import { describe, it, expect } from "vitest";
import { placePanel, overlaps, PANEL_GAP, type Area, type Box } from "../quicktools/panelPlacement";
import {
  clipboardPanelSizeFor,
  clipboardSafeArea,
} from "../clipboard-assistant/ClipboardPanel";

/** A 1080p work area with a taskbar along the bottom. */
const AREA: Area = { left: 0, top: 0, right: 1920, bottom: 1032 };
const PANEL = { width: 300, height: 260 };

const catAt = (x: number, y: number, size = 88): Box => ({ x, y, width: size, height: size });

describe("placePanel", () => {
  it("puts the panel to the right of a cat with room on both sides", () => {
    const cat = catAt(900, 500);
    const p = placePanel({ cat, panel: PANEL, area: AREA });
    expect(p.side).toBe("right");
    expect(p.clamped).toBe(false);
    expect(p.x).toBe(cat.x + cat.width + PANEL_GAP);
  });

  it("flips to the left when the right edge is too close", () => {
    const cat = catAt(1800, 500);
    const p = placePanel({ cat, panel: PANEL, area: AREA });
    expect(p.side).toBe("left");
    expect(p.x + PANEL.width).toBe(cat.x - PANEL_GAP);
  });

  it("goes above when neither side has horizontal room", () => {
    // A narrow work area: the cat sits mid-width with < 300px either side.
    const narrow: Area = { left: 0, top: 0, right: 640, bottom: 1032 };
    const cat = catAt(280, 700);
    const p = placePanel({ cat, panel: PANEL, area: narrow });
    expect(p.side).toBe("above");
    expect(p.y + PANEL.height).toBe(cat.y - PANEL_GAP);
  });

  it("falls to below when there is no room above either", () => {
    const narrow: Area = { left: 0, top: 0, right: 640, bottom: 1032 };
    const cat = catAt(280, 40); // near the top, so "above" cannot fit
    const p = placePanel({ cat, panel: PANEL, area: narrow });
    expect(p.side).toBe("below");
    expect(p.y).toBe(cat.y + cat.height + PANEL_GAP);
  });

  it("never covers the cat, wherever the cat is", () => {
    // The whole point of the feature: the cat stays visible while you use it.
    for (let x = 0; x <= AREA.right - 88; x += 37) {
      for (let y = 0; y <= AREA.bottom - 88; y += 41) {
        const cat = catAt(x, y);
        const p = placePanel({ cat, panel: PANEL, area: AREA });
        const box: Box = { x: p.x, y: p.y, width: PANEL.width, height: PANEL.height };
        expect(overlaps(box, cat), `overlap at cat ${x},${y} (side ${p.side})`).toBe(false);
        expect(p.clamped).toBe(false);
      }
    }
  });

  it("keeps the panel inside the work area", () => {
    for (let x = 0; x <= AREA.right - 88; x += 53) {
      for (let y = 0; y <= AREA.bottom - 88; y += 47) {
        const p = placePanel({ cat: catAt(x, y), panel: PANEL, area: AREA });
        expect(p.x).toBeGreaterThanOrEqual(AREA.left);
        expect(p.y).toBeGreaterThanOrEqual(AREA.top);
        expect(p.x + PANEL.width).toBeLessThanOrEqual(AREA.right);
        expect(p.y + PANEL.height).toBeLessThanOrEqual(AREA.bottom);
      }
    }
  });

  it("respects the taskbar: never places the panel below the work area", () => {
    // Cat parked on the taskbar floor — the spot it now rests in by default.
    const cat = catAt(960, AREA.bottom - 88);
    const p = placePanel({ cat, panel: PANEL, area: AREA });
    expect(p.y + PANEL.height).toBeLessThanOrEqual(AREA.bottom);
  });

  it("reports clamped when the cat is boxed in on every side", () => {
    // A work area barely bigger than the cat: no side can hold the panel.
    const tiny: Area = { left: 0, top: 0, right: 320, bottom: 300 };
    const p = placePanel({ cat: catAt(120, 110), panel: PANEL, area: tiny });
    expect(p.clamped).toBe(true);
    // Still dragged back inside the work area rather than left off-screen.
    expect(p.x).toBeGreaterThanOrEqual(tiny.left);
    expect(p.y).toBeGreaterThanOrEqual(tiny.top);
  });

  it("handles a work area that does not start at the origin (second monitor)", () => {
    const right: Area = { left: 1920, top: 0, right: 3840, bottom: 1032 };
    const cat = catAt(3700, 500);
    const p = placePanel({ cat, panel: PANEL, area: right });
    expect(p.side).toBe("left");
    expect(p.x).toBeGreaterThanOrEqual(right.left);
    expect(p.x + PANEL.width).toBeLessThanOrEqual(right.right);
  });

  it("keeps the responsive clipboard panel usable at every required DPI", () => {
    for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
      const area: Area = {
        left: 0,
        top: 0,
        right: 1366 / scale,
        bottom: (768 - 48) / scale,
      };
      const cat = catAt((area.right - 88 / scale) / 2, (area.bottom - 88 / scale) / 2, 88 / scale);
      const panel = clipboardPanelSizeFor(cat, area);
      const safe = clipboardSafeArea(area);
      const placement = placePanel({ cat, panel: { width: panel.width, height: panel.maxHeight }, area: safe });
      expect(placement.x).toBeGreaterThanOrEqual(safe.left);
      expect(placement.y).toBeGreaterThanOrEqual(safe.top);
      expect(placement.x + panel.width).toBeLessThanOrEqual(safe.right);
      expect(placement.y + panel.maxHeight).toBeLessThanOrEqual(safe.bottom);
      expect(overlaps({ x: placement.x, y: placement.y, width: panel.width, height: panel.maxHeight }, cat)).toBe(false);
    }
  });

  it("fits all required desktop resolutions and each cat corner", () => {
    for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
      const area: Area = { left: 0, top: 0, right: width, bottom: height - 48 };
      const cats = [
        catAt(0, 0),
        catAt(width - 88, 0),
        catAt(0, area.bottom - 88),
        catAt(width - 88, area.bottom - 88),
      ];
      for (const cat of cats) {
        const panel = clipboardPanelSizeFor(cat, area);
        const safe = clipboardSafeArea(area);
        const placement = placePanel({ cat, panel: { width: panel.width, height: panel.maxHeight }, area: safe });
        expect(placement.x).toBeGreaterThanOrEqual(safe.left);
        expect(placement.y).toBeGreaterThanOrEqual(safe.top);
        expect(placement.x + panel.width).toBeLessThanOrEqual(safe.right);
        expect(placement.y + panel.maxHeight).toBeLessThanOrEqual(safe.bottom);
        expect(overlaps({ x: placement.x, y: placement.y, width: panel.width, height: panel.maxHeight }, cat)).toBe(false);
      }
    }
  });
});
