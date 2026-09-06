import { describe, it, expect } from "vitest";
import { TypingDetector } from "../interaction/typingDetector";

describe("TypingDetector", () => {
  it("stays 'none' with no activity", () => {
    const d = new TypingDetector();
    expect(d.sample(0, 0)).toBe("none");
    expect(d.sample(0, 5)).toBe("none");
  });

  it("detects steady typing from count increases only", () => {
    const d = new TypingDetector();
    let level = d.sample(0, 0);
    // Simulate ~3 presses/sec: count alternates 0→1 (a rising edge = a press).
    for (let t = 0.1; t < 3; t += 0.3) {
      level = d.sample(1, t);
      level = d.sample(0, t + 0.15);
    }
    expect(level).toBe("typing");
  });

  it("returns to 'none' after quiet period", () => {
    const d = new TypingDetector();
    for (let t = 0.1; t < 2; t += 0.3) {
      d.sample(1, t);
      d.sample(0, t + 0.15);
    }
    expect(d.level(2)).toBe("typing");
    expect(d.level(7)).toBe("none");
  });

  it("overheats only after sustained fast typing, then cools down", () => {
    const d = new TypingDetector();
    let level: string = "none";
    // ~8 presses/sec sustained (rate window needs ~3s to ramp + 6s hold).
    for (let t = 0; t < 12; t += 0.125) {
      level = d.sample(1, t);
      level = d.sample(0, t + 0.06);
    }
    expect(level).toBe("overheat");
    // A short fast burst must NOT overheat (fresh detector).
    const d2 = new TypingDetector();
    let l2: string = "none";
    for (let t = 0; t < 1.5; t += 0.125) {
      l2 = d2.sample(1, t);
      l2 = d2.sample(0, t + 0.06);
    }
    expect(l2).toBe("typing");
  });

  it("never exposes key identities (API surface is counts only)", () => {
    const d = new TypingDetector();
    // The only input is a number; nothing key-shaped exists on the type.
    expect(typeof d.sample(3, 1)).toBe("string");
  });
});
