//! When the cat says good morning.
//!
//! Once per day, on the first moment the user is actually at the computer -
//! not at a clock boundary, so "good afternoon" never pops up just because it
//! turned noon mid-task. Separately, "still up?" at most once a night, and
//! only if the user is active well past midnight.

import { dayKey, dayPart, localParts, type DayPart } from "./clock";
import type { AnimationName } from "../types/cat";

export interface GreetState {
  /** Local day the day greeting was given on. */
  lastDay: string;
  /** Local day "still up?" was last asked on (keyed by the evening it began). */
  lastLateDay: string;
}

export const EMPTY_GREET: GreetState = { lastDay: "", lastLateDay: "" };

export interface GreetDecision {
  part: DayPart;
  /** The animation that sells it: wake and stretch in the morning. */
  cat: AnimationName;
  next: GreetState;
}

/** The late-night check only fires between these local hours. */
const LATE_FROM = 0;
const LATE_TO = 4;

/**
 * Decide whether to greet now. `active` means the user is at the machine right
 * now (fresh input) - the cat never greets an empty room.
 */
export function decideGreeting(state: GreetState, nowMs: number, tz: string, active: boolean): GreetDecision | null {
  if (!active) return null;
  const today = dayKey(nowMs, tz);
  const { hour } = localParts(nowMs, tz);

  // Past midnight counts toward the PREVIOUS evening, so someone working
  // 23:00-01:00 is not greeted "good morning" at 00:30.
  if (hour >= LATE_FROM && hour < LATE_TO) {
    const evening = dayKey(nowMs - (hour + 1) * 3_600_000, tz);
    if (state.lastLateDay === evening) return null;
    return { part: "late", cat: "yawn", next: { ...state, lastLateDay: evening } };
  }

  if (state.lastDay === today) return null;
  const part = dayPart(hour);
  return {
    part,
    cat: part === "morning" ? "stretch" : part === "late" ? "yawn" : "wave",
    // A first greeting at 22:30 is already "still up?" - claim the night too,
    // or the same question comes round again at half past midnight.
    next: { ...state, lastDay: today, lastLateDay: part === "late" ? today : state.lastLateDay },
  };
}
