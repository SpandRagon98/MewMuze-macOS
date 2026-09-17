//! Calendar companion: understanding the day, not just the next alarm.
//!
//! Reuses the existing private-ICS integration. The feed is parsed in Rust
//! (now with UID, duration, location, meeting link, cancellation and recurrence
//! expansion); everything here is pure logic over the resulting meetings:
//! today's schedule, the next meeting, free windows, back-to-back runs,
//! tomorrow's first event, and what CHANGED since the last fetch.
//!
//! Nothing here ever writes to the calendar.

import { eventStartMs, type CalEventRaw } from "../integrations/calendar";
import { dayKey, formatSpokenClock, localParts, minuteOfDay, startOfLocalDay } from "./clock";

export interface Meeting {
  /** UID when the feed has one, otherwise title@start. */
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  /** An https meeting link, or "". */
  link: string;
  cancelled: boolean;
  /** For a moved instance of a recurring meeting: where it used to be. */
  movedFrom: number | null;
}

const MIN = 60_000;
/** Assumed length when the feed gives none. */
const DEFAULT_DURATION_MIN = 30;

export function toMeetings(events: CalEventRaw[]): Meeting[] {
  return events
    .map((e) => {
      const start = eventStartMs(e);
      const dur = e.allDay ? 24 * 60 : e.durationMin && e.durationMin > 0 ? e.durationMin : DEFAULT_DURATION_MIN;
      const moved =
        e.origYear && e.origMonth && e.origDay
          ? eventStartMs({
              ...e,
              year: e.origYear,
              month: e.origMonth,
              day: e.origDay,
              hour: e.origHour ?? 0,
              minute: e.origMinute ?? 0,
            })
          : null;
      return {
        // A one-off event's UID is unique on its own, and must stay the same
        // when it is moved - suffixing the start would turn "moved to 4:30"
        // into "cancelled". Only instances of a recurring series share a UID,
        // so those are told apart by their ORIGINAL slot, which a move keeps.
        id: e.uid ? (e.recurring ? `${e.uid}@${moved ?? start}` : e.uid) : `${e.summary}@${start}`,
        title: e.summary.trim() || "Untitled event",
        start,
        end: start + dur * MIN,
        allDay: e.allDay,
        location: e.location ?? "",
        link: e.link ?? "",
        cancelled: e.cancelled === true,
        movedFrom: moved !== null && moved !== start ? moved : null,
      } satisfies Meeting;
    })
    .sort((a, b) => a.start - b.start);
}

/** Timed, not cancelled meetings on the local day of `day`. */
export function meetingsOn(meetings: Meeting[], day: number, tz: string): Meeting[] {
  const key = dayKey(day, tz);
  return meetings.filter((m) => !m.allDay && !m.cancelled && dayKey(m.start, tz) === key);
}

export function nextMeeting(meetings: Meeting[], now: number): Meeting | null {
  return meetings.find((m) => !m.allDay && !m.cancelled && m.start > now) ?? null;
}

export function tomorrowFirst(meetings: Meeting[], now: number, tz: string): Meeting | null {
  return meetingsOn(meetings, now + 24 * 3_600_000, tz)[0] ?? null;
}

export interface FreeWindow {
  start: number;
  end: number;
}

/**
 * Gaps of at least `minMin` minutes between now and the end of the working
 * day. With no work hours set, the day is 9:00-18:00 - a gap at 23:00 is not
 * a "free window" anyone was asking about.
 */
export function freeWindows(
  meetings: Meeting[],
  now: number,
  tz: string,
  work: { start: number; end: number } | null,
  minMin = 60,
): FreeWindow[] {
  const dayStart = startOfLocalDay(now, tz);
  const ws = work?.start ?? 9 * 60;
  const we = work?.end ?? 18 * 60;
  if (we <= ws) return [];
  const from = Math.max(now, dayStart + ws * MIN);
  const to = dayStart + we * MIN;
  if (from >= to) return [];
  const busy = meetingsOn(meetings, now, tz).filter((m) => m.end > from && m.start < to);
  const out: FreeWindow[] = [];
  let cursor = from;
  for (const m of busy) {
    if (m.start - cursor >= minMin * MIN) out.push({ start: cursor, end: m.start });
    cursor = Math.max(cursor, m.end);
  }
  if (to - cursor >= minMin * MIN) out.push({ start: cursor, end: to });
  return out;
}

/** Three or more meetings still to come today, each starting within 10 minutes of the last ending. */
export function backToBack(meetings: Meeting[], now: number, tz: string): Meeting[] | null {
  const today = meetingsOn(meetings, now, tz).filter((m) => m.end > now);
  let run: Meeting[] = [];
  let best: Meeting[] = [];
  for (const m of today) {
    const prev = run[run.length - 1];
    run = prev && m.start - prev.end <= 10 * MIN ? [...run, m] : [m];
    if (run.length > best.length) best = run;
  }
  return best.length >= 3 ? best : null;
}

// ---- change detection ------------------------------------------------------

export interface CalendarSnapshot {
  /** id -> start and whether it was cancelled, for upcoming meetings only. */
  byId: Record<string, { start: number; title: string; cancelled: boolean }>;
  takenAt: number;
}

export interface CalendarChange {
  kind: "moved" | "cancelled";
  meeting: Meeting;
  /** For a move: the old start. */
  from?: number;
}

/**
 * What changed since the last fetch that the user would want to hear about.
 *
 * The very first fetch reports nothing: without a previous snapshot, "moved"
 * would announce a change from last week as news. A meeting that simply
 * disappeared only counts as cancelled while it sat well inside the fetch
 * window - near the edge it may just have slid out.
 */
export function diffCalendar(
  prev: CalendarSnapshot | null,
  meetings: Meeting[],
  now: number,
): { changes: CalendarChange[]; snapshot: CalendarSnapshot } {
  const upcoming = meetings.filter((m) => !m.allDay && m.end > now);
  const byId: CalendarSnapshot["byId"] = {};
  // Recurring instances are keyed by their ORIGINAL slot, so a moved instance
  // keeps the same id before and after the move.
  for (const m of upcoming) byId[m.id] = { start: m.start, title: m.title, cancelled: m.cancelled };
  const snapshot = { byId, takenAt: now };
  if (!prev) return { changes: [], snapshot };

  const changes: CalendarChange[] = [];
  const seen = new Set<string>();
  for (const m of upcoming) {
    seen.add(m.id);
    const before = prev.byId[m.id];
    if (!before) continue;
    if (m.cancelled && !before.cancelled) {
      changes.push({ kind: "cancelled", meeting: m });
    } else if (!m.cancelled && Math.abs(m.start - before.start) >= 5 * MIN && m.start > now) {
      changes.push({ kind: "moved", meeting: m, from: before.start });
    }
  }
  for (const [id, before] of Object.entries(prev.byId)) {
    if (seen.has(id) || before.cancelled) continue;
    const safelyInside = before.start > now + 15 * MIN && before.start < now + 36 * 3_600_000;
    if (safelyInside) {
      changes.push({
        kind: "cancelled",
        meeting: { id, title: before.title, start: before.start, end: before.start, allDay: false, location: "", link: "", cancelled: true, movedFrom: null },
      });
    }
  }
  return { changes, snapshot };
}

// ---- words -----------------------------------------------------------------

export function describeChange(c: CalendarChange, h12: boolean, tz: string): string {
  const title = c.meeting.title;
  const at = formatSpokenClock(c.meeting.start, h12, tz);
  if (c.kind === "cancelled") return `${title} (${at}) was cancelled.`;
  const from = formatSpokenClock(c.from ?? c.meeting.start, h12, tz);
  const sameDay = dayKey(c.from ?? c.meeting.start, tz) === dayKey(c.meeting.start, tz);
  return sameDay ? `${title} moved from ${from} to ${at}.` : `${title} moved to ${weekdayName(c.meeting.start, tz)} at ${at}.`;
}

export function describeBackToBack(run: Meeting[], now: number, tz: string): string {
  const words = ["", "", "", "three", "four", "five", "six"];
  const count = words[run.length] ?? String(run.length);
  const hour = localParts(run[0].start, tz).hour;
  const when = hour >= 17 ? "this evening" : hour >= 12 ? "this afternoon" : minuteOfDay(now, tz) < 12 * 60 ? "this morning" : "today";
  return `You have ${count} meetings back-to-back ${when}.`;
}

export function describeTomorrowFirst(m: Meeting, h12: boolean, tz: string): string {
  return `Tomorrow's first meeting: ${m.title} at ${formatSpokenClock(m.start, h12, tz)}.`;
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayName(ms: number, tz: string): string {
  return WEEKDAY[localParts(ms, tz).weekday];
}

/** Google Calendar's day view - the "Open Calendar" action. Read-only. */
export const CALENDAR_DAY_URL = "https://calendar.google.com/calendar/r/day";
