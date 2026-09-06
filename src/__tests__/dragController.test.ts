import { describe, it, expect } from "vitest";
import { DragController, DRAG_DISTANCE, DRAG_HOLD_MS } from "../interaction/dragController";

describe("DragController", () => {
  it("treats a quick press-release with no movement as a click", () => {
    const d = new DragController();
    d.onDown(100, 100, 0);
    const res = d.onUp(50); // released before hold threshold, no move
    expect(res.wasClick).toBe(true);
    expect(d.isDragging).toBe(false);
  });

  it("enters dragging after moving past the distance threshold", () => {
    const d = new DragController();
    d.onDown(100, 100, 0);
    const r = d.onMove(100 + DRAG_DISTANCE + 1, 100, 10);
    expect(r.startedDrag).toBe(true);
    expect(d.isDragging).toBe(true);
  });

  it("enters dragging after holding past the time threshold", () => {
    const d = new DragController();
    d.onDown(100, 100, 0);
    const r = d.onMove(101, 100, DRAG_HOLD_MS + 5);
    expect(r.startedDrag).toBe(true);
  });

  it("produces a release velocity from recent motion when dropped", () => {
    const d = new DragController();
    d.onDown(0, 0, 0);
    d.onMove(20, 0, 20);
    d.onMove(60, 0, 40); // moving right quickly
    const res = d.onUp(50);
    expect(res.wasClick).toBe(false);
    expect(res.releaseVelocity).not.toBeNull();
    expect(res.releaseVelocity!.x).toBeGreaterThan(0);
  });

  it("a drag is not reported as a click on release", () => {
    const d = new DragController();
    d.onDown(0, 0, 0);
    d.onMove(50, 50, 200);
    const res = d.onUp(210);
    expect(res.wasClick).toBe(false);
  });
});
