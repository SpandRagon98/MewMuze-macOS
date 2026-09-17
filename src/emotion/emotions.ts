//! The emotion catalogue: every feeling MewMuze can show, as DATA.
//!
//! An emotion never draws anything itself. It is a set of pose values (eyes,
//! brows, ears, mouth, tail, head tilt, marks) that the ExpressionController
//! lays over whatever animation is playing, plus the timing of small idle
//! accents and gestures. The renderer, costumes, Photo Mode and the preview
//! window all read the resulting pose, so there is one emotional system and
//! no per-costume copy of it.
//!
//! Intensity is continuous (0..1). `tiers` are cumulative: every tier whose
//! `at` is at or below the current intensity applies, in order, so sad at 0.2
//! only drops the gaze, at 0.5 the ears and head go down too, and at 0.8 the
//! eyes are wet.

import { type BodyState, type BrowState, type CatTint, type EarState, type EyeState, type Gesture, type MouthState, type TailState } from "../animation/spriteLoader";
import type { AnimationName } from "../types/cat";

export const EMOTION_IDS = [
  "neutral", "happy", "excited", "sad", "crying", "savage", "angry", "rage", "victory", "proud", "shy", "embarrassed",
  "confused", "suspicious", "curious", "surprised", "scared", "tired", "bored", "annoyed", "affectionate", "love",
  "determined", "cheering", "comforting", "mischievous", "thinking", "relieved", "sleepy",
] as const;
export type EmotionId = (typeof EMOTION_IDS)[number];

/** What an emotion paints over the current animation. Unset fields leave the animation's own. */
export interface Look {
  eyes?: EyeState;
  brow?: BrowState;
  mouth?: MouthState;
  ears?: EarState;
  tail?: TailState;
  body?: BodyState;
  tint?: CatTint;
  blush?: boolean;
  sweat?: boolean;
  anger?: boolean;
  sparkle?: boolean;
  hearts?: boolean;
  zzz?: boolean;
  /** Head roll in degrees at full strength (scaled by intensity and the Expression setting). */
  tilt?: number;
  /** headBob offset: + drops the head (heavy, sad), − lifts it (proud, alert). */
  bob?: number;
  /** Where the eyes rest when nothing is being watched, in pupil units (±2). */
  gaze?: { x: number; y: number };
}

/** A small, occasional variation: a blink, a bounce, a paw, a hop. */
export interface Accent {
  id: string;
  /** Seconds between accents, randomised within this range. */
  every: [number, number];
  /** Seconds it lasts. */
  dur: number;
  look?: Look;
  /** A gesture for the duration; several alternate (a wave, a stomp). */
  gesture?: Gesture | readonly Gesture[];
  /** A one-shot animation for the whole body (a hop, a yawn). */
  anim?: AnimationName;
  /** Lowest intensity at which it may happen. */
  min?: number;
  /** Behind the Edgy gestures setting and its safeguards. */
  edgy?: boolean;
}

export type Movement = "still" | "slow" | "normal" | "lively";

export interface EmotionSpec {
  id: EmotionId;
  label: string;
  /** −1 unpleasant .. +1 pleasant. */
  valence: number;
  /** 0 drained .. 1 wired. */
  energy: number;
  tiers: readonly { at: number; look: Look }[];
  /** A gesture held while the feeling is at least `min`. */
  hold?: { gesture: Gesture | readonly Gesture[]; min: number; period?: number };
  accents?: readonly Accent[];
  /** Tail sway speed multiplier. */
  tail: number;
  /** "still": sits and feels it; "slow": wanders less, walks slower; "lively": bursts of play. */
  movement: Movement;
  /** Default seconds a request lasts before it starts to fade. */
  duration: number;
  /** Seconds for the fade to halve the intensity. */
  fade: number;
  /** Must pass through these first: sad before crying, annoyed before rage. */
  enterVia?: readonly EmotionId[];
  /** Falls back through these as it fades: crying → sad, rage → annoyed. */
  exitVia?: readonly EmotionId[];
  /** Secondary emotions that make sense alongside. */
  blends?: readonly EmotionId[];
  /** Grief, fear, comfort: no playful accents, never an edgy gesture. */
  serious?: boolean;
  /** Tears follow the crying cycle (expression.ts). */
  cries?: boolean;
}

const e = (s: EmotionSpec): EmotionSpec => s;

export const EMOTIONS: Record<EmotionId, EmotionSpec> = {
  neutral: e({ id: "neutral", label: "Neutral", valence: 0, energy: 0.5, tiers: [], tail: 1, movement: "normal", duration: 0, fade: 1 }),

  happy: e({
    id: "happy", label: "Happy", valence: 0.7, energy: 0.6,
    tiers: [
      { at: 0, look: { mouth: "smile", ears: "up" } },
      { at: 0.45, look: { tail: "up", tilt: 4, bob: -0.4 } },
      { at: 0.75, look: { eyes: "wide", tilt: 7 } },
    ],
    accents: [
      { id: "bounce", every: [4, 8], dur: 0.55, look: { bob: -1.4, tilt: 8 } },
      { id: "happy-blink", every: [3, 6], dur: 0.3, look: { eyes: "happy" } },
      { id: "tail", every: [5, 9], dur: 0.9, look: { tail: "flick" } },
      { id: "wave", every: [10, 16], dur: 1.1, gesture: ["waveA", "waveB"], min: 0.65 },
    ],
    tail: 1.4, movement: "normal", duration: 20, fade: 25, blends: ["curious", "affectionate", "tired", "shy"],
  }),

  excited: e({
    id: "excited", label: "Excited", valence: 0.8, energy: 0.95,
    tiers: [
      { at: 0, look: { eyes: "wide", mouth: "smile", ears: "perk", tail: "up" } },
      { at: 0.5, look: { eyes: "sparkle", mouth: "grin", bob: -0.6 } },
      { at: 0.75, look: { sparkle: true, tilt: 6 } },
    ],
    accents: [
      { id: "hop", every: [3, 6], dur: 0.6, anim: "smallHop", min: 0.5 },
      { id: "bounce", every: [2, 4], dur: 0.35, look: { bob: -1.8 } },
      { id: "wobble", every: [3, 5], dur: 0.3, look: { tilt: -8 } },
      { id: "cheer", every: [5, 9], dur: 0.9, gesture: "cheer", min: 0.6 },
    ],
    tail: 2.2, movement: "lively", duration: 12, fade: 10, blends: ["curious", "happy"],
  }),

  sad: e({
    id: "sad", label: "Sad", valence: -0.6, energy: 0.25,
    tiers: [
      { at: 0, look: { brow: "worried", gaze: { x: 0, y: 1.3 } } },
      { at: 0.5, look: { ears: "down", tail: "down", mouth: "frown", bob: 1, tilt: -4 } },
      { at: 0.8, look: { eyes: "watery", brow: "sad", tint: "sad", bob: 1.6, tilt: -6 } },
    ],
    accents: [
      { id: "sigh", every: [6, 11], dur: 1.2, look: { eyes: "half", bob: 2 } },
      { id: "look-away", every: [7, 12], dur: 1.6, look: { gaze: { x: -1.6, y: 1.1 } } },
    ],
    tail: 0.45, movement: "slow", duration: 40, fade: 40, blends: ["affectionate", "tired", "comforting"], serious: true,
  }),

  crying: e({
    id: "crying", label: "Crying", valence: -0.85, energy: 0.3,
    tiers: [
      { at: 0, look: { eyes: "watery", brow: "sad", mouth: "wobble", ears: "down", tail: "tuck", tint: "sad", bob: 1.4, tilt: -6 } },
    ],
    accents: [
      { id: "wipe", every: [6, 10], dur: 1.1, gesture: "wipe", min: 0.5 },
      { id: "sniffle", every: [4, 7], dur: 0.35, look: { eyes: "closed", bob: 2.2 } },
    ],
    tail: 0.3, movement: "still", duration: 18, fade: 12, enterVia: ["sad"], exitVia: ["sad"], serious: true, cries: true,
  }),

  savage: e({
    id: "savage", label: "Savage", valence: 0.35, energy: 0.6,
    tiers: [
      { at: 0, look: { eyes: "smug", mouth: "smirk", gaze: { x: 2, y: 0 } } },
      { at: 0.45, look: { brow: "raised", bob: -1, tilt: -6 } },
      { at: 0.75, look: { tail: "flick" } },
    ],
    accents: [
      { id: "side-eye", every: [3, 5], dur: 1.3, look: { gaze: { x: -2, y: 0 } } },
      { id: "really", every: [5, 8], dur: 1, look: { brow: "raised", tilt: 10, mouth: "flat" } },
      { id: "dismiss", every: [7, 12], dur: 0.9, gesture: "dismiss", min: 0.6 },
      { id: "blep", every: [9, 14], dur: 1, look: { mouth: "tongue" }, min: 0.7 },
      { id: "edgy", every: [14, 24], dur: 1.4, gesture: "middle", min: 0.85, edgy: true },
    ],
    tail: 1.1, movement: "still", duration: 25, fade: 20, blends: ["angry", "mischievous"],
  }),

  angry: e({
    id: "angry", label: "Angry", valence: -0.6, energy: 0.75,
    tiers: [
      { at: 0, look: { brow: "angry", mouth: "flat", ears: "back" } },
      { at: 0.45, look: { eyes: "angry", tail: "flick", bob: 0.6 } },
      { at: 0.7, look: { mouth: "frown", anger: true } },
    ],
    accents: [
      { id: "stomp", every: [4, 7], dur: 0.9, gesture: ["stompUp", "stompDown"], min: 0.6 },
      { id: "shake", every: [5, 8], dur: 0.45, look: { tilt: -7 } },
      { id: "huff", every: [3, 5], dur: 0.3, look: { bob: 1.2 } },
    ],
    tail: 1.8, movement: "still", duration: 15, fade: 12, enterVia: ["annoyed"], exitVia: ["annoyed"], blends: ["savage"],
  }),

  rage: e({
    id: "rage", label: "Very angry", valence: -0.9, energy: 1,
    tiers: [
      { at: 0, look: { eyes: "angry", brow: "angry", ears: "flat", mouth: "teeth", anger: true, tail: "puff", bob: 1 } },
    ],
    accents: [
      { id: "stomp", every: [2.5, 4], dur: 1, gesture: ["stompUp", "stompDown"] },
      { id: "shake", every: [3, 5], dur: 0.5, look: { tilt: 8 } },
      { id: "edgy", every: [8, 14], dur: 1.4, gesture: "middle", min: 0.9, edgy: true },
    ],
    tail: 2.5, movement: "still", duration: 7, fade: 5, enterVia: ["annoyed", "angry"], exitVia: ["annoyed"],
  }),

  victory: e({
    id: "victory", label: "Victory", valence: 0.9, energy: 0.85,
    tiers: [{ at: 0, look: { eyes: "sparkle", mouth: "grin", ears: "perk", tail: "up", bob: -1, sparkle: true, tilt: 5 } }],
    hold: { gesture: "victory", min: 0.3 },
    accents: [{ id: "bounce", every: [2.5, 4], dur: 0.35, look: { bob: -2 } }],
    tail: 1.8, movement: "still", duration: 4.5, fade: 4, blends: ["proud", "excited"],
  }),

  proud: e({
    id: "proud", label: "Proud", valence: 0.6, energy: 0.5,
    tiers: [
      // Chin up, eyes shut, pleased with itself: the cartoon proud face.
      { at: 0, look: { eyes: "closed", mouth: "smile", ears: "up", bob: -1.4 } },
      { at: 0.5, look: { tail: "up", tilt: 4, sparkle: true } },
    ],
    accents: [{ id: "peek", every: [4, 7], dur: 0.8, look: { eyes: "half" } }],
    tail: 0.6, movement: "still", duration: 12, fade: 12, blends: ["happy"],
  }),

  shy: e({
    id: "shy", label: "Shy", valence: 0.2, energy: 0.3,
    tiers: [
      { at: 0, look: { gaze: { x: -1.6, y: 1 }, bob: 1, tilt: 6, ears: "back" } },
      { at: 0.5, look: { eyes: "half", mouth: "smile", blush: true } },
    ],
    accents: [
      { id: "paws", every: [5, 9], dur: 1.2, gesture: "cover", min: 0.55 },
      { id: "peek", every: [3, 6], dur: 0.6, look: { gaze: { x: 0, y: 0.4 } } },
    ],
    tail: 0.5, movement: "still", duration: 10, fade: 10, blends: ["happy", "affectionate"],
  }),

  embarrassed: e({
    id: "embarrassed", label: "Embarrassed", valence: -0.1, energy: 0.5,
    tiers: [
      { at: 0, look: { gaze: { x: 1.8, y: 0.5 }, tilt: -8, bob: 0.8, ears: "back", mouth: "flat", blush: true } },
      { at: 0.5, look: { sweat: true } },
    ],
    accents: [
      { id: "look-away", every: [2, 4], dur: 0.5, look: { gaze: { x: -1.8, y: 0.5 } } },
      { id: "paw-face", every: [4, 7], dur: 1.1, gesture: "cover", min: 0.4 },
      { id: "dip", every: [3, 5], dur: 0.4, look: { bob: 1.6 } },
    ],
    tail: 0.8, movement: "still", duration: 5, fade: 5, blends: ["shy"],
  }),

  confused: e({
    id: "confused", label: "Confused", valence: -0.1, energy: 0.45,
    tiers: [
      { at: 0, look: { ears: "asym", tilt: 12, brow: "raised", mouth: "flat" } },
      { at: 0.5, look: { gaze: { x: 0.8, y: -0.6 } } },
    ],
    accents: [
      { id: "blink", every: [2, 4], dur: 0.2, look: { eyes: "closed" } },
      { id: "shift", every: [2.5, 4], dur: 0.8, look: { gaze: { x: -1, y: -0.4 } } },
      { id: "other-way", every: [4, 6], dur: 1.2, look: { tilt: -12 } },
      { id: "shrug", every: [5, 9], dur: 1.1, gesture: "shrug", min: 0.6 },
    ],
    tail: 0.7, movement: "still", duration: 6, fade: 6, blends: ["curious"],
  }),

  suspicious: e({
    id: "suspicious", label: "Suspicious", valence: -0.2, energy: 0.4,
    tiers: [
      { at: 0, look: { eyes: "narrow", ears: "asym", mouth: "flat", gaze: { x: 1.5, y: 0 } } },
      { at: 0.6, look: { tilt: -6 } },
    ],
    accents: [
      { id: "slow-look", every: [3, 5], dur: 1.6, look: { gaze: { x: -1.5, y: 0 } } },
      { id: "flick", every: [3, 5], dur: 0.5, look: { tail: "flick" } },
    ],
    tail: 0.9, movement: "still", duration: 8, fade: 8, blends: ["annoyed", "curious"],
  }),

  curious: e({
    id: "curious", label: "Curious", valence: 0.4, energy: 0.6,
    tiers: [
      { at: 0, look: { ears: "forward", tilt: 8 } },
      { at: 0.5, look: { eyes: "wide" } },
      // Right up close: pupils blown wide and the head draws back a touch.
      { at: 0.85, look: { eyes: "dilated", bob: -0.8 } },
    ],
    accents: [
      { id: "other-tilt", every: [4, 7], dur: 1.5, look: { tilt: -8 } },
      { id: "reach", every: [5, 9], dur: 0.9, gesture: "reachR", min: 0.75 },
    ],
    tail: 1.2, movement: "still", duration: 10, fade: 8, blends: ["excited", "happy", "confused"],
  }),

  surprised: e({
    id: "surprised", label: "Surprised", valence: 0.1, energy: 0.8,
    tiers: [{ at: 0, look: { eyes: "surprised", ears: "perk", mouth: "o", bob: -1.2, tail: "up" } }],
    tail: 1.6, movement: "still", duration: 1.6, fade: 1.2, blends: ["happy", "curious"],
  }),

  scared: e({
    id: "scared", label: "Scared", valence: -0.7, energy: 0.8,
    tiers: [{ at: 0, look: { eyes: "panic", ears: "flat", tail: "puff", mouth: "o", bob: 1, tilt: -6, sweat: true } }],
    tail: 0.4, movement: "still", duration: 2.5, fade: 2, serious: true,
  }),

  tired: e({
    id: "tired", label: "Tired", valence: -0.2, energy: 0.1,
    tiers: [
      { at: 0, look: { eyes: "half" } },
      { at: 0.5, look: { bob: 1.2, tail: "down", ears: "back" } },
    ],
    accents: [
      { id: "yawn", every: [10, 18], dur: 1.2, anim: "yawn", min: 0.5 },
      { id: "slow-blink", every: [3, 6], dur: 0.6, look: { eyes: "closed" } },
    ],
    tail: 0.4, movement: "slow", duration: 30, fade: 30, blends: ["happy", "sad"],
  }),

  bored: e({
    id: "bored", label: "Bored", valence: -0.2, energy: 0.2,
    tiers: [{ at: 0, look: { eyes: "half", mouth: "flat", bob: 0.8 } }],
    accents: [
      { id: "look-right", every: [4, 7], dur: 1.2, look: { gaze: { x: 1.8, y: -0.4 } } },
      { id: "look-left", every: [5, 8], dur: 1.2, look: { gaze: { x: -1.8, y: -0.4 } } },
      { id: "sigh", every: [8, 12], dur: 0.9, look: { eyes: "closed", bob: 1.8 } },
    ],
    tail: 0.5, movement: "slow", duration: 20, fade: 20,
  }),

  annoyed: e({
    id: "annoyed", label: "Annoyed", valence: -0.4, energy: 0.5,
    tiers: [
      { at: 0, look: { eyes: "half", mouth: "flat", brow: "angry" } },
      { at: 0.5, look: { ears: "back", gaze: { x: 1.4, y: 0 } } },
    ],
    accents: [
      { id: "flick", every: [2.5, 4], dur: 0.5, look: { tail: "flick" } },
      { id: "toss", every: [4, 6], dur: 0.4, look: { tilt: -6 } },
    ],
    tail: 1.3, movement: "still", duration: 10, fade: 10, blends: ["suspicious", "savage"],
  }),

  affectionate: e({
    id: "affectionate", label: "Affectionate", valence: 0.7, energy: 0.35,
    tiers: [
      { at: 0, look: { eyes: "soft", mouth: "smile", ears: "up", tilt: 6 } },
      { at: 0.6, look: { blush: true } },
    ],
    accents: [
      { id: "slow-blink", every: [4, 7], dur: 0.7, look: { eyes: "closed" } },
      { id: "lean", every: [6, 10], dur: 1.5, look: { tilt: 10 } },
      { id: "heart", every: [12, 20], dur: 1.2, look: { hearts: true }, min: 0.7 },
    ],
    // A quick fade: the blush after petting should pass in a moment, not linger a minute.
    tail: 0.6, movement: "still", duration: 25, fade: 4, blends: ["sad", "happy", "shy", "sleepy"],
  }),

  love: e({
    id: "love", label: "Adoring", valence: 0.95, energy: 0.5,
    tiers: [{ at: 0, look: { eyes: "soft", blush: true, mouth: "smile", tilt: 10, ears: "up" } }],
    accents: [
      { id: "happy-blink", every: [3, 5], dur: 0.8, look: { eyes: "happy" } },
      { id: "heart", every: [6, 10], dur: 1.5, look: { hearts: true } },
      { id: "paw-heart", every: [8, 14], dur: 1.6, gesture: "pawHeart", min: 0.8 },
    ],
    tail: 0.8, movement: "still", duration: 10, fade: 10, blends: ["affectionate"],
  }),

  determined: e({
    id: "determined", label: "Determined", valence: 0.3, energy: 0.7,
    tiers: [
      { at: 0, look: { eyes: "focus", mouth: "flat", ears: "perk", bob: -0.4 } },
      { at: 0.6, look: { tail: "up" } },
    ],
    accents: [
      { id: "nod", every: [6, 10], dur: 0.3, look: { bob: 1 } },
      { id: "thumbs", every: [15, 25], dur: 1.2, gesture: "thumbsUp", min: 0.8 },
    ],
    tail: 0.8, movement: "normal", duration: 30, fade: 20,
  }),

  cheering: e({
    id: "cheering", label: "Cheering", valence: 0.9, energy: 0.9,
    tiers: [{ at: 0, look: { eyes: "happy", mouth: "grin", ears: "perk", tail: "up", sparkle: true } }],
    hold: { gesture: ["cheer", "clap"], min: 0.3, period: 0.32 },
    accents: [{ id: "hop", every: [3, 5], dur: 0.6, anim: "smallHop" }],
    tail: 2, movement: "still", duration: 4, fade: 3, blends: ["excited", "victory"],
  }),

  comforting: e({
    id: "comforting", label: "Comforting", valence: 0.4, energy: 0.2,
    tiers: [
      { at: 0, look: { eyes: "soft", brow: "soft", mouth: "smile", ears: "up", tilt: 7, bob: 0.4 } },
      { at: 0.6, look: { brow: "worried" } },
    ],
    accents: [
      { id: "slow-blink", every: [5, 8], dur: 0.9, look: { eyes: "closed" } },
      { id: "other-tilt", every: [8, 12], dur: 2.2, look: { tilt: -7 } },
    ],
    tail: 0.35, movement: "still", duration: 60, fade: 45, blends: ["sad", "affectionate"], serious: true,
  }),

  mischievous: e({
    id: "mischievous", label: "Mischievous", valence: 0.5, energy: 0.75,
    tiers: [
      { at: 0, look: { eyes: "smug", mouth: "smirk", ears: "perk", tilt: -6, gaze: { x: 1.4, y: 0.2 } } },
      { at: 0.6, look: { tail: "flick" } },
    ],
    accents: [
      { id: "bounce", every: [3, 5], dur: 0.3, look: { bob: -1 } },
      { id: "blep", every: [6, 9], dur: 1, look: { mouth: "tongue" } },
      { id: "glance", every: [4, 6], dur: 0.8, look: { gaze: { x: -1.4, y: 0.2 }, tilt: 6 } },
    ],
    tail: 1.8, movement: "lively", duration: 15, fade: 12, blends: ["savage", "curious"],
  }),

  thinking: e({
    id: "thinking", label: "Thinking", valence: 0, energy: 0.4,
    tiers: [{ at: 0, look: { eyes: "up", gaze: { x: 0.8, y: -1.6 }, tilt: 10, ears: "perk", mouth: "flat" } }],
    hold: { gesture: "chin", min: 0.4 },
    accents: [
      { id: "blink", every: [2.5, 4], dur: 0.2, look: { eyes: "closed" } },
      { id: "other-way", every: [5, 8], dur: 1.6, look: { tilt: -8, gaze: { x: -0.8, y: -1.6 } } },
    ],
    tail: 0.8, movement: "still", duration: 60, fade: 2,
  }),

  relieved: e({
    id: "relieved", label: "Relieved", valence: 0.5, energy: 0.3,
    tiers: [{ at: 0, look: { eyes: "soft", mouth: "smile", ears: "up", bob: 0.8 } }],
    accents: [{ id: "exhale", every: [1, 1.5], dur: 0.9, look: { eyes: "closed", bob: 1.5 } }],
    tail: 0.6, movement: "still", duration: 4, fade: 4,
  }),

  sleepy: e({
    id: "sleepy", label: "Sleepy", valence: 0.3, energy: 0.05,
    tiers: [
      { at: 0, look: { eyes: "half", mouth: "smile", bob: 1, tilt: 6, ears: "back" } },
      { at: 0.6, look: { zzz: true } },
    ],
    accents: [
      { id: "slow-blink", every: [2.5, 4], dur: 1.2, look: { eyes: "closed" } },
      { id: "nod-off", every: [4, 6], dur: 1.2, look: { bob: 2, eyes: "closed" } },
    ],
    tail: 0.25, movement: "still", duration: 30, fade: 30, blends: ["affectionate", "happy"],
  }),
};

export function emotion(id: EmotionId): EmotionSpec {
  return EMOTIONS[id] ?? EMOTIONS.neutral;
}

/** The look of `id` at `intensity`: every tier at or below it, merged in order. */
export function lookAt(id: EmotionId, intensity: number): Look {
  const out: Look = {};
  for (const t of emotion(id).tiers) if (intensity >= t.at) Object.assign(out, t.look);
  return out;
}

/** Can `b` sit alongside `a` as its secondary? */
export function blends(a: EmotionId, b: EmotionId): boolean {
  return a !== b && !!(emotion(a).blends?.includes(b) || emotion(b).blends?.includes(a));
}
