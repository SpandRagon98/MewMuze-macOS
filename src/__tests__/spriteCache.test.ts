import { describe, it, expect, beforeEach } from "vitest";
import {
  renderFrame,
  clearSpriteCache,
  spriteCacheSize,
  spriteCacheLimit,
  DEFAULT_POSE,
  TAIL_PHASE_STEPS,
  type PoseSpec,
} from "../animation/spriteLoader";
import { ANIMATIONS } from "../animation/animationDefinitions";

/**
 * The sprite cache was once an unbounded Map. Roughly 200 base animation frames
 * multiply by 25 live pupil positions and 12 tail phases, so a long session
 * accumulated thousands of 96x96 canvases (hundreds of MB) and eventually made
 * the whole app unresponsive. It must stay capped no matter what is thrown at it.
 */
describe("sprite frame cache", () => {
  beforeEach(() => clearSpriteCache());

  it("stays bounded when far more poses than the cap are rendered", () => {
    // A representative slice of the real pose space (frames x pupils x tail),
    // deliberately much larger than the cap. Kept to a sample rather than the
    // full cross-product so the suite stays fast and quiet.
    // Asserted against the exported cap rather than a copied number, so raising
    // the limit does not silently leave this test checking a stale bound.
    const cap = spriteCacheLimit();
    const frames = Object.values(ANIMATIONS).flatMap((d) => d.frames).slice(0, 90);
    let rendered = 0;
    for (const frame of frames) {
      for (let px = -2; px <= 2; px++) {
        for (let tp = 0; tp < TAIL_PHASE_STEPS; tp += 3) {
          renderFrame({ ...frame, pupilX: px, pupilY: 0, tailPhase: tp });
          rendered++;
        }
      }
    }
    expect(rendered).toBeGreaterThan(cap); // the cap is actually exercised
    expect(spriteCacheSize()).toBeLessThanOrEqual(cap);
  });

  it("still serves repeated identical poses from cache", () => {
    const pose: PoseSpec = { ...DEFAULT_POSE };
    const a = renderFrame(pose);
    const b = renderFrame({ ...pose });
    expect(b).toBe(a);
    expect(spriteCacheSize()).toBe(1);
  });

  it("keeps a hot pose alive under LRU pressure", () => {
    const hot: PoseSpec = { ...DEFAULT_POSE, tailPhase: 0 };
    const first = renderFrame(hot);
    // Churn through many distinct poses, touching the hot one throughout.
    for (let i = 0; i < 500; i++) {
      renderFrame({ ...DEFAULT_POSE, legPhase: i / 500, pupilX: i % 3 });
      renderFrame(hot);
    }
    expect(renderFrame(hot)).toBe(first);
  });
});
