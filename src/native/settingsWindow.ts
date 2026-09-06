import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function setSettingsWindowMode(active: boolean): Promise<void> {
  try {
    await invoke("set_settings_window_mode", { active });
  } catch {
    // Browser previews and component tests do not have a native Tauri window.
  }
}

export async function minimizeSettingsWindow(): Promise<void> {
  try {
    await invoke("minimize_settings_window");
  } catch {
    // Browser previews and component tests do not have a native Tauri window.
  }
}

export async function watchSettingsWindowFocus(
  onChanged: (focused: boolean) => void,
): Promise<() => void> {
  try {
    return await getCurrentWindow().onFocusChanged(({ payload }) => onChanged(payload));
  } catch {
    return () => {};
  }
}
