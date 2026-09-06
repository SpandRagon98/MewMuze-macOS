//! What the cat does when a full-screen app takes the screen.
//!
//! A true full-screen window (a video, a game, a presentation) should get the
//! display entirely to itself: the cat waves goodbye, fades out, and the
//! overlay window is hidden outright — not merely peeked, dimmed or moved
//! off-screen, since a transparent always-on-top window still costs
//! compositing and still swallows nothing but is *there*.
//!
//! The sequencing is a small state machine rather than a scatter of booleans
//! inside the render loop, so the awkward transitions — full screen ending
//! mid-wave, Cat Off taking over while withdrawn — are unit-testable without a
//! window, a renderer or a clock.

/** How long the goodbye wave plays before the fade-out starts (ms). */
export const FS_RETREAT_MS = 850;

export type FullscreenPhase =
  /** On screen, business as usual. */
  | "visible"
  /** Waving goodbye; the fade has not started yet. */
  | "retreating"
  /** Fading out; the window is still shown until the fade completes. */
  | "fading"
  /** Overlay window hidden. Nothing renders, nothing is hit-tested. */
  | "hidden";

export interface FullscreenState {
  phase: FullscreenPhase;
  /** Timestamp (ms, same clock as `now`) the fade begins; 0 when not retreating. */
  retreatAt: number;
}

export interface FullscreenInput {
  /** A full-screen app is up AND the cat is allowed to withdraw for it. */
  hide: boolean;
  /** Monotonic ms — the render loop's frame time. */
  now: number;
  /** The fade has finished and the overlay window is actually hidden. */
  faded: boolean;
}

export type FullscreenEffect =
  /** Nothing to do this frame. */
  | "none"
  /** Play the goodbye wave and remember where to come back to. */
  | "retreat"
  /** Begin fading the cat out. */
  | "fadeOut"
  /** The window is hidden now: suspend rendering. */
  | "hidden"
  /** Full screen ended: show the window and drop the cat back in. */
  | "restore"
  /** Full screen ended before the cat finished leaving: cancel the retreat. */
  | "abort";

export const INITIAL_FULLSCREEN_STATE: FullscreenState = { phase: "visible", retreatAt: 0 };

/**
 * Advance the retreat by one frame.
 *
 * Pure: returns the next state and the single side effect the caller should
 * perform. `hide` going false at ANY point before the window is hidden aborts
 * cleanly back to visible — a user who alt-tabs out of a video during the wave
 * must not be left with a cat stuck mid-fade.
 */
export function stepFullscreen(
  state: FullscreenState,
  input: FullscreenInput,
): { state: FullscreenState; effect: FullscreenEffect } {
  const { hide, now, faded } = input;

  switch (state.phase) {
    case "visible":
      if (!hide) return { state, effect: "none" };
      return { state: { phase: "retreating", retreatAt: now + FS_RETREAT_MS }, effect: "retreat" };

    case "retreating":
      if (!hide) return { state: INITIAL_FULLSCREEN_STATE, effect: "abort" };
      if (now < state.retreatAt) return { state, effect: "none" };
      return { state: { phase: "fading", retreatAt: 0 }, effect: "fadeOut" };

    case "fading":
      if (!hide) return { state: INITIAL_FULLSCREEN_STATE, effect: "abort" };
      if (!faded) return { state, effect: "none" };
      return { state: { phase: "hidden", retreatAt: 0 }, effect: "hidden" };

    case "hidden":
      if (hide) return { state, effect: "none" };
      return { state: INITIAL_FULLSCREEN_STATE, effect: "restore" };
  }
}

/** Whether the overlay is withdrawn right now (rendering may be suspended). */
export function isWithdrawn(state: FullscreenState): boolean {
  return state.phase === "hidden";
}
