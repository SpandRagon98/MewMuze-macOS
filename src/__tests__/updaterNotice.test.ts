import { describe, expect, it } from "vitest";
// @ts-expect-error -- node:fs is available at runtime under vitest.
import { readFileSync } from "node:fs";
import { friendlyUpdateError, shouldNotify, UPDATE_CHECK_EVERY_MS, UPDATE_SNOOZE_MS } from "../licensing/updater";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import appSource from "../App.tsx?raw";

const NOW = 1_800_000_000_000;

describe("update notice", () => {
  it("offers a version nobody has waved off", () => {
    expect(shouldNotify("0.1.11", null, NOW)).toBe(true);
  });

  it("stays quiet for a day after OK on that version", () => {
    const d = { version: "0.1.11", at: NOW };
    expect(shouldNotify("0.1.11", d, NOW + 60_000)).toBe(false);
    expect(shouldNotify("0.1.11", d, NOW + UPDATE_SNOOZE_MS)).toBe(true);
  });

  it("always offers a newer version, even right after dismissing the last one", () => {
    expect(shouldNotify("0.1.12", { version: "0.1.11", at: NOW }, NOW + 1)).toBe(true);
  });

  it("keeps checking while the app stays open, but rarely", () => {
    expect(UPDATE_CHECK_EVERY_MS).toBeGreaterThanOrEqual(60 * 60_000);
    expect(UPDATE_CHECK_EVERY_MS).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("turns raw plugin errors into plain sentences", () => {
    expect(friendlyUpdateError("error sending request for url")).toContain("Couldn't reach");
    expect(friendlyUpdateError("signature verification failed")).toContain("safety check");
    expect(friendlyUpdateError("something odd")).not.toContain("odd");
  });
});

describe("update flow wiring (App.tsx)", () => {
  const APP: string = appSource;
  const check = APP.slice(APP.indexOf("const runUpdateCheck"), APP.indexOf("const autoCheck"));

  it("installs only when asked: the automatic check just offers", () => {
    expect(check).toContain("if (manual) return installFoundUpdate(info.version);");
    expect(check).toContain("offerUpdate(info.version);");
    // No silent download/restart path left in the automatic branch.
    expect(check.indexOf("installUpdate(")).toBe(-1);
  });

  it("the notice's Update button installs, and OK remembers the choice", () => {
    expect(APP).toContain('id: "update-install", label: "Update"');
    expect(APP).toContain('if (action.id === "update-install")');
    expect(APP).toContain('if (b.id.startsWith("update:")) saveDismissed(');
  });

  it("checks at launch and then periodically, both behind the setting", () => {
    expect(APP).toContain("setInterval(autoCheck, UPDATE_CHECK_EVERY_MS)");
    expect(APP).toMatch(/const autoCheck = \(\) => \{\s*if \(current\.autoUpdate\)/);
  });
});

describe("Paper's update channel is its own", () => {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const keyId = (b64: string) => {
    const line2 = atob(b64).split("\n")[1];
    return Array.from(atob(line2).slice(2, 10), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
  };

  it("reads Paper's feed, never Pro's", () => {
    expect(conf.productName).toBe("MewMuze Paper");
    expect(conf.plugins.updater.active).toBe(true);
    expect(conf.plugins.updater.endpoints).toEqual(["https://mewmuze.com/updates/paper/latest.json"]);
  });

  it("trusts Paper's own signing key, not Pro's", () => {
    // FBDC6226BF1073A9 is MewMuze Pro's updater key: a Paper install must never accept a Pro release.
    expect(keyId(conf.plugins.updater.pubkey)).not.toBe("FBDC6226BF1073A9");
    expect(keyId(conf.plugins.updater.pubkey)).toMatch(/^[0-9A-F]{16}$/);
  });
});
