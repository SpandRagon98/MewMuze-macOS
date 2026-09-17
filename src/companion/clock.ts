//! Local time, the way the user actually lives it.
//!
//! Everything is resolved through `Intl` against an IANA time zone - the
//! system's own by default - so daylight saving, half-hour zones and date
//! boundaries all come from the platform's tz database. There is no hard-coded
//! offset anywhere in the companion.
//!
//! Every function takes the zone explicitly (defaulting to the system zone), so
//! tests can pin a zone and a DST-boundary instant and get the same answer on
//! any machine.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

export type DayPart = "morning" | "afternoon" | "evening" | "late";

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The machine's IANA zone, e.g. "Asia/Kolkata". */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // Built once per zone: constructing a DateTimeFormat is far more expensive
    // than formatting with one.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Calendar fields of `ms` as seen on a wall clock in `tz`. */
export function localParts(ms: number, tz: string = systemTimeZone()): LocalParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Some engines render midnight as "24" even with h23; normalise it.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(out.weekday)),
  };
}

/** A stable key for the local calendar day: "2026-09-10". */
export function dayKey(ms: number, tz: string = systemTimeZone()): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
export function minuteOfDay(ms: number, tz: string = systemTimeZone()): number {
  const p = localParts(ms, tz);
  return p.hour * 60 + p.minute;
}

/**
 * Which part of the day an hour belongs to.
 *
 * "late" covers 22:00-04:59 - late enough that "good evening" would be odd,
 * early enough that "good morning" would be a lie.
 */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "late";
}

/** "5:00 PM" or "17:00", in the given zone. */
export function formatClock(ms: number, h12: boolean, tz: string = systemTimeZone()): string {
  const { hour, minute } = localParts(ms, tz);
  const mm = String(minute).padStart(2, "0");
  if (!h12) return `${String(hour).padStart(2, "0")}:${mm}`;
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}

/** "5 PM" when on the hour, otherwise the full clock - how people say times. */
export function formatSpokenClock(ms: number, h12: boolean, tz: string = systemTimeZone()): string {
  const { hour, minute } = localParts(ms, tz);
  if (!h12 || minute !== 0) return formatClock(ms, h12, tz);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * The instant local midnight begins for the day containing `ms`.
 *
 * Found by search rather than arithmetic: a day in a DST zone can be 23 or 25
 * hours long, so "ms minus hours*3600000" lands on the wrong instant twice a
 * year.
 */
export function startOfLocalDay(ms: number, tz: string = systemTimeZone()): number {
  const target = dayKey(ms, tz);
  let t = ms - minuteOfDay(ms, tz) * 60_000 - (ms % 60_000);
  // Step back an hour at a time until the previous instant is on another day,
  // then forward a minute at a time to the exact boundary.
  for (let i = 0; i < 3 && dayKey(t - 1, tz) === target; i++) t -= 3_600_000;
  while (dayKey(t, tz) !== target) t += 60_000;
  while (dayKey(t - 60_000, tz) === target) t -= 60_000;
  return t;
}

/** Whole calendar days from the day of `a` to the day of `b` (b - a). */
export function daysBetween(a: number, b: number, tz: string = systemTimeZone()): number {
  const pa = localParts(a, tz);
  const pb = localParts(b, tz);
  const da = Date.UTC(pa.year, pa.month - 1, pa.day);
  const db = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((db - da) / 86_400_000);
}

/**
 * Minutes a zone is ahead of another at an instant, DST included. Positive
 * means `zone` is ahead of `from`.
 */
export function zoneOffsetMinutes(ms: number, zone: string, from: string = systemTimeZone()): number {
  const wall = (tz: string) => {
    const p = localParts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  return Math.round((wall(zone) - wall(from)) / 60_000);
}
