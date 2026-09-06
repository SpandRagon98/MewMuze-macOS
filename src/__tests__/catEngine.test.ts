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

function makeEngine(startY: number) {
  const engine = new CatEngine({
    sizePx: 40,
    scale: 1,
    activity: ACTIVITY_PROFILES.balanced,
    bounds,
    start: { x: 400, y: startY },
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

describe("CatEngine", () => {
  it("falls under gravity and lands on the monitor floor", () => {
    const engine = makeEngine(100);
    let grounded = false;
    for (let i = 0; i < 300 && !grounded; i++) {
      engine.tick(0.03, i * 30);
      if (engine.state.isGrounded) grounded = true;
    }
    expect(grounded).toBe(true);
    expect(engine.state.y).toBeGreaterThan(560);
    expect(engine.state.y).toBeLessThanOrEqual(600);
  });

  it("stays within the horizontal bounds during normal behaviour", () => {
    const engine = makeEngine(560);
    for (let i = 0; i < 500; i++) {
      engine.tick(0.03, i * 30);
      expect(engine.state.x).toBeGreaterThanOrEqual(0);
      expect(engine.state.x).toBeLessThanOrEqual(800);
    }
  });

  it("recovers to a safe on-monitor position on reset", () => {
    const engine = makeEngine(560);
    engine.command("reset", 0);
    expect(engine.state.isGrounded).toBe(true);
    expect(engine.state.x).toBeCloseTo(400, 0);
    expect(engine.state.y).toBeCloseTo(580, 0);
  });

  it("hit-tests the cursor against the cat's interactive bounds", () => {
    const engine = makeEngine(560);
    const b = engine.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    expect(engine.containsPoint(cx, cy)).toBe(true);
    expect(engine.containsPoint(cx + 1000, cy)).toBe(false);
  });

  it("enters the dragging state and follows the cursor", () => {
    const engine = makeEngine(560);
    engine.grabStart();
    expect(engine.state.isDragging).toBe(true);
    engine.grabMove(200, 150, 50);
    engine.tick(0.016, 1000);
    expect(engine.state.x).toBe(200);
    // Cat hangs just below the cursor.
    expect(engine.state.y).toBeGreaterThan(150);
    engine.grabEnd({ x: 0, y: 0 });
    expect(engine.state.isDragging).toBe(false);
  });

  it("visibly deforms and trails during a fast drag", () => {
    const engine = makeEngine(560);
    engine.setDragStretch(true);
    engine.grabStart();
    engine.grabMove(200, 150, 80);
    for (let i = 0; i < 12; i++) {
      engine.grabMove(200 + i * 22, 150, 520);
      engine.tick(0.016, 1000 + i * 16);
    }
    const render = engine.getRender();
    // Deformation is expressed as per-vertex mesh offsets, not a uniform scale.
    expect(render.mesh).not.toBeNull();
    const mesh = render.mesh!;
    // The grabbed scruff stays welded (offset ~0) while lower vertices trail, so
    // the vertical spread of x-offsets down the grid must be non-trivial.
    let minOx = Infinity, maxOx = -Infinity;
    for (let i = 0; i < mesh.length; i += 2) {
      minOx = Math.min(minOx, mesh[i]);
      maxOx = Math.max(maxOx, mesh[i]);
    }
    expect(maxOx - minOx).toBeGreaterThan(0.01); // the body lags behind the held point
  });

  it("reports no deformation mesh while at rest", () => {
    const engine = makeEngine(560);
    engine.tick(0.016, 1000);
    expect(engine.getRender().mesh).toBeNull();
  });

  it("hangs by two paws when released just below a window title edge", () => {
    const engine = makeEngine(560);
    engine.setWorld({
      platforms: buildPlatforms([{ hwnd: 9, left: 100, top: 200, right: 600, bottom: 500, isLarge: true }], [monitor], origin),
      bounds,
      monitors: [monitor],
      origin,
      scale: 1,
    });
    engine.grabStart();
    engine.grabMove(300, 202, 40); // feet anchor ends ~36 px below the ledge
    engine.grabEnd({ x: 0, y: 0 });
    expect(engine.state.currentAnimation).not.toBe("fall");
    engine.tick(0.03, 1000);
    expect(engine.state.currentAnimation).toBe("hangTwoPaws");
    expect(engine.state.isGrounded).toBe(false);
    expect(engine.state.y).toBeCloseTo(236.8, 0);
  });

  it("stays attached when its supporting window moves", () => {
    const engine = new CatEngine({
      sizePx: 40,
      scale: 1,
      activity: ACTIVITY_PROFILES.balanced,
      bounds,
      start: { x: 400, y: 299 },
      random: () => 0.5,
    });
    const first = buildPlatforms([{ hwnd: 12, left: 100, top: 300, right: 700, bottom: 550, isLarge: true }], [monitor], origin);
    engine.setWorld({ platforms: first, bounds, monitors: [monitor], origin, scale: 1 });
    engine.tick(0.03, 0);
    expect(engine.state.isGrounded).toBe(true);
    expect(engine.state.y).toBe(300);

    const moved = buildPlatforms([{ hwnd: 12, left: 150, top: 320, right: 750, bottom: 570, isLarge: true }], [monitor], origin);
    engine.setWorld({ platforms: moved, bounds, monitors: [monitor], origin, scale: 1 });
    expect(engine.state.x).toBe(450);
    expect(engine.state.y).toBe(320);
  });

  it("pauses autonomous motion when paused", () => {
    const engine = makeEngine(560);
    engine.setPaused(true);
    const x0 = engine.state.x;
    for (let i = 0; i < 100; i++) engine.tick(0.03, i * 30);
    expect(engine.state.x).toBe(x0);
  });
});
