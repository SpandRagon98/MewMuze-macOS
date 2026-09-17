//! Pixel-snapped drawing for costumes.
//!
//! The cat's own body is emitted a pixel at a time (`fillRect(x, y, 1, 1)`), so
//! every edge lands on the pixel grid. Canvas path fills, clips and strokes are
//! all anti-aliased, and against pixel art that reads as a soft half-
//! transparent fringe wherever a garment meets fur. Everything here rasterises
//! the same way the cat does.
//!
//! Shared by every costume painter; see corporateCat.ts and cyberpunkCat.ts.

import { S, type LimbPoint } from "../animation/spriteLoader";

/**
 * Scale a hex colour's channels by `factor`, then lift them by `lift`.
 *
 * How every costume derives its lit and shadow tones from one chosen colour,
 * so the whole palette moves together when the customer picks a new one.
 */
export function shift(hex: string, factor: number, lift = 0): string {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * factor + lift);
  const g = clamp(((n >> 8) & 255) * factor + lift);
  const b = clamp((n & 255) * factor + lift);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Design units to device pixels: the renderer's own, live for the frame being drawn. */
export { S };

export type Ctx = CanvasRenderingContext2D;

export interface Torso {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/**
 * A pixel-snapped drawing surface for one frame of the costume.
 *
 * Every shape is described in the renderer's 48-unit design space and emitted
 * as whole device pixels, so the garment's edges sit on the same grid as the
 * cat's. Three things it does that a plain canvas path cannot:
 *
 *   * No anti-aliasing. A `ctx.fill()` edge lands on fractional pixels and
 *     canvas softens it; against pixel art that fringe is what made the jacket
 *     look pasted on rather than drawn.
 *   * The torso ellipse is a per-pixel test, not `ctx.clip()`, so the garment's
 *     outline is as crisp as the body's own silhouette.
 *   * Mirroring for a left-facing cat is arithmetic on the pixel column rather
 *     than a canvas transform, which would have re-introduced sampling.
 */
export class Surface {
  private readonly ctx: Ctx;
  private readonly cx: number;
  private readonly cy: number;
  private readonly rx: number;
  private readonly ry: number;
  private readonly mirror: boolean;
  /** Pixel bounds of the torso, so nothing outside it is even considered. */
  private readonly x0: number;
  private readonly y0: number;
  private readonly x1: number;
  private readonly y1: number;

  constructor(ctx: Ctx, t: Torso, mirror: boolean) {
    this.ctx = ctx;
    this.cx = t.x * S;
    this.cy = t.y * S;
    this.rx = t.rx * S;
    this.ry = t.ry * S;
    this.mirror = mirror;
    this.x0 = Math.floor(this.cx - this.rx);
    this.x1 = Math.ceil(this.cx + this.rx);
    this.y0 = Math.floor(this.cy - this.ry);
    this.y1 = Math.ceil(this.cy + this.ry);
  }

  /** Inside the torso? Tested at the pixel's centre, exactly as `blob` does. */
  private inside(x: number, y: number): boolean {
    const nx = (x + 0.5 - this.cx) / this.rx;
    const ny = (y + 0.5 - this.cy) / this.ry;
    return nx * nx + ny * ny <= 1;
  }

  /** One whole pixel, mirrored about the torso centre when facing left. */
  private plot(x: number, y: number): void {
    const px = this.mirror ? Math.round(2 * this.cx - 1 - x) : x;
    this.ctx.fillRect(px, y, 1, 1);
  }

  /** Fill a design-space polygon. Scanline, half-open, no AA. */
  poly(points: number[][], colour: string): void {
    const pts = points.map(([x, y]) => [x * S, y * S]);
    const top = Math.max(this.y0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    const bottom = Math.min(this.y1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    this.ctx.fillStyle = colour;
    for (let y = top; y <= bottom; y++) {
      const scan = y + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= scan && by > scan) || (by <= scan && ay > scan)) {
          crossings.push(ax + ((scan - ay) / (by - ay)) * (bx - ax));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(this.x0, Math.round(crossings[k]));
        const to = Math.min(this.x1, Math.round(crossings[k + 1]));
        for (let x = from; x < to; x++) {
          if (this.inside(x, y)) this.plot(x, y);
        }
      }
    }
  }

  /**
   * A one-pixel darker rim around the garment's silhouette.
   *
   * The cat gets a crisp outline from applyAppearanceStroke; without an
   * equivalent the jacket just changed colour where it met the fur, which is
   * what made the edge look unfinished. This traces the same ellipse the
   * garment is clipped to, so the rim is exactly the garment's own boundary.
   */
  edge(colour: string): void {
    this.ctx.fillStyle = colour;
    for (let y = this.y0; y <= this.y1; y++) {
      for (let x = this.x0; x <= this.x1; x++) {
        if (!this.inside(x, y)) continue;
        // A rim pixel is one with at least one neighbour outside the body.
        if (
          this.inside(x - 1, y) &&
          this.inside(x + 1, y) &&
          this.inside(x, y - 1) &&
          this.inside(x, y + 1)
        ) {
          continue;
        }
        this.plot(x, y);
      }
    }
  }

  /** Axis-aligned design-space rectangle. */
  rect(x: number, y: number, w: number, h: number, colour: string): void {
    this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], colour);
  }

  /**
   * A rectangle filled on every other pixel, in a checkerboard.
   *
   * The pixel-art way to blend two tones. A hard edge between a lit band and
   * the base reads as a flat stripe; a dithered step reads as a curved
   * surface. Clipped to the body like everything else here.
   */
  dither(x: number, y: number, w: number, h: number, colour: string): void {
    const x0 = Math.max(this.x0, Math.floor(x * S));
    const x1 = Math.min(this.x1, Math.ceil((x + w) * S));
    const y0 = Math.max(this.y0, Math.floor(y * S));
    const y1 = Math.min(this.y1, Math.ceil((y + h) * S));
    this.ctx.fillStyle = colour;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (((px + py) & 1) === 0 && this.inside(px, py)) this.plot(px, py);
      }
    }
  }
}

/**
 * A sleeve stamped along a limb curve, pixel by pixel.
 *
 * Deliberately NOT clipped to the torso: a sleeve's whole job is to be on the
 * arm, which is outside the body ellipse. It is stamped as a run of small
 * filled discs so the edge is as hard as the leg it covers, where a
 * `ctx.stroke()` would have feathered it.
 */
export function stampSleeve(
  ctx: Ctx,
  limb: { from: LimbPoint; ctrl: LimbPoint; to: LimbPoint },
  fromT: number,
  toT: number,
  radius: number,
  colour: string,
): void {
  const at = (t: number) => ({
    x: ((1 - t) * (1 - t) * limb.from.x + 2 * (1 - t) * t * limb.ctrl.x + t * t * limb.to.x) * S,
    y: ((1 - t) * (1 - t) * limb.from.y + 2 * (1 - t) * t * limb.ctrl.y + t * t * limb.to.y) * S,
  });
  const r = radius * S;
  ctx.fillStyle = colour;
  // Step finely enough that consecutive discs overlap; the limb is only a few
  // design units long, so this is a few dozen pixels of work.
  const steps = Math.max(6, Math.ceil((toT - fromT) * 48));
  for (let i = 0; i <= steps; i++) {
    const p = at(fromT + ((toT - fromT) * i) / steps);
    for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++) {
      for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
        const dx = x + 0.5 - p.x;
        const dy = y + 0.5 - p.y;
        if (dx * dx + dy * dy <= r * r) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

/**
 * A pixel-snapped rectangle in design units, drawn WITHOUT any body clip.
 *
 * For the parts of a garment that deliberately leave the torso - a collar
 * rising onto the neck, a cuff past the wrist. Everything inside the body
 * should go through Surface instead, which confines it.
 */
export function pxRect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.fillRect(
    Math.round(x * S),
    Math.round(y * S),
    Math.max(1, Math.round(w * S)),
    Math.max(1, Math.round(h * S)),
  );
}

/** A pixel-snapped polygon with no body clip; same scanline rule as Surface. */
export function pxPoly(ctx: Ctx, points: number[][], colour: string): void {
  const pts = points.map(([x, y]) => [x * S, y * S]);
  const top = Math.floor(Math.min(...pts.map((p) => p[1])));
  const bottom = Math.ceil(Math.max(...pts.map((p) => p[1])));
  ctx.fillStyle = colour;
  for (let y = top; y <= bottom; y++) {
    const scan = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= scan && by > scan) || (by <= scan && ay > scan)) {
        xs.push(ax + ((scan - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.round(xs[k]);
      const to = Math.round(xs[k + 1]);
      for (let x = from; x < to; x++) ctx.fillRect(x, y, 1, 1);
    }
  }
}
