import type { AnimationName, CatState, CursorSample, Facing } from "../types/cat";
import type { Platform } from "../types/platform";
import type { PhysicsConfig } from "../physics/physicsEngine";
import type { Bounds } from "../physics/collision";
import type { ActivityProfile } from "../settings/defaultSettings";
import { edgeProximity } from "../physics/collision";
import { findJumpTarget } from "../physics/platformResolver";
import { animationDuration } from "../animation/animationDefinitions";
import { canExert } from "./energySystem";
import { pickBehaviour, type Behaviour, type WeightContext } from "./behaviourWeights";

/**
 * The cat's "brain". When the cat is grounded and not being dragged/petted, the
 * engine asks this for a decision each tick. It chooses a high-level behaviour
 * (with cooldowns + minimum durations so it doesn't twitch), then "drives" that
 * behaviour into a concrete output: a target horizontal velocity, an optional
 * jump/pounce impulse, an animation request, and a facing direction.
 *
 * It never mutates `state`; the engine applies the outputs. This keeps the
 * decision logic deterministic and unit-testable with an injected RNG.
 */
export interface BrainInput {
  state: CatState;
  cfg: PhysicsConfig;
  cursor: CursorSample | null;
  petting: boolean;
  userIdle: boolean;
  /** Seconds without mouse or keyboard input. Drives the drowsiness ladder. */
  userIdleS?: number;
  /** Idle seconds before the cat gets drowsy. Defaults to DROWSY_AFTER_S. */
  drowsyAfterS?: number;
  cursorChasing: boolean;
  activity: ActivityProfile;
  support: Platform | null;
  platforms: Platform[];
  bounds: Bounds;
  scale: number;
  dt: number;
  now: number;
  random: () => number;
}

export interface BrainOutput {
  targetVx: number | null;
  jump: { vx: number; anim: "jump" | "smallHop" | "verticalJump" | "longJump" | "pounce" } | null;
  animation: AnimationName;
  facing: Facing;
  behaviour: Behaviour;
}

const DECISION_INTERVAL = 0.7; // s between possible behaviour changes (calmer)
const BEHAVIOUR_MIN: Record<Behaviour, number> = {
  // Long minimums for calm states so the cat settles and stays a while rather
  // than twitching between activities — this is the "relaxing companion" feel.
  idle: 4.0,
  wander: 1.4,
  rest: 6.0,
  groom: 2.6,
  observe: 2.2,
  lookAround: 1.2,
  approachCursor: 1.0,
  chaseCursor: 1.2,
  playSelf: 1.8,
  sleep: 6.0,
};
const BEHAVIOUR_COOLDOWN: Partial<Record<Behaviour, number>> = {
  chaseCursor: 2.5,
};

/** Fraction of the screen span kept clear at each end when picking a wander target. */
const WANDER_EDGE_MARGIN = 0.03;

/**
 * Cursor motionless for this long and the cat gets visibly drowsy: it yawns,
 * then curls up. Driven directly rather than left to the weighted random pick,
 * so "walk away and it falls asleep" is dependable instead of luck.
 */
export const DROWSY_AFTER_S = 20;

/** Let the yawn animation finish before the cat curls up to sleep. */
const YAWN_DURATION = animationDuration("yawn");

export class CatBrain {
  private behaviour: Behaviour = "idle";
  private age = 0;
  private decisionTimer = 0;
  private wanderTargetX = 0;
  private cooldownUntil = new Map<Behaviour, number>();
  private pounceReadyAt = 0;
  private exploreReadyAt = 0;
  private cuteNodReadyAt = 4_000;
  private idleGestureReadyAt = 3_000;
  private lastFacing: Facing = "right";

  get current(): Behaviour {
    return this.behaviour;
  }

  /** Behaviours that move the cat around, i.e. shown in side profile. */
  private static readonly MOVING: ReadonlySet<Behaviour> = new Set<Behaviour>([
    "wander",
    "approachCursor",
    "chaseCursor",
    "playSelf",
  ]);

  private setBehaviour(b: Behaviour, input: BrainInput): void {
    // Coming to a stop: settle facing the user and blink shortly after, so
    // arriving somewhere reads as "sat down and looked at you" rather than
    // freezing mid-stride in profile.
    if (b === "idle" && CatBrain.MOVING.has(this.behaviour)) {
      this.idleGestureReadyAt = input.now + 400 + input.random() * 500;
    }
    this.behaviour = b;
    this.age = 0;
    if (b === "wander") {
      // Nearly the full width: the cat rarely chooses to wander, but when it
      // does it should be able to reach anywhere across the desktop rather than
      // being fenced into the middle 80%. clampToBounds still stops it at the
      // real screen edge, so the small margin is only to keep the walk natural.
      const span = input.bounds.right - input.bounds.left;
      const min = input.bounds.left + span * WANDER_EDGE_MARGIN;
      const max = input.bounds.right - span * WANDER_EDGE_MARGIN;
      this.wanderTargetX = min + input.random() * (max - min);
    }
    const cd = BEHAVIOUR_COOLDOWN[b];
    if (cd) this.cooldownUntil.set(b, input.now + cd * 1000);
  }

  private cooldownReady(b: Behaviour, now: number): boolean {
    const until = this.cooldownUntil.get(b);
    return until === undefined || now >= until;
  }

  update(input: BrainInput): BrainOutput {
    const { state, cursor, scale, dt, now } = input;
    this.age += dt;
    this.decisionTimer += dt;

    const near = 150 * scale;
    const dx = cursor ? cursor.x - state.x : Infinity;
    const dy = cursor ? cursor.y - state.y : Infinity;
    const dist = cursor ? Math.hypot(dx, dy) : Infinity;
    const cursorNearby = dist < near;
    const cursorFast = cursor ? cursor.speed > 320 * scale : false;

    // Reactive interrupt: a lively cat pounces at sudden nearby motion.
    if (
      input.cursorChasing &&
      cursorFast &&
      cursorNearby &&
      canExert(state.energy) &&
      this.behaviour !== "chaseCursor" &&
      this.age >= 0.4 &&
      input.random() < 0.5
    ) {
      this.setBehaviour("chaseCursor", input);
    }

    const idleS = input.userIdleS ?? (input.userIdle ? 999 : 0);
    const drowsyAfter = input.drowsyAfterS ?? DROWSY_AFTER_S;
    // Asleep while the user is still away: stay asleep. Re-deciding here picked
    // another behaviour, the drowsy rule below sent it straight back to sleep,
    // and the cat yawned itself awake again every six seconds.
    const stayAsleep = this.behaviour === "sleep" && idleS >= drowsyAfter;

    // Periodic re-decision once the current behaviour has run its minimum.
    if (!stayAsleep && this.decisionTimer >= DECISION_INTERVAL && this.age >= BEHAVIOUR_MIN[this.behaviour]) {
      this.decisionTimer = 0;
      const wctx: WeightContext = {
        mood: state.mood,
        energy: state.energy,
        curiosity: state.curiosity,
        cursorNearby,
        cursorFast,
        cursorChasingEnabled: input.cursorChasing,
        userIdle: input.userIdle,
        activity: input.activity,
      };
      const next = pickBehaviour(wctx, input.random);
      if (next !== this.behaviour && this.cooldownReady(next, now)) {
        this.setBehaviour(next, input);
      }
    }

    // Left alone long enough: settle down and doze off. Checked before the
    // wake rule so a parked cursor can't hold the cat awake indefinitely.
    if (idleS >= drowsyAfter && this.behaviour !== "sleep" && !input.petting) {
      this.setBehaviour("sleep", input);
    }

    // Wake up if something approaches while sleeping — but only on genuine
    // cursor movement. A stationary cursor resting near the cat is not a
    // disturbance, and treating it as one made the cat wake/sleep in a loop.
    if (this.behaviour === "sleep" && cursorNearby && idleS < 2) {
      this.setBehaviour("observe", input);
      return this.output(null, null, "wakeUp", this.faceToward(dx));
    }

    return this.drive(input, { dx, dy, dist, cursorNearby });
  }

  private drive(
    input: BrainInput,
    c: { dx: number; dy: number; dist: number; cursorNearby: boolean },
  ): BrainOutput {
    const { state, cfg, scale, now } = input;
    switch (this.behaviour) {
      case "rest":
        // Stay sitting upright and facing the user; only actually flop down
        // (a side-on pose) once genuinely low on energy.
        // Lying down is a side-on pose, so keep it for genuinely tired moments;
        // the default resting posture stays an upright, front-facing sit.
        return this.output(
          null,
          null,
          this.age > 3 && state.energy < 0.28 ? "lieDown" : "sit",
          this.lastFacing,
        );
      case "sleep":
        // Play the yawn out in full before curling up — it was previously cut
        // off after 0.08s, so the cat appeared to teleport into sleep.
        return this.output(
          null,
          null,
          this.age < YAWN_DURATION ? "yawn" : "sleep",
          this.lastFacing,
        );
      case "groom":
        return this.output(null, null, "groom", this.lastFacing);
      case "lookAround":
        return this.output(null, null, "lookAround", this.faceToward(c.dx));
      case "observe":
        return this.output(null, null, c.cursorNearby ? "watch" : "lookAround", this.faceToward(c.dx));
      case "playSelf": {
        // Rounded haunches and a visible paw swipe make self-play read clearly.
        const wobble = Math.sin(this.age * 8) * cfg.walkSpeed * 0.6;
        return this.output(wobble, null, this.age % 2.2 < 1.4 ? "tailChase" : "pawSwipe", wobble >= 0 ? "right" : "left");
      }
      case "approachCursor": {
        if (!input.cursor) return this.output(null, null, "lookAround", this.lastFacing);
        const stop = 26 * scale;
        if (c.dist < stop) return this.output(null, null, "watch", this.faceToward(c.dx));
        const dir = Math.sign(c.dx) || 1;
        return this.driveWalk(input, dir, cfg.walkSpeed * 0.72, "stalk");
      }
      case "chaseCursor": {
        if (!input.cursor || !canExert(state.energy)) {
          this.setBehaviour("rest", input);
          return this.output(null, null, "tired", this.lastFacing);
        }
        const pounceRange = 95 * scale;
        const dir = Math.sign(c.dx) || 1;
        if (c.dist < pounceRange && state.isGrounded && now >= this.pounceReadyAt) {
          this.pounceReadyAt = now + 1400;
          const vx = dir * cfg.runSpeed * 0.8;
          return this.output(null, { vx, anim: "pounce" }, "pounce", dir >= 0 ? "right" : "left");
        }
        const sprinting = input.cursor.speed > 520 * scale;
        return this.driveWalk(input, dir, sprinting ? cfg.runSpeed * 1.22 : cfg.runSpeed, sprinting ? "sprint" : "chase");
      }
      case "wander": {
        // Occasionally hop onto a nearby window ledge instead of only pacing the
        // floor, so the cat explores the whole screen vertically too.
        if (input.random() < 0.5) {
          const hop = this.tryExplore(input);
          if (hop) return hop;
        }
        const dir = Math.sign(this.wanderTargetX - state.x);
        if (Math.abs(this.wanderTargetX - state.x) < 6 || dir === 0) {
          this.setBehaviour("idle", input);
          return this.output(null, null, "idle", this.lastFacing);
        }
        return this.driveWalk(input, dir, cfg.walkSpeed, "walk");
      }
      case "idle":
      default: {
        // Occasionally face the user, sit, and give a tiny affectionate nod.
        // The randomized cooldown keeps this special motion spontaneous.
        if (now >= this.cuteNodReadyAt && input.random() < 0.06) {
          this.cuteNodReadyAt = now + 15_000 + input.random() * 15_000;
          return this.output(null, null, "cuteNod", this.lastFacing);
        }
        // Sitting micro-gestures are the main thing you actually watch the cat
        // do, so they come often and vary: slow blinks, paw licks, face
        // washing, an ear-scratch, a tail flick, a glance around.
        if (now >= this.idleGestureReadyAt) {
          this.idleGestureReadyAt = now + 2_400 + input.random() * 4_200;
          const r = input.random();
          const gesture: AnimationName =
            r < 0.24 ? "blink"
              : r < 0.44 ? "cleanPaw"
                : r < 0.60 ? "cleanFace"
                  : r < 0.72 ? "tailFlick"
                    : r < 0.82 ? "scratch"
                      : r < 0.90 ? "groom"
                        : r < 0.96 ? "lookAround"
                          : "stretch";
          return this.output(null, null, gesture, this.faceToward(c.dx));
        }
        if (input.random() < 0.02) {
          const hop = this.tryExplore(input);
          if (hop) return hop;
        }
        // Default resting pose: sitting upright facing the user. The side-on
        // idle is deliberately rare — a cat presented in profile all day reads
        // as "walking past" rather than "sitting with you".
        return this.output(null, null, "idle", c.cursorNearby ? this.faceToward(c.dx) : this.lastFacing);
      }
    }
  }

  /**
   * Try to jump onto a nearby platform (window top / another monitor ledge)
   * within jump reach. Returns a jump output, or null if nothing suitable.
   */
  private tryExplore(input: BrainInput): BrainOutput | null {
    const { state, cfg, platforms, support, scale, now } = input;
    if (now < this.exploreReadyAt || !state.isGrounded) return null;
    const target = findJumpTarget(
      { x: state.x, y: state.y },
      support?.id ?? null,
      platforms,
      150 * scale,
      90 * scale,
    );
    if (!target) return null;
    // Skip negligible hops (same level, right next to us).
    if (Math.abs(target.dx) < 10 * scale && Math.abs(target.dy) < 8 * scale) return null;
    this.exploreReadyAt = now + 2600;
    const dir: Facing = target.dx >= 0 ? "right" : "left";
    const vx = Math.max(-cfg.runSpeed, Math.min(cfg.runSpeed, target.dx / 0.55));
    const anim = Math.abs(target.dx) < 30 * scale ? "verticalJump" : Math.abs(target.dx) < 75 * scale ? "smallHop" : "longJump";
    return this.output(null, { vx, anim }, anim, dir);
  }

  /**
   * Walk in `dir`, but respect ledge edges: try to hop to a neighbouring
   * platform when walking off the end, otherwise stop and turn back.
   */
  private driveWalk(
    input: BrainInput,
    dir: number,
    speed: number,
    anim: AnimationName,
  ): BrainOutput {
    const { state, cfg, scale, support, platforms } = input;
    const facing: Facing = dir >= 0 ? "right" : "left";
    const edgeThreshold = 12 * scale;

    if (support) {
      const side = edgeProximity(state.x, support, edgeThreshold);
      const walkingOff = (side === "right" && dir > 0) || (side === "left" && dir < 0);
      if (walkingOff) {
        const jump = findJumpTarget(
          { x: state.x, y: state.y },
          support.id,
          platforms,
          160 * scale,
          120 * scale,
        );
        if (jump && Math.sign(jump.dx) === dir) {
          const vx = dir * Math.min(cfg.runSpeed, Math.abs(jump.dx) / 0.5);
          return this.output(null, { vx, anim: "longJump" }, "longJump", facing);
        }
        // No reachable ledge: stop at the edge and reconsider.
        if (this.behaviour === "wander") this.wanderTargetX = state.x - dir * 40 * scale;
        return this.output(null, null, this.behaviour === "wander" ? "peek" : "balance", facing);
      }
    }
    return this.output(dir * speed, null, anim, facing);
  }

  private faceToward(dx: number): Facing {
    if (!Number.isFinite(dx) || dx === 0) return this.lastFacing;
    return dx >= 0 ? "right" : "left";
  }

  private output(
    targetVx: number | null,
    jump: { vx: number; anim: "jump" | "smallHop" | "verticalJump" | "longJump" | "pounce" } | null,
    animation: AnimationName,
    facing: Facing,
  ): BrainOutput {
    this.lastFacing = facing;
    return { targetVx, jump, animation, facing, behaviour: this.behaviour };
  }
}
