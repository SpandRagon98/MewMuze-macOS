import { describe, expect, it } from "vitest";
import {
  adaptActivity,
  busyAt,
  daysLearned,
  emptyHabits,
  MIN_DAYS,
  observe,
  parseHabits,
  quietHours,
  rhythmNote,
  type HabitProfile,
} from "../companion/habits";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";

const BALANCED = ACTIVITY_PROFILES.balanced;

/** Live an hour: `samples` minutes of it, `busy` of them working. */
function liveHour(h: HabitProfile, hour: number, busyRatio: number, played = false, samples = 20): HabitProfile {
  let out = h;
  for (let i = 0; i < samples; i++) {
    out = observe(out, { hour, busy: i < Math.round(busyRatio * samples), played: played && i === 0 });
  }
  return out;
}

/** Repeat one hour over `days` days (each day closed by passing through another hour). */
function repeatDays(hour: number, busyRatio: number, days: number, played = false): HabitProfile {
  let h = emptyHabits();
  for (let d = 0; d < days; d++) {
    h = liveHour(h, hour, busyRatio, played);
    h = liveHour(h, (hour + 1) % 24, 0, false, 10); // closes the hour above
  }
  return h;
}

describe("habits: learning", () => {
  it("says nothing until an hour has a few days behind it", () => {
    const h = repeatDays(10, 1, MIN_DAYS - 1);
    expect(busyAt(h, 10)).toBeNull();
    expect(adaptActivity(BALANCED, h, 10)).toEqual(BALANCED);
    expect(rhythmNote(h, 10)).toBeNull();
  });

  it("learns the hours you are heads-down", () => {
    const h = repeatDays(10, 0.9, MIN_DAYS);
    expect(daysLearned(h)).toBeGreaterThanOrEqual(MIN_DAYS);
    expect(busyAt(h, 10)!).toBeGreaterThan(0.7);
    expect(quietHours(h)).toContain(10);
    // An hour never lived is still unknown, not "free".
    expect(busyAt(h, 3)).toBeNull();
  });

  it("ignores an hour with barely any evidence in it", () => {
    let h = emptyHabits();
    for (let d = 0; d < 5; d++) {
      h = observe(h, { hour: 9, busy: true, played: false }); // one lonely minute
      h = liveHour(h, 10, 0, false, 10);
    }
    expect(busyAt(h, 9)).toBeNull();
  });

  it("keeps the averages inside 0..1 and never counts text", () => {
    const h = repeatDays(14, 1, 6);
    expect(h.hours.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(Object.keys(emptyHabits())).toEqual(["v", "hours", "seen", "play", "hour", "samples", "busySamples", "playSamples"]);
  });
});

describe("habits: adapting the cat", () => {
  it("settles the cat down in hours you are usually working", () => {
    const h = repeatDays(11, 0.9, MIN_DAYS);
    const a = adaptActivity(BALANCED, h, 11);
    expect(a.playfulness).toBeLessThan(BALANCED.playfulness);
    expect(a.chaseEagerness).toBeLessThan(BALANCED.chaseEagerness);
    expect(a.restfulness).toBeGreaterThan(BALANCED.restfulness);
  });

  it("is livelier in free hours you actually spend with it", () => {
    const h = repeatDays(20, 0.05, MIN_DAYS, true);
    const a = adaptActivity(BALANCED, h, 20);
    expect(a.playfulness).toBeGreaterThan(BALANCED.playfulness);
    expect(a.restfulness).toBeLessThan(BALANCED.restfulness);
  });

  it("stays calm in a free hour you never play in", () => {
    const h = repeatDays(20, 0.05, MIN_DAYS, false);
    expect(adaptActivity(BALANCED, h, 20)).toEqual(BALANCED);
  });

  it("leans the user's setting, never overrules it", () => {
    const busyH = repeatDays(11, 1, 8);
    const freeH = repeatDays(20, 0, 8, true);
    for (const level of ["calm", "balanced", "playful"] as const) {
      const base = ACTIVITY_PROFILES[level];
      for (const [h, hour] of [[busyH, 11] as const, [freeH, 20] as const]) {
        const a = adaptActivity(base, h, hour);
        for (const k of ["playfulness", "chaseEagerness", "restfulness"] as const) {
          expect(a[k]).toBeGreaterThanOrEqual(base[k] * 0.5 - 1e-9);
          expect(a[k]).toBeLessThanOrEqual(base[k] * 1.5 + 1e-9);
        }
      }
    }
    // A calm cat in a free hour is still calmer than a playful cat working.
    expect(adaptActivity(ACTIVITY_PROFILES.calm, freeH, 20).playfulness).toBeLessThan(
      adaptActivity(ACTIVITY_PROFILES.playful, busyH, 11).playfulness,
    );
  });

  it("tells Local Chat about the hour, in one background line", () => {
    expect(rhythmNote(repeatDays(11, 0.95, MIN_DAYS), 11)).toContain("deep in work");
    expect(rhythmNote(repeatDays(21, 0, MIN_DAYS), 21)).toContain("usually free");
    // A middling hour says nothing rather than guessing.
    expect(rhythmNote(repeatDays(15, 0.4, MIN_DAYS), 15)).toBeNull();
  });
});

describe("habits: storage", () => {
  it("survives a damaged or foreign file without losing the shape", () => {
    expect(parseHabits(null)).toEqual(emptyHabits());
    expect(parseHabits("nonsense")).toEqual(emptyHabits());
    expect(parseHabits({ hours: "no", seen: 5, play: 99, hour: 41 })).toMatchObject({
      hours: emptyHabits().hours,
      play: 1,
      hour: 23,
    });
  });

  it("round-trips what it learned", () => {
    const h = repeatDays(9, 0.8, 4);
    const back = parseHabits(JSON.parse(JSON.stringify(h)));
    expect(busyAt(back, 9)).toBeCloseTo(busyAt(h, 9)!, 6);
  });
});
