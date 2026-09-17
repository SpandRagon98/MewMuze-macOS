//! Google Calendar connector (frontend side).
//!
//! Wraps the Rust `calendar_fetch` (fetch + parse the private .ics feed) and
//! owns the pure logic that turns raw event components into a local-time
//! timestamp and decides which upcoming event deserves a warning right now.
//! The Rust side deliberately returns raw Y/M/D/H/M + flags so the timestamp is
//! resolved here, against the machine's real local time zone.

export interface CalEventRaw {
  summary: string;
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  allDay: boolean;
  utc: boolean;
  // ---- added for the Personal Companion; all optional, so the meeting alert
  // above keeps working against a feed that lacks them. ----
  /** iCal UID. Shared by every instance of a recurring series. */
  uid?: string;
  /** From DTEND or DURATION. */
  durationMin?: number;
  location?: string;
  /** An https meeting link from URL, LOCATION or DESCRIPTION. */
  link?: string;
  /** STATUS:CANCELLED. */
  cancelled?: boolean;
  /** An instance expanded from an RRULE, or an override of one. */
  recurring?: boolean;
  /** For an override (RECURRENCE-ID): the slot it was moved from. */
  origYear?: number;
  origMonth?: number;
  origDay?: number;
  origHour?: number;
  origMinute?: number;
}

export interface CalResult {
  ok: boolean;
  error: string | null;
  events: CalEventRaw[];
}

export type CalPhase = "warn" | "due";

export interface CalAlert {
  /** Stable id for de-duping (summary + start). */
  id: string;
  message: string;
  phase: CalPhase;
}

/** How often the App refreshes the calendar feed while connected (ms). */
export const CALENDAR_POLL_MS = 5 * 60_000;
/** An event is "due now" for this long after its start before it stops firing. */
const DUE_GRACE_MS = 5 * 60_000;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;

/** Fetch upcoming events via the backend. Returns null in a non-Tauri context. */
export async function pollCalendar(icsUrl: string): Promise<CalResult | null> {
  try {
    if (!invokeFn) {
      const mod = await import("@tauri-apps/api/core");
      invokeFn = mod.invoke as unknown as Invoke;
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    return await invokeFn("calendar_fetch", { icsUrl, nowUnix });
  } catch {
    return null;
  }
}

/**
 * Resolve an event's start to an epoch-ms in the way the user actually
 * experiences it: UTC events use Date.UTC, everything else (all-day and
 * floating/TZID) is interpreted in the machine's local zone.
 */
export function eventStartMs(e: CalEventRaw): number {
  if (e.utc) return Date.UTC(e.year, e.month - 1, e.day, e.hour, e.minute);
  return new Date(e.year, e.month - 1, e.day, e.allDay ? 0 : e.hour, e.allDay ? 0 : e.minute).getTime();
}

function label(e: CalEventRaw, phase: CalPhase, minutesLeft: number, userName: string): string {
  const hey = userName.trim() ? `${userName.trim()}, ` : "";
  const title = e.summary.trim() || "an event";
  if (phase === "due") return `${hey}${title} is starting now`;
  if (minutesLeft <= 1) return `${hey}${title} in 1 minute`;
  return `${hey}${title} in ${minutesLeft} minutes`;
}

/**
 * The single most urgent event to surface right now, or null. An event enters
 * the "warn" window `earlyWarnMin` before it starts and becomes "due" at start
 * (for a short grace period). Due always outranks warn; ties break on the
 * earlier start.
 */
export function calendarAlert(
  events: CalEventRaw[],
  nowMs: number,
  earlyWarnMin: number,
  userName: string,
): CalAlert | null {
  const warnMs = Math.max(0, earlyWarnMin) * 60_000;
  let best: { alert: CalAlert; rank: number; start: number } | null = null;

  for (const e of events) {
    // All-day events don't get a timed alarm; a cancelled one gets none at all.
    if (e.allDay || e.cancelled) continue;
    const start = eventStartMs(e);
    const delta = start - nowMs; // >0 upcoming, <0 already started
    let phase: CalPhase | null = null;
    if (delta <= 0 && delta > -DUE_GRACE_MS) phase = "due";
    else if (delta > 0 && delta <= warnMs) phase = "warn";
    if (!phase) continue;

    const minutesLeft = Math.max(0, Math.ceil(delta / 60_000));
    const id = `${e.summary}@${start}`;
    const rank = phase === "due" ? 2 : 1;
    if (!best || rank > best.rank || (rank === best.rank && start < best.start)) {
      best = { alert: { id, message: label(e, phase, minutesLeft, userName), phase }, rank, start };
    }
  }
  return best?.alert ?? null;
}
