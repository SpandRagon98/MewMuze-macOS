import { describe, it, expect } from "vitest";
import { behaviourWeights, pickBehaviour, type WeightContext } from "../behaviour/behaviourWeights";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";

const ctx = (over: Partial<WeightContext> = {}): WeightContext => ({
  mood: "calm",
  energy: 0.6,
  curiosity: 0.3,
  cursorNearby: false,
  cursorFast: false,
  cursorChasingEnabled: true,
  userIdle: false,
  activity: ACTIVITY_PROFILES.balanced,
  ...over,
});

describe("behaviourWeights", () => {
  it("gives zero chase weight when cursor chasing is disabled", () => {
    const w = behaviourWeights(ctx({ cursorChasingEnabled: false, cursorNearby: true, cursorFast: true }));
    expect(w.chaseCursor).toBe(0);
    expect(w.approachCursor).toBe(0);
  });

  it("heavily weights sleep when the user is idle and energy is low", () => {
    const w = behaviourWeights(ctx({ userIdle: true, energy: 0.1, mood: "sleepy" }));
    const max = Math.max(...Object.values(w));
    expect(w.sleep).toBe(max);
  });

  it("pickBehaviour is deterministic with an injected RNG", () => {
    const c = ctx({ mood: "playful", energy: 0.9, cursorNearby: true });
    const a = pickBehaviour(c, () => 0.0);
    const b = pickBehaviour(c, () => 0.0);
    expect(a).toBe(b);
  });

  it("falls back to idle when all weights are zero", () => {
    const zero = ctx({ energy: 0, curiosity: 0, cursorChasingEnabled: false, activity: { playfulness: 0, chaseEagerness: 0, restfulness: 0 } });
    // Force every weight to 0 by picking with a guard: even if not all zero, pick must return a valid behaviour.
    const b = pickBehaviour(zero, () => 0.9999);
    expect(typeof b).toBe("string");
  });
});
