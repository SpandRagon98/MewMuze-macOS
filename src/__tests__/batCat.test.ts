import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography guard
// reads its stylesheet exactly this way.
import { readFileSync } from "node:fs";
import {
  BATCAT_ID,
  BATCAT_COLOURS,
  DEFAULT_BATCAT_COLOUR,
  batCatPainter,
  resolveBatcatColour,
} from "../costumes/batCat";

const costume: string = readFileSync("src/costumes/batCat.ts", "utf8");
const overlay: string = readFileSync("src/costumes/costumeOverlay.ts", "utf8");
const manager: string = readFileSync("src/costumes/CostumeManager.tsx", "utf8");

describe("BatCat", () => {
  it("offers five accent colours, all valid hex", () => {
    expect(BATCAT_COLOURS).toHaveLength(5);
    for (const c of BATCAT_COLOURS) {
      expect(c.hex, c.label).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.label.length).toBeGreaterThan(0);
    }
    expect(new Set(BATCAT_COLOURS.map((c) => c.hex)).size).toBe(5);
  });

  it("falls back to the default rather than trusting whatever is in settings", () => {
    // settings.json is a file on disk a user can edit, and the value reaches a
    // canvas fillStyle. It is also shared with the Cyberpunk jacket, so a
    // colour from that costume must not survive the switch.
    expect(resolveBatcatColour("")).toBe(DEFAULT_BATCAT_COLOUR);
    expect(resolveBatcatColour("javascript:alert(1)")).toBe(DEFAULT_BATCAT_COLOUR);
    expect(resolveBatcatColour("#7cf319")).toBe("#7cf319");
    expect(resolveBatcatColour("#ff2fb9")).toBe(DEFAULT_BATCAT_COLOUR);
    expect(resolveBatcatColour(BATCAT_COLOURS[2].hex)).toBe(BATCAT_COLOURS[2].hex);
  });

  it("builds a painter per colour instead of holding module state", () => {
    const a = batCatPainter(BATCAT_COLOURS[0].hex);
    const b = batCatPainter(BATCAT_COLOURS[1].hex);
    expect(typeof a).toBe("function");
    expect(a).not.toBe(b);
  });

  it("is registered as procedural, colour and all", () => {
    // One table decides the painter, the cache key and that the package art is
    // never composited on top of what the painter already drew.
    expect(overlay).toMatch(/\[BATCAT_ID\]:/);
    expect(overlay).toMatch(/key: `\$\{BATCAT_ID\}:\$\{colour\}`/);
    expect(overlay).toMatch(/if \(PROCEDURAL\[activeCostumeId\]\) return base;/);
  });

  it("gets its swatches from the table, not another id check", () => {
    expect(manager).toMatch(/\[BATCAT_ID\]: \{ colours: BATCAT_COLOURS/);
    expect(manager).toMatch(/TINTABLE\[costume\.costumeId\] &&/);
  });

  it("cuts real holes for the eyes rather than painting over them", () => {
    // This costume covers more of the face than any other. An opaque mask
    // deletes the cat's expression, which is the thing people watch.
    expect(costume).toContain("inHole");
    expect(costume).toMatch(/!inHole\(x, y\)/);
    // And the mask goes on the face layer, the only seam drawn over the eyes.
    expect(costume).toContain('layer === "face"');
  });

  it("mirrors the profile cowl, because the sleeping cat faces the other way", () => {
    // The curled sleeper is drawn facing LEFT. Without this its eye opening
    // lands on the back of its head.
    expect(costume).toMatch(/drawCowlSide\(ctx, skull, accent, faces\)/);
    expect(costume).toMatch(/const eyeX = cx \+ 3\.3 \* faces;/);
  });

  it("has the id the package declares", () => {
    expect(BATCAT_ID).toBe("mewmuze.bat-cat.v1");
  });
});
