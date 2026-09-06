import { describe, it, expect } from "vitest";
import { CATEGORIES, convert, findCategory, findUnit, formatConverted } from "../calctime/units";

describe("unit converter", () => {
  it("covers every category the panel offers", () => {
    const ids = CATEGORIES.map((c) => c.id);
    for (const expected of [
      "length",
      "weight",
      "temperature",
      "area",
      "volume",
      "speed",
      "data",
      "energy",
      "power",
      "angle",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("round-trips every unit back to itself", () => {
    // Catches a mistyped factor: converting out and back must be the identity.
    for (const cat of CATEGORIES) {
      for (const from of cat.units) {
        for (const to of cat.units) {
          const there = convert(100, cat.id, from.id, to.id);
          const back = convert(there, cat.id, to.id, from.id);
          expect(back, `${cat.id}: ${from.id} -> ${to.id}`).toBeCloseTo(100, 6);
        }
      }
    }
  });

  it("has a valid default pair for every category", () => {
    for (const cat of CATEGORIES) {
      expect(findUnit(cat, cat.defaultFrom), `${cat.id} defaultFrom`).toBeDefined();
      expect(findUnit(cat, cat.defaultTo), `${cat.id} defaultTo`).toBeDefined();
    }
  });

  it("converts length", () => {
    expect(convert(1, "length", "m", "cm")).toBeCloseTo(100, 9);
    expect(convert(1, "length", "mi", "km")).toBeCloseTo(1.609344, 9);
    expect(convert(6, "length", "ft", "in")).toBeCloseTo(72, 9);
  });

  it("converts weight", () => {
    expect(convert(1, "weight", "kg", "g")).toBeCloseTo(1000, 9);
    expect(convert(1, "weight", "lb", "oz")).toBeCloseTo(16, 9);
    expect(convert(70, "weight", "kg", "lb")).toBeCloseTo(154.3235835, 6);
  });

  it("converts temperature with its offset, not just a scale", () => {
    // The affine cases: a naive factor table gets all of these wrong.
    expect(convert(0, "temperature", "c", "f")).toBeCloseTo(32, 9);
    expect(convert(100, "temperature", "c", "f")).toBeCloseTo(212, 9);
    expect(convert(-40, "temperature", "c", "f")).toBeCloseTo(-40, 9);
    expect(convert(37, "temperature", "c", "f")).toBeCloseTo(98.6, 9);
    expect(convert(0, "temperature", "c", "k")).toBeCloseTo(273.15, 9);
    expect(convert(32, "temperature", "f", "c")).toBeCloseTo(0, 9);
    expect(convert(300, "temperature", "k", "f")).toBeCloseTo(80.33, 9);
  });

  it("converts area, volume and speed", () => {
    expect(convert(1, "area", "ha", "m2")).toBeCloseTo(10000, 9);
    expect(convert(1, "area", "acre", "ft2")).toBeCloseTo(43560, 3);
    expect(convert(1, "volume", "l", "ml")).toBeCloseTo(1000, 9);
    expect(convert(1, "volume", "galus", "l")).toBeCloseTo(3.785411784, 9);
    expect(convert(100, "speed", "kmh", "mph")).toBeCloseTo(62.13711922, 6);
    expect(convert(1, "speed", "ms", "kmh")).toBeCloseTo(3.6, 9);
  });

  it("keeps decimal and binary data units distinct", () => {
    // 1 MB != 1 MiB — conflating them is the usual "why is my 1 TB drive
    // showing as 931 GB" confusion.
    expect(convert(1, "data", "mb", "b")).toBeCloseTo(1e6, 6);
    expect(convert(1, "data", "mib", "b")).toBeCloseTo(1048576, 6);
    expect(convert(1, "data", "gb", "gib")).toBeCloseTo(0.9313225746, 6);
    expect(convert(1, "data", "b", "bit")).toBeCloseTo(8, 9);
  });

  it("converts energy, power and angles", () => {
    expect(convert(1, "energy", "kwh", "j")).toBeCloseTo(3.6e6, 3);
    expect(convert(1, "energy", "kcal", "cal")).toBeCloseTo(1000, 9);
    expect(convert(1, "power", "kw", "w")).toBeCloseTo(1000, 9);
    expect(convert(180, "angle", "deg", "rad")).toBeCloseTo(Math.PI, 9);
    expect(convert(1, "angle", "turn", "deg")).toBeCloseTo(360, 9);
    expect(convert(1, "angle", "deg", "arcmin")).toBeCloseTo(60, 9);
  });

  it("refuses unknown categories and units rather than guessing", () => {
    expect(() => convert(1, "nope", "m", "cm")).toThrow();
    expect(() => convert(1, "length", "m", "kg")).toThrow();
  });

  it("formats across a wide dynamic range", () => {
    expect(formatConverted(100)).toBe("100");
    expect(formatConverted(0)).toBe("0");
    expect(formatConverted(1e20)).toContain("e+");
    expect(formatConverted(1e-9)).toContain("e-");
    // Trailing zeros trimmed: 1 m -> 100 cm, not "100.000000".
    expect(formatConverted(convert(1, "length", "m", "cm"))).toBe("100");
  });

  it("finds categories by id", () => {
    expect(findCategory("length")?.name).toBe("Length");
    expect(findCategory("missing")).toBeUndefined();
  });
});
