import { describe, it, expect } from "vitest";
import { findLanding, findSupport, clampToBounds, rectContains, edgeProximity, catBounds } from "../physics/collision";
import type { Platform } from "../types/platform";
import type { CatState } from "../types/cat";

const floor: Platform = { id: "f", kind: "monitorFloor", left: 0, right: 800, top: 500 };

function state(over: Partial<CatState> = {}): CatState {
  return {
    x: 400,
    y: 400,
    velocityX: 0,
    velocityY: 0,
    facing: "right",
    mood: "calm",
    energy: 1,
    curiosity: 0,
    isGrounded: false,
    isDragging: false,
    currentAnimation: "fall",
    ...over,
  };
}

describe("collision", () => {
  it("finds a landing when feet cross a ledge top moving down", () => {
    const p = findLanding(495, 505, 400, 300, [floor]);
    expect(p).toBe(floor);
  });

  it("does not land when moving upward", () => {
    expect(findLanding(505, 495, 400, -300, [floor])).toBeNull();
  });

  it("does not land when horizontally off the ledge", () => {
    expect(findLanding(495, 505, 900, 300, [floor])).toBeNull();
  });

  it("prefers the highest valid ledge when several overlap", () => {
    const high: Platform = { id: "h", kind: "window", left: 0, right: 800, top: 480 };
    const p = findLanding(470, 520, 400, 300, [floor, high]);
    expect(p).toBe(high);
  });

  it("detects the supporting platform under the feet", () => {
    expect(findSupport(400, 500, [floor])).toBe(floor);
    expect(findSupport(400, 450, [floor])).toBeNull();
  });

  it("clamps the cat inside the horizontal bounds and to the floor of the desktop", () => {
    const s = state({ x: -50, y: 700, velocityX: -100 });
    clampToBounds(s, { left: 0, top: 0, right: 800, bottom: 600 }, 10);
    expect(s.x).toBe(10);
    expect(s.velocityX).toBe(0);
    expect(s.y).toBe(600);
    expect(s.isGrounded).toBe(true);
  });

  it("reports edge proximity on a ledge", () => {
    expect(edgeProximity(5, floor, 10)).toBe("left");
    expect(edgeProximity(795, floor, 10)).toBe("right");
    expect(edgeProximity(400, floor, 10)).toBeNull();
  });

  it("rectContains + catBounds hit-testing works around the cat", () => {
    const s = state({ x: 100, y: 100 });
    const b = catBounds(s, 40);
    expect(rectContains(b, 100, 90)).toBe(true);
    expect(rectContains(b, 300, 300)).toBe(false);
  });
});
