import { describe, it, expect } from "vitest";
import { seasonalAccessoryFor, seasonalLabel } from "../animation/seasonal";
import { SEASONAL_ACCESSORIES, SPECIES_TRAITS, type CatSpecies } from "../animation/spriteLoader";

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("seasonal costumes", () => {
  it("dresses the cat for Halloween all through October", () => {
    expect(seasonalAccessoryFor(on(2026, 10, 1))).toBe("witchHat");
    expect(seasonalAccessoryFor(on(2026, 10, 31))).toBe("witchHat");
  });

  it("wears a santa hat in December", () => {
    expect(seasonalAccessoryFor(on(2026, 12, 1))).toBe("santaHat");
    expect(seasonalAccessoryFor(on(2026, 12, 25))).toBe("santaHat");
  });

  it("celebrates the new year then bundles up for deep winter", () => {
    expect(seasonalAccessoryFor(on(2027, 1, 1))).toBe("partyHat");
    expect(seasonalAccessoryFor(on(2027, 1, 5))).toBe("partyHat");
    expect(seasonalAccessoryFor(on(2027, 1, 6))).toBe("scarf");
    expect(seasonalAccessoryFor(on(2027, 2, 20))).toBe("scarf");
  });

  it("blooms in spring and goes bare through summer", () => {
    expect(seasonalAccessoryFor(on(2026, 3, 15))).toBe("flowerCrown");
    expect(seasonalAccessoryFor(on(2026, 5, 31))).toBe("flowerCrown");
    expect(seasonalAccessoryFor(on(2026, 6, 15))).toBeNull();
    expect(seasonalAccessoryFor(on(2026, 9, 30))).toBeNull();
  });

  it("only ever returns accessories the sprite system can draw", () => {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, 5, 6, 15, 28]) {
        const a = seasonalAccessoryFor(on(2026, month, day));
        if (a !== null) expect(SEASONAL_ACCESSORIES).toContain(a);
      }
    }
  });

  it("labels every seasonal costume", () => {
    for (const a of SEASONAL_ACCESSORIES) expect(seasonalLabel(a).length).toBeGreaterThan(0);
    expect(seasonalLabel("none")).toBe("");
  });
});

describe("cat species", () => {
  const all: CatSpecies[] = ["classic", "chonk", "fluffy", "siamese", "kitten"];

  it("defines traits for every breed", () => {
    for (const s of all) expect(SPECIES_TRAITS[s]).toBeDefined();
  });

  it("keeps classic as the neutral baseline", () => {
    const c = SPECIES_TRAITS.classic;
    expect(c.head).toBe(1);
    expect(c.bodyW).toBe(1);
    expect(c.bodyDrop).toBe(0);
    expect(c.tufts).toBe(false);
    expect(c.point).toBe(false);
  });

  it("gives each breed a genuinely different silhouette, not just colour", () => {
    // Chonk is the widest; kitten has the biggest head-to-body ratio.
    expect(SPECIES_TRAITS.chonk.bodyW).toBeGreaterThan(SPECIES_TRAITS.classic.bodyW);
    expect(SPECIES_TRAITS.siamese.bodyW).toBeLessThan(SPECIES_TRAITS.classic.bodyW);
    const ratio = (s: CatSpecies) => SPECIES_TRAITS[s].head / SPECIES_TRAITS[s].bodyW;
    expect(ratio("kitten")).toBeGreaterThan(ratio("classic"));
    expect(ratio("chonk")).toBeLessThan(ratio("classic"));
    // Distinguishing features are exclusive to the right breeds.
    expect(SPECIES_TRAITS.fluffy.tufts).toBe(true);
    expect(SPECIES_TRAITS.fluffy.ruff).toBe(true);
    expect(SPECIES_TRAITS.siamese.point).toBe(true);
    expect(SPECIES_TRAITS.siamese.ear).toBeGreaterThan(SPECIES_TRAITS.classic.ear);
  });

  it("keeps every trait within sane rendering bounds", () => {
    for (const s of all) {
      const t = SPECIES_TRAITS[s];
      for (const v of [t.head, t.bodyW, t.bodyH, t.ear, t.eye, t.tail]) {
        expect(v).toBeGreaterThan(0.5);
        expect(v).toBeLessThan(2);
      }
      expect(Math.abs(t.bodyDrop)).toBeLessThanOrEqual(4);
    }
  });
});
