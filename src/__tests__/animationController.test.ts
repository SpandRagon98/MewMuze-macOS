import { describe, it, expect } from "vitest";
import { AnimationController } from "../animation/animationController";

describe("AnimationController", () => {
  it("loops looping animations", () => {
    const c = new AnimationController("idle");
    // idle has 4 frames at 4fps -> 0.25s per frame.
    for (let i = 0; i < 20; i++) c.update(0.25);
    expect(c.name).toBe("idle"); // still looping, never leaves
  });

  it("auto-chains a one-shot into its declared next state", () => {
    const c = new AnimationController("jump");
    // jump -> fall (fall loops)
    for (let i = 0; i < 10; i++) c.update(0.05);
    expect(c.name).toBe("fall");
  });

  it("respects minDuration before allowing interruption", () => {
    const c = new AnimationController("sit"); // minDuration 0.8
    c.update(0.1);
    expect(c.canInterrupt()).toBe(false);
    expect(c.requestPlay("walk")).toBe(false);
    c.update(0.9);
    expect(c.canInterrupt()).toBe(true);
    expect(c.requestPlay("walk")).toBe(true);
    expect(c.name).toBe("walk");
  });

  it("play() resets timers and force switches", () => {
    const c = new AnimationController("idle");
    c.update(0.1);
    c.play("run");
    expect(c.name).toBe("run");
    expect(c.frame).toBe(0);
  });

  it("tolerates a very large dt without runaway looping", () => {
    const c = new AnimationController("walk");
    expect(() => c.update(1000)).not.toThrow();
    expect(c.name).toBe("walk");
  });

  it("plays the front-facing cute nod and settles into a sit", () => {
    const c = new AnimationController("cuteNod");
    expect(c.getPose().view).toBe("front");
    expect(c.getPose().body).toBe("sit");
    // The brain goes back to requesting its ordinary idle on following ticks;
    // the nod must still finish before those requests can interrupt it.
    for (let i = 0; i < 24; i++) {
      c.requestPlay("sideIdle");
      c.update(0.05);
    }
    expect(c.name).toBe("sit");
  });

  it("opens into a full yawn before chaining into sleep", () => {
    const c = new AnimationController("yawn");
    c.update(0.5);
    expect(c.getPose().mouth).toBe("yawn");
    expect(c.getPose().eyes).toBe("closed");
    for (let i = 0; i < 24; i++) c.update(0.05);
    expect(c.name).toBe("sleep");
  });
});

/**
 * Poses are tweened between keyframes so the cat moves at the display's rate
 * rather than at each animation's own 4-13fps. Without this the render loop ran
 * at 60fps but the cat only changed pose a few times a second, which read as a
 * stepping, jerky animation.
 */
describe("AnimationController keyframe tweening", () => {
  it("produces intermediate poses between two keyframes", () => {
    const c = new AnimationController("quickTools"); // 4fps, legPhase 0/.25/.5/.75
    const seen = new Set<number>();
    // Sample at 60fps across a single 0.25s keyframe interval.
    for (let i = 0; i < 15; i++) {
      seen.add(c.getPose().legPhase);
      c.update(1 / 60);
    }
    // Snapping would give exactly one value for the whole interval.
    expect(seen.size).toBeGreaterThan(4);
  });

  it("advances the pose on most frames at 60fps", () => {
    const c = new AnimationController("walk");
    let changes = 0;
    let prev = -1;
    for (let i = 0; i < 60; i++) {
      const p = c.getPose();
      const v = p.legPhase * 1000 + p.headBob;
      if (v !== prev) changes++;
      prev = v;
      c.update(1 / 60);
    }
    // Well beyond the handful of updates the raw keyframe rate would give.
    expect(changes).toBeGreaterThan(30);
  });

  it("keeps discrete states snapping rather than blending", () => {
    const c = new AnimationController("quickTools");
    for (let i = 0; i < 30; i++) {
      const p = c.getPose();
      // These are states, not quantities — there is no halfway pose to draw.
      expect(typeof p.eyes).toBe("string");
      expect(p.prop).toBe("laptop");
      expect(p.view).toBe("front");
      c.update(1 / 60);
    }
  });

  it("wraps a looping gait the short way instead of running backwards", () => {
    const c = new AnimationController("quickTools");
    // Step to the final keyframe (legPhase 0.75), which loops back to 0.
    for (let i = 0; i < 3; i++) c.update(0.25);
    expect(c.getPose().legPhase).toBeCloseTo(0.75, 1);
    const phases: number[] = [];
    for (let i = 0; i < 14; i++) {
      c.update(1 / 60);
      phases.push(c.getPose().legPhase);
    }
    // Going forwards wraps through >0.75 and past 1 back to near 0. A naive
    // lerp would instead sweep down through 0.5 and 0.25.
    expect(phases.some((p) => p > 0.75 || p < 0.25)).toBe(true);
    expect(phases.every((p) => p >= 0 && p < 1)).toBe(true);
  });

  it("holds the final pose of a finished one-shot", () => {
    const c = new AnimationController("bow"); // 4 frames, chains into idle
    for (let i = 0; i < 6; i++) c.update(0.05);
    const a = { ...c.getPose() };
    const b = { ...c.getPose() };
    // Repeated reads at the same instant must agree (the scratch pose is
    // reused, so this also guards against it being mutated between calls).
    expect(b).toEqual(a);
  });

  it("keeps tweened values on a coarse grid so the sprite cache can hit", () => {
    // Continuous values would make every frame a fresh cache key, and an
    // unbounded sprite cache is what made this app unresponsive once before.
    const c = new AnimationController("walk");
    for (let i = 0; i < 40; i++) {
      const p = c.getPose();
      expect(Number.isFinite(p.legPhase)).toBe(true);
      // 1/48 grid: multiplying by 48 must land on (near) a whole number.
      expect(Math.abs(p.legPhase * 48 - Math.round(p.legPhase * 48))).toBeLessThan(1e-6);
      expect(Math.abs(p.headBob * 8 - Math.round(p.headBob * 8))).toBeLessThan(1e-6);
      c.update(1 / 60);
    }
  });
});
