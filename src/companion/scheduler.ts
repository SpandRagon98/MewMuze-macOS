//! CompanionScheduler - the one owner of every periodic companion check.
//!
//! Weather, calendar, Gmail, watchlists, news and the companion's own tick all
//! register here instead of each starting its own timer. There is exactly ONE
//! timer, armed for the earliest due job, so the process only wakes when
//! something is actually due - not on a fixed polling beat.
//!
//! It owns the policy those services would otherwise each half-implement:
//! power-mode and battery scaling, exponential backoff with jitter, offline
//! detection, and deferring network work while a full-screen app is in front.
//! ("Pause Companion Internet" is enforced in Rust, where the requests are made.)

import { intervalFactor } from "./power";
import type { PowerMode } from "./profile";

export interface SchedulerJob {
  id: string;
  /** Interval in Balanced mode on AC. Power mode and battery stretch it. */
  intervalMs: number;
  /** Needs the internet: deferred when offline, stretched more on battery. */
  network: boolean;
  /** Resolve false (or throw) on failure to trigger backoff. */
  run: () => Promise<boolean | void> | boolean | void;
  /** Run on registration instead of one interval later. */
  immediate?: boolean;
  /** Keep running while a full-screen app is in front (default: local jobs only). */
  runInFullscreen?: boolean;
}

export interface SchedulerEnv {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  online: () => boolean;
  /** A full-screen app is in front (read at fire time, never stale). */
  fullscreen: () => boolean;
  random: () => number;
}

export const defaultEnv = (): SchedulerEnv => ({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  fullscreen: () => false,
  random: Math.random,
});

/** Backoff never waits longer than this, whatever the failure count. */
export const MAX_BACKOFF_MS = 6 * 3_600_000;
/** Offline network jobs look again after this long. */
export const OFFLINE_RETRY_MS = 5 * 60_000;
/** Deferred network jobs while full-screen try again after this long. */
export const FULLSCREEN_DEFER_MS = 5 * 60_000;
/** The timer never fires sooner than this, however many jobs are due. */
const MIN_ARM_MS = 1_000;

interface JobState {
  job: SchedulerJob;
  nextDue: number;
  failures: number;
  running: boolean;
  lastRun: number | null;
  lastOk: boolean | null;
}

export interface JobStats {
  id: string;
  network: boolean;
  nextDue: number;
  failures: number;
  lastRun: number | null;
  lastOk: boolean | null;
  /** The interval it runs at right now, after power scaling. */
  everyMs: number;
}

export class CompanionScheduler {
  private jobs = new Map<string, JobState>();
  private timer: unknown = null;
  private started = false;
  private mode: PowerMode = "balanced";
  private onBattery = false;
  /** Timer wakeups, runs and network runs - reported by the privacy dashboard. */
  readonly counters = { wakeups: 0, runs: 0, networkRuns: 0, failures: 0 };

  constructor(private readonly env: SchedulerEnv = defaultEnv()) {}

  register(job: SchedulerJob): void {
    const now = this.env.now();
    const first = job.immediate ? now : now + this.effectiveInterval(job);
    this.jobs.set(job.id, { job, nextDue: first, failures: 0, running: false, lastRun: null, lastOk: null });
    this.arm();
  }

  unregister(id: string): void {
    this.jobs.delete(id);
    this.arm();
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  start(): void {
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  setMode(mode: PowerMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.rescale();
  }

  setOnBattery(onBattery: boolean): void {
    if (onBattery === this.onBattery) return;
    this.onBattery = onBattery;
    this.rescale();
  }

  /** The network came back: bring network jobs forward rather than waiting. */
  notifyOnline(): void {
    const now = this.env.now();
    for (const s of this.jobs.values()) if (s.job.network && s.nextDue > now + 2_000) s.nextDue = now + 2_000;
    this.arm();
  }

  /** Run a job now, on explicit user request, whatever its schedule. */
  async runNow(id: string): Promise<boolean> {
    const s = this.jobs.get(id);
    // Already running: the result is on its way, never start a second copy.
    if (!s || s.running) return false;
    if (s.job.network && !this.env.online()) return false;
    const ok = await this.execute(s);
    // Its next run moved; the one timer must follow it.
    this.arm();
    return ok;
  }

  effectiveInterval(job: SchedulerJob): number {
    return Math.round(job.intervalMs * intervalFactor(this.mode, this.onBattery, job.network));
  }

  stats(): JobStats[] {
    return [...this.jobs.values()].map((s) => ({
      id: s.job.id,
      network: s.job.network,
      nextDue: s.nextDue,
      failures: s.failures,
      lastRun: s.lastRun,
      lastOk: s.lastOk,
      everyMs: this.effectiveInterval(s.job),
    }));
  }

  /** Stretch or shrink every pending wait to the new interval, from its last run. */
  private rescale(): void {
    const now = this.env.now();
    for (const s of this.jobs.values()) {
      if (s.failures > 0) continue; // backoff owns the timing until it recovers
      const anchor = s.lastRun ?? now;
      s.nextDue = Math.max(now, anchor + this.effectiveInterval(s.job));
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
    if (!this.started || this.jobs.size === 0) return;
    let earliest = Infinity;
    for (const s of this.jobs.values()) if (!s.running) earliest = Math.min(earliest, s.nextDue);
    if (!Number.isFinite(earliest)) return;
    const wait = Math.max(MIN_ARM_MS, earliest - this.env.now());
    this.timer = this.env.setTimer(() => void this.fire(), wait);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.counters.wakeups++;
    const now = this.env.now();
    const due = [...this.jobs.values()].filter((s) => !s.running && s.nextDue <= now);
    for (const s of due) {
      if (s.job.network && !this.env.online()) {
        // Not a failure - nothing was attempted. Look again later.
        s.nextDue = now + Math.min(this.effectiveInterval(s.job), OFFLINE_RETRY_MS);
        continue;
      }
      const inFullscreen = s.job.runInFullscreen ?? !s.job.network;
      if (!inFullscreen && this.env.fullscreen()) {
        s.nextDue = now + FULLSCREEN_DEFER_MS;
        continue;
      }
      await this.execute(s);
    }
    this.arm();
  }

  private async execute(s: JobState): Promise<boolean> {
    s.running = true;
    let ok = false;
    try {
      ok = (await s.job.run()) !== false;
    } catch {
      ok = false;
    }
    s.running = false;
    const now = this.env.now();
    s.lastRun = now;
    s.lastOk = ok;
    this.counters.runs++;
    if (s.job.network) this.counters.networkRuns++;
    if (!this.jobs.has(s.job.id)) return ok; // unregistered while running
    if (ok) {
      s.failures = 0;
      s.nextDue = now + this.jitter(this.effectiveInterval(s.job));
    } else {
      s.failures++;
      this.counters.failures++;
      const backoff = Math.min(MAX_BACKOFF_MS, this.effectiveInterval(s.job) * 2 ** Math.min(s.failures, 10));
      s.nextDue = now + this.jitter(backoff);
    }
    return ok;
  }

  /** +/-10%, so jobs registered together do not keep firing in lockstep. */
  private jitter(ms: number): number {
    return Math.round(ms * (0.9 + this.env.random() * 0.2));
  }
}
