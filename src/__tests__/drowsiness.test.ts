import { describe, it, expect } from "vitest";
import { CatBrain, type BrainInput } from "../behaviour/catStateMachine";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { DEFAULT_SETTINGS, ACTIVITY_PROFILES } from "../settings/defaultSettings";
import type { CatState } from "../types/cat";

function state(over: Partial<CatState> = {}): CatState {
  return {
    x: 500, y: 500, velocityX: 0, velocityY: 0, isGrounded: true,
    facing: "right", currentAnimation: "idle", mood: "calm",
    energy: 0.8, curiosity: 0.5, isDragging: false, ...over,
  } as CatState;
}

function input(over: Partial<BrainInput> = {}): BrainInput {
  return {
    state: state(),
    cfg: { gravity: 1400, walkSpeed: 60, runSpeed: 150, jumpVelocity: 400, friction: 0.8, maxFallSpeed: 900 },
    cursor: null,
    petting: false,
    userIdle: false,
    userIdleS: 0,
    cursorChasing: true,
    activity: ACTIVITY_PROFILES[DEFAULT_SETTINGS.activityLevel],
    support: null,
    platforms: [],
    bounds: { left: 0, top: 0, right: 1920, bottom: 1080 },
    scale: 1,
    dt: 0.1,
    now: 10_000,
    random: () => 0.99, // avoid the random gesture/explore branches
    ...over,
  } as BrainInput;
}

describe("combined-input drowsiness", () => {
  it("yawns first, then sleeps, once both mouse and keyboard are inactive", () => {
    const brain = new CatBrain();
    const first = brain.update(input({ userIdleS: 25 }));
    expect(first.behaviour).toBe("sleep");
    expect(first.animation).toBe("yawn");

    // Let the yawn play out in full.
    const yawnS = ANIMATIONS.yawn.frames.length / ANIMATIONS.yawn.fps;
    let out = first;
    for (let t = 0; t < yawnS + 0.5; t += 0.1) {
      out = brain.update(input({ userIdleS: 25 + t, now: 10_000 + t * 1000 }));
    }
    expect(out.animation).toBe("sleep");
  });

  it("does not wake for a cursor that is merely parked nearby", () => {
    const brain = new CatBrain();
    const cursor = { x: 505, y: 505, speed: 0, dirX: 0, dirY: 0, timestamp: 0 };
    let out = brain.update(input({ userIdleS: 30, cursor }));
    expect(out.behaviour).toBe("sleep");
    // Still idle, cursor still sitting right next to the cat.
    out = brain.update(input({ userIdleS: 40, cursor, now: 20_000 }));
    expect(out.behaviour).toBe("sleep");
  });

  it("wakes when the cursor actually moves nearby", () => {
    const brain = new CatBrain();
    const cursor = { x: 505, y: 505, speed: 0, dirX: 0, dirY: 0, timestamp: 0 };
    expect(brain.update(input({ userIdleS: 30, cursor })).behaviour).toBe("sleep");
    const out = brain.update(input({ userIdleS: 0, cursor, now: 20_000 }));
    expect(out.animation).toBe("wakeUp");
  });

});

describe("resting posture", () => {
  it("idles facing forward rather than in profile", () => {
    const brain = new CatBrain();
    // random()=0.99 skips the gesture branches, leaving the default idle pose.
    const out = brain.update(input({ now: 1_000 }));
    expect(out.animation).toBe("idle");
    expect(ANIMATIONS.idle.view).toBe("front");
  });
});
