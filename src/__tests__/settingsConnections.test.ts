import { describe, expect, it } from "vitest";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import settingsSource from "../components/SettingsPanel.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import appSource from "../App.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import nativeSource from "../native/settingsWindow.ts?raw";

describe("connection setup guidance", () => {
  it("provides the complete Gmail app-password workflow and direct Google links", () => {
    expect(settingsSource).toContain("https://myaccount.google.com/signinoptions/two-step-verification");
    expect(settingsSource).toContain("https://myaccount.google.com/apppasswords");
    expect(settingsSource).toContain("16-character App Password");
    expect(settingsSource).toContain("with or without spaces");
    expect(settingsSource).toContain("1–3 minutes");
  });

  it("provides the private Google Calendar iCal workflow and warning", () => {
    expect(settingsSource).toContain("https://calendar.google.com/calendar/u/0/r");
    expect(settingsSource).toContain("https://calendar.google.com/calendar/u/0/r/settings/calendar");
    expect(settingsSource).toContain("Secret address in iCal format");
    expect(settingsSource).toContain("Keep the Secret iCal address private");
  });
});

describe("settings window behaviour", () => {
  it("offers minimize and hides the panel when another app receives focus", () => {
    expect(settingsSource).toContain('aria-label="Minimize Settings"');
    expect(settingsSource).toContain("watchSettingsWindowFocus");
    expect(settingsSource).toContain("if (!windowFocused) return null");
  });

  it("keeps click-through tied to the visible settings surface", () => {
    expect(appSource).toContain("panelRef.current = panelOpen && settingsForeground");
    expect(appSource).toContain("onVisibilityChange={setSettingsForeground}");
  });

  it("shows a taskbar entry only while Settings remains open", () => {
    expect(settingsSource).toContain("setSettingsWindowMode(true)");
    expect(settingsSource).toContain("setSettingsWindowMode(false)");
    expect(nativeSource).toContain('invoke("set_settings_window_mode", { active })');
  });
});
