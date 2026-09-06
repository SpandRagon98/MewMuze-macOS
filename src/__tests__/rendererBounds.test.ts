import { describe, expect, it } from "vitest";
import { outwardDirtyRect, paintedDirtyRect } from "../components/CatRenderer";

describe("renderer dirty bounds", () => {
  it("expands fractional paint bounds to complete device pixels", () => {
    expect(outwardDirtyRect({ x: 10.8, y: 20.2, w: 30.1, h: 40.4 })).toEqual({
      x: 10,
      y: 20,
      w: 31,
      h: 41,
    });
  });

  it("fully covers negative and fast-moving edge bounds", () => {
    expect(outwardDirtyRect({ x: -3.2, y: 99.9, w: 8.1, h: 1.2 })).toEqual({
      x: -4,
      y: 99,
      w: 9,
      h: 3,
    });
  });

  it("tracks the actual mirrored bounds of an asymmetric drag mesh", () => {
    expect(paintedDirtyRect({ x: 62.4, y: 20.2, w: 51.1, h: 40.4 }, 100)).toEqual({
      x: 86,
      y: 20,
      w: 52,
      h: 41,
    });
  });
});
