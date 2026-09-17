import { describe, it, expect } from "vitest";
import { BUTTERFLY_PATHS, ButterflyVisit, nextVisitMs, pickPath, type ButterflyCat } from "../emotion/butterfly";
import type { EmotionRequest } from "../emotion/emotionEngine";
import type { GestureId } from "../emotion/gestures";

function fakeCat() {
  const felt: EmotionRequest[] = [];
  const gestures: GestureId[] = [];
  const attention: ({ x: number; y: number } | null)[] = [];
  const api: ButterflyCat = {
    feel: (r) => (felt.push(r), true),
    gesture: (g) => void gestures.push(g),
    setAttention: (p) => void attention.push(p),
  };
  return { api, felt, gestures, attention };
}

const CAT = { x: 500, y: 600, sizePx: 88 };
const last = <T,>(a: T[]): T | undefined => a[a.length - 1];

function fly(path: (typeof BUTTERFLY_PATHS)[number]) {
  const f = fakeCat();
  const v = new ButterflyVisit(path, CAT, 0.3);
  const frames: { x: number; y: number }[] = [];
  let steps = 0;
  while (v.update(1 / 60, CAT, f.api) && steps++ < 60 * 30) frames.push({ x: v.frame!.x, y: v.frame!.y });
  return { ...f, frames, v };
}

describe("butterfly visit", () => {
  it("every path flies, is noticed, and ends with the cat's attention released", () => {
    for (const path of BUTTERFLY_PATHS) {
      const { felt, attention, frames, v } = fly(path);
      expect(v.finished, path).toBe(true);
      expect(v.frame, `${path} leaves nothing drawn`).toBeNull();
      expect(frames.length, path).toBeGreaterThan(60 * 5);
      // Freeze first (surprise), then curiosity.
      expect(felt[0]?.emotion, path).toBe("surprised");
      expect(felt.some((r) => r.emotion === "curious"), path).toBe(true);
      expect(last(attention), path).toBeNull();
    }
  });

  it("flies smoothly: no teleporting between frames", () => {
    for (const path of BUTTERFLY_PATHS) {
      const { frames } = fly(path);
      for (let i = 1; i < frames.length; i++) {
        const step = Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
        expect(step, `${path} frame ${i}`).toBeLessThan(CAT.sizePx * 0.25);
      }
    }
  });

  it("close to the face: a paw reaches, then disappointment when it gets away", () => {
    const { gestures, felt } = fly("closeToFace");
    expect(gestures.length).toBe(1);
    expect(["reachLeft", "reachRight"]).toContain(gestures[0]);
    expect(felt.some((r) => r.emotion === "curious" && r.intensity >= 0.9)).toBe(true);
    expect(last(felt)?.emotion).toBe("confused");
  });

  it("flying past without coming close ends quietly", () => {
    const { gestures, felt } = fly("above");
    expect(gestures).toEqual([]);
    expect(felt.some((r) => r.emotion === "confused")).toBe(false);
  });

  it("cancel (drag, Photo Mode, full screen) stops at once and lets go", () => {
    const f = fakeCat();
    const v = new ButterflyVisit("leftToRight", CAT, 0.1);
    for (let i = 0; i < 120; i++) v.update(1 / 60, CAT, f.api);
    v.cancel(f.api);
    expect(v.finished).toBe(true);
    expect(v.frame).toBeNull();
    expect(last(f.attention)).toBeNull();
    expect(v.update(1 / 60, CAT, f.api)).toBe(false);
  });

  it("visits are 20-45 minutes apart and the face path is the rare one", () => {
    expect(nextVisitMs(0, () => 0)).toBe(20 * 60_000);
    expect(nextVisitMs(0, () => 1)).toBe(45 * 60_000);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const p = pickPath(() => i / 1000);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const p of BUTTERFLY_PATHS) expect(counts.get(p) ?? 0, p).toBeGreaterThan(0);
    expect(counts.get("closeToFace")!).toBeLessThan(200);
  });
});
