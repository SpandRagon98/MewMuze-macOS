import type { NativeClipboardEvent } from "./clipboardTypes";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return (core.invoke as Invoke)<T>(command, args);
}

export async function listenForClipboardText(
  onEvent: (event: NativeClipboardEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NativeClipboardEvent>("clipboard-text", (event) => onEvent(event.payload));
}

export async function readClipboardText(): Promise<string | null> {
  return invoke<string | null>("clipboard_read_text");
}

export async function writeClipboardText(text: string): Promise<void> {
  await invoke<void>("clipboard_write_text", { text });
}

export async function clearClipboard(): Promise<void> {
  await invoke<void>("clipboard_clear");
}

export async function isWindowsSessionLocked(): Promise<boolean> {
  return invoke<boolean>("is_session_locked");
}

export async function openClipboardLink(url: string): Promise<void> {
  await invoke<void>("open_clipboard_link", { link: url });
}
