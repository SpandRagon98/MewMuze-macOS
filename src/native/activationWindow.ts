import { invoke } from "@tauri-apps/api/core";

/**
 * Temporarily give the borderless desktop overlay a taskbar entry while the
 * blocking activation gate is visible. The native side restores MewMuze's
 * normal taskbar-free companion mode as soon as the gate unmounts.
 */
export async function setActivationWindowMode(active: boolean): Promise<void> {
  try {
    await invoke("set_activation_window_mode", { active });
  } catch {
    // Browser tests and preview builds do not have a Tauri window.
  }
}

/** Keep the activation screen alive and restorable while the customer checks email. */
export async function minimizeActivationWindow(): Promise<void> {
  try {
    await invoke("minimize_activation_window");
  } catch {
    // Browser tests and preview builds do not have a Tauri window.
  }
}
