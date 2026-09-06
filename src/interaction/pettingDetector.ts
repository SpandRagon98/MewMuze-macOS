import type { CursorSample } from "../types/cat";

/**
 * Detects "petting": gentle back-and-forth cursor motion over the cat.
 *
 * Criteria (all must hold):
 *  - the cursor is over the cat's bounds,
 *  - no drag is in progress,
 *  - speed is in a low-to-medium band (not a fast flick, not perfectly still),
 *  - the horizontal direction has reversed at least `MIN_REVERSALS` times within
 *    `WINDOW_MS`.
 *
 * A plain hover (no reversals) never triggers petting — it only makes the cat
 * look at the cursor, which is handled by the behaviour layer.
 */
const WINDOW_MS = 1100;
const MIN_REVERSALS = 2;
const MIN_SPEED = 8; // px/s — must actually be moving
const MAX_SPEED = 260; // px/s — faster than this reads as a flick, not a pet
const RELEASE_MS = 550; // petting is considered ended after this with no reversals

export class PettingDetector {
  private reversalTimes: number[] = [];
  private lastDirX = 0;
  private petting = false;
  private lastReversalAt = 0;

  reset(): void {
    this.reversalTimes = [];
    this.lastDirX = 0;
    this.petting = false;
    this.lastReversalAt = 0;
  }

  get isPetting(): boolean {
    return this.petting;
  }

  /** 0..1 intensity from how many recent reversals occurred. */
  get intensity(): number {
    return Math.min(1, this.reversalTimes.length / 4);
  }

  /**
   * Feed the latest cursor sample and context. Returns whether petting is
   * currently active.
   */
  update(sample: CursorSample, overCat: boolean, isDragging: boolean, now: number): boolean {
    if (!overCat || isDragging) {
      this.reset();
      return false;
    }

    const speedOk = sample.speed >= MIN_SPEED && sample.speed <= MAX_SPEED;
    const dir = Math.sign(sample.dirX);

    if (speedOk && dir !== 0 && this.lastDirX !== 0 && dir !== this.lastDirX) {
      this.reversalTimes.push(now);
      this.lastReversalAt = now;
    }
    if (dir !== 0) this.lastDirX = dir;

    // Drop reversals older than the detection window.
    const cutoff = now - WINDOW_MS;
    this.reversalTimes = this.reversalTimes.filter((t) => t >= cutoff);

    if (this.reversalTimes.length >= MIN_REVERSALS) {
      this.petting = true;
    } else if (now - this.lastReversalAt > RELEASE_MS) {
      this.petting = false;
    }
    return this.petting;
  }
}
