import { TaskStore, type TaskBridge } from "./taskStore";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Lazy: tests and browser previews have no Tauri runtime (the store then stays read-only).
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** src-tauri/src/tasks.rs: one local file, written atomically. */
export const tauriTaskBridge: TaskBridge = {
  load: () => call("tasks_load"),
  save: (json) => call("tasks_save", { json }),
  quarantine: () => call("tasks_quarantine"),
};

/** The overlay window's one task store. Loaded the first time Tasks opens. */
export const taskStore = new TaskStore(tauriTaskBridge);
