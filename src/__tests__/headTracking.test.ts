import { describe, it, expect } from "vitest";
import { CatEngine } from "../engine/catEngine";
import { ACTIVITY_PROFILES, DEFAULT_SETTINGS } from "../settings/defaultSettings";
import type { CursorSample } from "../types/cat";

const bounds = { left: 0, top: 0, right: 1920, bottom: 1080, floorY: 1032 };

function makeEngine() {
  const e = new CatEngine({
    sizePx: 64,
    scale: 1,
    activity: ACTIVITY_PROFILES[DEFAULT_SETTINGS.activityLevel],
    bounds,
    start: { x: 900, y: 1000 },
    random: () => 0.5,
  });
  e.setWorld({ platforms: [], bounds, monitors: [], origin: { left: 0, top: 0 }, scale: 1 });
  return e;
}

const cursorAt = (x: number, y: number): CursorSample => ({
  x, y, speed: 0, dirX: 0, dirY: 0, timestamp: 0,
});

function settle(e: CatEngine, seconds: number, now = 0) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.tick(dt, now + t * 1000);
}

describe("pupil and head cursor tracking", () => {
  it("leans the head toward the cursor", () => {
    const e = makeEngine();
    e.setCursor(cursorAt(1500, 980)); // well to the right
    settle(e, 2);
    expect(e.getRender().headTurnX).toBeGreaterThan(0);

    const left = makeEngine();
    left.setCursor(cursorAt(300, 980));
    settle(left, 2);
    expect(left.getRender().headTurnX).toBeLessThan(0);
  });

  it("still moves the head less than the pupils", () => {
    const e = makeEngine();
    e.setCursor(cursorAt(1600, 980));
    settle(e, 3);
    const r = e.getRender();
    // Both now range +-2, but the head target is 78% of the pupils', so the
    // eyes must never trail the head — that is what makes the gaze read as
    // "looked, then turned" rather than a single stiff swivel.
    expect(Math.abs(r.headTurnX)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.headTurnX)).toBeLessThanOrEqual(Math.abs(r.pupilX));
  });

  it("lags behind the pupils when the cursor jumps", () => {
    const e = makeEngine();
    e.setCursor(cursorAt(1600, 980));
    // Sampled across the whole approach rather than at one instant: both are
    // quantised, so at any single moment they can round to the same step even
    // while the underlying head genuinely trails. The property that matters is
    // that the head NEVER overtakes the eyes, and visibly trails at some point.
    const dt = 1 / 60;
    let sawLag = false;
    for (let t = 0; t < 0.6; t += dt) {
      e.tick(dt, t * 1000);
      const r = e.getRender();
      expect(Math.abs(r.headTurnX)).toBeLessThanOrEqual(Math.abs(r.pupilX));
      if (Math.abs(r.headTurnX) < Math.abs(r.pupilX)) sawLag = true;
    }
    expect(sawLag, "the head should visibly trail the eyes at some point").toBe(true);
  });

  it("returns gradually to neutral once the cursor goes away", () => {
    const e = makeEngine();
    e.setCursor(cursorAt(1600, 980));
    settle(e, 2);
    // Compared against whatever it settled at rather than a hard-coded step,
    // so tuning the lean range does not require editing this test.
    const settled = e.getRender().headTurnX;
    expect(Math.abs(settled)).toBeGreaterThan(0);
    e.setCursor(null);
    settle(e, 0.1, 5000);
    // Eased, not snapped: a moment later it is still leaning the same way
    // rather than having jumped straight back to neutral.
    const after = e.getRender().headTurnX;
    expect(Math.sign(after)).toBe(Math.sign(settled));
    expect(Math.abs(after)).toBeGreaterThan(0);
    settle(e, 3, 6000);
    expect(e.getRender().headTurnX).toBe(0);
  });

  // Regression: chasing used to be gated by passing setCursor(null), which
  // also blinded the cat — so eyes and head froze in work mode, during pomodoro
  // focus, and whenever cursor-chasing was simply switched off.
  it("keeps tracking the cursor while chasing is disabled", () => {
    const e = makeEngine();
    e.setCursorChasing(false);
    e.setCursor(cursorAt(1600, 980));
    settle(e, 2);
    const r = e.getRender();
    expect(Math.abs(r.pupilX)).toBeGreaterThan(0);
    expect(Math.abs(r.headTurnX)).toBeGreaterThan(0);
  });

  it("stays within safe limits however far away the cursor is", () => {
    const e = makeEngine();
    e.setCursor(cursorAt(99999, -99999));
    settle(e, 5);
    const r = e.getRender();
    // The clamp is what keeps the head on the neck, and keeps the sprite cache
    // to five buckets per axis instead of a continuous range.
    expect(Math.abs(r.headTurnX)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.headTurnY)).toBeLessThanOrEqual(2);
    expect(Number.isInteger(r.headTurnX)).toBe(true);
    expect(Number.isInteger(r.headTurnY)).toBe(true);
  });
});
