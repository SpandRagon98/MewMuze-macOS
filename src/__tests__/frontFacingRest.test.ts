import { describe, it, expect } from "vitest";
import { ANIMATIONS } from "../animation/animationDefinitions";
import type { AnimationName } from "../types/cat";

/**
 * The cat must come to rest FACING THE USER. Several one-shots used to
 * auto-chain into side-profile idle loops (turnAround/softLand -> sideIdle,
 * pullUp -> sitSide), so after routine actions — turning round, landing from a
 * hop — it parked side-on and just sat there in profile.
 *
 * "Resting" = a looping animation the cat can sit in indefinitely. Transient
 * states (fall, land, shake) are fine in profile because they resolve onward.
 */

/** Follow `next` links until reaching a looping state or a dead end. */
function restingStateAfter(name: AnimationName): AnimationName {
  const seen = new Set<AnimationName>();
  let cur = name;
  while (!seen.has(cur)) {
    seen.add(cur);
    const def = ANIMATIONS[cur];
    if (def.loop) return cur; // settled into a loop
    if (!def.next) return cur;
    cur = def.next;
  }
  return cur;
}

/** Loops the cat may legitimately hold in profile. */
const ALLOWED_SIDE_LOOPS = new Set<AnimationName>([
  "sleep", // curled up asleep — a distinct, readable silhouette
  "hold", // actively holding the cursor
  // Falling loops only until the ground arrives; the engine always replaces it
  // with a landing animation, which chains onward to a front-facing rest.
  "fall",
  "sideIdle", // retained for compatibility; nothing may chain into it
  "sitSide",
]);

describe("the cat settles front-facing", () => {
  it("no one-shot chains into a side-profile resting loop", () => {
    const offenders: string[] = [];
    for (const [name, def] of Object.entries(ANIMATIONS)) {
      if (def.loop || !def.next) continue;
      const rest = restingStateAfter(name as AnimationName);
      if (ALLOWED_SIDE_LOOPS.has(rest)) continue;
      if (ANIMATIONS[rest].view === "side") {
        offenders.push(`${name} -> ... -> ${rest} (side)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("turning, landing and climbing up all end facing the user", () => {
    for (const start of ["turnAround", "softLand", "land", "pullUp", "hardLand"] as AnimationName[]) {
      const rest = restingStateAfter(start);
      expect(
        ANIMATIONS[rest].view,
        `${start} settles into ${rest} (${ANIMATIONS[rest].view})`,
      ).toBe("front");
    }
  });

  it("keeps the side-profile idle loops unreachable", () => {
    const reachable = new Set<string>();
    for (const def of Object.values(ANIMATIONS)) if (def.next) reachable.add(def.next);
    expect(reachable.has("sideIdle")).toBe(false);
    expect(reachable.has("sitSide")).toBe(false);
  });
});
