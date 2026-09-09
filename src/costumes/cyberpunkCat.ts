//! "Cyberpunk Cat" — an open-front neon puffer and a wraparound visor.
//!
//! Built the same way as corporateCat: drawn from the pose rather than blitted,
//! confined to the live torso ellipse so it fits every body state and species,
//! and rasterised a pixel at a time so its edges are as hard as the cat's.
//!
//! Four things are particular to this one.
//!
//!   * The jacket colour is chosen by the customer. The painter is a CLOSURE
//!     over that colour rather than reading module state, so there is no way
//!     for the drawing and the cache key to disagree about which colour is on.
//!   * The jacket hangs OPEN, and the gap shows the cat's own chest. There is
//!     no inner garment: a dark shell behind the opening read as a second
//!     layer of clothing rather than as an unzipped coat.
//!   * The quilting runs the full silhouette. It is clipped to exactly the
//!     torso ellipse the renderer draws - not a shrunken copy - and carries no
//!     outline of its own, so there is no band of bare fur or piping ringing
//!     the garment.
//!   * The visor follows the skull ellipse and dips over the muzzle the way a
//!     pair of sunglasses does, instead of sitting across the face as a slab.

import {
  bodyAnchors,
  frontLimbs,
  type CostumeLayer,
  type CostumePainter,
  type PoseSpec,
} from "../animation/spriteLoader";
import { S, Surface, pxPoly, pxRect, stampSleeve, type Ctx, type Torso } from "./pixelSurface";

export const CYBERPUNK_CAT_ID = "mewmuze.cyberpunk-cat.v1";

/**
 * The jacket colours offered in Settings.
 *
 * Neon on purpose: the costume is meant to glow against a desktop, and a muted
 * palette here just reads as a normal coat.
 */
export const CYBERPUNK_COLOURS = [
  { id: "acid", label: "Acid Green", hex: "#7cf319" },
  { id: "magenta", label: "Hot Magenta", hex: "#ff2fb9" },
  { id: "cyan", label: "Electric Cyan", hex: "#22e0ff" },
  { id: "orange", label: "Ember Orange", hex: "#ff7a1a" },
  { id: "violet", label: "Ultraviolet", hex: "#9d5cff" },
] as const;

export const DEFAULT_CYBERPUNK_COLOUR = CYBERPUNK_COLOURS[0].hex;

/** The chosen hex, or the default if it is not one this costume offers. */
export function resolveCyberpunkColour(hex: string): string {
  return CYBERPUNK_COLOURS.some((c) => c.hex === hex) ? hex : DEFAULT_CYBERPUNK_COLOUR;
}

// ---------------------------------------------------------------------------
// Palette derived from the one chosen colour, so every shade moves together.
// ---------------------------------------------------------------------------

interface Palette {
  base: string;
  lit: string;
  spec: string;
  shade: string;
  seam: string;
  rim: string;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function shift(hex: string, factor: number, lift = 0): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp255(((n >> 16) & 255) * factor + lift);
  const g = clamp255(((n >> 8) & 255) * factor + lift);
  const b = clamp255((n & 255) * factor + lift);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function paletteFor(hex: string): Palette {
  return {
    base: hex,
    // A puffer's panels catch a lot of light; the lift keeps the highlight
    // from just looking like a paler version of the same flat colour.
    lit: shift(hex, 1.0, 40),
    // One bright line along the crown of each tube. Without it the shading
    // reads as flat stripes rather than as rows of stuffed cylinders.
    spec: shift(hex, 1.0, 100),
    shade: shift(hex, 0.7),
    // The contact shadow where one tube sits against the next. A line of the
    // shadow tone, not black - black against neon looks like damage.
    seam: shift(hex, 0.48),
    rim: shift(hex, 1.0, 95),
  };
}

const VISOR_FRAME = "#dfe6ee";
const VISOR_EDGE = "#8e9aa6";
// Cool smoke, not amber: a warm tint over grey fur came out khaki, which read
// as a bandage across the face rather than glass. Light enough that the eyes
// still show through the whole pane.
const VISOR_GLASS = "rgba(26, 32, 52, 0.34)";
const VISOR_BROW = "rgba(10, 13, 26, 0.28)";
const VISOR_SHEEN = "rgba(214, 240, 255, 0.34)";

// ---------------------------------------------------------------------------
// A little physics
// ---------------------------------------------------------------------------

/**
 * How far the hem of the jacket lags behind the body, in design units.
 *
 * Deliberately derived from `legPhase`, `stride` and `headBob` and nothing
 * else: all three are already in the sprite cache key, so the swing costs no
 * state, no timer and no cache misses. A real cloth simulation would need
 * per-frame history the frame cache cannot see, and would re-render the sprite
 * every tick for a two-pixel effect.
 *
 * Pinned at the shoulders and free at the hem, which is how a coat hangs - so
 * callers scale this by how far down the garment a row sits.
 */
function hemLag(pose: PoseSpec): number {
  const swing = Math.sin(pose.legPhase * Math.PI * 2);
  // Walking and running drive it hardest; a bobbing head while sitting still
  // gives it the faintest amount of life.
  const drive = Math.min(1.3, Math.abs(pose.stride) + Math.abs(pose.headBob) * 0.18);
  return swing * (0.16 + drive * 0.5);
}

// ---------------------------------------------------------------------------
// Collar
// ---------------------------------------------------------------------------

/**
 * Two collar wings meeting at the throat and flaring apart down the chest.
 *
 * Drawn UNCLIPPED and before the jacket body: the torso ellipse stops short of
 * the head, and bare fur in that gap is what made the first version look like
 * a floating blob instead of a coat. The V between the wings is left empty on
 * purpose - the cat's own chest shows through an open jacket.
 */
function drawCollar(ctx: Ctx, torso: Torso, head: Torso, p: Palette, side: boolean): void {
  // From just inside the skull down to well inside the shoulders, so there is
  // overlap at both ends and no seam can open up as the head bobs.
  const top = head.y + head.ry * 0.45;
  const bottom = torso.y - torso.ry * 0.35;
  if (bottom <= top) return;
  // Wide. A narrow collar left the cat's pale chest showing either side of it,
  // which read as the jacket not being attached to anything.
  const half = side ? torso.rx * 0.54 : torso.rx * 0.70;
  const flare = side ? torso.rx * 0.84 : torso.rx * 1.02;
  // In profile the neck runs diagonally from the shoulder up to the jaw, and
  // it is nowhere near the torso's centre. Anchoring on the torso alone put
  // the collar over the ribs and left the whole throat and chest bare;
  // weighted toward the jaw, it covers the shoulder sweep the renderer draws
  // between the two.
  const shoulder = torso.x + torso.rx * 0.5;
  const jaw = head.x - head.rx * 0.42;
  const cx = side ? shoulder * 0.35 + jaw * 0.65 : torso.x;
  const h = bottom - top;

  if (side) {
    // In profile the collar is one raised band around the neck; there is no V
    // to see from here.
    pxPoly(ctx, [
      [cx - half, top],
      [cx + half, top],
      [cx + flare, bottom],
      [cx - flare * 0.75, bottom],
    ], p.base);
    pxRect(ctx, cx - half, top, half * 2, h * 0.36, p.lit);
    pxRect(ctx, cx - half * 0.9, top + h * 0.04, half * 1.8, h * 0.10, p.spec);
    pxRect(ctx, cx - flare * 0.70, bottom - h * 0.26, flare * 1.4, h * 0.26, p.shade);
    return;
  }

  for (const d of [-1, 1] as const) {
    // Near-closed at the throat, wide open by the chest: that taper is what
    // reads as an unzipped jacket rather than a hole in one.
    pxPoly(ctx, [
      [cx + d * half * 0.20, top],
      [cx + d * half, top],
      [cx + d * flare, bottom],
      [cx + d * flare * 0.40, bottom],
    ], p.base);
    // Lit roll along the top of the wing, with a bright crown line on it.
    pxPoly(ctx, [
      [cx + d * half * 0.22, top],
      [cx + d * half * 0.96, top],
      [cx + d * flare * 0.86, top + h * 0.38],
      [cx + d * flare * 0.42, top + h * 0.38],
    ], p.lit);
    pxPoly(ctx, [
      [cx + d * half * 0.26, top + h * 0.06],
      [cx + d * half * 0.92, top + h * 0.06],
      [cx + d * flare * 0.80, top + h * 0.20],
      [cx + d * flare * 0.46, top + h * 0.20],
    ], p.spec);
    // Neon piping down the open edge - the one line that says cyberpunk from
    // across a desktop.
    pxPoly(ctx, [
      [cx + d * half * 0.20, top],
      [cx + d * half * 0.36, top],
      [cx + d * flare * 0.56, bottom],
      [cx + d * flare * 0.40, bottom],
    ], p.rim);
  }
}

// ---------------------------------------------------------------------------
// The jacket
// ---------------------------------------------------------------------------

/**
 * One padded tube.
 *
 * Both ends are rounded, so a row reads as a stuffed cylinder with capped ends
 * rather than a stripe ruled across a panel. The shading is a cylinder's, in
 * order down the tube: contact shadow from the tube above, base, lit shoulder,
 * a one-line specular crown, base again, then the underside in shadow.
 */
/** Which end of a tube is a finished edge; the other runs off under the clip. */
type Cap = "left" | "right" | "none";

function puffBaffle(
  s: Surface,
  left: number,
  right: number,
  top: number,
  bottom: number,
  cap: Cap,
  p: Palette,
): void {
  const h = bottom - top;
  const w = right - left;
  if (h <= 0 || w <= 0) return;
  // Rounded only where the garment actually ends - the edge of the opening.
  // The far end is shaped by the torso clip, and capping it there was what
  // made the quilting stop short of the silhouette.
  const r = cap === "none" ? 0 : Math.min(h * 0.34, w * 0.20);
  const l = cap === "left";
  s.poly(
    r === 0
      ? [[left, top], [right, top], [right, bottom], [left, bottom]]
      : l
        ? [
            [left + r, top],
            [right, top],
            [right, bottom],
            [left + r, bottom],
            [left, bottom - r],
            [left, top + r],
          ]
        : [
            [left, top],
            [right - r, top],
            [right, top + r],
            [right, bottom - r],
            [right - r, bottom],
            [left, bottom],
          ],
    p.base,
  );
  // Inset only past the cap, so every band still reaches the far end.
  const ix = l ? left + r * 0.5 : left;
  const iw = w - r * 0.5;
  // Only the underside falls into shadow. An earlier split put nearly half the
  // tube in shade and every colour came out olive.
  s.rect(ix, top + h * 0.74, iw, h * 0.26, p.shade);
  s.rect(ix, top, iw, h * 0.07, p.seam);
  s.rect(ix, top + h * 0.16, iw, h * 0.22, p.lit);
  s.rect(ix, top + h * 0.22, iw, h * 0.06, p.spec);
}

/** Rows of baffles, spaced as a fraction of the live body height. */
const ROWS = 5;

/**
 * The vertical band for one row, plus how far that row swings.
 *
 * Rows overlap upward by a sliver so the swing cannot open a hairline of fur
 * between two of them, and the outer extents run well past the silhouette
 * because the clip, not the geometry, is what decides where the garment ends.
 */
function row(t: Torso, i: number, lag: number): { top: number; bottom: number; sway: number } {
  // Exactly the body's own height, divided evenly. Spanning 1.1x of it put a
  // clipped sliver at each end and no two tubes were the same size.
  const h = (t.ry * 2) / ROWS;
  const top = t.y - t.ry + i * h;
  return {
    // Every row overlaps upward by the same amount, including the first, so
    // the swing cannot open a hairline between two of them and the banding
    // stays identical row to row.
    top: top - h * 0.1,
    bottom: top + h,
    // Pinned at the shoulders, free at the hem.
    sway: lag * (i / (ROWS - 1)),
  };
}

function drawFrontJacket(s: Surface, t: Torso, p: Palette, lag: number): void {
  // No fill behind the opening: an open jacket shows the cat, not a second
  // garment.
  const gap = t.rx * 0.11;
  const outer = t.rx * 1.3;
  for (let i = 0; i < ROWS; i++) {
    const { top, bottom, sway } = row(t, i, lag);
    puffBaffle(s, t.x - outer + sway, t.x - gap + sway, top, bottom, "right", p);
    puffBaffle(s, t.x + gap + sway, t.x + outer + sway, top, bottom, "left", p);
  }
  // Neon piping down both open edges, tying the jacket to the collar's, and
  // trailing with the hem.
  const hem = row(t, ROWS - 1, lag).sway;
  for (const d of [-1, 1] as const) {
    s.poly([
      [t.x + d * gap - t.rx * 0.03, t.y - t.ry],
      [t.x + d * gap + t.rx * 0.03, t.y - t.ry],
      [t.x + d * gap + t.rx * 0.03 + hem, t.y + t.ry],
      [t.x + d * gap - t.rx * 0.03 + hem, t.y + t.ry],
    ], p.rim);
  }
}

function drawSideJacket(s: Surface, t: Torso, p: Palette, lag: number): void {
  // The cat faces +x, so the open front edge is at the chest and the fur ahead
  // of it stays bare.
  const front = t.x + t.rx * 0.76;
  for (let i = 0; i < ROWS; i++) {
    const { top, bottom, sway } = row(t, i, lag);
    puffBaffle(s, t.x - t.rx * 1.3 + sway, front + sway, top, bottom, "right", p);
  }
  const hem = row(t, ROWS - 1, lag).sway;
  s.poly([
    [front - t.rx * 0.03, t.y - t.ry],
    [front + t.rx * 0.03, t.y - t.ry],
    [front + t.rx * 0.03 + hem, t.y + t.ry],
    [front - t.rx * 0.03 + hem, t.y + t.ry],
  ], p.rim);
}

function drawBackJacket(s: Surface, t: Torso, p: Palette, lag: number): void {
  // Nothing opens at the back, so this is the one panel that runs edge to edge.
  for (let i = 0; i < ROWS; i++) {
    const { top, bottom, sway } = row(t, i, lag);
    puffBaffle(s, t.x - t.rx * 1.3 + sway, t.x + t.rx * 1.3 + sway, top, bottom, "none", p);
  }
  // Spine stripe, the back's answer to the open front.
  const hem = row(t, ROWS - 1, lag).sway;
  s.poly([
    [t.x - t.rx * 0.05, t.y - t.ry * 0.75],
    [t.x + t.rx * 0.05, t.y - t.ry * 0.75],
    [t.x + t.rx * 0.05 + hem, t.y + t.ry * 0.85],
    [t.x - t.rx * 0.05 + hem, t.y + t.ry * 0.85],
  ], p.rim);
}

// ---------------------------------------------------------------------------
// The visor
// ---------------------------------------------------------------------------

/** How far out the lens reaches, as a fraction of the skull. */
const LENS_HALF = 0.88;

/** A one-frame white blowout on the HUD line. */
const HUD_BLOWN = "#f2fbff";

/** Deterministic pseudo-random 0..1 from an integer step. */
function noise(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The scan line across the lens, torn apart on some frames.
 *
 * Driven by `pose.tailPhase`: a 0..39 counter the engine always advances (the
 * tail is never truly still) that is ALREADY part of the sprite cache key. So
 * the glitch animates for free - no timer, no state, and not one extra frame
 * render. Anything driven by wall-clock time here would miss the cache on
 * every tick and re-rasterise the whole cat for a three-pixel effect.
 */
function drawHudLine(
  ctx: Ctx,
  x0: number,
  w: number,
  y: number,
  thick: number,
  colour: string,
  step: number,
): void {
  if (noise(step * 1.7) <= 0.84) {
    pxRect(ctx, x0, y, w, thick, colour);
    return;
  }
  // Torn: three segments, each knocked sideways and up or down, one of them
  // blown out to white.
  const hot = Math.floor(noise(step * 7.9) * 3);
  for (let i = 0; i < 3; i++) {
    const dx = (noise(step * 3.1 + i * 5) - 0.5) * w * 0.14;
    const dy = (noise(step * 5.3 + i * 11) - 0.5) * thick * 5;
    pxRect(ctx, x0 + (w * i) / 3 + dx, y + dy, (w / 3) * 0.92, thick, i === hot ? HUD_BLOWN : colour);
  }
}

/**
 * The top and bottom of the lens at one horizontal offset from the skull's
 * centre.
 *
 * Both edges follow the skull ellipse, so the pane curves down at the temples
 * and sits ON the face instead of across it. The lower edge lifts sharply in
 * the middle: that notch is the nose bridge, and it is the single detail that
 * turns a slab into a pair of sunglasses.
 */
function lensEdges(skull: Torso, x: number): { top: number; bottom: number } {
  const n = x / (skull.rx * 1.02);
  const arc = Math.sqrt(Math.max(0, 1 - n * n));
  const notch = Math.max(0, 1 - Math.abs(x) / (skull.rx * 0.30)) * skull.ry * 0.34;
  return {
    top: skull.y - skull.ry * (0.16 + 0.48 * arc),
    bottom: skull.y + skull.ry * (0.06 + 0.36 * arc) - notch,
  };
}

/** Sample the lens outline as a closed polygon: top edge out, bottom edge back. */
function lensOutline(skull: Torso, inset = 0): number[][] {
  const half = skull.rx * LENS_HALF;
  const steps = 14;
  const top: number[][] = [];
  const bottom: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = -half + (2 * half * i) / steps;
    const e = lensEdges(skull, x);
    top.push([skull.x + x, e.top + inset]);
    bottom.push([skull.x + x, e.bottom - inset]);
  }
  return [...top, ...bottom.reverse()];
}

/**
 * A wraparound shield across the whole eye band.
 *
 * Sized off `skull` - the ellipse the renderer draws - rather than `head`,
 * which is the smaller collar anchor and produced a lens a third too small.
 * Translucent by design: an opaque lens deletes the cat's expression.
 */
function drawVisorFront(ctx: Ctx, skull: Torso, p: Palette, step: number): void {
  const half = skull.rx * LENS_HALF;
  const mid = lensEdges(skull, 0);
  const rail = skull.ry * 0.05;

  pxPoly(ctx, lensOutline(skull), VISOR_GLASS);
  // Denser just under the brow, where a real lens is shaded by its own frame.
  const browBand: number[][] = [];
  const back: number[][] = [];
  for (let i = 0; i <= 14; i++) {
    const x = -half + (2 * half * i) / 14;
    const e = lensEdges(skull, x);
    browBand.push([skull.x + x, e.top]);
    back.push([skull.x + x, Math.min(e.bottom, e.top + skull.ry * 0.20)]);
  }
  pxPoly(ctx, [...browBand, ...back.reverse()], VISOR_BROW);

  // Sheen on the left lens only - the middle is cut away by the nose bridge,
  // so a streak through the centre would spill onto the fur.
  for (const [from, to] of [[-0.74, -0.58], [-0.46, -0.38]] as const) {
    const a = lensEdges(skull, half * from);
    const b = lensEdges(skull, half * to);
    pxPoly(ctx, [
      [skull.x + half * from + 1.1, a.top + 1.1],
      [skull.x + half * to + 1.1, b.top + 1.1],
      [skull.x + half * to, b.bottom - 1.1],
      [skull.x + half * from, a.bottom - 1.1],
    ], VISOR_SHEEN);
  }

  // Brow rail: thin, and curved along the top edge rather than ruled straight
  // across the forehead.
  const railTop: number[][] = [];
  const railBottom: number[][] = [];
  for (let i = 0; i <= 14; i++) {
    const x = -half + (2 * half * i) / 14;
    const e = lensEdges(skull, x);
    railTop.push([skull.x + x, e.top - rail]);
    railBottom.push([skull.x + x, e.top + rail * 0.6]);
  }
  // Frame grey, not white: a bright rail this wide read as a sweatband rather
  // than as the top of a pair of glasses.
  pxPoly(ctx, [...railTop, ...railBottom.reverse()], VISOR_EDGE);
  pxPoly(ctx, [
    ...railTop.map(([x, y]) => [x, y]),
    ...railTop.map(([x, y]) => [x, y + rail * 0.45]).reverse(),
  ], VISOR_FRAME);

  // Lower rim, following the same curve and so around the nose notch too -
  // which is what makes the bridge read as part of the frame.
  const rimTop: number[][] = [];
  const rimBottom: number[][] = [];
  for (let i = 0; i <= 14; i++) {
    const x = -half + (2 * half * i) / 14;
    const e = lensEdges(skull, x);
    rimBottom.push([skull.x + x, e.bottom]);
    rimTop.push([skull.x + x, e.bottom - rail * 0.7]);
  }
  pxPoly(ctx, [...rimTop, ...rimBottom.reverse()], VISOR_EDGE);

  // A neon HUD line across the lens, in the jacket's own colour.
  drawHudLine(
    ctx,
    skull.x - half * 0.92,
    half * 1.84,
    mid.top + skull.ry * 0.46,
    Math.max(0.3, skull.ry * 0.045),
    p.rim,
    step,
  );
  // Temple arms reaching back towards the ears.
  for (const d of [-1, 1] as const) {
    const e = lensEdges(skull, d * half * 0.97);
    pxRect(
      ctx,
      d < 0 ? skull.x - half - skull.rx * 0.08 : skull.x + half - skull.rx * 0.01,
      e.top + skull.ry * 0.06,
      skull.rx * 0.09,
      skull.ry * 0.16,
      VISOR_EDGE,
    );
  }
}

/** In profile only one lens is visible, angled along the muzzle. */
function drawVisorSide(ctx: Ctx, skull: Torso, p: Palette, step: number): void {
  const back = skull.x - skull.rx * 0.46;
  const front = skull.x + skull.rx * 0.80;
  const w = front - back;
  // Same curve idea as the front, read along the muzzle: the lens rides the
  // skull and steps up at the very front to clear the nose.
  const edge = (x: number): { top: number; bottom: number } => {
    const n = (x - skull.x) / (skull.rx * 1.06);
    const arc = Math.sqrt(Math.max(0, 1 - n * n));
    const nose = Math.max(0, (x - skull.x - skull.rx * 0.52) / (skull.rx * 0.30)) * skull.ry * 0.34;
    return {
      top: skull.y - skull.ry * (0.14 + 0.50 * arc),
      bottom: skull.y + skull.ry * (0.04 + 0.38 * arc) - nose,
    };
  };
  const outline = (inset: number): number[][] => {
    const t: number[][] = [];
    const b: number[][] = [];
    for (let i = 0; i <= 12; i++) {
      const x = back + (w * i) / 12;
      const e = edge(x);
      t.push([x, e.top + inset]);
      b.push([x, e.bottom - inset]);
    }
    return [...t, ...b.reverse()];
  };
  const rail = skull.ry * 0.05;

  pxPoly(ctx, outline(0), VISOR_GLASS);
  const browTop: number[][] = [];
  const browBottom: number[][] = [];
  for (let i = 0; i <= 12; i++) {
    const x = back + (w * i) / 12;
    const e = edge(x);
    browTop.push([x, e.top]);
    browBottom.push([x, Math.min(e.bottom, e.top + skull.ry * 0.20)]);
  }
  pxPoly(ctx, [...browTop, ...browBottom.reverse()], VISOR_BROW);

  const a = edge(back + w * 0.26);
  const b = edge(back + w * 0.40);
  pxPoly(ctx, [
    [back + w * 0.26 + 1.1, a.top + 1.1],
    [back + w * 0.40 + 1.1, b.top + 1.1],
    [back + w * 0.40, b.bottom - 1.1],
    [back + w * 0.26, a.bottom - 1.1],
  ], VISOR_SHEEN);

  const railTop: number[][] = [];
  const railBottom: number[][] = [];
  for (let i = 0; i <= 12; i++) {
    const x = back + (w * i) / 12;
    const e = edge(x);
    railTop.push([x, e.top - rail]);
    railBottom.push([x, e.top + rail * 0.6]);
  }
  pxPoly(ctx, [...railTop, ...railBottom.reverse()], VISOR_EDGE);
  pxPoly(ctx, [
    ...railTop.map(([x, y]) => [x, y]),
    ...railTop.map(([x, y]) => [x, y + rail * 0.45]).reverse(),
  ], VISOR_FRAME);

  drawHudLine(
    ctx,
    back + w * 0.08,
    w * 0.78,
    skull.y - skull.ry * 0.06,
    Math.max(0.3, skull.ry * 0.045),
    p.rim,
    step,
  );
  // Temple arm running back to the ear.
  pxRect(ctx, back - skull.rx * 0.26, edge(back).top + skull.ry * 0.08, skull.rx * 0.28, skull.ry * 0.15, VISOR_EDGE);
}

// ---------------------------------------------------------------------------

/**
 * Build a painter for one jacket colour.
 *
 * A closure rather than module state: the colour is baked into the function
 * the renderer holds, and the same colour goes into the sprite cache key, so
 * the two cannot fall out of step and leave cached frames in the old colour.
 */
export function cyberpunkPainter(colour: string): CostumePainter {
  const p = paletteFor(resolveCyberpunkColour(colour));

  return (ctx: Ctx, pose: PoseSpec, layer: CostumeLayer): void => {
    const { torso, head, skull, faces } = bodyAnchors(pose);

    if (layer === "face") {
      // No visor from behind - there is no face to put it on.
      if (pose.view === "back") return;
      ctx.save();
      ctx.scale(1 / S, 1 / S);
      if (pose.view === "side") drawVisorSide(ctx, skull, p, pose.tailPhase);
      else drawVisorFront(ctx, skull, p, pose.tailPhase);
      ctx.restore();
      return;
    }

    if (layer === "limbs") {
      if (pose.view === "side" || pose.view === "back") return;
      ctx.save();
      ctx.scale(1 / S, 1 / S);
      for (const limb of frontLimbs(pose, torso.y + 2)) {
        // Padded sleeve, then pinch rings, a crown highlight and a cuff: a
        // plain tube read as a blazer sleeve in a brighter colour.
        stampSleeve(ctx, limb, 0, 0.58, 1.32, p.base);
        stampSleeve(ctx, limb, 0.02, 0.14, 1.34, p.lit);
        stampSleeve(ctx, limb, 0.04, 0.09, 1.3, p.spec);
        for (const at of [0.24, 0.44] as const) {
          stampSleeve(ctx, limb, at, at + 0.02, 1.3, p.seam);
        }
        stampSleeve(ctx, limb, 0.5, 0.58, 1.2, p.shade);
        stampSleeve(ctx, limb, 0.56, 0.58, 1.24, p.rim);
      }
      ctx.restore();
      return;
    }

    // EXACTLY the ellipse the renderer draws for the body, so the quilting
    // runs the full silhouette. A shrunken copy left a ring of bare fur, and
    // an outline of its own left a border - both read as a sticker rather
    // than a garment.
    //
    // In profile the anchor ellipse is the ribs and haunch; the chest and the
    // shoulder sweep sit forward of it, so the garment is nudged toward the
    // face - signed by `faces`, so the mirrored sleeping cat shifts the same
    // way it points.
    const side = pose.view === "side";
    const rx = torso.rx * (side ? 1.02 : 1);
    const ry = torso.ry * (side ? 0.97 : 1);
    if (rx <= 0 || ry <= 0) return;
    const t: Torso = { x: torso.x + (side ? faces * torso.rx * 0.2 : 0), y: torso.y, rx, ry };
    const lag = hemLag(pose);

    ctx.save();
    ctx.scale(1 / S, 1 / S);
    // Collar first and unclipped, so the jacket body overlaps its lower edge
    // rather than the other way round.
    if (pose.view !== "back") drawCollar(ctx, t, head, p, side);
    const s = new Surface(ctx, t, side && faces === -1);
    if (side) drawSideJacket(s, t, p, lag);
    else if (pose.view === "back") drawBackJacket(s, t, p, lag);
    else drawFrontJacket(s, t, p, lag);
    ctx.restore();
  };
}
