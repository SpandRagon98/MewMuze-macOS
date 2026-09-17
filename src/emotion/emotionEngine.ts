//! CatEmotionEngine: what MewMuze is feeling, how strongly, and why.
//!
//!   EVENT / CONTEXT  →  request()  →  EmotionState  →  ExpressionController  →  pose
//!
//! Everything that wants the cat to feel something - a chat mood, a persona,
//! a butterfly, a finished focus session, being grabbed too often - asks
//! here, with a source. The source sets its priority, so an ambient mood never
//! overrides a direct interaction, and nothing overrides a drag. Feelings have
//! intensity, last a while, then fade; some pass through others on the way in
//! and out (sad before crying, crying through sad back to calm), and a heavy
//! feeling leaves a short, calmer afterglow. Nothing here is stored.

import { blends, emotion, type EmotionId } from "./emotions";

/** Who is asking. Order is priority: a drag outranks everything. */
export const SOURCES = ["idle", "ambient", "event", "chat", "interaction", "drag"] as const;
export type EmotionSource = (typeof SOURCES)[number];
const PRIORITY: Record<EmotionSource, number> = { idle: 0, ambient: 1, event: 2, chat: 3, interaction: 4, drag: 5 };

export interface EmotionRequest {
  emotion: EmotionId;
  /** 0..1. */
  intensity: number;
  source: EmotionSource;
  /** Seconds before it starts fading (default: the emotion's own). */
  duration?: number;
  secondary?: { emotion: EmotionId; intensity: number };
}

export interface EmotionState {
  emotion: EmotionId;
  /** The live, smoothed intensity 0..1. */
  intensity: number;
  secondary: { emotion: EmotionId; intensity: number } | null;
  source: EmotionSource;
  /** −1..1 and 0..1, from the emotion (for the cat's movement and the brain). */
  valence: number;
  energy: number;
  /** When this emotion began (engine clock, s). */
  since: number;
}

/** Seconds spent in each intermediate emotion on the way in (sad → crying). */
const VIA_SECONDS = 1.1;
/** Below this the feeling is gone. */
const GONE = 0.08;
/** How long a heavy feeling leaves the cat calmer afterwards. */
const AFTERGLOW_S = 180;

export class CatEmotionEngine {
  private t = 0;
  private cur: EmotionState = CatEmotionEngine.neutral(0);
  /** The intensity the current request asked for; the live value eases toward it. */
  private target = 0;
  /** Until when the current request holds before fading. */
  private holdUntil = 0;
  /** Steps still to go on the way into an emotion. */
  private route: { steps: EmotionId[]; final: EmotionRequest; nextAt: number } | null = null;
  private peak = 0;
  private afterglowUntil = 0;

  private static neutral(t: number): EmotionState {
    return { emotion: "neutral", intensity: 0, secondary: null, source: "idle", valence: 0, energy: 0.5, since: t };
  }

  get state(): EmotionState {
    return this.cur;
  }

  /** 0..1: how much calmer the cat should be after a heavy feeling (emotional memory). */
  calmness(): number {
    if (this.t >= this.afterglowUntil) return 0;
    return Math.min(1, (this.afterglowUntil - this.t) / AFTERGLOW_S) * 0.7;
  }

  /**
   * Ask for a feeling. Accepted when the source is at least as important as
   * the current one, or the current one has run its course. Returns whether
   * it was accepted.
   */
  request(r: EmotionRequest): boolean {
    let req = { ...r, intensity: clamp01(r.intensity) };
    // Sad at full strength IS crying - reached through sadness, not by a jump.
    if (req.emotion === "sad" && req.intensity >= 0.95) req = { ...req, emotion: "crying", intensity: 0.9 };
    const spec = emotion(req.emotion);
    if (req.emotion === "neutral") return this.release(req.source);

    const cur = this.cur;
    const busy = cur.emotion !== "neutral" && this.t < this.holdUntil && cur.intensity > 0.2;
    if (busy && PRIORITY[req.source] < PRIORITY[cur.source]) return false;
    // While calmer after something heavy, playful requests arrive softened.
    if (spec.valence > 0.3 && spec.energy > 0.6) req.intensity *= 1 - this.calmness();

    // Whatever was on its way in is superseded by what is asked now.
    this.route = null;
    if (req.emotion === cur.emotion) {
      // The same feeling again: stronger if asked, and it lasts longer.
      this.target = Math.max(this.target, req.intensity);
      this.holdUntil = Math.max(this.holdUntil, this.t + (req.duration ?? spec.duration));
      if (PRIORITY[req.source] >= PRIORITY[cur.source]) cur.source = req.source;
      this.setSecondary(req.secondary ?? null);
      return true;
    }

    // Some feelings are only reachable through others: never happy → crying
    // in one frame. Surprise and fear have no route - they are meant to jump.
    const via = (spec.enterVia ?? []).filter((v) => v !== cur.emotion);
    if (spec.enterVia && !spec.enterVia.includes(cur.emotion) && via.length) {
      this.route = { steps: [...via], final: req, nextAt: this.t };
      this.advanceRoute();
      return true;
    }
    this.enter(req);
    return true;
  }

  /** Let go of what `source` asked for (the chat closed, the butterfly left). */
  release(source: EmotionSource): boolean {
    if (PRIORITY[source] < PRIORITY[this.cur.source]) return false;
    this.holdUntil = this.t;
    this.route = null;
    return true;
  }

  /** Advance the clock: easing, the route in, the fade and the route out. */
  update(dt: number): void {
    this.t += dt;
    if (this.route && this.t >= this.route.nextAt) this.advanceRoute();
    const cur = this.cur;
    if (cur.emotion === "neutral") return;
    const spec = emotion(cur.emotion);
    if (this.t < this.holdUntil) {
      // Rise quickly, but not instantly: a feeling builds over half a second.
      cur.intensity += (this.target - cur.intensity) * Math.min(1, dt * 3.5);
    } else {
      cur.intensity *= Math.pow(0.5, dt / Math.max(0.2, spec.fade));
    }
    if (cur.secondary) {
      cur.secondary.intensity *= this.t < this.holdUntil ? 1 : Math.pow(0.5, dt / Math.max(0.2, spec.fade));
      if (cur.secondary.intensity < GONE) cur.secondary = null;
    }
    this.peak = Math.max(this.peak, cur.intensity);
    // Crying lets go through sadness once the tears stop; rage through annoyance.
    const exit = spec.exitVia?.[0];
    if (exit && this.t >= this.holdUntil && cur.intensity < 0.45) {
      this.leave();
      this.enter({ emotion: exit, intensity: Math.max(0.35, cur.intensity), source: cur.source, duration: 4 });
      return;
    }
    // Only a fading feeling can be gone: one that is still rising starts near zero.
    if (this.t >= this.holdUntil && cur.intensity < GONE) {
      this.leave();
      this.cur = CatEmotionEngine.neutral(this.t);
      this.target = 0;
    }
  }

  private advanceRoute(): void {
    const route = this.route;
    if (!route) return;
    const step = route.steps.shift();
    if (step) {
      this.enter({ emotion: step, intensity: Math.min(0.75, route.final.intensity), source: route.final.source, duration: VIA_SECONDS + 0.5 });
      route.nextAt = this.t + VIA_SECONDS;
      return;
    }
    this.route = null;
    this.enter(route.final);
  }

  private enter(r: EmotionRequest): void {
    const spec = emotion(r.emotion);
    // Carry the current strength into the new feeling so it grows from where
    // the cat already is rather than dropping to nothing first.
    const carry = this.cur.emotion === "neutral" ? 0 : Math.min(this.cur.intensity, r.intensity) * 0.6;
    this.cur = {
      emotion: r.emotion, intensity: carry, secondary: null, source: r.source,
      valence: spec.valence, energy: spec.energy, since: this.t,
    };
    this.target = r.intensity;
    this.holdUntil = this.t + (r.duration ?? spec.duration);
    this.setSecondary(r.secondary ?? null);
  }

  private setSecondary(s: { emotion: EmotionId; intensity: number } | null): void {
    this.cur.secondary = s && blends(this.cur.emotion, s.emotion) ? { emotion: s.emotion, intensity: clamp01(s.intensity) } : null;
  }

  /** A heavy, unpleasant feeling ending leaves the cat quieter for a few minutes. */
  private leave(): void {
    const spec = emotion(this.cur.emotion);
    if (spec.valence < -0.3 && this.peak > 0.5) this.afterglowUntil = this.t + AFTERGLOW_S;
    this.peak = 0;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
