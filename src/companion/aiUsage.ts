//! AIUsageMonitor - when prolonged local AI on battery deserves ONE gentle word.
//!
//! Not a timer. It looks at technical signals only - power source, whether
//! inference is running, and the CPU the AI processes actually used - and
//! warns when, on battery, AI work has been sustained for several minutes.
//! It never reads what was said or transcribed.
//!
//! One notice, then a long cooldown. Never on AC. Never during a recording:
//! it waits until the recording and its transcription are finished.

export interface UsageSample {
  at: number;
  onBattery: boolean;
  /** Inference (a reply or a transcription) was running at this moment. */
  busy: boolean;
  /** Cumulative CPU seconds used by the local-AI processes. */
  cpuSeconds: number;
}

export type GuardDecision = "none" | "defer" | "warn";

/** The window judged, and how much of it must be sustained AI work. */
export const WINDOW_MS = 6 * 60_000;
export const MIN_SPAN_MS = 5 * 60_000;
export const BUSY_SHARE = 0.5;
/** Average cores of AI CPU over the window that also counts as sustained. */
export const CPU_CORES = 0.75;
export const COOLDOWN_MS = 45 * 60_000;

export class AIUsageMonitor {
  private samples: UsageSample[] = [];
  private quietUntil = 0;

  push(s: UsageSample): void {
    this.samples.push(s);
    const cutoff = s.at - WINDOW_MS * 2;
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
    // Plugging in resets the picture: a new battery stretch starts fresh.
    if (!s.onBattery) this.samples = [s];
  }

  /** Measured facts for the report/UI (no content, just numbers). */
  summary(now: number): { busyShare: number; cpuCores: number; spanMs: number; onBattery: boolean } {
    const w = this.samples.filter((x) => x.at >= now - WINDOW_MS);
    if (w.length < 2) return { busyShare: 0, cpuCores: 0, spanMs: 0, onBattery: w[0]?.onBattery ?? false };
    const span = w[w.length - 1].at - w[0].at;
    const busyShare = w.filter((x) => x.busy).length / w.length;
    const cpuCores = span > 0 ? (w[w.length - 1].cpuSeconds - w[0].cpuSeconds) / (span / 1000) : 0;
    return { busyShare, cpuCores, spanMs: span, onBattery: w.every((x) => x.onBattery) };
  }

  evaluate(now: number, ctx: { recording: boolean; muted: boolean }): GuardDecision {
    if (ctx.muted || now < this.quietUntil) return "none";
    const s = this.summary(now);
    if (!s.onBattery || s.spanMs < MIN_SPAN_MS) return "none";
    const sustained = s.busyShare >= BUSY_SHARE || s.cpuCores >= CPU_CORES;
    if (!sustained) return "none";
    return ctx.recording ? "defer" : "warn";
  }

  /** The notice was shown, or "Keep going" was chosen: stay quiet for a long while. */
  quiet(now: number, ms = COOLDOWN_MS): void {
    this.quietUntil = now + ms;
  }
}

export const GUARD_LINES = ["MewMuze's local AI has been working for a while.", "Your battery may drain faster while it continues."];

export const GUARD_ACTIONS = [
  { id: "ai-saver", label: "Battery Saver" },
  { id: "ai-keep", label: "Keep Going" },
  { id: "ai-mute", label: "Don't Remind Again" },
];
