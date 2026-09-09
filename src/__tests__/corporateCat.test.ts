import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography and
// costume-settings guards read their sources exactly this way.
import { readFileSync } from "node:fs";
import { CORPORATE_CAT_ID } from "../costumes/corporateCat";

const overlay: string = readFileSync("src/costumes/costumeOverlay.ts", "utf8");
const costume: string = readFileSync("src/costumes/corporateCat.ts", "utf8");
// The rasteriser is shared by every costume, so the guarantees about hard
// pixels and torso confinement are asserted where they now live.
const surface: string = readFileSync("src/costumes/pixelSurface.ts", "utf8");

describe("Corporate Cat", () => {
  it("uses the id the signed package declares", () => {
    // The manifest in the costume workspace ships this exact id; a mismatch
    // means the package installs and then renders nothing.
    expect(CORPORATE_CAT_ID).toBe("mewmuze.corporate-cat.v1");
  });

  it("is registered as a painter rather than composited afterwards", () => {
    // Painting over a finished sprite put the jacket above the forelegs, the
    // keyboard and the laptop. It is now painted INSIDE the sprite instead.
    expect(overlay).toContain("setCostumePainter");
    expect(overlay).toContain("paintCorporateCat");
  });

  it("does not also composite itself on top", () => {
    // Belt and braces: with the painter registered, a second pass here would
    // draw the jacket again over the very props the first pass stayed behind.
    // Both facts come off one table now, so registering a painter and skipping
    // the composite cannot drift apart.
    expect(overlay).toMatch(/\[CORPORATE_CAT_ID\]: \(\) => \(\{ painter: paintCorporateCat/);
    expect(overlay).toMatch(/if \(PROCEDURAL\[activeCostumeId\]\) return base;/);
  });

  it("draws from the live pose rather than a fixed bitmap", () => {
    // The whole point: a bitmap follows where the torso IS but not what shape
    // it is, which is what made a lying cat wear a slab.
    expect(costume).toContain("bodyAnchors(pose)");
  });

  it("confines the jacket to the torso, which is what keeps it off the paws", () => {
    // Limbs are drawn OUTSIDE the torso ellipse, so confining the garment to
    // it means a raised paw can never be painted over however large the
    // garment is. This was a ctx.clip(); it is now a per-pixel test, because
    // an anti-aliased clip edge left a soft fringe against pixel art. The
    // guarantee is the same, so this asserts the guarantee, not the mechanism.
    expect(surface).toMatch(/private inside\(/);
    expect(surface).toMatch(/nx \* nx \+ ny \* ny <= 1/);
    // Every fill routes through the ellipse test.
    expect(surface).toMatch(/if \(this\.inside\(x, y\)\) this\.plot\(x, y\)/);
    // ...and the costume actually uses it.
    expect(costume).toContain("new Surface(");
  });

  it("rasterises hard pixels, matching the cat it is worn on", () => {
    // The cat's own body is emitted a pixel at a time; an anti-aliased garment
    // edge against that reads as a soft, half-transparent fringe. Comments are
    // stripped first: this file explains WHY it avoids ctx.fill(), and prose
    // about a call is not a call.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(strip(surface)).toMatch(/fillRect\([^)]*, 1, 1\)/);
    for (const code of [strip(surface), strip(costume)]) {
      expect(code).not.toMatch(/ctx\.fill\(\)/);
      expect(code).not.toMatch(/ctx\.stroke\(\)/);
      expect(code).not.toMatch(/ctx\.clip\(\)/);
    }
  });

  it("cannot leak between costumes through the frame cache", () => {
    // The painter now draws into the cached sprite itself, so the cache key
    // MUST include the costume - otherwise a frame drawn while the jacket was
    // on comes back for a cat that has taken it off, or for a different
    // costume entirely.
    const sprite = readFileSync("src/animation/spriteLoader.ts", "utf8");
    expect(sprite).toContain("costumeCacheKey");
    const key = sprite.slice(sprite.indexOf("function keyFor"), sprite.indexOf("export function renderFrame"));
    expect(key).toContain("costumeCacheKey");
    // Changing painter must also drop whatever was already cached.
    const setter = sprite.slice(sprite.indexOf("export function setCostumePainter"));
    expect(setter.slice(0, 400)).toContain("clearSpriteCache()");
  });

  it("paints behind the limbs and props, and sleeves on top of them", () => {
    expect(costume).toContain('layer === "limbs"');
    expect(costume).toContain("frontLimbs(");
  });

  it("handles a degenerate torso instead of dividing by it", () => {
    expect(costume).toContain("if (rx <= 0 || ry <= 0)");
  });

  it("covers every view", () => {
    for (const view of ["drawSide", "drawFront", "drawBack"]) {
      expect(costume, view).toContain(view);
    }
  });
});
