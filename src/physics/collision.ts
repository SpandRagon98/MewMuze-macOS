import type { CatState, Rect } from "../types/cat";
import type { Platform } from "../types/platform";

/**
 * Collision / landing helpers. All pure functions over overlay-local physical
 * pixels. The cat's (x, y) is its feet anchor (centre-bottom).
 */

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /**
   * Lowest line the cat may rest on: the monitor WORK-AREA bottom, i.e. the top
   * of the taskbar. `bottom` is the raw screen edge, and anything resting there
   * is drawn underneath the taskbar — which sits above the overlay in z-order,
   * so the cat becomes invisible AND unclickable (every click hits the taskbar).
   * Falls back to `bottom` when the work area is unknown.
   */
  floorY?: number;
}

export function rectContains(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}

/** The axis-aligned interactive box around the cat, given its size in px. */
export function catBounds(state: CatState, sizePx: number): Rect {
  // Sprite is centred on x, feet at y. Add a little padding for easy grabbing.
  const pad = Math.round(sizePx * 0.12);
  return {
    x: Math.round(state.x - sizePx / 2 - pad),
    y: Math.round(state.y - sizePx - pad),
    width: sizePx + pad * 2,
    height: sizePx + pad * 2,
  };
}

const LAND_TOLERANCE = 6; // px of forgiveness when snapping onto a ledge
const EDGE_MARGIN = 2;

/**
 * Given downward motion from `prevFeetY` to `feetY` at horizontal `x`, return
 * the platform the cat lands on this step (if any). Only platforms whose span
 * contains `x` and whose top the feet crossed (top-down) qualify.
 */
export function findLanding(
  prevFeetY: number,
  feetY: number,
  x: number,
  vy: number,
  platforms: Platform[],
): Platform | null {
  if (vy < 0) return null; // moving up — can't land
  let best: Platform | null = null;
  for (const p of platforms) {
    if (x < p.left - EDGE_MARGIN || x > p.right + EDGE_MARGIN) continue;
    // Feet were at/above the ledge and are now at/below it (within tolerance).
    if (prevFeetY <= p.top + LAND_TOLERANCE && feetY >= p.top - LAND_TOLERANCE) {
      if (!best || p.top < best.top) best = p; // prefer the highest valid ledge
    }
  }
  return best;
}

/**
 * The platform currently supporting the cat's feet (within tolerance), used to
 * detect when the ground has vanished (window moved/closed) so the cat falls.
 */
export function findSupport(x: number, feetY: number, platforms: Platform[]): Platform | null {
  for (const p of platforms) {
    if (x < p.left - EDGE_MARGIN || x > p.right + EDGE_MARGIN) continue;
    if (Math.abs(feetY - p.top) <= LAND_TOLERANCE + 2) return p;
  }
  return null;
}

/** Clamp the cat horizontally inside the virtual-screen bounds. */
export function clampToBounds(state: CatState, bounds: Bounds, halfWidth: number): void {
  if (state.x - halfWidth < bounds.left) {
    state.x = bounds.left + halfWidth;
    if (state.velocityX < 0) state.velocityX = 0;
  }
  if (state.x + halfWidth > bounds.right) {
    state.x = bounds.right - halfWidth;
    if (state.velocityX > 0) state.velocityX = 0;
  }
  // Never let the cat sink below the usable desktop. This must be the work-area
  // floor, not the screen edge, or the cat ends up behind the taskbar where it
  // cannot be seen, grabbed or right-clicked.
  const floor = bounds.floorY ?? bounds.bottom;
  if (state.y > floor) {
    state.y = floor;
    state.velocityY = 0;
    state.isGrounded = true;
  }
}

/** How close the feet are to the left/right end of their supporting ledge. */
export function edgeProximity(x: number, platform: Platform, threshold: number): "left" | "right" | null {
  if (x - platform.left <= threshold) return "left";
  if (platform.right - x <= threshold) return "right";
  return null;
}
