import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography guard
// reads its stylesheet exactly this way, and Vite's ?raw loader is no help
// because vitest stubs these files to empty.
import { readFileSync } from "node:fs";

/**
 * The costume manager, its Tauri bridge and its stylesheet were all finished,
 * and then a "Coming soon" placeholder was put in front of them - so the
 * feature looked unbuilt while being entirely built. These assertions are
 * against the source rather than a rendered tree because that is what actually
 * regressed: the component was never broken, it was disconnected.
 */
// Paths are relative to the project root, which is vitest's working directory.
const panel: string = readFileSync("src/components/SettingsPanel.tsx", "utf8");
const css: string = readFileSync("src/components/ui.css", "utf8");
const manager: string = readFileSync("src/costumes/CostumeManager.tsx", "utf8");

describe("Costumes in Settings > Appearance", () => {
  it("renders the real manager, not a placeholder", () => {
    expect(panel).toContain("<CostumeManager");
    expect(panel).toContain('from "../costumes/CostumeManager"');
  });

  it("no longer claims costumes are coming soon", () => {
    expect(panel).not.toMatch(/coming soon/i);
    expect(css).not.toContain("costume-coming-soon");
  });

  it("hands the manager the settings and the same change handler as the rest of the panel", () => {
    // Passing `set` instead of `onChange` would silently drop every field the
    // manager did not name, wiping unrelated settings on a costume change.
    expect(panel).toMatch(/<CostumeManager\s+settings=\{s\}\s+onChange=\{onChange\}\s*\/>/);
  });

  it("sits in the Appearance tab, beside the accessory picker", () => {
    const appearance = panel.slice(panel.indexOf('tab === "appearance"'), panel.indexOf('tab === "behaviour"'));
    expect(appearance).toContain("<CostumeManager");
  });

  it("the manager can still install, enable and remove a costume", () => {
    // Guards against the manager being hollowed out rather than disconnected.
    for (const call of ["chooseAndInstallCostume", "setCostumeEnabled", "uninstallCostume", "listInstalledCostumes"]) {
      expect(manager, call).toContain(call);
    }
  });

  it("keeps the styles the manager actually renders", () => {
    for (const cls of [
      "costume-manager",
      "costume-manager-head",
      "costume-list",
      "costume-thumb",
      "costume-empty",
      "costume-status",
    ]) {
      expect(css, cls).toContain(`.${cls}`);
    }
  });
});
