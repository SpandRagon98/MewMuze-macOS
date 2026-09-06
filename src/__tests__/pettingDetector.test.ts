import { describe, it, expect } from "vitest";
import { PettingDetector } from "../interaction/pettingDetector";
import type { CursorSample } from "../types/cat";

function sample(dirX: number, speed: number, t: number): CursorSample {
  return { x: 0, y: 0, speed, dirX, dirY: 0, timestamp: t };
}

describe("PettingDetector", () => {
  it("detects back-and-forth gentle motion over the cat", () => {
    const d = new PettingDetector();
    let t = 0;
    const dirs = [1, -1, 1, -1];
    let petting = false;
    for (const dir of dirs) {
      t += 150;
      petting = d.update(sample(dir, 60, t), true, false, t);
    }
    expect(petting).toBe(true);
    expect(d.isPetting).toBe(true);
  });

  it("does not trigger on a plain hover (no direction reversals)", () => {
    const d = new PettingDetector();
    let petting = false;
    for (let i = 0; i < 6; i++) petting = d.update(sample(1, 40, i * 100), true, false, i * 100);
    expect(petting).toBe(false);
  });

  it("ignores fast flicks above the speed band", () => {
    const d = new PettingDetector();
    let petting = false;
    const dirs = [1, -1, 1, -1];
    let t = 0;
    for (const dir of dirs) {
      t += 120;
      petting = d.update(sample(dir, 999, t), true, false, t);
    }
    expect(petting).toBe(false);
  });

  it("resets when the cursor leaves the cat or a drag starts", () => {
    const d = new PettingDetector();
    let t = 0;
    for (const dir of [1, -1, 1, -1]) {
      t += 120;
      d.update(sample(dir, 60, t), true, false, t);
    }
    expect(d.isPetting).toBe(true);
    const res = d.update(sample(1, 60, t + 120), false, false, t + 120);
    expect(res).toBe(false);
    expect(d.isPetting).toBe(false);
  });
});
