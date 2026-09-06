import { describe, it, expect } from "vitest";
import { CatEngine } from "../engine/catEngine";
import { buildPlatforms } from "../physics/platformResolver";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";
import { PHOTO_POSES } from "../photo/photoMode";
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

function grounded() {
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
  // Settle onto the floor before any photo business begins.
  for (let i = 0; i < 120; i++) engine.tick(1 / 60, i * 16.7);
  return engine;
}

function run(engine: CatEngine, seconds: number, from = 5000) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) engine.tick(1 / 60, from + i * 16.7);
}

describe("Photo Mode holds the cat still", () => {
  it("parks the cat in the chosen pose instead of wandering", () => {
    const engine = grounded();
    engine.setPhotoPose("wave");
    run(engine, 3);
    expect(engine.state.currentAnimation).toBe("wave");
  });

  it("keeps holding a one-shot pose rather than drifting back to idle", () => {
    const engine = grounded();
    // `wave` is a finite animation; a naive hold would play it once and fall
    // through to whatever it chains into, ruining the shot mid-compose.
    engine.setPhotoPose("wave");
    run(engine, 20);
    expect(engine.state.currentAnimation).toBe("wave");
  });

  it("does not move, however long the panel stays open", () => {
    const engine = grounded();
    engine.setPhotoPose("sit");
    const at = { x: engine.state.x, y: engine.state.y };
    run(engine, 30);
    expect(engine.state.x).toBe(at.x);
    expect(engine.state.y).toBe(at.y);
  });

  it("every offered pose actually holds", () => {
    for (const pose of PHOTO_POSES) {
      const engine = grounded();
      engine.setPhotoPose(pose.anim);
      run(engine, 4);
      expect(engine.state.currentAnimation, pose.label).toBe(pose.anim);
    }
  });

  it("hands the cat straight back when Photo Mode closes", () => {
    const engine = grounded();
    engine.setPhotoPose("sleep");
    run(engine, 3);
    expect(engine.state.currentAnimation).toBe("sleep");

    engine.setPhotoPose(null);
    run(engine, 3, 60000);
    // Back under its own control: it is no longer pinned to the photo pose.
    expect(engine.state.currentAnimation).not.toBe("sleep");
  });

  it("a cursor moving past does not drag the cat out of frame", () => {
    const engine = grounded();
    engine.setCursorChasing(true);
    engine.setPhotoPose("sit");
    const at = { x: engine.state.x, y: engine.state.y };
    for (let i = 0; i < 600; i++) {
      engine.setCursor({ x: 100 + i, y: 300, speed: 400, dirX: 1, dirY: 0, timestamp: i * 16.7 });
      engine.tick(1 / 60, 5000 + i * 16.7);
    }
    expect(engine.state.x).toBe(at.x);
    expect(engine.state.y).toBe(at.y);
  });
});

describe("Photo Mode expressions", () => {
  it("overrides the eyes and mouth of whatever pose is held", () => {
    const engine = grounded();
    engine.setPhotoPose("sit");
    engine.setPhotoExpression({ eyes: "happy", mouth: "smile" });
    run(engine, 1);
    expect(engine.getRender().pose.eyes).toBe("happy");
    expect(engine.getRender().pose.mouth).toBe("smile");
  });

  it("a null field leaves the pose's own expression alone", () => {
    const engine = grounded();
    engine.setPhotoPose("sleep");
    run(engine, 1);
    const own = engine.getRender().pose.eyes;
    engine.setPhotoExpression({ eyes: null, mouth: "smile" });
    run(engine, 1);
    expect(engine.getRender().pose.eyes).toBe(own);
    expect(engine.getRender().pose.mouth).toBe("smile");
  });

  it("clearing the override restores the pose's own face", () => {
    const engine = grounded();
    engine.setPhotoPose("sit");
    run(engine, 1);
    const own = engine.getRender().pose.eyes;
    engine.setPhotoExpression({ eyes: "panic", mouth: null });
    run(engine, 1);
    expect(engine.getRender().pose.eyes).toBe("panic");
    engine.setPhotoExpression(null);
    run(engine, 1);
    expect(engine.getRender().pose.eyes).toBe(own);
  });

  it("does not corrupt the controller's own pose object", () => {
    // The override is applied to a copy. Writing into the reused pose the
    // animation controller hands out would poison every later frame, including
    // after Photo Mode closes.
    const engine = grounded();
    engine.setPhotoPose("sit");
    engine.setPhotoExpression({ eyes: "panic", mouth: "teeth" });
    run(engine, 1);
    expect(engine.getRender().pose.eyes).toBe("panic");

    engine.setPhotoPose(null);
    engine.setPhotoExpression(null);
    run(engine, 2, 60000);
    expect(engine.getRender().pose.eyes).not.toBe("panic");
    expect(engine.getRender().pose.mouth).not.toBe("teeth");
  });
});
