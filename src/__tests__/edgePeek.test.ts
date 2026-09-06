import { describe, it, expect } from "vitest";
import { CatEngine } from "../engine/catEngine";
import { buildPlatforms } from "../physics/platformResolver";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";
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

function makeEngine() {
  const engine = new CatEngine({
    sizePx: 40,
    scale: 1,
    activity: ACTIVITY_PROFILES.balanced,
    bounds,
    start: { x: 400, y: 560 },
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

/** Drag the cat to (x, y) and let go there. */
function dragTo(engine: CatEngine, x: number, y: number) {
  engine.grabStart();
  engine.grabMove(x, y, 100);
  engine.grabMove(x, y, 100);
  engine.grabEnd({ x: 0, y: 0 });
}

describe("Edge Peek Mode", () => {
  it("released against the left edge, it tucks in and peeks with the face visible", () => {
    const engine = makeEngine();
    dragTo(engine, 5, 300);
    expect(engine.edgePeek).toBe("left");
    // Centre just INSIDE the screen: over half the cat (incl. the face) shows,
    // while the far half of the body stays tucked beyond the edge.
    expect(engine.state.x).toBeGreaterThan(0);
    expect(engine.state.x).toBeLessThan(40 * 0.2);
    expect(engine.state.facing).toBe("right"); // looking back into the room
    expect(engine.state.currentAnimation === "edgePeek" || engine.state.isGrounded).toBe(true);
  });

  it("released against the right edge, it peeks from the right, facing left", () => {
    const engine = makeEngine();
    dragTo(engine, 796, 300);
    expect(engine.edgePeek).toBe("right");
    expect(engine.state.x).toBeLessThan(800);
    expect(engine.state.x).toBeGreaterThan(800 - 40 * 0.2);
    expect(engine.state.facing).toBe("left");
  });

  it("stays pinned at the edge over time (no gravity, no wandering off)", () => {
    const engine = makeEngine();
    dragTo(engine, 3, 300);
    const x0 = engine.state.x;
    const y0 = engine.state.y;
    for (let i = 0; i < 300; i++) engine.tick(0.03, 10_000 + i * 30);
    expect(engine.edgePeek).toBe("left");
    expect(engine.state.x).toBeCloseTo(x0, 5);
    expect(engine.state.y).toBeCloseTo(y0, 5);
    expect(engine.state.currentAnimation).toBe("edgePeek");
  });

  it("grabbing it again pulls it out of the edge", () => {
    const engine = makeEngine();
    dragTo(engine, 3, 300);
    expect(engine.edgePeek).toBe("left");
    engine.grabStart();
    expect(engine.edgePeek).toBeNull();
    engine.grabMove(400, 300, 100);
    engine.grabEnd({ x: 0, y: 0 });
    expect(engine.edgePeek).toBeNull();
    // Back to normal physics: it falls and lands like usual.
    let grounded = false;
    for (let i = 0; i < 300 && !grounded; i++) {
      engine.tick(0.03, 20_000 + i * 30);
      grounded = engine.state.isGrounded;
    }
    expect(grounded).toBe(true);
  });

  it("a normal mid-screen drop never enters edge peek", () => {
    const engine = makeEngine();
    dragTo(engine, 400, 300);
    expect(engine.edgePeek).toBeNull();
  });

  it("loses its temper after six grabs in quick succession", () => {
    const engine = makeEngine();
    // Settle onto the floor first so drops land on the monitor platform.
    for (let i = 0; i < 100 && !engine.state.isGrounded; i++) engine.tick(0.03, i * 30);
    // Drop from well above the floor each time so the release falls onto the
    // monitor platform normally (a release below the floor line is a test-world
    // artifact — production bounds carry floorY).
    for (let g = 0; g < 6; g++) dragTo(engine, 300 + g * 20, 400);
    // The sixth release triggers the tantrum on landing: angry glare, teeth.
    // (currentAnimation is published by tick, so advance until it lands.)
    let angrySeen = false;
    for (let i = 0; i < 200 && !angrySeen; i++) {
      engine.tick(0.016, 50_000 + i * 16);
      if (engine.state.currentAnimation === "angry") angrySeen = true;
    }
    expect(angrySeen).toBe(true);
  });

  it("stays calm when grabbed only a few times", () => {
    const engine = makeEngine();
    for (let i = 0; i < 100 && !engine.state.isGrounded; i++) engine.tick(0.03, i * 30);
    for (let g = 0; g < 3; g++) dragTo(engine, 300 + g * 20, 400);
    for (let i = 0; i < 200; i++) {
      engine.tick(0.016, 50_000 + i * 16);
      expect(engine.state.currentAnimation).not.toBe("angry");
    }
  });

  it("persists a safe on-screen position while peeking", () => {
    const engine = makeEngine();
    dragTo(engine, 3, 300);
    const safe = engine.getSafePosition();
    expect(safe.x).toBeGreaterThanOrEqual(0);
    expect(safe.x).toBeLessThanOrEqual(800);
  });
});
