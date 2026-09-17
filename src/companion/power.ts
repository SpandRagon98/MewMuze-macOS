//! Power modes and the battery state they react to.
//!
//! The companion never switches MewMuze's own behaviour off because of the
//! battery - the cat keeps walking. What changes is how much BACKGROUND work
//! the companion does: how often it refreshes things from the internet, and
//! (in Phase 2) how aggressively local AI is unloaded.

import type { PowerMode } from "./profile";

export interface PowerStatus {
  /** False when unknown (desktop, or the query failed). */
  onBattery: boolean;
  /** 0-100, or null when there is no battery or it is unknown. */
  percent: number | null;
  /** The operating system's own battery saver is on. */
  osSaver: boolean;
  /** The platform actually answered; false means every field is a default. */
  known: boolean;
}

export const UNKNOWN_POWER: PowerStatus = { onBattery: false, percent: null, osSaver: false, known: false };

export interface ModeProfile {
  /** Multiplier on every network job's interval. */
  networkFactor: number;
  /** Multiplier on local (no-network) job intervals. */
  localFactor: number;
  /** Phase 2: inference threads as a share of logical cores. */
  aiThreadShare: number;
  /** Phase 2: how long an idle model stays loaded after its session ends. */
  aiIdleUnloadMs: number;
  /** Phase 2: never start AI work the user did not explicitly ask for. */
  aiExplicitOnly: boolean;
}

export const MODE_PROFILE: Record<PowerMode, ModeProfile> = {
  saver: { networkFactor: 3, localFactor: 2, aiThreadShare: 0.25, aiIdleUnloadMs: 20_000, aiExplicitOnly: true },
  balanced: { networkFactor: 1, localFactor: 1, aiThreadShare: 0.5, aiIdleUnloadMs: 3 * 60_000, aiExplicitOnly: true },
  performance: { networkFactor: 1, localFactor: 1, aiThreadShare: 0.75, aiIdleUnloadMs: 10 * 60_000, aiExplicitOnly: false },
};

/** Extra stretch on network refresh while unplugged in Balanced mode. */
export const BALANCED_ON_BATTERY_FACTOR = 1.5;

/**
 * The mode the companion actually runs in. The OS battery saver is honoured as
 * "at least Battery Saver" - the user asked their whole machine to save power.
 * Otherwise the user's own choice stands.
 */
export function effectiveMode(chosen: PowerMode, status: PowerStatus): PowerMode {
  if (status.osSaver) return "saver";
  return chosen;
}

/** Interval multiplier for a job, given mode and battery. */
export function intervalFactor(mode: PowerMode, onBattery: boolean, network: boolean): number {
  const p = MODE_PROFILE[mode];
  const base = network ? p.networkFactor : p.localFactor;
  return mode === "balanced" && onBattery && network ? base * BALANCED_ON_BATTERY_FACTOR : base;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;

/** Ask the backend for the battery state; UNKNOWN_POWER outside Tauri. */
export async function readPowerStatus(): Promise<PowerStatus> {
  try {
    if (!invokeFn) invokeFn = (await import("@tauri-apps/api/core")).invoke as unknown as Invoke;
    const s = await invokeFn<PowerStatus>("power_status");
    return s && typeof s.onBattery === "boolean" ? s : UNKNOWN_POWER;
  } catch {
    return UNKNOWN_POWER;
  }
}
