import { describe, it, expect } from "vitest";
import {
  startFocus,
  startBreak,
  sessionView,
  breakColor,
  formatMMSS,
  focusDrift,
  FOCUS_GREEN,
} from "../productivity/session";

describe("focus / break sessions", () => {
  it("formats mm:ss with a zero-padded seconds field", () => {
    expect(formatMMSS(0)).toBe("0:00");
    expect(formatMMSS(9)).toBe("0:09");
    expect(formatMMSS(65)).toBe("1:05");
    expect(formatMMSS(600)).toBe("10:00");
    expect(formatMMSS(-5)).toBe("0:00"); // never negative
  });

  it("focus counts up from zero on a steady green, no bar", () => {
    const t0 = 1_000_000;
    const s = startFocus(t0);
    const v0 = sessionView(s, t0);
    expect(v0.kind).toBe("focus");
    expect(v0.label).toBe("0:00");
    expect(v0.color).toBe(FOCUS_GREEN);
    expect(v0.fraction).toBe(0);
    expect(v0.text).toBe("#ffffff");
    const v90 = sessionView(s, t0 + 90_000);
    expect(v90.label).toBe("1:30");
    expect(v90.fraction).toBe(0); // focus never shows a progress bar
  });

  it("break counts down and fills its bar as time elapses", () => {
    const t0 = 5_000_000;
    const s = startBreak(10, t0); // 10 minutes = 600 s
    expect(s.durationS).toBe(600);
    const start = sessionView(s, t0);
    expect(start.label).toBe("10:00");
    expect(start.fraction).toBe(0);
    expect(start.overrun).toBe(false);

    const half = sessionView(s, t0 + 300_000); // 5 min in
    expect(half.label).toBe("5:00");
    expect(half.fraction).toBeCloseTo(0.5, 5);
    expect(half.overrun).toBe(false);
  });

  it("break turns red and flags overrun once time is up", () => {
    const t0 = 0;
    const s = startBreak(5, t0); // 300 s
    const done = sessionView(s, t0 + 300_000);
    expect(done.overrun).toBe(true);
    expect(done.label).toBe("0:00");
    expect(done.color).toBe("#c0392b");
    const past = sessionView(s, t0 + 360_000);
    expect(past.overrun).toBe(true);
    expect(past.fraction).toBe(1); // bar stays full, never overflows
  });

  it("break colour ramps green → amber and never past its endpoints", () => {
    const green = breakColor(0, false);
    const amber = breakColor(1, false);
    const red = breakColor(0.5, true);
    expect(green).toBe("rgb(46, 158, 79)"); // start green
    expect(amber).toBe("rgb(212, 160, 23)"); // deep amber at the end
    expect(red).toBe("#c0392b"); // overrun always red regardless of fraction
    // Mid-break sits between the two endpoints (a real interpolation).
    const mid = breakColor(0.5, false);
    expect(mid).toBe("rgb(129, 159, 51)");
    // Out-of-range fractions clamp rather than extrapolating.
    expect(breakColor(-1, false)).toBe(green);
    expect(breakColor(2, false)).toBe(amber);
  });

  it("clamps absurd break lengths into a sane range", () => {
    expect(startBreak(0, 0).durationS).toBe(60); // min 1 min
    expect(startBreak(9999, 0).durationS).toBe(180 * 60); // max 180 min
  });
});

describe("focus mode app guard", () => {
  it("locks onto the first real app, not onto MewMuze itself", () => {
    // Focus mode is started from the cat's right-click menu, so the foreground
    // window at that moment is MewMuze. Locking onto it would guard nothing.
    expect(focusDrift("MewMuze.exe", null)).toEqual({ kind: "ignore" });
    expect(focusDrift("code.exe", null)).toEqual({ kind: "lock", app: "code.exe" });
  });

  it("stays quiet while the guarded app stays in front", () => {
    expect(focusDrift("code.exe", "code.exe")).toEqual({ kind: "ignore" });
    // Case and stray whitespace must not read as a different app.
    expect(focusDrift("CODE.EXE", "code.exe")).toEqual({ kind: "ignore" });
    expect(focusDrift("  code.exe  ", "code.exe")).toEqual({ kind: "ignore" });
  });

  it("reports drift when a different application comes to the front", () => {
    expect(focusDrift("chrome.exe", "code.exe")).toEqual({
      kind: "drift",
      from: "code.exe",
      to: "chrome.exe",
    });
  });

  it("never scolds the user for interacting with the cat", () => {
    // Right-clicking, dragging or opening settings makes MewMuze foreground.
    for (const own of ["MewMuze.exe", "mewmuze.exe", "mewmuze", "pixel-cat-companion.exe"]) {
      expect(focusDrift(own, "code.exe"), `${own} should be ignored`).toEqual({ kind: "ignore" });
    }
  });

  it("ignores having no foreground app at all", () => {
    // The desktop, a lock screen, or a window in the middle of closing.
    expect(focusDrift(null, "code.exe")).toEqual({ kind: "ignore" });
    expect(focusDrift("", "code.exe")).toEqual({ kind: "ignore" });
    expect(focusDrift("   ", "code.exe")).toEqual({ kind: "ignore" });
    // And must not lock onto nothing when the session has just started.
    expect(focusDrift(null, null)).toEqual({ kind: "ignore" });
  });

  it("treats browser tabs as one app, by design", () => {
    // Switching tabs inside Chrome does not change the foreground process, so
    // the guard cannot and deliberately does not react to it.
    expect(focusDrift("chrome.exe", "chrome.exe")).toEqual({ kind: "ignore" });
  });
});
