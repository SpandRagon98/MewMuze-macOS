/**
 * Privacy-safe typing-activity detector.
 *
 * The native layer reports ONLY the number of keyboard keys currently held
 * down (an aggregate count — never which keys). This module turns consecutive
 * samples into a typing level:
 *
 *   - "none":     no recent keyboard activity
 *   - "typing":   steady typing → the cat kneads/"types" along
 *   - "overheat": sustained fast typing → the cat overheats (steam!)
 *
 * Rates are computed from count transitions (a press = count increased), so no
 * key identity or text ever exists here.
 */

export type TypingLevel = "none" | "typing" | "overheat";

const WINDOW_S = 4; // rolling window for the press rate
const TYPING_MIN_RATE = 1.2; // presses/sec to count as typing
const OVERHEAT_RATE = 6.5; // sustained presses/sec to overheat
const OVERHEAT_HOLD_S = 6; // must stay fast this long
const RELEASE_S = 2.2; // typing ends after this much quiet
const OVERHEAT_COOLDOWN_S = 45;

export class TypingDetector {
  private lastCount = 0;
  private presses: number[] = []; // timestamps (s) of detected presses
  private lastPressAt = -Infinity;
  private fastSince: number | null = null;
  private overheatUntil = -Infinity;
  private overheatCooldownUntil = -Infinity;

  /** Feed a keys-down count sample. `now` in seconds. Returns current level. */
  sample(keysDown: number, now: number): TypingLevel {
    if (keysDown > this.lastCount) {
      // One or more new presses since the last poll.
      const newPresses = Math.min(6, keysDown - this.lastCount);
      for (let i = 0; i < newPresses; i++) this.presses.push(now);
      this.lastPressAt = now;
    }
    this.lastCount = keysDown;
    const cutoff = now - WINDOW_S;
    while (this.presses.length > 0 && this.presses[0] < cutoff) this.presses.shift();
    return this.level(now);
  }

  /** Presses per second over the rolling window. */
  rate(now: number): number {
    const cutoff = now - WINDOW_S;
    const inWindow = this.presses.filter((t) => t >= cutoff).length;
    return inWindow / WINDOW_S;
  }

  level(now: number): TypingLevel {
    const rate = this.rate(now);
    const active = now - this.lastPressAt <= RELEASE_S && rate >= TYPING_MIN_RATE;

    if (now < this.overheatUntil) return "overheat";

    if (active && rate >= OVERHEAT_RATE && now >= this.overheatCooldownUntil) {
      if (this.fastSince === null) this.fastSince = now;
      if (now - this.fastSince >= OVERHEAT_HOLD_S) {
        this.overheatUntil = now + 4; // overheat display period
        this.overheatCooldownUntil = now + OVERHEAT_COOLDOWN_S;
        this.fastSince = null;
        return "overheat";
      }
    } else if (rate < OVERHEAT_RATE * 0.7) {
      this.fastSince = null;
    }

    return active ? "typing" : "none";
  }

  reset(): void {
    this.lastCount = 0;
    this.presses = [];
    this.lastPressAt = -Infinity;
    this.fastSince = null;
    this.overheatUntil = -Infinity;
  }
}
