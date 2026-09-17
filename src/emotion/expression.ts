//! ExpressionController: turns an EmotionState into what the body does, frame
//! by frame - and CatGestureController-style timing for the paws.
//!
//! It owns the motion, not the feeling: springs for the head (so a tilt
//! anticipates, overshoots a touch and settles), the crying cycle, seeded and
//! rate-limited idle accents, gestures, and the user's Expression intensity.
//! Its output is an Overlay; applyOverlay() lays it on the animation's pose
//! without overriding anything the animation deliberately set (a blink, a
//! yawn, a prop), so one emotional system works on every animation, view and
//! costume.

import { DEFAULT_POSE, HEAD_TILT_MAX, HEAD_TILT_STEP, TEAR_STAGES, type CostumeTraits, type Gesture, type PoseSpec, type TailState } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";
import type { EmotionState } from "./emotionEngine";
import { emotion, lookAt, type Accent, type EmotionId, type Look, type Movement } from "./emotions";
import { safeGesture } from "./gestures";

export type ExpressionLevel = "subtle" | "balanced" | "dramatic";
export const EXPRESSION_LEVELS: readonly ExpressionLevel[] = ["subtle", "balanced", "dramatic"];

export interface ExpressionSettings {
  level: ExpressionLevel;
  /** Edgy gestures setting (default off). Even when on, safeGesture decides. */
  edgy: boolean;
}

export interface ExpressionContext {
  /** A front-facing sit/stand without a prop: somewhere paws can make signs. */
  canGesture: boolean;
  /** Serious context right now (grief, health, crisis, professional persona). */
  serious: boolean;
  /** An explicit invitation to be edgy (the user teased, or a rage the user caused). */
  edgyInvited: boolean;
  /** Something being watched, in pupil units: -2..2 each way. */
  attention?: { x: number; y: number } | null;
}

export interface Overlay {
  active: boolean;
  emotion: EmotionId;
  intensity: number;
  look: Look;
  /** Degrees, quantised to HEAD_TILT_STEP. */
  tilt: number;
  /** headBob offset, quantised to a quarter unit. */
  bob: number;
  gaze: { x: number; y: number } | null;
  gesture: Gesture | null;
  tears: number;
  tailSpeed: number;
  movement: Movement;
  /** A whole-body one-shot to start this frame (a hop, a yawn); null most frames. */
  anim: AnimationName | null;
}

const LEVEL: Record<ExpressionLevel, { range: number; rate: number; push: number }> = {
  // range: head/eye travel; rate: how often accents happen (interval ×); push: how strong tiers read.
  subtle: { range: 0.55, rate: 1.6, push: 0.85 },
  balanced: { range: 1, rate: 1, push: 1 },
  dramatic: { range: 1.45, rate: 0.75, push: 1.12 },
};

/** Minimum quiet between two accents: controlled randomness, never a twitchy cat. */
const ACCENT_GAP_S = 1.4;

/** Small seeded PRNG, so a session's accents are varied but reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A damped spring: the head moves toward its target, overshoots a touch and settles. */
class Spring {
  pos = 0;
  vel = 0;
  constructor(private readonly k: number, private readonly zeta: number) {}
  step(target: number, dt: number): number {
    // Sub-step so a long frame cannot explode the integration.
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const c = 2 * this.zeta * Math.sqrt(this.k);
    for (let i = 0; i < n; i++) {
      this.vel += (this.k * (target - this.pos) - c * this.vel) * h;
      this.pos += this.vel * h;
    }
    return this.pos;
  }
  kick(v: number): void {
    this.vel += v;
  }
}

/**
 * The crying cycle, by seconds since crying began: eyes water, a tear gathers
 * and grows, falls, and the next one starts - never a stream of particles.
 */
export function tearStage(s: number): number {
  if (s < 0.9) return 1;
  if (s < 1.8) return 2;
  if (s < 2.6) return 3;
  const c = (s - 2.6) % 3;
  return c < 0.55 ? 4 : c < 1.15 ? 5 : c < 1.7 ? 6 : c < 2.3 ? 2 : 3;
}

export const NO_OVERLAY: Overlay = {
  active: false, emotion: "neutral", intensity: 0, look: {}, tilt: 0, bob: 0, gaze: null, gesture: null, tears: 0, tailSpeed: 1, movement: "normal", anim: null,
};

export class ExpressionController {
  private t = 0;
  private readonly rand: () => number;
  private settings: ExpressionSettings = { level: "balanced", edgy: false };
  private traits: CostumeTraits = {};
  private tilt = new Spring(95, 0.55);
  private bob = new Spring(120, 0.6);
  private lastEmotion: EmotionId = "neutral";
  private anticipateUntil = 0;
  private nextAt = new Map<string, number>();
  private accent: { a: Accent; until: number; start: number } | null = null;
  private quietUntil = 0;
  private lastGesture: Gesture | null = null;
  private readonly out: Overlay = { ...NO_OVERLAY, look: {} };

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
  }

  setSettings(s: ExpressionSettings): void {
    this.settings = s;
  }

  getSettings(): ExpressionSettings {
    return this.settings;
  }

  /**
   * What the worn costume covers. Hidden ears or eyes hand more of the acting
   * to the head and tail; a change nobody can see is not drawn at all.
   */
  setCostumeTraits(t: CostumeTraits): void {
    this.traits = t;
  }

  private rnd(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rand();
  }

  /** Advance by dt seconds and describe the frame. Reuses one Overlay object. */
  update(dt: number, emo: EmotionState, ctx: ExpressionContext): Overlay {
    this.t += dt;
    const o = this.out;
    const spec = emotion(emo.emotion);
    const lv = LEVEL[this.settings.level];
    if (emo.emotion !== this.lastEmotion) this.changed(emo.emotion);

    const I = emo.emotion === "neutral" ? 0 : Math.min(1, emo.intensity * lv.push);
    // The head keeps springing back to rest even after the feeling has gone.
    const settled = I < 0.04 && Math.abs(this.tilt.pos) < 0.5 && Math.abs(this.bob.pos) < 0.1 && !this.accent;
    if (settled) {
      this.tilt.pos = this.tilt.vel = this.bob.pos = this.bob.vel = 0;
      Object.assign(o, NO_OVERLAY);
      o.look = {};
      return o;
    }

    // ---- the look: tiers, the secondary emotion, and any accent on top ----
    const look: Look = I > 0 ? lookAt(emo.emotion, I) : {};
    if (emo.secondary) {
      const sec = lookAt(emo.secondary.emotion, emo.secondary.intensity * lv.push);
      for (const k of Object.keys(sec) as (keyof Look)[]) if (look[k] === undefined) (look as Record<string, unknown>)[k] = sec[k];
    }
    this.runAccents(spec.accents ?? [], I, ctx, spec.serious ?? false);
    const ac = this.accent;
    if (ac?.a.look) Object.assign(look, ac.a.look);
    const tr = this.traits;
    if (tr.hidesEars) delete look.ears;
    if (tr.hidesBrows) delete look.brow;
    // Each hidden feature the costume takes away, the head and tail give back a little.
    const boost = 1 + 0.2 * (Number(!!tr.hidesEars) + Number(!!tr.coversEyes));

    // ---- head: tilt and bob on springs, with anticipation at a change ----
    const tiltTarget = (look.tilt ?? 0) * lv.range * boost * Math.min(1, 0.35 + I);
    const bobTarget = (look.bob ?? 0) * boost * Math.min(1, 0.35 + I) * (lv.range > 1 ? 1.15 : lv.range < 1 ? 0.7 : 1);
    const anticipating = this.t < this.anticipateUntil;
    const tilt = this.tilt.step(anticipating ? -0.35 * tiltTarget : tiltTarget, dt);
    const bob = this.bob.step(anticipating ? bobTarget + 0.5 : bobTarget, dt);

    // ---- gaze: something watched wins; otherwise the emotion's resting gaze ----
    let gaze: { x: number; y: number } | null = null;
    if (ctx.attention) gaze = ctx.attention;
    else if (look.gaze) gaze = { x: clamp2(look.gaze.x * Math.min(1.25, lv.range)), y: clamp2(look.gaze.y * Math.min(1.25, lv.range)) };

    // ---- paws: a held gesture, else an accent's ----
    let gesture: Gesture | null = null;
    if (ctx.canGesture) {
      const hold = spec.hold;
      if (hold && I >= hold.min) gesture = pickAlternating(hold.gesture, this.t, hold.period ?? 0.3);
      else if (ac?.a.gesture) gesture = pickAlternating(ac.a.gesture, this.t - ac.start, 0.26);
    }
    if (gesture) gesture = safeGesture(gesture, { enabled: this.settings.edgy, invited: ctx.edgyInvited, serious: ctx.serious || !!spec.serious });
    if (gesture && gesture !== this.lastGesture) this.bob.kick(-4); // a raised paw lifts the whole cat a touch
    this.lastGesture = gesture;

    // ---- tears ----
    let tears = 0;
    if (spec.cries && I > 0) {
      tears = I < 0.55 ? 1 : tearStage(this.t - emo.since);
      if (ac?.a.gesture === "wipe") tears = 1; // the paw just wiped it away
    } else if (look.eyes === "watery") {
      tears = 1;
    }

    o.active = true;
    o.emotion = emo.emotion;
    o.intensity = I;
    o.look = look;
    o.tilt = quantTilt(tilt);
    o.bob = Math.round(bob * 4) / 4;
    o.gaze = gaze;
    o.gesture = gesture;
    o.tears = Math.min(TEAR_STAGES, tears);
    o.tailSpeed = 1 + (spec.tail - 1) * Math.min(1, I * 1.3 * boost);
    o.movement = I >= 0.35 ? spec.movement : "normal";
    // `anim` is set by runAccents for the frame an accent starts, then cleared.
    return o;
  }

  private changed(id: EmotionId): void {
    this.lastEmotion = id;
    this.anticipateUntil = this.t + 0.12;
    this.accent = null;
    this.nextAt.clear();
    // The first accents come after the feeling has had a moment to land.
    const lv = LEVEL[this.settings.level];
    for (const a of emotion(id).accents ?? []) this.nextAt.set(a.id, this.t + this.rnd(a.every[0], a.every[1]) * lv.rate * 0.6);
  }

  private runAccents(accents: readonly Accent[], I: number, ctx: ExpressionContext, serious: boolean): void {
    this.out.anim = null;
    if (this.accent && this.t >= this.accent.until) {
      this.accent = null;
      this.quietUntil = this.t + ACCENT_GAP_S;
    }
    if (this.accent || this.t < this.quietUntil || I <= 0) return;
    const lv = LEVEL[this.settings.level];
    for (const a of accents) {
      const due = this.nextAt.get(a.id);
      if (due === undefined || this.t < due) continue;
      this.nextAt.set(a.id, this.t + this.rnd(a.every[0], a.every[1]) * lv.rate);
      if (I < (a.min ?? 0)) continue;
      if (a.gesture && !ctx.canGesture) continue;
      // Subtle keeps to the face: no hops, no signs.
      if (this.settings.level === "subtle" && (a.anim || a.gesture)) continue;
      if (serious && a.anim) continue;
      // Not allowed right now: skip it (the emotion has its own harmless dismissive wave).
      if (a.edgy && safeGesture("middle", { enabled: this.settings.edgy, invited: ctx.edgyInvited, serious }) !== "middle") continue;
      this.accent = { a, until: this.t + a.dur, start: this.t };
      if (a.anim) this.out.anim = a.anim;
      return;
    }
  }
}

function pickAlternating(g: Gesture | readonly Gesture[], t: number, period: number): Gesture {
  if (typeof g === "string") return g;
  return g[Math.floor(Math.max(0, t) / period) % g.length];
}

function clamp2(v: number): number {
  return Math.max(-2, Math.min(2, v));
}

function quantTilt(deg: number): number {
  const q = Math.round(deg / HEAD_TILT_STEP) * HEAD_TILT_STEP;
  return Math.max(-HEAD_TILT_MAX, Math.min(HEAD_TILT_MAX, q)) || 0;
}

/**
 * An emotion at full strength, held still: Photo Mode, the preview window's
 * stills, the expression sheet. Crying shows a tear on the cheek.
 */
export function peakOverlay(id: EmotionId, level: ExpressionLevel = "balanced"): Overlay {
  const spec = emotion(id);
  const look = lookAt(id, 1);
  const hold = spec.hold?.gesture;
  return {
    ...NO_OVERLAY,
    active: id !== "neutral",
    emotion: id,
    intensity: 1,
    look,
    tilt: quantTilt((look.tilt ?? 0) * LEVEL[level].range),
    bob: look.bob ?? 0,
    gaze: look.gaze ?? null,
    gesture: hold ? (typeof hold === "string" ? hold : hold[0]) : null,
    tears: spec.cries ? 4 : look.eyes === "watery" ? 1 : 0,
    tailSpeed: spec.tail,
    movement: spec.movement,
  };
}

/**
 * `base` showing `id` at full strength, held still (Photo Mode, previews):
 * the eyes go where the feeling puts them unless the pose aimed them itself.
 */
export function feelPose(base: PoseSpec, id: EmotionId, out: PoseSpec = { ...DEFAULT_POSE }): PoseSpec {
  const ov = peakOverlay(id);
  const pose = applyOverlay(base, ov, out);
  if (ov.gaze && base.pupilX === 0 && base.pupilY === 0) {
    pose.pupilX = ov.gaze.x;
    pose.pupilY = ov.gaze.y;
  }
  return pose;
}

/** A sitting cat showing `id` at full strength. */
export function peakPose(id: EmotionId, base: Partial<PoseSpec> = { body: "sit" }): PoseSpec {
  return feelPose({ ...DEFAULT_POSE, ...base }, id);
}

/** Tails the emotion may replace: resting ones. A walking cat's raised tail is the walk's. */
const RESTING_TAILS: ReadonlySet<TailState> = new Set<TailState>(["curl", "wrap", "flick"]);

/**
 * Lay an overlay on the animation's pose, into `out`. The animation's own
 * deliberate choices win: an emotion fills the eyes only while they are
 * plainly open, the mouth only while it is at rest, paws only when they are
 * free - so a yawn is still a yawn and a blink still blinks, sadly.
 */
export function applyOverlay(base: PoseSpec, ov: Overlay, out: PoseSpec): PoseSpec {
  Object.assign(out, base);
  if (!ov.active) return out;
  const L = ov.look;
  // The idle and sit loops half-close the eyes every other beat as an ambient
  // slow blink; left alone that flickered every feeling back to sleepy. A clear
  // feeling takes those frames too. Closed eyes (a real blink) still blink.
  if (L.eyes && (base.eyes === "open" || (base.eyes === "half" && ov.intensity >= 0.35))) out.eyes = L.eyes;
  if (L.brow && base.brow === "none") out.brow = L.brow;
  if (L.mouth && base.mouth === "none") out.mouth = L.mouth;
  if (L.ears && (base.ears === "up" || base.ears === "perk")) out.ears = L.ears;
  if (L.tail && RESTING_TAILS.has(base.tail)) out.tail = L.tail;
  if (L.tint && base.tint === "none") out.tint = L.tint;
  if (L.blush) out.blush = true;
  if (L.sweat) out.sweat = true;
  if (L.anger) out.anger = true;
  if (L.sparkle) out.sparkle = true;
  if (L.hearts) out.hearts = true;
  if (L.zzz) out.zzz = true;
  const front = base.view === "front" || base.view === "threeQuarter";
  if (ov.gesture && front && base.gesture === "none" && base.prop === "none" && (base.body === "sit" || base.body === "stand")) out.gesture = ov.gesture;
  if (front) out.headTilt = quantTilt(base.headTilt + ov.tilt);
  out.headBob = Math.max(-2.5, Math.min(3, Math.round((base.headBob + ov.bob) * 4) / 4));
  if (front && ov.tears && base.eyes !== "happy") out.tears = ov.tears;
  return out;
}
