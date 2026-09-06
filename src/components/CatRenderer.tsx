import { forwardRef, useImperativeHandle, useRef } from "react";
import type { RenderInfo } from "../engine/catEngine";
import { COLS as MESH_COLS, ROWS as MESH_ROWS } from "../physics/mochiMesh";
import {
  applyAppearanceStroke,
  renderFrame,
  spriteEpoch,
  DEFAULT_POSE,
  type PoseSpec,
} from "../animation/spriteLoader";
import {
  composeCostumeSprite,
  costumeOverlayEpoch,
  costumeOverlayFrame,
} from "../costumes/costumeOverlay";

/**
 * A single full-overlay <canvas>. Everything except the cat is transparent.
 *
 * The backing store is sized to the whole virtual desktop in PHYSICAL pixels
 * and displayed at CSS 100%, so engine coordinates (physical px) map 1:1 to the
 * screen regardless of the window's DPI scale factor. Sprites are blitted with
 * nearest-neighbour scaling for crisp pixel-art.
 */
export interface CatRendererHandle {
  /**
   * Draw one frame. `visibility` (0..1) drives the Cat On/Off entrance and exit
   * transitions: the sprite fades and shrinks toward its feet as it goes to 0.
   */
  draw(render: RenderInfo | null, physicalWidth: number, physicalHeight: number, visibility?: number): void;
}

/**
 * Scratch pose reused every frame. `renderFrame` only reads it (to build a
 * cache key and rasterise), so a single mutable instance avoids allocating a
 * fresh pose object 60 times a second.
 */
const scratchPose: PoseSpec = { ...DEFAULT_POSE };

export interface DirtyRect { x: number; y: number; w: number; h: number }

/** Expand a floating-point paint bound to complete device pixels. */
export function outwardDirtyRect(rect: DirtyRect): DirtyRect {
  const left = Math.floor(rect.x);
  const top = Math.floor(rect.y);
  const right = Math.ceil(rect.x + rect.w);
  const bottom = Math.ceil(rect.y + rect.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Return the device-pixel bounds that the canvas transform actually paints.
 *
 * A left-facing side sprite is mirrored around the cat's X coordinate. Mesh
 * deformation is asymmetric, so its mirrored paint bounds are not the same as
 * the unmirrored bounds. Remembering the latter leaves individual textured
 * triangles behind when the cat moves quickly.
 */
export function paintedDirtyRect(rect: DirtyRect, mirrorAxisX: number | null): DirtyRect {
  const painted =
    mirrorAxisX === null
      ? rect
      : {
          x: mirrorAxisX * 2 - (rect.x + rect.w),
          y: rect.y,
          w: rect.w,
          h: rect.h,
        };
  return outwardDirtyRect(painted);
}

/**
 * Compact digest of the deformable-mesh offsets. The renderer skips repainting
 * when nothing changed, so the deformation has to be part of that check or a
 * drag would freeze the picture while the physics carried on underneath.
 * Quantised so a settling body that has effectively stopped stops repainting.
 */
function meshSignature(mesh: Float32Array | null): string {
  if (!mesh) return "";
  let s = "";
  for (let i = 0; i < mesh.length; i++) s += Math.round(mesh[i] * 100).toString(36) + ",";
  return s;
}

/**
 * Draw one texture-mapped triangle: map the source triangle (s*) of `img` onto
 * the destination triangle (d*) with an affine transform, clipped to the dest
 * triangle. Neighbouring triangles share vertices exactly, so the warped
 * silhouette can never tear — the whole reason the drag uses a mesh.
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number,
): void {
  ctx.save();
  // Expand the clip a hair outward from the centroid so adjacent triangles
  // overlap by a sub-pixel and antialiased seams don't show as hairlines.
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const grow = (x: number, y: number): [number, number] => {
    const vx = x - cx, vy = y - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [x + (vx / len) * 1.0, y + (vy / len) * 1.0];
  };
  const [ex0, ey0] = grow(dx0, dy0);
  const [ex1, ey1] = grow(dx1, dy1);
  const [ex2, ey2] = grow(dx2, dy2);
  ctx.beginPath();
  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();

  // Affine mapping source triangle -> dest triangle (see derivation: subtract
  // vertex 0, solve the 2x2, back out the translation).
  const p = sx1 - sx0, q = sy1 - sy0;
  const r = sx2 - sx0, s = sy2 - sy0;
  const det = p * s - q * r;
  if (det !== 0) {
    const id = 1 / det;
    const a = ((dx1 - dx0) * s - (dx2 - dx0) * q) * id;
    const c = (p * (dx2 - dx0) - r * (dx1 - dx0)) * id;
    const e = dx0 - a * sx0 - c * sy0;
    const b = ((dy1 - dy0) * s - (dy2 - dy0) * q) * id;
    const d = (p * (dy2 - dy0) - r * (dy1 - dy0)) * id;
    const f = dy0 - b * sx0 - d * sy0;
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();
}

function drawCatSprite(
  ctx: CanvasRenderingContext2D,
  render: RenderInfo,
  visibility: number,
): DirtyRect {
  // Inject the smoothed cursor-tracking pupil offsets — but only when the
  // animation frame hasn't deliberately posed the eyes (e.g. the embarrassed
  // sideways glance or a book-reading scan). Baked pupils always win. Side-view
  // art is mirrored for left-facing cats, so pre-flip X to keep the gaze aimed
  // at the real cursor.
  const sideFlip = render.facing === "left" && render.pose.view === "side";
  const baked = render.pose.pupilX !== 0 || render.pose.pupilY !== 0;
  const tracking = !baked && (render.pupilX !== 0 || render.pupilY !== 0);
  // The tail sways continuously, so the live phase is always applied on top of
  // whatever the animation frame declared.
  Object.assign(scratchPose, render.pose);
  scratchPose.tailPhase = render.tailPhase;
  if (tracking) {
    scratchPose.pupilX = sideFlip ? -render.pupilX : render.pupilX;
    scratchPose.pupilY = render.pupilY;
  }
  // Head lean rides along with the gaze; mirrored art needs X pre-flipped so
  // the cat leans toward the real cursor, not away from it.
  scratchPose.headTurnX = sideFlip ? -render.headTurnX : render.headTurnX;
  scratchPose.headTurnY = render.headTurnY;
  const sprite = applyAppearanceStroke(composeCostumeSprite(renderFrame(scratchPose), scratchPose));
  const size = render.sizePx;

  // Landing squash (wider + shorter) and the on/off transition scale.
  const scaleX = (1 + render.squash * 0.22) * (0.4 + 0.6 * visibility);
  const scaleY = (1 - render.squash * 0.28) * (0.4 + 0.6 * visibility);
  // Raster art is finally placed on physical device pixels. Fractional canvas
  // bounds can leave a partially covered edge after `clearRect`, which shows up
  // as a one-pixel trail during a fast drag.
  const drawW = Math.max(1, Math.round(size * scaleX));
  const drawH = Math.max(1, Math.round(size * scaleY));
  const left = Math.round(render.x - drawW / 2);
  const top = Math.round(render.y - drawH);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = visibility;
  // Front/back/three-quarter art owns its silhouette. Mirroring is reserved for
  // left/right side profiles so a seated cat never flips its face unnaturally.
  if (sideFlip) {
    ctx.translate(render.x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-render.x, 0);
  }

  const mesh = render.mesh;
  let dirty: DirtyRect;
  if (!mesh) {
    // Rest: one cheap blit.
    ctx.drawImage(sprite, left, top, drawW, drawH);
    const pad = 4;
    dirty = paintedDirtyRect(
      { x: left - pad, y: top - pad, w: drawW + pad * 2, h: drawH + pad * 2 },
      sideFlip ? render.x : null,
    );
  } else {
    // Mochi drag: warp the sprite through the deformable spring MESH as a grid
    // of textured triangles. Each vertex is displaced by the physics (offsets
    // are in sprite-size units); the grabbed scruff has zero offset so it stays
    // welded under the cursor while the torso stretches, the paws and tail
    // trail, and the ears flop — the face barely moves so it stays a cat.
    // Neighbouring triangles share vertices, so it cannot tear no matter how
    // hard it is pulled.
    const sw = sprite.width;
    const sh = sprite.height;
    // Precompute the destination position of every grid vertex, plus the source
    // texel it samples, and track the deformed bounds for the dirty rect.
    const nx = MESH_COLS, ny = MESH_ROWS;
    const dX = new Float64Array(nx * ny);
    const dY = new Float64Array(nx * ny);
    const sX = new Float64Array(nx * ny);
    const sY = new Float64Array(nx * ny);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const i = r * nx + c;
        const u = c / (nx - 1);
        const v = r / (ny - 1);
        sX[i] = u * sw;
        sY[i] = v * sh;
        const ddx = left + u * drawW + mesh[i * 2] * size;
        const ddy = top + v * drawH + mesh[i * 2 + 1] * size;
        dX[i] = ddx;
        dY[i] = ddy;
        if (ddx < minX) minX = ddx;
        if (ddx > maxX) maxX = ddx;
        if (ddy < minY) minY = ddy;
        if (ddy > maxY) maxY = ddy;
      }
    }
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const i00 = r * nx + c;
        const i10 = i00 + 1;
        const i01 = i00 + nx;
        const i11 = i01 + 1;
        drawTriangle(
          ctx, sprite,
          sX[i00], sY[i00], sX[i10], sY[i10], sX[i11], sY[i11],
          dX[i00], dY[i00], dX[i10], dY[i10], dX[i11], dY[i11],
        );
        drawTriangle(
          ctx, sprite,
          sX[i00], sY[i00], sX[i11], sY[i11], sX[i01], sY[i01],
          dX[i00], dY[i00], dX[i11], dY[i11], dX[i01], dY[i01],
        );
      }
    }
    ctx.restore();
    const pad = 6;
    return paintedDirtyRect(
      {
        x: minX - pad,
        y: minY - pad,
        w: maxX - minX + pad * 2,
        h: maxY - minY + pad * 2,
      },
      sideFlip ? render.x : null,
    );
  }
  ctx.restore();
  return dirty;
}

export const CatRenderer = forwardRef<CatRendererHandle>(function CatRenderer(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Region drawn last frame. The canvas spans the whole virtual desktop, so
  // clearing all of it every frame means clearing millions of pixels to move a
  // ~96px cat — at 60fps that alone dominates the frame budget.
  const dirtyRef = useRef<DirtyRect | null>(null);
  // A one-time full clear when a deformable drag settles is inexpensive and
  // guarantees that even a driver-level antialiasing spill cannot survive the
  // mesh lifecycle.
  const meshActiveRef = useRef(false);
  // Signature of the last frame actually painted. The overlay spans the whole
  // desktop, so every paint makes the compositor redo a full-screen transparent
  // surface — expensive, and pure waste when the cat is sitting perfectly still.
  const sigRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    draw(render, w, h, visibility = 1) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const resized = canvas.width !== w || canvas.height !== h;
      const vis = render ? Math.min(1, visibility) : 0;
      const sig =
        !render || vis <= 0.01
          ? "blank"
          : `${spriteEpoch()}|${costumeOverlayEpoch()}|${costumeOverlayFrame()}|${render.x.toFixed(1)}|${render.y.toFixed(1)}|${render.sizePx}|` +
            `${render.facing}|${render.squash.toFixed(3)}|${render.pupilX}|${render.pupilY}|` +
            `${render.headTurnX}|${render.headTurnY}|` +
            `${render.tailPhase}|${meshSignature(render.mesh)}|` +
            `${vis.toFixed(3)}|${render.pose.view}|${render.pose.body}|` +
            `${render.pose.legPhase}|${render.pose.eyes}|${render.pose.ears}|${render.pose.tail}|` +
            `${render.pose.headBob}|${render.pose.gesture}|${render.pose.mouth}|${render.pose.prop}`;

      if (!resized && sig === sigRef.current) return; // nothing moved: don't touch the canvas

      const meshJustEnded = meshActiveRef.current && !render?.mesh;
      if (resized) {
        // Resizing the backing store already clears it.
        canvas.width = w;
        canvas.height = h;
        dirtyRef.current = null;
      } else if (!render || vis <= 0.01 || meshJustEnded) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        dirtyRef.current = null;
      } else if (dirtyRef.current) {
        const d = dirtyRef.current;
        ctx.clearRect(d.x, d.y, d.w, d.h);
        dirtyRef.current = null;
      }
      if (render && vis > 0.01) {
        dirtyRef.current = drawCatSprite(ctx, render, vis);
      }
      meshActiveRef.current = Boolean(render?.mesh);
      sigRef.current = sig;
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
});
