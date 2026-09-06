//! The native side of Photo Mode: pickers, saving, copying, revealing, and the
//! one screen capture.
//!
//! Follows Quick Tools' convention of importing the Tauri modules lazily, so
//! nothing here is loaded until Photo Mode is actually opened.

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

/** Native save dialog. Returns the chosen path, or null if cancelled. */
export async function pickPhotoDestination(
  defaultName: string,
  folder: string,
): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      // A remembered folder pre-fills the dialog; without one the OS opens
      // wherever the user last saved something, which is the better default.
      defaultPath: folder ? `${folder}/${defaultName}` : defaultName,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/** Folder picker for the remembered save location. */
export async function pickPhotoFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/** Write the PNG. Resolves to the path written. */
export function savePhoto(bytes: Uint8Array, output: string): Promise<string> {
  return invoke<string>("photo_save", { bytes: Array.from(bytes), output });
}

/** Put the PNG on the clipboard as an image. */
export function copyPhoto(bytes: Uint8Array): Promise<void> {
  return invoke<void>("photo_copy_image", { bytes: Array.from(bytes) });
}

/** Open the containing folder with the photo selected. */
export function revealPhoto(path: string): Promise<void> {
  return invoke<void>("photo_reveal", { path });
}

/**
 * Photograph the screen.
 *
 * Called from exactly one place — the confirmed desktop capture in
 * PhotoModePanel. Nothing else in the app calls it, and it is never called
 * speculatively or on a timer.
 */
export async function captureScreen(): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("photo_capture_screen");
  return new Uint8Array(bytes);
}

/** The folder part of a saved path, for showing "saved to …". */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}
