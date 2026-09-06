import { describe, it, expect } from "vitest";
import { Pomodoro, formatTimer } from "../productivity/pomodoro";

const config = { enabled: true, focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLongBreak: 2 };

describe("Pomodoro", () => {
  it("starts idle and enters focus on start", () => {
    const p = new Pomodoro(config);
    expect(p.tick(0).phase).toBe("idle");
    p.start(0);
    const snap = p.tick(1);
    expect(snap.phase).toBe("focus");
    expect(snap.remaining).toBeCloseTo(25 * 60 - 1, 0);
  });

  it("rolls focus → short break → focus and reports completions", () => {
    const p = new Pomodoro(config);
    p.start(0);
    let snap = p.tick(25 * 60 + 1);
    expect(snap.completed).toBe("focus");
    expect(snap.phase).toBe("shortBreak");
    snap = p.tick(25 * 60 + 5 * 60 + 2);
    expect(snap.completed).toBe("shortBreak");
    expect(snap.phase).toBe("focus");
  });

  it("takes a long break after the configured cycles", () => {
    const p = new Pomodoro(config);
    p.start(0);
    let t = 25 * 60 + 1;
    let snap = p.tick(t); // cycle 1 done -> short break
    t += 5 * 60 + 1;
    snap = p.tick(t); // back to focus
    t += 25 * 60 + 1;
    snap = p.tick(t); // cycle 2 done -> long break
    expect(snap.phase).toBe("longBreak");
  });

  it("pause freezes remaining time; resume continues", () => {
    const p = new Pomodoro(config);
    p.start(0);
    p.tick(60);
    p.pause(60);
    const paused = p.tick(600);
    expect(paused.phase).toBe("paused");
    expect(paused.remaining).toBeCloseTo(24 * 60, 0);
    p.resume(600);
    const resumed = p.tick(660);
    expect(resumed.phase).toBe("focus");
    expect(resumed.remaining).toBeCloseTo(24 * 60 - 60, 0);
  });

  it("skip completes the current phase; reset returns to idle", () => {
    const p = new Pomodoro(config);
    p.start(0);
    p.skip(10);
    expect(p.tick(11).phase).toBe("shortBreak");
    p.reset();
    expect(p.tick(12).phase).toBe("idle");
  });

  it("formats timers as m:ss", () => {
    expect(formatTimer(65)).toBe("1:05");
    expect(formatTimer(0)).toBe("0:00");
    // Never render a broken clock: a negative or non-finite value reads as
    // "no time left", the same way formatMMSS has always behaved.
    expect(formatTimer(-5)).toBe("0:00");
    expect(formatTimer(-90)).toBe("0:00");
    expect(formatTimer(NaN)).toBe("0:00");
    expect(formatTimer(Infinity)).toBe("0:00");
  });
});
