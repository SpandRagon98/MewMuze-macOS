//! The Photo Mode panel.
//!
//! Wears the same skeuomorphic shell as Quick Tools (`quick-tools pixel-ui`,
//! the same header, the same close button, the same placement helper) so it
//! reads as another drawer of the same piece of furniture.
//!
//! The preview is the deliverable: what it shows is exactly what gets exported,
//! because the export re-renders the very pose object the preview last drew.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimationController } from "../animation/animationController";
import { ART, spriteEpoch, type PoseSpec } from "../animation/spriteLoader";
import { costumeOverlayEpoch } from "../costumes/costumeOverlay";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  DEFAULT_EXPRESSION_ID,
  DEFAULT_POSE_ID,
  PHOTO_EXPRESSIONS,
  PHOTO_POSES,
  SHARE_HINT,
  captureMode,
  findExpression,
  findPose,
  isBranded,
  needsScreenConsent,
  isFeeling,
  photoFileName,
  type CaptureMode,
  type PhotoExpression,
} from "./photoMode";
import {
  CARD_THEME,
  canvasToPng,
  composeCard,
  composeCatOnly,
  composeDesktop,
  photoSprite,
} from "./photoCanvas";
import {
  captureScreen,
  copyPhoto,
  folderOf,
  pickPhotoDestination,
  pickPhotoFolder,
  revealPhoto,
  savePhoto,
} from "./photoApi";
import { Icon } from "../components/icons";
import { feelPose } from "../emotion/expression";

export const PHOTO_PANEL_SIZE = { width: 560, height: 470 };

/** Milliseconds to let the compositor present the hidden panel before the grab. */
const HIDE_SETTLE_MS = 140;

export interface PhotoSelection {
  poseId: string;
  expressionId: string;
}

export function PhotoModePanel({
  cat,
  area,
  folder,
  onSelectionChange,
  onFolderChange,
  onClose,
}: {
  cat: Box;
  area: Area;
  /** Remembered save folder, or "" to ask every time. */
  folder: string;
  /** Tells App which pose/expression to hold the real cat in. */
  onSelectionChange: (selection: PhotoSelection) => void;
  onFolderChange: (folder: string) => void;
  onClose: () => void;
}) {
  const [poseId, setPoseId] = useState(DEFAULT_POSE_ID);
  const [expressionId, setExpressionId] = useState(DEFAULT_EXPRESSION_ID);
  const [mode, setMode] = useState<CaptureMode>(DEFAULT_CAPTURE_MODE);
  /**
   * Screen consent. Deliberately NOT remembered: it resets whenever the mode
   * changes and is never persisted, so every desktop photo is its own decision.
   */
  const [screenConsent, setScreenConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  /** Last saved path, so "Open folder" has something to open. */
  const [saved, setSaved] = useState("");
  /** Hides the panel for the instant a desktop photo is taken. */
  const [hidden, setHidden] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  /** The exact pose the preview last drew — the export re-renders this. */
  const poseRef = useRef<PoseSpec | null>(null);

  const [placement, setPlacement] = useState(() =>
    placePanel({ cat, area, panel: PHOTO_PANEL_SIZE }),
  );

  const epoch = spriteEpoch();
  const costumeEpoch = costumeOverlayEpoch();

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && Math.abs(r.height - PHOTO_PANEL_SIZE.height) > 2) {
      setPlacement(placePanel({ cat, area, panel: { width: PHOTO_PANEL_SIZE.width, height: r.height } }));
    }
    // `mode` changes the panel's height (the desktop warning appears), so a
    // switch re-places against the box that just rendered.
  }, [cat, area, mode]);

  useEffect(() => {
    onSelectionChange({ poseId, expressionId });
  }, [poseId, expressionId, onSelectionChange]);

  // Any change of what is being captured invalidates consent.
  useEffect(() => {
    setScreenConsent(false);
    setStatus("");
    setError("");
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- live preview -------------------------------------------------------
  // Same shape as the settings CatPreview: an AnimationController driving the
  // shared sprite pipeline. Runs only while the panel is mounted, so closing
  // Photo Mode leaves nothing ticking.
  useEffect(() => {
    const pose = findPose(poseId);
    const expression = findExpression(expressionId);
    const ctrl = new AnimationController(pose.anim);
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
      // Hold the chosen pose rather than letting it chain onward into idle.
      if (ctrl.name !== pose.anim && ctrl.isFinished) ctrl.play(pose.anim, true);

      const cv = previewRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      // getPose returns a reused object; copy before keeping or overriding it.
      let live: PoseSpec = { ...ctrl.getPose() };
      if (expression.eyes) live.eyes = expression.eyes;
      if (expression.mouth) live.mouth = expression.mouth;
      if (expression.emotion) live = feelPose(live, expression.emotion);
      poseRef.current = live;

      const sprite = photoSprite(live);
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
    // epoch/costumeEpoch restart the loop when the user edits appearance while
    // Photo Mode is open, so the preview never shows a stale cat.
  }, [poseId, expressionId, epoch, costumeEpoch]);

  // ---- building the image -------------------------------------------------
  const buildCatCanvas = useCallback((): HTMLCanvasElement | null => {
    const pose = poseRef.current;
    if (!pose) return null;
    const sprite = photoSprite(pose);
    return isBranded(mode) ? composeCard(sprite, CARD_THEME) : composeCatOnly(sprite);
  }, [mode]);

  const buildDesktopCanvas = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    // Hide the panel first: the photo is of the desktop and the cat, not of the
    // control panel used to take it.
    setHidden(true);
    try {
      await new Promise((r) => setTimeout(r, HIDE_SETTLE_MS));
      const bytes = await captureScreen();
      // `bytes.buffer` really is an ArrayBuffer here — captureScreen allocates
      // it — but Uint8Array is generic over ArrayBufferLike and Blob will not
      // accept a SharedArrayBuffer, so the cast states what is already true.
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("The screenshot could not be read."));
          img.src = url;
        });
        return composeDesktop(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      setHidden(false);
    }
  }, []);

  const buildPhoto = useCallback(async (): Promise<Uint8Array> => {
    const canvas = mode === "desktop" ? await buildDesktopCanvas() : buildCatCanvas();
    if (!canvas) throw new Error("The photo is not ready yet.");
    return canvasToPng(canvas);
  }, [mode, buildCatCanvas, buildDesktopCanvas]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await fn();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    guard(async () => {
      const bytes = await buildPhoto();
      const name = photoFileName();
      let target: string;
      if (folder) {
        target = `${folder}/${name}`;
      } else {
        const picked = await pickPhotoDestination(name, folder);
        if (!picked) return; // cancelled: not an error
        target = picked;
        onFolderChange(folderOf(picked));
      }
      const written = await savePhoto(bytes, target);
      setSaved(written);
      setStatus(`Saved ${name}`);
    });

  const onCopy = () =>
    guard(async () => {
      await copyPhoto(await buildPhoto());
      setStatus("Copied — paste it anywhere.");
    });

  const onChooseFolder = () =>
    guard(async () => {
      const picked = await pickPhotoFolder();
      if (picked) {
        onFolderChange(picked);
        setStatus("Photos will be saved there.");
      }
    });

  const onOpenFolder = () => guard(async () => revealPhoto(saved));

  const info = captureMode(mode);
  // A desktop photo is blocked until the warning has been read and accepted.
  const blocked = needsScreenConsent(mode) && !screenConsent;
  const faceChip = (e: PhotoExpression) => (
    <button key={e.id} className={`sk-chip${expressionId === e.id ? " on" : ""}`} aria-pressed={expressionId === e.id} onClick={() => setExpressionId(e.id)}>
      {e.label}
    </button>
  );

  return (
    <div
      ref={boxRef}
      className="quick-tools photo-mode pixel-ui"
      data-side={placement.side}
      style={{
        left: placement.x,
        top: placement.y,
        width: PHOTO_PANEL_SIZE.width,
        // `visibility`, not unmounting: the preview loop and every field survive
        // the instant the desktop photo is taken.
        visibility: hidden ? "hidden" : "visible",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="qt-head">
        <span className="qt-title">
          <Icon name="camera" size={18} /> Photo Mode
        </span>
        <button className="qt-x" onClick={onClose} aria-label="Close Photo Mode" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="pm-body">
      {/* Left: the shot itself and how it is taken. Right: what the cat is
          doing. Side by side, every choice fits on one screen. */}
      <div className="pm-col">
      <div className="pm-stage">
        <canvas
          ref={previewRef}
          className="pm-preview"
          width={ART * 2}
          height={ART * 2}
          aria-label="Photo preview"
        />
      </div>

      <section className="qt-group pm-capture">
      <h3 className="qt-group-head">Capture</h3>
      <div className="pm-modes">
        {CAPTURE_MODES.map((m) => (
          <button
            key={m.id}
            className={`pm-mode${mode === m.id ? " on" : ""}`}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="pm-detail">{info.detail}</div>

      {needsScreenConsent(mode) && (
        <label className="pm-consent">
          <input
            type="checkbox"
            checked={screenConsent}
            onChange={(e) => setScreenConsent(e.target.checked)}
          />
          <span>
            I understand this photo will contain whatever is on my screen right now — windows,
            messages and file names included.
          </span>
        </label>
      )}

      <div className="qt-row pm-actions">
        <button className="pixel-btn primary" onClick={onSave} disabled={busy || blocked}>
          Save
        </button>
        <button className="pixel-btn" onClick={onCopy} disabled={busy || blocked}>
          Copy Image
        </button>
      </div>
      <div className="qt-row pm-actions">
        <button className="pixel-btn" onClick={onChooseFolder} disabled={busy}>
          {folder ? "Change folder" : "Choose folder"}
        </button>
        <button className="pixel-btn" onClick={onOpenFolder} disabled={busy || !saved}>
          Open folder
        </button>
      </div>
      </section>
      </div>

      <div className="pm-col">
      <section className="qt-group">
      <h3 className="qt-group-head">Pose</h3>
      <div className="pm-chips">
        {PHOTO_POSES.map((p) => (
          <button
            key={p.id}
            className={`sk-chip${poseId === p.id ? " on" : ""}`}
            aria-pressed={poseId === p.id}
            onClick={() => setPoseId(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      </section>

      <section className="qt-group">
      <h3 className="qt-group-head">Expression</h3>
      <div className="pm-chips">{PHOTO_EXPRESSIONS.filter((e) => !isFeeling(e)).map(faceChip)}</div>
      <h3 className="qt-group-head pm-sub">Feeling</h3>
      <div className="pm-chips">{PHOTO_EXPRESSIONS.filter(isFeeling).map(faceChip)}</div>
      </section>
      </div>
      </div>

      {status && <div className="pm-status">{status}</div>}
      {error && <div className="pm-error">{error}</div>}
      <div className="pm-share">{SHARE_HINT}</div>
    </div>
  );
}
