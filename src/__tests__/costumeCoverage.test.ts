import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography guard
// reads its stylesheet exactly this way.
import { readFileSync } from "node:fs";

/**
 * Every drawing path must dress the cat.
 *
 * A costume gap has been found by eye three separate times - the else-branch
 * of drawFront, the loaf frame that petting alternates into, and the hanging
 * and turning cats - because `drawCat` has five drawing paths and a new one
 * inherits nothing. Each was invisible until someone happened to trigger that
 * pose with a costume on.
 *
 * This is the check that makes a sixth path fail loudly instead.
 */
const sprite: string = readFileSync("src/animation/spriteLoader.ts", "utf8");

/** The body of a top-level function, from its signature to the next one. */
function bodyOf(name: string): string {
  const start = sprite.indexOf(`function ${name}(`);
  expect(start, `${name} should exist`).toBeGreaterThan(-1);
  const next = sprite.indexOf("\nfunction ", start + 1);
  return sprite.slice(start, next === -1 ? undefined : next);
}

describe("costume coverage", () => {
  /**
   * Read straight out of drawCat's dispatch, so adding a view there without a
   * renderer here fails rather than silently going undressed.
   */
  const dispatch = bodyOf("drawCat");
  const VIEWS = ["drawSide", "drawBack", "drawThreeQuarter", "drawFront"];

  it("drawCat still dispatches to exactly the paths this test knows about", () => {
    for (const view of VIEWS) {
      expect(dispatch, `drawCat should dispatch to ${view}`).toContain(`${view}(ctx, pose)`);
    }
    // Any OTHER drawSomething(ctx, pose) in the dispatch is a path nobody has
    // checked for costume support.
    const called = [...dispatch.matchAll(/\b(draw[A-Z]\w*)\(ctx, pose\)/g)].map((m) => m[1]);
    expect([...new Set(called)].sort()).toEqual([...VIEWS].sort());
  });

  it("every view path paints the costume", () => {
    // drawHangingFront is reached by an early return inside drawFront, so it
    // is a sixth path in practice even though drawCat never names it.
    for (const view of [...VIEWS, "drawHangingFront"]) {
      expect(bodyOf(view), `${view} must paint the costume`).toContain("paintCostume(ctx, pose,");
    }
  });

  it("puts accessories on top of a costume's face layer, never under it", () => {
    // With the costume painted after the accessory, a cap or glasses chosen
    // with a cowl or visor on was buried under it and never seen.
    // drawFrontFace tilts the head and hands the painting to paintFrontFace.
    const face = bodyOf("paintFrontFace");
    const seam = face.indexOf('paintCostume(ctx, pose, "face")');
    expect(seam).toBeGreaterThan(-1);
    expect(face.indexOf("frontAccessory(ctx")).toBeGreaterThan(seam);
    const side = bodyOf("drawSide");
    expect(side.lastIndexOf("sideAccessory(ctx")).toBeGreaterThan(side.lastIndexOf('paintCostume(ctx, pose, "face")'));
  });

  it("no branch returns before the cat is dressed", () => {
    // Containing a paintCostume call is not enough. drawBack has a whole
    // separate silhouette for the climbing cat that returned before reaching
    // the paint - so the costume came off for the entire climb, which is the
    // pose you get when the cat is stuck at the top of a window.
    //
    // The one legitimate early return is one that hands the pose to another
    // path which does its own painting.
    for (const view of [...VIEWS, "drawHangingFront"]) {
      const body = bodyOf(view);
      const paint = body.indexOf('paintCostume(ctx, pose, "torso")');
      expect(paint, `${view} must paint the torso`).toBeGreaterThan(-1);
      for (const m of body.slice(0, paint).matchAll(/\breturn;/g)) {
        const lead = body.slice(Math.max(0, (m.index ?? 0) - 160), m.index);
        expect(
          /\bdraw[A-Z]\w*\(ctx, pose\)/.test(lead),
          `${view}: a branch returns undressed at offset ${m.index}`,
        ).toBe(true);
      }
    }
  });

  it("paints after the body and before the limbs that attach to it", () => {
    // The order is the whole reason the hook exists: a keyboard, a laptop and
    // a raised paw must land ON TOP of the clothing.
    //
    // "before the LAST limb", not the first: the hanging cat's gripping
    // forepaws are drawn above the body and reach up to the ledge, nowhere
    // near the torso, while its hind legs hang off the body and do have to be
    // painted over. Requiring the paint to precede every limb would have
    // demanded the jacket be drawn before the body it sits on.
    for (const view of ["drawFront", "drawThreeQuarter", "drawHangingFront"]) {
      const body = bodyOf(view);
      const torso = body.indexOf('paintCostume(ctx, pose, "torso")');
      const limbCalls = [...body.matchAll(/drawFrontPaws\(|curvedLimb\(/g)];
      if (limbCalls.length === 0) continue;
      const lastLimb = limbCalls[limbCalls.length - 1].index ?? 0;
      const firstBody = body.search(/blob\(ctx, [^)]*(BODY|FUR)\)/);
      expect(torso, `${view}: costume goes on after the body`).toBeGreaterThan(firstBody);
      expect(torso, `${view}: costume goes on before the limbs it must sit under`).toBeLessThan(lastLimb);
    }
  });

  it("gives every branch that draws a head its own face seam", () => {
    // Containing one face paint is not enough: drawSide has a whole separate
    // silhouette for the curled sleeper that returns early, and it wore a
    // full costume with a bare head until it got its own seam. Hard counts,
    // so a third branch fails here instead of on someone's desktop.
    const faces = (name: string) =>
      [...bodyOf(name).matchAll(/paintCostume\(ctx, pose, "face"\)/g)].length;
    expect(faces("drawSide"), "drawSide: main path + curled sleeper").toBe(2);
    // The three front paths share ONE seam, inside the face they all draw -
    // which is what lets the accessory go on after the costume in one place.
    // (drawFrontFace only tilts the head and paints it through paintFrontFace.)
    expect(bodyOf("drawFrontFace")).toContain("paintFrontFace(");
    expect(faces("paintFrontFace"), "paintFrontFace: the shared front seam").toBe(1);
    for (const path of ["drawFront", "drawHangingFront", "drawThreeQuarter"]) {
      expect(bodyOf(path), `${path} must draw the shared face`).toContain("drawFrontFace(ctx");
      expect(faces(path), `${path} must not paint the face twice`).toBe(0);
    }
    // The back view has no face to dress; anything worn on the head rides its
    // torso seam, which drawBack paints after the skull.
    expect(faces("drawBack"), "drawBack has no face").toBe(0);
  });

  it("dresses the climbing cat after its head, not before it", () => {
    // drawBack's climbing branch used to paint the costume straight after the
    // body, so a mask or a hat was buried under the skull drawn next.
    const body = bodyOf("drawBack");
    const climb = body.indexOf('pose.body === "climb"');
    const head = body.indexOf("14.5 + pose.headBob", climb);
    const paint = body.indexOf('paintCostume(ctx, pose, "torso")', climb);
    expect(head).toBeGreaterThan(-1);
    expect(paint).toBeGreaterThan(head);
    // And still before the paws, which belong in front of it.
    expect(body.indexOf("for (const paw of paws)", climb)).toBeGreaterThan(paint);
  });

  it("drawFront paints outside its body-state branch", () => {
    // Petting alternates between "sit" and "loaf" frames. Painting inside one
    // arm of that branch made the jacket flicker off on alternate frames.
    const body = bodyOf("drawFront");
    const paint = body.indexOf('paintCostume(ctx, pose, "torso")');
    const branch = body.indexOf('if (pose.body === "dangle")');
    expect(branch).toBeGreaterThan(-1);
    expect(paint, "the torso paint must precede the body-state branch").toBeLessThan(branch);
  });
});
