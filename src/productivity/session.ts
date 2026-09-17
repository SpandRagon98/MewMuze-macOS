//! Focus / Break sessions — the right-click "Focus mode" and "Break" timers.
//!
//! Pure and frame-independent so the colour ramp and countdown maths can be
//! unit-tested without any React or Tauri runtime. The App owns a single
//! `Session | null`; the SessionTimer component renders a `SessionView`.

export type SessionKind = "focus" | "break";

export interface Session {
  kind: SessionKind;
  /** Epoch ms when the session began. */
  startedAtMs: number;
  /** Break only: planned length in seconds. Focus counts up, so this is 0. */
  durationS: number;
}

export interface SessionView {
  kind: SessionKind;
  /** "12:34" — focus counts up, break counts down (clamped at 0:00). */
  label: string;
  /** 0..1 elapsed fraction. Focus stays 0 (no bar); break fills up. */
  fraction: number;
  /** Break only: the countdown has reached / passed zero. */
  overrun: boolean;
  /** The session colour: the chip's dot and progress edge. */
  color: string;
  /** Text colour to pair with `color` when it is used as a fill. */
  text: string;
}

/** Focus is the design system's icy teal (--mm-accent-2). */
export const FOCUS_COLOUR = "#5fd3e3";
const BREAK_START = [76, 195, 138] as const; // success green #4cc38a
const BREAK_MID = [230, 200, 92] as const; // amber-yellow #e6c85c - never orange
const BREAK_OVER = "#ef5b64"; // danger red

/** Options offered by the Break duration picker (minutes). */
export const BREAK_MINUTES = [5, 10, 15, 20, 30] as const;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Break colour: green at the start, ramping to amber-yellow as the break
 * runs down, then a solid red once time is up. A single linear green→amber
 * interpolation across the whole break reads as "the clock is winding down"
 * without a jarring mid-point jump.
 */
export function breakColor(fraction: number, overrun: boolean): string {
  if (overrun) return BREAK_OVER;
  const t = Math.max(0, Math.min(1, fraction));
  const r = lerp(BREAK_START[0], BREAK_MID[0], t);
  const g = lerp(BREAK_START[1], BREAK_MID[1], t);
  const b = lerp(BREAK_START[2], BREAK_MID[2], t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** mm:ss for a non-negative second count. */
export function formatMMSS(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Derive everything the timer chip needs to render, for a given wall clock. */
export function sessionView(session: Session, nowMs: number): SessionView {
  const elapsedS = Math.max(0, (nowMs - session.startedAtMs) / 1000);
  if (session.kind === "focus") {
    return {
      kind: "focus",
      label: formatMMSS(elapsedS),
      fraction: 0,
      overrun: false,
      color: FOCUS_COLOUR,
      text: "#ffffff",
    };
  }
  const remainingS = session.durationS - elapsedS;
  const overrun = remainingS <= 0;
  const fraction = session.durationS > 0 ? Math.min(1, elapsedS / session.durationS) : 1;
  return {
    kind: "break",
    label: overrun ? "0:00" : formatMMSS(remainingS),
    fraction,
    overrun,
    color: breakColor(fraction, overrun),
    text: "#ffffff",
  };
}

/** Build a focus session (open-ended count-up). */
export function startFocus(nowMs: number): Session {
  return { kind: "focus", startedAtMs: nowMs, durationS: 0 };
}

/** Build a break session of `minutes` length. */
export function startBreak(minutes: number, nowMs: number): Session {
  const m = Math.max(1, Math.min(180, Math.floor(minutes)));
  return { kind: "break", startedAtMs: nowMs, durationS: m * 60 };
}

/**
 * MewMuze's own overlay, which takes the foreground whenever the cat is
 * right-clicked, dragged or its settings are opened. Focus mode must never
 * scold someone for interacting with the cat itself. The dev binary name is
 * matched too, so `tauri dev` behaves like a release build.
 */
// Paper builds ship as MewMuzePaper.exe; it is still the cat's own window.
const OWN_PROCESS = /^(mewmuze(paper)?|pixel-cat-companion)(\.exe)?$/i;

export type FocusDrift =
  /** Nothing to react to: no foreground app, or it is MewMuze itself. */
  | { kind: "ignore" }
  /** First real app of the session: this is what focus now guards. */
  | { kind: "lock"; app: string }
  /** The user moved to a different application. */
  | { kind: "drift"; from: string; to: string };

/**
 * Decide what focus mode should do about the current foreground application.
 *
 * `guarded` is null until the first real app is seen, because focus mode is
 * started from the cat's own right-click menu — at which point the foreground
 * window is MewMuze, not the app the user intends to work in.
 *
 * Pure so the rules can be tested without a desktop: see session.test.ts.
 */
export function focusDrift(foreground: string | null, guarded: string | null): FocusDrift {
  const app = (foreground ?? "").trim().toLowerCase();
  // No foreground app at all (the desktop, a lock screen, a closing window).
  if (!app) return { kind: "ignore" };
  // Interacting with the cat is not losing focus.
  if (OWN_PROCESS.test(app)) return { kind: "ignore" };
  if (!guarded) return { kind: "lock", app };
  if (app === guarded) return { kind: "ignore" };
  return { kind: "drift", from: guarded, to: app };
}
