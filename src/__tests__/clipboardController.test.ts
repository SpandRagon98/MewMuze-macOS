import { describe, expect, it, vi } from "vitest";
import { ClipboardController } from "../clipboard-assistant/ClipboardController";
import {
  isExcludedApplication,
  looksLikeSensitiveCode,
} from "../clipboard-assistant/ClipboardPrivacy";
import {
  CLIPBOARD_BADGE_MS,
  scheduleClipboardBadgeDismiss,
} from "../clipboard-assistant/ClipboardNotice";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";

const settings = () => ({
  ...DEFAULT_SETTINGS.clipboardAssistant,
  excludedApplications: [...DEFAULT_SETTINGS.clipboardAssistant.excludedApplications],
});
const runtime = {
  sessionLocked: false,
  hidden: false,
  paused: false,
  fullscreen: false,
};
const event = (text = "hello", sourceApp: string | null = "notepad.exe", sequence = 1) => ({
  text,
  sourceApp,
  sequence,
});

describe("ClipboardController", () => {
  it("accepts an event and requests a badge without opening anything", () => {
    const controller = new ClipboardController();
    const result = controller.accept(event(), settings(), runtime, 1000);
    expect(result).toMatchObject({ accepted: true, showBadge: true, reason: null });
    expect(result.snapshot?.original).toBe("hello");
  });

  it("ignores duplicate events and MewMuze-generated writes", () => {
    const controller = new ClipboardController();
    expect(controller.accept(event(), settings(), runtime, 1000).accepted).toBe(true);
    expect(controller.accept(event("hello", "notepad.exe", 2), settings(), runtime, 1100).reason).toBe("duplicate");
    controller.markOwnWrite("clean result", 1200);
    expect(controller.accept(event("clean result", null, 3), settings(), runtime, 1300).reason).toBe("self-write");
  });

  it("respects disabled/manual modes, app exclusions and safety limits", () => {
    const controller = new ClipboardController();
    expect(controller.accept(event(), { ...settings(), mode: "off" }, runtime, 1).reason).toBe("disabled");
    expect(controller.accept(event(), { ...settings(), mode: "manual" }, runtime, 1).reason).toBe("manual-only");
    expect(controller.accept(event(), { ...settings(), mode: "manual" }, runtime, 1, true).accepted).toBe(true);

    const excluded = new ClipboardController();
    expect(excluded.accept(event("secret", "KeePassXC.exe"), settings(), runtime, 1).reason).toBe("excluded");
    expect(
      new ClipboardController().accept(event("123456"), settings(), runtime, 1).reason,
    ).toBe("sensitive-code");
    expect(
      new ClipboardController().accept(
        event("x".repeat(1001)),
        { ...settings(), maxInputLength: 1000 },
        runtime,
        1,
      ).reason,
    ).toBe("too-large");
  });

  it("suppresses events while locked, hidden, paused or fullscreen", () => {
    for (const key of ["sessionLocked", "hidden", "paused", "fullscreen"] as const) {
      const result = new ClipboardController().accept(
        event(),
        settings(),
        { ...runtime, [key]: true },
        1,
      );
      expect(result.accepted).toBe(false);
    }
  });

  it("replaces old text, expires it and always forgets it when the panel closes", () => {
    const controller = new ClipboardController();
    const configured = { ...settings(), forgetAfterSeconds: 60 as const };
    controller.accept(event("first"), configured, runtime, 1_000);
    controller.accept(event("second", "notepad.exe", 2), configured, runtime, 2_000);
    expect(controller.session.snapshot?.original).toBe("second");
    expect(controller.expire(61_999)).toBe(false);
    expect(controller.expire(62_000)).toBe(true);
    expect(controller.session.snapshot).toBeNull();

    controller.accept(event("third", "notepad.exe", 3), configured, runtime, 70_000);
    controller.close(60);
    expect(controller.session.snapshot).toBeNull();
  });

  it("dismisses the badge at approximately five seconds", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    scheduleClipboardBadgeDismiss(dismiss);
    vi.advanceTimersByTime(CLIPBOARD_BADGE_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("normalizes exclusions and conservatively detects short codes", () => {
    expect(isExcludedApplication("C:\\Apps\\BITWARDEN.EXE", ["bitwarden.exe"])).toBe(true);
    expect(looksLikeSensitiveCode("938201")).toBe(true);
    expect(looksLikeSensitiveCode("Project 938201")).toBe(false);
  });

  it("catches payment-card numbers, however they are spaced", () => {
    // Luhn-valid test numbers.
    expect(looksLikeSensitiveCode("4111111111111111")).toBe(true);
    expect(looksLikeSensitiveCode("4111 1111 1111 1111")).toBe(true);
    expect(looksLikeSensitiveCode("4111-1111-1111-1111")).toBe(true);
    expect(looksLikeSensitiveCode("378282246310005")).toBe(true); // 15-digit Amex
  });

  it("does not mistake an ordinary long number for a card", () => {
    // Right length, fails the checksum: an order reference, not a card.
    expect(looksLikeSensitiveCode("1234567890123456")).toBe(false);
    expect(looksLikeSensitiveCode("9999 9999 9999 9999")).toBe(false);
  });

  it("catches credentials that announce their issuer", () => {
    expect(looksLikeSensitiveCode("sk-abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksLikeSensitiveCode("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe(true);
    expect(looksLikeSensitiveCode("github_pat_11ABCDEFG0abcdefghijkl")).toBe(true);
    expect(looksLikeSensitiveCode("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSensitiveCode("xoxb-123456789012-abcdefghijkl")).toBe(true);
    expect(looksLikeSensitiveCode("AIzaSyD1234567890abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeSensitiveCode("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true);
    expect(
      looksLikeSensitiveCode("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"),
    ).toBe(true);
  });

  it("finds a credential even when it was copied inside a longer snippet", () => {
    expect(looksLikeSensitiveCode('Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe(true);
  });

  it("leaves ordinary text and code alone", () => {
    for (const ordinary of [
      "hello there",
      "Let's meet at 4pm",
      "const total = price * 1.18;",
      "https://example.com/some/page?ref=42",
      "The order number is 12345",
      "",
      "   ",
    ]) {
      expect(looksLikeSensitiveCode(ordinary), ordinary).toBe(false);
    }
  });
});
