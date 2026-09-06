import { describe, it, expect } from "vitest";
import { computeMood, decayAnnoyance, bumpAnnoyance, type MoodContext } from "../behaviour/moodSystem";

const base: MoodContext = {
  energy: 0.6,
  curiosity: 0.3,
  annoyance: 0,
  secondsSinceInteraction: 10,
  cursorNearby: false,
  userIdle: false,
};

describe("moodSystem", () => {
  it("becomes sleepy when energy is very low", () => {
    expect(computeMood({ ...base, energy: 0.05 }, "calm")).toBe("sleepy");
  });

  it("becomes annoyed when annoyance is high, overriding others", () => {
    expect(computeMood({ ...base, annoyance: 0.9, curiosity: 1 }, "playful")).toBe("annoyed");
  });

  it("leans playful with high energy and a nearby cursor", () => {
    const m = computeMood({ ...base, energy: 0.9, curiosity: 0.9, cursorNearby: true }, "calm");
    expect(["playful", "curious"]).toContain(m);
  });

  it("is sticky: keeps current mood without stronger evidence", () => {
    expect(computeMood({ ...base }, "calm")).toBe("calm");
  });

  it("decays annoyance toward zero over time", () => {
    let a = 1;
    for (let i = 0; i < 20; i++) a = decayAnnoyance(a, 0.6);
    expect(a).toBe(0);
  });

  it("bumps annoyance but never above 1", () => {
    expect(bumpAnnoyance(0.9, 0.5)).toBe(1);
    expect(bumpAnnoyance(0.1)).toBeCloseTo(0.35, 5);
  });
});
