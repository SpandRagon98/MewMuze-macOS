/**
 * 2D soft-body MESH for the mochi drag.
 *
 * A grid of spring-damper control points laid over the sprite. One vertex — the
 * scruff — is welded to the cursor; every other vertex springs back toward its
 * rest shape while lagging the cursor by an amount that grows toward the soft
 * extremities. That gives each PART its own delay: the ears (top corners) and
 * the tail/paws (bottom) trail far more than the stiff head, so grabbing the
 * cat and whipping it around makes the body stretch, bend and wobble like soft
 * mochi while the face stays recognisable.
 *
 * The renderer warps the sprite through this grid as a triangle mesh. Because
 * neighbouring triangles SHARE vertices, the silhouette can never tear or gap
 * no matter how hard it is pulled — the failure mode that plagued every earlier
 * slice-based attempt is impossible here by construction.
 *
 * Pure and frame-rate independent (offsets in sprite-size units), so it is
 * unit-testable with no canvas.
 */

export const COLS = 3;
export const ROWS = 7;

/** The welded vertex: column 1 (centre), row 1 — the scruff, just below the head. */
export const GRAB_COL = 1;
export const GRAB_ROW = 1;
export const GRAB_INDEX = GRAB_ROW * COLS + GRAB_COL;

/** Rest position of the grab vertex down the sprite, 0..1 (for the renderer). */
export const GRAB_V = GRAB_ROW / (ROWS - 1);

export interface MeshTuning {
  stiffness: number;
  damping: number;
  /** Max offset a vertex may reach, in sprite-size units. */
  maxOffset: number;
}

export const DEFAULT_MESH_TUNING: MeshTuning = {
  // Soft and bouncy: real mochi/rubber deforms a long way and oscillates a few
  // times before settling. Low damping is the wobble; low stiffness the stretch.
  stiffness: 105,
  damping: 6.2,
  maxOffset: 1.1,
};

export interface MeshVertex {
  /** Offset from rest, sprite-size units. */
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

/**
 * Per-vertex softness: how much a vertex lags the cursor and how floppily it
 * springs. 0 would be rigid; higher trails more. Tuned to anatomy: the face is
 * stiff (recognisable), ears and tail/paws are floppy.
 */
function softnessFor(col: number, row: number): number {
  const v = row / (ROWS - 1);
  const edge = col === 0 || col === COLS - 1; // ear tips / tail sides
  if (row === 0) return edge ? 1.7 : 1.0; // ear tips flop hardest
  if (v < 0.35) return edge ? 1.0 : 0.55; // head + cheeks: stiff, stays a face
  // Torso down to paws/tail: progressively floppier, sides more than centre.
  const base = 0.7 + (v - 0.35) * 1.4;
  return edge ? base * 1.25 : base;
}

function clamp(v: number, limit: number): number {
  return v < -limit ? -limit : v > limit ? limit : v;
}

export class MochiMesh {
  readonly verts: MeshVertex[] = [];
  readonly soft: number[] = [];
  private tuning: MeshTuning;
  private dragging = false;

  constructor(tuning: MeshTuning = DEFAULT_MESH_TUNING) {
    this.tuning = tuning;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        this.verts.push({ ox: 0, oy: 0, vx: 0, vy: 0 });
        this.soft.push(softnessFor(c, r));
      }
    }
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  isAtRest(eps = 0.004): boolean {
    for (const n of this.verts) {
      if (Math.abs(n.ox) > eps || Math.abs(n.oy) > eps) return false;
      if (Math.abs(n.vx) > eps * 60 || Math.abs(n.vy) > eps * 60) return false;
    }
    return true;
  }

  grabStart(): void {
    this.dragging = true;
    const g = this.verts[GRAB_INDEX];
    g.ox = g.oy = g.vx = g.vy = 0;
  }

  /**
   * The cursor moved by (dx,dy) THIS FRAME, in sprite-size units. In the frame
   * that follows the pointer, an inertial body drifts the opposite way; the
   * further a vertex is from the grab (and the softer it is) the more it lags,
   * which is what stretches the body and flops the extremities. Fast moves push
   * harder than slow ones, so a quick flick stretches more than a gentle pull.
   */
  grabMove(dx: number, dy: number): void {
    if (!this.dragging) return;
    const { maxOffset } = this.tuning;
    const mx = clamp(dx, 0.25);
    const my = clamp(dy, 0.3);
    for (let i = 0; i < this.verts.length; i++) {
      if (i === GRAB_INDEX) continue;
      const n = this.verts[i];
      const row = Math.floor(i / COLS);
      const distRows = Math.abs(row - GRAB_ROW) / (ROWS - 1);
      const inertia = (0.25 + 0.9 * Math.pow(distRows, 0.7)) * this.soft[i];
      n.ox = clamp(n.ox - mx * inertia, maxOffset);
      n.oy = clamp(n.oy - my * inertia, maxOffset);
      // Carry momentum so a sharp reversal overshoots and wobbles.
      n.vx -= mx * inertia * 5;
      n.vy -= my * inertia * 6;
    }
    const g = this.verts[GRAB_INDEX];
    g.ox = g.oy = g.vx = g.vy = 0;
    this.constrain();
  }

  /**
   * Keep neighbouring vertices close so the mesh stays a smooth sheet — this is
   * what stops any triangle from folding or over-stretching. The whole body can
   * still travel far; no single edge takes the entire pull.
   */
  private constrain(): void {
    // Symmetric distance constraint (position-based dynamics): when a pair
    // exceeds a limit, pull BOTH ends toward each other by half. No saturated
    // vertex acts as an immovable anchor — the only fixed point is the pinned
    // grab, so its influence relaxes smoothly across the whole sheet instead of
    // the stiff edges dragging the centre back out.
    //
    // The limits are keyed to rest spacing and are ASYMMETRIC in the pull axis:
    // a cell may stretch a long way, but may NOT compress past (nearly) zero —
    // that is what stops a row from crossing its neighbour and folding the mesh
    // inside-out. A rest cell spans REST_V vertically and REST_H horizontally;
    // clamping the compression to a small fraction of that keeps every dest
    // cell positive-area no matter how hard the body is flung.
    const REST_V = 1 / (ROWS - 1); // ≈0.167
    // Vertical neighbours (a = upper row, b = lower row). diff = a.oy - b.oy;
    // dest cell height = REST_V - diff, so diff must stay below REST_V to avoid
    // a fold, and may go strongly negative for a big downward stretch.
    const VY_LO = -REST_V * 2.6; // generous stretch
    const VY_HI = REST_V * 0.6; // fold guard (cell stays >= ~40% of rest)
    const VX = 0.2; // columns stay roughly vertically aligned
    // Horizontal neighbours: rest cell is wide (REST_H = 0.5), so a symmetric
    // limit well under it can never fold laterally.
    const HX = 0.34;
    const HY = 0.16; // rows stay roughly level across a span
    const clampPair = (a: MeshVertex, b: MeshVertex, axis: "x" | "y", lo: number, hi: number) => {
      const av = axis === "x" ? a.ox : a.oy;
      const bv = axis === "x" ? b.ox : b.oy;
      const diff = av - bv;
      let e = 0;
      if (diff > hi) e = (diff - hi) * 0.5;
      else if (diff < lo) e = (diff - lo) * 0.5;
      if (e !== 0) {
        if (axis === "x") { a.ox -= e; b.ox += e; }
        else { a.oy -= e; b.oy += e; }
      }
    };
    const vlink = (i: number, j: number) => {
      const a = this.verts[i], b = this.verts[j];
      clampPair(a, b, "x", -VX, VX);
      clampPair(a, b, "y", VY_LO, VY_HI);
    };
    const hlink = (i: number, j: number) => {
      const a = this.verts[i], b = this.verts[j];
      clampPair(a, b, "x", -HX, HX);
      clampPair(a, b, "y", -HY, HY);
    };
    // Enough passes to propagate the pin all the way to the corners of the
    // 3x7 grid, so the stretch spreads smoothly instead of piling into one
    // over-stretched seam. Grab re-pinned after each pass.
    for (let pass = 0; pass < 8; pass++) {
      for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS; c++) vlink(r * COLS + c, (r + 1) * COLS + c);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS - 1; c++) hlink(r * COLS + c, r * COLS + (c + 1));
      const g = this.verts[GRAB_INDEX];
      g.ox = g.oy = 0;
    }
    this.verts[GRAB_INDEX].ox = this.verts[GRAB_INDEX].oy = 0;
    // Fold prevention is purely vertical and catastrophic if violated, whereas a
    // small horizontal residual is invisible. Finish with a directional
    // projection rooted at the grab row: sweeping OUTWARD from the fixed row and
    // moving only the outer vertex satisfies the cell-height limit exactly in a
    // single pass, so no cell can ever invert no matter how hard the pull.
    for (let c = 0; c < COLS; c++) {
      for (let r = GRAB_ROW; r < ROWS - 1; r++) {
        const a = this.verts[r * COLS + c];
        const b = this.verts[(r + 1) * COLS + c];
        const diff = a.oy - b.oy;
        if (diff > VY_HI) b.oy = a.oy - VY_HI;
        else if (diff < VY_LO) b.oy = a.oy - VY_LO;
      }
      for (let r = GRAB_ROW; r > 0; r--) {
        const a = this.verts[r * COLS + c];
        const b = this.verts[(r - 1) * COLS + c]; // upper (outer) vertex
        const diff = b.oy - a.oy;
        if (diff > VY_HI) b.oy = a.oy + VY_HI;
        else if (diff < VY_LO) b.oy = a.oy + VY_LO;
      }
    }
  }

  /** Let go: kick every vertex outward so it springs past rest and wobbles. */
  release(impulseX = 0, impulseY = 0): void {
    this.dragging = false;
    for (let i = 0; i < this.verts.length; i++) {
      const n = this.verts[i];
      const s = this.soft[i];
      n.vx += -n.ox * 11 * s + impulseX * s * 0.4;
      n.vy += -n.oy * 11 * s + impulseY * s * 0.4;
    }
  }

  /** Advance the springs. `dt` seconds. */
  update(dt: number): void {
    const step = Math.min(dt, 1 / 30);
    const { stiffness, damping, maxOffset } = this.tuning;
    const d = Math.max(0, 1 - damping * step);
    for (let i = 0; i < this.verts.length; i++) {
      if (i === GRAB_INDEX && this.dragging) {
        const g = this.verts[i];
        g.ox = g.oy = g.vx = g.vy = 0;
        continue;
      }
      const n = this.verts[i];
      // Softer vertices spring back more weakly, so they lag and wobble longer.
      const k = stiffness / (0.5 + this.soft[i]);
      n.vx += -n.ox * k * step;
      n.vy += -n.oy * k * step;
      n.vx *= d;
      n.vy *= d;
      n.ox = clamp(n.ox + n.vx * step, maxOffset);
      n.oy = clamp(n.oy + n.vy * step, maxOffset);
    }
    this.constrain();
  }

  /** Offset of a grid vertex, sprite-size units. Read by the renderer. */
  offsetAt(col: number, row: number): { x: number; y: number } {
    const n = this.verts[row * COLS + col];
    return { x: n.ox, y: n.oy };
  }
}
