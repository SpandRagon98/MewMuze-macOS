import type { CatMood } from "../types/cat";
import { ENERGY_LOW, clamp01 } from "./energySystem";

/**
 * Mood model. Mood is a soft, hysteretic classification derived from energy,
 * curiosity, recent disturbance, and cursor proximity. It biases which
 * behaviours the weighting system is likely to pick.
 *
 * Mood is intentionally "sticky": we only switch when the new mood's evidence
 * is clearly stronger, to avoid the cat flip-flopping every frame.
 */
export interface MoodContext {
  energy: number; // 0..1
  curiosity: number; // 0..1
  /** 0..1 — rises when the cat is grabbed/clicked repeatedly, decays over time. */
  annoyance: number;
  /** Seconds since the user last interacted with the cat (pet/drag/click). */
  secondsSinceInteraction: number;
  /** Whether the cursor is within the "nearby" radius this tick. */
  cursorNearby: boolean;
  /** Whether the user's machine has had no mouse or keyboard input for a while. */
  userIdle: boolean;
}

const ANNOYED_THRESHOLD = 0.6;

/** Score each candidate mood; highest wins, with a bias toward the current one. */
export function scoreMoods(ctx: MoodContext): Record<CatMood, number> {
  const energy = clamp01(ctx.energy);
  const curiosity = clamp01(ctx.curiosity);
  const annoyance = clamp01(ctx.annoyance);

  const sleepy =
    (energy < ENERGY_LOW ? 1.2 : 0) +
    (ctx.userIdle ? 0.8 : 0) +
    (1 - energy) * 0.6;

  const playful =
    (energy > 0.5 ? 0.9 : 0) *
      (ctx.cursorNearby ? 1.4 : 0.7) +
    curiosity * 0.5;

  const curious =
    curiosity * 1.0 + (ctx.cursorNearby ? 0.5 : 0) + (energy > 0.3 ? 0.2 : 0);

  const calm =
    0.6 + (ctx.secondsSinceInteraction > 8 ? 0.4 : 0) - curiosity * 0.3;

  const annoyed = annoyance > ANNOYED_THRESHOLD ? 1.5 + annoyance : 0;

  return { calm, curious, playful, sleepy, annoyed };
}

/**
 * Resolve the next mood. `current` gets a small stickiness bonus so moods
 * persist unless another is clearly stronger.
 */
export function computeMood(ctx: MoodContext, current: CatMood): CatMood {
  const scores = scoreMoods(ctx);
  // Annoyance is decisive: it overrides everything while elevated.
  if (scores.annoyed > ANNOYED_THRESHOLD + 1) return "annoyed";

  const STICKINESS = 0.35;
  let best: CatMood = current;
  let bestScore = scores[current] + STICKINESS;
  (Object.keys(scores) as CatMood[]).forEach((mood) => {
    if (scores[mood] > bestScore) {
      bestScore = scores[mood];
      best = mood;
    }
  });
  return best;
}

/** Decay accumulated annoyance toward zero. */
export function decayAnnoyance(annoyance: number, dt: number): number {
  // Fully calms down over ~10 seconds.
  return clamp01(annoyance - 0.1 * dt);
}

/** Bump annoyance when the cat is disturbed (grab/click while already busy). */
export function bumpAnnoyance(annoyance: number, amount = 0.25): number {
  return clamp01(annoyance + amount);
}
