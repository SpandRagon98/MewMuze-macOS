//! CatGestureController: paw gestures as a reusable, timed layer.
//!
//! A gesture is a short sequence of the renderer's paw poses (spriteLoader
//! `Gesture`), played over whatever the cat is feeling: a wave alternates two
//! poses, a stomp lifts and drops, a victory sign is raised and held. Events
//! ask for one directly (a finished focus session → victory); emotions use the
//! same poses through their accents. Every pose is a limb path in
//! `frontLimbs`, so costumes sleeve the arm with no per-costume work.
//!
//! The one edgy gesture is behind a setting that is OFF by default, needs an
//! explicit invitation, and is never shown in a serious context. Otherwise it
//! is replaced by a harmless dismissive wave.

import type { Gesture } from "../animation/spriteLoader";

export interface GestureDef {
  label: string;
  /** Poses in order; played once through `beats` over `dur` seconds, the last one held. */
  poses: readonly Gesture[];
  /** Seconds per pose while alternating (a wave), 0 = step once through. */
  beat: number;
  dur: number;
  edgy?: boolean;
}

export const GESTURES = {
  victory: { label: "Victory", poses: ["victory"], beat: 0, dur: 2.2 },
  wave: { label: "Wave", poses: ["waveA", "waveB"], beat: 0.24, dur: 1.4 },
  highFive: { label: "High five", poses: ["highFive"], beat: 0, dur: 1.4 },
  thumbsUp: { label: "Thumbs up", poses: ["thumbsUp"], beat: 0, dur: 1.6 },
  clap: { label: "Clap", poses: ["cheer", "clap"], beat: 0.18, dur: 1.4 },
  cheer: { label: "Cheer", poses: ["cheer"], beat: 0, dur: 1.4 },
  facepalm: { label: "Facepalm", poses: ["facepalm"], beat: 0, dur: 1.6 },
  pawFace: { label: "Paws to face", poses: ["cover"], beat: 0, dur: 1.4 },
  wipeTear: { label: "Wipe a tear", poses: ["wipe"], beat: 0, dur: 1.1 },
  point: { label: "Point", poses: ["point"], beat: 0, dur: 1.4 },
  shrug: { label: "Shrug", poses: ["shrug"], beat: 0, dur: 1.3 },
  dismiss: { label: "Dismissive wave", poses: ["dismiss", "none", "dismiss"], beat: 0.22, dur: 0.9 },
  pawHeart: { label: "Paw heart", poses: ["pawHeart"], beat: 0, dur: 1.8 },
  salute: { label: "Salute", poses: ["salute"], beat: 0, dur: 1.4 },
  thinking: { label: "Paw to chin", poses: ["chin"], beat: 0, dur: 2 },
  stomp: { label: "Annoyed paw", poses: ["stompUp", "stompDown"], beat: 0.22, dur: 1.1 },
  reachLeft: { label: "Reach", poses: ["reachL"], beat: 0, dur: 1.1 },
  reachRight: { label: "Reach", poses: ["reachR"], beat: 0, dur: 1.1 },
  middle: { label: "Rude gesture", poses: ["middle"], beat: 0, dur: 1.4, edgy: true },
} as const satisfies Record<string, GestureDef>;

export type GestureId = keyof typeof GESTURES;

export interface GestureSafety {
  /** The Edgy gestures setting. Off by default. */
  enabled: boolean;
  /** An explicit invitation: the user teased MewMuze, or caused the rage themselves. */
  invited: boolean;
  /** Grief, health, crisis, comfort or a professional persona: never. */
  serious: boolean;
}

/** The edgy pose only when every safeguard agrees; otherwise the harmless stand-in. */
export function safeGesture(g: Gesture, s: GestureSafety): Gesture {
  if (g !== "middle") return g;
  return s.enabled && s.invited && !s.serious ? "middle" : "dismiss";
}

/** Plays one requested gesture at a time, then gets out of the way. */
export class CatGestureController {
  private cur: { id: GestureId; start: number; until: number } | null = null;

  play(id: GestureId, now: number, dur?: number): void {
    this.cur = { id, start: now, until: now + (dur ?? GESTURES[id].dur) };
  }

  stop(): void {
    this.cur = null;
  }

  /** The paw pose right now, or null when no gesture is playing. */
  pose(now: number, safety: GestureSafety): Gesture | null {
    const c = this.cur;
    if (!c) return null;
    if (now >= c.until) {
      this.cur = null;
      return null;
    }
    const def: GestureDef = GESTURES[c.id];
    const t = now - c.start;
    const i = def.beat > 0 ? Math.floor(t / def.beat) % def.poses.length : Math.min(def.poses.length - 1, Math.floor((t / def.dur) * def.poses.length));
    const g = def.poses[i];
    return g === "none" ? null : safeGesture(g, safety);
  }

  get playing(): GestureId | null {
    return this.cur?.id ?? null;
  }

  /** Still going at `now` (pose() may not have been asked since it ended). */
  isPlaying(now: number): boolean {
    return !!this.cur && now < this.cur.until;
  }
}
