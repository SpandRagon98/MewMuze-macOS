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
  type LimbPoint,
  type PoseSpec,
} from "../animation/spriteLoader";
import { S, Surface, stampSleeve, type Ctx, type Torso } from "./pixelSurface";

const NAVY = "#1b2b4d";
const NAVY_HI = "#2c4373";
const NAVY_SH = "#0e1830";
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
function drawSide(s: Surface, t: Torso): void {
  // The cat faces +x in side view; the renderer mirrors the finished sprite for
  // a left-facing cat, so this is drawn once for "facing right".
  // The chest opening sits INBOARD, not at the leading edge: the torso ellipse
  // narrows sharply there, so a wedge placed at the edge was clipped down to a
  // sliver and the whole cat read as plain navy.
  const chest = t.x + t.rx * 0.10;

  // Body of the jacket. Clipped to the torso, so this rectangle takes the
  // body's own curve rather than looking like a rectangle.
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, NAVY);

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
  ], NAVY_HI);

  // Shoulder highlight behind the lapel.
  s.poly([
    [t.x - t.rx * 1.05, t.y - t.ry * 0.42],
    [t.x - t.rx * 0.34, t.y - t.ry * 1.05],
    [chest - t.rx * 0.30, t.y - t.ry * 1.05],
    [chest - t.rx * 0.42, t.y - t.ry * 0.30],
    [t.x - t.rx * 1.05, t.y + t.ry * 0.10],
  ], NAVY_HI);

  // Hem band along the belly.
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.62, t.rx * 1.5, t.ry * 0.5, NAVY_SH);

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
function drawFront(s: Surface, t: Torso): void {
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, NAVY);

  // Shoulders catch the light; the lower body falls into shadow.
  s.poly([
    [t.x - t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 1.05],
    [t.x + t.rx * 1.05, t.y - t.ry * 0.62],
    [t.x, t.y - t.ry * 0.30],
    [t.x - t.rx * 1.05, t.y - t.ry * 0.62],
  ], NAVY_HI);
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.60, t.rx * 2.1, t.ry * 0.5, NAVY_SH);

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
    ], NAVY_HI);
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
function drawBack(s: Surface, t: Torso): void {
  s.rect(t.x - t.rx * 1.05, t.y - t.ry * 1.05, t.rx * 2.1, t.ry * 2.1, NAVY);
  s.poly([
    [t.x - t.rx * 0.42, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.42, t.y - t.ry * 1.05],
    [t.x + t.rx * 0.36, t.y - t.ry * 0.70],
    [t.x - t.rx * 0.36, t.y - t.ry * 0.70],
  ], NAVY_HI);
  s.rect(t.x - t.rx * 0.05, t.y - t.ry * 0.10, t.rx * 0.1, t.ry * 1.15, NAVY_SH);
  s.rect(t.x - t.rx * 1.05, t.y + t.ry * 0.60, t.rx * 2.1, t.ry * 0.5, NAVY_SH);
}

/**
 * A sleeve along the upper half of a foreleg.
 *
 * Drawn on the SAME curve the renderer strokes for that limb (frontLimbs), so
 * it moves with the arm through every gesture - typing, waving, kneading,
 * clapping - instead of sitting still while the arm animates underneath it.
 * Only the upper half: a blazer has a cuff, not a glove.
 */
function drawSleeve(ctx: Ctx, limb: { from: LimbPoint; ctrl: LimbPoint; to: LimbPoint }, width: number): void {
  const r = width / 2;
  // Down past the hem, or the sleeve never leaves the jacket and there is no
  // arm to see. A lit top edge, a shadow underneath, then a white shirt cuff
  // right above the paw - the cuff is what turns a navy stripe into a sleeve.
  stampSleeve(ctx, limb, 0, 0.80, r, NAVY);
  stampSleeve(ctx, limb, 0, 0.30, r * 0.62, NAVY_HI);
  // The jacket covers the arm down to about y 41.6, and the paw starts at 41.1
  // - so this narrow band across the wrist is the ONLY part of the sleeve that
  // can ever be seen. A dark line, then a white cuff over the top of the paw:
  // that pair is what turns a navy ball into a cat with hands.
  stampSleeve(ctx, limb, 0.66, 0.78, r * 0.92, NAVY_SH);
  stampSleeve(ctx, limb, 0.78, 0.94, r * 0.95, SHIRT);
  stampSleeve(ctx, limb, 0.92, 0.94, r * 0.88, SHIRT_SH);
}

/**
 * Paint the jacket as part of the sprite, one layer at a time.
 *
 * Registered with the renderer rather than composited afterwards, so the
 * forelegs, the keyboard and the laptop all draw ON TOP of the clothing - the
 * z-order a real garment has.
 */
export function paintCorporateCat(ctx: Ctx, pose: PoseSpec, layer: CostumeLayer): void {
  const { torso, faces } = bodyAnchors(pose);
  const rx = torso.rx * 0.94;
  const ry = torso.ry * 0.94;
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
      drawSleeve(ctx, limb, 2.9);
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
    drawSide(surface, t);
  } else if (pose.view === "back") {
    drawBack(surface, t);
  } else {
    drawFront(surface, t);
  }
  // Last, so it sits over every panel it borders.
  surface.edge(NAVY_SH);
  ctx.restore();
}

export const CORPORATE_CAT_ID = "mewmuze.corporate-cat.v1";
