//! ModelLifecycleManager - the one place that decides when a local model is
//! loaded, kept, or unloaded.
//!
//!   NORMAL DAY          chat opens           chat closes
//!   voice: unloaded     chat: loading->ready  grace period -> unloaded
//!   chat:  unloaded
//!
//! Models are never loaded at startup, never loaded because a file exists, and
//! never kept after their grace period. Features `acquire` a model for the
//! span of a session and `release` it; the idle timer lives here, not
//! scattered through the chat window and the recorder. Phase 1 registers no
//! loaders - this is the seam Phase 2 plugs into.

import { MODE_PROFILE } from "./power";
import type { PowerMode } from "./profile";
import type { ModuleId } from "./modules";

export type ModelState = "unloaded" | "loading" | "ready" | "unloading" | "failed";

export interface ModelLoader {
  load(opts: { threads: number }): Promise<void>;
  unload(): Promise<void>;
}

export interface LifecycleEnv {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  cpuThreads: number;
}

const defaultEnv = (): LifecycleEnv => ({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  cpuThreads: typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4,
});

interface Slot {
  loader: ModelLoader;
  state: ModelState;
  holders: number;
  idleTimer: unknown;
  pending: Promise<void> | null;
  error: string | null;
}

export class ModelLifecycleManager {
  private slots = new Map<ModuleId, Slot>();
  private mode: PowerMode = "balanced";

  constructor(private readonly env: LifecycleEnv = defaultEnv()) {}

  /** A module that is installed and usable registers its loader. */
  register(id: ModuleId, loader: ModelLoader): void {
    this.slots.set(id, { loader, state: "unloaded", holders: 0, idleTimer: null, pending: null, error: null });
  }

  /** Removing a module: unload first, then forget it. Never throws. */
  async unregister(id: ModuleId): Promise<void> {
    const s = this.slots.get(id);
    if (!s) return;
    this.clearIdle(s);
    await s.pending?.catch(() => undefined);
    if (s.state === "ready") await s.loader.unload().catch(() => undefined);
    this.slots.delete(id);
  }

  state(id: ModuleId): ModelState | "absent" {
    return this.slots.get(id)?.state ?? "absent";
  }

  setMode(mode: PowerMode): void {
    this.mode = mode;
  }

  /** Threads a new inference may use: a share of the machine, never all of it. */
  threads(): number {
    return Math.max(1, Math.floor(this.env.cpuThreads * MODE_PROFILE[this.mode].aiThreadShare));
  }

  /** Grace period after the last holder releases. */
  idleUnloadMs(): number {
    return MODE_PROFILE[this.mode].aiIdleUnloadMs;
  }

  /**
   * Hold a model for a session (a chat window, a recording). Loads it if
   * needed; a second acquire during the same session reuses it. Rejects if the
   * module is absent or fails to load - the caller shows an error, the cat
   * carries on.
   */
  async acquire(id: ModuleId): Promise<void> {
    const s = this.slots.get(id);
    if (!s) throw new Error(`${id} is not installed`);
    s.holders++;
    this.clearIdle(s);
    if (s.state === "ready") return;
    if (s.state === "unloading" && s.pending) await s.pending.catch(() => undefined);
    if (s.state === "loading" && s.pending) return s.pending;
    s.state = "loading";
    s.error = null;
    s.pending = s.loader
      .load({ threads: this.threads() })
      .then(() => {
        s.state = "ready";
      })
      .catch((e: unknown) => {
        s.state = "failed";
        s.holders = Math.max(0, s.holders - 1);
        s.error = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        s.pending = null;
      });
    return s.pending;
  }

  /** Done with it. The model unloads after the grace period unless re-acquired. */
  release(id: ModuleId): void {
    const s = this.slots.get(id);
    if (!s || s.holders === 0) return;
    s.holders--;
    if (s.holders > 0 || s.state !== "ready") return;
    this.clearIdle(s);
    s.idleTimer = this.env.setTimer(() => void this.unloadNow(id), this.idleUnloadMs());
  }

  /** Unload immediately if nobody holds it (Battery Saver, low memory, removal). */
  async unloadNow(id: ModuleId): Promise<void> {
    const s = this.slots.get(id);
    if (!s || s.holders > 0 || s.state !== "ready") return;
    this.clearIdle(s);
    s.state = "unloading";
    s.pending = s.loader
      .unload()
      .catch(() => undefined)
      .finally(() => {
        s.state = "unloaded";
        s.pending = null;
      });
    await s.pending;
  }

  /**
   * The runtime died underneath us (crashed, killed, out of memory). Load it
   * again for the holders that are still waiting, without touching the hold
   * count - so the session's own release still unloads it afterwards.
   */
  async recover(id: ModuleId): Promise<void> {
    const s = this.slots.get(id);
    if (!s) throw new Error(`${id} is not installed`);
    this.clearIdle(s);
    s.state = "loading";
    s.pending = s.loader
      .load({ threads: this.threads() })
      .then(() => {
        s.state = "ready";
      })
      .catch((e: unknown) => {
        s.state = "failed";
        s.error = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        s.pending = null;
      });
    return s.pending;
  }

  /** Anything loaded right now? (Drives "AI working" indicators and power checks.) */
  anyLoaded(): boolean {
    return [...this.slots.values()].some((s) => s.state === "ready" || s.state === "loading");
  }

  private clearIdle(s: Slot): void {
    if (s.idleTimer !== null) this.env.clearTimer(s.idleTimer);
    s.idleTimer = null;
  }
}
