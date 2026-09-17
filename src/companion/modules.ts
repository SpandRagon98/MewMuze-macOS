//! Companion Modules - optional, independently installable local AI.
//!
//! Two modules, neither required by the other: Local Voice (Whisper) and
//! Local Chat (Qwen). Downloads happen only on an explicit Download press,
//! over HTTPS, pinned by size and SHA-256 (see src-tauri/src/modules.rs), into
//! the OS local app-data folder - never into the installer or the app folder.
//!
//! Voice Chat is not a module - it is what you get when BOTH are installed.

export type ModuleId = "voice" | "chat" | "chat-lite";

export type ModuleState =
  | "not-installed"
  | "downloading"
  | "paused"
  | "verifying"
  | "installing"
  | "installed"
  | "update-available"
  | "error";

export type ModuleAction = "download" | "pause" | "resume" | "cancel" | "retry" | "remove" | "update";

export interface ModuleSpec {
  id: ModuleId;
  name: string;
  tagline: string;
  engine: string;
  model: string;
  license: string;
  /** Exact bytes downloaded (runtime archive + model), from the pinned catalog. */
  downloadBytes: number;
  privacy: string;
  /** Sub-folder of the app-data "models" directory. */
  folder: "whisper" | "companion" | "companion-lite";
}

export const MODULES: readonly ModuleSpec[] = [
  {
    id: "voice",
    name: "Local Voice",
    tagline: "Talk instead of typing.",
    engine: "whisper.cpp b4938",
    model: "Whisper base, multilingual (ggml q8_0)",
    license: "MIT (model and runtime)",
    downloadBytes: 8_361_840 + 81_768_585,
    privacy: "Audio stays on this computer. Nothing is uploaded, and recordings are deleted after transcription unless you save them.",
    folder: "whisper",
  },
  {
    id: "chat",
    name: "Local Chat",
    tagline: "Private conversations with MewMuze.",
    engine: "llama.cpp b10894",
    model: "Qwen3-1.7B (Q4_K_M)",
    license: "Apache-2.0 (model) · MIT (runtime)",
    downloadBytes: 18_423_620 + 1_282_439_264,
    privacy: "Conversations stay on this computer. Nothing is uploaded; only preferences you allow are remembered.",
    folder: "companion",
  },
  {
    id: "chat-lite",
    name: "Local Chat Lite",
    tagline: "For PCs with 4–6 GB of memory.",
    engine: "llama.cpp b10894",
    model: "Qwen3-0.6B (Q4_0)",
    license: "Apache-2.0 (model) · MIT (runtime)",
    downloadBytes: 18_423_620 + 428_970_080,
    privacy: "Conversations stay on this computer. Nothing is uploaded; only preferences you allow are remembered.",
    folder: "companion-lite",
  },
];

/** At or below this much installed memory, Local Chat Lite is the one to suggest. */
export const LITE_RECOMMENDED_MB = 6 * 1024;

export interface ModuleStatus {
  id: ModuleId;
  state: ModuleState;
  /** 0..1 while downloading / paused. */
  progress: number;
  bytesDone: number;
  bytesTotal: number | null;
  version: string | null;
  storageBytes: number;
  error: string | null;
}

export const notInstalled = (id: ModuleId): ModuleStatus => ({
  id,
  state: "not-installed",
  progress: 0,
  bytesDone: 0,
  bytesTotal: null,
  version: null,
  storageBytes: 0,
  error: null,
});

/** Which actions the UI offers in each state. */
export const ACTIONS: Record<ModuleState, readonly ModuleAction[]> = {
  "not-installed": ["download"],
  downloading: ["pause", "cancel"],
  paused: ["resume", "cancel"],
  verifying: [],
  installing: [],
  installed: ["remove"],
  "update-available": ["update", "remove"],
  error: ["retry", "remove"],
};

/** Legal transitions. Anything else is a bug, and is refused. */
const NEXT: Partial<Record<ModuleState, Partial<Record<ModuleEvent, ModuleState>>>> = {
  "not-installed": { download: "downloading" },
  downloading: { pause: "paused", cancel: "not-installed", progress: "downloading", downloaded: "verifying", failed: "error" },
  paused: { resume: "downloading", cancel: "not-installed" },
  // A checksum mismatch never installs: the partial file is deleted and it is an error.
  verifying: { verified: "installed", corrupt: "error" },
  installing: { verified: "installed", failed: "error" },
  installed: { remove: "not-installed" },
  "update-available": { update: "downloading", remove: "not-installed" },
  error: { retry: "downloading", remove: "not-installed" },
};

export type ModuleEvent = ModuleAction | "progress" | "downloaded" | "verified" | "corrupt" | "failed";

export function transition(state: ModuleState, ev: ModuleEvent): ModuleState | null {
  return NEXT[state]?.[ev] ?? null;
}

export const usable = (s: ModuleStatus | null | undefined) => s?.state === "installed" || s?.state === "update-available";

/** Voice Chat needs both - and only both. */
export const voiceChatAvailable = (voice: ModuleStatus, chat: ModuleStatus) => usable(voice) && usable(chat);

export const STATE_LABEL: Record<ModuleState, string> = {
  "not-installed": "Not installed",
  downloading: "Downloading",
  paused: "Paused",
  verifying: "Checking download",
  installing: "Setting up",
  installed: "Installed",
  "update-available": "Update available",
  error: "Didn't finish",
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---- Rust bridge ------------------------------------------------------------------

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) invokeFn = (await import("@tauri-apps/api/core")).invoke as unknown as Invoke;
  return invokeFn<T>(cmd, args);
}

interface RustStatus {
  id: ModuleId;
  state: ModuleState;
  progress: number;
  bytesDone: number;
  bytesTotal: number;
  version: string | null;
  storageBytes: number;
  error: string | null;
}

export async function moduleStatus(id: ModuleId): Promise<ModuleStatus> {
  try {
    const s = await invoke<RustStatus>("module_status", { id });
    return { ...s, bytesTotal: s.bytesTotal ?? null };
  } catch {
    return notInstalled(id);
  }
}

/** Starts or resumes; progress arrives through `onModuleEvents`. */
export const moduleDownload = (id: ModuleId) => invoke<void>("module_download", { id });
export const modulePause = (id: ModuleId) => invoke<void>("module_pause", { id, discard: false });
export const moduleCancel = (id: ModuleId) => invoke<void>("module_pause", { id, discard: true });
/** Deletes the module's folder; resolves with the bytes freed. */
export const moduleRemove = (id: ModuleId) => invoke<number>("module_remove", { id });

export async function onModuleEvents(cb: (id: ModuleId) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const a = await listen<{ id: ModuleId }>("module-progress", (e) => cb(e.payload.id));
    const b = await listen<{ id: ModuleId }>("module-status", (e) => cb(e.payload.id));
    return () => {
      a();
      b();
    };
  } catch {
    return () => undefined;
  }
}

/** Only the end-of-job events (installed, paused, failed) - not every progress tick. */
export async function onModuleStatus(cb: (id: ModuleId) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ id: ModuleId }>("module-status", (e) => cb(e.payload.id));
  } catch {
    return () => undefined;
  }
}
