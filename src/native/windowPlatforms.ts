import type { NativeWindowRect } from "../types/platform";

/**
 * Bridge to the Rust `enumerate_windows` command, which returns the geometry of
 * visible, non-minimised, non-cloaked top-level windows (physical pixels).
 *
 * Only rectangles are returned by the native layer — never titles or contents.
 * The command already filters out the overlay itself, tool windows, and tiny
 * utility windows.
 */
export async function fetchWindows(): Promise<NativeWindowRect[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rects = await invoke<NativeWindowRect[]>("enumerate_windows");
    return Array.isArray(rects) ? rects : [];
  } catch {
    return [];
  }
}
