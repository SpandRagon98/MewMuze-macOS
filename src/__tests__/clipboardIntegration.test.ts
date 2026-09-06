import { describe, expect, it } from "vitest";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { placePanel, overlaps, type Area, type Box } from "../quicktools/panelPlacement";
import { CLIPBOARD_PANEL_SIZE } from "../clipboard-assistant/ClipboardPanel";
import { CLIPBOARD_BADGE_SIZE } from "../clipboard-assistant/ClipboardBadge";
import { sanitizeSettings } from "../settings/settingsStore";
import { canPlayClipboardReaction } from "../clipboard-assistant/ClipboardPriority";

describe("Clipboard Assistant integration boundaries", () => {
  it("places its full panel beside the cat, within every tested work-area edge", () => {
    const area: Area = { left: 1920, top: 0, right: 3840, bottom: 1032 };
    for (const cat of [
      { x: 1930, y: 10, width: 88, height: 88 },
      { x: 2800, y: 470, width: 88, height: 88 },
      { x: 3740, y: 934, width: 88, height: 88 },
    ] satisfies Box[]) {
      const placement = placePanel({ cat, panel: CLIPBOARD_PANEL_SIZE, area });
      const panel = { x: placement.x, y: placement.y, ...CLIPBOARD_PANEL_SIZE };
      expect(overlaps(panel, cat)).toBe(false);
      expect(panel.x).toBeGreaterThanOrEqual(area.left);
      expect(panel.y).toBeGreaterThanOrEqual(area.top);
      expect(panel.x + panel.width).toBeLessThanOrEqual(area.right);
      expect(panel.y + panel.height).toBeLessThanOrEqual(area.bottom);
    }
  });

  it("places the small badge beside the cat without covering it", () => {
    const area: Area = { left: 0, top: 0, right: 1920, bottom: 1032 };
    const cat: Box = { x: 1810, y: 930, width: 88, height: 88 };
    const placement = placePanel({ cat, panel: CLIPBOARD_BADGE_SIZE, area });
    const badge = { x: placement.x, y: placement.y, ...CLIPBOARD_BADGE_SIZE };
    expect(overlaps(badge, cat)).toBe(false);
    expect(badge.x + badge.width).toBeLessThanOrEqual(area.right);
    expect(badge.y + badge.height).toBeLessThanOrEqual(area.bottom);
  });

  it("registers only additive clipboard animations", () => {
    for (const name of [
      "clipboardNotice",
      "clipboardHold",
      "clipboardClean",
      "clipboardArrange",
      "clipboardSuccess",
      "clipboardError",
    ] as const) {
      expect(ANIMATIONS[name]).toBeDefined();
      expect(ANIMATIONS[name].view).toBe("front");
    }
    expect(ANIMATIONS.clipboardHold.loop).toBe(true);
  });

  it("keeps dragging, airborne, reminder and Quick Tools states above optional reactions", () => {
    const idle = {
      hidden: false,
      paused: false,
      fullscreen: false,
      dragging: false,
      grounded: true,
      activeNotice: false,
      quickTools: false,
    };
    expect(canPlayClipboardReaction(idle)).toBe(true);
    for (const blocked of [
      { dragging: true },
      { grounded: false },
      { activeNotice: true },
      { quickTools: true },
      { fullscreen: true },
      { paused: true },
      { hidden: true },
    ]) {
      expect(canPlayClipboardReaction({ ...idle, ...blocked })).toBe(false);
    }
  });

  it("sanitizes persisted clipboard settings without ever accepting content", () => {
    const sanitized = sanitizeSettings({
      clipboardAssistant: {
        mode: "manual",
        excludedApplications: ["safe.exe", 17, "x".repeat(150)],
        maxPreviewLength: 1,
        maxInputLength: 999_999,
        forgetAfterSeconds: 15,
        suppressSensitiveCodes: false,
        clipboardText: "must not persist",
      },
    });
    expect(sanitized.clipboardAssistant.mode).toBe("manual");
    expect(sanitized.clipboardAssistant.maxPreviewLength).toBe(250);
    expect(sanitized.clipboardAssistant.maxInputLength).toBe(500_000);
    expect(sanitized.clipboardAssistant.forgetAfterSeconds).toBe(300);
    expect(sanitized.clipboardAssistant.excludedApplications[0]).toBe("safe.exe");
    expect("clipboardText" in sanitized.clipboardAssistant).toBe(false);
  });
});
