import { describe, it, expect } from "vitest";
import { CatEngine } from "../engine/catEngine";
import { ACTIVITY_PROFILES, DEFAULT_SETTINGS } from "../settings/defaultSettings";

// Regression: peekAuto defaults on and flips true for ANY fullscreen window,
// so a real user hit this — the cat walked to a screen corner instead of
// holding its static work pose because tickGrounded checked peek before the
// loop override. loopOverride must win.

const bounds = { left: 0, top: 0, right: 1920, bottom: 1080, floorY: 1032 };
// findSupport only recognises platform objects, not bounds.floorY on its own —
// without one, isGrounded flips false every tick (no support found) and the
// cat re-lands (force-resetting its animation) forever instead of settling.
const floor = { id: "floor", kind: "monitorFloor" as const, left: 0, right: 1920, top: 1032 };

function makeEngine(startX = 900) {
  const e = new CatEngine({
    sizePx: 64,
    scale: 1,
    activity: ACTIVITY_PROFILES[DEFAULT_SETTINGS.activityLevel],
    bounds,
    start: { x: startX, y: 1032 },
    random: () => 0.5,
  });
  e.setWorld({ platforms: [floor], bounds, monitors: [], origin: { left: 0, top: 0 }, scale: 1 });
  return e;
}

function settle(e: CatEngine, seconds: number, now = 0) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) e.tick(dt, now + t * 1000);
}

describe("work mode outranks peek", () => {
  it("stays put when peek turns on while a loop override is active", () => {
    // Cat parked away from the peek corner, so any peek-driven walk is obvious.
    const e = makeEngine(900);
    e.setLoopOverride("quickTools");
    e.setPeek(true); // e.g. peekAuto + a fullscreen window elsewhere
    const before = e.state.x;
    settle(e, 3);
    expect(e.state.x).toBe(before);
    expect(e.getRender().pose.view).toBe("front");
  });

  it("resumes peeking once the loop override is released", () => {
    const e = makeEngine(900);
    e.setLoopOverride("quickTools");
    e.setPeek(true);
    settle(e, 1);
    const parked = e.state.x;

    e.setLoopOverride(null);
    settle(e, 3);
    // Now free to retreat toward the nearest corner.
    expect(e.state.x).not.toBe(parked);
  });

  it("peek alone (no override) still walks to a corner as before", () => {
    const e = makeEngine(900);
    e.setPeek(true);
    const before = e.state.x;
    settle(e, 3);
    expect(e.state.x).not.toBe(before);
  });
});
