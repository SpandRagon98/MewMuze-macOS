import type { AnimationName } from "../types/cat";

/**
 * Energy model. Energy is a 0..1 scalar that depletes during exertion and
 * recovers while the cat rests. It gates high-intensity behaviours so the cat
 * cannot chase or pounce forever.
 *
 * Values are "per second" rates; positive = drains energy, negative = restores.
 */
const EXERTION_PER_SECOND: Partial<Record<AnimationName, number>> = {
  run: 0.22,
  sprint: 0.34,
  chase: 0.25,
  pounce: 0.35,
  swat: 0.12,
  jump: 0.18,
  smallHop: 0.1,
  verticalJump: 0.2,
  longJump: 0.28,
  climb: 0.15,
  climbUp: 0.18,
  climbDown: 0.1,
  hangTwoPaws: 0.12,
  hangOnePaw: 0.18,
  pullUp: 0.25,
  catch: 0.2,
  walk: 0.05,
  stalk: 0.04,
  approach: 0.05,
  knead: 0.02,
  overheat: 0.08,
  celebrate: 0.1,
  typeKeys: 0.03,
  danceBop: 0.06,
  writeNotes: 0.01,
  // Resting behaviours recover energy.
  sit: -0.08,
  cuteNod: -0.05,
  lieDown: -0.14,
  sleep: -0.22,
  idle: -0.03,
  sideIdle: -0.03,
  backIdle: -0.03,
  groom: -0.02,
  cleanPaw: -0.02,
  cleanFace: -0.02,
};

/** Default drain for anything not listed (neutral). */
const DEFAULT_RATE = 0;

export const ENERGY_LOW = 0.2;
export const ENERGY_HIGH = 0.75;

export function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Advance energy by `dt` seconds given the currently playing animation. */
export function updateEnergy(energy: number, animation: AnimationName, dt: number): number {
  const rate = EXERTION_PER_SECOND[animation] ?? DEFAULT_RATE;
  return clamp01(energy - rate * dt);
}

/** Whether the cat currently has the stamina to start a high-energy activity. */
export function canExert(energy: number): boolean {
  return energy > ENERGY_LOW;
}

/** True once the cat has rested enough to feel lively again. */
export function isWellRested(energy: number): boolean {
  return energy >= ENERGY_HIGH;
}
