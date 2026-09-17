import { useEffect, useRef, useState } from "react";
import { AnimationController } from "../animation/animationController";
import { applyAppearanceStroke, previewKey, renderFramePreview, spriteEpoch, type PoseSpec } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";
import { composeCostumeSprite, costumeOverlayEpoch } from "../costumes/costumeOverlay";

/**
 * The live cat, drawn with the real renderer - the Settings preview, the Home
 * banner and the Chat header all use this, so what they show is exactly the
 * cat on the desktop, costume and all.
 *
 * Deliberately does NOT call `configureAppearance`: that writes module-global
 * palettes shared with the real cat. App already applies appearance changes
 * globally as they are edited, so re-rendering picks them up for free.
 */
const SHOWCASE: { name: AnimationName; label: string }[] = [
  { name: "idle", label: "Idle" },
  { name: "walk", label: "Walk" },
  { name: "happy", label: "Happy" },
  { name: "sleep", label: "Sleep" },
  { name: "quickTools", label: "Work" },
  { name: "panic", label: "Panic" },
  { name: "sad", label: "Sad" },
  { name: "placard", label: "Cheer" },
];

/**
 * Finished preview sprites, shared by every preview surface and kept across
 * mounts, so reopening Settings or Cat & Looks shows cached frames instead of
 * repainting them. Bounded: a preview loop only ever shows a handful of poses.
 */
const PREVIEW_CACHE_LIMIT = 64;
const previewCache = new Map<string, HTMLCanvasElement>();

export function cachedPreview(key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  const hit = previewCache.get(key);
  if (hit) {
    previewCache.delete(key); // most recently used goes last
    previewCache.set(key, hit);
    return hit;
  }
  const made = make();
  previewCache.set(key, made);
  while (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value as string);
  return made;
}

/** For the regression test: the bound is real. */
export const previewCacheSize = () => previewCache.size;
export const previewCacheLimit = () => PREVIEW_CACHE_LIMIT;

/** Poses change at 2-12 fps, so the preview ticks at 12 - a fifth of the
 *  wake-ups of a 60 fps loop, for the same picture. */
const TICK_MS = 83;

/**
 * Drive an animation into a canvas at pose rate, only while mounted.
 * `frame` turns a pose into a sprite (the live cat, or a costume preview).
 */
export function useCatAnimation(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  anim: AnimationName,
  frame: (pose: PoseSpec) => HTMLCanvasElement,
  deps: unknown[],
  running = true,
  /** Wait this long before the first frame: several posters mounting at once
   *  then share the work across frames instead of one long task. */
  firstDelayMs = 0,
) {
  useEffect(() => {
    const ctrl = new AnimationController(anim);
    let last = performance.now();
    let lastSprite: HTMLCanvasElement | null = null;
    const draw = () => {
      const now = performance.now();
      ctrl.update(Math.min(0.2, (now - last) / 1000));
      last = now;
      // Keep the chosen animation looping even when it auto-chains onward.
      if (ctrl.name !== anim && ctrl.isFinished) ctrl.play(anim, true);
      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      const sprite = frame(ctrl.getPose());
      if (sprite === lastSprite) return; // unchanged pose: nothing to paint
      lastSprite = sprite;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false;
      const d = Math.min(cv.width, cv.height);
      ctx.drawImage(sprite, (cv.width - d) / 2, (cv.height - d) / 2, d, d);
    };
    if (firstDelayMs > 0) {
      const first = window.setTimeout(draw, firstDelayMs);
      if (!running) return () => window.clearTimeout(first);
      const id = window.setInterval(draw, TICK_MS);
      return () => {
        window.clearTimeout(first);
        window.clearInterval(id);
      };
    }
    draw();
    if (!running) return;
    const id = window.setInterval(draw, TICK_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim, running, ...deps]);
}

export function CatPreview({ sizePx = 220, bare = false, anim: fixed }: { sizePx?: number; bare?: boolean; anim?: AnimationName }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chosen, setChosen] = useState<AnimationName>("idle");
  const anim = fixed ?? chosen;
  // The frame is rasterised at the canvas's device-pixel size and shown 1:1:
  // never a 128 px frame squeezed into 44 or stretched to 190.
  const px = Math.round(sizePx * (window.devicePixelRatio || 1));
  const frame = (pose: PoseSpec) =>
    cachedPreview(`live|${previewKey(pose, px)}|${costumeOverlayEpoch()}`, () =>
      applyAppearanceStroke(composeCostumeSprite(renderFramePreview(pose, px), pose)),
    );
  // Bumped whenever appearance is reconfigured, so a colour edit shows at once.
  useCatAnimation(canvasRef, anim, frame, [spriteEpoch(), costumeOverlayEpoch(), px]);

  const canvas = <canvas ref={canvasRef} width={px} height={px} style={{ width: sizePx, height: sizePx }} aria-label="Your cat" role="img" />;
  if (bare) return canvas;
  return (
    <div className="sk-preview">
      <div className="sk-preview-screen">{canvas}</div>
      <div className="sk-preview-poses" role="group" aria-label="Preview pose">
        {SHOWCASE.map((p) => (
          <button key={p.name} className={`sk-chip${anim === p.name ? " on" : ""}`} aria-pressed={anim === p.name} onClick={() => setChosen(p.name)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
