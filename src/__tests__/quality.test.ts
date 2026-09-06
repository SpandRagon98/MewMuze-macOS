import { describe, it, expect, afterEach } from "vitest";
import {
  FrameBudget,
  TAIL_STRIDE,
  TWEEN_ENABLED,
  qualityLevel,
  setQualityLevel,
} from "../perf/quality";

/** Feed `count` frames of `ms` each, advancing a clock. */
function feed(b: FrameBudget, ms: number, count: number, start = 0, stepMs = 16) {
  let now = start;
  let level = b.quality;
  for (let i = 0; i < count; i++) {
    now += stepMs;
    level = b.sample(ms, now);
  }
  return { level, now };
}

describe("adaptive quality", () => {
  afterEach(() => setQualityLevel("high"));

  it("starts at full quality", () => {
    expect(new FrameBudget().quality).toBe("high");
  });

  it("steps down when frames are consistently slow", () => {
    const b = new FrameBudget();
    const { level } = feed(b, 40, 200);
    expect(level).toBe("medium");
  });

  it("keeps stepping down while it stays slow, but only after the hold", () => {
    const b = new FrameBudget();
    let t = feed(b, 40, 200, 0);
    expect(t.level).toBe("medium");
    // Immediately after a change it must hold, however bad the frames are.
    t = feed(b, 40, 200, t.now, 1);
    expect(t.level).toBe("medium");
    // Past the hold window it may drop again.
    t = feed(b, 40, 200, t.now + 5000);
    expect(t.level).toBe("low");
  });

  it("never drops below the lowest level", () => {
    const b = new FrameBudget();
    let t = { level: b.quality, now: 0 };
    for (let i = 0; i < 6; i++) t = feed(b, 60, 200, t.now + 5000);
    expect(t.level).toBe("low");
  });

  it("recovers when the machine speeds up", () => {
    const b = new FrameBudget();
    let t = feed(b, 40, 200);
    expect(t.level).toBe("medium");
    t = feed(b, 8, 200, t.now + 5000);
    expect(t.level).toBe("high");
  });

  it("ignores a single stall so one hitch cannot downgrade quality", () => {
    const b = new FrameBudget();
    // 89 good frames and one enormous stall: the median stays fast.
    let now = 0;
    for (let i = 0; i < 89; i++) {
      now += 16;
      b.sample(9, now);
    }
    now += 16;
    const level = b.sample(4000, now);
    expect(level).toBe("high");
  });

  it("does not decide before it has enough samples", () => {
    const b = new FrameBudget();
    const { level } = feed(b, 90, 10);
    expect(level).toBe("high");
  });

  it("lowering quality reduces the distinct-sprite drivers", () => {
    // This is the whole point: fewer tail steps and no tweening means fewer
    // distinct poses per second, so fewer rasterises on a weak machine.
    expect(TAIL_STRIDE.low).toBeGreaterThan(TAIL_STRIDE.medium);
    expect(TAIL_STRIDE.medium).toBeGreaterThan(TAIL_STRIDE.high);
    expect(TWEEN_ENABLED.high).toBe(true);
    expect(TWEEN_ENABLED.low).toBe(false);
  });

  it("exposes the current level globally", () => {
    setQualityLevel("low");
    expect(qualityLevel()).toBe("low");
    setQualityLevel("high");
    expect(qualityLevel()).toBe("high");
  });
});
