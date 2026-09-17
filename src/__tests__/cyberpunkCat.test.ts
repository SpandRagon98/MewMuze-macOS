import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography guard
// reads its stylesheet exactly this way.
import { readFileSync } from "node:fs";
import {
  CYBERPUNK_CAT_ID,
  CYBERPUNK_COLOURS,
  DEFAULT_CYBERPUNK_COLOUR,
  cyberpunkPainter,
  resolveCyberpunkColour,
} from "../costumes/cyberpunkCat";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";
import { sanitizeSettings } from "../settings/settingsStore";

const overlay: string = readFileSync("src/costumes/costumeOverlay.ts", "utf8");
const app: string = readFileSync("src/App.tsx", "utf8");

describe("Cyberpunk Cat", () => {
  it("offers the five neon colours, all valid hex", () => {
    expect(CYBERPUNK_COLOURS).toHaveLength(5);
    for (const c of CYBERPUNK_COLOURS) {
      expect(c.hex, c.label).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.label.length).toBeGreaterThan(0);
    }
    expect(new Set(CYBERPUNK_COLOURS.map((c) => c.hex)).size).toBe(5);
  });

  it("falls back to the default rather than trusting whatever is in settings", () => {
    // settings.json is a file on disk a user can edit, and the value reaches a
    // canvas fillStyle.
    expect(resolveCyberpunkColour("")).toBe(DEFAULT_CYBERPUNK_COLOUR);
    expect(resolveCyberpunkColour("javascript:alert(1)")).toBe(DEFAULT_CYBERPUNK_COLOUR);
    expect(resolveCyberpunkColour("#123456")).toBe(DEFAULT_CYBERPUNK_COLOUR);
    expect(resolveCyberpunkColour(CYBERPUNK_COLOURS[2].hex)).toBe(CYBERPUNK_COLOURS[2].hex);
  });

  it("builds a painter per colour instead of holding module state", () => {
    // Two painters for two colours must be genuinely different functions, or
    // the sprite cache key and the drawing could disagree about which is live.
    const a = cyberpunkPainter(CYBERPUNK_COLOURS[0].hex);
    const b = cyberpunkPainter(CYBERPUNK_COLOURS[1].hex);
    expect(typeof a).toBe("function");
    expect(a).not.toBe(b);
  });

  it("puts the colour in the sprite cache key", () => {
    // renderFrame caches by pose. Without the colour in the key, changing it
    // would leave every already-drawn frame in the old colour.
    expect(overlay).toMatch(/key: `\$\{CYBERPUNK_CAT_ID\}:\$\{colour\}`/);
  });

  it("is registered as procedural, so its package art is never composited too", () => {
    // The painter draws the jacket inside the sprite. Pasting the package's
    // PNG layers over the finished frame as well put a SECOND jacket on top of
    // the paws and props the painter had stayed behind - which is what happens
    // the moment these two facts are recorded in different places.
    expect(overlay).toMatch(/\[CYBERPUNK_CAT_ID\]:/);
    expect(overlay).toMatch(/if \(PROCEDURAL\[activeCostumeId\]\) return base;/);
    // Every procedural entry, not just this one.
    for (const id of ["CORPORATE_CAT_ID", "CYBERPUNK_CAT_ID"]) {
      expect(overlay, `${id} must be in the procedural table`).toMatch(
        new RegExp(`\\[${id}\\]:`),
      );
    }
  });

  it("re-activates when the colour changes, not only when the costume does", () => {
    expect(app).toMatch(/next\.costumeTint !== prev\.costumeTint/);
    // And the tint must be set BEFORE activation, since the painter is built
    // with it.
    const idx = app.indexOf("setCostumeTint(eff.costumeTint)");
    const act = app.indexOf("activateCostumeOverlay(eff.selectedCostumeId)", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(act).toBeGreaterThan(idx);
  });

  it("wears the visor on the face layer, which is the only one drawn over the eyes", () => {
    const costume: string = readFileSync("src/costumes/cyberpunkCat.ts", "utf8");
    expect(costume).toContain('layer === "face"');
    // Translucent on purpose - an opaque lens deletes the cat's expression.
    expect(costume).toMatch(/rgba\([^)]*0\.\d+\)/);
    // No visor from behind: there is no face there.
    expect(costume).toMatch(/if \(pose\.view === "back"\) return;/);
  });

  it("shows the chosen accessory in the preview, not a context swap", () => {
    // The app swaps in glasses while an IDE is focused. With Settings open that
    // made the preview contradict the dropdown right next to it.
    expect(app).toMatch(/const wantedAccessory = panelOpenRef\.current\s*\?\s*baseAccessory/);
  });

  it("has the id the package declares", () => {
    expect(CYBERPUNK_CAT_ID).toBe("mewmuze.cyberpunk-cat.v1");
  });
});

describe("the jacket colour setting", () => {
  it("defaults to empty, meaning the costume's own default", () => {
    expect(DEFAULT_SETTINGS.costumeTint).toBe("");
  });

  it("survives a settings.json written before the setting existed", () => {
    const old = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    delete old.costumeTint;
    expect(sanitizeSettings(old).costumeTint).toBe("");
  });

  it("accepts hex and rejects anything else", () => {
    expect(sanitizeSettings({ costumeTint: "#7cf319" }).costumeTint).toBe("#7cf319");
    expect(sanitizeSettings({ costumeTint: "red" }).costumeTint).toBe("");
    expect(sanitizeSettings({ costumeTint: "#7cf3" }).costumeTint).toBe("");
    expect(sanitizeSettings({ costumeTint: 42 }).costumeTint).toBe("");
  });
});
