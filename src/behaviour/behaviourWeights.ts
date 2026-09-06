import type { CatMood } from "../types/cat";
import type { ActivityProfile } from "../settings/defaultSettings";
import { ENERGY_LOW } from "./energySystem";

/**
 * High-level behaviours the cat can choose when it is grounded and idle-enough
 * to pick something new. Transient physical states (dragging, falling, petting,
 * annoyed) are handled directly by the engine, not chosen here.
 */
export type Behaviour =
  | "idle"
  | "wander"
  | "rest"
  | "groom"
  | "observe"
  | "lookAround"
  | "approachCursor"
  | "chaseCursor"
  | "playSelf"
  | "sleep";

export interface WeightContext {
  mood: CatMood;
  energy: number; // 0..1
  curiosity: number; // 0..1
  cursorNearby: boolean;
  cursorFast: boolean;
  cursorChasingEnabled: boolean;
  userIdle: boolean;
  activity: ActivityProfile;
}

const MOOD_BIAS: Record<CatMood, Partial<Record<Behaviour, number>>> = {
  calm: { wander: 0.8, rest: 1.3, groom: 1.2, chaseCursor: 0.5 },
  curious: { observe: 1.6, approachCursor: 1.5, lookAround: 1.4, wander: 1.2 },
  playful: { chaseCursor: 1.8, playSelf: 1.6, approachCursor: 1.3, rest: 0.5 },
  sleepy: { sleep: 2.2, rest: 1.1, groom: 0.7, chaseCursor: 0.2 },
  annoyed: { wander: 1.4, rest: 1.2, chaseCursor: 0.2, approachCursor: 0.2 },
};

/** Compute a raw weight per behaviour for the current context. */
export function behaviourWeights(ctx: WeightContext): Record<Behaviour, number> {
  const { energy, curiosity, cursorNearby, cursorFast, cursorChasingEnabled, userIdle, activity } = ctx;
  const energetic = energy > 0.3;

  // The companion should feel relaxing: it prefers to settle down and watch
  // rather than pace the screen. Roaming is only likely when it is lively AND
  // the cursor is not nearby to hold its attention. Calm sitting/resting is the
  // strong default, especially once it has been left alone for a while.
  const calmPull = cursorNearby ? 1 : 1.4; // sit and observe more when undisturbed
  const w: Record<Behaviour, number> = {
    // Sitting is overwhelmingly the default. The companion should read as a cat
    // keeping you company at your desk, not one pacing back and forth across
    // the screen — roaming is an occasional punctuation, not the baseline.
    idle: 4.0 * calmPull,
    wander: 0.22 * (energetic ? 1 : 0.3) * (cursorNearby ? 0.5 : 1),
    rest: 1.5 * activity.restfulness * (energy < 0.5 ? 1.7 : 1.0) * calmPull,
    groom: 1.4 * calmPull,
    observe: 0.8 * (cursorNearby ? 1.7 : 0.7) * (0.5 + curiosity),
    lookAround: 0.45,
    approachCursor:
      (cursorChasingEnabled && cursorNearby ? 1.0 : 0) *
      (0.4 + curiosity) *
      activity.chaseEagerness,
    chaseCursor:
      (cursorChasingEnabled && (cursorFast || cursorNearby) && energy > 0.25 ? 1.3 : 0) *
      activity.playfulness *
      activity.chaseEagerness,
    playSelf: 0.4 * activity.playfulness * (energy > 0.4 ? 1 : 0.3),
    sleep: (userIdle || energy < ENERGY_LOW ? 2.8 : 0.04) * activity.restfulness,
  };

  const bias = MOOD_BIAS[ctx.mood];
  (Object.keys(w) as Behaviour[]).forEach((b) => {
    if (bias[b] !== undefined) w[b] *= bias[b]!;
  });
  return w;
}

/** Weighted random pick. `random` returns [0,1); injectable for tests. */
export function pickBehaviour(ctx: WeightContext, random: () => number): Behaviour {
  const w = behaviourWeights(ctx);
  const entries = Object.entries(w) as [Behaviour, number][];
  const total = entries.reduce((s, [, v]) => s + Math.max(0, v), 0);
  if (total <= 0) return "idle";
  let r = random() * total;
  for (const [b, v] of entries) {
    r -= Math.max(0, v);
    if (r <= 0) return b;
  }
  return "idle";
}
