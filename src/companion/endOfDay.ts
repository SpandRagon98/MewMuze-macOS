//! End of day - a gentle wrap-up, never a report card.
//!
//! Offered once a day, when the user seems to be finishing: at the end of
//! their work hours if they set them, otherwise around the time they usually
//! finish (once routine learning knows it). Only after a real day's activity,
//! so a quick evening check of email does not get a "wrapping up" message.
//! It lists what happened and what is next. No scores, no judgement.

import { dayKey, minuteOfDay } from "./clock";
import type { WorkHours } from "./profile";

/** Activity needed before a day counts as a working day worth wrapping up. */
export const MIN_ACTIVE_FOR_WRAP_MIN = 120;

export function wrapUpDue(opts: {
  now: number;
  tz: string;
  work: WorkHours;
  typicalFinishMin: number | null;
  activeMinToday: number;
  lastWrapDay: string;
}): boolean {
  const { now, tz, work, typicalFinishMin, activeMinToday, lastWrapDay } = opts;
  if (dayKey(now, tz) === lastWrapDay) return false;
  if (activeMinToday < MIN_ACTIVE_FOR_WRAP_MIN) return false;
  const minute = minuteOfDay(now, tz);
  if (minute >= 23 * 60) return false; // too late to be "wrapping up"
  const finish = work.enabled ? work.end : typicalFinishMin;
  if (finish === null) return false;
  return minute >= finish - 15 && minute < finish + 180;
}

export interface DayCounts {
  focusSessions: number;
  remindersDone: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function wrapUpLines(counts: DayCounts, tomorrowFirst: string | null): string[] {
  const lines: string[] = [];
  if (counts.focusSessions > 0) lines.push(`${plural(counts.focusSessions, "focus session", "focus sessions")} completed`);
  if (counts.remindersDone > 0) lines.push(`${plural(counts.remindersDone, "reminder", "reminders")} finished`);
  if (tomorrowFirst) lines.push(tomorrowFirst);
  return lines;
}
