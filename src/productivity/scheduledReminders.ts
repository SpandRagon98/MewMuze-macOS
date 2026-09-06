import type { ScheduledReminder } from "../settings/defaultSettings";

/**
 * Date/time reminders ("Stakeholder Meeting at 8:30 PM") with an optional
 * early warning. Pure functions over wall-clock unix seconds so the whole
 * lifecycle — warn window, due, snooze, complete — is unit-testable.
 *
 * Lifecycle of one reminder:
 *   upcoming ──(dueUnix - earlyWarnMin*60)──▶ warn ──(dueUnix)──▶ due
 * Snoozing while due hides it for SNOOZE_S then it returns (still due).
 * Dismiss and Mark Complete both retire it (kept, flagged, for the panel).
 */

export const SNOOZE_S = 5 * 60;
/** A reminder more than a day past due is stale; retire it silently. */
const EXPIRE_S = 24 * 3600;

export type ReminderPhase = "warn" | "due";

export interface ActiveScheduled {
  id: string;
  phase: ReminderPhase;
  message: string;
}

/** "Spandan, Stakeholder Meeting in 5 minutes." / "…is now. Please join." */
export function scheduledMessage(title: string, phase: ReminderPhase, minutesLeft: number, userName: string): string {
  const hey = userName.trim() ? `${userName.trim()}, ` : "";
  if (phase === "due") return `${hey}${title} is now. Please join.`;
  const m = Math.max(1, minutesLeft);
  return `${hey}${title} in ${m} minute${m === 1 ? "" : "s"}.`;
}

/**
 * The single reminder to surface right now, most urgent first (due beats
 * warn; earlier due time beats later). Returns null when nothing is active.
 */
export function activeScheduled(
  reminders: ScheduledReminder[],
  nowUnix: number,
  userName: string,
): ActiveScheduled | null {
  let best: { r: ScheduledReminder; phase: ReminderPhase } | null = null;
  for (const r of reminders) {
    if (r.done) continue;
    if (nowUnix - r.dueUnix > EXPIRE_S) continue;
    if (r.snoozedUntil && nowUnix < r.snoozedUntil) continue;
    const warnAt = r.dueUnix - r.earlyWarnMin * 60;
    const phase: ReminderPhase | null =
      nowUnix >= r.dueUnix ? "due" : r.earlyWarnMin > 0 && nowUnix >= warnAt ? "warn" : null;
    if (!phase) continue;
    if (
      !best ||
      (phase === "due" && best.phase !== "due") ||
      (phase === best.phase && r.dueUnix < best.r.dueUnix)
    ) {
      best = { r, phase };
    }
  }
  if (!best) return null;
  const minutesLeft = Math.ceil((best.r.dueUnix - nowUnix) / 60);
  return {
    id: best.r.id,
    phase: best.phase,
    message: scheduledMessage(best.r.title, best.phase, minutesLeft, userName),
  };
}

/** Snooze: hide for five minutes (works in both warn and due phases). */
export function snoozeScheduled(reminders: ScheduledReminder[], id: string, nowUnix: number): ScheduledReminder[] {
  return reminders.map((r) => (r.id === id ? { ...r, snoozedUntil: nowUnix + SNOOZE_S } : r));
}

/** Dismiss / Mark Complete both retire the reminder. */
export function completeScheduled(reminders: ScheduledReminder[], id: string): ScheduledReminder[] {
  return reminders.map((r) => (r.id === id ? { ...r, done: true } : r));
}

/** Drop retired and long-past reminders so settings never grow unbounded. */
export function pruneScheduled(reminders: ScheduledReminder[], nowUnix: number): ScheduledReminder[] {
  return reminders.filter((r) => !r.done && nowUnix - r.dueUnix <= EXPIRE_S);
}

/** Build a reminder from the Set Reminder panel's fields. */
export function makeScheduled(title: string, dateStr: string, timeStr: string, earlyWarnMin: number): ScheduledReminder | null {
  const t = title.trim();
  if (!t || !dateStr || !timeStr) return null;
  const due = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(due.getTime())) return null;
  return {
    id: `sch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    title: t.slice(0, 60),
    dueUnix: Math.floor(due.getTime() / 1000),
    earlyWarnMin,
    snoozedUntil: 0,
    done: false,
  };
}
