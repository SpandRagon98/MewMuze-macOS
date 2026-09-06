import type { CustomReminder, ReminderConfig } from "../settings/defaultSettings";

/**
 * Pure interval-reminder scheduler (stretch, water, custom messages).
 * Time is injected in seconds; callers poll `due(now)` and use snooze/dismiss.
 * Reminders are suppressed while a full-screen app is active (the caller
 * passes that flag) so presentations are never interrupted.
 */

export interface DueReminder {
  id: string;
  kind: "stretch" | "water" | "custom";
  message: string;
}

interface Tracked {
  id: string;
  kind: DueReminder["kind"];
  message: string;
  intervalS: number;
  nextAt: number;
}

const SNOOZE_S = 5 * 60;

export class ReminderScheduler {
  private tracked: Tracked[] = [];
  private active: DueReminder | null = null;

  configure(
    stretch: ReminderConfig,
    water: ReminderConfig,
    custom: CustomReminder[],
    userName: string,
    now: number,
  ): void {
    const name = userName.trim();
    const hey = name ? `${name}, ` : "";
    const wanted: Omit<Tracked, "nextAt">[] = [];
    if (stretch.enabled) {
      wanted.push({
        id: "stretch",
        kind: "stretch",
        message: `${hey}time to stretch!`,
        intervalS: stretch.intervalMin * 60,
      });
    }
    if (water.enabled) {
      wanted.push({
        id: "water",
        kind: "water",
        message: `${hey}please drink some water.`,
        intervalS: water.intervalMin * 60,
      });
    }
    for (const c of custom) {
      if (c.enabled) wanted.push({ id: c.id, kind: "custom", message: c.message, intervalS: c.intervalMin * 60 });
    }
    // Preserve existing schedules; add new; drop removed.
    this.tracked = wanted.map((w) => {
      const existing = this.tracked.find((t) => t.id === w.id && t.intervalS === w.intervalS);
      return { ...w, nextAt: existing ? existing.nextAt : now + w.intervalS };
    });
    if (this.active && !this.tracked.some((t) => t.id === this.active?.id)) this.active = null;
  }

  /**
   * Poll for a due reminder. Only one is surfaced at a time; while one is
   * active the others keep their schedule (they fire after dismissal).
   *
   * The full-screen check comes FIRST, before the active reminder is returned.
   * The other way round, a reminder that had already surfaced kept being handed
   * back throughout a film or a presentation — the one situation the flag
   * exists to protect. `active` is deliberately left set, so the moment full
   * screen ends the same reminder comes back rather than being lost.
   */
  due(now: number, fullScreenActive: boolean): DueReminder | null {
    if (fullScreenActive) return null;
    if (this.active) return this.active;
    for (const t of this.tracked) {
      if (now >= t.nextAt) {
        this.active = { id: t.id, kind: t.kind, message: t.message };
        return this.active;
      }
    }
    return null;
  }

  /**
   * The reminder currently surfaced, if any. Lets the caller recognise its own
   * notice — to take it off screen when a full-screen app starts, without
   * touching the schedule, so `due()` hands the same one back afterwards.
   */
  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  dismiss(id: string, now: number): void {
    const t = this.tracked.find((x) => x.id === id);
    if (t) t.nextAt = now + t.intervalS;
    if (this.active?.id === id) this.active = null;
  }

  snooze(id: string, now: number): void {
    const t = this.tracked.find((x) => x.id === id);
    if (t) t.nextAt = now + SNOOZE_S;
    if (this.active?.id === id) this.active = null;
  }
}
