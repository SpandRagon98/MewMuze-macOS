//! The butterfly: a small visitor for MewMuze to watch.
//!
//! A visit is a path (flutter past, over, under, zig-zag, or come right up to
//! the face and dart off) plus the cat's side of it: freeze and notice, the
//! eyes snap to it and the head follows a beat later (CatEngine.setAttention),
//! a paw reaches when it comes close, and a little disappointment when it gets
//! away. Pure: positions in the engine's world px, no timers of its own - the
//! App frame loop drives it only while a visit is on, so there is no cost
//! between visits.

import type { EmotionRequest } from "./emotionEngine";
import type { GestureId } from "./gestures";

export const BUTTERFLY_PATHS = ["leftToRight", "rightToLeft", "above", "below", "zigzag", "closeToFace"] as const;
export type ButterflyPath = (typeof BUTTERFLY_PATHS)[number];

/** What the renderer draws this frame. */
export interface ButterflyFrame {
  x: number;
  y: number;
  /** Wing beat: 0 open, 1 half, 2 edge-on. */
  wing: 0 | 1 | 2;
  /** Pixel size of one art pixel. */
  scale: number;
}

/** The slice of CatEngine a visit talks to. */
export interface ButterflyCat {
  feel(r: EmotionRequest): boolean;
  gesture(id: GestureId): void;
  setAttention(p: { x: number; y: number } | null): void;
}

/** Where the cat is: its feet and size, as RenderInfo has them. */
export interface CatSpot {
  x: number;
  y: number;
  sizePx: number;
}

/** Waypoints relative to the cat's head, in cat sizes; `t` is the fraction of the visit. */
type Way = { t: number; x: number; y: number };
const PATHS: Record<ButterflyPath, { seconds: number; ways: Way[] }> = {
  leftToRight: { seconds: 9, ways: [{ t: 0, x: -6, y: -1.4 }, { t: 0.35, x: -1.6, y: -1.1 }, { t: 0.55, x: 0.2, y: -1.5 }, { t: 0.75, x: 1.8, y: -1.0 }, { t: 1, x: 6.5, y: -1.8 }] },
  rightToLeft: { seconds: 9, ways: [{ t: 0, x: 6, y: -1.2 }, { t: 0.35, x: 1.6, y: -1.4 }, { t: 0.55, x: -0.2, y: -1.0 }, { t: 0.75, x: -1.8, y: -1.5 }, { t: 1, x: -6.5, y: -1.6 }] },
  above: { seconds: 8, ways: [{ t: 0, x: -4.5, y: -3.4 }, { t: 0.4, x: -0.8, y: -2.2 }, { t: 0.6, x: 0.6, y: -2.0 }, { t: 1, x: 4.5, y: -3.8 }] },
  below: { seconds: 8, ways: [{ t: 0, x: 5, y: 0.2 }, { t: 0.4, x: 1.3, y: 0.05 }, { t: 0.6, x: -1.2, y: 0.15 }, { t: 1, x: -5.5, y: -0.6 }] },
  zigzag: { seconds: 10, ways: [{ t: 0, x: -6, y: -1.0 }, { t: 0.2, x: -3, y: -2.4 }, { t: 0.4, x: -1, y: -0.8 }, { t: 0.6, x: 1, y: -2.2 }, { t: 0.8, x: 3, y: -0.9 }, { t: 1, x: 6, y: -2.6 }] },
  // Up beside the cheek at eye level, hangs there a moment, then darts off before the paw lands.
  closeToFace: { seconds: 9, ways: [{ t: 0, x: -5, y: -2.2 }, { t: 0.3, x: -1.5, y: -0.7 }, { t: 0.42, x: -0.55, y: -0.08 }, { t: 0.62, x: -0.48, y: -0.14 }, { t: 0.72, x: 0.7, y: -1.2 }, { t: 1, x: 4.5, y: -4.5 }] },
};

/** The head is this far up the cat (fraction of its size). */
const HEAD_UP = 0.62;
/** Closer than this (in cat sizes) is close enough to reach for. */
const REACH = 1.0;
/** The cat notices it inside this range. */
const NOTICE = 5;

/** Catmull-Rom through the waypoints, so the flight curves instead of kinking. */
function along(ways: Way[], u: number): { x: number; y: number } {
  let i = 0;
  while (i < ways.length - 2 && u > ways[i + 1].t) i++;
  const a = ways[Math.max(0, i - 1)], b = ways[i], c = ways[i + 1], d = ways[Math.min(ways.length - 1, i + 2)];
  const s = Math.max(0, Math.min(1, (u - b.t) / Math.max(1e-6, c.t - b.t)));
  const cr = (p0: number, p1: number, p2: number, p3: number) =>
    0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
  return { x: cr(a.x, b.x, c.x, d.x), y: cr(a.y, b.y, c.y, d.y) };
}

export class ButterflyVisit {
  private t = 0;
  private readonly seconds: number;
  private readonly ways: Way[];
  /** Head position at the start: the flight is laid out around it. */
  private readonly ox: number;
  private readonly oy: number;
  private readonly size: number;
  private noticedAt = -1;
  private interested = false;
  private reachedAt = -1;
  private readonly wobble: number;
  private done = false;
  frame: ButterflyFrame | null = null;

  constructor(readonly path: ButterflyPath, cat: CatSpot, seed = Math.random()) {
    const p = PATHS[path];
    this.seconds = p.seconds;
    this.ways = p.ways;
    this.size = cat.sizePx;
    this.ox = cat.x;
    this.oy = cat.y - cat.sizePx * HEAD_UP;
    this.wobble = seed * Math.PI * 2;
  }

  get finished(): boolean {
    return this.done;
  }

  /** Advance the flight and the cat's reaction. Returns false once the visit is over. */
  update(dt: number, cat: CatSpot, api: ButterflyCat): boolean {
    if (this.done) return false;
    this.t += dt;
    const u = this.t / this.seconds;
    if (u >= 1) return this.end(api, true);
    const p = along(this.ways, u);
    // Flutter: a butterfly never flies a clean line.
    const fl = Math.sin(this.t * 7.3 + this.wobble) * 0.16 + Math.sin(this.t * 3.1) * 0.08;
    const x = this.ox + p.x * this.size;
    const y = this.oy + (p.y + fl) * this.size;
    const beat = Math.floor(this.t * 11) % 4;
    this.frame = { x, y, wing: beat === 0 ? 0 : beat === 2 ? 2 : 1, scale: Math.max(2, Math.round(cat.sizePx / 44)) };

    // ---- the cat's side ----
    const headX = cat.x;
    const headY = cat.y - cat.sizePx * HEAD_UP;
    const dist = Math.hypot(x - headX, y - headY) / cat.sizePx;
    if (this.noticedAt < 0 && dist < NOTICE) {
      // Freeze: a startle first, then it becomes the most interesting thing in the world.
      this.noticedAt = this.t;
      api.feel({ emotion: "surprised", intensity: 0.55, source: "event", duration: 0.5 });
    }
    if (this.noticedAt >= 0) {
      api.setAttention({ x, y });
      if (!this.interested && this.t - this.noticedAt > 0.45) {
        this.interested = true;
        api.feel({ emotion: "curious", intensity: 0.8, source: "event", duration: this.seconds });
      }
    }
    if (this.reachedAt < 0 && dist < REACH) {
      this.reachedAt = this.t;
      api.feel({ emotion: "curious", intensity: 0.95, source: "event", duration: this.seconds });
      api.gesture(x < headX ? "reachLeft" : "reachRight");
    }
    // Out of reach again after coming close: it got away.
    if (this.reachedAt >= 0 && dist > NOTICE * 0.8) return this.end(api, false);
    return true;
  }

  /** Stop now (drag, Photo Mode, full screen): no reaction, nothing left behind. */
  cancel(api: ButterflyCat): void {
    if (this.done) return;
    this.done = true;
    this.frame = null;
    api.setAttention(null);
  }

  private end(api: ButterflyCat, flewPast: boolean): false {
    this.done = true;
    this.frame = null;
    api.setAttention(null);
    // Close enough to touch and it still got away: a small, confused letdown.
    if (this.reachedAt >= 0 || !flewPast) api.feel({ emotion: "confused", intensity: 0.5, source: "event", duration: 2.5 });
    return false;
  }
}

/** Next visit, 20-45 minutes out. */
export function nextVisitMs(now: number, rand: () => number = Math.random): number {
  return now + (20 + rand() * 25) * 60_000;
}

/** A path for this visit; close-to-face is the special one, so it is a bit rarer. */
export function pickPath(rand: () => number = Math.random): ButterflyPath {
  const r = rand();
  if (r < 0.14) return "closeToFace";
  const rest = BUTTERFLY_PATHS.filter((p) => p !== "closeToFace");
  return rest[Math.min(rest.length - 1, Math.floor(((r - 0.14) / 0.86) * rest.length))];
}
