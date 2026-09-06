import type { PomodoroConfig } from "../settings/defaultSettings";

/**
 * Pure Pomodoro state machine. Time is injected (seconds) so it is fully
 * unit-testable and immune to timer drift — callers poll `tick(now)`.
 */

export type PomodoroPhase = "idle" | "focus" | "shortBreak" | "longBreak" | "paused";

export interface PomodoroSnapshot {
  phase: PomodoroPhase;
  /** Seconds remaining in the current phase (0 when idle). */
  remaining: number;
  /** Completed focus cycles in the current set. */
  cycle: number;
  /** Set when a phase just completed this tick (for notifications). */
  completed: "focus" | "shortBreak" | "longBreak" | null;
}

export class Pomodoro {
  private phase: PomodoroPhase = "idle";
  private phaseEndsAt = 0;
  private pausedRemaining = 0;
  private pausedPhase: PomodoroPhase = "idle";
  private cycle = 0;
  private config: PomodoroConfig;

  constructor(config: PomodoroConfig) {
    this.config = config;
  }

  setConfig(config: PomodoroConfig): void {
    this.config = config;
  }

  get currentPhase(): PomodoroPhase {
    return this.phase;
  }

  start(now: number): void {
    this.phase = "focus";
    this.cycle = 0;
    this.phaseEndsAt = now + this.config.focusMin * 60;
  }

  pause(now: number): void {
    if (this.phase === "idle" || this.phase === "paused") return;
    this.pausedRemaining = Math.max(0, this.phaseEndsAt - now);
    this.pausedPhase = this.phase;
    this.phase = "paused";
  }

  resume(now: number): void {
    if (this.phase !== "paused") return;
    this.phase = this.pausedPhase;
    this.phaseEndsAt = now + this.pausedRemaining;
  }

  skip(now: number): void {
    if (this.phase === "idle") return;
    if (this.phase === "paused") this.phase = this.pausedPhase;
    this.phaseEndsAt = now; // completes on next tick
  }

  reset(): void {
    this.phase = "idle";
    this.cycle = 0;
    this.phaseEndsAt = 0;
  }

  /** Advance; returns the current snapshot (with `completed` set on rollover). */
  tick(now: number): PomodoroSnapshot {
    let completed: PomodoroSnapshot["completed"] = null;
    if (this.phase !== "idle" && this.phase !== "paused" && now >= this.phaseEndsAt) {
      if (this.phase === "focus") {
        completed = "focus";
        this.cycle += 1;
        if (this.cycle >= this.config.cyclesBeforeLongBreak) {
          this.phase = "longBreak";
          this.phaseEndsAt = now + this.config.longBreakMin * 60;
        } else {
          this.phase = "shortBreak";
          this.phaseEndsAt = now + this.config.shortBreakMin * 60;
        }
      } else if (this.phase === "shortBreak") {
        completed = "shortBreak";
        this.phase = "focus";
        this.phaseEndsAt = now + this.config.focusMin * 60;
      } else {
        completed = "longBreak";
        this.cycle = 0;
        this.phase = "focus";
        this.phaseEndsAt = now + this.config.focusMin * 60;
      }
    }
    return {
      phase: this.phase,
      remaining:
        this.phase === "idle" ? 0 : this.phase === "paused" ? this.pausedRemaining : Math.max(0, this.phaseEndsAt - now),
      cycle: this.cycle,
      completed,
    };
  }
}

/**
 * Format seconds as m:ss for the tiny pixel timer.
 *
 * Clamped at zero — a negative input rendered as "-1:-5", and the countdown
 * showing garbage is worse than it showing nothing left. `formatMMSS` in
 * session.ts has always clamped; this matches it so the two clocks in the UI
 * cannot disagree.
 */
export function formatTimer(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
