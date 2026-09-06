import { describe, it, expect } from "vitest";
import { updateEnergy, canExert, isWellRested, clamp01, ENERGY_LOW } from "../behaviour/energySystem";

describe("energySystem", () => {
  it("drains energy while running and clamps at 0", () => {
    let e = 0.5;
    for (let i = 0; i < 100; i++) e = updateEnergy(e, "run", 0.1);
    expect(e).toBe(0);
  });

  it("recovers energy while sleeping and clamps at 1", () => {
    let e = 0.2;
    for (let i = 0; i < 100; i++) e = updateEnergy(e, "sleep", 0.1);
    expect(e).toBe(1);
  });

  it("leaves energy unchanged for neutral animations", () => {
    expect(updateEnergy(0.5, "watch", 0.1)).toBeCloseTo(0.5, 5);
  });

  it("canExert is false at or below the low threshold", () => {
    expect(canExert(ENERGY_LOW)).toBe(false);
    expect(canExert(ENERGY_LOW + 0.01)).toBe(true);
  });

  it("isWellRested only near full energy", () => {
    expect(isWellRested(0.5)).toBe(false);
    expect(isWellRested(0.8)).toBe(true);
  });

  it("clamp01 bounds values", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });
});
