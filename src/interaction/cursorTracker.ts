import type { CursorSample } from "../types/cat";
import type { OverlayOrigin } from "../physics/platformResolver";

/**
 * Tracks the GLOBAL cursor by polling the Rust `get_cursor_position` command
 * (physical screen pixels), converting to overlay-local coordinates, and
 * deriving a smoothed speed + travel direction.
 *
 * Privacy: only the latest sample and a short-lived smoothed speed are kept.
 * No path/history is stored or persisted.
 */

export const IDLE_MS = 18_000; // user considered idle after this with no mouse or keyboard input
const MOVE_EPSILON = 2; // px of motion that counts as "the user moved"

export interface UserIdleState {
  idle: boolean;
  idleSeconds: number;
}

/**
 * Prefer Windows' combined mouse+keyboard idle duration when available. The
 * cursor-only duration remains a browser/test fallback.
 */
export function resolveUserIdle(nativeIdleMs: number | null, cursorIdleSeconds: number): UserIdleState {
  const idleSeconds =
    typeof nativeIdleMs === "number" && Number.isFinite(nativeIdleMs) && nativeIdleMs >= 0
      ? nativeIdleMs / 1000
      : Math.max(0, cursorIdleSeconds);
  return { idle: idleSeconds * 1000 > IDLE_MS, idleSeconds };
}

/** Pure: derive a new sample from the previous one and a raw local position. */
export function computeSample(
  prev: CursorSample | null,
  x: number,
  y: number,
  now: number,
): CursorSample {
  const dtMs = prev ? Math.max(1, now - prev.timestamp) : 16;
  const dt = dtMs / 1000;
  const dx = prev ? x - prev.x : 0;
  const dy = prev ? y - prev.y : 0;
  const len = Math.hypot(dx, dy);
  const instSpeed = len / dt;
  const speed = prev ? prev.speed + (instSpeed - prev.speed) * 0.35 : instSpeed;
  const dirX = len > 0.5 ? dx / len : 0;
  const dirY = len > 0.5 ? dy / len : 0;
  return { x, y, speed, dirX, dirY, timestamp: now };
}

export class CursorTracker {
  private sample: CursorSample | null = null;
  private origin: OverlayOrigin = { left: 0, top: 0 };
  private lastMoveTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  setOrigin(origin: OverlayOrigin): void {
    this.origin = origin;
  }

  getSample(): CursorSample | null {
    return this.sample;
  }

  isUserIdle(now: number): boolean {
    return now - this.lastMoveTime > IDLE_MS;
  }

  /** Cursor-only fallback used when native combined input timing is unavailable. */
  idleSeconds(now: number): number {
    return Math.max(0, (now - this.lastMoveTime) / 1000);
  }

  /** Feed a raw GLOBAL physical position (mainly for tests / manual updates). */
  ingestGlobal(gx: number, gy: number, now: number): CursorSample {
    const x = gx - this.origin.left;
    const y = gy - this.origin.top;
    const next = computeSample(this.sample, x, y, now);
    const moved = this.sample ? Math.hypot(next.x - this.sample.x, next.y - this.sample.y) : 0;
    if (moved > MOVE_EPSILON || !this.sample) this.lastMoveTime = now;
    this.sample = next;
    return next;
  }

  /** Start polling the native cursor at ~30 Hz. Safe no-op outside Tauri. */
  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastMoveTime = performance.now();
    let invoke: (<T>(cmd: string) => Promise<T>) | null = null;
    try {
      ({ invoke } = await import("@tauri-apps/api/core"));
    } catch {
      this.polling = false;
      return;
    }
    this.timer = setInterval(async () => {
      try {
        const pos = await invoke!<{ x: number; y: number }>("get_cursor_position");
        this.ingestGlobal(pos.x, pos.y, performance.now());
      } catch {
        /* transient failures are ignored; next tick retries */
      }
    }, 33);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.polling = false;
  }
}
