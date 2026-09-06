import { describe, it, expect } from "vitest";
import { clampToBounds, type Bounds } from "../physics/collision";
import { computeVirtualBounds, computeOverlayOrigin } from "../native/monitorManager";
import type { NativeMonitor } from "../types/platform";
import type { CatState } from "../types/cat";

/**
 * The cat must never come to rest below the work area. The taskbar sits above
 * the overlay in z-order, so a cat resting on the raw screen edge is both
 * invisible and unclickable — every click lands on the taskbar instead. This
 * is exactly how the cat "disappeared" and stopped responding to drag and
 * right-click.
 */
const monitor: NativeMonitor = {
  left: 0, top: 0, right: 1920, bottom: 1080,
  workLeft: 0, workTop: 0, workRight: 1920, workBottom: 1032,
  scale: 1, isPrimary: true,
};

function state(y: number): CatState {
  return { x: 500, y, velocityX: 0, velocityY: 500, isGrounded: false } as CatState;
}

describe("taskbar floor", () => {
  const origin = computeOverlayOrigin([monitor]);
  const bounds = computeVirtualBounds([monitor], origin);

  it("ends a single-monitor overlay at the bottom work-area edge", () => {
    expect(bounds.bottom).toBe(1032);
    expect(bounds.floorY).toBe(1032);
  });

  it("stops the cat on top of the taskbar, never underneath it", () => {
    const s = state(1200); // fell way past the bottom
    clampToBounds(s, bounds, 32);
    expect(s.y).toBe(1032);
    expect(s.isGrounded).toBe(true);
    expect(s.velocityY).toBe(0);
  });

  it("lifts a restored position that was saved under the taskbar", () => {
    const s = state(1078); // e.g. persisted from an older buggy build
    clampToBounds(s, bounds, 32);
    expect(s.y).toBe(1032);
  });

  it("leaves a cat resting above the taskbar untouched", () => {
    const s = state(600);
    s.velocityY = 0;
    clampToBounds(s, bounds, 32);
    expect(s.y).toBe(600);
  });

  it("still assumes a taskbar strip when monitor info is unavailable", () => {
    const fallback: Bounds = computeVirtualBounds([], { left: 0, top: 0 });
    expect(fallback.floorY).toBeLessThan(fallback.bottom);
    const s = state(2000);
    clampToBounds(s, fallback, 32);
    expect(s.y).toBe(fallback.floorY);
  });
});
