//! Routine learning - a few rolling averages, kept on this machine.
//!
//! What is recorded: the minute of the day the user first became active, and
//! the last minute they were active, per "routine day" (which starts at 04:00
//! so a late night counts toward the day it began), plus how many minutes they
//! were active. Weekdays and weekends are learned separately.
//!
//! What is never recorded: typed text, key names, screen contents, window
//! titles, websites, documents. Nothing here ever leaves the device.

import { dayKey, localParts } from "./clock";

export interface RollingStat {
  /** Exponentially weighted mean, in minutes since midnight. */
  mean: number;
  /** Exponentially weighted mean absolute deviation. */
  dev: number;
  n: number;
}

export interface RoutineStats {
  weekday: { first: RollingStat; last: RollingStat };
  weekend: { first: RollingStat; last: RollingStat };
  /** The routine day being observed. */
  day: string;
  dayFirst: number | null;
  dayLast: number | null;
  dayActiveMin: number;
  dayIsWeekend: boolean;
  /** Last minute an observation counted, so active minutes are not double-counted. */
  lastObserved: number;
}

const EMPTY_STAT: RollingStat = { mean: 0, dev: 0, n: 0 };
/** How strongly a new day moves the average. ~0.2 remembers about a week. */
const ALPHA = 0.2;
/** A day with less activity than this says nothing about a routine. */
const MIN_ACTIVE_MIN = 45;
/** Days of history before any routine-based remark. */
export const MIN_DAYS = 5;
/** Routine days start at 04:00. */
const DAY_OFFSET_MS = 4 * 3_600_000;

export function emptyRoutine(): RoutineStats {
  return {
    weekday: { first: { ...EMPTY_STAT }, last: { ...EMPTY_STAT } },
    weekend: { first: { ...EMPTY_STAT }, last: { ...EMPTY_STAT } },
    day: "",
    dayFirst: null,
    dayLast: null,
    dayActiveMin: 0,
    dayIsWeekend: false,
    lastObserved: 0,
  };
}

function update(s: RollingStat, x: number): RollingStat {
  if (s.n === 0) return { mean: x, dev: 30, n: 1 };
  const mean = s.mean + ALPHA * (x - s.mean);
  const dev = s.dev + ALPHA * (Math.abs(x - s.mean) - s.dev);
  return { mean, dev, n: s.n + 1 };
}

/** Minutes into the routine day (04:00 = 0 ... 03:59 = 1439), plus which day. */
function routineMinute(now: number, tz: string): { day: string; minute: number; weekend: boolean } {
  const shifted = now - DAY_OFFSET_MS;
  const p = localParts(shifted, tz);
  return { day: dayKey(shifted, tz), minute: p.hour * 60 + p.minute, weekend: p.weekday === 0 || p.weekday === 6 };
}

/** Convert a routine minute back to a wall-clock minute of day. */
export const toWallMinute = (routineMin: number) => (routineMin + 240) % 1440;

/**
 * Record that the user is active at `now`. Call it on real input, at most
 * about once a minute. Returns the updated stats (the input is not mutated).
 */
export function observeActivity(stats: RoutineStats, now: number, tz: string): RoutineStats {
  const r = routineMinute(now, tz);
  let s = stats;
  if (s.day !== r.day) s = rollOver(s, r.day, r.weekend);
  if (now - s.lastObserved < 55_000) return s;
  return {
    ...s,
    dayFirst: s.dayFirst ?? r.minute,
    dayLast: r.minute,
    dayActiveMin: s.dayActiveMin + 1,
    lastObserved: now,
  };
}

/** Fold the finished day into the averages - if it was a real working day. */
function rollOver(s: RoutineStats, newDay: string, weekend: boolean): RoutineStats {
  let next = { ...s };
  if (s.day && s.dayFirst !== null && s.dayLast !== null && s.dayActiveMin >= MIN_ACTIVE_MIN) {
    const bucket = s.dayIsWeekend ? "weekend" : "weekday";
    next = {
      ...next,
      [bucket]: {
        first: update(s[bucket].first, s.dayFirst),
        last: update(s[bucket].last, s.dayLast),
      },
    };
  }
  return { ...next, day: newDay, dayFirst: null, dayLast: null, dayActiveMin: 0, dayIsWeekend: weekend };
}

/**
 * An unusually early start today: well before the learned first-activity time,
 * by at least an hour and at least two typical deviations. Needs a week-ish
 * of history, so it never fires on day two.
 */
export function isEarlyStart(stats: RoutineStats, now: number, tz: string): boolean {
  const r = routineMinute(now, tz);
  if (stats.day !== r.day || stats.dayFirst === null) return false;
  const learned = (r.weekend ? stats.weekend : stats.weekday).first;
  if (learned.n < MIN_DAYS) return false;
  return stats.dayFirst < learned.mean - Math.max(60, 2 * learned.dev);
}

/** The learned finish time as a wall-clock minute of day, or null if not yet known. */
export function typicalFinish(stats: RoutineStats, now: number, tz: string): number | null {
  const r = routineMinute(now, tz);
  const learned = (r.weekend ? stats.weekend : stats.weekday).last;
  return learned.n >= MIN_DAYS ? toWallMinute(Math.round(learned.mean)) : null;
}

/** The learned start time as a wall-clock minute of day, or null. */
export function typicalStart(stats: RoutineStats, now: number, tz: string): number | null {
  const r = routineMinute(now, tz);
  const learned = (r.weekend ? stats.weekend : stats.weekday).first;
  return learned.n >= MIN_DAYS ? toWallMinute(Math.round(learned.mean)) : null;
}

/** Minutes of activity observed so far in the current routine day. */
export function activeMinutesToday(stats: RoutineStats, now: number, tz: string): number {
  return stats.day === routineMinute(now, tz).day ? stats.dayActiveMin : 0;
}
