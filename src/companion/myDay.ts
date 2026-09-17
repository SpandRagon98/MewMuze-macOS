//! My Day - the whole day on one small card. Deterministic, no model.
//!
//!   Good morning, Sandy.
//!   27°C, partly cloudy · Rain after 5 PM
//!   4 meetings today · First at 10:30 AM
//!   2 important emails
//!   3 reminders
//!   90-minute free window before lunch
//!
//! Every line is optional and only appears when there is something true to
//! say. Nothing is padded out to look busy.

import { formatSpokenClock, localParts } from "./clock";
import { freeWindows, meetingsOn, nextMeeting, type Meeting } from "./calendarCompanion";
import type { DueDate } from "./dates";

export interface MyDayInput {
  now: number;
  tz: string;
  h12: boolean;
  greeting: string;
  weather: { now: string; later: string | null } | null;
  /** null = calendar not connected (then no meeting line at all). */
  meetings: Meeting[] | null;
  work: { start: number; end: number } | null;
  /** null = Gmail not connected. */
  importantMail: number | null;
  unreadMail: number | null;
  remindersToday: number;
  dates: DueDate[];
  dateLine: (d: DueDate) => string;
}

const MIN = 60_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function windowLabel(start: number, end: number, now: number, tz: string, h12: boolean): string {
  const mins = Math.round((end - start) / MIN);
  const size = mins >= 120 && mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-minute`;
  const startHour = localParts(start, tz).hour;
  const endHour = localParts(end, tz).hour + localParts(end, tz).minute / 60;
  // "before lunch" only when the window genuinely ends around midday.
  if (startHour < 12 && endHour <= 13 && endHour >= 11.5) return `${size} free window before lunch`;
  if (start <= now + 5 * MIN) return `${size} free window now`;
  return `${size} free window at ${formatSpokenClock(start, h12, tz)}`;
}

export function myDayLines(d: MyDayInput): string[] {
  const lines = [d.greeting];

  if (d.weather) lines.push(d.weather.later ? `${d.weather.now} · ${d.weather.later}` : d.weather.now);

  if (d.meetings) {
    const today = meetingsOn(d.meetings, d.now, d.tz);
    const ahead = today.filter((m) => m.start > d.now);
    if (today.length === 0) {
      lines.push("No meetings today");
    } else if (ahead.length === 0) {
      lines.push(`${plural(today.length, "meeting")} today · all done`);
    } else {
      const next = nextMeeting(ahead, d.now);
      const first = ahead.length === today.length ? "First" : "Next";
      lines.push(`${plural(today.length, "meeting")} today · ${first} at ${formatSpokenClock(next!.start, d.h12, d.tz)}`);
    }
    const free = freeWindows(d.meetings, d.now, d.tz, d.work, 60);
    if (free.length && today.length) {
      const best = free.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      lines.push(windowLabel(best.start, best.end, d.now, d.tz, d.h12));
    }
  }

  if (d.importantMail !== null && d.importantMail > 0) {
    lines.push(plural(d.importantMail, "important email"));
  } else if (d.unreadMail !== null && d.unreadMail > 0) {
    lines.push(plural(d.unreadMail, "unread email"));
  }

  if (d.remindersToday > 0) lines.push(plural(d.remindersToday, "reminder"));
  for (const due of d.dates) lines.push(d.dateLine(due));

  // The greeting plus at most six facts - it is a glance, not a report.
  return lines.slice(0, 7);
}
