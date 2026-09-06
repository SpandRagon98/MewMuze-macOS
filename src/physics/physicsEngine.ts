import type { CatState } from "../types/cat";

/**
 * Lightweight 2D physics. Coordinates are overlay-local PHYSICAL pixels; the
 * cat's (x, y) is its feet anchor (horizontal centre, bottom of the sprite).
 *
 * The feel is deliberately playful rather than realistic: smooth acceleration,
 * a squash on landing (handled by the renderer), capped fall speed, and gentle
 * damping. Speeds/accelerations scale with the current monitor's DPI so motion
 * feels consistent across display scaling.
 */
export interface PhysicsConfig {
  gravity: number; // px/s^2
  walkSpeed: number; // px/s
  runSpeed: number; // px/s
  accel: number; // horizontal accel toward target vx, px/s^2
  groundFriction: number; // per-second damping when no input on ground
  airDrag: number; // per-second horizontal damping in air
  jumpVelocity: number; // px/s (negative = up)
  maxFallSpeed: number; // px/s
}

const BASE_CONFIG: PhysicsConfig = {
  gravity: 1400,
  walkSpeed: 52,
  runSpeed: 150,
  accel: 1100,
  groundFriction: 12,
  airDrag: 1.5,
  jumpVelocity: -540,
  maxFallSpeed: 1600,
};

/** Scale movement constants by DPI so the cat moves at a consistent visual pace. */
export function makeConfig(scale: number): PhysicsConfig {
  const s = Math.max(0.75, Math.min(3, scale));
  return {
    gravity: BASE_CONFIG.gravity * s,
    walkSpeed: BASE_CONFIG.walkSpeed * s,
    runSpeed: BASE_CONFIG.runSpeed * s,
    accel: BASE_CONFIG.accel * s,
    groundFriction: BASE_CONFIG.groundFriction,
    airDrag: BASE_CONFIG.airDrag,
    jumpVelocity: BASE_CONFIG.jumpVelocity * s,
    maxFallSpeed: BASE_CONFIG.maxFallSpeed * s,
  };
}

/** Move horizontal velocity toward a target at `accel`, clamped by `dt`. */
export function approach(current: number, target: number, accel: number, dt: number): number {
  const diff = target - current;
  const step = accel * dt;
  if (Math.abs(diff) <= step) return target;
  return current + Math.sign(diff) * step;
}

/**
 * Integrate one physics step. Applies horizontal steering toward `targetVx`
 * (or friction/drag if `targetVx` is null), gravity when airborne, and updates
 * position. Collision/landing is resolved separately.
 *
 * Mutates and returns `state` for the hot path.
 */
export function integrate(
  state: CatState,
  cfg: PhysicsConfig,
  dt: number,
  targetVx: number | null,
): CatState {
  if (state.isDragging) return state; // position is driven by the cursor

  // Horizontal
  if (targetVx !== null) {
    state.velocityX = approach(state.velocityX, targetVx, cfg.accel, dt);
  } else if (state.isGrounded) {
    // Exponential friction toward rest.
    state.velocityX *= Math.max(0, 1 - cfg.groundFriction * dt);
    if (Math.abs(state.velocityX) < 1) state.velocityX = 0;
  } else {
    state.velocityX *= Math.max(0, 1 - cfg.airDrag * dt);
  }

  // Vertical
  if (!state.isGrounded) {
    state.velocityY += cfg.gravity * dt;
    if (state.velocityY > cfg.maxFallSpeed) state.velocityY = cfg.maxFallSpeed;
  }

  state.x += state.velocityX * dt;
  state.y += state.velocityY * dt;
  return state;
}

/** Give the cat an upward impulse (used for jumps/pounces). */
export function applyJump(state: CatState, cfg: PhysicsConfig, horizontal = 0): void {
  state.velocityY = cfg.jumpVelocity;
  state.velocityX = horizontal;
  state.isGrounded = false;
}
