import { describe, it, expect } from "vitest";
import {
  ZONES,
  searchZones,
  findZone,
  convertZone,
  zonedTimeToUtc,
  wallClockAt,
  offsetMinutesAt,
  formatOffset,
  formatTime,
  formatDate,
  dayShiftLabel,
  zoneAbbreviation,
} from "../calctime/timezones";

describe("time zones: data", () => {
  it("uses real IANA identifiers, never fixed offsets", () => {
    for (const z of ZONES) {
      // A zone id the engine cannot resolve would silently fall back to UTC.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: z.id }), z.id).not.toThrow();
      expect(z.id).not.toMatch(/^UTC[+-]/);
    }
  });

  it("has no duplicate zones", () => {
    expect(new Set(ZONES.map((z) => z.id)).size).toBe(ZONES.length);
  });

  it("covers the zones named in the brief", () => {
    for (const id of [
      "Asia/Kolkata",
      "America/New_York",
      "America/Chicago",
      "America/Los_Angeles",
      "Europe/London",
      "Asia/Dubai",
      "Asia/Singapore",
      "Asia/Tokyo",
      "Australia/Sydney",
      "UTC",
    ]) {
      expect(findZone(id), id).toBeDefined();
    }
  });
});

describe("time zones: search", () => {
  it("finds zones by the abbreviations people actually type", () => {
    expect(searchZones("IST")[0].id).toBe("Asia/Kolkata");
    expect(searchZones("PST")[0].id).toBe("America/Los_Angeles");
    expect(searchZones("EST")[0].id).toBe("America/New_York");
    expect(searchZones("GMT")[0].id).toBe("Europe/London");
  });

  it("finds zones by city, country and IANA id", () => {
    expect(searchZones("tokyo")[0].id).toBe("Asia/Tokyo");
    expect(searchZones("india")[0].id).toBe("Asia/Kolkata");
    expect(searchZones("Asia/Dubai")[0].id).toBe("Asia/Dubai");
    expect(searchZones("bengaluru")[0].id).toBe("Asia/Kolkata");
  });

  it("is case-insensitive and returns everything for an empty query", () => {
    expect(searchZones("ToKyO")[0].id).toBe("Asia/Tokyo");
    expect(searchZones("")).toHaveLength(ZONES.length);
    expect(searchZones("   ")).toHaveLength(ZONES.length);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchZones("zzzzz-not-a-place")).toHaveLength(0);
  });
});

describe("time zones: DST-aware conversion", () => {
  it("converts the brief's example: 10:30 PM India -> New York", () => {
    // 22:30 IST on 12 Aug is 13:00 EDT the SAME day (IST +5:30, EDT -4:00).
    const r = convertZone(
      { year: 2026, month: 8, day: 12, hour: 22, minute: 30 },
      "Asia/Kolkata",
      "America/New_York",
    );
    expect(r.wall.hour).toBe(13);
    expect(r.wall.minute).toBe(0);
    expect(r.wall.day).toBe(12);
    expect(r.dayShift).toBe(0);
  });

  it("uses the summer offset in summer and the winter one in winter", () => {
    // This is the whole point of IANA over a fixed offset: same wall clock,
    // different real-world answer depending on the date.
    const summer = convertZone(
      { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
      "Europe/London",
      "America/New_York",
    );
    const winter = convertZone(
      { year: 2026, month: 1, day: 1, hour: 12, minute: 0 },
      "Europe/London",
      "America/New_York",
    );
    // London noon: BST(+1) -> EDT(-4) = 07:00. GMT(0) -> EST(-5) = 07:00.
    expect(summer.wall.hour).toBe(7);
    expect(winter.wall.hour).toBe(7);
    // …but the underlying offsets genuinely differ.
    expect(summer.offsetMinutes).toBe(-240); // EDT
    expect(winter.offsetMinutes).toBe(-300); // EST
  });

  it("gets the US DST transition instants right", () => {
    // 2026: US DST starts 8 Mar, ends 1 Nov.
    const beforeSpring = offsetMinutesAt(Date.UTC(2026, 2, 8, 6, 0), "America/New_York");
    const afterSpring = offsetMinutesAt(Date.UTC(2026, 2, 8, 8, 0), "America/New_York");
    expect(beforeSpring).toBe(-300); // EST
    expect(afterSpring).toBe(-240); // EDT

    const beforeFall = offsetMinutesAt(Date.UTC(2026, 10, 1, 5, 0), "America/New_York");
    const afterFall = offsetMinutesAt(Date.UTC(2026, 10, 1, 7, 0), "America/New_York");
    expect(beforeFall).toBe(-240); // EDT
    expect(afterFall).toBe(-300); // EST
  });

  it("handles zones that never observe DST", () => {
    // India and Brisbane stay put all year.
    expect(offsetMinutesAt(Date.UTC(2026, 0, 15), "Asia/Kolkata")).toBe(330);
    expect(offsetMinutesAt(Date.UTC(2026, 6, 15), "Asia/Kolkata")).toBe(330);
    expect(offsetMinutesAt(Date.UTC(2026, 0, 15), "Australia/Brisbane")).toBe(600);
    expect(offsetMinutesAt(Date.UTC(2026, 6, 15), "Australia/Brisbane")).toBe(600);
  });

  it("reports next-day and previous-day rollovers", () => {
    // Late evening in India is already the next morning in Sydney.
    const forward = convertZone(
      { year: 2026, month: 8, day: 12, hour: 23, minute: 0 },
      "Asia/Kolkata",
      "Australia/Sydney",
    );
    expect(forward.dayShift).toBe(1);
    expect(dayShiftLabel(forward.dayShift)).toBe("next day");

    // Early morning in India is still the previous evening in Los Angeles.
    const back = convertZone(
      { year: 2026, month: 8, day: 12, hour: 6, minute: 0 },
      "Asia/Kolkata",
      "America/Los_Angeles",
    );
    expect(back.dayShift).toBe(-1);
    expect(dayShiftLabel(back.dayShift)).toBe("previous day");
  });

  it("rolls over month and year boundaries correctly", () => {
    const newYear = convertZone(
      { year: 2026, month: 12, day: 31, hour: 23, minute: 30 },
      "Asia/Kolkata",
      "Australia/Sydney",
    );
    expect(newYear.wall.year).toBe(2027);
    expect(newYear.wall.month).toBe(1);
    expect(newYear.wall.day).toBe(1);
    expect(newYear.dayShift).toBe(1);
  });

  it("round-trips a wall clock through UTC and back", () => {
    for (const zone of ["Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Sydney"]) {
      for (const month of [1, 4, 7, 10]) {
        const wall = { year: 2026, month, day: 15, hour: 14, minute: 45 };
        const utc = zonedTimeToUtc(wall, zone);
        const back = wallClockAt(utc, zone);
        expect({ y: back.year, m: back.month, d: back.day, h: back.hour, min: back.minute }).toEqual({
          y: wall.year,
          m: wall.month,
          d: wall.day,
          h: wall.hour,
          min: wall.minute,
        });
      }
    }
  });

  it("survives the skipped hour when clocks spring forward", () => {
    // 02:30 on 8 Mar 2026 does not exist in New York. It must resolve to a
    // real instant rather than NaN or a wild date.
    const r = convertZone(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
      "UTC",
    );
    expect(Number.isFinite(r.utcMs)).toBe(true);
    expect(r.wall.year).toBe(2026);
    expect(r.wall.month).toBe(3);
    expect(r.wall.day).toBe(8);
  });

  it("resolves the repeated hour when clocks fall back", () => {
    // 01:30 on 1 Nov 2026 happens twice in New York; either is defensible, but
    // it must be a real instant on the right date.
    const r = convertZone(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
      "UTC",
    );
    expect(Number.isFinite(r.utcMs)).toBe(true);
    expect(r.wall.day).toBe(1);
    expect([5, 6]).toContain(r.wall.hour); // EDT or EST reading
  });

  it("converts to and from UTC", () => {
    const r = convertZone(
      { year: 2026, month: 8, day: 12, hour: 12, minute: 0 },
      "UTC",
      "Asia/Kolkata",
    );
    expect(r.wall.hour).toBe(17);
    expect(r.wall.minute).toBe(30);
    expect(r.offsetMinutes).toBe(330);
  });

  it("handles half-hour and three-quarter-hour zones", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 6, 1), "Asia/Kolkata")).toBe(330);
    expect(offsetMinutesAt(Date.UTC(2026, 6, 1), "Asia/Kathmandu")).toBe(345);
  });
});

describe("time zones: formatting", () => {
  it("formats offsets", () => {
    expect(formatOffset(330)).toBe("UTC+05:30");
    expect(formatOffset(-240)).toBe("UTC-04:00");
    expect(formatOffset(0)).toBe("UTC+00:00");
    expect(formatOffset(345)).toBe("UTC+05:45");
  });

  it("formats 12- and 24-hour clocks, including the midnight/noon traps", () => {
    const at = (hour: number, minute = 0) => ({ year: 2026, month: 8, day: 12, hour, minute });
    expect(formatTime(at(22, 30), false)).toBe("22:30");
    expect(formatTime(at(22, 30), true)).toBe("10:30 PM");
    expect(formatTime(at(0, 5), true)).toBe("12:05 AM");
    expect(formatTime(at(12, 0), true)).toBe("12:00 PM");
    expect(formatTime(at(0, 0), false)).toBe("00:00");
  });

  it("formats an unambiguous date", () => {
    expect(formatDate({ year: 2026, month: 8, day: 12, hour: 0, minute: 0 })).toBe("Wed, 12 Aug 2026");
  });

  it("reports the engine's zone abbreviation", () => {
    const summer = zoneAbbreviation(Date.UTC(2026, 6, 1), "America/New_York");
    const winter = zoneAbbreviation(Date.UTC(2026, 0, 1), "America/New_York");
    expect(summer).toBe("EDT");
    expect(winter).toBe("EST");
  });

  it("says nothing when the day does not change", () => {
    expect(dayShiftLabel(0)).toBe("");
  });
});
