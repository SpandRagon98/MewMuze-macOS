/**
 * Types describing walkable "platforms" (window top edges + monitor floors)
 * and the monitor geometry the cat lives within.
 *
 * All coordinates are in overlay-local logical pixels unless noted.
 */

export type PlatformKind = "window" | "monitorFloor";

/**
 * A horizontal ledge the cat can stand on. Derived from the top edge of a
 * visible application window, or the bottom work-area edge of a monitor.
 */
export interface Platform {
  id: string;
  kind: PlatformKind;
  /** Left x of the walkable span. */
  left: number;
  /** Right x of the walkable span. */
  right: number;
  /** The y the cat's feet rest on. */
  top: number;
  /** Window bottom, when this ledge belongs to a window (used for side climbing). */
  bottom?: number;
}

/** Raw window rectangle as reported by the native layer (physical pixels). */
export interface NativeWindowRect {
  hwnd: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Whether the native layer considered this a "large enough" window. */
  isLarge: boolean;
}

/** Monitor geometry as reported by the native layer (physical pixels). */
export interface NativeMonitor {
  /** Full monitor bounds. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Work area (monitor minus taskbar). */
  workLeft: number;
  workTop: number;
  workRight: number;
  workBottom: number;
  /** DPI scale factor, e.g. 1.0, 1.25, 1.5, 2.0. */
  scale: number;
  isPrimary: boolean;
}
