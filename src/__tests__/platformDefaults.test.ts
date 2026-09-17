import { afterEach, describe, expect, it, vi } from "vitest";

const onPlatform = async (platform: string) => {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform, userAgent: platform });
  return {
    platform: await import("../platform"),
    profile: await import("../companion/profile"),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("platform defaults", () => {
  it("a Mac gets Mac words and a dictation shortcut macOS does not already own", async () => {
    const { platform, profile } = await onPlatform("MacIntel");
    expect(platform.IS_MAC).toBe(true);
    expect(platform.VAULT_NAME).toContain("Keychain");
    // Ctrl+Option+Space is macOS's "select next input source".
    expect(profile.DEFAULT_COMPANION.voice.shortcut).toBe("Cmd+Shift+Space");
    expect(profile.SHORTCUT_PATTERN.test("Cmd+Shift+Space")).toBe(true);
  });

  it("Windows keeps its own", async () => {
    const { platform, profile } = await onPlatform("Win32");
    expect(platform.IS_MAC).toBe(false);
    expect(platform.VAULT_NAME).toContain("Credential Manager");
    expect(profile.DEFAULT_COMPANION.voice.shortcut).toBe("Ctrl+Alt+Space");
  });

  it("rejects modifiers the shortcut plugin does not know", async () => {
    const { profile } = await onPlatform("MacIntel");
    expect(profile.SHORTCUT_PATTERN.test("Meta+Space")).toBe(false);
    expect(profile.SHORTCUT_PATTERN.test("Cmd+Cmd+Cmd+Cmd+Space")).toBe(false);
  });
});
