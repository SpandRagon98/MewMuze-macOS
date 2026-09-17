//! What the companion remembers between runs - all of it on this machine.
//!
//! One small JSON blob in the webview's local storage, which lives in the
//! app's own data folder (separate for the Paper build). Settings (name,
//! features, location) live in settings.json; this is the learned and
//! remembered state that "Clear Companion Data" and "Delete Local History"
//! erase.

import type { CalendarSnapshot } from "./calendarCompanion";
import { EMPTY_GREET, type GreetState } from "./greeting";
import type { Headline } from "./news";
import { emptyMemory, type NoteKind, type NotifyMemory } from "./notify";
import { emptyRoutine, type RoutineStats } from "./routine";
import type { WatchState } from "./watchlists";
import type { WeatherMemory, WeatherSnapshot } from "./weather";

export interface HistoryEntry {
  at: number;
  kind: NoteKind;
  text: string;
}

export interface CompanionState {
  v: 1;
  greet: GreetState;
  routine: RoutineStats;
  notify: NotifyMemory;
  weatherMem: WeatherMemory;
  weather: WeatherSnapshot | null;
  calendar: CalendarSnapshot | null;
  /** News URLs already seen, newest first (bounded). */
  newsSeen: string[];
  /** Interests that have had their first, silent, baseline fetch. */
  newsBaseline: string[];
  /** interest -> local day it last produced a notice. */
  newsNotifiedDay: Record<string, string>;
  /** interest -> latest headlines, for the on-demand briefing. */
  headlines: Record<string, { at: number; items: Headline[] }>;
  watches: Record<string, WatchState>;
  lastWrapDay: string;
  lastSunnyDay: string;
  lastEarlyDay: string;
  lastB2BDay: string;
  /** The notices the companion showed, newest first - visible in Companion Privacy. */
  history: HistoryEntry[];
}

export const HISTORY_CAP = 50;
export const STORE_KEY = "mewmuze.companion.v1";

export function freshState(): CompanionState {
  return {
    v: 1,
    greet: { ...EMPTY_GREET },
    routine: emptyRoutine(),
    notify: emptyMemory(),
    weatherMem: { lastDayMax: null },
    weather: null,
    calendar: null,
    newsSeen: [],
    newsBaseline: [],
    newsNotifiedDay: {},
    headlines: {},
    watches: {},
    lastWrapDay: "",
    lastSunnyDay: "",
    lastEarlyDay: "",
    lastB2BDay: "",
    history: [],
  };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse a stored blob. Anything missing or the wrong shape falls back to its
 * fresh value field by field, so one bad field never costs the rest.
 */
export function parseState(raw: string | null): CompanionState {
  const base = freshState();
  if (!raw) return base;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!isRec(o) || o.v !== 1) return base;
  const out: CompanionState = { ...base };
  for (const k of Object.keys(base) as (keyof CompanionState)[]) {
    const have = o[k];
    const want = base[k];
    if (have === undefined) continue;
    const sameShape =
      (Array.isArray(want) && Array.isArray(have)) ||
      (typeof want === "string" && typeof have === "string") ||
      (want === null && (have === null || isRec(have))) ||
      (isRec(want) && isRec(have));
    if (sameShape) (out as unknown as Record<string, unknown>)[k] = have;
  }
  return out;
}

export function loadState(): CompanionState {
  try {
    return parseState(localStorage.getItem(STORE_KEY));
  } catch {
    return freshState();
  }
}

export function saveState(s: CompanionState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: the companion simply forgets, it never breaks.
  }
}
