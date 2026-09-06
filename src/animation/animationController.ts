import type { AnimationName } from "../types/cat";
import { ANIMATIONS, type AnimationDef } from "./animationDefinitions";
import { DEFAULT_POSE, type PoseSpec } from "./spriteLoader";
import { TWEEN_ENABLED, qualityLevel } from "../perf/quality";

// Tweened values snap to this grid: every distinct pose is a sprite-cache
// entry, and an unbounded cache once made the app unresponsive.
const LEG_STEP = 1 / 48;
const BOB_STEP = 1 / 8;
const STRIDE_STEP = 1 / 8;
const PUPIL_STEP = 1 / 4;

function snapTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate a 0..1 cyclic phase. A looping gait wraps from 0.75 back to 0,
 * and a plain lerp would run the legs backwards through the whole cycle to get
 * there, so take the short way round instead.
 */
function lerpPhase(a: number, b: number, t: number, cyclic: boolean): number {
  if (!cyclic) return lerp(a, b, t);
  let delta = b - a;
  if (delta > 0.5) delta -= 1;
  else if (delta < -0.5) delta += 1;
  const v = a + delta * t;
  return v - Math.floor(v);
}

/**
 * Drives frame timing for the current animation: advances frames at each
 * animation's configured fps, loops or plays once, auto-chains into a `next`
 * state when a one-shot completes, and enforces `minDuration` so behaviour
 * logic cannot visually "stutter" the cat by switching states too fast.
 *
 * Pure and deterministic given a fixed `dt` sequence, so it is unit-testable
 * without any canvas/DOM.
 */
export class AnimationController {
  private current: AnimationName;
  private frameIndex = 0;
  private frameTimer = 0;
  private elapsed = 0;
  private finished = false;
  /** Reused by `getPose` so tweening does not allocate every frame. */
  private readonly scratch: PoseSpec = { ...DEFAULT_POSE };

  constructor(initial: AnimationName = "idle") {
    this.current = initial;
  }

  get name(): AnimationName {
    return this.current;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get frame(): number {
    return this.frameIndex;
  }

  private def(): AnimationDef {
    return ANIMATIONS[this.current];
  }

  /**
   * Pose tweened between the current keyframe and the next — without this the
   * cat only changed pose at the animation's own fps (4 for idle) regardless of
   * render rate. Discrete fields (eyes/ears/mouth/body/gesture/prop) still snap:
   * there's no halfway between "open" and "closed" for the art to draw.
   * Returns a REUSED object; read it within the frame, don't retain it.
   */
  getPose(): PoseSpec {
    const def = this.def();
    const frames = def.frames;
    const i = Math.min(this.frameIndex, frames.length - 1);
    const cur = frames[i];
    if (frames.length < 2) return cur;
    // On a slow machine, snapping to keyframes cuts the distinct-pose count
    // (and so the rasterise cost) by roughly the tween-step factor.
    if (!TWEEN_ENABLED[qualityLevel()]) return cur;

    const isLast = i >= frames.length - 1;
    // A finished one-shot holds its final pose; there is nothing to tween into.
    if (isLast && !def.loop) return cur;
    const next = frames[isLast ? 0 : i + 1];

    // frameTimer is the time spent in this frame, and frameDuration is 1/fps,
    // so this is the 0..1 position between the two keyframes.
    const t = Math.min(1, Math.max(0, this.frameTimer * def.fps));

    const s = this.scratch;
    Object.assign(s, cur);
    s.legPhase = snapTo(lerpPhase(cur.legPhase, next.legPhase, t, def.loop), LEG_STEP);
    s.headBob = snapTo(lerp(cur.headBob, next.headBob, t), BOB_STEP);
    s.stride = snapTo(lerp(cur.stride, next.stride, t), STRIDE_STEP);
    // Baked pupil poses (the embarrassed glance, the book-reading scan) tween
    // too, so the eyes drift rather than jumping between positions.
    s.pupilX = snapTo(lerp(cur.pupilX, next.pupilX, t), PUPIL_STEP);
    s.pupilY = snapTo(lerp(cur.pupilY, next.pupilY, t), PUPIL_STEP);
    return s;
  }

  /**
   * True when the current animation has played long enough to be interrupted:
   * either past its `minDuration`, or a finished non-looping one-shot.
   */
  canInterrupt(): boolean {
    const def = this.def();
    const min = def.minDuration ?? 0;
    if (this.elapsed >= min) return true;
    return this.finished && !def.loop;
  }

  /** Force-start an animation, resetting its timers. No-op if already playing it. */
  play(name: AnimationName, force = false): void {
    if (!force && name === this.current) return;
    this.current = name;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.elapsed = 0;
    this.finished = false;
  }

  /**
   * Request a switch that respects the interrupt guard. Returns true if the
   * switch happened. Behaviour code should prefer this over `play`.
   */
  requestPlay(name: AnimationName): boolean {
    if (name === this.current) return false;
    if (!this.canInterrupt()) return false;
    this.play(name, true);
    return true;
  }

  /** Advance timing by `dt` seconds. */
  update(dt: number): void {
    this.elapsed += dt;
    const def = this.def();
    const frameDuration = 1 / def.fps;
    this.frameTimer += dt;

    // Guard against huge dt (e.g. after the machine wakes from sleep).
    let safety = 0;
    while (this.frameTimer >= frameDuration && safety < 240) {
      this.frameTimer -= frameDuration;
      safety++;
      this.frameIndex++;
      if (this.frameIndex >= def.frames.length) {
        if (def.loop) {
          this.frameIndex = 0;
        } else {
          this.frameIndex = def.frames.length - 1;
          this.finished = true;
          break;
        }
      }
    }

    // Auto-chain one-shots into their declared follow-up state.
    if (this.finished && !def.loop && def.next) {
      this.play(def.next, true);
    }
  }
}
