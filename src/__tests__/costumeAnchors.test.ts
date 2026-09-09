import { describe, it, expect, afterEach } from "vitest";
import {
  bodyAnchors,
  frontLimbs,
  configureAppearance,
  DEFAULT_APPEARANCE,
  DEFAULT_POSE,
  type PoseSpec,
} from "../animation/spriteLoader";

/** A pose built from the renderer's own default, so nothing drifts silently. */
function pose(over: Partial<PoseSpec> = {}): PoseSpec {
  return { ...DEFAULT_POSE, ...over };
}

afterEach(() => {
  // configureAppearance writes module-global palettes and species traits.
  configureAppearance(DEFAULT_APPEARANCE);
});

describe("body anchors", () => {
  it("reports a real torso and head for every body state, in both views", () => {
    const bodies: PoseSpec["body"][] = [
      "stand", "sit", "crouch", "lie", "air", "loaf", "dangle", "stretch", "climb", "hang",
    ];
    for (const view of ["side", "front", "back", "threeQuarter"] as const) {
      for (const body of bodies) {
        const a = bodyAnchors(pose({ view, body }));
        for (const [name, e] of [["torso", a.torso], ["head", a.head]] as const) {
          expect(Number.isFinite(e.x), `${view}/${body} ${name}.x`).toBe(true);
          expect(Number.isFinite(e.y), `${view}/${body} ${name}.y`).toBe(true);
          expect(e.rx, `${view}/${body} ${name}.rx`).toBeGreaterThan(0);
          expect(e.ry, `${view}/${body} ${name}.ry`).toBeGreaterThan(0);
          // Everything must land inside the 48-unit design space, or a costume
          // anchored to it would be drawn off the edge of the sprite.
          expect(e.x, `${view}/${body} ${name}.x range`).toBeGreaterThan(-8);
          expect(e.x, `${view}/${body} ${name}.x range`).toBeLessThan(56);
          expect(e.y, `${view}/${body} ${name}.y range`).toBeGreaterThan(-8);
          expect(e.y, `${view}/${body} ${name}.y range`).toBeLessThan(56);
        }
      }
    }
  });

  it("moves the torso between poses — the reason a fixed image cannot work", () => {
    const stand = bodyAnchors(pose({ view: "side", body: "stand" })).torso;
    const lie = bodyAnchors(pose({ view: "side", body: "lie" })).torso;
    const sit = bodyAnchors(pose({ view: "side", body: "sit" })).torso;

    // Lying: lower and much flatter.
    expect(lie.y).toBeGreaterThan(stand.y + 4);
    expect(lie.ry).toBeLessThan(stand.ry * 0.7);
    expect(lie.rx).toBeGreaterThan(stand.rx);

    // Sitting: taller and narrower than standing.
    expect(sit.ry).toBeGreaterThan(stand.ry);
    expect(sit.rx).toBeLessThan(stand.rx);
  });

  it("scales the torso with species, and applies that scaling exactly once", () => {
    configureAppearance({ ...DEFAULT_APPEARANCE, species: "classic" });
    const classic = bodyAnchors(pose({ view: "side" })).torso;
    configureAppearance({ ...DEFAULT_APPEARANCE, species: "chonk" });
    const chonk = bodyAnchors(pose({ view: "side" })).torso;
    configureAppearance({ ...DEFAULT_APPEARANCE, species: "kitten" });
    const kitten = bodyAnchors(pose({ view: "side" })).torso;

    // The traits table says chonk is 1.3x wide and kitten 0.8x. Applying the
    // multiplier twice - the bug the anchor extraction had to avoid - would
    // give 1.69x and 0.64x, so these bounds are deliberately tight.
    expect(chonk.rx / classic.rx).toBeCloseTo(1.3, 5);
    expect(kitten.rx / classic.rx).toBeCloseTo(0.8, 5);
    expect(chonk.ry / classic.ry).toBeCloseTo(1.12, 5);

    // Short legs ride lower, and that too must be applied once.
    expect(chonk.y - classic.y).toBeCloseTo(2.4, 5);
    expect(kitten.y - classic.y).toBeCloseTo(3, 5);
  });

  it("does not drop a lying cat through the floor for short-legged breeds", () => {
    configureAppearance({ ...DEFAULT_APPEARANCE, species: "chonk" });
    const classicLie = 40;
    const lie = bodyAnchors(pose({ view: "side", body: "lie" })).torso;
    // bodyDrop models short legs, so it must NOT apply to a cat already down.
    expect(lie.y).toBeCloseTo(classicLie, 5);
  });

  it("follows the head bob, so a hat or spectacles ride with the skull", () => {
    const still = bodyAnchors(pose({ view: "front", headBob: 0 })).head;
    const bobbed = bodyAnchors(pose({ view: "front", headBob: 1.5 })).head;
    expect(bobbed.y - still.y).toBeCloseTo(1.5, 5);
  });

  it("gives the back view the wider body drawBack actually paints", () => {
    // This used to return the FRONT body, and the test asserted that as if it
    // were the intent. drawBack paints (24, 35.5) r10x8.6 - a unit and a half
    // lower and a unit wider - so a jacket sat above the mass it was on.
    const back = bodyAnchors(pose({ view: "back" })).torso;
    expect(back).toEqual({ x: 24, y: 35.5, rx: 10, ry: 8.6 });
    expect(back).not.toEqual(bodyAnchors(pose({ view: "front" })).torso);
  });

  it("gives the climbing cat the swaying body drawBack's own branch draws", () => {
    // The pose you get when the cat is stuck at the top of a window. It is a
    // separate silhouette inside drawBack, unscaled and swaying with legPhase,
    // and it was reporting the standing front-view body.
    const still = bodyAnchors(pose({ view: "back", body: "climb", legPhase: 0 })).torso;
    expect(still).toEqual({ x: 24, y: 31, rx: 8, ry: 10.5 });
    const swung = bodyAnchors(pose({ view: "back", body: "climb", legPhase: 0.25 })).torso;
    expect(swung.x).toBeCloseTo(24 + 1.4, 5);
  });

  it("reports the skull the renderer draws, not the smaller collar anchor", () => {
    // `head` is where a collar meets the jaw and is deliberately smaller than
    // the drawn skull. Eyewear sized off it came out a third too small.
    const a = bodyAnchors(pose({ view: "front" }));
    expect(a.skull.rx).toBeCloseTo(12.3, 5);
    expect(a.skull.ry).toBeCloseTo(11, 5);
    expect(a.skull.rx).toBeGreaterThan(a.head.rx);
    // Wide enough to cover both eyes: drawFrontFace puts their outer edges at
    // eyeGap 5.8 plus an iris radius of up to 5.
    expect(a.skull.rx).toBeGreaterThan(5.8 + 5);
  });

  it("leans the skull with the look direction, and leaves the collar alone", () => {
    // The head lean used to live only inside the drawing code, so a visor
    // stayed put while the face moved out from under it.
    const still = bodyAnchors(pose({ view: "front" }));
    const turned = bodyAnchors(pose({ view: "front", headTurnX: 2, headTurnY: 1 }));
    expect(turned.skull.x - still.skull.x).toBeCloseTo(1.9, 5);
    expect(turned.skull.y - still.skull.y).toBeCloseTo(0.62, 5);
    expect(turned.head.x).toBeCloseTo(still.head.x, 5);
  });

  it("leans the profile skull too, and keeps the stretch clamp last", () => {
    const still = bodyAnchors(pose({ view: "side" }));
    const turned = bodyAnchors(pose({ view: "side", headTurnX: 2 }));
    expect(turned.skull.x - still.skull.x).toBeCloseTo(1.9, 5);
    // A deep bow with a hard lean must still land inside the sprite.
    const bowed = bodyAnchors(pose({ view: "side", body: "stretch", legPhase: 1, headTurnX: 2 }));
    expect(bowed.skull.x + bowed.skull.rx).toBeLessThanOrEqual(46);
    expect(bowed.skull.y + bowed.skull.ry).toBeLessThanOrEqual(46);
  });

  it("gives the turning cat its own body, because drawThreeQuarter draws one", () => {
    // This used to return the front body, which put the jacket a unit to the
    // right of the torso and the wrong shape - drawThreeQuarter builds its own
    // mass at (23, 36) r8.8x7.6, offset left of centre.
    const tq = bodyAnchors(pose({ view: "threeQuarter" })).torso;
    expect(tq).toEqual({ x: 23, y: 36, rx: 8.8, ry: 7.6 });
    expect(tq).not.toEqual(bodyAnchors(pose({ view: "front" })).torso);
  });

  it("gives the hanging cat the swinging body drawHangingFront draws", () => {
    // Gripping a window edge is its own drawing path with no species scaling;
    // the body swings with legPhase, so the jacket has to swing with it.
    const still = bodyAnchors(pose({ view: "front", body: "hang", legPhase: 0 })).torso;
    expect(still).toEqual({ x: 24, y: 34, rx: 7.6, ry: 8.2 });
    const swung = bodyAnchors(pose({ view: "front", body: "hang", legPhase: 0.25 })).torso;
    expect(swung.x).toBeCloseTo(24 + 1.2, 5);
  });

  it("keeps the torso inside the sprite when a placard drops the whole cat", () => {
    configureAppearance({ ...DEFAULT_APPEARANCE, species: "chonk" });
    const t = bodyAnchors(pose({ view: "front", prop: "placard" })).torso;
    // The clamp exists because the placard drop plus a heavy breed's own drop
    // pushed the body through the bottom edge.
    expect(t.y + t.ry).toBeLessThanOrEqual(48);
  });

  it("is pure — the same pose always gives the same answer", () => {
    const p = pose({ view: "side", body: "sit", headBob: 0.7 });
    expect(bodyAnchors(p)).toEqual(bodyAnchors(p));
  });
});

describe("the Corporate Cat art matches the geometry it was drawn against", () => {
  // These are the reference values baked into the costume's manifest. If a pose
  // is ever retuned, the art silently stops fitting - this is the alarm.
  const REFERENCE = {
    side: { torso: { x: 17.5, y: 34.5, rx: 9.6, ry: 7.0 }, head: { x: 31, y: 21.5, rx: 10.2, ry: 9.6 } },
    front: { torso: { x: 24, y: 34, rx: 9, ry: 8.8 }, head: { x: 24, y: 15.5, rx: 8.4, ry: 7.6 } },
  };

  it("side reference equals the standing classic cat", () => {
    const a = bodyAnchors(pose({ view: "side", body: "stand", legPhase: 0, headBob: 0 }));
    expect(a.torso).toEqual(REFERENCE.side.torso);
    expect(a.head).toEqual(REFERENCE.side.head);
  });

  it("front reference equals the standing classic cat", () => {
    const a = bodyAnchors(pose({ view: "front", body: "stand", headBob: 0 }));
    expect(a.torso).toEqual(REFERENCE.front.torso);
    expect(a.head).toEqual(REFERENCE.front.head);
  });
});

describe("aspect clamping keeps a garment wearable on an extreme pose", () => {
  /** The clamp as costumeOverlay applies it. */
  function clamp(sx: number, sy: number, limit: number) {
    const uniform = Math.sqrt(sx * sy);
    return [
      Math.min(Math.max(sx, uniform / limit), uniform * limit),
      Math.min(Math.max(sy, uniform / limit), uniform * limit),
    ];
  }

  it("stops a lying cat squashing the jacket into a slab", () => {
    const ref = { rx: 9.6, ry: 7.0 };                       // standing side torso
    const lie = bodyAnchors(pose({ view: "side", body: "lie" })).torso;
    const [sx, sy] = clamp(lie.rx / ref.rx, lie.ry / ref.ry, 1.15);
    // Unclamped this is 1.30 x 0.60 - more than twice as wide as tall.
    expect(sx / sy).toBeLessThanOrEqual(1.15 * 1.15 + 1e-9);
    expect(sy).toBeGreaterThan(0.6);
  });

  it("leaves an ordinary standing pose untouched", () => {
    const [sx, sy] = clamp(1, 1, 1.15);
    expect(sx).toBeCloseTo(1, 6);
    expect(sy).toBeCloseTo(1, 6);
  });

  it("preserves area, so the garment neither shrinks nor grows overall", () => {
    for (const [a, b] of [[1.3, 0.6], [0.7, 1.4], [1, 1]]) {
      const [sx, sy] = clamp(a, b, 1.15);
      expect(sx * sy).toBeCloseTo(a * b, 6);
    }
  });
});

describe("the curled sleeping cat is its own pose", () => {
  it("reports the curled body, not the generic lying ellipse", () => {
    // drawSide has a dedicated branch for a sleeping cat that draws its own
    // geometry and returns early. Reporting the generic "lie" values here put
    // the jacket where the body was not, and sleep was the one pose that came
    // out undressed.
    const awake = bodyAnchors(pose({ view: "side", body: "lie", eyes: "open" })).torso;
    const asleep = bodyAnchors(pose({ view: "side", body: "lie", eyes: "closed" })).torso;
    expect(asleep).not.toEqual(awake);
    expect(asleep.x).toBeCloseTo(25, 5);
    expect(asleep.ry).toBeGreaterThan(awake.ry); // curled up is rounder than flat
  });

  it("is the one side pose that faces left", () => {
    expect(bodyAnchors(pose({ view: "side", body: "lie", eyes: "closed" })).faces).toBe(-1);
    for (const body of ["stand", "sit", "crouch", "stretch"] as const) {
      expect(bodyAnchors(pose({ view: "side", body })).faces, body).toBe(1);
    }
    expect(bodyAnchors(pose({ view: "front" })).faces).toBe(1);
  });

  it("breathes, so a garment on it breathes too", () => {
    const still = bodyAnchors(pose({ view: "side", body: "lie", eyes: "closed", headBob: 0 })).torso;
    const breathing = bodyAnchors(pose({ view: "side", body: "lie", eyes: "closed", headBob: 2 })).torso;
    expect(breathing.y).toBeLessThan(still.y);
  });
});

describe("limb paths are shared with the renderer", () => {
  it("gives a sleeve somewhere to sit for the gestures that raise a paw", () => {
    for (const gesture of ["cheer", "clap", "knead", "pawUp", "groom", "swat", "none"] as const) {
      const limbs = frontLimbs(pose({ view: "front", gesture }), 36);
      expect(limbs.length, gesture).toBeGreaterThan(0);
      for (const limb of limbs) {
        for (const p of [limb.from, limb.ctrl, limb.to]) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y), gesture).toBe(true);
        }
      }
    }
  });

  it("reports no limb where the prop draws its own paws", () => {
    // A keyboard, laptop, placard or calculator draws the forepaws itself, so
    // there is no free-standing limb to put a sleeve on.
    for (const prop of ["keyboard", "laptop", "placard", "calculator"] as const) {
      expect(frontLimbs(pose({ view: "front", prop }), 36), prop).toHaveLength(0);
    }
  });

  it("moves the raised paw as the gesture progresses", () => {
    const early = frontLimbs(pose({ view: "front", gesture: "pawUp", legPhase: 0.2 }), 36);
    const late = frontLimbs(pose({ view: "front", gesture: "pawUp", legPhase: 0.8 }), 36);
    // Which paw is raised swaps at the half-way point; a sleeve that did not
    // follow would sit on the wrong arm.
    expect(early[0].to.x).not.toBeCloseTo(late[0].to.x, 3);
  });
});
