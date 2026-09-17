//! "Your Corporate Cat" — drawn from the pose, not blitted from a bitmap.
//!
//! A flat image scaled onto the torso's bounding ellipse can follow where the
//! body IS, but never what shape it is: on a lying cat it squashed into a slab,
//! and on a standing one it was a rectangle laid over a round body. Clothes
//! read as clothes only when they take the body's outline.
//!
//! So the jacket is CLIPPED TO THE TORSO ELLIPSE and drawn inside it. Two
//! things follow for free, and both were bugs in the bitmap version:
//!
//!   * It fills the body exactly, at every pose and every species, because the
//!     ellipse is the body — a lying cat gets a long low jacket, a sitting one
//!     a tall narrow jacket, with no per-pose artwork.
//!   * It can never cover a raised paw. Limbs are drawn OUTSIDE the torso
//!     ellipse, so clipping to it means typing, waving and kneading keep their
//!     hands no matter how large the garment is.
//!
//! Everything is in the renderer's 48-unit design space, so the numbers here
//! read the same as the ones in spriteLoader.

import {
  bodyAnchors,
  frontLimbs,
  type CostumeLayer,
  type CostumePainter,
  type CostumeTraits,
  type LimbPoint,
  type PoseSpec,
} from "../animation/spriteLoader";
import { S, Surface, shift, stampSleeve, type Ctx, type Torso } from "./pixelSurface";

/**
 * Suit colours offered in Settings. Navy first: it is what the costume was
 * designed around, and what an existing install keeps.
 */
export const CORPORATE_COLOURS = [
  { id: "navy", label: "Navy Blue", hex: "#1b2b4d" },
  { id: "charcoal", label: "Charcoal", hex: "#3b4049" },
  { id: "gray", label: "Light Gray", hex: "#aeb4bd" },
  { id: "sky", label: "Light Blue", hex: "#8db3dc" },
  { id: "black", label: "Black", hex: "#1c1d21" },
  { id: "tan", label: "Tan", hex: "#b3946b" },
] as const;

export const DEFAULT_CORPORATE_COLOUR = CORPORATE_COLOURS[0].hex;

/** The chosen hex, or navy if it is not one this costume offers. */
export function resolveCorporateColour(hex: string): string {
  return CORPORATE_COLOURS.some((c) => c.hex === hex) ? hex : DEFAULT_CORPORATE_COLOUR;
}

/** The jacket's three tones, all derived from the one chosen colour. */
interface Suit {
  base: string;
  lit: string;
  shade: string;
}

function suitFor(hex: string): Suit {
  // Navy is kept to its original hand-picked tones, so the default suit looks
  // exactly as it did before colours existed.
  if (hex === DEFAULT_CORPORATE_COLOUR) return { base: "#1b2b4d", lit: "#2c4373", shade: "#0e1830" };
  return { base: hex, lit: shift(hex, 1.0, 30), shade: shift(hex, 0.56) };
}
const SHIRT = "#f5f8fb";
const SHIRT_SH = "#cfd7e2";
const TIE = "#8c2b3d";
const TIE_HI = "#a8384c";

/**
 * The side jacket.
 *
 * `t` is the live torso. Everything is expressed as a fraction of its radii, so
 * the collar stays at the shoulder and the hem at the belly whether the cat is
 * standing, sitting, crouching or stretched out flat.
 */
function drawSide(s: Surface, t: Torso, p: Suit): void {
  // The cat faces +x in side view; the renderer mirrors the finished sprite for
  // a left-facing cat, so this is drawn once for "facing right".
  // The chest opening sits INBOARD, not at the leading edge: the torso ellipse
  // narrows sharply there, so a wedge placed at the edge was clipped down to a
  // sliver and the whole cat read as plain navy.
  const chest = t.x + t.rx * 0.10;

  // Body of the jacket. Clipped to the torso, so this rectangle takes the
  // body's own curve rather than looking like a rectangle.
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, p.base);

  // Shirt: a broad panel over the front half of the body.
  s.poly([
    [chest + t.rx * 0.04, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y + t.ry * 1.05],
    [chest + t.rx * 0.52, t.y + t.ry * 1.05],
  ], SHIRT);
  s.poly([
    [t.x + t.rx * 0.74, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y + t.ry * 1.05],
    [t.x + t.rx * 0.80, t.y + t.ry * 1.05],
  ], SHIRT_SH);

  // Lapel: the jacket edge folding back over the shirt, from shoulder to belly.
  s.poly([
    [chest - t.rx * 0.34, t.y - t.ry * 1.05],
    [chest + t.rx * 0.14, t.y - t.ry * 1.05],
    [chest + t.rx * 0.40, t.y + t.ry * 1.05],
    [chest - t.rx * 0.10, t.y + t.ry * 1.05],
  ], p.lit);

  // Shoulder highlight behind the lapel.
  s.poly([
    [t.x - t.rx * 1.05, t.y - t.ry * 0.42],
    [t.x - t.rx * 0.34, t.y - t.ry * 1.05],
    [chest - t.rx * 0.30, t.y - t.ry * 1.05],
    [chest - t.rx * 0.42, t.y - t.ry * 0.30],
    [t.x - t.rx * 1.05, t.y + t.ry * 0.10],
  ], p.lit);

  // Hem band along the belly.
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.62, t.rx * 1.5, t.ry * 0.5, p.shade);

  // Tie down the shirt panel.
  const tie = chest + t.rx * 0.52;
  s.poly([
    [tie - t.rx * 0.13, t.y - t.ry * 1.05],
    [tie + t.rx * 0.15, t.y - t.ry * 1.05],
    [tie + t.rx * 0.14, t.y - t.ry * 0.62],
    [tie - t.rx * 0.11, t.y - t.ry * 0.64],
  ], TIE_HI);
  s.poly([
    [tie - t.rx * 0.11, t.y - t.ry * 0.62],
    [tie + t.rx * 0.14, t.y - t.ry * 0.62],
    [tie + t.rx * 0.22, t.y + t.ry * 0.60],
    [tie - t.rx * 0.02, t.y + t.ry * 0.62],
  ], TIE);
}

/** The front jacket: symmetric, both lapels, tie down the middle. */
function drawFront(s: Surface, t: Torso, p: Suit): void {
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, p.base);

  // Shoulders catch the light; the lower body falls into shadow.
  s.poly([
    [t.x - t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 0.62],
    [t.x, t.y - t.ry * 0.30],
    [t.x - t.rx * 1.05, t.y - t.ry * 0.62],
  ], p.lit);
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.60, t.rx * 2.1, t.ry * 0.5, p.shade);

  // Shirt: a V, wide at the collar and converging at the button. A parallel
  // band read as a bib; the taper is what makes it a jacket opening.
  s.poly([
    [t.x - t.rx * 0.56, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.56, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.17, t.y + t.ry * 0.46],
    [t.x - t.rx * 0.17, t.y + t.ry * 0.46],
  ], SHIRT);

  // Collar points and lapels, mirrored.
  for (const side of [-1, 1]) {
    s.poly([
      [t.x + side * t.rx * 0.50, t.y - t.ry * 1.05],
      [t.x + side * t.rx * 0.14, t.y - t.ry * 1.05],
      [t.x + side * t.rx * 0.26, t.y - t.ry * 0.52],
    ], SHIRT_SH);
    // Lapel: the jacket edge running down the side of the V to the button.
    s.poly([
      [t.x + side * t.rx * 0.86, t.y - t.ry * 1.05],
      [t.x + side * t.rx * 0.50, t.y - t.ry * 1.05],
      [t.x + side * t.rx * 0.15, t.y + t.ry * 0.44],
      [t.x + side * t.rx * 0.44, t.y + t.ry * 0.40],
    ], p.lit);
  }

  // Tie.
  s.poly([
    [t.x - t.rx * 0.17, t.y - t.ry * 0.98],
    [t.x + t.rx * 0.17, t.y - t.ry * 0.98],
    [t.x + t.rx * 0.14, t.y - t.ry * 0.62],
    [t.x - t.rx * 0.14, t.y - t.ry * 0.62],
  ], TIE_HI);
  s.poly([
    [t.x - t.rx * 0.15, t.y - t.ry * 0.62],
    [t.x + t.rx * 0.15, t.y - t.ry * 0.62],
    [t.x + t.rx * 0.10, t.y + t.ry * 0.42],
    [t.x - t.rx * 0.10, t.y + t.ry * 0.42],
  ], TIE);
}

/** The back: all jacket, with a collar band and a centre vent. */
function drawBack(s: Surface, t: Torso, p: Suit): void {
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, p.base);
  s.poly([
    [t.x - t.rx * 0.42, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.42, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.36, t.y - t.ry * 0.70],
    [t.x - t.rx * 0.36, t.y - t.ry * 0.70],
  ], p.lit);
  s.rect(t.x - t.rx * 0.05, t.y - t.ry * 0.10, t.rx * 0.1, t.ry * 1.15, p.shade);
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.60, t.rx * 2.1, t.ry * 0.5, p.shade);
}

/**
 * A sleeve along the upper half of a foreleg.
 *
 * Drawn on the SAME curve the renderer strokes for that limb (frontLimbs), so
 * it moves with the arm through every gesture - typing, waving, kneading,
 * clapping - instead of sitting still while the arm animates underneath it.
 * Only the upper half: a blazer has a cuff, not a glove.
 */
function drawSleeve(ctx: Ctx, limb: { from: LimbPoint; ctrl: LimbPoint; to: LimbPoint }, width: number, p: Suit): void {
  const r = width / 2;
  // A navy arm over a navy blazer has nothing to separate it from the body,
  // so every raised paw vanished and only the cuff showed. Three things make
  // it a tube in front of the chest instead: a shadow outline round it, a lit
  // crease down its length, and a shadowed cuff. The outline starts clear of
  // the shoulder so it does not ring the joint.
  stampSleeve(ctx, limb, 0.14, 0.80, r + 0.42, p.shade);
  stampSleeve(ctx, limb, 0, 0.80, r, p.base);
  stampSleeve(ctx, limb, 0.04, 0.70, r * 0.5, p.lit);
  stampSleeve(ctx, limb, 0.76, 0.94, r * 0.95 + 0.32, p.shade);
  stampSleeve(ctx, limb, 0.79, 0.94, r * 0.95, SHIRT);
  stampSleeve(ctx, limb, 0.92, 0.94, r * 0.88, SHIRT_SH);
}

/**
 * Paint the jacket as part of the sprite, one layer at a time.
 *
 * Registered with the renderer rather than composited afterwards, so the
 * forelegs, the keyboard and the laptop all draw ON TOP of the clothing - the
 * z-order a real garment has.
 */
/**
 * Build a painter for one suit colour.
 *
 * A closure, like the Cyberpunk jacket's: the colour is baked into the
 * function the renderer holds, and the same colour goes into the sprite cache
 * key, so a cached frame can never come back in the previous colour.
 */
export function corporatePainter(colour: string): CostumePainter {
  const p = suitFor(resolveCorporateColour(colour));
  return (ctx: Ctx, pose: PoseSpec, layer: CostumeLayer): void => paintSuit(ctx, pose, layer, p);
}

function paintSuit(ctx: Ctx, pose: PoseSpec, layer: CostumeLayer, p: Suit): void {
  // Nothing is worn on the head. The "face" seam runs LAST, after the paws and
  // props, so answering it with the jacket repainted the torso over every raised
  // arm, the book, the keyboard and the notebook.
  if (layer === "face") return;
  const { torso, faces } = bodyAnchors(pose);
  // EXACTLY the ellipse the renderer draws for the body. A shrunken copy left
  // a ring of bare fur round the jacket, which is most of why it read as an
  // image laid over the cat rather than something it was wearing.
  const rx = torso.rx;
  const ry = torso.ry;
  if (rx <= 0 || ry <= 0) return;
  const t: Torso = { x: torso.x, y: torso.y, rx, ry };

  if (layer === "limbs") {
    // Side view keeps its painted-on sleeve: the side foreleg is drawn as part
    // of the body mass rather than as a separate limb path.
    if (pose.view === "side" || pose.view === "back") return;
    // by + 2 is the shoulder line drawFront passes to drawFrontPaws.
    ctx.save();
    ctx.scale(1 / S, 1 / S);
    for (const limb of frontLimbs(pose, torso.y + 2)) {
      drawSleeve(ctx, limb, 2.4, p);
    }
    ctx.restore();
    return;
  }

  // Device pixels from here on. The painter is handed a context scaled to the
  // 48-unit design space, but this costume rasterises itself a pixel at a time
  // - exactly as the cat's own body does - so that scale is undone rather than
  // drawn through. Anything drawn through it would be anti-aliased and would
  // meet the fur with a soft fringe.
  ctx.save();
  ctx.scale(1 / S, 1 / S);
  // The curled sleeping cat is the one side pose drawn mirrored; the Surface
  // flips the pixel column so the lapel and tie land on its chest, not its tail.
  const surface = new Surface(ctx, t, pose.view === "side" && faces === -1);

  if (pose.view === "side") {
    drawSide(surface, t, p);
  } else if (pose.view === "back") {
    drawBack(surface, t, p);
  } else {
    drawFront(surface, t, p);
  }
  // No outline: a dark ring round the whole garment is exactly what made it
  // look like a sticker. The body's own silhouette is the jacket's edge.
  ctx.restore();
}

export const CORPORATE_CAT_ID = "mewmuze.corporate-cat.v1";
/** A suit covers nothing the face uses. */
export const CORPORATE_TRAITS: CostumeTraits = {};
