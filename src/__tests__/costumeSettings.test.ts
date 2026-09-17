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
// The manager and the Featured posters share one installed-costume hook.
const looks: string = readFileSync("src/components/FeaturedLooks.tsx", "utf8");

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
    // (Further props, like `premium`, may follow.)
    expect(panel).toMatch(/<CostumeManager\s+settings=\{s\}\s+onChange=\{onChange\}[^>]*\/>/);
  });

  it("sits on the Cat & Looks page, beside the accessory picker", () => {
    const looks = panel.slice(panel.indexOf('page === "looks"'), panel.indexOf('page === "voice"'));
    expect(looks).toContain("<CostumeManager");
    expect(looks).toContain('label="Accessory"');
  });

  it("the manager can still install, enable and remove a costume", () => {
    // Guards against the manager being hollowed out rather than disconnected.
    for (const call of ["chooseAndInstallCostume", "setCostumeEnabled", "uninstallCostume"]) {
      expect(manager, call).toContain(call);
    }
    // Listing moved into the hook both the manager and the posters use.
    expect(manager).toContain("useInstalledCostumes");
    expect(looks).toContain("listInstalledCostumes");
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
