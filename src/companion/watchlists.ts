//! Personal watches: "tell me when...".
//!
//! Three kinds, each with a responsible data source and cadence - no scraping:
//!   * fx       - a currency pair crossing a level. Frankfurter serves the ECB
//!                reference rates, published once a working day, so the watch
//!                is checked a few times a day, not every minute.
//!   * rain-tomorrow - reads the weather snapshot the companion already has;
//!                no extra request at all.
//!   * keyword  - a phrase appearing in the news (a product launch), via GDELT.
//! Each fires once per crossing / per day, never repeatedly.

import { companionGet, safeJson } from "./net";
import type { Watch } from "./profile";

export interface WatchState {
  lastChecked: number | null;
  lastValue: number | null;
  /** fx: armed = the next crossing will fire. Re-arms after moving back. */
  armed: boolean;
  /** rain/keyword: the local day it last fired. */
  lastFiredDay: string;
  lastError: string | null;
}

export const freshWatchState = (): WatchState => ({
  lastChecked: null,
  lastValue: null,
  armed: true,
  lastFiredDay: "",
  lastError: null,
});

/** Re-arm once the rate is back this far on the other side of the level. */
const HYSTERESIS = 0.003;

export function parseFrankfurter(json: unknown, quote: string): number | null {
  const rates = (json as { rates?: Record<string, unknown> })?.rates;
  const v = rates?.[quote];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function fetchRate(base: string, quote: string): Promise<number | null> {
  const res = await companionGet("frankfurter", `/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`);
  return res.ok ? parseFrankfurter(safeJson(res.body), quote) : null;
}

/**
 * Evaluate a currency watch against a fresh rate. Fires when the rate is on
 * the watched side of the level while armed - including when it was already
 * there at creation, which is what "tell me when it crosses" means if it
 * already has.
 */
export function evaluateFx(w: Watch, state: WatchState, rate: number, now: number): { fire: boolean; state: WatchState } {
  const beyond = w.direction === "above" ? rate >= w.threshold : rate <= w.threshold;
  const backInside =
    w.direction === "above" ? rate < w.threshold * (1 - HYSTERESIS) : rate > w.threshold * (1 + HYSTERESIS);
  const fire = state.armed && beyond;
  const armed = fire ? false : state.armed || backInside;
  return { fire, state: { ...state, lastChecked: now, lastValue: rate, armed, lastError: null } };
}

export function describeFx(w: Watch, rate: number): string {
  const pair = `${w.base}/${w.quote}`;
  return `${pair} is ${w.direction === "above" ? "above" : "below"} ${w.threshold} - now ${rate.toFixed(2)}.`;
}

/** Keyword watch: does any headline actually contain the phrase? */
export function keywordHit(phrase: string, titles: string[]): string | null {
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  return titles.find((t) => words.every((w) => t.toLowerCase().includes(w))) ?? null;
}
