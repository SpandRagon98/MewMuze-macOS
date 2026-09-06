// Where to put the Quick Tools panel: never on top of the cat, since the cat
// keeps animating while it's open and getting covered reads as it vanishing.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Work area (monitor minus taskbar). */
export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PlacementSide = "right" | "left" | "above" | "below";

export interface Placement {
  x: number;
  y: number;
  side: PlacementSide;
  /** No side had room; panel was clamped into the work area and may overlap. */
  clamped: boolean;
}

export const PANEL_GAP = 12;

// Horizontal first: the panel is wider than tall, so side-by-side keeps it
// beside the cat instead of pushing it toward the top of the screen.
const SIDE_ORDER: PlacementSide[] = ["right", "left", "above", "below"];

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : Math.max(lo, Math.min(hi, v)); // hi < lo: span smaller than panel, anchor to lo
}

function freeSpace(cat: Box, area: Area, side: PlacementSide): number {
  switch (side) {
    case "right":
      return area.right - (cat.x + cat.width) - PANEL_GAP;
    case "left":
      return cat.x - area.left - PANEL_GAP;
    case "above":
      return cat.y - area.top - PANEL_GAP;
    case "below":
      return area.bottom - (cat.y + cat.height) - PANEL_GAP;
  }
}

function fits(cat: Box, panel: { width: number; height: number }, area: Area, side: PlacementSide): boolean {
  const need = side === "right" || side === "left" ? panel.width : panel.height;
  return freeSpace(cat, area, side) >= need;
}

function positionOn(
  cat: Box,
  panel: { width: number; height: number },
  area: Area,
  side: PlacementSide,
): { x: number; y: number } {
  const catCx = cat.x + cat.width / 2;
  const catCy = cat.y + cat.height / 2;

  if (side === "right" || side === "left") {
    const x = side === "right" ? cat.x + cat.width + PANEL_GAP : cat.x - PANEL_GAP - panel.width;
    // x already clears the cat, so clamping the cross axis can't re-cover it.
    const y = clamp(catCy - panel.height / 2, area.top, area.bottom - panel.height);
    return { x, y };
  }
  const y = side === "above" ? cat.y - PANEL_GAP - panel.height : cat.y + cat.height + PANEL_GAP;
  const x = clamp(catCx - panel.width / 2, area.left, area.right - panel.width);
  return { x, y };
}

export function placePanel(opts: {
  cat: Box;
  panel: { width: number; height: number };
  area: Area;
}): Placement {
  const { cat, panel, area } = opts;

  for (const side of SIDE_ORDER) {
    if (fits(cat, panel, area, side)) {
      const { x, y } = positionOn(cat, panel, area, side);
      return { x, y, side, clamped: false };
    }
  }

  // Cat is boxed in on every side: use whichever has the most room and clamp.
  let best: PlacementSide = SIDE_ORDER[0];
  let bestSpace = -Infinity;
  for (const side of SIDE_ORDER) {
    const space = freeSpace(cat, area, side);
    if (space > bestSpace) {
      bestSpace = space;
      best = side;
    }
  }
  const { x, y } = positionOn(cat, panel, area, best);
  return {
    x: clamp(x, area.left, area.right - panel.width),
    y: clamp(y, area.top, area.bottom - panel.height),
    side: best,
    clamped: true,
  };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
