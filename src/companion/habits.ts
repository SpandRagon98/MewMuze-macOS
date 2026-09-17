//! What the cat works out about your day, so it can read the room.
//!
//! Two things are learned, both as plain averages on this machine: how BUSY
//! you usually are in each hour of the day (typing, a focus session, a
//! pomodoro), and how much you PLAY with the cat. From those it nudges the
//! cat's own liveliness - calmer in the hours you are usually heads-down,
//! livelier in the hours you are usually free and up for it.
//!
//! What is never recorded: typed text, key names, window titles, screen
//! contents, websites, files. Only "busy or not" counts per hour, averaged
//! over days. Nothing here leaves the device, and no AI model is involved:
//! the learning is arithmetic. The local-AI switch only decides whether the
//! cat is allowed to act on it.

import type { ActivityProfile } from "../settings/defaultSettings";

export interface HabitProfile {
  v: 1;
  /** Busy share for each local hour, 0..1. */
  hours: number[];
  /** Days folded into each hour: how much the number above is worth. */
  seen: number[];
  /** How often an hour contains play with the cat, 0..1. */
  play: number;
  /** The hour being watched right now, and its tally so far. */
  hour: number;
  samples: number;
  busySamples: number;
  playSamples: number;
}

/** Days of evidence before an hour is allowed to change anything. */
export const MIN_DAYS = 3;
/** How strongly one day moves an hour's average. ~0.3 remembers about three days. */
const ALPHA = 0.3;
/** Samples an hour needs before it counts as observed at all. */
const MIN_SAMPLES = 8;
const HOURS = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function emptyHabits(): HabitProfile {
  return {
    v: 1,
    hours: Array.from({ length: HOURS }, () => 0),
    seen: Array.from({ length: HOURS }, () => 0),
    play: 0,
    hour: -1,
    samples: 0,
    busySamples: 0,
    playSamples: 0,
  };
}

const numArray = (v: unknown, lo: number, hi: number): number[] | null => {
  if (!Array.isArray(v) || v.length !== HOURS) return null;
  return v.map((x) => (typeof x === "number" && Number.isFinite(x) ? clamp(x, lo, hi) : 0));
};
const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : d;

/** Whatever is in storage -> a usable profile. A damaged field costs only itself. */
export function parseHabits(raw: unknown): HabitProfile {
  const base = emptyHabits();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    hours: numArray(r.hours, 0, 1) ?? base.hours,
    seen: numArray(r.seen, 0, 9999) ?? base.seen,
    play: num(r.play, 0, 0, 1),
    hour: num(r.hour, -1, -1, 23),
    samples: num(r.samples, 0, 0, 1e6),
    busySamples: num(r.busySamples, 0, 0, 1e6),
    playSamples: num(r.playSamples, 0, 0, 1e6),
  };
}

const ema = (old: number, x: number, seen: number) => (seen === 0 ? x : old + ALPHA * (x - old));

/** Fold the finished hour into its average and start watching the new one. */
function rollHour(h: HabitProfile, hour: number): HabitProfile {
  const next = { ...h, hours: [...h.hours], seen: [...h.seen] };
  if (h.hour >= 0 && h.samples >= MIN_SAMPLES) {
    const i = h.hour;
    next.hours[i] = ema(h.hours[i], h.busySamples / h.samples, h.seen[i]);
    next.seen[i] = h.seen[i] + 1;
    next.play = ema(h.play, h.playSamples > 0 ? 1 : 0, h.seen[i]);
  }
  return { ...next, hour, samples: 0, busySamples: 0, playSamples: 0 };
}

/**
 * Record one observation. Call it on a slow tick (about once a minute):
 * `busy` = they are working right now, `played` = they touched the cat since
 * the last call. The input is never changed.
 */
export function observe(h: HabitProfile, o: { hour: number; busy: boolean; played: boolean }): HabitProfile {
  const hour = clamp(Math.floor(o.hour), 0, 23);
  const s = h.hour === hour ? h : rollHour(h, hour);
  return {
    ...s,
    samples: s.samples + 1,
    busySamples: s.busySamples + (o.busy ? 1 : 0),
    playSamples: s.playSamples + (o.played ? 1 : 0),
  };
}

/** The learned busy share for an hour, or null while it is still guesswork. */
export function busyAt(h: HabitProfile, hour: number): number | null {
  const i = clamp(Math.floor(hour), 0, 23);
  return h.seen[i] >= MIN_DAYS ? h.hours[i] : null;
}

/** Hours that are reliably heads-down (>= 55% busy). */
export function quietHours(h: HabitProfile): number[] {
  return h.hours.map((_, i) => i).filter((i) => (busyAt(h, i) ?? 0) >= 0.55);
}

/** Days of evidence behind the best-known hour. */
export function daysLearned(h: HabitProfile): number {
  return Math.max(0, ...h.seen);
}

/**
 * The cat's liveliness for this hour. The user's Activity setting is the
 * anchor; what is learned only leans it, and never past these bounds, so the
 * setting always still means something.
 */
export function adaptActivity(base: ActivityProfile, h: HabitProfile, hour: number): ActivityProfile {
  const busy = busyAt(h, hour);
  if (busy === null) return base;
  const lean = (v: number, f: number) => clamp(v * f, v * 0.5, v * 1.5);
  if (busy >= 0.55) {
    // Heads-down hours: settle down and let them work.
    const pull = 0.7 - 0.2 * (busy - 0.55); // deeper the busier
    return {
      playfulness: lean(base.playfulness, pull),
      chaseEagerness: lean(base.chaseEagerness, pull * 0.85),
      restfulness: lean(base.restfulness, 1.35),
    };
  }
  if (busy <= 0.25 && h.play >= 0.25) {
    // Quiet hours they usually spend with the cat: be up for it.
    return {
      playfulness: lean(base.playfulness, 1.3),
      chaseEagerness: lean(base.chaseEagerness, 1.25),
      restfulness: lean(base.restfulness, 0.85),
    };
  }
  return base;
}

/** One line for Local Chat, so the reply can read the hour the way the cat does. */
export function rhythmNote(h: HabitProfile, hour: number): string | null {
  const busy = busyAt(h, hour);
  if (busy === null) return null;
  if (busy >= 0.7) return "Around this hour they are usually deep in work - keep it short unless they want to talk.";
  if (busy >= 0.55) return "Around this hour they are usually working.";
  if (busy <= 0.2) return "Around this hour they are usually free.";
  return null;
}

// ---- storage: its own small key, nothing to do with settings.json ----

export const HABITS_KEY = "mewmuze.habits.v1";

export function loadHabits(): HabitProfile {
  try {
    const raw = localStorage.getItem(HABITS_KEY);
    return parseHabits(raw ? JSON.parse(raw) : null);
  } catch {
    return emptyHabits();
  }
}

export function saveHabits(h: HabitProfile): void {
  try {
    localStorage.setItem(HABITS_KEY, JSON.stringify(h));
  } catch {
    // Storage blocked or full: the cat simply keeps learning in memory.
  }
}

/** "Forget what you learned about my day" - Companion privacy clears this too. */
export function clearHabits(): void {
  try {
    localStorage.removeItem(HABITS_KEY);
  } catch {
    // Nothing to do; the caller replaces the in-memory profile anyway.
  }
}
