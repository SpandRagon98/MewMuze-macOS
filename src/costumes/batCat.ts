//! "BatCat" — a half cowl, a cape and a charcoal body suit.
//!
//! Deliberately its own hero rather than a recolour of a famous one: the cowl
//! is a different shape, the suit is charcoal-blue instead of black, and the
//! chest badge is a bat-eared CAT head in a rounded diamond - no oval, no wing
//! silhouette. The accent colour is the customer's, the way the Cyberpunk
//! jacket's is.
//!
//! Built the same way as the other procedural costumes: drawn from the pose,
//! confined to the live anchors, rasterised a pixel at a time.

import {
  bodyAnchors,
  frontLimbs,
  type CostumeLayer,
  type CostumePainter,
  type CostumeTraits,
  type PoseSpec,
} from "../animation/spriteLoader";
import { S, Surface, pxPoly, shift, stampSleeve, type Ctx, type Torso } from "./pixelSurface";

export const BATCAT_ID = "mewmuze.bat-cat.v1";
/** The cowl brings its own bat ears. */
export const BATCAT_TRAITS: CostumeTraits = { hidesEars: true };

/** The accent colour: badge, cowl rims and the cape lining. */
export const BATCAT_COLOURS = [
  { id: "gold", label: "Signal Gold", hex: "#f2b428" },
  { id: "violet", label: "Night Violet", hex: "#9a5cf0" },
  { id: "crimson", label: "Crimson Alert", hex: "#e0364a" },
  { id: "ice", label: "Ice Blue", hex: "#6fd8ff" },
  { id: "acid", label: "Signal Green", hex: "#7cf319" },
] as const;

export const DEFAULT_BATCAT_COLOUR = BATCAT_COLOURS[0].hex;

export function resolveBatcatColour(hex: string): string {
  return BATCAT_COLOURS.some((c) => c.hex === hex) ? hex : DEFAULT_BATCAT_COLOUR;
}

// Charcoal-BLUE, not black: against a dark desktop a true black suit loses its
// whole silhouette, and the cat's own fur is already near-black.
const SUIT = "#1e2436";
const SUIT_LIT = "#333d59";
const SUIT_SPEC = "#4a5878";
const SUIT_SH = "#141826";
const CAPE = "#0f1320";
const CAPE_LIT = "#1d2438";


// ---------------------------------------------------------------------------
// A predicate fill, for shapes with holes
// ---------------------------------------------------------------------------

/**
 * Fill every pixel in a design-space box where `test` passes.
 *
 * The cowl is a shape with two holes cut in it, which no polygon fill can
 * express. Testing per pixel is the honest way to do it and rasterises on the
 * same grid as the cat, so the eye openings have hard edges. The box is a
 * head, so this is a few thousand tests, once per cached frame.
 */
function fillWhere(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: string,
  test: (x: number, y: number) => boolean,
): void {
  ctx.fillStyle = colour;
  for (let py = Math.floor(y0 * S); py <= Math.ceil(y1 * S); py++) {
    for (let px = Math.floor(x0 * S); px <= Math.ceil(x1 * S); px++) {
      if (test((px + 0.5) / S, (py + 0.5) / S)) ctx.fillRect(px, py, 1, 1);
    }
  }
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean => {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return nx * nx + ny * ny <= 1;
};

/** Point in the triangle (ax,ay)-(bx,by)-(cx,cy), by sign of the three edges. */
function inTri(
  x: number, y: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): boolean {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// ---------------------------------------------------------------------------
// The cowl
// ---------------------------------------------------------------------------

/**
 * Where a horn's point lands, kept on the canvas.
 *
 * Unclamped, the default head put the point at y ~ -1.7, above the top of the
 * sprite, so the tips were sliced off. The cat's own ears clamp to the same
 * headroom; a big-headed breed gets a shorter horn rather than a cut one.
 */
const HORN_TOP = 1.2;
const hornTip = (base: number, height: number): number => Math.max(HORN_TOP, base - height);

/**
 * The lit inner face of a horn: a slimmer triangle inside it. Without it each
 * horn is one flat dark shape that disappears against a dark desktop.
 */
function hornFace(
  ctx: Ctx,
  earX: number,
  base: number,
  half: number,
  tip: number,
  lean: number,
  inMask: (x: number, y: number) => boolean,
): void {
  fillWhere(ctx, earX - half, tip - 1, earX + half, base + 1, SUIT_LIT, (x, y) =>
    inMask(x, y) && inTri(x, y, earX - half * 0.42, base - 0.6, earX + half * 0.42, base - 0.6, earX + lean, tip + 1.6));
}

/** Where drawFrontFace puts the eyes, in the skull's own units. */
const EYE_GAP = 5.8;
const EYE_RX = 4.5;
const EYE_RY = 5.4;
/** Skull radii drawFrontFace draws at, used to recover the species scale. */
const SKULL_RX = 12.3;

/**
 * The half mask: over the crown, around the eyes, stopping above the muzzle.
 *
 * Two tall pointed ears sit OVER the cat's own, which is what makes the
 * silhouette read from across a desktop. The eye openings are real holes, not
 * a painted-on shape - the cat's expression is the thing people watch, and
 * this costume covers more of the face than any other.
 */
function drawCowlFront(ctx: Ctx, skull: Torso, accent: string): void {
  const hs = skull.rx / SKULL_RX;
  const cx = skull.x;
  const cy = skull.y;
  const rx = skull.rx * 1.02;
  const ry = skull.ry * 1.02;
  const eyeY = cy - 0.5;
  const eyeRx = EYE_RX * hs + 0.7;
  const eyeRy = EYE_RY * hs + 0.7;
  const eyeL = cx - EYE_GAP * hs;
  const eyeR = cx + EYE_GAP * hs;

  // Ears: taller and sharper than the cat's own, and set a little wider.
  const earBase = cy - ry + 3.6;
  // Wide enough at the base to swallow the cat's own ears, which otherwise
  // poke out either side of the cowl as two grey wedges.
  const earHalf = 3.8 * hs;
  const earTip = hornTip(earBase, 9.6 * hs);
  const earL = cx - skull.rx * 0.66;
  const earR = cx + skull.rx * 0.66;

  // The mask comes further down at the cheeks than over the nose, so the
  // muzzle and chin stay bare - that gap is most of the charm in a real one.
  const bottom = (x: number): number =>
    cy + ry * (0.22 + 0.26 * Math.min(1, Math.abs(x - cx) / (rx * 0.85)));

  const inEar = (x: number, y: number): boolean =>
    inTri(x, y, earL - earHalf, earBase + 1, earL + earHalf, earBase + 1, earL - 0.6, earTip) ||
    inTri(x, y, earR - earHalf, earBase + 1, earR + earHalf, earBase + 1, earR + 0.6, earTip);

  const inHole = (x: number, y: number): boolean =>
    inEllipse(x, y, eyeL, eyeY, eyeRx, eyeRy) || inEllipse(x, y, eyeR, eyeY, eyeRx, eyeRy);

  const inMask = (x: number, y: number): boolean =>
    !inHole(x, y) &&
    (inEar(x, y) || (inEllipse(x, y, cx, cy, rx, ry) && y <= bottom(x)));

  const x0 = cx - rx - 5;
  const x1 = cx + rx + 5;
  fillWhere(ctx, x0, earTip - 1, x1, cy + ry, SUIT, inMask);
  // Lit crown, so the mask is not one flat mass.
  fillWhere(ctx, x0, earTip - 1, x1, cy, SUIT_LIT, (x, y) =>
    inMask(x, y) && y < cy - ry * 0.42 && y > cy - ry * 0.78);
  fillWhere(ctx, x0, earTip - 1, x1, cy, SUIT_SPEC, (x, y) =>
    inMask(x, y) && y < cy - ry * 0.58 && y > cy - ry * 0.70);
  hornFace(ctx, earL, earBase, earHalf, earTip, -0.6, inMask);
  hornFace(ctx, earR, earBase, earHalf, earTip, 0.6, inMask);
  // Accent rim around each opening.
  fillWhere(ctx, x0, cy - ry, x1, cy + ry, accent, (x, y) =>
    inMask(x, y) &&
    (inEllipse(x, y, eyeL, eyeY, eyeRx + 0.12, eyeRy + 0.12) ||
      inEllipse(x, y, eyeR, eyeY, eyeRx + 0.12, eyeRy + 0.12)));
  // Shadow under the mask's lower edge, where it meets bare fur.
  fillWhere(ctx, x0, cy, x1, cy + ry, SUIT_SH, (x, y) =>
    inMask(x, y) && y > bottom(x) - 0.9);
}

/**
 * From behind: the same cowl with no openings.
 *
 * Painted on the TORSO layer rather than "face", because drawBack has no face
 * seam - it draws the head, then its body markings, then the costume. That
 * order is what lets this land on top of the skull at all.
 */
function drawCowlBack(ctx: Ctx, skull: Torso): void {
  const hs = skull.rx / 11.6;
  const cx = skull.x;
  const cy = skull.y;
  const rx = skull.rx * 1.02;
  const ry = skull.ry * 1.02;
  const earBase = cy - ry + 3.2;
  const earHalf = 3.2 * hs;
  const earTip = hornTip(earBase, 9.4 * hs);
  const earL = cx - skull.rx * 0.62;
  const earR = cx + skull.rx * 0.62;
  const bottom = cy + ry * 0.62;

  const inEar = (x: number, y: number): boolean =>
    inTri(x, y, earL - earHalf, earBase + 1, earL + earHalf, earBase + 1, earL - 0.6, earTip) ||
    inTri(x, y, earR - earHalf, earBase + 1, earR + earHalf, earBase + 1, earR + 0.6, earTip);
  const inMask = (x: number, y: number): boolean =>
    inEar(x, y) || (inEllipse(x, y, cx, cy, rx, ry) && y <= bottom);

  fillWhere(ctx, cx - rx - 5, earTip - 1, cx + rx + 5, cy + ry, SUIT, inMask);
  hornFace(ctx, earL, earBase, earHalf, earTip, -0.6, inMask);
  hornFace(ctx, earR, earBase, earHalf, earTip, 0.6, inMask);
  fillWhere(ctx, cx - rx - 5, earTip - 1, cx + rx + 5, cy, SUIT_LIT, (x, y) =>
    inMask(x, y) && y < cy - ry * 0.36 && y > cy - ry * 0.74);
  fillWhere(ctx, cx - rx - 5, cy, cx + rx + 5, cy + ry, SUIT_SH, (x, y) =>
    inMask(x, y) && y > bottom - 0.9);
}

/**
 * In profile: one ear, one eye opening, and the cowl wrapping the skull.
 *
 * `faces` mirrors every offset from the skull's centre. The curled sleeping
 * cat is drawn facing LEFT, and without this its eye opening ends up on the
 * back of its head.
 */
function drawCowlSide(ctx: Ctx, skull: Torso, accent: string, faces: number): void {
  const hs = skull.rx / 10.2;
  const cx = skull.x;
  const cy = skull.y;
  const rx = skull.rx * 1.02;
  const ry = skull.ry * 1.02;
  const eyeX = cx + 3.3 * faces;
  const eyeY = cy - 0.8;
  const eyeRx = 3.75 * hs + 0.7;
  const eyeRy = 4.65 * hs + 0.7;

  const earBase = cy - ry + 3.0;
  const earHalf = 3.0 * hs;
  const earTip = hornTip(earBase, 9.2 * hs);
  const earL = cx - 4.6;
  const earR = cx + 4.6;

  // Cut away sharply toward the muzzle so the nose and mouth stay clear.
  const bottom = (x: number): number =>
    cy + ry * (0.62 - 0.5 * Math.max(0, Math.min(1, (faces * (x - cx) + rx * 0.2) / (rx * 1.1))));

  const inEar = (x: number, y: number): boolean =>
    inTri(x, y, earL - earHalf, earBase + 1, earL + earHalf, earBase + 1, earL - 0.6, earTip) ||
    inTri(x, y, earR - earHalf, earBase + 1, earR + earHalf, earBase + 1, earR + 0.6, earTip);

  const inHole = (x: number, y: number): boolean => inEllipse(x, y, eyeX, eyeY, eyeRx, eyeRy);
  const inMask = (x: number, y: number): boolean =>
    !inHole(x, y) &&
    (inEar(x, y) || (inEllipse(x, y, cx, cy, rx, ry) && y <= bottom(x)));

  const x0 = cx - rx - 5;
  const x1 = cx + rx + 5;
  fillWhere(ctx, x0, earTip - 1, x1, cy + ry, SUIT, inMask);
  fillWhere(ctx, x0, earTip - 1, x1, cy, SUIT_LIT, (x, y) =>
    inMask(x, y) && y < cy - ry * 0.40 && y > cy - ry * 0.76);
  fillWhere(ctx, x0, earTip - 1, x1, cy, SUIT_SPEC, (x, y) =>
    inMask(x, y) && y < cy - ry * 0.56 && y > cy - ry * 0.68);
  hornFace(ctx, earL, earBase, earHalf, earTip, -0.6, inMask);
  hornFace(ctx, earR, earBase, earHalf, earTip, 0.6, inMask);
  fillWhere(ctx, x0, cy - ry, x1, cy + ry, accent, (x, y) =>
    inMask(x, y) && inEllipse(x, y, eyeX, eyeY, eyeRx + 0.12, eyeRy + 0.12));
  fillWhere(ctx, x0, cy, x1, cy + ry, SUIT_SH, (x, y) => inMask(x, y) && y > bottom(x) - 0.9);
}

// ---------------------------------------------------------------------------
// The cape
// ---------------------------------------------------------------------------

/** Scalloped hem: three shallow arcs, the one detail that says "cape". */
function scallops(from: number, to: number, y: number, depth: number): number[][] {
  const pts: number[][] = [];
  const lobes = 3;
  const steps = 12;
  for (let i = 0; i <= lobes * steps; i++) {
    const t = i / (lobes * steps);
    const x = from + (to - from) * t;
    pts.push([x, y + Math.abs(Math.sin(t * lobes * Math.PI)) * depth]);
  }
  return pts;
}

/**
 * The cape, drawn UNCLIPPED at the torso seam.
 *
 * It has to leave the torso ellipse - that is the whole point of a cape - and
 * it goes down before the suit so the suit overlaps its inner edge rather than
 * the other way round.
 */
function drawCapeFront(ctx: Ctx, t: Torso, head: Torso): void {
  const top = head.y + head.ry * 0.5;
  const hem = t.y + t.ry * 1.02;
  for (const d of [-1, 1] as const) {
    pxPoly(ctx, [
      [t.x + d * t.rx * 0.30, top],
      [t.x + d * t.rx * 0.92, top + (hem - top) * 0.12],
      ...scallops(t.x + d * t.rx * 1.42, t.x + d * t.rx * 0.34, hem, t.ry * 0.13),
    ], CAPE);
    // Lit fold along the shoulder.
    pxPoly(ctx, [
      [t.x + d * t.rx * 0.34, top],
      [t.x + d * t.rx * 0.86, top + (hem - top) * 0.12],
      [t.x + d * t.rx * 0.80, top + (hem - top) * 0.34],
      [t.x + d * t.rx * 0.36, top + (hem - top) * 0.26],
    ], CAPE_LIT);
  }
}

function drawCapeSide(ctx: Ctx, t: Torso, head: Torso, faces: number): void {
  const back = -faces;
  const top = head.y + head.ry * 0.55;
  const hem = t.y + t.ry * 1.05;
  pxPoly(ctx, [
    [t.x + faces * t.rx * 0.35, top],
    [t.x + faces * t.rx * 0.05, top - t.ry * 0.10],
    ...scallops(t.x + back * t.rx * 1.55, t.x + faces * t.rx * 0.30, hem, t.ry * 0.14),
  ], CAPE);
  pxPoly(ctx, [
    [t.x + faces * t.rx * 0.30, top],
    [t.x + back * t.rx * 0.30, top + (hem - top) * 0.22],
    [t.x + back * t.rx * 0.42, top + (hem - top) * 0.5],
    [t.x + faces * t.rx * 0.22, top + (hem - top) * 0.3],
  ], CAPE_LIT);
}

function drawCapeBack(ctx: Ctx, t: Torso, head: Torso): void {
  // From behind the cape IS the costume: it covers the shoulders and falls
  // past the hem in one sweep.
  const top = head.y + head.ry * 0.55;
  const hem = t.y + t.ry * 1.18;
  pxPoly(ctx, [
    [t.x - t.rx * 0.55, top],
    [t.x + t.rx * 0.55, top],
    [t.x + t.rx * 1.12, top + (hem - top) * 0.30],
    ...scallops(t.x + t.rx * 1.2, t.x - t.rx * 1.2, hem, t.ry * 0.16),
    [t.x - t.rx * 1.12, top + (hem - top) * 0.30],
  ], CAPE);
  // A centre fold and two side folds, or it reads as a flat sheet.
  for (const f of [-0.42, 0.42] as const) {
    pxPoly(ctx, [
      [t.x + f * t.rx - t.rx * 0.035, top + (hem - top) * 0.12],
      [t.x + f * t.rx + t.rx * 0.035, top + (hem - top) * 0.12],
      [t.x + f * t.rx * 1.5 + t.rx * 0.035, hem],
      [t.x + f * t.rx * 1.5 - t.rx * 0.035, hem],
    ], CAPE_LIT);
  }
}

// ---------------------------------------------------------------------------
// The suit
// ---------------------------------------------------------------------------

/**
 * The chest badge: a bat-eared CAT head in a rounded diamond.
 *
 * Deliberately not an oval and deliberately not a wing shape - the mark has to
 * be BatCat's own, and at this size a silhouette is all anyone reads.
 */
function drawBadge(s: Surface, cx: number, cy: number, w: number, accent: string): void {
  const h = w * 0.92;
  s.poly([
    [cx, cy - h],
    [cx + w * 0.72, cy - h * 0.34],
    [cx + w, cy + h * 0.10],
    [cx, cy + h],
    [cx - w, cy + h * 0.10],
    [cx - w * 0.72, cy - h * 0.34],
  ], accent);
  s.poly([
    [cx, cy - h * 0.80],
    [cx + w * 0.60, cy - h * 0.26],
    [cx + w * 0.84, cy + h * 0.10],
    [cx, cy + h * 0.80],
    [cx - w * 0.84, cy + h * 0.10],
    [cx - w * 0.60, cy - h * 0.26],
  ], shift(accent, 1.0, 55));
  // The glyph: a blunt cat head with two sharp ears. Kept to three simple
  // masses - at thirteen pixels wide anything finer is mush.
  for (const d of [-1, 1] as const) {
    s.poly([
      [cx + d * w * 0.44, cy - h * 0.62],
      [cx + d * w * 0.16, cy - h * 0.06],
      [cx + d * w * 0.54, cy - h * 0.06],
    ], SUIT_SH);
  }
  s.poly([
    [cx - w * 0.50, cy - h * 0.14],
    [cx + w * 0.50, cy - h * 0.14],
    [cx + w * 0.42, cy + h * 0.20],
    [cx + w * 0.20, cy + h * 0.42],
    [cx - w * 0.20, cy + h * 0.42],
    [cx - w * 0.42, cy + h * 0.20],
  ], SUIT_SH);
}

function drawSuitFront(s: Surface, t: Torso, accent: string): void {
  s.rect(t.x - t.rx * 1.3, t.y - t.ry * 1.3, t.rx * 2.6, t.ry * 2.6, SUIT);
  // Chest and shoulders take the light; the belly falls away.
  s.poly([
    [t.x - t.rx * 1.3, t.y - t.ry * 1.3],
    [t.x + t.rx * 1.3, t.y - t.ry * 1.3],
    [t.x + t.rx * 1.1, t.y - t.ry * 0.30],
    [t.x, t.y - t.ry * 0.10],
    [t.x - t.rx * 1.1, t.y - t.ry * 0.30],
  ], SUIT_LIT);
  s.rect(t.x - t.rx * 0.9, t.y - t.ry * 0.86, t.rx * 1.8, t.ry * 0.16, SUIT_SPEC);
  s.rect(t.x - t.rx * 1.3, t.y + t.ry * 0.74, t.rx * 2.6, t.ry * 0.56, SUIT_SH);

  drawBadge(s, t.x, t.y - t.ry * 0.30, t.rx * 0.40, accent);
  // No belt: a gold band with pouches is the famous hero's utility belt, and
  // BatCat has to be its own character. The suit is badge, cowl and cape.
}

function drawSuitSide(s: Surface, t: Torso, accent: string): void {
  s.rect(t.x - t.rx * 1.3, t.y - t.ry * 1.3, t.rx * 2.6, t.ry * 2.6, SUIT);
  s.poly([
    [t.x - t.rx * 0.30, t.y - t.ry * 1.3],
    [t.x + t.rx * 1.3, t.y - t.ry * 1.3],
    [t.x + t.rx * 1.3, t.y - t.ry * 0.05],
    [t.x - t.rx * 0.20, t.y - t.ry * 0.40],
  ], SUIT_LIT);
  s.rect(t.x - t.rx * 0.1, t.y - t.ry * 0.92, t.rx * 1.3, t.ry * 0.16, SUIT_SPEC);
  s.rect(t.x - t.rx * 1.3, t.y + t.ry * 0.74, t.rx * 2.6, t.ry * 0.56, SUIT_SH);
  // Badge sits on the chest, which in profile is forward of centre.
  drawBadge(s, t.x + t.rx * 0.52, t.y - t.ry * 0.26, t.rx * 0.26, accent);
}

function drawSuitBack(s: Surface, t: Torso): void {
  s.rect(t.x - t.rx * 1.3, t.y - t.ry * 1.3, t.rx * 2.6, t.ry * 2.6, SUIT);
}

// ---------------------------------------------------------------------------

export function batCatPainter(colour: string): CostumePainter {
  const accent = resolveBatcatColour(colour);

  return (ctx: Ctx, pose: PoseSpec, layer: CostumeLayer): void => {
    const { torso, head, skull, faces } = bodyAnchors(pose);

    if (layer === "face") {
      if (pose.view === "back") return;
      ctx.save();
      ctx.scale(1 / S, 1 / S);
      if (pose.view === "side") drawCowlSide(ctx, skull, accent, faces);
      else drawCowlFront(ctx, skull, accent);
      ctx.restore();
      return;
    }

    if (layer === "limbs") {
      if (pose.view === "side" || pose.view === "back") return;
      ctx.save();
      ctx.scale(1 / S, 1 / S);
      for (const limb of frontLimbs(pose, torso.y + 2)) {
        // Sleeve to the wrist, then a gauntlet cuff in the accent.
        stampSleeve(ctx, limb, 0, 0.52, 1.1, SUIT);
        stampSleeve(ctx, limb, 0.02, 0.18, 1.12, SUIT_LIT);
        stampSleeve(ctx, limb, 0.44, 0.52, 1.18, accent);
        stampSleeve(ctx, limb, 0.5, 0.52, 1.14, shift(accent, 0.62));
      }
      ctx.restore();
      return;
    }

    const side = pose.view === "side";
    const rx = torso.rx * (side ? 1.02 : 1);
    const ry = torso.ry * (side ? 0.97 : 1);
    if (rx <= 0 || ry <= 0) return;
    const t: Torso = { x: torso.x + (side ? faces * torso.rx * 0.2 : 0), y: torso.y, rx, ry };

    ctx.save();
    ctx.scale(1 / S, 1 / S);
    // Cape first and unclipped, so the suit overlaps its inner edge.
    if (pose.view === "back") {
      drawCowlBack(ctx, skull);
      drawCapeBack(ctx, t, head);
    }
    else if (side) drawCapeSide(ctx, t, head, faces);
    else drawCapeFront(ctx, t, head);
    const s = new Surface(ctx, t, side && faces === -1);
    if (side) drawSuitSide(s, t, accent);
    else if (pose.view === "back") drawSuitBack(s, t);
    else drawSuitFront(s, t, accent);
    ctx.restore();
  };
}
