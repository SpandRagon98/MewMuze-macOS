//! While you were away.
//!
//! Built on the app's existing, privacy-safe idle signal (seconds since the
//! last input anywhere - never which keys, never what was on screen). When the
//! user comes back from a real absence, the cat says welcome back; if
//! something meaningful happened meanwhile, it offers a short recap. If nothing
//! did, it does not manufacture one.

export const AWAY_AFTER_MS = 10 * 60_000;
/** Shorter absences get a wave, never a recap card. */
export const RECAP_AFTER_MS = 20 * 60_000;
/** Input this recent means "back". */
const BACK_WITHIN_S = 20;

export interface AwayReturn {
  awayMs: number;
  since: number;
}

export class AwayTracker {
  private awaySince: number | null = null;

  /** Feed the idle signal. Returns a return event exactly once per absence. */
  sample(idleSeconds: number, now: number): AwayReturn | null {
    if (this.awaySince === null) {
      if (idleSeconds * 1000 >= AWAY_AFTER_MS) this.awaySince = now - idleSeconds * 1000;
      return null;
    }
    if (idleSeconds <= BACK_WITHIN_S) {
      const since = this.awaySince;
      this.awaySince = null;
      return { awayMs: now - since, since };
    }
    return null;
  }

  isAway(): boolean {
    return this.awaySince !== null;
  }

  awaySinceMs(): number | null {
    return this.awaySince;
  }
}
