import type { Point } from "../types/cat";

/**
 * Distinguishes a click from a drag and produces drop physics.
 *
 * A press becomes a drag once the pointer moves past `DRAG_DISTANCE` or is held
 * longer than `DRAG_HOLD_MS`. A press released before either threshold is a
 * click (used for petting/poke reactions). On release mid-air the recent
 * pointer motion becomes a small toss velocity.
 */
export const DRAG_DISTANCE = 6; // px
export const DRAG_HOLD_MS = 160; // ms

export type DragPhase = "none" | "pressed" | "dragging";

export interface DragResult {
  phase: DragPhase;
  /** True on the transition into dragging. */
  startedDrag: boolean;
  /** Set on release: whether it was a plain click (no drag happened). */
  wasClick: boolean;
  /** Toss velocity (px/s) on release, from recent pointer motion. */
  releaseVelocity: Point | null;
}

interface MoveRecord {
  x: number;
  y: number;
  t: number;
}

export class DragController {
  private phase: DragPhase = "none";
  private downAt: Point = { x: 0, y: 0 };
  private downTime = 0;
  private recent: MoveRecord[] = [];

  get current(): DragPhase {
    return this.phase;
  }

  get isDragging(): boolean {
    return this.phase === "dragging";
  }

  onDown(x: number, y: number, now: number): void {
    this.phase = "pressed";
    this.downAt = { x, y };
    this.downTime = now;
    this.recent = [{ x, y, t: now }];
  }

  onMove(x: number, y: number, now: number): DragResult {
    if (this.phase === "none") {
      return { phase: "none", startedDrag: false, wasClick: false, releaseVelocity: null };
    }
    this.recent.push({ x, y, t: now });
    // Keep only ~120ms of history for the toss estimate.
    const cutoff = now - 120;
    while (this.recent.length > 2 && this.recent[0].t < cutoff) this.recent.shift();

    let startedDrag = false;
    if (this.phase === "pressed") {
      const moved = Math.hypot(x - this.downAt.x, y - this.downAt.y);
      const held = now - this.downTime;
      if (moved >= DRAG_DISTANCE || held >= DRAG_HOLD_MS) {
        this.phase = "dragging";
        startedDrag = true;
      }
    }
    return { phase: this.phase, startedDrag, wasClick: false, releaseVelocity: null };
  }

  onUp(now: number): DragResult {
    const wasClick = this.phase === "pressed";
    let releaseVelocity: Point | null = null;
    if (this.phase === "dragging") {
      releaseVelocity = this.estimateVelocity(now);
    }
    this.phase = "none";
    this.recent = [];
    return { phase: "none", startedDrag: false, wasClick, releaseVelocity };
  }

  cancel(): void {
    this.phase = "none";
    this.recent = [];
  }

  private estimateVelocity(now: number): Point {
    if (this.recent.length < 2) return { x: 0, y: 0 };
    const first = this.recent[0];
    const last = this.recent[this.recent.length - 1];
    const dt = Math.max(0.016, (last.t - first.t) / 1000);
    // Dampen so drops feel gentle, and cap the throw.
    const cap = 700;
    const vx = clamp((last.x - first.x) / dt * 0.6, -cap, cap);
    const vy = clamp((last.y - first.y) / dt * 0.6, -cap, cap);
    void now;
    return { x: vx, y: vy };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
