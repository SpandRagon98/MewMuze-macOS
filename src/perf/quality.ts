/**
 * Adaptive render quality.
 *
 * The expensive part of a frame is rasterising a new sprite (~3.4ms at 128px),
 * and the pose space is far too large to cache: the tail phase, pupil offsets,
 * head lean and tween position multiply into millions of combinations, so a
 * smoothly-animating cat misses the cache most frames. On a fast machine that
 * is affordable; on a slow one it is not.
 *
 * Rather than pick one compromise for everybody, measure the real frame budget
 * and scale the quality knobs that drive the miss rate. A capable laptop keeps
 * full smoothness; a weak one sheds tween steps and tail resolution instead of
 * dropping frames.
 *
 * Pure and dependency-free so it can be unit-tested without a canvas.
 */

export type QualityLevel = "high" | "medium" | "low";

/** Coarseness applied to the tail phase; higher = fewer distinct sprites. */
export const TAIL_STRIDE: Record<QualityLevel, number> = {
  high: 1,
  medium: 2,
  low: 4,
};

/** Whether poses are tweened between keyframes at this level. */
export const TWEEN_ENABLED: Record<QualityLevel, boolean> = {
  high: true,
  medium: true,
  low: false,
};

/**
 * Cursor-tracking coarseness. Measured: with the pointer moving, pupil and head
 * offsets dominate the distinct-sprite count (5x5 pupil positions times 5x5
 * head leans = 625 combinations) — far more than the tail or tween steps. Any
 * quality level that does not coarsen these barely helps at all.
 */
export const PUPIL_STRIDE: Record<QualityLevel, number> = {
  high: 1,
  medium: 2,
  low: 2,
};

/** Clamp on head lean, in quantised steps either side of centre. */
export const HEAD_RANGE: Record<QualityLevel, number> = {
  high: 2,
  medium: 1,
  low: 1,
};

/**
 * Sprite-cache cap per level. Chromium commonly allocates a GPU surface much
 * larger than the raw 128×128 RGBA pixels for each tiny canvas, so measuring
 * only `width × height × 4` badly understated the real WebView working set.
 * These caps still cover several complete animation cycles without allowing
 * cursor/tail combinations to retain hundreds of megabytes.
 */
export const CACHE_LIMIT: Record<QualityLevel, number> = {
  high: 192,
  medium: 128,
  low: 96,
};

let current: QualityLevel = "high";

export function qualityLevel(): QualityLevel {
  return current;
}

/** Set directly (used by tests and by the monitor). */
export function setQualityLevel(level: QualityLevel): void {
  current = level;
}

const ORDER: QualityLevel[] = ["low", "medium", "high"];

/**
 * Watches frame times and picks a level.
 *
 * Deliberately slow to react and hysteretic: quality that flickers up and down
 * is more distracting than quality that is simply lower, and a single stalled
 * frame (a GC pause, the machine waking) must never trigger a downgrade.
 */
export class FrameBudget {
  private samples: number[] = [];
  private level: QualityLevel = "high";
  private holdUntil = 0;

  constructor(
    /** Frame time above which the level steps down. 60fps = 16.7ms. */
    private readonly slowMs = 24,
    /** Frame time below which it may step back up. */
    private readonly fastMs = 13,
    /** Frames averaged before any decision. */
    private readonly window = 90,
    /** Minimum ms between changes, so it cannot oscillate. */
    private readonly holdMs = 4000,
  ) {}

  get quality(): QualityLevel {
    return this.level;
  }

  /** Feed one frame's duration. Returns the level to use now. */
  sample(frameMs: number, now: number): QualityLevel {
    // Ignore absurd frames: a lock/resume stall says nothing about the GPU.
    if (frameMs > 0 && frameMs < 500) this.samples.push(frameMs);
    if (this.samples.length < this.window) return this.level;

    const sorted = [...this.samples].sort((a, b) => a - b);
    // Median, not mean: one 200ms hitch should not condemn the machine.
    const median = sorted[sorted.length >> 1];
    this.samples.length = 0;

    if (now < this.holdUntil) return this.level;

    const i = ORDER.indexOf(this.level);
    if (median > this.slowMs && i > 0) {
      this.level = ORDER[i - 1];
      this.holdUntil = now + this.holdMs;
    } else if (median < this.fastMs && i < ORDER.length - 1) {
      this.level = ORDER[i + 1];
      this.holdUntil = now + this.holdMs;
    }
    return this.level;
  }
}
