//! The Look Preview window: one costume on YOUR cat, running through real
//! MewMuze animations, so an outfit can be judged - and costume clipping or
//! layering mistakes seen - before it is worn.
//!
//! This is a separate webview. Its renderer, its costume painter and its
//! appearance are its own copies; nothing here can change the desktop cat.
//! "Wear" asks the main window to do it (look-preview-action), which applies
//! it through the same settings path as Settings.
//!
//! Rendering runs only while playing and visible: paused, minimised or hidden,
//! the timer stops; closing the window destroys everything.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimationController } from "../animation/animationController";
import { applyAppearanceStroke, configureAppearance, poseKey, renderFrame, type PoseSpec } from "../animation/spriteLoader";
import { activateCostumeOverlay, composeCostumeSprite, previewCostumeFrame, setCostumeTint } from "../costumes/costumeOverlay";
import { listInstalledCostumes, openMewMuzeStore, type InstalledCostume } from "../costumes/costumeApi";
import { FEATURED, tintFor } from "../components/FeaturedLooks";
import { Icon } from "../components/icons";
import { loadSettings, type Settings } from "../settings/settingsStore";
import type { AnimationName } from "../types/cat";
import type { EmotionId } from "../emotion/emotions";
import { feelPose } from "../emotion/expression";
import "../components/ui.css";

/**
 * Real animations only - each name exists in ANIMATIONS (a test checks). The
 * feelings at the end are the desktop cat's own (feelPose), so tears, a tilted
 * head and paws on the face can be checked against the outfit too.
 */
export const PLAYLIST: readonly { anim: AnimationName; label: string; mirror?: boolean; emotion?: EmotionId }[] = [
  { anim: "idle", label: "Idle" },
  { anim: "sit", label: "Sit" },
  { anim: "walk", label: "Walk" },
  { anim: "walk", label: "Walk back", mirror: true },
  { anim: "lookAround", label: "Look around" },
  { anim: "stretch", label: "Stretch" },
  { anim: "groom", label: "Groom" },
  { anim: "yawn", label: "Yawn" },
  { anim: "smallHop", label: "Hop" },
  { anim: "danceBop", label: "Dance" },
  { anim: "typeKeys", label: "Typing" },
  { anim: "peek", label: "Peek" },
  { anim: "hangTwoPaws", label: "Hang" },
  { anim: "happy", label: "Happy", emotion: "happy" },
  { anim: "sit", label: "Curious", emotion: "curious" },
  { anim: "sit", label: "Sad", emotion: "crying" },
  { anim: "sit", label: "Savage", emotion: "savage" },
  { anim: "sit", label: "Victory", emotion: "victory" },
  { anim: "idle", label: "Excited", emotion: "excited" },
];

/** Long enough to read the outfit, short enough not to drag. */
export const STEP_MS = 3400;
const TICK_MS = 83;
const STAGE_CSS = 300;

interface Look {
  id: string;
  name: string;
  cls: string;
  tag: string;
  featured: boolean;
}

function useLooks(installed: InstalledCostume[]): Look[] {
  return useMemo(() => {
    const extra = installed
      .filter((c) => !FEATURED.some((f) => f.id === c.costumeId))
      .map((c) => ({ id: c.costumeId, name: c.name, cls: "custom", tag: `By ${c.creator}`, featured: false }));
    return [...FEATURED.map((f) => ({ id: f.id, name: f.name, cls: f.cls, tag: f.tag, featured: true })), ...extra];
  }, [installed]);
}

async function tauriEvent() {
  return import("@tauri-apps/api/event");
}

export function LookPreviewApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [installed, setInstalled] = useState<InstalledCostume[]>([]);
  const [lookId, setLookId] = useState(
    () => (window as Window & { __MEWMUZE_VIEW__?: { look?: string } }).__MEWMUZE_VIEW__?.look ?? new URLSearchParams(location.search).get("look") ?? FEATURED[0].id,
  );
  const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [playing, setPlaying] = useState(!reducedMotion);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState("");
  const looks = useLooks(installed);
  const look = looks.find((l) => l.id === lookId) ?? looks[0];

  // The window's ground, before anything draws.
  useEffect(() => {
    document.documentElement.classList.add("mm-preview-root");
    document.title = "MewMuze · Look preview";
    return () => document.documentElement.classList.remove("mm-preview-root");
  }, []);

  const reload = useCallback(async () => {
    const [s, list] = await Promise.all([loadSettings(), listInstalledCostumes().catch(() => [] as InstalledCostume[])]);
    // This window's own copy of the palettes: the desktop cat is not involved.
    configureAppearance(s.appearance);
    document.documentElement.dataset.theme = s.theme;
    setSettings(s);
    setInstalled(list);
  }, []);

  useEffect(() => {
    void reload();
    let stop: (() => void)[] = [];
    let alive = true;
    void tauriEvent().then(async ({ listen }) => {
      const a = await listen<string>("preview-look", (e) => {
        setLookId(e.payload);
        setStep(0);
      });
      const b = await listen("costumes-changed", () => void reload());
      // WebView2 keeps reporting "visible" while the window is minimised, so
      // ask the window itself. Minimise and restore both fire a resize.
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const check = async () => setVisible(!document.hidden && !(await win.isMinimized()) && (await win.isVisible()));
      const c = await win.onResized(() => void check().catch(() => undefined));
      if (alive) stop = [a, b, c];
      else [a, b, c].forEach((u) => u());
    }).catch(() => undefined);
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop.forEach((u) => u());
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload]);

  // Installed (non-procedural) costumes are composited over the frame: load
  // this look's layers into THIS window's overlay state.
  useEffect(() => {
    if (!look || look.featured) return;
    setReady(false);
    void activateCostumeOverlay(look.id).catch(() => activateCostumeOverlay("")).then(() => setReady(true));
  }, [look]);

  const featured = FEATURED.find((f) => f.id === look?.id);
  const tint = featured && settings ? tintFor(featured, settings.costumeTint) : settings?.costumeTint ?? "";
  useEffect(() => {
    if (tint) setCostumeTint(tint);
  }, [tint]);

  // ---- rendering: a timer only while playing and visible ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Painted at half size and shown at exactly 2x (image-rendering: pixelated):
  // the costume painters work per device pixel, and at full 300 px a playing
  // preview cost ~60% of a core (400k+ fillRects a second).
  const px = Math.round((STAGE_CSS / 2) * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
  const cache = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => cache.current.clear(), [look?.id, tint, px, ready, settings]);
  const frameFor = useCallback(
    (raw: PoseSpec): HTMLCanvasElement => {
      // Twelve leg positions per stride and 20 tail positions - about one per
      // tick at this frame rate. The desktop cat keeps its finer steps; here
      // each new phase is a full repaint of the costume.
      const pose = { ...raw, legPhase: Math.round(raw.legPhase * 12) / 12, tailPhase: Math.floor(raw.tailPhase / 2) * 2 };
      const key = poseKey(pose);
      let c = cache.current.get(key);
      if (!c) {
        c = featured ? previewCostumeFrame(featured.id, tint, pose, px) : composeCostumeSprite(renderFrame(pose, px), pose);
        c = applyAppearanceStroke(c);
        cache.current.set(key, c);
      }
      return c;
    },
    [featured, tint, px],
  );

  const current = PLAYLIST[step % PLAYLIST.length];
  const canRender = !!settings && !!look && (look.featured || ready);
  // One controller per playlist step: pausing freezes it where it is and
  // resuming carries on from the same frame.
  const ctrlRef = useRef<AnimationController | null>(null);
  const lastRef = useRef<{ t: number; sprite: HTMLCanvasElement | null }>({ t: 0, sprite: null });
  useEffect(() => {
    ctrlRef.current = new AnimationController(current.anim);
    lastRef.current = { t: performance.now(), sprite: null };
    // Bounded memory: frames are cached per animation, not per window lifetime.
    cache.current.clear();
  }, [step, current.anim]);
  const draw = useCallback(() => {
    const ctrl = ctrlRef.current;
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!ctrl || !cv || !ctx) return;
    const now = performance.now();
    ctrl.update(Math.min(0.2, (now - lastRef.current.t) / 1000));
    lastRef.current.t = now;
    if (ctrl.name !== current.anim && ctrl.isFinished) ctrl.play(current.anim, true);
    const pose = ctrl.getPose();
    const sprite = frameFor(current.emotion ? feelPose(pose, current.emotion) : pose);
    if (sprite === lastRef.current.sprite) return;
    lastRef.current.sprite = sprite;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, 0, 0, cv.width, cv.height);
  }, [frameFor, current.anim, current.emotion]);
  useEffect(() => {
    if (!canRender) return;
    lastRef.current.sprite = null;
    draw();
    if (!playing || !visible) return;
    const id = window.setInterval(draw, TICK_MS);
    return () => window.clearInterval(id);
  }, [draw, playing, visible, canRender, step]);

  // Auto-advance through the playlist.
  useEffect(() => {
    if (!playing || !visible) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % PLAYLIST.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, playing, visible]);

  const lookIndex = Math.max(0, looks.findIndex((l) => l.id === look?.id));
  const goLook = (d: number) => {
    const next = looks[(lookIndex + d + looks.length) % looks.length];
    if (next) {
      setLookId(next.id);
      setStep(0);
    }
  };

  const costume = installed.find((c) => c.costumeId === look?.id && c.enabled);
  const wearing = settings?.selectedCostumeId === look?.id;
  const wear = async () => {
    if (!look || !settings || !costume) return;
    if (!costume.supportedBodies.includes(settings.appearance.species)) {
      setNote(`${look.name} fits ${costume.supportedBodies.join(", ")} cats. Change the breed in Settings first.`);
      return;
    }
    const { emitTo } = await tauriEvent();
    await emitTo("main", "look-preview-action", { action: "wear", id: look.id });
    setNote(`Wearing ${look.name}.`);
    // The main window saves the choice; read it back to show "Wearing".
    window.setTimeout(() => void reload(), 700);
  };

  const close = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p);
    } else if (e.key === "ArrowRight") setStep((s) => (s + 1) % PLAYLIST.length);
    else if (e.key === "ArrowLeft") setStep((s) => (s - 1 + PLAYLIST.length) % PLAYLIST.length);
    else if (e.key === "Escape") void close();
  };

  if (!look) return null;
  return (
    <div className={`mm-preview ${look.cls}`} onKeyDown={onKey} tabIndex={-1} aria-label={`${look.name} preview`}>
      <header className="mm-preview-bar" data-tauri-drag-region>
        <div className="mm-preview-title" data-tauri-drag-region>
          <span className="mm-preview-eyebrow">Look preview</span>
          <strong>{look.name}</strong>
        </div>
        <span className={`mm-badge${wearing ? " accent" : costume ? " ok" : ""}`}>{wearing ? "Wearing" : costume ? "Owned" : "In the Store"}</span>
        <button className="mm-winbtn close" aria-label="Close preview" title="Close" onClick={() => void close()}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="mm-preview-stage">
        <button className="mm-preview-nav prev" aria-label="Previous look" onClick={() => goLook(-1)} disabled={looks.length < 2}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <div className="mm-preview-cat">
          <canvas
            ref={canvasRef}
            key={step}
            width={px}
            height={px}
            style={{ width: STAGE_CSS, height: STAGE_CSS, transform: current.mirror ? "scaleX(-1)" : undefined }}
            role="img"
            aria-label={`${look.name}: ${current.label}`}
          />
          <span className="mm-preview-floor" aria-hidden="true" />
        </div>
        <button className="mm-preview-nav next" aria-label="Next look" onClick={() => goLook(1)} disabled={looks.length < 2}>
          <Icon name="chevronRight" size={20} />
        </button>
      </div>
      <p className="mm-preview-tag">{look.tag}</p>

      <div className="mm-preview-chips" role="tablist" aria-label="Animation">
        {PLAYLIST.map((p, i) => (
          <button key={p.label} role="tab" aria-selected={i === step} className={`mm-preview-chip${i === step ? " on" : ""}`} onClick={() => setStep(i)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="mm-preview-controls">
        <button className="mm-icon-btn" aria-label="Previous animation" onClick={() => setStep((s) => (s - 1 + PLAYLIST.length) % PLAYLIST.length)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <button className="mm-icon-btn" aria-label={playing ? "Pause" : "Play"} aria-pressed={!playing} onClick={() => setPlaying((p) => !p)}>
          <Icon name={playing ? "pause" : "resume"} size={16} />
        </button>
        <button className="mm-icon-btn" aria-label="Next animation" onClick={() => setStep((s) => (s + 1) % PLAYLIST.length)}>
          <Icon name="chevronRight" size={16} />
        </button>
        <span className="mm-preview-dots" aria-hidden="true">
          {PLAYLIST.map((p, i) => (
            <i key={p.label} className={i === step ? "on" : ""} />
          ))}
        </span>
        <span className="mm-preview-spacer" />
        {wearing ? (
          <button className="mm-btn" disabled>
            Wearing
          </button>
        ) : costume ? (
          <button className="mm-btn primary" onClick={() => void wear()}>
            Wear
          </button>
        ) : (
          <button className="mm-btn primary" onClick={() => void openMewMuzeStore()}>
            Get it
          </button>
        )}
      </div>
      {note && (
        <p className="mm-preview-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
