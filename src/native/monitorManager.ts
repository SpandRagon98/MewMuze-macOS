import type { NativeMonitor } from "../types/platform";
import type { Bounds } from "../physics/collision";
import type { OverlayOrigin } from "../physics/platformResolver";

/**
 * Bridge to monitor geometry + overlay window control on the Rust side.
 *
 * The overlay spans the virtual screen (all monitors). For a single monitor
 * with a bottom taskbar, its height stops at the work-area edge so Windows does
 * not mistake the transparent overlay for a fullscreen app. Its origin remains
 * the virtual-screen top-left and engine coordinates stay relative to it.
 */
export async function fetchMonitors(): Promise<NativeMonitor[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const mons = await invoke<NativeMonitor[]>("get_monitors");
    return Array.isArray(mons) ? mons : [];
  } catch {
    return [];
  }
}

/** Virtual-screen origin (physical px) = min of all monitor top-lefts. */
export function computeOverlayOrigin(monitors: NativeMonitor[]): OverlayOrigin {
  if (monitors.length === 0) return { left: 0, top: 0 };
  return {
    left: Math.min(...monitors.map((m) => m.left)),
    top: Math.min(...monitors.map((m) => m.top)),
  };
}

/** Overlay-local bounds of the whole virtual desktop (physical px). */
export function computeVirtualBounds(monitors: NativeMonitor[], origin: OverlayOrigin): Bounds {
  if (monitors.length === 0) {
    // No monitor info: assume a taskbar-sized strip is occupied so the cat is
    // never stranded underneath it.
    return { left: 0, top: 0, right: 1920, bottom: 1080, floorY: 1080 - 48 };
  }
  const right = Math.max(...monitors.map((m) => m.right)) - origin.left;
  const only = monitors.length === 1 ? monitors[0] : null;
  const singleBottomTaskbar =
    only !== null &&
    only.workLeft === only.left &&
    only.workTop === only.top &&
    only.workRight === only.right &&
    only.workBottom > only.top &&
    only.workBottom < only.bottom;
  const bottom =
    (singleBottomTaskbar && only
      ? only.workBottom
      : Math.max(...monitors.map((m) => m.bottom))) - origin.top;
  // Work-area bottom = top of the taskbar. Resting below this hides the cat
  // behind it and makes it unclickable.
  const floorY = Math.max(...monitors.map((m) => m.workBottom)) - origin.top;
  return { left: 0, top: 0, right, bottom, floorY: Math.min(floorY, bottom) };
}

/**
 * Toggle overlay click-through. When `through` is true the whole overlay lets
 * the mouse pass to windows behind it; when false, the overlay receives mouse
 * events (so the cat can be grabbed/petted). Driven by whether the global
 * cursor is over the cat.
 */
export async function setClickThrough(through: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_click_through", { through });
  } catch {
    /* no-op outside Tauri */
  }
}

/** Ask the native layer for the current overlay window origin + size (physical). */
export async function positionOverlayToVirtualScreen(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("position_overlay");
  } catch {
    /* no-op outside Tauri */
  }
}
