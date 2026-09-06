import { describe, it, expect } from "vitest";
import { CatEngine } from "../engine/catEngine";
import { buildPlatforms } from "../physics/platformResolver";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";
import { ANIMATIONS } from "../animation/animationDefinitions";
import type { AnimationName } from "../types/cat";
import type { NativeMonitor } from "../types/platform";

const monitor: NativeMonitor = {
  left: 0,
  top: 0,
  right: 800,
  bottom: 600,
  workLeft: 0,
  workTop: 0,
  workRight: 800,
  workBottom: 580,
  scale: 1,
  isPrimary: true,
};
const origin = { left: 0, top: 0 };
const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
const SIZE = 40;
const HALF = SIZE / 2;

function makeEngine(activity: keyof typeof ACTIVITY_PROFILES, startX: number) {
  const engine = new CatEngine({
    sizePx: SIZE,
    scale: 1,
    activity: ACTIVITY_PROFILES[activity],
    bounds,
    start: { x: startX, y: 560 },
    random: () => 0.5,
  });
  engine.setWorld({
    platforms: buildPlatforms([], [monitor], origin),
    bounds,
    monitors: [monitor],
    origin,
    scale: 1,
  });
  return engine;
}

/** The view the sprite renders in for a given animation. */
function viewOf(anim: AnimationName): string {
  return ANIMATIONS[anim].frames[0].view;
}

/**
 * Hold the cat against a screen edge and record what it plays. Re-pinning each
 * frame simulates it having walked all the way into the wall.
 */
function runAtEdge(engine: CatEngine, edgeX: number, frames = 600): AnimationName[] {
  const seen: AnimationName[] = [];
  for (let i = 0; i < 200 && !engine.state.isGrounded; i++) engine.tick(0.03, i * 30);
  for (let i = 0; i < frames; i++) {
    engine.state.x = edgeX;
    engine.tick(0.03, 10_000 + i * 30);
    seen.push(engine.state.currentAnimation);
  }
  return seen;
}

describe("cat parked at the extreme horizontal end", () => {
  it("faces the room and sits rather than staying side-on at the left edge", () => {
    const engine = makeEngine("balanced", HALF);
    const seen = runAtEdge(engine, bounds.left + HALF);
    expect(seen).toContain("sit");
    // It must not be "sideways always": side-view frames stay a small minority.
    const sideFrames = seen.filter((a) => viewOf(a) === "side").length;
    expect(sideFrames / seen.length).toBeLessThan(0.5);
  });

  it("does the same at the right edge", () => {
    const engine = makeEngine("balanced", bounds.right - HALF);
    const seen = runAtEdge(engine, bounds.right - HALF);
    expect(seen).toContain("sit");
    const sideFrames = seen.filter((a) => viewOf(a) === "side").length;
    expect(sideFrames / seen.length).toBeLessThan(0.5);
  });

  it("a playful cat also fidgets in place, still front-facing", () => {
    const engine = makeEngine("playful", HALF);
    const seen = runAtEdge(engine, bounds.left + HALF, 900);
    const fidgets = new Set<AnimationName>(["cuteNod", "tailFlick", "danceBop", "happy"]);
    expect(seen.some((a) => fidgets.has(a))).toBe(true);
    // Every fidget it chose is a front view — it moves without turning sideways.
    for (const a of seen) {
      if (fidgets.has(a)) expect(viewOf(a)).toBe("front");
    }
  });

  it("a calm cat just settles and does not fidget", () => {
    const engine = makeEngine("calm", HALF);
    const seen = runAtEdge(engine, bounds.left + HALF, 900);
    expect(seen).toContain("sit");
    expect(seen.some((a) => a === "danceBop" || a === "cuteNod")).toBe(false);
  });

  it("peek mode settles in the corner with a straight, front-facing pose", () => {
    const engine = makeEngine("balanced", 400);
    for (let i = 0; i < 200 && !engine.state.isGrounded; i++) engine.tick(0.03, i * 30);
    engine.setPeek(true);
    // Give it time to walk to the nearest corner and settle.
    for (let i = 0; i < 1200; i++) engine.tick(0.03, 10_000 + i * 30);
    const anim = engine.state.currentAnimation;
    // The old "peek" loop was a SIDE view (crouched, peering round a corner) —
    // that is exactly the hunched sideways pose we are fixing.
    expect(anim).not.toBe("peek");
    expect(viewOf(anim)).toBe("front");
  });

  it("is never trapped: away from the edge it moves normally again", () => {
    const engine = makeEngine("balanced", HALF);
    runAtEdge(engine, bounds.left + HALF, 300);
    // Release it into open space and let it roam.
    engine.state.x = 400;
    const seen: AnimationName[] = [];
    for (let i = 0; i < 600; i++) {
      engine.tick(0.03, 40_000 + i * 30);
      seen.push(engine.state.currentAnimation);
    }
    // It is free to walk again (the edge rule only applies at the edge).
    expect(engine.state.x).toBeGreaterThan(bounds.left + HALF + 2);
    expect(seen.length).toBe(600);
  });
});
