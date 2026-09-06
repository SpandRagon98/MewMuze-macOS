import { describe, it, expect } from "vitest";
import { sanitizeSettings } from "../settings/settingsStore";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";

describe("settings persistence", () => {
  it("uses the requested first-install appearance and interaction defaults", () => {
    expect(DEFAULT_SETTINGS.dragStretch).toBe(false);
    expect(DEFAULT_SETTINGS.appearance.furColor).toBe("#FAFAFA");
  });

  it("returns defaults for null / non-object input", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and drops invalid ones", () => {
    const s = sanitizeSettings({
      soundEnabled: true,
      activityLevel: "playful",
      catSize: "nonsense",
      cursorChasing: false,
      lastMonitorIndex: -3,
      lastPosition: { x: 12, y: 34 },
      extra: "ignored",
    });
    expect(s.soundEnabled).toBe(true);
    expect(s.activityLevel).toBe("playful");
    expect(s.catSize).toBe(DEFAULT_SETTINGS.catSize); // invalid -> default
    expect(s.cursorChasing).toBe(false);
    expect(s.lastMonitorIndex).toBe(0); // clamped to >= 0
    expect(s.lastPosition).toEqual({ x: 12, y: 34 });
  });

  it("rejects a malformed lastPosition", () => {
    const s = sanitizeSettings({ lastPosition: { x: "a", y: 1 } });
    expect(s.lastPosition).toBeNull();
  });

  it("rejects non-finite coordinates", () => {
    const s = sanitizeSettings({ lastPosition: { x: Infinity, y: 1 } });
    expect(s.lastPosition).toBeNull();
  });

  it("keeps the approved built-in accessories and migrates removed selections", () => {
    const s = sanitizeSettings({
      appearance: {
        furColor: "#101820",
        eyeColor: "#f0c419",
        earColor: "#ff784f",
        pattern: "solid",
        accessory: "headphones",
      },
    });
    expect(s.appearance.earColor).toBe("#ff784f");
    expect(s.appearance.accessory).toBe("headphones");
    expect(s.costumeMigrationNoticePending).toBe(false);
    for (const accessory of [
      "flowerCrown",
      "bandana",
      "sunglasses",
      "headphones",
      "glasses",
    ] as const) {
      expect(sanitizeSettings({ appearance: { accessory } }).appearance.accessory).toBe(accessory);
    }

    const invalid = sanitizeSettings({ appearance: { earColor: "orange", accessory: "cape" } });
    expect(invalid.appearance.earColor).toBe(DEFAULT_SETTINGS.appearance.earColor);
    expect(invalid.appearance.accessory).toBe("none");
  });

  it("persists the chosen breed and rejects unknown ones", () => {
    for (const species of ["classic", "chonk", "fluffy", "siamese", "kitten"] as const) {
      expect(sanitizeSettings({ appearance: { species } }).appearance.species).toBe(species);
    }
    expect(sanitizeSettings({ appearance: { species: "dragon" } }).appearance.species).toBe(
      DEFAULT_SETTINGS.appearance.species,
    );
  });

  it("persists the optional cat stroke and validates its colour", () => {
    const enabled = sanitizeSettings({
      appearance: { stroke: true, strokeColor: "#12abEF" },
    });
    expect(enabled.appearance.stroke).toBe(true);
    expect(enabled.appearance.strokeColor).toBe("#12abEF");

    const invalid = sanitizeSettings({
      appearance: { stroke: "yes", strokeColor: "red" },
    });
    expect(invalid.appearance.stroke).toBe(false);
    expect(invalid.appearance.strokeColor).toBe(DEFAULT_SETTINGS.appearance.strokeColor);
  });

  it("retires seasonal costumes and does not repeat an acknowledged migration", () => {
    for (const accessory of ["santaHat", "witchHat", "partyHat", "scarf"] as const) {
      const migrated = sanitizeSettings({ appearance: { accessory }, seasonalCostumes: true });
      expect(migrated.appearance.accessory).toBe("none");
      expect(migrated.costumeMigrationNoticePending).toBe(true);
    }
    expect(sanitizeSettings({ seasonalCostumes: false }).seasonalCostumes).toBe(false);
    expect(sanitizeSettings({ seasonalCostumes: true }).seasonalCostumes).toBe(false);
    const acknowledged = sanitizeSettings({
      costumeCatalogMigrationVersion: 1,
      costumeMigrationNoticePending: false,
      appearance: { accessory: "none" },
    });
    expect(acknowledged.costumeMigrationNoticePending).toBe(false);
  });

  it("persists only safe installed-costume identifiers", () => {
    expect(
      sanitizeSettings({ selectedCostumeId: "mewmuze.space-explorer.sample" }).selectedCostumeId,
    ).toBe("mewmuze.space-explorer.sample");
    expect(sanitizeSettings({ selectedCostumeId: "../../escape" }).selectedCostumeId).toBe("");
    expect(sanitizeSettings({ selectedCostumeId: "MewMuze Space Explorer" }).selectedCostumeId).toBe("");
  });
});
