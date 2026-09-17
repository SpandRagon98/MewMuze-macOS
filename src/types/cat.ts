/**
 * Core domain types for the cat's behaviour and rendering.
 *
 * These are intentionally framework-agnostic (no React / Tauri imports) so the
 * behaviour, physics, and animation systems can be unit-tested in isolation.
 */

export type Facing = "left" | "right";

export type CatMood = "calm" | "curious" | "playful" | "sleepy" | "annoyed";

/**
 * Every discrete animation the cat can play. Kept as a string-literal union so
 * the animation definitions and the state machine stay in sync at compile time.
 */
export type AnimationName =
  // Movement
  | "idle"
  | "sideIdle"
  | "backIdle"
  | "walk"
  | "stalk"
  | "run"
  | "sprint"
  | "turnAround"
  | "turnLeft"
  | "turnRight"
  | "lookUp"
  | "lookDown"
  | "jump"
  | "smallHop"
  | "verticalJump"
  | "longJump"
  | "fall"
  | "land"
  | "softLand"
  | "hardLand"
  | "climb"
  | "climbUp"
  | "climbDown"
  | "stepDown"
  | "balance"
  | "hangTwoPaws"
  | "hangOnePaw"
  | "pullUp"
  // Relaxing
  | "sit"
  | "sitSide"
  | "cuteNod"
  | "lieDown"
  | "sleep"
  | "wakeUp"
  | "stretch"
  | "yawn"
  | "blink"
  | "tailFlick"
  | "cleanPaw"
  | "cleanFace"
  | "groom"
  | "scratch"
  | "lookAround"
  // Cursor interactions
  | "watch"
  | "approach"
  | "chase"
  | "pounce"
  | "swat"
  | "pawSwipe"
  | "catch"
  | "hold"
  | "draggedByCursor"
  | "cursorGrab"
  | "cursorSwing"
  | "loseGrip"
  | "landSafe"
  | "confused"
  | "startled"
  | "tired"
  | "tailChase"
  | "peek"
  // User interactions
  | "petted"
  | "pettedEyesClosed"
  | "purr"
  | "pickedUp"
  | "dangle"
  | "draggedSurprised"
  | "placedDown"
  | "shake"
  | "annoyed"
  | "happy"
  // Productivity / expressions
  | "knead"
  | "overheat"
  | "think"
  | "celebrate"
  | "wave"
  // Context-aware companion
  | "writeNotes"
  | "typeKeys"
  | "sing"
  | "bow"
  | "quickTools"
  | "calcTools"
  | "clipboardNotice"
  | "clipboardHold"
  | "clipboardClean"
  | "clipboardArrange"
  | "clipboardSuccess"
  | "clipboardError"
  | "panic"
  | "sad"
  | "placard"
  | "readBook"
  | "danceBop"
  | "embarrassed"
  | "drinkWater"
  | "edgePeek"
  | "angry"
  | "alarmClap"
  // Persona reactions (Paper): built from existing pose features
  | "sideEye"
  | "loveHearts";

/** Mutable runtime state of the cat, updated every tick. */
export interface CatState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  facing: Facing;
  mood: CatMood;
  /** 0..1 — depletes with exertion, recovers while resting. */
  energy: number;
  /** 0..1 — drives how eagerly the cat investigates the cursor. */
  curiosity: number;
  isGrounded: boolean;
  isDragging: boolean;
  currentAnimation: AnimationName;
}

/** A point in overlay-local logical pixels (origin = top-left of the overlay). */
export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned bounding box in overlay-local logical pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Snapshot of the cursor, derived without ever storing history. */
export interface CursorSample {
  x: number;
  y: number;
  /** Instantaneous speed in logical px per second (smoothed). */
  speed: number;
  /** Unit direction of travel; zero-vector when stationary. */
  dirX: number;
  dirY: number;
  timestamp: number;
}

export type ActivityLevel = "calm" | "balanced" | "playful";
export type CatSize = "small" | "medium" | "large";
