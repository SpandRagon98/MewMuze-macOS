//! Photo Mode: what can be photographed, and the rules around capturing it.
//!
//! Deliberately pure — no React, no Tauri, no canvas. Everything here is a
//! function of its arguments, so the catalogues, the filename, the export
//! geometry and (most importantly) the privacy rules are all testable without a
//! desktop.
//!
//! There is NO cat-drawing code in this feature. Poses are existing animation
//! names, expressions are existing `EyeState`/`MouthState` values, and the
//! sprite itself comes from the same
//! `applyAppearanceStroke(composeCostumeSprite(renderFrame(pose), pose))`
//! pipeline the live overlay and the settings preview already use — so the
//! user's species, coat, pattern, colours, accessory, stroke and installed
//! costume are correct by construction rather than by a second implementation.

import type { EyeState, MouthState } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";

/** A pose the user can photograph. Every entry is an existing animation. */
export interface PhotoPose {
  id: string;
  label: string;
  anim: AnimationName;
}

export const PHOTO_POSES: readonly PhotoPose[] = [
  { id: "sit", label: "Sit", anim: "sit" },
  { id: "happy", label: "Happy", anim: "happy" },
  { id: "wave", label: "Wave", anim: "wave" },
  { id: "sleep", label: "Sleep", anim: "sleep" },
  { id: "stretch", label: "Stretch", anim: "stretch" },
  // "Curious" is the cat's existing look-around behaviour, not a new pose.
  { id: "curious", label: "Curious", anim: "lookAround" },
  { id: "celebrate", label: "Celebration", anim: "celebrate" },
  { id: "groom", label: "Groom", anim: "groom" },
  { id: "peek", label: "Peek", anim: "peek" },
];

/**
 * An expression override. `eyes`/`mouth` null means "leave whatever the pose
 * itself does", which is the default — the animations already carry their own
 * expressions and overriding them by default would flatten every photo.
 */
export interface PhotoExpression {
  id: string;
  label: string;
  eyes: EyeState | null;
  mouth: MouthState | null;
}

export const PHOTO_EXPRESSIONS: readonly PhotoExpression[] = [
  { id: "as-posed", label: "As posed", eyes: null, mouth: null },
  { id: "happy", label: "Happy", eyes: "happy", mouth: "smile" },
  { id: "wide", label: "Wide", eyes: "wide", mouth: "open" },
  { id: "sleepy", label: "Sleepy", eyes: "half", mouth: "none" },
  { id: "closed", label: "Content", eyes: "closed", mouth: "smile" },
  { id: "surprised", label: "Surprised", eyes: "surprised", mouth: "open" },
];

export const DEFAULT_POSE_ID = "sit";
export const DEFAULT_EXPRESSION_ID = "as-posed";

export function findPose(id: string): PhotoPose {
  return PHOTO_POSES.find((p) => p.id === id) ?? PHOTO_POSES[0];
}

export function findExpression(id: string): PhotoExpression {
  return PHOTO_EXPRESSIONS.find((e) => e.id === id) ?? PHOTO_EXPRESSIONS[0];
}

/** What the photo is of. */
export type CaptureMode = "cat" | "card" | "desktop";

export interface CaptureModeInfo {
  id: CaptureMode;
  label: string;
  /** One line under the option, shown in the panel. */
  detail: string;
  /**
   * True when the capture can contain anything other than the cat itself.
   * Only `desktop` can, and the panel refuses to take one until the user has
   * clicked through an explicit confirmation.
   */
  capturesScreen: boolean;
  /** Branded footer. Never on a transparent export. */
  branded: boolean;
}

export const CAPTURE_MODES: readonly CaptureModeInfo[] = [
  {
    id: "cat",
    label: "Cat only",
    detail: "Transparent PNG — just MewMuze, nothing else.",
    capturesScreen: false,
    branded: false,
  },
  {
    id: "card",
    label: "On a card",
    detail: "MewMuze on a simple backdrop.",
    capturesScreen: false,
    branded: true,
  },
  {
    id: "desktop",
    label: "Desktop + MewMuze",
    detail: "Screenshots your screen. Everything visible will be in the image.",
    capturesScreen: true,
    branded: false,
  },
];

/** The default is the one that cannot leak anything: cat only, transparent. */
export const DEFAULT_CAPTURE_MODE: CaptureMode = "cat";

export function captureMode(id: CaptureMode): CaptureModeInfo {
  return CAPTURE_MODES.find((m) => m.id === id) ?? CAPTURE_MODES[0];
}

/**
 * Whether taking this photo needs a second, explicit confirmation first.
 *
 * The screen is never photographed as a side effect of opening Photo Mode,
 * switching pose, or pressing Save on another mode — only a deliberate click on
 * a confirmation the user has read.
 */
export function needsScreenConsent(mode: CaptureMode): boolean {
  return captureMode(mode).capturesScreen;
}

/** Whether this mode may carry the "My MewMuze / mewmuze.com" footer. */
export function isBranded(mode: CaptureMode): boolean {
  return captureMode(mode).branded;
}

export const BRAND_TITLE = "My MewMuze";
export const BRAND_URL = "mewmuze.com";
export const SHARE_HINT = "Share your desktop companion with #MyMewMuze";

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `MewMuze-YYYY-MM-DD-HHMMSS.png`, in the user's own local time — a photo taken
 * at 9pm should not be filed under tomorrow because the machine is east of UTC.
 */
export function photoFileName(at: Date = new Date()): string {
  const stamp =
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `MewMuze-${stamp}.png`;
}

/**
 * How many times to blow the sprite up for export.
 *
 * Always a whole number: pixel art scaled by a fraction lands source pixels on
 * fractional destination pixels, and the sampler has to either blur them or
 * make some output pixels wider than others. An integer factor with
 * `imageSmoothingEnabled = false` maps one source pixel to an exact square
 * block, which is what keeps a photographed MewMuze as crisp as the one on the
 * desktop. At least 1, so a small target never shrinks the art.
 */
export function exportScale(artSize: number, target: number): number {
  if (!Number.isFinite(artSize) || artSize <= 0) return 1;
  if (!Number.isFinite(target) || target <= 0) return 1;
  return Math.max(1, Math.floor(target / artSize));
}

/** Long edge, in px, that "Cat only" and the card aim for. */
export const EXPORT_TARGET = 1024;

export interface CardLayout {
  width: number;
  height: number;
  /** Where the sprite is drawn, already an integer box. */
  cat: { x: number; y: number; size: number };
  /** Baseline for the branded footer, or null when unbranded. */
  footerY: number | null;
  pad: number;
}

/**
 * Geometry for the card. Square, with the cat sitting slightly above centre so
 * the footer has room without the cat looking like it is falling off.
 *
 * All integers: a half-pixel offset on a nearest-neighbour blit is exactly the
 * thing that produces a seam down the middle of a sprite.
 */
export function cardLayout(spriteSize: number, branded = true): CardLayout {
  const size = Math.max(1, Math.round(spriteSize));
  const pad = Math.round(size * 0.14);
  const footer = branded ? Math.round(size * 0.17) : 0;
  const width = size + pad * 2;
  const height = size + pad * 2 + footer;
  return {
    width,
    height,
    cat: { x: pad, y: pad, size },
    footerY: branded ? pad + size + Math.round(footer * 0.52) : null,
    pad,
  };
}
