import { describe, it, expect } from "vitest";
import {
  buildPlatforms,
  nearestPlatformBelow,
  findDropTarget,
  findJumpTarget,
  monitorAt,
  MIN_WINDOW_WIDTH,
} from "../physics/platformResolver";
import type { NativeMonitor, NativeWindowRect } from "../types/platform";

const monitor: NativeMonitor = {
  left: 0,
  top: 0,
  right: 1920,
  bottom: 1080,
  workLeft: 0,
  workTop: 0,
  workRight: 1920,
  workBottom: 1040,
  scale: 1,
  isPrimary: true,
};

function win(hwnd: number, left: number, top: number, right: number, bottom: number, isLarge = true): NativeWindowRect {
  return { hwnd, left, top, right, bottom, isLarge };
}

describe("platformResolver", () => {
  it("builds window ledges + monitor floors and skips tiny/flagged windows", () => {
    const wins = [
      win(1, 100, 200, 500, 700), // ok
      win(2, 0, 0, MIN_WINDOW_WIDTH - 10, 400), // too narrow
      win(3, 100, 100, 400, 400, false), // flagged not large
    ];
    const plats = buildPlatforms(wins, [monitor], { left: 0, top: 0 });
    const windowPlats = plats.filter((p) => p.kind === "window");
    expect(windowPlats).toHaveLength(1);
    expect(windowPlats[0].top).toBe(200);
    expect(plats.some((p) => p.kind === "monitorFloor" && p.top === 1040)).toBe(true);
  });

  it("converts to overlay-local coordinates using the origin", () => {
    const plats = buildPlatforms([win(1, 200, 300, 600, 800)], [], { left: 100, top: 50 });
    expect(plats[0].left).toBe(100);
    expect(plats[0].top).toBe(250);
  });

  it("finds the nearest platform below a point", () => {
    const plats = buildPlatforms(
      [win(1, 0, 300, 800, 600), win(2, 0, 500, 800, 700)],
      [],
      { left: 0, top: 0 },
    );
    const below = nearestPlatformBelow(400, 100, plats);
    expect(below?.top).toBe(300); // the higher of the two below
  });

  it("snaps drag releases onto or just below a window ledge", () => {
    const platforms = buildPlatforms([win(7, 100, 200, 600, 700)], [], { left: 0, top: 0 });
    expect(findDropTarget(300, 205, platforms, 40)?.mode).toBe("stand");
    expect(findDropTarget(300, 236, platforms, 40)?.mode).toBe("hang");
    expect(findDropTarget(104, 360, platforms, 40)).toMatchObject({ mode: "cling", side: "left" });
    expect(findDropTarget(300, 300, platforms, 40)).toBeNull();
  });

  it("finds a reachable jump target within reach and ignores the current ledge", () => {
    const plats = buildPlatforms(
      [win(1, 0, 400, 300, 600), win(2, 350, 380, 650, 600)],
      [],
      { left: 0, top: 0 },
    );
    const from = { x: 290, y: 400 };
    const target = findJumpTarget(from, "win-1", plats, 200, 200);
    expect(target?.platform.id).toBe("win-2");
  });

  it("selects the monitor containing a point", () => {
    const m2 = { ...monitor, left: 1920, right: 3840, isPrimary: false };
    const found = monitorAt(2000, 100, [monitor, m2], { left: 0, top: 0 });
    expect(found).toBe(m2);
  });
});
