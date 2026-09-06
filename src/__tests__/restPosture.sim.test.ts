import { describe, it, expect } from "vitest";
import { CatBrain, type BrainInput } from "../behaviour/catStateMachine";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { DEFAULT_SETTINGS, ACTIVITY_PROFILES } from "../settings/defaultSettings";
import { makeConfig } from "../physics/physicsEngine";
import type { CatState } from "../types/cat";

/**
 * Behavioural simulation: over a long stretch with the user present but not
 * interacting, how does the cat actually spend its time? It should mostly be
 * sitting still and facing the user, not pacing or parked in profile.
 */
describe("resting posture over a long session", () => {
  it("spends most of its time front-facing and stationary", () => {
    const brain = new CatBrain();
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    const state: CatState = {
      x: 900, y: 1000, velocityX: 0, velocityY: 0, isGrounded: true,
      facing: "right", currentAnimation: "idle", mood: "calm",
      energy: 0.8, curiosity: 0.5, isDragging: false,
    } as CatState;

    const views: Record<string, number> = {};
    const moving = { yes: 0, no: 0 };
    const dt = 0.1;
    const steps = 5 * 60 * 10; // 5 simulated minutes

    for (let i = 0; i < steps; i++) {
      const now = i * dt * 1000;
      const input: BrainInput = {
        state, cfg: makeConfig(1),
        // Cursor present and gently moving, so the cat never drifts into sleep.
        cursor: { x: 1400, y: 500, speed: 5, dirX: 1, dirY: 0, timestamp: now },
        petting: false, userIdle: false, userIdleS: 1,
        cursorChasing: true, activity: ACTIVITY_PROFILES[DEFAULT_SETTINGS.activityLevel],
        support: null, platforms: [], bounds: { left: 0, top: 0, right: 1920, bottom: 1080 },
        scale: 1, dt, now, random,
      } as BrainInput;

      const out = brain.update(input);
      const view = ANIMATIONS[out.animation].view ?? "front";
      views[view] = (views[view] ?? 0) + 1;
      if (out.targetVx !== null && out.targetVx !== 0) moving.yes++;
      else moving.no++;
      // Crude integration so wander actually reaches its target.
      if (out.targetVx) state.x = Math.max(0, Math.min(1920, state.x + out.targetVx * dt));
    }

    const total = steps;
    const pct = (n: number) => ((n / total) * 100).toFixed(1) + "%";
    console.log("=== 5-minute behaviour simulation ===");
    console.log("front-facing :", pct(views.front ?? 0));
    console.log("side profile :", pct(views.side ?? 0));
    console.log("three-quarter:", pct(views.threeQuarter ?? 0));
    console.log("back         :", pct(views.back ?? 0));
    console.log("stationary   :", pct(moving.no));

    // The companion should read as "sitting with you", not pacing in profile.
    expect((views.front ?? 0) / total).toBeGreaterThan(0.8);
    expect((views.side ?? 0) / total).toBeLessThan(0.15);
    expect(moving.no / total).toBeGreaterThan(0.85);
  });
});
