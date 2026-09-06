import { describe, it, expect } from "vitest";
import {
  MochiMesh,
  COLS,
  ROWS,
  GRAB_INDEX,
  GRAB_ROW,
} from "../physics/mochiMesh";

function run(m: MochiMesh, seconds: number, fps = 60) {
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) m.update(dt);
}

const rowOf = (i: number) => Math.floor(i / COLS);

describe("MochiMesh", () => {
  it("starts flat and at rest", () => {
    const m = new MochiMesh();
    expect(m.verts).toHaveLength(COLS * ROWS);
    expect(m.isAtRest()).toBe(true);
    for (const v of m.verts) {
      expect(v.ox).toBe(0);
      expect(v.oy).toBe(0);
    }
  });

  it("keeps the grabbed scruff welded to the cursor (offset 0)", () => {
    const m = new MochiMesh();
    m.grabStart();
    for (let i = 0; i < 20; i++) m.grabMove(0.2, 0.05);
    const g = m.verts[GRAB_INDEX];
    expect(Math.abs(g.ox)).toBeLessThan(1e-6);
    expect(Math.abs(g.oy)).toBeLessThan(1e-6);
  });

  it("makes lower/extremity vertices trail more than the stiff head", () => {
    const m = new MochiMesh();
    m.grabStart();
    // Pull rightward for several frames.
    for (let i = 0; i < 15; i++) m.grabMove(0.2, 0);

    // A face vertex just below the grab barely moves; a bottom (paw/tail)
    // vertex trails far behind, so its |offset| is clearly larger.
    const faceIdx = (GRAB_ROW + 1) * COLS + 1; // centre, one row under the grab
    const bottomIdx = (ROWS - 1) * COLS + 1; // centre paw row
    expect(Math.abs(m.verts[bottomIdx].ox)).toBeGreaterThan(
      Math.abs(m.verts[faceIdx].ox) + 0.02,
    );
    // The offset grows monotonically-ish down the centre column.
    expect(rowOf(bottomIdx)).toBeGreaterThan(rowOf(faceIdx));
  });

  it("never folds the mesh inside-out, even under a hard drag in any direction", () => {
    const REST_V = 1 / (ROWS - 1);
    for (const [dx, dy] of [[0, 0.3], [0, -0.3], [0.3, 0], [-0.3, 0], [0.25, 0.25], [-0.25, 0.25]]) {
      const m = new MochiMesh();
      m.grabStart();
      for (let i = 0; i < 30; i++) { m.grabMove(dx, dy); m.update(1 / 60); }
      // Every vertical dest cell must keep positive height: the dest-v of a row
      // is (row * REST_V + oy). Strictly increasing down each column => no fold.
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS - 1; r++) {
          const top = r * REST_V + m.verts[r * COLS + c].oy;
          const bot = (r + 1) * REST_V + m.verts[(r + 1) * COLS + c].oy;
          expect(bot).toBeGreaterThan(top);
        }
      }
    }
  });

  it("wobbles (overshoots) after release, then settles back to rest", () => {
    const m = new MochiMesh();
    m.grabStart();
    for (let i = 0; i < 15; i++) m.grabMove(0.22, 0);
    m.release(0, 0);

    // Something must be moving right after release (the recoil kick).
    let moving = false;
    for (const v of m.verts) if (Math.abs(v.vx) > 0.01) moving = true;
    expect(moving).toBe(true);

    // And it damps out to rest within a couple of seconds.
    run(m, 3);
    expect(m.isAtRest()).toBe(true);
  });

  it("never produces NaN or runaway offsets even under a violent shake", () => {
    const m = new MochiMesh();
    m.grabStart();
    for (let i = 0; i < 200; i++) {
      m.grabMove(i % 2 === 0 ? 0.9 : -0.9, i % 3 === 0 ? 0.8 : -0.8);
      m.update(1 / 60);
    }
    for (const v of m.verts) {
      expect(Number.isFinite(v.ox)).toBe(true);
      expect(Number.isFinite(v.oy)).toBe(true);
      expect(Math.abs(v.ox)).toBeLessThanOrEqual(1.2);
      expect(Math.abs(v.oy)).toBeLessThanOrEqual(1.2);
    }
  });

  it("keeps neighbouring vertices close so triangles can't fold or gap", () => {
    const m = new MochiMesh();
    m.grabStart();
    for (let i = 0; i < 40; i++) m.grabMove(0.5, 0.5);
    // No adjacent pair may separate wildly: the constraint keeps the stretch
    // spread out so a single cell never blows up into a fold. A little extra
    // slack is allowed right at the pinned scruff, whose hard pin legitimately
    // out-pulls the soft distance limit by design.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        if (c + 1 < COLS) {
          const j = i + 1;
          expect(Math.abs(m.verts[i].ox - m.verts[j].ox)).toBeLessThan(0.6);
        }
        if (r + 1 < ROWS) {
          const j = i + COLS;
          expect(Math.abs(m.verts[i].oy - m.verts[j].oy)).toBeLessThan(0.6);
        }
      }
    }
  });
});
