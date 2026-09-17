import type { AnimationName, CatState, CursorSample, Facing, Point } from "../types/cat";
import type { NativeMonitor, Platform } from "../types/platform";
import { AnimationController } from "../animation/animationController";
import {
  DEFAULT_POSE,
  TAIL_PHASE_STEPS,
  type CostumeTraits,
  type EyeState,
  type MouthState,
  type PoseSpec,
} from "../animation/spriteLoader";
import { MochiMesh, COLS as MESH_COLS, ROWS as MESH_ROWS, GRAB_V } from "../physics/mochiMesh";
import { CatBrain, DROWSY_AFTER_S } from "../behaviour/catStateMachine";
import { TAIL_STRIDE, PUPIL_STRIDE, HEAD_RANGE, qualityLevel } from "../perf/quality";
import { updateEnergy, clamp01 } from "../behaviour/energySystem";
import { computeMood, decayAnnoyance, bumpAnnoyance } from "../behaviour/moodSystem";
import type { ActivityProfile } from "../settings/defaultSettings";
import { integrate, applyJump, makeConfig, type PhysicsConfig } from "../physics/physicsEngine";
import { findDropTarget } from "../physics/platformResolver";
import {
  clampToBounds,
  findLanding,
  findSupport,
  catBounds,
  rectContains,
  type Bounds,
} from "../physics/collision";
import type { Rect } from "../types/cat";
import { CatEmotionEngine, type EmotionRequest, type EmotionSource, type EmotionState } from "../emotion/emotionEngine";
import { ExpressionController, NO_OVERLAY, applyOverlay, feelPose, type ExpressionSettings, type Overlay } from "../emotion/expression";
import { CatGestureController, type GestureId } from "../emotion/gestures";
import type { EmotionId } from "../emotion/emotions";

/** Animations that mean "the cat is airborne on purpose"; skip the fall override. */
const AIRBORNE_ANIMS = new Set<AnimationName>([
  "jump",
  "smallHop",
  "verticalJump",
  "longJump",
  "fall",
  "pounce",
  "startled",
  "loseGrip",
  "draggedByCursor",
]);

const RECOVERY_SECONDS = 3;

/**
 * In-place beats a playful cat performs while parked at a screen edge. All are
 * FRONT-view animations, so it stays facing the room rather than turning
 * side-on against the wall.
 */
const EDGE_FIDGETS: AnimationName[] = ["cuteNod", "tailFlick", "danceBop", "happy"];

/** Shared empty slice list for the common at-rest case (avoids allocation). */
/** Flat [x0,y0,x1,y1,…] offsets for the mesh grid; length COLS*ROWS*2. */
const MESH_LEN = MESH_COLS * MESH_ROWS * 2;

export interface EngineWorld {
  platforms: Platform[];
  bounds: Bounds;
  monitors: NativeMonitor[];
  origin: { left: number; top: number };
  /** DPI scale of the monitor the cat is currently on. */
  scale: number;
}

export interface RenderInfo {
  x: number;
  y: number;
  sizePx: number;
  pose: PoseSpec;
  facing: Facing;
  /** 0..1 squash amount for the landing bounce. */
  squash: number;
  bounds: Rect;
  /** Smoothed pupil offset in sprite design units (cursor eye-tracking). */
  pupilX: number;
  pupilY: number;
  /** Quantised tail sway step, 0..TAIL_PHASE_STEPS-1. */
  tailPhase: number;
  /** -1..1 quantised head lean toward the cursor. */
  headTurnX: number;
  headTurnY: number;
  /**
   * Deformable-mesh vertex offsets for the mochi drag, as a flat
   * [x0,y0,x1,y1,…] Float32Array in sprite-size units (COLS*ROWS vertices,
   * row-major). Null when the body is at rest, so idle rendering stays a single
   * cheap blit. The renderer warps the sprite through this grid as triangles.
   */
  mesh: Float32Array | null;
}

type Override = { type: "call" | "sleep" | "pet"; until: number } | null;
type PlatformAttachment = {
  platformId: string;
  offsetX: number;
  offsetY: number;
  mode: "standing" | "hanging" | "pulling" | "climbing";
  side?: "left" | "right";
  age: number;
};

export class CatEngine {
  readonly state: CatState;
  private ctrl = new AnimationController("idle");
  private brain = new CatBrain();
  private cfg: PhysicsConfig;

  private world: EngineWorld;
  private cursor: CursorSample | null = null;
  /** May the cat move toward the cursor? Independent of whether it can see it. */
  private cursorChasing = true;
  /**
   * Photo Mode: hold this animation and stop wandering, so the cat on the
   * desktop is in the pose being photographed. Null the rest of the time, when
   * this costs one branch per tick and nothing else.
   */
  private photoPose: AnimationName | null = null;
  /** Photo Mode expression override; null fields keep the pose's own. */
  private photoExpression: { eyes: EyeState | null; mouth: MouthState | null } | null = null;
  /**
   * Scratch for the expression override. `getPose()` hands back a REUSED
   * object owned by the controller — writing to it would corrupt the tween it
   * builds every frame, so the override is applied to a copy.
   */
  private readonly photoPoseScratch: PoseSpec = { ...DEFAULT_POSE };
  /** Idle seconds before the cat yawns and dozes off (user-configurable). */
  private drowsyAfterS = DROWSY_AFTER_S;
  private userIdle = false;
  /** Seconds without mouse or keyboard input (drowsiness ladder). */
  private userIdleS = 0;
  private pettingActive = false;

  private annoyance = 0;
  private secondsSinceInteraction = 999;
  private support: Platform | null = null;
  private attachment: PlatformAttachment | null = null;
  private cursorHeld = false;
  private cursorHoldAge = 0;
  private cursorGrabCooldown = 0;
  private turningTo: Facing | null = null;
  private turnAge = 0;
  private offscreenTimer = 0;
  private squash = 0;
  private paused = false;

  private sizePx: number;
  private activity: ActivityProfile;
  private override: Override = null;
  private random: () => number;

  // Eye tracking (smoothed pupil offsets in sprite design units).
  private eyeTracking = true;
  private pupilX = 0;
  private pupilY = 0;
  /**
   * Head lean toward the cursor. Tracks the same target as the pupils but with
   * roughly half the travel and half the speed, so the eyes lead and the head
   * follows a beat later — a fast cursor sweep leaves both briefly trailing.
   */
  private headX = 0;
  private headY = 0;

  /**
   * Continuous tail sway phase in [0, TAIL_PHASE_STEPS). Always advancing, so
   * the tail keeps curling whether the cat is sitting, walking or dozing.
   * Quantised on the way out so it doesn't explode the sprite cache.
   */
  private tailPhase = 0;

  /**
   * Soft-body deformation used while the cat is dragged. A 2D spring MESH: the
   * grabbed scruff stays welded to the cursor while the torso, paws, tail and
   * ears each trail with their own spring delay, and the renderer warps the
   * sprite through the grid as triangles (tear-free by shared vertices).
   */
  private readonly mochi = new MochiMesh();
  /** Reused output buffer so getRender allocates nothing per frame. */
  private readonly meshBuf = new Float32Array(MESH_LEN);

  /**
   * Edge Peek Mode: parked at the extreme left/right desktop edge with most of
   * the body off-screen, head and front paws peeking in. Entered by dropping
   * the cat against an edge; exited by grabbing it again.
   */
  private edgePeekSide: "left" | "right" | null = null;

  /**
   * Countdown (s) to the next in-place fidget while parked at a screen edge.
   * Only a playful cat uses it; calmer ones just sit and watch the room.
   */
  private edgeFidgetS = 3;

  /**
   * Timestamps (ms) of recent grabs. Haul the cat around 6+ times inside a
   * minute and it loses its temper: flat ears, bared teeth, angry glare.
   */
  private recentGrabsMs: number[] = [];
  private angryPending = false;

  /** User toggle for the drag deformation. */
  private dragStretchEnabled = false;
  private lastDragX: number | null = null;
  private lastDragY: number | null = null;

  /** Persistent grounded loop (kneading, thinking, scroll-watching…). */
  private loopOverride: AnimationName | null = null;

  // ---- emotion (Paper) ---------------------------------------------------
  /** What the cat feels. Everything that wants a feeling asks here (feel()). */
  readonly emotion = new CatEmotionEngine();
  private readonly expression = new ExpressionController(7);
  private readonly gestures = new CatGestureController();
  private overlay: Overlay = NO_OVERLAY;
  /** Scratch for the emotional pose; getPose()'s object is the controller's, never written. */
  private readonly emotionPose: PoseSpec = { ...DEFAULT_POSE };
  /** Reused so a gesture on top of the overlay allocates nothing per frame. */
  private readonly gestureOverlay: Overlay = { ...NO_OVERLAY, look: {} };
  /** Something the cat is watching (the butterfly), in world px. */
  private attention: Point | null = null;
  private attentionSince = 0;
  private emotionContext = { serious: false, edgyInvited: false };
  /** Until when (engine clock) the user has provoked the cat themselves - grabbed it once too often. */
  private provokedUntil = 0;
  private photoEmotion: EmotionId | null = null;
  /** Engine clock (s), for gestures. */
  private clock = 0;
  /** Peek mode: tuck into a screen corner and stay unobtrusive. */
  private peek = false;

  constructor(opts: {
    sizePx: number;
    scale: number;
    activity: ActivityProfile;
    bounds: Bounds;
    start?: Point;
    random?: () => number;
  }) {
    this.sizePx = opts.sizePx;
    this.activity = opts.activity;
    this.cfg = makeConfig(opts.scale);
    this.random = opts.random ?? Math.random;
    this.world = { platforms: [], bounds: opts.bounds, monitors: [], origin: { left: 0, top: 0 }, scale: opts.scale };
    const start = opts.start ?? { x: (opts.bounds.right - opts.bounds.left) / 2, y: opts.bounds.bottom };
    this.state = {
      x: start.x,
      y: start.y,
      velocityX: 0,
      velocityY: 0,
      facing: "right",
      mood: "calm",
      energy: 0.8,
      curiosity: 0.4,
      isGrounded: false,
      isDragging: false,
      currentAnimation: "idle",
    };
  }

  // ---- external inputs ---------------------------------------------------
  setWorld(world: EngineWorld): void {
    // Preserve a standing/hanging cat's local offset when its host window moves.
    // If that window disappears or is minimised, release the cat into gravity.
    if (this.attachment) {
      const previous = this.world.platforms.find((p) => p.id === this.attachment?.platformId);
      const platform = world.platforms.find((p) => p.id === this.attachment?.platformId);
      if (!platform) {
        this.releasePlatformAttachment();
      } else {
        if (this.attachment.mode === "climbing") {
          this.state.x = this.attachment.side === "left" ? platform.left - this.sizePx * 0.12 : platform.right + this.sizePx * 0.12;
          this.state.y += platform.top - (previous?.top ?? platform.top);
          this.attachment.offsetX = this.state.x - platform.left;
          this.attachment.offsetY = this.state.y - platform.top;
          this.state.isGrounded = false;
        } else {
          const inset = this.sizePx * 0.18;
          this.state.x = Math.max(platform.left + inset, Math.min(platform.right - inset, platform.left + this.attachment.offsetX));
          this.attachment.offsetX = this.state.x - platform.left;
        }
        if (this.attachment.mode === "standing") {
          this.state.y = platform.top;
          this.state.isGrounded = true;
        } else if (this.attachment.mode !== "climbing") {
          this.state.y = platform.top + this.sizePx * 0.92;
          this.state.isGrounded = false;
        }
      }
    }
    this.world = world;
    this.cfg = makeConfig(world.scale);
  }
  /**
   * The cursor's real position, ALWAYS passed when known. Eye and head tracking
   * read this, so it must not be used to gate chasing — nulling it to stop the
   * cat walking also blinds it, which is what broke tracking in work mode,
   * during pomodoro focus, and whenever cursor-chasing was switched off.
   * Use `setCursorChasing` for that instead.
   */
  setCursor(sample: CursorSample | null): void {
    this.cursor = sample;
  }
  /** Whether the cat may walk/pounce toward the cursor. Looking is unaffected. */
  setCursorChasing(on: boolean): void {
    this.cursorChasing = on;
  }
  setDrowsyAfterS(seconds: number): void {
    this.drowsyAfterS = seconds;
  }
  /**
   * `idleSeconds` (how long both mouse and keyboard have been inactive) drives
   * the drowsiness ladder — the cat yawns and settles down to sleep once the
   * user has been away a while. Optional so existing callers/tests keep working.
   */
  setUserIdle(idle: boolean, idleSeconds?: number): void {
    const awayS = this.userIdleS;
    this.userIdle = idle;
    this.userIdleS = idleSeconds ?? (idle ? 999 : 0);
    // Back after a real absence (a measured one, not the no-reading fallback): glad to see you.
    if (idleSeconds !== undefined && this.measuredIdle && awayS >= 300 && idleSeconds < 2) {
      if (this.feel({ emotion: "happy", intensity: 0.75, source: "event" })) this.gesture("wave");
    }
    this.measuredIdle = idleSeconds !== undefined;
  }
  private measuredIdle = false;
  setPetting(active: boolean): void {
    if (active && !this.pettingActive) this.registerInteraction();
    this.pettingActive = active;
    // Held while the strokes last; it fades softly once they stop.
    if (active) this.feel({ emotion: "affectionate", intensity: 0.8, source: "interaction", duration: 2 });
  }
  setActivity(a: ActivityProfile): void {
    this.activity = a;
  }
  setSize(sizePx: number): void {
    this.sizePx = sizePx;
  }
  setPaused(p: boolean): void {
    this.paused = p;
  }
  setEyeTracking(on: boolean): void {
    this.eyeTracking = on;
    if (!on) {
      this.pupilX = 0;
      this.pupilY = 0;
    }
  }
  setDragStretch(on: boolean): void {
    this.dragStretchEnabled = on;
  }
  /**
   * Persistent grounded loop animation (kneading while the user types, agent
   * "thinking", scroll watching…). Pass null to release. Never interrupts
   * airborne/dragging/hanging states — those are handled before it in tick().
   */
  setLoopOverride(anim: AnimationName | null): void {
    this.loopOverride = anim;
  }
  setPeek(on: boolean): void {
    this.peek = on;
  }
  /**
   * Enter/leave Photo Mode. Passing an animation parks the cat in it; passing
   * null hands it straight back to its normal behaviour with no other state
   * touched, which is what makes closing the panel safe mid-anything.
   */
  setPhotoPose(anim: AnimationName | null): void {
    this.photoPose = anim;
  }
  setPhotoExpression(expression: { eyes: EyeState | null; mouth: MouthState | null } | null): void {
    this.photoExpression = expression;
  }
  /** Play a one-shot reaction if the current animation can be interrupted. */
  playOneShot(anim: AnimationName): void {
    this.ctrl.requestPlay(anim);
  }

  // ---- emotion (Paper) ---------------------------------------------------
  /**
   * Ask the cat to feel something. A drag owns the cat: nothing new starts
   * halfway through one (it would suddenly cry mid-air), except what the drag
   * itself asks for.
   */
  feel(r: EmotionRequest): boolean {
    if ((this.state.isDragging || this.cursorHeld) && r.source !== "drag") return false;
    return this.emotion.request(r);
  }
  /** What the cat feels right now. */
  feeling(): EmotionState {
    return this.emotion.state;
  }
  /** Let go of a feeling `source` asked for (the chat closed, the butterfly left). */
  releaseFeeling(source: EmotionSource): void {
    this.emotion.release(source);
  }
  setExpressionSettings(s: ExpressionSettings): void {
    this.expression.setSettings(s);
  }
  /** What the worn costume covers (costumes declare it; see CostumeTraits). */
  setCostumeTraits(t: CostumeTraits): void {
    this.expression.setCostumeTraits(t);
  }
  /** Serious conversation, or an explicit invitation to be edgy (see emotion/gestures.ts). */
  setEmotionContext(c: { serious: boolean; edgyInvited: boolean }): void {
    this.emotionContext = c;
  }
  private edgyInvited(): boolean {
    return this.emotionContext.edgyInvited || this.clock < this.provokedUntil;
  }
  /** Hauled around once too often: a tantrum the user asked for. */
  private tantrum(): void {
    this.ctrl.play("angry", true);
    this.provokedUntil = this.clock + 8;
    this.emotion.request({ emotion: "rage", intensity: 0.9, source: "interaction", duration: 3 });
  }
  /**
   * Play → Tease: the user asked for attitude, so this is the one explicit
   * invitation. The rude paw still needs Edgy gestures on and nothing serious
   * going on; otherwise the same moment ends in a dismissive wave.
   */
  tease(): void {
    this.provokedUntil = this.clock + 4;
    if (this.feel({ emotion: "savage", intensity: 0.85, source: "interaction", duration: 4 })) this.gesture("middle");
  }
  /** Play a paw gesture now (a finished focus session → victory). */
  gesture(id: GestureId): void {
    this.gestures.play(id, this.clock);
  }
  /**
   * Watch something (the butterfly), in world px; null to stop. The cat
   * freezes when it first notices, then the pupils track it and the head
   * follows a beat later.
   */
  setAttention(p: Point | null): void {
    if (p && !this.attention) this.attentionSince = this.clock;
    this.attention = p;
  }
  /** How long the current thing has been watched, in seconds (0 if nothing). */
  attentionSeconds(): number {
    return this.attention ? this.clock - this.attentionSince : 0;
  }
  /** Photo Mode: hold this emotion at full strength on the photographed pose. */
  setPhotoEmotion(id: EmotionId | null): void {
    this.photoEmotion = id;
  }
  /** The current expression overlay (tests, the developer line). */
  getOverlay(): Overlay {
    return this.overlay;
  }

  /** Somewhere a feeling can be shown on the body: on its feet and not being handled. */
  private canEmote(): boolean {
    return (
      this.state.isGrounded &&
      !this.state.isDragging &&
      !this.cursorHeld &&
      !this.paused &&
      (!this.attachment || this.attachment.mode === "standing")
    );
  }

  private updateEmotion(dt: number): void {
    this.clock += dt;
    this.emotion.update(dt);
    const can = this.canEmote();
    this.overlay = this.expression.update(dt, this.emotion.state, {
      canGesture: can,
      serious: this.emotionContext.serious,
      edgyInvited: this.edgyInvited(),
      attention: null,
    });
    // Whole-body accents (a hop of excitement, a yawn) only where the body is free.
    const anim = this.overlay.anim;
    if (!anim || !can || this.loopOverride || this.override || this.pettingActive || this.photoPose || this.attention) return;
    if (anim === "smallHop") {
      // A real little hop of joy - a fifth of a full jump - landed by the
      // ordinary airborne code, not a jump pose played on the spot.
      this.attachment = null;
      this.state.velocityY = this.cfg.jumpVelocity * 0.42;
      this.state.isGrounded = false;
      this.ctrl.play("smallHop", true);
      return;
    }
    this.ctrl.requestPlay(anim);
  }
  /** Entrance: drop in from the top of the current monitor and land. */
  enterFromTop(): void {
    const mon = this.world.monitors.find((m) => m.isPrimary) ?? this.world.monitors[0];
    if (mon) {
      this.state.x = (mon.workLeft + mon.workRight) / 2 - this.world.origin.left;
      this.state.y = mon.workTop - this.world.origin.top + this.sizePx;
    }
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = false;
    this.attachment = null;
    this.ctrl.play("fall", true);
  }

  /**
   * Entrance at a remembered spot: drop in just above `x`/`y` and land there.
   *
   * The sibling of `enterFromTop`, for returning from a full-screen app — the
   * cat comes back where it was rather than in the middle of the primary
   * monitor. Any edge-peek state is left alone on purpose, so a cat parked at
   * the screen edge is still parked there afterwards.
   */
  enterAt(x: number, y: number): void {
    this.state.x = x;
    this.state.y = Math.max(this.sizePx, y - this.sizePx * 1.5);
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = false;
    this.attachment = null;
    this.ctrl.play("fall", true);
  }

  /** Interactive box for hit-testing the global cursor against the cat. */
  getBounds(): Rect {
    return catBounds(this.state, this.sizePx);
  }
  containsPoint(localX: number, localY: number): boolean {
    return rectContains(this.getBounds(), localX, localY);
  }

  // ---- drag / click / commands ------------------------------------------
  grabStart(): void {
    this.registerInteraction();
    if (this.secondsSinceInteractionRecentlyDisturbed()) this.annoyance = bumpAnnoyance(this.annoyance);
    this.state.isDragging = true;
    this.state.isGrounded = false;
    this.attachment = null;
    this.cursorHeld = false;
    // Grabbing a peeking cat pulls it out of the edge; the mochi drag itself
    // is the pull-out animation.
    this.edgePeekSide = null;
    // Count how often it's been hauled around lately. Past six grabs in a
    // minute, patience runs out — the tantrum plays at the next landing.
    const nowMs = Date.now();
    this.recentGrabsMs = this.recentGrabsMs.filter((t) => nowMs - t < 60_000);
    this.recentGrabsMs.push(nowMs);
    if (this.recentGrabsMs.length >= 6) {
      this.angryPending = true;
      this.recentGrabsMs.length = 0; // one tantrum per streak, then forgiveness
    }
    this.mochi.grabStart();
    this.ctrl.play("pickedUp", true);
  }
  grabMove(localX: number, localY: number, cursorSpeed: number): void {
    if (!this.state.isDragging) return;
    // Put the source sprite's scruff exactly on the cursor. The face stays
    // controlled while the torso and paws trail behind it.
    this.state.x = localX;
    this.state.y = localY + this.sizePx * (1 - GRAB_V);
    // Mochi stretch: the head stays at the cursor while the body pulls like
    // taffy. Pulls elongate the cat dramatically (up to ~2.5x) and squash the other axis
    // for a soft, springy, volume-preserving feel — while still reading as a
    // cat. Direction changes feed the wobble spring.
    if (this.dragStretchEnabled && this.lastDragX !== null && this.lastDragY !== null) {
      // Feed the frame's cursor delta to the soft body in SPRITE UNITS, so the
      // same feel holds at any cat size or DPI. The chain does the rest: the
      // held scruff tracks the cursor exactly, everything else has to catch up.
      const dx = (localX - this.lastDragX) / this.sizePx;
      const dy = (localY - this.lastDragY) / this.sizePx;
      this.mochi.grabMove(dx, dy);
    }
    this.lastDragX = localX;
    this.lastDragY = localY;
    const anim: AnimationName = cursorSpeed > 260 ? "draggedSurprised" : "dangle";
    this.ctrl.requestPlay(anim);
    this.registerInteraction();
  }
  grabEnd(releaseVelocity: Point | null): void {
    if (!this.state.isDragging) return;
    this.state.isDragging = false;
    // Let go: the chain springs back past rest and wobbles down to neutral,
    // carrying a little of the throw velocity so a flung cat wobbles harder.
    this.mochi.release(
      Math.max(-2, Math.min(2, (releaseVelocity?.x ?? 0) / this.sizePx)),
      Math.max(-2, Math.min(2, (releaseVelocity?.y ?? 0) / this.sizePx)),
    );
    this.lastDragX = null;
    this.lastDragY = null;
    // Edge Peek: released hard against the extreme left/right of the desktop,
    // the cat tucks itself mostly off-screen and peeks back in.
    const b = this.world.bounds;
    const EDGE_GRAB = this.sizePx * 0.5;
    if (this.state.x - b.left < EDGE_GRAB || b.right - this.state.x < EDGE_GRAB) {
      this.enterEdgePeek(this.state.x - b.left < EDGE_GRAB ? "left" : "right");
      this.registerInteraction();
      return;
    }
    const target = findDropTarget(this.state.x, this.state.y, this.world.platforms, this.sizePx);
    if (target?.mode === "stand") {
      this.state.y = target.platform.top;
      this.state.velocityX = 0;
      this.state.velocityY = 0;
      this.state.isGrounded = true;
      this.attachToPlatform(target.platform, "standing");
      if (this.angryPending) {
        this.angryPending = false;
        this.tantrum();
      } else {
        this.ctrl.play("placedDown", true);
      }
    } else if (target?.mode === "hang") {
      this.state.y = target.platform.top + this.sizePx * 0.92;
      this.state.velocityX = 0;
      this.state.velocityY = 0;
      this.state.isGrounded = false;
      this.attachToPlatform(target.platform, "hanging");
      this.ctrl.play("hangTwoPaws", true);
    } else if (target?.mode === "cling" && target.side) {
      this.state.x = target.side === "left" ? target.platform.left - this.sizePx * 0.12 : target.platform.right + this.sizePx * 0.12;
      this.state.velocityX = 0;
      this.state.velocityY = 0;
      this.state.isGrounded = false;
      this.attachToPlatform(target.platform, "climbing", target.side);
      this.ctrl.play("climbUp", true);
    } else {
      this.state.isGrounded = false;
      if (releaseVelocity) {
        this.state.velocityX = releaseVelocity.x;
        this.state.velocityY = Math.max(this.cfg.jumpVelocity * 0.45, Math.min(this.cfg.maxFallSpeed * 0.45, releaseVelocity.y));
      }
      this.ctrl.play("fall", true);
    }
    this.registerInteraction();
  }
  /** Which desktop edge the cat is peeking from, if any. */
  get edgePeek(): "left" | "right" | null {
    return this.edgePeekSide;
  }

  /**
   * Tuck into the edge: centre the sprite far enough outside the screen that
   * only about a third — the near half of the face plus a front paw — stays
   * visible, facing back into the room. Eye/head tracking keeps running, so
   * the peeking cat still follows the cursor around.
   */
  private enterEdgePeek(side: "left" | "right"): void {
    this.edgePeekSide = side;
    this.enterEdgePeekPosition();
    this.state.facing = side === "left" ? "right" : "left";
    this.attachment = null;
    this.ctrl.play("edgePeek", true);
  }

  /** (Re-)pin the peeking cat against its edge; also re-clamps after world changes. */
  private enterEdgePeekPosition(): void {
    const b = this.world.bounds;
    const side = this.edgePeekSide;
    if (!side) return;
    // Centre slightly INSIDE the screen so the face (one full eye, nose and
    // mouth) reads clearly while the body's far half stays tucked away.
    this.state.x = side === "left" ? b.left + this.sizePx * 0.08 : b.right - this.sizePx * 0.08;
    // Keep whatever height it was dropped at, clamped inside the monitor.
    const floor = b.floorY ?? b.bottom - this.sizePx * 0.5;
    this.state.y = Math.max(this.sizePx, Math.min(floor, this.state.y));
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = true;
  }

  /** A quick click (no drag): a gentle poke reaction. */
  poke(): void {
    this.registerInteraction();
    this.annoyance = bumpAnnoyance(this.annoyance, 0.18);
    if (this.annoyance > 0.6) {
      this.ctrl.requestPlay("annoyed");
    } else {
      this.ctrl.requestPlay(this.random() < 0.5 ? "happy" : "blink");
    }
  }

  command(cmd: "pause" | "resume" | "pet" | "call" | "sleep" | "reset", now: number): void {
    switch (cmd) {
      case "pause":
        this.paused = true;
        break;
      case "resume":
        this.paused = false;
        break;
      case "pet":
        this.override = { type: "pet", until: now + 2500 };
        this.state.mood = "calm";
        this.registerInteraction();
        break;
      case "call":
        this.override = { type: "call", until: now + 6000 };
        break;
      case "sleep":
        this.override = { type: "sleep", until: now + 8000 };
        this.state.energy = Math.min(this.state.energy, 0.3);
        this.ctrl.play("yawn", true);
        break;
      case "reset":
        this.recoverToSafePosition();
        break;
    }
  }

  private registerInteraction(): void {
    this.secondsSinceInteraction = 0;
  }
  private secondsSinceInteractionRecentlyDisturbed(): boolean {
    return this.secondsSinceInteraction < 1.5;
  }

  private attachToPlatform(platform: Platform, mode: PlatformAttachment["mode"], side?: "left" | "right"): void {
    this.attachment = {
      platformId: platform.id,
      offsetX: this.state.x - platform.left,
      offsetY: this.state.y - platform.top,
      mode,
      side,
      age: 0,
    };
  }

  private releasePlatformAttachment(): void {
    this.attachment = null;
    this.support = null;
    this.state.isGrounded = false;
    this.state.velocityY = Math.max(40 * this.world.scale, this.state.velocityY);
    this.ctrl.play("fall", true);
  }

  // ---- main tick ---------------------------------------------------------
  tick(dt: number, now: number): void {
    // Clamp dt so a long stall (lock/sleep) can't launch the cat across screens.
    dt = Math.min(dt, 0.05);

    this.updateVitals(dt, now);
    this.updateStretchSpring(dt);
    this.updateEmotion(dt);
    this.updatePupils(dt);
    this.updateTail(dt);
    this.cursorGrabCooldown = Math.max(0, this.cursorGrabCooldown - dt);

    // Photo Mode holds the chosen pose. Same shape as the pause branch below —
    // no wandering, no gravity — except the pose is the user's pick, and a
    // finished one-shot is replayed so a wave keeps waving while it is framed.
    if (this.photoPose) {
      if (this.ctrl.name !== this.photoPose) this.ctrl.play(this.photoPose, true);
      this.ctrl.update(dt);
      // `update` chains a finished one-shot onward (happy -> idle), which would
      // quietly swap the pose the user is composing. Snapping back afterwards
      // both prevents that and makes a finite pose repeat, so a wave keeps
      // waving for as long as the panel is open.
      if (this.ctrl.name !== this.photoPose || this.ctrl.isFinished) {
        this.ctrl.play(this.photoPose, true);
      }
      this.finishTick();
      return;
    }

    if (this.paused) {
      this.ctrl.requestPlay("sit");
      this.ctrl.update(dt);
      this.finishTick();
      return;
    }

    if (this.state.isDragging) {
      this.ctrl.update(dt);
      this.finishTick();
      return;
    }

    if (this.cursorHeld) {
      this.tickCursorHeld(dt);
      this.finishTick();
      return;
    }

    if (this.edgePeekSide) {
      // Pinned at the edge: no gravity, no wandering. The loop supplies
      // blinks/ear checks and the live pupil/head tracking keeps the eyes on
      // the cursor. A world-geometry change (monitor unplugged) re-clamps.
      this.enterEdgePeekPosition();
      this.ctrl.requestPlay("edgePeek");
      this.ctrl.update(dt);
      this.finishTick();
      return;
    }

    if (this.attachment?.mode === "hanging" || this.attachment?.mode === "pulling") {
      this.tickHanging(dt);
      this.finishTick();
      return;
    }
    if (this.attachment?.mode === "climbing") {
      this.tickClimbing(dt);
      this.finishTick();
      return;
    }

    this.support = findSupport(this.state.x, this.state.y, this.world.platforms);
    if (this.state.isGrounded && !this.support) {
      // The supporting window moved away, closed, or the cat walked off its edge.
      this.attachment = null;
      this.state.isGrounded = false;
    } else if (this.state.isGrounded && this.support?.kind === "window") {
      this.attachToPlatform(this.support, "standing");
    }

    if (!this.state.isGrounded) {
      this.tickAirborne(dt);
    } else {
      this.tickGrounded(dt, now);
    }

    this.squash = Math.max(0, this.squash - dt * 4);
    this.checkRecovery(dt);
    this.finishTick();
  }

  /** Springy return to shape after stretching, with a soft mochi wobble. */
  /**
   * Step the soft-body chain. Replaces the old uniform stretchX/stretchY
   * scaling, which could only make the whole sprite bigger or smaller — it had
   * no way to let the body trail, bend or wobble independently of the head.
   */
  private updateStretchSpring(dt: number): void {
    this.mochi.update(dt);
  }

  /** Smooth pupil tracking toward the cursor; fast cursors lag naturally. */
  private updatePupils(dt: number): void {
    let tx = 0;
    let ty = 0;
    let pupilRate = 9.5;
    let headRate = 5.6;
    const headY = this.state.y - this.sizePx * 0.72;
    // Shorter reach = the gaze saturates sooner, so an ordinary move sweeps the
    // pupils across their whole range — visibly more dramatic.
    const aim = (x: number, y: number, reach: number) => {
      tx = Math.max(-1, Math.min(1, (x - this.state.x) / reach)) * 2;
      ty = Math.max(-1, Math.min(1, (y - headY) / reach)) * 2;
    };
    if (this.attention) {
      // Layered attention: the pupils snap to what it is watching, the head
      // turns a beat later - so a fast zig-zag leaves the eyes leading and the
      // head making small, late corrections, never the neck whipping round.
      aim(this.attention.x, this.attention.y, 150 * this.world.scale);
      pupilRate = 15;
      headRate = 3.4;
    } else {
      if (this.eyeTracking && this.cursor) aim(this.cursor.x, this.cursor.y, 190 * this.world.scale);
      // A feeling has a resting gaze (downcast when sad, sideways when smug)
      // that pulls the eyes away from the cursor as it strengthens.
      const g = this.overlay.gaze;
      if (g) {
        const w = Math.min(1, this.overlay.intensity * 1.2);
        tx += (g.x - tx) * w;
        ty += (g.y - ty) * w;
      }
    }
    const ease = Math.min(1, dt * pupilRate);
    this.pupilX += (tx - this.pupilX) * ease;
    this.pupilY += (ty - this.pupilY) * ease;
    // Deliberately slower and shorter than the pupils, so the eyes still lead
    // and the head follows a beat later — but with noticeably more travel and
    // snap, so the cat visibly turns to watch you rather than only hinting at
    // it. With no cursor the target is 0, so the head drifts back to neutral.
    const headEase = Math.min(1, dt * headRate);
    this.headX += (tx * 0.92 - this.headX) * headEase;
    this.headY += (ty * 0.74 - this.headY) * headEase;
  }

  /**
   * Advance the tail sway. Speed follows what the cat is doing: a slow drift
   * while dozing, a lazy curl while sitting, quick flicks while running or
   * excited. It never stops entirely — a motionless tail reads as a dead cat.
   */
  private updateTail(dt: number): void {
    const anim = this.ctrl.name;
    let cyclesPerSecond: number;
    if (anim === "sleep" || anim === "lieDown") cyclesPerSecond = 0.08;
    else if (anim === "run" || anim === "sprint" || anim === "chase" || anim === "pounce") cyclesPerSecond = 0.85;
    else if (anim === "walk" || anim === "stalk" || anim === "danceBop") cyclesPerSecond = 0.5;
    else if (this.state.mood === "playful") cyclesPerSecond = 0.42;
    else cyclesPerSecond = 0.22; // sitting / idling: a slow, calm curl
    // Feelings set the tempo: a lazy sweep when sad, a quick flick when excited or cross.
    if (this.overlay.active) cyclesPerSecond *= this.overlay.tailSpeed;
    this.tailPhase = (this.tailPhase + dt * cyclesPerSecond * TAIL_PHASE_STEPS) % TAIL_PHASE_STEPS;
  }

  private updateVitals(dt: number, now: number): void {
    this.secondsSinceInteraction += dt;
    this.annoyance = decayAnnoyance(this.annoyance, dt);
    this.state.energy = updateEnergy(this.state.energy, this.ctrl.name, dt);

    // Curiosity drifts toward a target set by cursor proximity.
    const near = this.cursor ? Math.hypot(this.cursor.x - this.state.x, this.cursor.y - this.state.y) < 150 * this.world.scale : false;
    const target = near ? 0.8 : 0.3;
    this.state.curiosity = clamp01(this.state.curiosity + (target - this.state.curiosity) * Math.min(1, dt * 0.8));

    this.state.mood = computeMood(
      {
        energy: this.state.energy,
        curiosity: this.state.curiosity,
        annoyance: this.annoyance,
        secondsSinceInteraction: this.secondsSinceInteraction,
        cursorNearby: near,
        userIdle: this.userIdle,
      },
      this.state.mood,
    );

    if (this.override && now >= this.override.until) this.override = null;
  }

  private tickHanging(dt: number): void {
    const attachment = this.attachment;
    if (!attachment) return;
    const platform = this.world.platforms.find((p) => p.id === attachment.platformId);
    if (!platform) {
      this.releasePlatformAttachment();
      this.ctrl.update(dt);
      return;
    }

    attachment.age += dt;
    this.state.x = Math.max(platform.left + this.sizePx * 0.18, Math.min(platform.right - this.sizePx * 0.18, platform.left + attachment.offsetX));
    this.state.y = platform.top + this.sizePx * 0.92;
    this.state.velocityX = 0;
    this.state.velocityY = 0;

    if (attachment.mode === "pulling") {
      this.ctrl.requestPlay("pullUp");
      if (attachment.age >= 0.55) {
        attachment.mode = "standing";
        attachment.age = 0;
        this.state.y = platform.top;
        this.state.isGrounded = true;
        this.support = platform;
        // Turn to face the user after hauling itself up, rather than sitting
        // in profile on the ledge.
        this.ctrl.play("sit", true);
      }
    } else if (attachment.age < 1.7) {
      this.ctrl.requestPlay("hangTwoPaws");
    } else if (attachment.age < 2.45) {
      this.ctrl.requestPlay("hangOnePaw");
    } else if (this.random() < 0.82) {
      attachment.mode = "pulling";
      attachment.age = 0;
      this.ctrl.play("pullUp", true);
    } else {
      this.attachment = null;
      this.state.isGrounded = false;
      this.state.velocityY = 80 * this.world.scale;
      this.ctrl.play("loseGrip", true);
    }
    this.ctrl.update(dt);
  }

  private tickClimbing(dt: number): void {
    const attachment = this.attachment;
    if (!attachment) return;
    const platform = this.world.platforms.find((p) => p.id === attachment.platformId);
    if (!platform) {
      this.releasePlatformAttachment();
      this.ctrl.update(dt);
      return;
    }
    attachment.age += dt;
    this.state.x = attachment.side === "left" ? platform.left - this.sizePx * 0.12 : platform.right + this.sizePx * 0.12;
    this.state.y -= 42 * this.world.scale * dt;
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = false;
    attachment.offsetY = this.state.y - platform.top;
    this.ctrl.requestPlay("climbUp");

    const hangingY = platform.top + this.sizePx * 0.92;
    if (this.state.y <= hangingY) {
      this.state.x = Math.max(platform.left + this.sizePx * 0.3, Math.min(platform.right - this.sizePx * 0.3, this.state.x));
      this.state.y = hangingY;
      attachment.offsetX = this.state.x - platform.left;
      attachment.offsetY = this.state.y - platform.top;
      attachment.mode = "hanging";
      attachment.side = undefined;
      attachment.age = 0;
      this.ctrl.play("hangTwoPaws", true);
    }
    this.ctrl.update(dt);
  }

  private tickCursorHeld(dt: number): void {
    this.cursorHoldAge += dt;
    const cursor = this.cursor;
    const tooFast = !cursor || cursor.speed > 650 * this.world.scale;
    if (tooFast || this.cursorHoldAge > 2.2) {
      this.cursorHeld = false;
      this.cursorGrabCooldown = 4;
      this.state.isGrounded = false;
      this.state.velocityX = cursor ? cursor.dirX * Math.min(cursor.speed * 0.25, this.cfg.runSpeed) : 0;
      this.state.velocityY = 70 * this.world.scale;
      this.ctrl.play("loseGrip", true);
      this.ctrl.update(dt);
      return;
    }
    this.state.x = cursor.x;
    this.state.y = cursor.y + this.sizePx * 0.92;
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = false;
    this.ctrl.requestPlay("cursorSwing");
    this.ctrl.update(dt);
  }

  private tickAirborne(dt: number): void {
    const prevY = this.state.y;
    const prevVy = this.state.velocityY;
    integrate(this.state, this.cfg, dt, null);

    // A pounce can visually catch the real cursor without ever controlling it.
    if (
      this.ctrl.name === "pounce" &&
      this.cursor &&
      this.cursorChasing &&
      this.cursorGrabCooldown <= 0 &&
      this.containsPoint(this.cursor.x, this.cursor.y) &&
      this.cursor.speed < 650 * this.world.scale
    ) {
      this.cursorHeld = true;
      this.cursorHoldAge = 0;
      this.state.x = this.cursor.x;
      this.state.y = this.cursor.y + this.sizePx * 0.92;
      this.state.velocityX = 0;
      this.state.velocityY = 0;
      this.ctrl.play("cursorGrab", true);
      this.ctrl.update(dt);
      return;
    }

    const landing = findLanding(prevY, this.state.y, this.state.x, this.state.velocityY, this.world.platforms);
    if (landing) {
      this.land(landing, prevVy);
    } else {
      const half = this.sizePx / 2;
      clampToBounds(this.state, this.world.bounds, half);
      if (this.state.isGrounded) this.land(null, prevVy); // hit the virtual floor
    }

    if (!this.state.isGrounded && !AIRBORNE_ANIMS.has(this.ctrl.name)) {
      this.ctrl.play("fall", true);
    }
    this.ctrl.update(dt);
  }

  private land(platform: Platform | null, impactVy: number): void {
    if (platform) this.state.y = platform.top;
    this.state.velocityY = 0;
    this.state.isGrounded = true;
    this.squash = clamp01(impactVy / this.cfg.maxFallSpeed) * 1.2;
    if (platform?.kind === "window") this.attachToPlatform(platform, "standing");
    else this.attachment = null;
    // Hauled around one time too many: the temper tantrum outranks the
    // landing flourish. Ears flat, teeth out, then it shakes it off.
    if (this.angryPending) {
      this.angryPending = false;
      this.tantrum();
      return;
    }
    // A clumsy hard landing sometimes leaves the cat sheepishly embarrassed.
    const hard = this.squash > 0.4;
    const sheepish = hard && this.random() < 0.45;
    this.ctrl.play(hard ? (sheepish ? "embarrassed" : "hardLand") : "softLand", true);
    if (sheepish) this.emotion.request({ emotion: "embarrassed", intensity: 0.7, source: "interaction", duration: 2.5 });
  }

  private tickGrounded(dt: number, now: number): void {
    const half = this.sizePx / 2;

    // Petting takes precedence over autonomous behaviour.
    if (this.pettingActive || this.override?.type === "pet") {
      this.state.velocityX = 0;
      this.annoyance = decayAnnoyance(this.annoyance, dt * 3);
      this.state.energy = clamp01(this.state.energy + dt * 0.03);
      this.ctrl.requestPlay(this.pettingCyclePose());
      clampToBounds(this.state, this.world.bounds, half);
      this.ctrl.update(dt);
      return;
    }

    if (this.override) {
      this.driveOverride(dt);
      clampToBounds(this.state, this.world.bounds, half);
      this.ctrl.update(dt);
      return;
    }

    // Persistent loop override (work mode, kneading along with typing, agent
    // states…) outranks peek: peekAuto can flip on for any fullscreen window,
    // and without this a cat that started peeking before work mode began (or
    // whose peekAuto triggers while it's on) walks to a corner instead of
    // holding its static work pose.
    if (this.loopOverride) {
      this.state.velocityX = 0;
      this.ctrl.requestPlay(this.loopOverride);
      clampToBounds(this.state, this.world.bounds, half);
      this.ctrl.update(dt);
      return;
    }

    // Peek mode: retreat to the nearest bottom corner and stay tiny + still.
    if (this.peek) {
      const margin = this.sizePx * 0.7;
      const targetX =
        this.state.x < (this.world.bounds.left + this.world.bounds.right) / 2
          ? this.world.bounds.left + margin
          : this.world.bounds.right - margin;
      const dx = targetX - this.state.x;
      if (Math.abs(dx) > 8) {
        const dir = Math.sign(dx);
        this.state.facing = dir >= 0 ? "right" : "left";
        integrate(this.state, this.cfg, dt, dir * this.cfg.walkSpeed);
        this.ctrl.requestPlay("walk");
      } else {
        this.state.velocityX = 0;
        // Straight, front-facing pose once parked in the corner. The old
        // "peek" loop is a SIDE view (crouched, peering round a corner), which
        // read as the cat hunching sideways against the screen edge.
        this.ctrl.requestPlay("edgePeek");
      }
      clampToBounds(this.state, this.world.bounds, half);
      this.ctrl.update(dt);
      return;
    }

    // Watching something, or feeling something that wants stillness (sad,
    // crying, savage, comforting): stay put, face the room, and let the face
    // and paws do the acting. Wandering off mid-sob would read as not feeling it.
    const ov = this.overlay;
    // A paw gesture is made facing the room, so a walking cat pauses for it too.
    if (this.attention || this.gestures.isPlaying(this.clock) || (ov.active && ov.movement === "still" && ov.intensity >= 0.35)) {
      integrate(this.state, this.cfg, dt, 0);
      this.state.velocityX = 0;
      if (this.attention) this.state.facing = this.attention.x >= this.state.x ? "right" : "left";
      this.ctrl.requestPlay(this.attention ? "watch" : "idle");
      clampToBounds(this.state, this.world.bounds, half);
      this.ctrl.update(dt);
      return;
    }

    // After something heavy the cat stays quieter for a while (emotional memory):
    // less play, more rest, then back to its usual self.
    const calm = this.emotion.calmness();
    const activity = calm > 0
      ? { playfulness: this.activity.playfulness * (1 - calm), chaseEagerness: this.activity.chaseEagerness * (1 - calm), restfulness: this.activity.restfulness * (1 + calm) }
      : this.activity;
    const out = this.brain.update({
      state: this.state,
      cfg: this.cfg,
      cursor: this.cursor,
      petting: this.pettingActive,
      userIdle: this.userIdle,
      userIdleS: this.userIdleS,
      drowsyAfterS: this.drowsyAfterS,
      cursorChasing: this.cursorChasing,
      activity,
      support: this.support,
      platforms: this.world.platforms,
      bounds: this.world.bounds,
      scale: this.world.scale,
      dt,
      now,
      random: this.random,
    });

    // At the very end of the desktop there is nowhere further to go. Rather
    // than holding a side-on walk pose pressed against the wall, the cat turns
    // to face the room and sits. Walking back inward is untouched, so this is
    // never a trap — and a playful cat still fidgets in place while it waits.
    const end = this.atHorizontalEnd(half);
    if (end && !out.jump) {
      const intoWall =
        out.targetVx === null || (end === "left" ? out.targetVx <= 0 : out.targetVx >= 0);
      if (intoWall) {
        integrate(this.state, this.cfg, dt, 0);
        this.state.velocityX = 0;
        this.edgeFidgetS -= dt;
        if (this.activity.playfulness >= 1.5 && this.edgeFidgetS <= 0) {
          this.edgeFidgetS = 3 + this.random() * 4;
          // All front-facing, all in place: it moves without turning sideways.
          const fidget = EDGE_FIDGETS[Math.floor(this.random() * EDGE_FIDGETS.length)];
          this.ctrl.requestPlay(fidget);
        } else {
          this.ctrl.requestPlay("sit");
        }
        clampToBounds(this.state, this.world.bounds, half);
        this.ctrl.update(dt);
        return;
      }
    } else {
      // Prime the timer so arriving at an edge doesn't fidget instantly.
      this.edgeFidgetS = 2 + this.random() * 3;
    }

    // Decelerate into a readable three-quarter turn before reversing a walk.
    if (!out.jump && out.targetVx !== null && out.facing !== this.state.facing) {
      if (this.turningTo !== out.facing) {
        this.turningTo = out.facing;
        this.turnAge = 0;
        this.ctrl.play("turnAround", true);
      }
      this.turnAge += dt;
      integrate(this.state, this.cfg, dt, null);
      if (this.turnAge < 0.3) {
        clampToBounds(this.state, this.world.bounds, half);
        this.ctrl.update(dt);
        return;
      }
      this.state.facing = this.turningTo;
      this.turningTo = null;
      this.turnAge = 0;
    } else {
      this.state.facing = out.facing;
      if (out.targetVx === null) {
        this.turningTo = null;
        this.turnAge = 0;
      }
    }
    if (out.jump) {
      this.attachment = null;
      applyJump(this.state, this.cfg, out.jump.vx);
      this.ctrl.play(out.jump.anim, true);
    } else {
      // A low mood walks slower and smaller.
      const slow = ov.active && ov.movement === "slow" ? 1 - 0.45 * ov.intensity : 1;
      integrate(this.state, this.cfg, dt, out.targetVx === null ? null : out.targetVx * slow);
      this.ctrl.requestPlay(out.animation);
      if (this.support?.kind === "window" && this.state.x >= this.support.left && this.state.x <= this.support.right) {
        this.attachToPlatform(this.support, "standing");
      }
    }
    clampToBounds(this.state, this.world.bounds, half);
    this.ctrl.update(dt);
  }

  /**
   * Which end of the desktop the cat is pinned against, if any. `clampToBounds`
   * parks the centre exactly `half` from the edge, so a couple of pixels of
   * tolerance is all that's needed.
   */
  private atHorizontalEnd(half: number): "left" | "right" | null {
    const b = this.world.bounds;
    // A band rather than an exact pin: the cat should already be facing the
    // room by the time it settles near the end, not only when jammed into it.
    const band = half + this.sizePx * 0.5;
    if (this.state.x <= b.left + band) return "left";
    if (this.state.x >= b.right - band) return "right";
    return null;
  }

  private driveOverride(dt: number): void {
    const ov = this.override!;
    if (ov.type === "sleep") {
      this.state.velocityX = 0;
      this.ctrl.requestPlay("sleep");
      return;
    }
    if (ov.type === "call" && this.cursor) {
      const dx = this.cursor.x - this.state.x;
      if (Math.abs(dx) < 30 * this.world.scale) {
        this.override = null;
        this.ctrl.requestPlay("happy");
        return;
      }
      const dir = Math.sign(dx) || 1;
      this.state.facing = dir >= 0 ? "right" : "left";
      integrate(this.state, this.cfg, dt, dir * this.cfg.runSpeed);
      this.ctrl.requestPlay("approach");
    }
  }

  private pettingCyclePose(): AnimationName {
    if (this.annoyance > 0.5) return "annoyed";
    if (this.secondsSinceInteraction < 0.6) return "purr";
    return "pettedEyesClosed";
  }

  private checkRecovery(dt: number): void {
    const b = this.world.bounds;
    const margin = this.sizePx;
    const cx = this.state.x;
    const cy = this.state.y;
    const outside = cx < b.left - margin || cx > b.right + margin || cy < b.top - margin || cy > b.bottom + margin;
    if (outside) {
      this.offscreenTimer += dt;
      if (this.offscreenTimer >= RECOVERY_SECONDS) this.recoverToSafePosition();
    } else {
      this.offscreenTimer = 0;
    }
  }

  private recoverToSafePosition(): void {
    this.attachment = null;
    this.cursorHeld = false;
    const mon = this.world.monitors.find((m) => m.isPrimary) ?? this.world.monitors[0];
    if (mon) {
      this.state.x = (mon.workLeft + mon.workRight) / 2 - this.world.origin.left;
      this.state.y = mon.workBottom - this.world.origin.top;
    } else {
      this.state.x = (this.world.bounds.left + this.world.bounds.right) / 2;
      this.state.y = this.world.bounds.bottom;
    }
    this.state.velocityX = 0;
    this.state.velocityY = 0;
    this.state.isGrounded = true;
    this.offscreenTimer = 0;
    this.ctrl.play("softLand", true);
  }

  private finishTick(): void {
    this.state.currentAnimation = this.ctrl.name;
  }

  // ---- render ------------------------------------------------------------
  /**
   * Reused across calls: `getRender` runs several times per frame (draw plus
   * UI anchoring), and at 60fps a fresh object each time is pure GC churn.
   * Callers must treat the result as read-only and not retain it past the frame.
   */
  private readonly renderInfo: RenderInfo = {
    x: 0, y: 0, sizePx: 0, pose: DEFAULT_POSE, facing: "right", squash: 0,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    pupilX: 0, pupilY: 0, headTurnX: 0, headTurnY: 0, tailPhase: 0, mesh: null,
  };

  getRender(): RenderInfo {
    const r = this.renderInfo;
    r.x = this.state.x;
    r.y = this.state.y;
    r.sizePx = this.sizePx;
    r.pose = this.ctrl.getPose();
    if (this.photoExpression) {
      Object.assign(this.photoPoseScratch, r.pose);
      if (this.photoExpression.eyes) this.photoPoseScratch.eyes = this.photoExpression.eyes;
      if (this.photoExpression.mouth) this.photoPoseScratch.mouth = this.photoExpression.mouth;
      r.pose = this.photoPoseScratch;
    }
    if (this.photoPose) {
      // Photo Mode: the chosen emotion at full strength, held still for the shot.
      // Same call as the panel's preview, so the photo and the desktop cat match.
      if (this.photoEmotion) r.pose = feelPose(r.pose, this.photoEmotion, this.emotionPose);
    } else if (this.canEmote()) {
      const settings = this.expression.getSettings();
      const g = this.gestures.pose(this.clock, { enabled: settings.edgy, invited: this.edgyInvited(), serious: this.emotionContext.serious });
      let ov = this.overlay;
      if (g) {
        // A requested gesture plays over whatever is felt (or over nothing at all).
        Object.assign(this.gestureOverlay, ov.active ? ov : NO_OVERLAY);
        this.gestureOverlay.active = true;
        this.gestureOverlay.gesture = g;
        ov = this.gestureOverlay;
      }
      if (ov.active) r.pose = applyOverlay(r.pose, ov, this.emotionPose);
    }
    r.facing = this.state.facing;
    r.squash = this.squash;
    r.bounds = this.getBounds();
    const q = qualityLevel();
    // Quantised to whole design pixels so the sprite frame cache stays small,
    // and coarsened further on weak machines — pupil x head is the single
    // biggest driver of distinct sprites while the pointer is moving.
    const ps = PUPIL_STRIDE[q];
    r.pupilX = Math.round(this.pupilX / ps) * ps;
    r.pupilY = Math.round(this.pupilY / ps) * ps;
    // Tail coarseness scales with quality: at 128 steps the tail alone can
    // author 128 distinct sprites per sway, which a weak machine cannot
    // rasterise. Striding it collapses that proportionally.
    // Asleep the tail barely stirs (a third of its sway), so most of its 40
    // steps draw the same pixels - yet each was a new sprite and a repaint of
    // the whole overlay. Eight positions a cycle look the same and cost a fifth.
    const asleep = this.ctrl.name === "sleep" || this.ctrl.name === "lieDown";
    const stride = TAIL_STRIDE[q] * (asleep ? 5 : 1);
    r.tailPhase = (Math.floor(this.tailPhase / stride) * stride) % TAIL_PHASE_STEPS;
    // Quantised to ±2 at full quality (was ±1): five steps instead of three, so
    // the head reaches further and moves in finer increments as the cursor
    // crosses the screen. `headX/Y` track a target of at most ±1.56, so rounding
    // directly gives five useful buckets with saturation only at the very edge —
    // scaling first would peg it at ±2 for a third of the cursor's travel.
    // The range narrows on weak machines: it is a direct cache multiplier.
    const hr = HEAD_RANGE[q];
    r.headTurnX = Math.max(-hr, Math.min(hr, Math.round(this.headX)));
    r.headTurnY = Math.max(-hr, Math.min(hr, Math.round(this.headY)));
    // A sleeping cat does not watch the cursor: behind closed eyes every step
    // of it was a new sprite and a repaint that looked exactly the same.
    if (asleep) r.pupilX = r.pupilY = r.headTurnX = r.headTurnY = 0;
    // Only pay for mesh deformation while it would actually be visible. At rest
    // the renderer takes the single-blit fast path.
    if (this.mochi.isAtRest()) {
      r.mesh = null;
    } else {
      const buf = this.meshBuf;
      const verts = this.mochi.verts;
      for (let i = 0; i < verts.length; i++) {
        buf[i * 2] = verts[i].ox;
        buf[i * 2 + 1] = verts[i].oy;
      }
      r.mesh = buf;
    }
    return r;
  }

  getSafePosition(): Point {
    // A peeking cat's centre is deliberately off-screen; persist a position
    // pulled back inside so a restart never spawns the cat out of reach.
    if (this.edgePeekSide) {
      const b = this.world.bounds;
      const x = this.edgePeekSide === "left" ? b.left + this.sizePx : b.right - this.sizePx;
      return { x, y: this.state.y };
    }
    return { x: this.state.x, y: this.state.y };
  }
}
