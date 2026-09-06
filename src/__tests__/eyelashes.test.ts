import { describe, it, expect } from "vitest";
import { DEFAULT_APPEARANCE, configureAppearance, renderFrame } from "../animation/spriteLoader";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { sanitizeSettings } from "../settings/settingsStore";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";

/**
 * Settings/plumbing coverage for the eyelashes option. The *drawing* itself is
 * verified in the browser harness (jsdom has no canvas 2D context, so pixels
 * cannot be read here): lashes were measured as 125 pixels, 100% above the eye
 * centre and 100% on the outer side of each eye.
 */
describe("eyelashes appearance option", () => {
  it("is off by default, everywhere", () => {
    expect(DEFAULT_APPEARANCE.eyelashes).toBe(false);
    expect(DEFAULT_SETTINGS.appearance.eyelashes).toBe(false);
    expect(sanitizeSettings(null).appearance.eyelashes).toBe(false);
  });

  it("round-trips through the settings sanitiser", () => {
    const on = sanitizeSettings({ appearance: { ...DEFAULT_APPEARANCE, eyelashes: true } });
    expect(on.appearance.eyelashes).toBe(true);
    const off = sanitizeSettings({ appearance: { ...DEFAULT_APPEARANCE, eyelashes: false } });
    expect(off.appearance.eyelashes).toBe(false);
  });

  it("rejects a non-boolean and falls back to the default", () => {
    const junk = sanitizeSettings({ appearance: { ...DEFAULT_APPEARANCE, eyelashes: "yes" } });
    expect(junk.appearance.eyelashes).toBe(false);
  });

  it("keeps the rest of the appearance intact when toggled", () => {
    const s = sanitizeSettings({
      appearance: { ...DEFAULT_APPEARANCE, furColor: "#c98a3f", species: "fluffy", eyelashes: true },
    });
    expect(s.appearance.eyelashes).toBe(true);
    expect(s.appearance.furColor).toBe("#c98a3f");
    expect(s.appearance.species).toBe("fluffy");
  });

  it("renders every animation without error in both states", () => {
    // Guards against a lash-drawing crash on any eye state (closed, happy,
    // sad, angry, panic…) rather than just the common open-eyed poses.
    for (const lashes of [false, true]) {
      configureAppearance({ ...DEFAULT_APPEARANCE, eyelashes: lashes });
      for (const def of Object.values(ANIMATIONS)) {
        for (const frame of def.frames) {
          expect(() => renderFrame(frame)).not.toThrow();
        }
      }
    }
    configureAppearance({ ...DEFAULT_APPEARANCE, eyelashes: false });
  });
});
