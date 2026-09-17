import { describe, it, expect } from "vitest";
import { CatEmotionEngine } from "../emotion/emotionEngine";
import { EMOTIONS, EMOTION_IDS, emotion } from "../emotion/emotions";
import { ExpressionController, NO_OVERLAY, applyOverlay, peakOverlay, tearStage, type ExpressionContext } from "../emotion/expression";
import { CatGestureController, GESTURES, safeGesture } from "../emotion/gestures";
import { chatResponse, edgyInvite, isSerious, personaBias, personaGesture, respondToMood } from "../emotion/responses";
import { PERSONAS } from "../companion/persona/personas";
import { DEFAULT_POSE, headTiltPivot, poseKey, type Gesture } from "../animation/spriteLoader";
import { costumeTraits } from "../costumes/costumeOverlay";
import { BATCAT_ID } from "../costumes/batCat";
import { CYBERPUNK_CAT_ID } from "../costumes/cyberpunkCat";
import { CORPORATE_CAT_ID } from "../costumes/corporateCat";
import { PLAYLIST } from "../preview/LookPreviewApp";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";
import { sanitizeSettings } from "../settings/settingsStore";
import { CatEngine } from "../engine/catEngine";
import { buildPlatforms } from "../physics/platformResolver";
import { ACTIVITY_PROFILES } from "../settings/defaultSettings";
import type { NativeMonitor } from "../types/platform";

const FREE: ExpressionContext = { canGesture: true, serious: false, edgyInvited: false };

function run(engine: CatEmotionEngine, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) engine.update(dt);
}

describe("emotion catalogue", () => {
  it("defines every one of the 28 moods plus neutral, each with a way in and a look", () => {
    expect(EMOTION_IDS.length).toBe(29);
    for (const id of EMOTION_IDS) {
      const e = EMOTIONS[id];
      expect(e.id).toBe(id);
      if (id === "neutral") continue;
      expect(e.tiers.length, `${id} has a look`).toBeGreaterThan(0);
      expect(e.duration, `${id} lasts a while`).toBeGreaterThan(0);
      expect(e.fade, `${id} fades`).toBeGreaterThan(0);
    }
  });

  it("only routes through emotions that exist", () => {
    for (const id of EMOTION_IDS) {
      for (const via of [...(emotion(id).enterVia ?? []), ...(emotion(id).exitVia ?? [])]) expect(EMOTION_IDS).toContain(via);
    }
  });
});

describe("CatEmotionEngine priority", () => {
  it("drag > interaction > chat > event > ambient > idle while a feeling holds", () => {
    const e = new CatEmotionEngine();
    expect(e.request({ emotion: "happy", intensity: 0.8, source: "chat" })).toBe(true);
    run(e, 0.5);
    expect(e.request({ emotion: "bored", intensity: 0.8, source: "ambient" })).toBe(false);
    expect(e.request({ emotion: "surprised", intensity: 0.8, source: "event" })).toBe(false);
    expect(e.request({ emotion: "affectionate", intensity: 0.8, source: "interaction" })).toBe(true);
    run(e, 0.2);
    expect(e.request({ emotion: "happy", intensity: 0.8, source: "chat" })).toBe(false);
    expect(e.request({ emotion: "surprised", intensity: 0.8, source: "drag" })).toBe(true);
    expect(e.state.emotion).toBe("surprised");
  });

  it("lets a lower source in once the current feeling has run its course", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "happy", intensity: 0.8, source: "chat", duration: 1 });
    run(e, 1.2);
    expect(e.request({ emotion: "curious", intensity: 0.6, source: "ambient" })).toBe(true);
  });

  it("a drag blocks every other feeling on the desktop cat", () => {
    const cat = makeCat();
    cat.grabStart();
    expect(cat.feel({ emotion: "happy", intensity: 0.9, source: "interaction" })).toBe(false);
    expect(cat.feel({ emotion: "surprised", intensity: 0.9, source: "drag" })).toBe(true);
  });
});

describe("CatEmotionEngine decay and routes", () => {
  it("holds, then fades back to neutral", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "happy", intensity: 0.9, source: "event", duration: 2 });
    run(e, 1.5);
    expect(e.state.intensity).toBeGreaterThan(0.7);
    // Happy lingers (a 25 s half-life), so give it the minutes it takes.
    run(e, 120, 1 / 20);
    expect(e.state.emotion).toBe("neutral");
    expect(e.state.intensity).toBe(0);
  });

  it("never jumps from happy straight to tears: sadness comes first", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "happy", intensity: 0.8, source: "chat" });
    run(e, 0.5);
    e.request({ emotion: "crying", intensity: 0.9, source: "chat" });
    expect(e.state.emotion).toBe("sad");
    run(e, 1.3);
    expect(e.state.emotion).toBe("crying");
  });

  it("full-strength sadness becomes crying, and crying lets go through sadness", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "sad", intensity: 1, source: "chat", duration: 2 });
    run(e, 1.5);
    expect(e.state.emotion).toBe("crying");
    let sawSad = false;
    for (let i = 0; i < 20 * 300; i++) {
      e.update(1 / 20);
      if (e.state.emotion === "sad") sawSad = true;
    }
    expect(sawSad).toBe(true);
    expect(e.state.emotion).toBe("neutral");
  });

  it("a heavy feeling leaves a short, calmer afterglow - and nothing permanent", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "angry", intensity: 0.9, source: "interaction", duration: 1 });
    run(e, 60, 1 / 20);
    expect(e.state.emotion).toBe("neutral");
    expect(e.calmness()).toBeGreaterThan(0.3);
    // Energetic joy arrives softened while calmer.
    e.request({ emotion: "excited", intensity: 1, source: "event" });
    run(e, 1);
    expect(e.state.intensity).toBeLessThan(0.9);
    run(e, 200, 1 / 20);
    expect(e.calmness()).toBe(0);
  });

  it("only blends secondaries that make sense together", () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "comforting", intensity: 0.8, source: "chat", secondary: { emotion: "sad", intensity: 0.4 } });
    expect(e.state.secondary?.emotion).toBe("sad");
    e.request({ emotion: "victory", intensity: 0.8, source: "drag", secondary: { emotion: "crying", intensity: 0.4 } });
    expect(e.state.secondary).toBeNull();
  });
});

describe("ExpressionController", () => {
  const curious = () => {
    const e = new CatEmotionEngine();
    e.request({ emotion: "curious", intensity: 1, source: "event", duration: 10 });
    run(e, 1);
    return e;
  };

  it("Subtle < Balanced < Dramatic in head range", () => {
    const tilt = (level: "subtle" | "balanced" | "dramatic") => {
      const e = curious();
      const x = new ExpressionController(3);
      x.setSettings({ level, edgy: false });
      let o = NO_OVERLAY;
      for (let i = 0; i < 120; i++) o = x.update(1 / 60, e.state, FREE);
      return Math.abs(o.tilt);
    };
    expect(tilt("subtle")).toBeLessThan(tilt("balanced"));
    expect(tilt("balanced")).toBeLessThan(tilt("dramatic"));
  });

  it("Subtle keeps to the face: no hops and no paw signs from accents", () => {
    const e = new CatEmotionEngine();
    const x = new ExpressionController(5);
    x.setSettings({ level: "subtle", edgy: false });
    e.request({ emotion: "excited", intensity: 1, source: "event", duration: 60 });
    for (let i = 0; i < 60 * 40; i++) {
      e.update(1 / 60);
      const o = x.update(1 / 60, e.state, FREE);
      expect(o.anim).toBeNull();
    }
  });

  it("accents are rate-limited: never two starting within the quiet gap", () => {
    const e = new CatEmotionEngine();
    const x = new ExpressionController(9);
    x.setSettings({ level: "dramatic", edgy: false });
    e.request({ emotion: "excited", intensity: 1, source: "event", duration: 120 });
    const starts: number[] = [];
    for (let i = 0; i < 60 * 90; i++) {
      e.update(1 / 60);
      if (x.update(1 / 60, e.state, FREE).anim) starts.push(i / 60);
    }
    expect(starts.length).toBeGreaterThan(0);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThan(1.4);
  });

  it("settles to no overlay once the feeling is gone, leaving the pose untouched", () => {
    const e = new CatEmotionEngine();
    const x = new ExpressionController(1);
    e.request({ emotion: "sad", intensity: 0.8, source: "chat", duration: 1 });
    let o = NO_OVERLAY;
    for (let i = 0; i < 60 * 200; i++) {
      e.update(1 / 60);
      o = x.update(1 / 60, e.state, FREE);
    }
    expect(o.active).toBe(false);
    const base = { ...DEFAULT_POSE, body: "sit" as const };
    expect(poseKey(applyOverlay(base, o, { ...DEFAULT_POSE }))).toBe(poseKey(base));
  });

  it("a clear feeling takes the idle loop's half-lidded beat, but a blink still blinks", () => {
    const ov = peakOverlay("curious");
    expect(applyOverlay({ ...DEFAULT_POSE, eyes: "half" }, ov, { ...DEFAULT_POSE }).eyes).toBe("dilated");
    expect(applyOverlay({ ...DEFAULT_POSE, eyes: "closed" }, ov, { ...DEFAULT_POSE }).eyes).toBe("closed");
    const faint = { ...ov, intensity: 0.2 };
    expect(applyOverlay({ ...DEFAULT_POSE, eyes: "half" }, faint, { ...DEFAULT_POSE }).eyes).toBe("half");
  });

  it("never overrides what the animation chose deliberately", () => {
    const ov = peakOverlay("angry");
    const yawn = { ...DEFAULT_POSE, body: "sit" as const, eyes: "closed" as const, mouth: "open" as const, gesture: "waveA" as Gesture };
    const out = applyOverlay(yawn, ov, { ...DEFAULT_POSE });
    expect(out.eyes).toBe("closed");
    expect(out.mouth).toBe("open");
    expect(out.gesture).toBe("waveA");
  });
});

describe("tears", () => {
  it("water, gather, grow, fall, repeat - never a stream", () => {
    expect(tearStage(0.2)).toBe(1);
    expect(tearStage(1.2)).toBe(2);
    expect(tearStage(2.2)).toBe(3);
    const seen = new Set<number>();
    for (let s = 2.6; s < 2.6 + 3; s += 0.05) seen.add(tearStage(s));
    for (const stage of [2, 3, 4, 5, 6]) expect(seen).toContain(stage);
  });

  it("crying shows tears, and they are gone when the crying is", () => {
    const e = new CatEmotionEngine();
    const x = new ExpressionController(2);
    e.request({ emotion: "sad", intensity: 1, source: "chat", duration: 4 });
    let maxTears = 0;
    let o = NO_OVERLAY;
    for (let i = 0; i < 60 * 8; i++) {
      e.update(1 / 60);
      o = x.update(1 / 60, e.state, FREE);
      maxTears = Math.max(maxTears, o.tears);
    }
    expect(maxTears).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 60 * 60; i++) {
      e.update(1 / 60);
      o = x.update(1 / 60, e.state, FREE);
    }
    expect(o.tears).toBe(0);
  });

  it("stay on the head: only drawn on front views, never over happy eyes", () => {
    const ov = peakOverlay("crying");
    expect(applyOverlay({ ...DEFAULT_POSE, view: "side" }, ov, { ...DEFAULT_POSE }).tears).toBe(0);
    expect(applyOverlay({ ...DEFAULT_POSE, eyes: "happy" }, ov, { ...DEFAULT_POSE }).tears).toBe(0);
    expect(applyOverlay({ ...DEFAULT_POSE, body: "sit" }, ov, { ...DEFAULT_POSE }).tears).toBeGreaterThan(0);
  });
});

describe("gestures", () => {
  it("plays, alternates and then gets out of the way", () => {
    const g = new CatGestureController();
    const safe = { enabled: false, invited: false, serious: false };
    expect(g.pose(0, safe)).toBeNull();
    g.play("wave", 0);
    expect(g.playing).toBe("wave");
    const poses = new Set<Gesture | null>();
    for (let t = 0; t < GESTURES.wave.dur; t += 0.05) poses.add(g.pose(t, safe));
    expect(poses).toContain("waveA");
    expect(poses).toContain("waveB");
    expect(g.pose(GESTURES.wave.dur + 0.01, safe)).toBeNull();
    expect(g.playing).toBeNull();
  });

  it("the edgy gesture is OFF by default", () => {
    expect(DEFAULT_SETTINGS.edgyGestures).toBe(false);
    expect(new ExpressionController().getSettings().edgy).toBe(false);
  });

  it("needs the setting AND an invitation AND a light moment", () => {
    expect(safeGesture("middle", { enabled: false, invited: true, serious: false })).toBe("dismiss");
    expect(safeGesture("middle", { enabled: true, invited: false, serious: false })).toBe("dismiss");
    expect(safeGesture("middle", { enabled: true, invited: true, serious: true })).toBe("dismiss");
    expect(safeGesture("middle", { enabled: true, invited: true, serious: false })).toBe("middle");
    expect(safeGesture("waveA", { enabled: false, invited: false, serious: true })).toBe("waveA");
  });

  it("never shows it randomly: a long savage/rage stretch with the setting off stays clean", () => {
    for (const id of ["savage", "rage"] as const) {
      const e = new CatEmotionEngine();
      const x = new ExpressionController(11);
      e.request({ emotion: id, intensity: 1, source: "interaction", duration: 300 });
      for (let i = 0; i < 60 * 120; i++) {
        e.update(1 / 60);
        expect(x.update(1 / 60, e.state, { ...FREE, edgyInvited: true }).gesture).not.toBe("middle");
      }
    }
  });

  it("never in a serious context, even with the setting on and invited", () => {
    const e = new CatEmotionEngine();
    const x = new ExpressionController(13);
    x.setSettings({ level: "dramatic", edgy: true });
    e.request({ emotion: "rage", intensity: 1, source: "interaction", duration: 300 });
    for (let i = 0; i < 60 * 120; i++) {
      e.update(1 / 60);
      expect(x.update(1 / 60, e.state, { canGesture: true, serious: true, edgyInvited: true }).gesture).not.toBe("middle");
    }
  });
});

describe("personas and the user's mood", () => {
  it("responds to the user's feeling rather than mirroring it", () => {
    expect(respondToMood("sad", 0.8)?.emotion).toBe("comforting");
    expect(respondToMood("angry", 0.8)?.emotion).toBe("comforting");
    expect(respondToMood("tired", 0.8)?.emotion).toBe("sleepy");
    expect(respondToMood("happy", 0.8)?.emotion).toBe("happy");
    expect(respondToMood("sad", 0.05)).toBeNull();
  });

  it("gives every persona a lean made of real emotions", () => {
    for (const p of PERSONAS) {
      const bias = personaBias(p.id);
      expect(bias, `${p.id} has a lean`).not.toBeNull();
      expect(EMOTION_IDS).toContain(bias!.emotion);
    }
  });

  it("biases without locking: a heavy mood beats a playful persona", () => {
    expect(chatResponse("neutral", 0, "savage_bestie")?.emotion).toBe("savage");
    expect(chatResponse("sad", 0.8, "savage_bestie")?.emotion).toBe("comforting");
    const mild = chatResponse("happy", 0.3, "savage_bestie");
    expect(mild?.emotion).toBe("savage");
    expect(mild?.secondary?.emotion).toBe("happy");
  });

  it("marks health, grief and professional moments serious", () => {
    expect(isSerious("health_guide", null)).toBe(true);
    expect(isSerious("breakup_buddy", null)).toBe(true);
    expect(isSerious("career_coach", null)).toBe(true);
    expect(isSerious("mewmuze", "sad")).toBe(true);
    expect(isSerious("savage_bestie", "happy")).toBe(false);
  });
});

describe("settings", () => {
  it("defaults to Balanced, edgy off, butterflies on", () => {
    expect(DEFAULT_SETTINGS.expressionIntensity).toBe("balanced");
    expect(DEFAULT_SETTINGS.butterflyVisits).toBe(true);
  });

  it("sanitises what it cannot trust", () => {
    const bad = sanitizeSettings({ expressionIntensity: "extreme", edgyGestures: "yes", butterflyVisits: 1 });
    expect(bad.expressionIntensity).toBe("balanced");
    expect(bad.edgyGestures).toBe(false);
    expect(bad.butterflyVisits).toBe(true);
    const good = sanitizeSettings({ expressionIntensity: "dramatic", edgyGestures: true, butterflyVisits: false });
    expect(good.expressionIntensity).toBe("dramatic");
    expect(good.edgyGestures).toBe(true);
    expect(good.butterflyVisits).toBe(false);
  });
});

// ---- the desktop cat ------------------------------------------------------

const monitor: NativeMonitor = {
  left: 0, top: 0, right: 800, bottom: 600, workLeft: 0, workTop: 0, workRight: 800, workBottom: 580, scale: 1, isPrimary: true,
};
function makeCat(): CatEngine {
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
  const cat = new CatEngine({ sizePx: 40, scale: 1, activity: ACTIVITY_PROFILES.balanced, bounds, start: { x: 400, y: 560 }, random: () => 0.5 });
  cat.setWorld({ platforms: buildPlatforms([], [monitor], { left: 0, top: 0 }), bounds, monitors: [monitor], origin: { left: 0, top: 0 }, scale: 1 });
  return cat;
}

describe("CatEngine emotion integration", () => {
  it("adds nothing to the pose when nothing is felt (idle frames stay cacheable)", () => {
    const cat = makeCat();
    for (let i = 0; i < 400; i++) cat.tick(1 / 60, i * 16);
    expect(cat.getOverlay().active).toBe(false);
    expect(cat.getRender().pose.headTilt).toBe(0);
    expect(cat.getRender().pose.tears).toBe(0);
  });

  it("a sleeping cat draws only a handful of distinct frames a minute, cursor or not", () => {
    const cat = makeCat();
    cat.setDrowsyAfterS(5);
    cat.setUserIdle(true, 999);
    let i = 0;
    for (; i < 60 * 30 && cat.state.currentAnimation !== "sleep"; i++) cat.tick(1 / 60, i * 16);
    expect(cat.state.currentAnimation).toBe("sleep");
    // One minute asleep while a cursor wanders about: every distinct signature
    // is a sprite to draw and a repaint of the whole overlay (CatRenderer).
    const seen = new Set<string>();
    let repaints = 0;
    let prev = "";
    for (let k = 0; k < 60 * 60; k++, i++) {
      cat.setCursor({ x: 300 + 200 * Math.sin(k / 40), y: 400 + 80 * Math.cos(k / 55), speed: 120, dirX: 1, dirY: 0, timestamp: i * 16 });
      cat.tick(1 / 60, i * 16);
      const r = cat.getRender();
      const sig = `${poseKey(r.pose)}|${r.tailPhase}|${r.pupilX}|${r.pupilY}|${r.headTurnX}|${r.headTurnY}`;
      if (sig !== prev) repaints++;
      prev = sig;
      seen.add(sig);
    }
    expect(cat.state.currentAnimation).toBe("sleep"); // still asleep: no yawn every six seconds
    // Before: it re-yawned every 6 s, the tail took 40 steps a cycle and the eyes
    // followed the cursor behind closed lids - 446 distinct frames in this minute.
    expect(seen.size).toBeLessThanOrEqual(192); // fits the sprite cache: nothing re-rasterised
    // 579 with eighth-unit breathing (under a pixel, so identical pictures); 219 now.
    expect(repaints).toBeLessThan(240);
  });

  it("the petting blush passes in a moment once the strokes stop", () => {
    const cat = makeCat();
    for (let i = 0; i < 120; i++) cat.tick(1 / 60, i * 16);
    for (let i = 0; i < 180; i++) {
      cat.setPetting(true);
      cat.tick(1 / 60, 2000 + i * 16);
    }
    expect(cat.feeling().emotion).toBe("affectionate");
    cat.setPetting(false);
    for (let i = 0; i < 60 * 5; i++) cat.tick(1 / 60, 6000 + i * 16);
    expect(cat.getRender().pose.blush).toBe(false); // gone within 5 s
    for (let i = 0; i < 60 * 15; i++) cat.tick(1 / 60, 12000 + i * 16);
    expect(cat.feeling().emotion).toBe("neutral"); // and the whole face within 20 s
  });

  it("shows a feeling on the grounded cat, then lets it go", () => {
    const cat = makeCat();
    for (let i = 0; i < 120; i++) cat.tick(1 / 60, i * 16);
    expect(cat.feel({ emotion: "sad", intensity: 0.8, source: "chat", duration: 1 })).toBe(true);
    for (let i = 0; i < 90; i++) cat.tick(1 / 60, 2000 + i * 16);
    expect(cat.getOverlay().active).toBe(true);
    for (let i = 0; i < 30 * 200; i++) cat.tick(1 / 30, 4000 + i * 33);
    expect(cat.feeling().emotion).toBe("neutral");
    expect(cat.getOverlay().active).toBe(false);
  });
});

describe("tease and persona greetings", () => {
  /** Tease a grounded, settled cat and collect every paw pose it shows. */
  const teaseGestures = (edgy: boolean, serious: boolean) => {
    const cat = makeCat();
    cat.setExpressionSettings({ level: "balanced", edgy });
    cat.setEmotionContext({ serious, edgyInvited: false });
    for (let i = 0; i < 120; i++) cat.tick(1 / 60, i * 16);
    cat.tease();
    const seen = new Set<string>();
    for (let i = 0; i < 120; i++) {
      cat.tick(1 / 60, 2000 + i * 16);
      seen.add(cat.getRender().pose.gesture);
    }
    return seen;
  };

  it("Tease with Edgy gestures off: a dismissive wave, never the rude paw", () => {
    const seen = teaseGestures(false, false);
    expect(seen).toContain("dismiss");
    expect(seen).not.toContain("middle");
  });

  it("Tease with Edgy gestures on shows it - but not in a serious conversation", () => {
    expect(teaseGestures(true, false)).toContain("middle");
    const serious = teaseGestures(true, true);
    expect(serious).not.toContain("middle");
    expect(serious).toContain("dismiss");
  });

  it("the grab tantrum invites it only while the rage lasts", () => {
    const cat = makeCat();
    cat.setExpressionSettings({ level: "balanced", edgy: false });
    for (let i = 0; i < 6; i++) {
      cat.grabStart();
      cat.grabEnd(null);
    }
    for (let i = 0; i < 60 * 20; i++) {
      cat.tick(1 / 60, i * 16);
      expect(cat.getRender().pose.gesture).not.toBe("middle");
    }
  });

  it("a persona says hello once, and serious personas do not wave", () => {
    expect(personaGesture("hype_cat")).toBe("clap");
    expect(personaGesture("fitness_coach")).toBe("thumbsUp");
    expect(personaGesture("health_guide")).toBeNull();
    expect(personaGesture("breakup_buddy")).toBeNull();
    expect(personaGesture(null)).toBeNull();
    for (const p of PERSONAS) {
      const g = personaGesture(p.id);
      if (g) expect(Object.keys(GESTURES)).toContain(g);
      expect(g, p.id).not.toBe("middle");
    }
  });

  it("only Savage Bestie banter invites edginess, and never over sadness", () => {
    expect(edgyInvite("savage_bestie", "playful")).toBe(true);
    expect(edgyInvite("savage_bestie", null)).toBe(true);
    expect(edgyInvite("savage_bestie", "sad")).toBe(false);
    expect(edgyInvite("savage_bestie", "angry")).toBe(false);
    expect(edgyInvite("mewmuze", "playful")).toBe(false);
  });
});
describe("costume compatibility", () => {
  it("costumes declare what they cover; unknown costumes cover nothing", () => {
    expect(costumeTraits(BATCAT_ID).hidesEars).toBe(true);
    expect(costumeTraits(CYBERPUNK_CAT_ID).coversEyes).toBe(true);
    expect(costumeTraits(CORPORATE_CAT_ID)).toEqual({});
    expect(costumeTraits("someone.else.v1")).toEqual({});
  });

  it("under a cowl the head does more and the hidden ears are left alone", () => {
    const run = (traits: object) => {
      const e = new CatEmotionEngine();
      const x = new ExpressionController(4);
      x.setCostumeTraits(traits);
      e.request({ emotion: "curious", intensity: 1, source: "event", duration: 10 });
      let o = NO_OVERLAY;
      for (let i = 0; i < 150; i++) {
        e.update(1 / 60);
        o = x.update(1 / 60, e.state, FREE);
      }
      return o;
    };
    const bare = run({});
    const cowl = run({ hidesEars: true });
    expect(bare.look.ears).toBeDefined();
    expect(cowl.look.ears).toBeUndefined();
    expect(Math.abs(cowl.tilt)).toBeGreaterThan(Math.abs(bare.tilt));
  });

  it("a hat on an installed costume turns about the same neck as the head", () => {
    expect(headTiltPivot({ ...DEFAULT_POSE, headTilt: 0 })).toBeNull();
    expect(headTiltPivot({ ...DEFAULT_POSE, view: "side", headTilt: 8 })).toBeNull();
    const p = headTiltPivot({ ...DEFAULT_POSE, headTilt: 8 })!;
    expect(p.y).toBeGreaterThan(15); // below the skull centre: the neck
    expect(p.x).toBeGreaterThan(20);
    expect(p.x).toBeLessThan(28);
  });

  it("the Look Preview's feelings are real emotions", () => {
    const felt = PLAYLIST.filter((p) => p.emotion);
    expect(felt.map((p) => p.label)).toEqual(expect.arrayContaining(["Curious", "Happy", "Sad", "Savage", "Victory", "Excited"]));
    for (const p of felt) expect(EMOTION_IDS).toContain(p.emotion);
  });
});