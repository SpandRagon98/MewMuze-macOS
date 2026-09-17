//! SmartNotificationEngine - the one gate every companion event goes through.
//!
//!   EVENT -> meaningful? -> still relevant? -> already said? -> user busy?
//!                                                                  |-> queue
//!                                                                  v
//!                                                           show / ignore
//!
//! "Meaningful" is decided by whoever raises the event (a weather detector
//! only submits a rain warning when rain is actually coming). Everything after
//! that lives here, once, instead of in every feature: priorities, cooldowns,
//! de-duplication, Focus suppression, the full-screen queue, quiet hours,
//! grouping, an hourly cap, and backing off kinds the user keeps dismissing.

import type { AnimationName } from "../types/cat";

export type Priority = "low" | "normal" | "high" | "urgent";
export type NoteKind =
  | "greeting"
  | "weather"
  | "calendar"
  | "mail"
  | "away"
  | "endOfDay"
  | "routine"
  | "date"
  | "travel"
  | "news"
  | "watch"
  | "system";

const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export interface NoteAction {
  id: string;
  label: string;
  /** Opened in the browser when chosen (a meeting link, the calendar). */
  href?: string;
}

export interface CompanionNote {
  /** Stable de-duplication key: the same fact always produces the same id. */
  id: string;
  kind: NoteKind;
  priority: Priority;
  /** First line is the headline; more lines make it a card. */
  lines: string[];
  actions?: NoteAction[];
  /** Cat reaction to play when shown. */
  cat?: AnimationName;
  /** Queued notes sharing a group are merged into one card. */
  group?: string;
  createdAt: number;
  /** Drop it if it could not be shown before this. */
  expiresAt?: number;
  /** While the user is away, hold it for the recap instead of the bubble. */
  recap?: boolean;
}

export interface NotifyContext {
  now: number;
  focus: boolean;
  fullscreen: boolean;
  quiet: boolean;
  /** Something else (a reminder, a calendar alert) holds the one bubble. */
  slotBusy: boolean;
  away: boolean;
}

export type Verdict = { outcome: "queued" } | { outcome: "ignored"; reason: string };

export interface NotifyOptions {
  cooldownMs?: Partial<Record<NoteKind, number>>;
  /** A fact already accepted is not accepted again for this long. */
  dedupeTtlMs?: number;
  /** At most this many companion notices an hour, urgent excepted. */
  hourlyCap?: number;
  queueCap?: number;
}

const DEFAULT_COOLDOWN: Record<NoteKind, number> = {
  greeting: 0,
  weather: 3 * 3_600_000,
  calendar: 0,
  mail: 20 * 60_000,
  away: 0,
  endOfDay: 0,
  routine: 12 * 3_600_000,
  date: 0,
  travel: 6 * 3_600_000,
  news: 6 * 3_600_000,
  watch: 30 * 60_000,
  system: 30 * 60_000,
};

/** A notice the user dismissed within this long counts as "not wanted". */
export const QUICK_DISMISS_MS = 4_000;

export interface NotifyMemory {
  /** id -> when it was accepted. Persisted so a restart does not repeat it. */
  seen: Record<string, number>;
  lastByKind: Partial<Record<NoteKind, number>>;
  shown: number[];
  quickDismiss: Partial<Record<NoteKind, number>>;
}

export function emptyMemory(): NotifyMemory {
  return { seen: {}, lastByKind: {}, shown: [], quickDismiss: {} };
}

export class SmartNotificationEngine {
  private queue: CompanionNote[] = [];
  private mem: NotifyMemory;
  private readonly cooldown: Record<NoteKind, number>;
  private readonly ttl: number;
  private readonly cap: number;
  private readonly queueCap: number;

  constructor(opts: NotifyOptions = {}, memory: NotifyMemory = emptyMemory()) {
    this.cooldown = { ...DEFAULT_COOLDOWN, ...opts.cooldownMs };
    this.ttl = opts.dedupeTtlMs ?? 36 * 3_600_000;
    this.cap = opts.hourlyCap ?? 6;
    this.queueCap = opts.queueCap ?? 25;
    this.mem = memory;
  }

  /** Offer an event. Returns whether it was queued, and why not if not. */
  submit(note: CompanionNote, now: number): Verdict {
    this.prune(now);
    if (note.lines.length === 0 || !note.lines[0].trim()) return { outcome: "ignored", reason: "empty" };
    if (note.expiresAt !== undefined && note.expiresAt <= now) return { outcome: "ignored", reason: "expired" };
    const seenAt = this.mem.seen[note.id];
    if (seenAt !== undefined && now - seenAt < this.ttl) return { outcome: "ignored", reason: "duplicate" };
    if (this.queue.some((q) => q.id === note.id)) return { outcome: "ignored", reason: "already queued" };

    this.mem.seen[note.id] = now;
    this.queue.push(note);
    if (this.queue.length > this.queueCap) {
      // Over capacity: shed the least important, oldest first.
      this.queue.sort(byImportance);
      this.queue.length = this.queueCap;
    }
    return { outcome: "queued" };
  }

  /** The notice to show right now, or null to keep holding. */
  next(ctx: NotifyContext): CompanionNote | null {
    this.prune(ctx.now);
    if (this.queue.length === 0 || ctx.slotBusy || ctx.fullscreen || ctx.away) return null;

    const hourAgo = ctx.now - 3_600_000;
    const shownLastHour = this.mem.shown.filter((t) => t > hourAgo).length;

    for (const note of [...this.queue].sort(byImportance)) {
      const rank = RANK[note.priority];
      // Focus and quiet hours: only what cannot wait.
      if ((ctx.focus || ctx.quiet) && rank < RANK.urgent) continue;
      if (shownLastHour >= this.cap && rank < RANK.urgent) continue;
      const last = this.mem.lastByKind[note.kind];
      if (last !== undefined && rank < RANK.high && ctx.now - last < this.cooldownFor(note.kind)) continue;

      const merged = this.takeGroup(note);
      this.mem.lastByKind[note.kind] = ctx.now;
      this.mem.shown.push(ctx.now);
      return merged;
    }
    return null;
  }

  /** Everything held for the "while you were away" recap, removed from the queue. */
  drainRecap(now: number): CompanionNote[] {
    this.prune(now);
    const held = this.queue.filter((n) => n.recap);
    this.queue = this.queue.filter((n) => !n.recap);
    return held.sort(byImportance);
  }

  /**
   * Learn from how a notice was dismissed. Three quick dismissals in a row of
   * the same kind doubles that kind's cooldown (up to x4); reading one
   * properly resets it.
   */
  dismissed(kind: NoteKind, shownForMs: number): void {
    const streak = this.mem.quickDismiss[kind] ?? 0;
    this.mem.quickDismiss[kind] = shownForMs < QUICK_DISMISS_MS ? streak + 1 : 0;
  }

  cooldownFor(kind: NoteKind): number {
    const streak = this.mem.quickDismiss[kind] ?? 0;
    const factor = streak >= 6 ? 4 : streak >= 3 ? 2 : 1;
    return this.cooldown[kind] * factor;
  }

  pending(): readonly CompanionNote[] {
    return this.queue;
  }

  memory(): NotifyMemory {
    return this.mem;
  }

  clear(): void {
    this.queue = [];
    this.mem = emptyMemory();
  }

  private takeGroup(note: CompanionNote): CompanionNote {
    const group = note.group ? this.queue.filter((q) => q.group === note.group) : [note];
    this.queue = this.queue.filter((q) => !group.includes(q));
    if (group.length === 1) return note;
    // One card for the whole group: the most important headline first, every
    // other note's headline as a line under it, actions de-duplicated.
    const ordered = group.sort(byImportance);
    const seen = new Set<string>();
    const actions = ordered.flatMap((n) => n.actions ?? []).filter((a) => !seen.has(a.id) && seen.add(a.id));
    return {
      ...ordered[0],
      id: `${note.group}:${ordered.map((n) => n.id).join("+")}`,
      lines: ordered.flatMap((n, i) => (i === 0 ? n.lines : [n.lines[0]])),
      actions: actions.length ? actions.slice(0, 3) : undefined,
    };
  }

  private prune(now: number): void {
    this.queue = this.queue.filter((n) => n.expiresAt === undefined || n.expiresAt > now);
    const cutoff = now - this.ttl;
    for (const [id, t] of Object.entries(this.mem.seen)) if (t < cutoff) delete this.mem.seen[id];
    this.mem.shown = this.mem.shown.filter((t) => t > now - 3_600_000);
  }
}

function byImportance(a: CompanionNote, b: CompanionNote): number {
  return RANK[b.priority] - RANK[a.priority] || a.createdAt - b.createdAt;
}
