import { useEffect, useRef, useState } from "react";
import { AnimationController } from "../animation/animationController";
import { applyAppearanceStroke, renderFrame, spriteEpoch, ART } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";
import { composeCostumeSprite, costumeOverlayEpoch } from "../costumes/costumeOverlay";

/**
 * Live cat preview for the settings panel.
 *
 * Deliberately does NOT call `configureAppearance`: that writes module-global
 * palettes shared with the real cat, so a preview owning it would fight the
 * running overlay. App already applies appearance changes globally as they are
 * edited, so simply re-rendering every frame picks them up for free.
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

export function CatPreview({ sizePx = 220 }: { sizePx?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [anim, setAnim] = useState<AnimationName>("idle");
  // Bumped whenever appearance is reconfigured, so a colour edit restarts the
  // loop and shows up immediately rather than on the next pose change.
  const epoch = spriteEpoch();
  const costumeEpoch = costumeOverlayEpoch();

  useEffect(() => {
    const ctrl = new AnimationController(anim);
    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctrl.update(dt);
      // Keep the chosen animation looping even when it auto-chains onward, so
      // the preview shows what was picked rather than drifting into idle.
      if (ctrl.name !== anim && ctrl.isFinished) ctrl.play(anim, true);

      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      const pose = ctrl.getPose();
      const sprite = applyAppearanceStroke(composeCostumeSprite(renderFrame(pose), pose));
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false;
      const d = Math.min(cv.width, cv.height);
      ctx.drawImage(sprite, (cv.width - d) / 2, (cv.height - d) / 2, d, d);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [anim, epoch, costumeEpoch]);

  return (
    <div className="sk-preview">
      <div className="sk-preview-screen">
        <canvas ref={canvasRef} width={ART * 2} height={ART * 2} style={{ width: sizePx, height: sizePx }} />
        <span className="sk-preview-glass" aria-hidden="true" />
      </div>
      <div className="sk-preview-poses">
        {SHOWCASE.map((p) => (
          <button
            key={p.name}
            className={`sk-chip${anim === p.name ? " on" : ""}`}
            onClick={() => setAnim(p.name)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
