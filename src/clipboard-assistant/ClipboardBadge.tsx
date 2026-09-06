import { PANEL_GAP, placePanel, type Area, type Box } from "../quicktools/panelPlacement";

export const CLIPBOARD_BADGE_SIZE = { width: 22, height: 22 };
export const CLIPBOARD_BADGE_GAP = 4;

export function ClipboardBadge({
  cat,
  area,
  onOpen,
}: {
  cat: Box;
  area: Area;
  onOpen: () => void;
}) {
  const placement = placePanel({ cat, panel: CLIPBOARD_BADGE_SIZE, area });
  const pullTowardCat = PANEL_GAP - CLIPBOARD_BADGE_GAP;
  const pulled =
    placement.side === "right"
      ? { x: placement.x - pullTowardCat, y: placement.y }
      : placement.side === "left"
        ? { x: placement.x + pullTowardCat, y: placement.y }
        : placement.side === "above"
          ? { x: placement.x, y: placement.y + pullTowardCat }
          : { x: placement.x, y: placement.y - pullTowardCat };
  const position = {
    x: Math.max(area.left, Math.min(area.right - CLIPBOARD_BADGE_SIZE.width, pulled.x)),
    y: Math.max(area.top, Math.min(area.bottom - CLIPBOARD_BADGE_SIZE.height, pulled.y)),
  };
  return (
    <button
      type="button"
      className="clipboard-badge pixel-ui"
      style={{ left: position.x, top: position.y }}
      data-side={placement.side}
      title="Open Clipboard Assistant"
      aria-label="Open Clipboard Assistant"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onOpen}
    >
      <span aria-hidden="true">▤</span>
    </button>
  );
}
