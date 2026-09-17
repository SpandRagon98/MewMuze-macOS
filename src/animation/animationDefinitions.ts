import type { AnimationName } from "../types/cat";
import { DEFAULT_POSE, type CatView, type PoseSpec } from "./spriteLoader";

/**
 * Declarative table of every animation. Each entry lists its frames (as pose
 * data), frame rate, looping behaviour, an optional `next` state to fall into
 * when a one-shot finishes, and a `minDuration` guard so the behaviour FSM
 * cannot yank the cat out of an animation before it reads as intentional.
 *
 * Many states share base poses on purpose — this is a placeholder art set and
 * the goal is legible, distinct-enough motion, not 45 bespoke sprite sheets.
 * Swapping in real art means replacing pose rendering, not this table.
 */
export interface AnimationDef {
  fps: number;
  loop: boolean;
  frames: PoseSpec[];
  next?: AnimationName;
  minDuration?: number;
  /** Which directional silhouette to draw. Applied from VIEW_BY_ANIM below. */
  view?: CatView;
}

function pose(p: Partial<PoseSpec>): PoseSpec {
  return { ...DEFAULT_POSE, ...p };
}

/** Build an N-frame leg cycle for walk/run/stalk/sprint. */
function legCycle(base: Partial<PoseSpec>, frames = 4): PoseSpec[] {
  return Array.from({ length: frames }, (_, i) =>
    pose({ ...base, legPhase: i / frames }),
  );
}

const IDLE_FRAMES: PoseSpec[] = [
  pose({ body: "sit", tail: "wrap", eyes: "open" }),
  pose({ body: "sit", tail: "wrap", eyes: "open", headBob: 1 }),
  pose({ body: "sit", tail: "flick", eyes: "open", ears: "perk" }),
  pose({ body: "sit", tail: "wrap", eyes: "half", headBob: 1 }),
];

export const ANIMATIONS: Record<AnimationName, AnimationDef> = {
  // ---- Movement ----------------------------------------------------------
  idle: { fps: 4, loop: true, frames: IDLE_FRAMES, minDuration: 0.6 },
  sideIdle: {
    fps: 3,
    loop: true,
    frames: [pose({ tail: "curl", ears: "up" }), pose({ tail: "flick", ears: "perk", headBob: 1 })],
    minDuration: 0.6,
  },
  backIdle: {
    fps: 3,
    loop: true,
    frames: [pose({ body: "sit", tail: "up" }), pose({ body: "sit", tail: "flick", ears: "perk" })],
    minDuration: 0.6,
  },
  walk: { fps: 10, loop: true, frames: legCycle({ tail: "up", stride: 1.05 }, 8), minDuration: 0.35 },
  stalk: { fps: 7, loop: true, frames: legCycle({ body: "crouch", tail: "down", eyes: "wide", ears: "perk", stride: 0.7 }, 8), minDuration: 0.55 },
  run: { fps: 15, loop: true, frames: legCycle({ tail: "flick", headBob: 1, stride: 1.45 }, 8), minDuration: 0.3 },
  sprint: { fps: 19, loop: true, frames: legCycle({ tail: "down", eyes: "wide", ears: "back", stride: 1.8 }, 8), minDuration: 0.35 },
  turnAround: {
    fps: 10,
    loop: false,
    frames: [pose({ body: "sit", ears: "perk" }), pose({ body: "sit", ears: "perk", headBob: 1 }), pose({ body: "sit", tail: "flick" })],
    // Settle facing the user, not in profile. Every resting state the cat can
    // auto-chain into must be front-facing, otherwise it parks side-on after
    // routine actions (turning, landing) and just sits there in profile.
    next: "idle",
    minDuration: 0.25,
  },
  turnLeft: {
    fps: 8,
    loop: false,
    frames: [pose({ ears: "perk" }), pose({ ears: "up", headBob: 1 })],
    next: "idle",
    minDuration: 0.2,
  },
  turnRight: {
    fps: 8,
    loop: false,
    frames: [pose({ ears: "perk" }), pose({ ears: "up", headBob: 1 })],
    next: "idle",
    minDuration: 0.2,
  },
  lookUp: { fps: 4, loop: true, frames: [pose({ eyes: "up", headBob: -2, ears: "perk" })], minDuration: 0.4 },
  lookDown: { fps: 4, loop: true, frames: [pose({ eyes: "down", headBob: 2 })], minDuration: 0.4 },
  jump: { fps: 10, loop: false, frames: [pose({ body: "air", ears: "back", eyes: "wide", legPhase: 0.15 }), pose({ body: "air", ears: "back", eyes: "wide", legPhase: 0.45 })], next: "fall", minDuration: 0.18 },
  smallHop: { fps: 11, loop: false, frames: [pose({ body: "crouch", eyes: "down" }), pose({ body: "air", tail: "up", legPhase: 0.3 })], next: "fall", minDuration: 0.18 },
  verticalJump: { fps: 10, loop: false, frames: [pose({ body: "crouch", ears: "back" }), pose({ body: "air", tail: "down", eyes: "up", legPhase: 0.5 })], next: "fall", minDuration: 0.2 },
  longJump: { fps: 12, loop: false, frames: [pose({ body: "crouch", gesture: "wiggle", eyes: "wide" }), pose({ body: "air", ears: "back", eyes: "wide", tail: "down", legPhase: 0.25 })], next: "fall", minDuration: 0.22 },
  fall: { fps: 8, loop: true, frames: [pose({ body: "air", ears: "back", eyes: "wide", tail: "up", legPhase: 0.1 }), pose({ body: "air", ears: "back", eyes: "down", tail: "down", legPhase: 0.6 })], minDuration: 0.1 },
  land: {
    fps: 14,
    loop: false,
    frames: [pose({ body: "crouch", ears: "back", eyes: "half" }), pose({ body: "stand", eyes: "open" })],
    next: "idle",
    minDuration: 0.15,
  },
  softLand: { fps: 13, loop: false, frames: [pose({ body: "crouch", eyes: "half" }), pose({ body: "stand", tail: "up" })], next: "idle", minDuration: 0.18 },
  hardLand: { fps: 11, loop: false, frames: [pose({ body: "crouch", ears: "flat", eyes: "closed", tail: "puff" }), pose({ body: "crouch", ears: "back", eyes: "half" }), pose({ body: "stand", eyes: "open" })], next: "shake", minDuration: 0.35 },
  climb: { fps: 8, loop: true, frames: legCycle({ body: "climb", tail: "down", ears: "perk" }, 4), minDuration: 0.3 },
  climbUp: { fps: 9, loop: true, frames: legCycle({ body: "climb", tail: "up", ears: "perk" }, 4), minDuration: 0.4 },
  climbDown: { fps: 7, loop: true, frames: legCycle({ body: "climb", tail: "down", eyes: "down" }, 4).reverse(), minDuration: 0.4 },
  stepDown: {
    fps: 6,
    loop: true,
    frames: [pose({ eyes: "down", ears: "perk", headBob: 1 }), pose({ eyes: "down", legPhase: 0.5, headBob: 1 })],
    minDuration: 0.3,
  },
  balance: {
    fps: 3,
    loop: true,
    frames: [pose({ tail: "up", ears: "perk" }), pose({ tail: "flick", ears: "perk", headBob: 1 })],
    minDuration: 0.4,
  },
  hangTwoPaws: { fps: 5, loop: true, frames: [pose({ body: "hang", gesture: "hangTwo", eyes: "wide", ears: "back", legPhase: 0 }), pose({ body: "hang", gesture: "hangTwo", eyes: "wide", ears: "back", legPhase: 0.5 })], minDuration: 0.5 },
  hangOnePaw: { fps: 6, loop: true, frames: [pose({ body: "hang", gesture: "hangOne", eyes: "surprised", ears: "flat", legPhase: 0.15 }), pose({ body: "hang", gesture: "hangOne", eyes: "wide", ears: "back", legPhase: 0.65 })], minDuration: 0.35 },
  pullUp: { fps: 9, loop: false, frames: [pose({ body: "hang", gesture: "pull", eyes: "up", ears: "back" }), pose({ body: "crouch", eyes: "half", ears: "perk" }), pose({ body: "sit", eyes: "open", tail: "wrap" })], next: "sit", minDuration: 0.3 },

  // ---- Relaxing ----------------------------------------------------------
  sit: { fps: 3, loop: true, frames: [pose({ body: "sit", tail: "wrap" }), pose({ body: "sit", tail: "wrap", eyes: "half" })], minDuration: 0.8 },
  sitSide: { fps: 3, loop: true, frames: [pose({ body: "sit", tail: "wrap", eyes: "open" }), pose({ body: "sit", tail: "wrap", eyes: "half", headBob: 1 })], minDuration: 0.8 },
  cuteNod: {
    fps: 5,
    loop: false,
    frames: [
      pose({ body: "sit", tail: "wrap", eyes: "wide", ears: "perk", mouth: "smile" }),
      pose({ body: "sit", tail: "wrap", eyes: "happy", ears: "perk", mouth: "smile", blush: true, headBob: 1 }),
      pose({ body: "sit", tail: "wrap", eyes: "closed", ears: "perk", mouth: "smile", blush: true, headBob: 2 }),
      pose({ body: "sit", tail: "flick", eyes: "happy", ears: "perk", mouth: "smile", blush: true, headBob: 1 }),
      pose({ body: "sit", tail: "wrap", eyes: "wide", ears: "up", mouth: "smile" }),
    ],
    next: "sit",
    minDuration: 1.1,
  },
  lieDown: { fps: 2, loop: true, frames: [pose({ body: "lie", eyes: "half", tail: "tuck" })], minDuration: 1 },
  sleep: {
    fps: 2,
    loop: true,
    frames: [
      pose({ body: "lie", eyes: "closed", ears: "back", tail: "tuck", zzz: true }),
      pose({ body: "lie", eyes: "closed", ears: "back", tail: "tuck", zzz: true, headBob: 0.5 }),
      pose({ body: "lie", eyes: "closed", ears: "back", tail: "tuck", headBob: 1 }),
      pose({ body: "lie", eyes: "closed", ears: "back", tail: "tuck", zzz: true, headBob: 0.5 }),
    ],
    minDuration: 2,
  },
  wakeUp: {
    fps: 4,
    loop: false,
    frames: [pose({ body: "lie", eyes: "half" }), pose({ body: "sit", eyes: "half" }), pose({ body: "sit", eyes: "open", ears: "perk" })],
    next: "sit",
    minDuration: 0.4,
  },
  // A full play-bow stretch: rock back, sink the chest while the hips stay
  // high, hold the deepest point (that hold is what sells it as a real
  // stretch rather than a quick dip), yawn, then unfold and shake it off.
  stretch: {
    fps: 9,
    loop: false,
    frames: [
      pose({ body: "stand", eyes: "half", ears: "back", tail: "up" }),
      pose({ body: "crouch", eyes: "half", ears: "back", tail: "up", legPhase: 0 }),
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "up", legPhase: 0.3, headBob: 0.5 }),
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "up", legPhase: 0.62, headBob: 1 }),
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "up", legPhase: 0.85, headBob: 1.4, mouth: "open" }),
      // Deepest point, held for several frames — claws out, big yawn.
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "up", legPhase: 1, headBob: 1.6, mouth: "yawn" }),
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "up", legPhase: 1, headBob: 1.7, mouth: "yawn" }),
      pose({ body: "stretch", ears: "back", eyes: "closed", tail: "flick", legPhase: 1, headBob: 1.6, mouth: "yawn" }),
      pose({ body: "stretch", ears: "back", eyes: "half", tail: "flick", legPhase: 0.9, headBob: 1.2, mouth: "open" }),
      // Unfold: hips drop back down, chest lifts.
      pose({ body: "stretch", ears: "perk", eyes: "half", tail: "flick", legPhase: 0.55, headBob: 0.6 }),
      pose({ body: "crouch", ears: "perk", eyes: "open", tail: "flick", legPhase: 0.2 }),
      pose({ body: "stand", tail: "up", ears: "perk", eyes: "happy" }),
    ],
    next: "shake",
    minDuration: 1.1,
  },
  yawn: {
    fps: 4,
    loop: false,
    frames: [
      pose({ body: "sit", eyes: "half", ears: "up", tail: "wrap" }),
      pose({ body: "sit", eyes: "closed", ears: "back", tail: "wrap", mouth: "open", headBob: -0.5 }),
      pose({ body: "sit", eyes: "closed", ears: "back", tail: "wrap", mouth: "yawn", headBob: -1 }),
      pose({ body: "sit", eyes: "closed", ears: "back", tail: "flick", mouth: "yawn", headBob: -1.5 }),
      pose({ body: "sit", eyes: "half", ears: "back", tail: "wrap", mouth: "open", headBob: -0.5 }),
      pose({ body: "sit", eyes: "half", ears: "up", tail: "tuck" }),
    ],
    next: "sleep",
    minDuration: 1.55,
  },
  blink: {
    fps: 8,
    loop: false,
    frames: [pose({ eyes: "half" }), pose({ eyes: "closed" }), pose({ eyes: "open" })],
    next: "idle",
    minDuration: 0.1,
  },
  tailFlick: {
    fps: 6,
    loop: false,
    frames: [pose({ tail: "flick" }), pose({ tail: "up" }), pose({ tail: "curl" })],
    next: "idle",
    minDuration: 0.2,
  },
  cleanPaw: {
    fps: 5,
    loop: true,
    frames: [pose({ body: "sit", gesture: "pawUp", legPhase: 0.2, eyes: "half", headBob: 1 }), pose({ body: "sit", gesture: "groom", legPhase: 0.2, eyes: "closed", headBob: 2 })],
    minDuration: 0.8,
  },
  cleanFace: {
    fps: 6,
    loop: true,
    frames: [pose({ body: "sit", gesture: "groom", legPhase: 0.7, eyes: "closed", headBob: 0 }), pose({ body: "sit", gesture: "pawUp", legPhase: 0.7, eyes: "closed", headBob: -1 })],
    minDuration: 0.8,
  },
  scratch: {
    fps: 10,
    loop: true,
    frames: [pose({ body: "sit", gesture: "scratch", legPhase: 0.2, ears: "back", headBob: 1 }), pose({ body: "sit", gesture: "scratch", legPhase: 0.8, ears: "back", headBob: -1 })],
    minDuration: 0.5,
  },
  groom: { fps: 6, loop: true, frames: [pose({ body: "sit", gesture: "groom", legPhase: 0.2, eyes: "half" }), pose({ body: "sit", gesture: "groom", legPhase: 0.8, eyes: "closed", headBob: 1 })], minDuration: 1 },
  lookAround: {
    fps: 3,
    loop: false,
    frames: [pose({ ears: "perk", eyes: "up" }), pose({ ears: "perk", eyes: "open", headBob: 1 }), pose({ ears: "perk", eyes: "down" })],
    next: "idle",
    minDuration: 0.5,
  },

  // ---- Cursor interactions ----------------------------------------------
  watch: { fps: 3, loop: true, frames: [pose({ ears: "perk", eyes: "wide" }), pose({ ears: "perk", eyes: "open", headBob: 1 })], minDuration: 0.3 },
  approach: { fps: 6, loop: true, frames: legCycle({ ears: "perk", tail: "up" }), minDuration: 0.3 },
  chase: { fps: 12, loop: true, frames: legCycle({ ears: "back", tail: "flick", eyes: "wide", headBob: 1 }), minDuration: 0.3 },
  pounce: {
    fps: 12,
    loop: false,
    frames: [pose({ body: "crouch", gesture: "wiggle", ears: "back", eyes: "wide" }), pose({ body: "air", ears: "back", eyes: "wide", legPhase: 0.25 })],
    next: "land",
    minDuration: 0.2,
  },
  swat: {
    fps: 12,
    loop: false,
    frames: [pose({ body: "sit", gesture: "pawUp", ears: "perk", eyes: "wide" }), pose({ body: "sit", gesture: "swat", ears: "perk", eyes: "wide", headBob: 1 })],
    next: "watch",
    minDuration: 0.15,
  },
  pawSwipe: { fps: 13, loop: false, frames: [pose({ body: "sit", gesture: "pawUp", eyes: "wide", ears: "perk" }), pose({ body: "sit", gesture: "swat", eyes: "wide", ears: "back" }), pose({ body: "sit", gesture: "pawUp", eyes: "open" })], next: "watch", minDuration: 0.2 },
  catch: {
    fps: 10,
    loop: false,
    frames: [pose({ body: "crouch", ears: "back", eyes: "wide", tail: "puff" })],
    next: "hold",
    minDuration: 0.15,
  },
  hold: { fps: 6, loop: true, frames: [pose({ body: "crouch", eyes: "wide", ears: "back", tail: "puff" })], minDuration: 0.3 },
  draggedByCursor: {
    fps: 8,
    loop: true,
    frames: [pose({ body: "air", eyes: "surprised", ears: "back", tail: "up" }), pose({ body: "air", eyes: "surprised", ears: "back", headBob: 1 })],
    minDuration: 0.2,
  },
  cursorGrab: { fps: 10, loop: false, frames: [pose({ body: "hang", gesture: "hangTwo", eyes: "surprised", ears: "back", tail: "puff" }), pose({ body: "hang", gesture: "hangTwo", eyes: "wide", ears: "back", legPhase: 0.5 })], next: "cursorSwing", minDuration: 0.2 },
  cursorSwing: { fps: 7, loop: true, frames: [pose({ body: "hang", gesture: "hangTwo", eyes: "wide", ears: "back", legPhase: 0.15 }), pose({ body: "hang", gesture: "hangTwo", eyes: "wide", ears: "back", legPhase: 0.65 })], minDuration: 0.3 },
  loseGrip: {
    fps: 10,
    loop: false,
    frames: [pose({ body: "air", eyes: "surprised", ears: "flat" })],
    next: "fall",
    minDuration: 0.15,
  },
  landSafe: {
    fps: 12,
    loop: false,
    frames: [pose({ body: "crouch", eyes: "half" }), pose({ body: "stand", eyes: "open", tail: "up" })],
    next: "shake",
    minDuration: 0.15,
  },
  confused: {
    fps: 4,
    loop: false,
    frames: [pose({ ears: "flat", eyes: "wide", headBob: -1 }), pose({ ears: "perk", eyes: "wide", headBob: 1 }), pose({ ears: "up", eyes: "open" })],
    next: "idle",
    minDuration: 0.4,
  },
  startled: { fps: 11, loop: false, frames: [pose({ body: "crouch", eyes: "surprised", ears: "flat", tail: "puff" }), pose({ body: "air", eyes: "wide", ears: "back", tail: "puff", legPhase: 0.5 })], next: "landSafe", minDuration: 0.22 },
  tired: {
    fps: 3,
    loop: false,
    frames: [pose({ body: "sit", eyes: "half", ears: "back", headBob: 1 }), pose({ body: "sit", eyes: "closed", ears: "back" })],
    next: "sit",
    minDuration: 1,
  },
  tailChase: { fps: 13, loop: true, frames: [pose({ body: "crouch", gesture: "swat", eyes: "wide", tail: "flick", legPhase: 0 }), pose({ body: "crouch", gesture: "swat", eyes: "wide", tail: "curl", legPhase: 0.5 })], minDuration: 0.8 },
  peek: { fps: 4, loop: true, frames: [pose({ body: "crouch", gesture: "peek", eyes: "wide", ears: "perk", headBob: 2 }), pose({ body: "crouch", gesture: "pawUp", eyes: "open", ears: "perk" })], minDuration: 0.8 },

  // ---- User interactions -------------------------------------------------
  petted: { fps: 4, loop: true, frames: [pose({ body: "sit", eyes: "half", ears: "back" }), pose({ body: "loaf", eyes: "half", ears: "back", headBob: 1 })], minDuration: 0.4 },
  pettedEyesClosed: {
    fps: 3,
    loop: true,
    frames: [pose({ body: "loaf", eyes: "closed", ears: "back", tail: "flick" }), pose({ body: "loaf", eyes: "closed", ears: "back", tail: "curl", headBob: 1 })],
    minDuration: 0.6,
  },
  purr: {
    fps: 6,
    loop: true,
    frames: [pose({ body: "loaf", eyes: "closed", hearts: true }), pose({ body: "loaf", eyes: "closed", headBob: 1, hearts: true })],
    minDuration: 0.6,
  },
  pickedUp: {
    fps: 10,
    loop: false,
    frames: [pose({ body: "dangle", eyes: "surprised", ears: "flat", legPhase: 0.2 })],
    next: "dangle",
    minDuration: 0.15,
  },
  dangle: {
    fps: 6,
    loop: true,
    frames: [pose({ body: "dangle", eyes: "wide", ears: "back", legPhase: 0.2 }), pose({ body: "dangle", eyes: "wide", ears: "back", legPhase: 0.6 })],
    minDuration: 0.2,
  },
  draggedSurprised: {
    fps: 8,
    loop: true,
    frames: [pose({ body: "dangle", eyes: "surprised", ears: "flat" }), pose({ body: "dangle", eyes: "surprised", ears: "flat", headBob: 1 })],
    minDuration: 0.2,
  },
  placedDown: {
    fps: 12,
    loop: false,
    frames: [pose({ body: "crouch", eyes: "half" }), pose({ body: "sit", eyes: "open" })],
    next: "shake",
    minDuration: 0.15,
  },
  shake: {
    fps: 14,
    loop: false,
    frames: [pose({ body: "stand", ears: "flat", headBob: -1 }), pose({ body: "stand", ears: "perk", headBob: 1, tail: "puff" }), pose({ body: "stand", ears: "up" })],
    next: "idle",
    minDuration: 0.25,
  },
  annoyed: {
    fps: 4,
    loop: false,
    frames: [pose({ body: "sit", ears: "flat", eyes: "half", tail: "flick" }), pose({ body: "sit", ears: "flat", eyes: "half", tail: "down" })],
    next: "sit",
    minDuration: 0.8,
  },
  happy: {
    fps: 6,
    loop: false,
    frames: [pose({ body: "sit", ears: "perk", eyes: "wide", tail: "up", hearts: true }), pose({ body: "sit", ears: "perk", eyes: "open", tail: "flick", headBob: 1 })],
    next: "idle",
    minDuration: 0.5,
  },
  // Persona reactions - combinations of existing eyes/mouth/props, no new art.
  // Savage Bestie: a sly side-eye with a smirk.
  sideEye: {
    fps: 3,
    loop: false,
    frames: [
      pose({ body: "sit", eyes: "half", pupilX: 1, mouth: "smile", ears: "perk", tail: "flick" }),
      pose({ body: "sit", eyes: "half", pupilX: 1, mouth: "smile", ears: "perk", tail: "curl", headBob: 1 }),
      pose({ body: "sit", eyes: "half", pupilX: -1, mouth: "smile", ears: "up", tail: "flick" }),
    ],
    next: "idle",
    minDuration: 1,
  },
  // Love Guru: a small, blushing heart moment.
  loveHearts: {
    fps: 3,
    loop: false,
    frames: [
      pose({ body: "sit", eyes: "happy", mouth: "smile", tail: "up", hearts: true, blush: true }),
      pose({ body: "sit", eyes: "happy", mouth: "smile", tail: "flick", headBob: 1, hearts: true, blush: true }),
    ],
    next: "idle",
    minDuration: 1.2,
  },

  // ---- Productivity / expressions ---------------------------------------
  knead: {
    fps: 5,
    loop: true,
    frames: [
      pose({ body: "sit", gesture: "knead", legPhase: 0.2, eyes: "down", tail: "wrap" }),
      pose({ body: "sit", gesture: "knead", legPhase: 0.7, eyes: "down", tail: "wrap", headBob: 1 }),
    ],
    minDuration: 0.5,
  },
  overheat: {
    fps: 10,
    loop: true,
    frames: [
      pose({ body: "sit", gesture: "knead", legPhase: 0.2, eyes: "wide", ears: "back", blush: true, steam: true }),
      pose({ body: "sit", gesture: "knead", legPhase: 0.7, eyes: "wide", ears: "back", blush: true, steam: true, headBob: 1 }),
    ],
    minDuration: 1,
  },
  think: {
    fps: 3,
    loop: true,
    frames: [
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.2, eyes: "up", ears: "perk", tail: "flick" }),
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.2, eyes: "up", ears: "perk", tail: "wrap", headBob: -1 }),
    ],
    minDuration: 0.8,
  },
  celebrate: {
    fps: 7,
    loop: false,
    frames: [
      pose({ body: "sit", gesture: "cheer", eyes: "happy", mouth: "smile", tail: "up", hearts: true }),
      pose({ body: "sit", gesture: "cheer", eyes: "happy", mouth: "smile", tail: "flick", headBob: -1 }),
      pose({ body: "sit", eyes: "open", mouth: "smile", tail: "up" }),
    ],
    next: "idle",
    minDuration: 0.8,
  },
  wave: {
    fps: 5,
    loop: false,
    frames: [
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.2, eyes: "happy", mouth: "smile", tail: "wrap" }),
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.7, eyes: "happy", mouth: "smile", tail: "wrap" }),
      pose({ body: "sit", eyes: "closed", mouth: "smile", tail: "wrap" }),
    ],
    next: "sit",
    minDuration: 0.6,
  },

  // ---- Context-aware companion -------------------------------------------
  writeNotes: {
    fps: 5,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "notebook", eyes: "down", tail: "wrap" }),
      pose({ body: "sit", prop: "notebook", eyes: "down", tail: "wrap", headBob: 1 }),
      pose({ body: "sit", prop: "notebook", eyes: "down", tail: "flick", headBob: 1 }),
      pose({ body: "sit", prop: "notebook", eyes: "open", tail: "wrap" }), // glance at the screen
    ],
    minDuration: 0.8,
  },
  // Furious typing: fast alternating slams, the whole cat rocking with each
  // strike, ears pinned back and the odd wide-eyed "wrong key!" beat.
  typeKeys: {
    fps: 13,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "keyboard", legPhase: 0.2, eyes: "focus", ears: "back", tail: "flick", headBob: 1.5 }),
      pose({ body: "sit", prop: "keyboard", legPhase: 0.7, eyes: "focus", ears: "back", tail: "flick", headBob: -0.5 }),
      pose({ body: "sit", prop: "keyboard", legPhase: 0.2, eyes: "down", ears: "back", tail: "up", headBob: 1.5 }),
      pose({ body: "sit", prop: "keyboard", legPhase: 0.7, eyes: "down", ears: "back", tail: "up", headBob: -0.5 }),
      pose({ body: "sit", prop: "keyboard", legPhase: 0.2, eyes: "wide", ears: "back", tail: "flick", headBob: 1.5, blush: true }),
      pose({ body: "sit", prop: "keyboard", legPhase: 0.7, eyes: "surprised", ears: "flat", tail: "puff", headBob: -0.5, blush: true }), // wrong key!
    ],
    minDuration: 0.6,
  },
  // Sings along while another app is using the microphone: mic to the muzzle,
  // mouth working, body swaying, notes drifting up.
  sing: {
    fps: 7,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "mic", mouth: "open", eyes: "happy", notes: true, legPhase: 0, headBob: 1 }),
      pose({ body: "sit", prop: "mic", mouth: "smile", eyes: "happy", notes: true, legPhase: 0.25, headBob: 0 }),
      pose({ body: "sit", prop: "mic", mouth: "open", eyes: "closed", notes: true, legPhase: 0.5, headBob: 1.4 }),
      pose({ body: "sit", prop: "mic", mouth: "smile", eyes: "happy", notes: true, legPhase: 0.75, headBob: 0 }),
    ],
    minDuration: 0.9,
  },
  // Takes a bow when the performance ends, then back to whatever it was doing.
  bow: {
    fps: 7,
    loop: false,
    frames: [
      pose({ body: "sit", eyes: "happy", mouth: "smile", headBob: -1 }),
      pose({ body: "crouch", eyes: "closed", mouth: "smile", headBob: 2, ears: "back" }),
      pose({ body: "crouch", eyes: "closed", mouth: "smile", headBob: 2.4, ears: "back" }),
      pose({ body: "sit", eyes: "happy", mouth: "smile", headBob: 0, ears: "perk" }),
    ],
    next: "idle",
    minDuration: 0.5,
  },
  // On the job: sunglasses on, laptop open, working through whatever the user
  // asked for. Deliberately slow and steady — this plays for as long as the
  // panel is open, so anything busier would get annoying fast.
  quickTools: {
    fps: 4,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "laptop", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0, headBob: 0 }),
      pose({ body: "sit", prop: "laptop", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0.25, headBob: 0.6 }),
      pose({ body: "sit", prop: "laptop", eyes: "focus", ears: "perk", tail: "flick", legPhase: 0.5, headBob: 0 }),
      pose({ body: "sit", prop: "laptop", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0.75, headBob: 0.6 }),
    ],
    minDuration: 1,
  },
  // Calc & Time mode: parked, holding a pocket calculator and tapping at it.
  // Mirrors `quickTools` in shape so both modes read as "settled in to work".
  calcTools: {
    fps: 4,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "calculator", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0, headBob: 0 }),
      pose({ body: "sit", prop: "calculator", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0.25, headBob: 0.6 }),
      pose({ body: "sit", prop: "calculator", eyes: "focus", ears: "perk", tail: "flick", legPhase: 0.5, headBob: 0 }),
      pose({ body: "sit", prop: "calculator", eyes: "focus", ears: "up", tail: "wrap", legPhase: 0.75, headBob: 0.6 }),
    ],
    minDuration: 1,
  },
  clipboardNotice: {
    fps: 7,
    loop: false,
    frames: [
      pose({ body: "sit", prop: "notebook", eyes: "wide", ears: "perk", gesture: "pawUp" }),
      pose({ body: "sit", prop: "notebook", eyes: "happy", ears: "up", gesture: "pawUp", headBob: -1 }),
      pose({ body: "sit", prop: "notebook", eyes: "open", ears: "perk" }),
    ],
    next: "idle",
    minDuration: 0.35,
  },
  clipboardHold: {
    fps: 3,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "notebook", eyes: "open", ears: "up", tail: "wrap" }),
      pose({ body: "sit", prop: "notebook", eyes: "down", ears: "perk", tail: "wrap", headBob: 0.6 }),
      pose({ body: "sit", prop: "notebook", eyes: "half", ears: "up", tail: "flick" }),
    ],
    minDuration: 0.7,
  },
  clipboardClean: {
    fps: 8,
    loop: false,
    frames: [
      pose({ body: "sit", prop: "notebook", gesture: "knead", eyes: "focus", headBob: 0.8 }),
      pose({ body: "sit", prop: "notebook", gesture: "knead", eyes: "down", headBob: -0.4 }),
      pose({ body: "sit", prop: "notebook", gesture: "knead", eyes: "focus", headBob: 0.8 }),
    ],
    next: "clipboardHold",
    minDuration: 0.35,
  },
  clipboardArrange: {
    fps: 7,
    loop: false,
    frames: [
      pose({ body: "sit", prop: "notebook", gesture: "pawUp", eyes: "down", pupilX: -1 }),
      pose({ body: "sit", prop: "notebook", gesture: "pawUp", eyes: "down", pupilX: 1, headBob: -0.6 }),
      pose({ body: "sit", prop: "notebook", eyes: "focus", ears: "perk" }),
    ],
    next: "clipboardHold",
    minDuration: 0.4,
  },
  clipboardSuccess: {
    fps: 7,
    loop: false,
    frames: [
      pose({ body: "sit", prop: "notebook", eyes: "wide", mouth: "smile", ears: "perk" }),
      pose({ body: "sit", prop: "notebook", eyes: "happy", mouth: "smile", ears: "up", headBob: -1, hearts: true }),
      pose({ body: "sit", prop: "notebook", eyes: "happy", mouth: "smile", ears: "perk" }),
    ],
    next: "clipboardHold",
    minDuration: 0.4,
  },
  clipboardError: {
    fps: 5,
    loop: false,
    frames: [
      pose({ body: "sit", prop: "notebook", eyes: "surprised", ears: "back", mouth: "frown" }),
      pose({ body: "sit", prop: "notebook", eyes: "down", ears: "flat", mouth: "frown", headBob: 1 }),
      pose({ body: "sit", prop: "notebook", eyes: "open", ears: "back" }),
    ],
    next: "clipboardHold",
    minDuration: 0.45,
  },
  // Sustained hammering at the keyboard: coat blanches, eyes blow wide, ears
  // pin flat and the whole cat vibrates. Fast fps because panic should read as
  // jittery, not smooth.
  panic: {
    fps: 12,
    loop: true,
    frames: [
      pose({ body: "sit", eyes: "panic", ears: "flat", tail: "puff", tint: "panic", mouth: "open", headBob: -1, steam: true }),
      pose({ body: "sit", eyes: "panic", ears: "flat", tail: "puff", tint: "panic", mouth: "open", headBob: 0.8, steam: true }),
      pose({ body: "sit", eyes: "panic", ears: "flat", tail: "puff", tint: "panic", mouth: "frown", headBob: -0.6, steam: true, blush: true }),
      pose({ body: "sit", eyes: "panic", ears: "flat", tail: "puff", tint: "panic", mouth: "open", headBob: 1, steam: true }),
    ],
    minDuration: 1.2,
  },
  // Neglected for a long stretch: hunched, muted, looking up hopefully.
  sad: {
    fps: 2,
    loop: true,
    frames: [
      pose({ body: "loaf", eyes: "sad", ears: "back", tail: "tuck", tint: "sad", mouth: "frown", headBob: 1 }),
      pose({ body: "loaf", eyes: "sad", ears: "back", tail: "tuck", tint: "sad", mouth: "frown", headBob: 1.4 }),
      pose({ body: "loaf", eyes: "sad", ears: "flat", tail: "tuck", tint: "sad", mouth: "frown", headBob: 1.2 }),
      pose({ body: "loaf", eyes: "sad", ears: "back", tail: "tuck", tint: "sad", mouth: "frown", headBob: 1.5 }),
    ],
    minDuration: 2,
  },
  // Holds a placard overhead and waves it. Loops so the message stays up as
  // long as the accompanying bubble does; App plays it as a timed override.
  placard: {
    fps: 6,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "placard", eyes: "happy", mouth: "smile", ears: "perk", tail: "up", legPhase: 0, hearts: true }),
      pose({ body: "sit", prop: "placard", eyes: "happy", mouth: "smile", ears: "perk", tail: "flick", legPhase: 0.25, headBob: -0.6 }),
      pose({ body: "sit", prop: "placard", eyes: "happy", mouth: "smile", ears: "up", tail: "up", legPhase: 0.5, hearts: true }),
      pose({ body: "sit", prop: "placard", eyes: "happy", mouth: "smile", ears: "perk", tail: "flick", legPhase: 0.75, headBob: -0.6 }),
    ],
    minDuration: 1.5,
  },
  readBook: {
    fps: 3,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "book", eyes: "down", pupilX: -1, tail: "wrap" }),
      pose({ body: "sit", prop: "book", eyes: "down", pupilX: 0, tail: "wrap" }),
      pose({ body: "sit", prop: "book", eyes: "down", pupilX: 1, tail: "wrap", headBob: 1 }),
      pose({ body: "sit", prop: "book", eyes: "half", pupilX: 0, tail: "flick" }),
    ],
    minDuration: 1,
  },
  danceBop: {
    fps: 6,
    loop: true,
    frames: [
      pose({ body: "sit", eyes: "happy", mouth: "smile", notes: true, legPhase: 0.1, headBob: -1, tail: "up" }),
      pose({ body: "sit", eyes: "happy", mouth: "smile", notes: true, legPhase: 0.35, headBob: 1, tail: "flick" }),
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.2, eyes: "happy", mouth: "open", notes: true, headBob: -1, tail: "up" }),
      pose({ body: "sit", gesture: "pawUp", legPhase: 0.7, eyes: "happy", mouth: "smile", notes: true, headBob: 1, tail: "flick" }),
    ],
    minDuration: 0.8,
  },
  // Sheepish sideways glance + blush after a clumsy fall, then a quick shake.
  embarrassed: {
    fps: 5,
    loop: false,
    frames: [
      pose({ body: "crouch", eyes: "surprised", ears: "flat", pupilX: -2, blush: true, headBob: 2 }),
      pose({ body: "sit", eyes: "half", ears: "back", pupilX: 2, blush: true, headBob: 1 }),
      pose({ body: "sit", eyes: "half", ears: "back", pupilX: -1, blush: true }),
      pose({ body: "sit", eyes: "open", ears: "perk", mouth: "smile", blush: true }),
    ],
    next: "shake",
    minDuration: 0.7,
  },
  // Water reminder: the cat sits at a little bowl and laps at it — head dips
  // to the water with the tongue out, the surface ripples (legPhase drives the
  // bowl), then it comes back up to swallow. Loops until dismissed/snoozed.
  drinkWater: {
    fps: 6,
    loop: true,
    frames: [
      pose({ body: "sit", prop: "bowl", eyes: "open", ears: "perk", legPhase: 0, headBob: 0.4 }),
      pose({ body: "sit", prop: "bowl", eyes: "half", mouth: "open", legPhase: 0.25, headBob: 2.2 }),
      pose({ body: "sit", prop: "bowl", eyes: "closed", mouth: "open", legPhase: 0.5, headBob: 2.6 }),
      pose({ body: "sit", prop: "bowl", eyes: "closed", mouth: "open", legPhase: 0.75, headBob: 2.3 }),
      pose({ body: "sit", prop: "bowl", eyes: "half", mouth: "smile", legPhase: 0.9, headBob: 1.2 }),
      pose({ body: "sit", prop: "bowl", eyes: "happy", mouth: "smile", legPhase: 0, headBob: 0.2 }),
    ],
    minDuration: 1.0,
  },
  // Fed up with being hauled around: ears flat, narrowed glare, bared teeth,
  // a couple of cross tail-lashes — then it shakes it off and forgives you.
  angry: {
    fps: 5,
    loop: false,
    frames: [
      pose({ body: "sit", eyes: "angry", ears: "back", mouth: "frown", headBob: -0.5 }),
      pose({ body: "sit", eyes: "angry", ears: "flat", mouth: "teeth", headBob: -1, tail: "puff" }),
      pose({ body: "sit", eyes: "angry", ears: "flat", mouth: "teeth", headBob: -0.6, tail: "flick" }),
      pose({ body: "sit", eyes: "angry", ears: "flat", mouth: "teeth", headBob: -1, tail: "puff" }),
      pose({ body: "sit", eyes: "angry", ears: "back", mouth: "frown", headBob: -0.3, tail: "flick" }),
      pose({ body: "sit", eyes: "half", ears: "back", mouth: "frown" }),
    ],
    next: "shake",
    minDuration: 1.6,
  },
  // Reminder alarm: up on the hind legs, clapping overhead — "hey, look at the
  // clock!". Cheer (paws apart) alternating with clap (paws together).
  alarmClap: {
    fps: 6,
    loop: true,
    frames: [
      pose({ body: "sit", gesture: "cheer", eyes: "wide", mouth: "open", ears: "perk", headBob: -0.6 }),
      pose({ body: "sit", gesture: "clap", eyes: "wide", mouth: "open", ears: "perk", headBob: -0.2 }),
      pose({ body: "sit", gesture: "cheer", eyes: "wide", mouth: "open", ears: "up", headBob: -0.6 }),
      pose({ body: "sit", gesture: "clap", eyes: "surprised", mouth: "open", ears: "perk", headBob: 0 }),
    ],
    minDuration: 0.8,
  },
  // Edge peek: parked half off-screen at a monitor edge, watching the room.
  // The peeking look itself comes from the engine positioning most of the body
  // outside the screen; this loop supplies life — slow blinks, ear checks and
  // an occasional tightening of the front paws' grip (crouch beat).
  edgePeek: {
    fps: 3,
    loop: true,
    frames: [
      pose({ body: "sit", eyes: "open", ears: "perk" }),
      pose({ body: "sit", eyes: "open", ears: "perk" }),
      pose({ body: "sit", eyes: "closed", ears: "perk" }),
      pose({ body: "sit", eyes: "open", ears: "back" }),
      pose({ body: "crouch", eyes: "open", ears: "perk", headBob: 0.6 }),
      pose({ body: "sit", eyes: "open", ears: "perk" }),
    ],
    minDuration: 1.2,
  },
};

/**
 * Directional view per animation. Horizontal movement (walk/run/chase/jump/…)
 * uses the SIDE profile so the cat never slides while facing forward; resting
 * and user-facing states use FRONT; climbing uses BACK; turning is 3/4.
 */
const VIEW_BY_ANIM: Record<AnimationName, CatView> = {
  // Movement
  idle: "front",
  sideIdle: "side",
  backIdle: "back",
  walk: "side",
  stalk: "side",
  run: "side",
  sprint: "side",
  turnAround: "threeQuarter",
  turnLeft: "threeQuarter",
  turnRight: "threeQuarter",
  lookUp: "front",
  lookDown: "front",
  jump: "side",
  smallHop: "side",
  verticalJump: "side",
  longJump: "side",
  fall: "side",
  land: "side",
  softLand: "side",
  hardLand: "side",
  climb: "back",
  climbUp: "back",
  climbDown: "back",
  stepDown: "side",
  balance: "side",
  hangTwoPaws: "front",
  hangOnePaw: "front",
  pullUp: "front",
  // Relaxing
  sit: "front",
  sitSide: "side",
  cuteNod: "front",
  lieDown: "side",
  sleep: "side",
  wakeUp: "front",
  stretch: "side",
  yawn: "front",
  blink: "front",
  tailFlick: "front",
  cleanPaw: "front",
  cleanFace: "front",
  groom: "front",
  scratch: "front",
  lookAround: "front",
  // Cursor
  watch: "front",
  approach: "side",
  chase: "side",
  pounce: "side",
  swat: "side",
  pawSwipe: "side",
  catch: "side",
  hold: "side",
  draggedByCursor: "front",
  cursorGrab: "front",
  cursorSwing: "front",
  loseGrip: "side",
  landSafe: "side",
  confused: "front",
  startled: "side",
  tired: "front",
  tailChase: "side",
  peek: "side",
  // User
  petted: "front",
  pettedEyesClosed: "front",
  purr: "front",
  pickedUp: "front",
  dangle: "front",
  draggedSurprised: "front",
  placedDown: "front",
  shake: "side",
  annoyed: "front",
  happy: "front",
  // Productivity / expressions
  knead: "front",
  overheat: "front",
  think: "front",
  celebrate: "front",
  wave: "front",
  // Context-aware companion
  writeNotes: "front",
  typeKeys: "front",
  sing: "front",
  bow: "front",
  quickTools: "front",
  calcTools: "front",
  clipboardNotice: "front",
  clipboardHold: "front",
  clipboardClean: "front",
  clipboardArrange: "front",
  clipboardSuccess: "front",
  clipboardError: "front",
  panic: "front",
  sad: "front",
  placard: "front",
  readBook: "front",
  danceBop: "front",
  embarrassed: "front",
  drinkWater: "front",
  edgePeek: "front",
  angry: "front",
  alarmClap: "front",
  sideEye: "front",
  loveHearts: "front",
};

// Apply the view to every animation definition, and bake it into each frame so
// the hot path (AnimationController.getPose, several calls per rendered frame)
// can return a frame directly instead of allocating a spread copy every time.
// Frames are cloned so two animations sharing a frame array can't stamp each
// other's view onto it.
(Object.keys(ANIMATIONS) as AnimationName[]).forEach((name) => {
  const def = ANIMATIONS[name];
  const view = VIEW_BY_ANIM[name];
  def.view = view;
  def.frames = def.frames.map((f) => ({ ...f, view }));
});

/** Total duration (seconds) of one pass of an animation. */
export function animationDuration(name: AnimationName): number {
  const def = ANIMATIONS[name];
  return def.frames.length / def.fps;
}
