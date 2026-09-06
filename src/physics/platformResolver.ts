import type { Point } from "../types/cat";
import type { NativeMonitor, NativeWindowRect, Platform } from "../types/platform";

/**
 * Turns raw native window / monitor rectangles into the walkable `Platform`
 * ledges the cat uses. Everything is converted from physical screen pixels into
 * overlay-local physical pixels via the overlay origin.
 *
 * Only the geometry (position + size) is used — never window titles/contents.
 */

export interface OverlayOrigin {
  /** Virtual-screen top-left in physical pixels. */
  left: number;
  top: number;
}

/** Minimum window width (px) to be considered a real, walkable window. */
export const MIN_WINDOW_WIDTH = 120;
export const MIN_WINDOW_HEIGHT = 80;

export function buildPlatforms(
  windows: NativeWindowRect[],
  monitors: NativeMonitor[],
  origin: OverlayOrigin,
): Platform[] {
  const platforms: Platform[] = [];

  for (const w of windows) {
    if (!w.isLarge) continue;
    const width = w.right - w.left;
    const height = w.bottom - w.top;
    if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) continue;
    platforms.push({
      id: `win-${w.hwnd}`,
      kind: "window",
      left: w.left - origin.left,
      right: w.right - origin.left,
      top: w.top - origin.top,
      bottom: w.bottom - origin.top,
    });
  }

  // Each monitor's work-area bottom is the "floor" the cat can always stand on.
  for (const m of monitors) {
    platforms.push({
      id: `floor-${m.left}-${m.top}`,
      kind: "monitorFloor",
      left: m.workLeft - origin.left,
      right: m.workRight - origin.left,
      top: m.workBottom - origin.top,
    });
  }

  return platforms;
}

/** Nearest platform strictly below a point whose span contains x. */
export function nearestPlatformBelow(x: number, y: number, platforms: Platform[]): Platform | null {
  let best: Platform | null = null;
  for (const p of platforms) {
    if (x < p.left || x > p.right) continue;
    if (p.top < y - 1) continue; // must be below
    if (!best || p.top < best.top) best = p;
  }
  return best;
}

export interface DropTarget {
  platform: Platform;
  mode: "stand" | "hang" | "cling";
  side?: "left" | "right";
}

/**
 * Resolve an intentional drag release near a ledge. Feet close to the top snap
 * onto it; a release just below a window top becomes a two-paw hang. Releases
 * elsewhere stay airborne and are handled by normal gravity/landing physics.
 */
export function findDropTarget(
  x: number,
  feetY: number,
  platforms: Platform[],
  catSize: number,
): DropTarget | null {
  let best: { target: DropTarget; score: number } | null = null;
  for (const platform of platforms) {
    const nearHorizontalSpan = x >= platform.left - catSize * 0.12 && x <= platform.right + catSize * 0.12;
    const delta = feetY - platform.top;
    let mode: DropTarget["mode"] | null = null;
    let score = Infinity;
    let side: DropTarget["side"];
    if (nearHorizontalSpan && Math.abs(delta) <= catSize * 0.3) {
      mode = "stand";
      score = Math.abs(delta);
    } else if (nearHorizontalSpan && platform.kind === "window" && delta > catSize * 0.3 && delta <= catSize * 1.2) {
      mode = "hang";
      score = Math.abs(delta - catSize * 0.9) + catSize * 0.08;
    } else if (platform.kind === "window" && platform.bottom !== undefined && feetY > platform.top + catSize * 0.65 && feetY < platform.bottom) {
      const leftDistance = Math.abs(x - platform.left);
      const rightDistance = Math.abs(x - platform.right);
      if (Math.min(leftDistance, rightDistance) <= catSize * 0.3) {
        mode = "cling";
        side = leftDistance <= rightDistance ? "left" : "right";
        score = Math.min(leftDistance, rightDistance) + catSize * 0.12;
      }
    }
    if (mode && (!best || score < best.score)) best = { target: { platform, mode, side }, score };
  }
  return best?.target ?? null;
}

export interface JumpCandidate {
  platform: Platform;
  /** Target x on that platform the cat would aim for. */
  targetX: number;
  dx: number;
  dy: number;
}

/**
 * Find a reasonable neighbouring ledge to hop to from `from`, within horizontal
 * `maxDx` and vertical `maxDy` reach. Prefers the closest that isn't the ledge
 * the cat is already on. Used for the "jump between nearby windows" behaviour.
 */
export function findJumpTarget(
  from: Point,
  currentPlatformId: string | null,
  platforms: Platform[],
  maxDx: number,
  maxDy: number,
): JumpCandidate | null {
  let best: JumpCandidate | null = null;
  for (const p of platforms) {
    if (p.id === currentPlatformId) continue;
    // Aim for the nearest x on the target span.
    const targetX = Math.max(p.left + 4, Math.min(from.x, p.right - 4));
    const dx = targetX - from.x;
    const dy = p.top - from.y;
    if (Math.abs(dx) > maxDx) continue;
    if (dy > maxDy || dy < -maxDy) continue;
    const dist = Math.abs(dx) + Math.abs(dy) * 1.4;
    if (!best || dist < Math.abs(best.dx) + Math.abs(best.dy) * 1.4) {
      best = { platform: p, targetX, dx, dy };
    }
  }
  return best;
}

/** Whichever monitor contains the point, else the primary, else the first. */
export function monitorAt(x: number, y: number, monitors: NativeMonitor[], origin: OverlayOrigin): NativeMonitor | null {
  if (monitors.length === 0) return null;
  const gx = x + origin.left;
  const gy = y + origin.top;
  for (const m of monitors) {
    if (gx >= m.left && gx < m.right && gy >= m.top && gy < m.bottom) return m;
  }
  return monitors.find((m) => m.isPrimary) ?? monitors[0];
}
