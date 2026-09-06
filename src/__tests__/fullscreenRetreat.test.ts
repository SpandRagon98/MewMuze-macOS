import { describe, it, expect } from "vitest";
import {
  stepFullscreen,
  isWithdrawn,
  INITIAL_FULLSCREEN_STATE,
  FS_RETREAT_MS,
  type FullscreenEffect,
  type FullscreenState,
} from "../behaviour/fullscreenRetreat";

/**
 * Drive the machine the way the render loop does: one step per frame, feeding
 * back whether the window has finished fading out.
 */
function run(
  frames: { hide: boolean; now: number; faded?: boolean }[],
  from: FullscreenState = INITIAL_FULLSCREEN_STATE,
): { state: FullscreenState; effects: FullscreenEffect[] } {
  let state = from;
  const effects: FullscreenEffect[] = [];
  for (const f of frames) {
    const out = stepFullscreen(state, { hide: f.hide, now: f.now, faded: f.faded ?? false });
    state = out.state;
    if (out.effect !== "none") effects.push(out.effect);
  }
  return { state, effects };
}

describe("entering full screen", () => {
  it("does nothing at all while no full-screen app is up", () => {
    const { state, effects } = run([
      { hide: false, now: 0 },
      { hide: false, now: 5000 },
      { hide: false, now: 60_000 },
    ]);
    expect(effects).toEqual([]);
    expect(state).toEqual(INITIAL_FULLSCREEN_STATE);
    expect(isWithdrawn(state)).toBe(false);
  });

  it("waves goodbye first, and only then fades", () => {
    const { effects } = run([
      { hide: true, now: 0 }, // full screen detected → wave
      { hide: true, now: 100 }, // still waving
      { hide: true, now: FS_RETREAT_MS - 1 }, // still waving
      { hide: true, now: FS_RETREAT_MS }, // wave done → fade
    ]);
    expect(effects).toEqual(["retreat", "fadeOut"]);
  });

  it("hides the window only once the fade has actually finished", () => {
    const { state, effects } = run([
      { hide: true, now: 0 },
      { hide: true, now: FS_RETREAT_MS },
      { hide: true, now: FS_RETREAT_MS + 16, faded: false }, // mid-fade
      { hide: true, now: FS_RETREAT_MS + 200, faded: false },
      { hide: true, now: FS_RETREAT_MS + 400, faded: true }, // fade complete
    ]);
    expect(effects).toEqual(["retreat", "fadeOut", "hidden"]);
    expect(isWithdrawn(state)).toBe(true);
  });

  it("stays withdrawn, emitting nothing, for as long as full screen lasts", () => {
    const start = run([
      { hide: true, now: 0 },
      { hide: true, now: FS_RETREAT_MS },
      { hide: true, now: FS_RETREAT_MS + 100, faded: true },
    ]);
    const held = run(
      Array.from({ length: 50 }, (_, i) => ({ hide: true, now: 10_000 + i * 500, faded: true })),
      start.state,
    );
    expect(held.effects).toEqual([]);
    expect(isWithdrawn(held.state)).toBe(true);
  });
});

describe("leaving full screen", () => {
  it("restores the overlay once, on the way out", () => {
    const entered = run([
      { hide: true, now: 0 },
      { hide: true, now: FS_RETREAT_MS },
      { hide: true, now: FS_RETREAT_MS + 100, faded: true },
    ]);
    expect(isWithdrawn(entered.state)).toBe(true);

    const left = run(
      [
        { hide: false, now: 20_000 },
        { hide: false, now: 20_500 },
        { hide: false, now: 21_000 },
      ],
      entered.state,
    );
    expect(left.effects).toEqual(["restore"]);
    expect(left.state).toEqual(INITIAL_FULLSCREEN_STATE);
    expect(isWithdrawn(left.state)).toBe(false);
  });

  it("a full enter/exit cycle can be repeated cleanly", () => {
    let state = INITIAL_FULLSCREEN_STATE;
    const seen: FullscreenEffect[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const base = cycle * 100_000;
      const out = run(
        [
          { hide: true, now: base },
          { hide: true, now: base + FS_RETREAT_MS },
          { hide: true, now: base + FS_RETREAT_MS + 100, faded: true },
          { hide: false, now: base + 50_000 },
        ],
        state,
      );
      state = out.state;
      seen.push(...out.effects);
    }
    expect(seen).toEqual([
      "retreat", "fadeOut", "hidden", "restore",
      "retreat", "fadeOut", "hidden", "restore",
      "retreat", "fadeOut", "hidden", "restore",
    ]);
    expect(state).toEqual(INITIAL_FULLSCREEN_STATE);
  });
});

describe("full screen ending before the cat has finished leaving", () => {
  it("aborts during the goodbye wave, leaving the cat where it stands", () => {
    const { state, effects } = run([
      { hide: true, now: 0 }, // wave starts
      { hide: false, now: 200 }, // user alt-tabs straight back out
      { hide: false, now: 400 },
    ]);
    expect(effects).toEqual(["retreat", "abort"]);
    expect(state).toEqual(INITIAL_FULLSCREEN_STATE);
    expect(isWithdrawn(state)).toBe(false);
  });

  it("aborts mid-fade, before the window was ever hidden", () => {
    const { state, effects } = run([
      { hide: true, now: 0 },
      { hide: true, now: FS_RETREAT_MS }, // fade begins
      { hide: false, now: FS_RETREAT_MS + 120 }, // …and full screen ends
    ]);
    expect(effects).toEqual(["retreat", "fadeOut", "abort"]);
    // Never reached "hidden", so no restore is owed — the window never went away.
    expect(effects).not.toContain("hidden");
    expect(state).toEqual(INITIAL_FULLSCREEN_STATE);
  });

  it("re-entering after an abort starts a fresh retreat with a fresh deadline", () => {
    const aborted = run([
      { hide: true, now: 0 },
      { hide: false, now: 200 },
    ]);
    const again = run(
      [
        { hide: true, now: 1000 },
        { hide: true, now: 1000 + FS_RETREAT_MS - 1 }, // old deadline must not apply
        { hide: true, now: 1000 + FS_RETREAT_MS },
      ],
      aborted.state,
    );
    expect(again.effects).toEqual(["retreat", "fadeOut"]);
  });
});
