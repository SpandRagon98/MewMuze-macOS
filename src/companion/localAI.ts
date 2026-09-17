//! LocalAIManager - the single owner of local AI at runtime.
//!
//! It decides when Local Chat's model is loaded (only while a chat is open,
//! plus the power mode's grace period), how many threads inference may use,
//! and runs every piece of AI work through ONE queue so voice and chat never
//! pile onto the CPU at once. It also cancels, and applies Battery Saver at a
//! safe boundary: between replies, never in the middle of one, and never by
//! killing a transcription.
//!
//! Local Voice has no resident model: each transcription is its own process
//! that exits when done. Nothing here runs at startup.

import { ModelLifecycleManager, type LifecycleEnv } from "./lifecycle";
import type { PowerMode } from "./profile";

export interface RustModuleStatus {
  id: string;
  state: "not-installed" | "downloading" | "installing" | "verifying" | "paused" | "installed" | "update-available" | "error";
  progress: number;
  bytesDone: number;
  bytesTotal: number;
  version: string | null;
  catalogVersion: string;
  downloadBytes: number;
  storageBytes: number;
  error: string | null;
}

export interface Transcript {
  text: string;
  language: string;
  audioSeconds: number;
  elapsedMs: number;
  realTimeFactor: number;
  threads: number;
}

export interface GenStats {
  text: string;
  firstTokenMs: number;
  totalMs: number;
  tokens: number;
  tokensPerSecond: number;
  promptTokens: number;
  promptMs: number;
  finishReason: string;
  cancelled: boolean;
}

export interface AiStatus {
  chatLoaded: boolean;
  chatThreads: number;
  chatLoadedSeconds: number;
  chatMemoryBytes: number;
  voiceBusy: boolean;
  voiceMemoryBytes: number;
  cpuSeconds: number;
  chatCrashes: number;
  availableMemoryBytes: number;
  /** Installed RAM (decides whether Lite is suggested). */
  totalMemoryBytes?: number;
  /** "lite" while Local Chat Lite is the running model. */
  chatModel?: string;
}

export type Msg = { role: string; content: string };

/** Per-reply sampling. `script` names one of Rust's fixed grammars (local_ai.rs). */
export interface ReplyOptions {
  topP?: number;
  script?: "latin" | "devanagari";
}

/** Everything that crosses into Rust, injectable for tests. */
export interface AIBridge {
  moduleStatus(id: "voice" | "chat" | "chat-lite"): Promise<RustModuleStatus>;
  chatLoad(threads: number, ctx: number, lite?: boolean): Promise<{ loadMs: number; threads: number; alreadyLoaded: boolean }>;
  chatUnload(): Promise<boolean>;
  chatGenerate(requestId: string, messages: Msg[], maxTokens: number, temperature: number, onToken: (t: string) => void, opts?: ReplyOptions): Promise<GenStats>;
  chatCancel(requestId: string): Promise<void>;
  chatJson(requestId: string, messages: Msg[], schema: unknown, maxTokens: number): Promise<string>;
  transcribe(path: string, language: string, threads: number): Promise<Transcript>;
  voiceCancel(): Promise<void>;
  status(): Promise<AiStatus>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) invokeFn = (await import("@tauri-apps/api/core")).invoke as unknown as Invoke;
  return invokeFn<T>(cmd, args);
}

/** One `chat-token` listener for the whole app, routed by request id. */
const tokenSinks = new Map<string, (t: string) => void>();
let listening: Promise<void> | null = null;
function ensureTokenListener(): Promise<void> {
  listening ??= import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ id: string; text: string }>("chat-token", (e) => tokenSinks.get(e.payload.id)?.(e.payload.text)).then(() => undefined),
    )
    .catch(() => undefined);
  return listening;
}

export const tauriBridge: AIBridge = {
  moduleStatus: (id) => invoke("module_status", { id }),
  chatLoad: (threads, ctx, lite = false) => invoke("chat_load", { threads, ctx, lite }),
  chatUnload: () => invoke("chat_unload"),
  async chatGenerate(requestId, messages, maxTokens, temperature, onToken, opts) {
    await ensureTokenListener();
    tokenSinks.set(requestId, onToken);
    try {
      return await invoke<GenStats>("chat_generate", { requestId, messages, maxTokens, temperature, topP: opts?.topP ?? null, script: opts?.script ?? null });
    } finally {
      tokenSinks.delete(requestId);
    }
  },
  chatCancel: (requestId) => invoke("chat_cancel", { requestId }),
  chatJson: (requestId, messages, schema, maxTokens) => invoke("chat_json", { requestId, messages, schema, maxTokens }),
  transcribe: (path, language, threads) => invoke("voice_transcribe", { path, language, threads }),
  voiceCancel: () => invoke("voice_cancel"),
  status: () => invoke("ai_status"),
};

export const CHAT_CTX = 4096;

/** Errors from Rust that mean the chat runtime is gone, not that the request was bad. */
const LOST = /not loaded|stopped unexpectedly|did not answer|connection dropped/i;

export interface WorkRecord {
  kind: "generate" | "transcribe" | "load";
  ms: number;
  at: number;
}

export class LocalAIManager {
  readonly lifecycle: ModelLifecycleManager;
  private queue: Promise<unknown> = Promise.resolve();
  private loadedThreads = 0;
  private busyKind: WorkRecord["kind"] | null = null;
  private busySince = 0;
  private readonly work: WorkRecord[] = [];
  private chatRegistered = false;
  /** Which chat model to run: Settings -> Chat, resolved against what is installed. */
  private chatPref: () => "auto" | "standard" | "lite" = () => "auto";
  /** The loaded (or next) model is Local Chat Lite. */
  private lite = false;
  /** Requests cancelled while still waiting in the queue: skipped when their turn comes. */
  private readonly cancelled = new Set<string>();
  lastLoadMs = 0;

  constructor(
    private readonly bridge: AIBridge,
    env: LifecycleEnv,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lifecycle = new ModelLifecycleManager(env);
  }

  setMode(mode: PowerMode): void {
    // Takes effect for the next load and at the next safe boundary (between
    // replies); running work is never interrupted.
    this.lifecycle.setMode(mode);
  }

  threads(): number {
    return this.lifecycle.threads();
  }

  setChatModel(pref: () => "auto" | "standard" | "lite"): void {
    this.chatPref = pref;
  }

  /**
   * The chat model to use: the one chosen in Settings if it is installed,
   * otherwise whichever is (standard first). null when neither is.
   */
  async pickChat(): Promise<boolean | null> {
    const [std, lite] = await Promise.all([this.installed("chat"), this.installed("chat-lite")]);
    const pref = this.chatPref();
    if (pref === "lite" && lite) return true;
    if (pref === "standard" && std) return false;
    return std ? false : lite ? true : null;
  }

  async installed(id: "voice" | "chat" | "chat-lite"): Promise<boolean> {
    try {
      const s = await this.bridge.moduleStatus(id);
      return s.state === "installed" || s.state === "update-available";
    } catch {
      return false;
    }
  }

  /** Busy with inference right now (for the battery guard and the UI). */
  busy(): WorkRecord["kind"] | null {
    return this.busyKind;
  }

  /** Recent work, newest last - technical timings only, never content. */
  recentWork(): readonly WorkRecord[] {
    return this.work;
  }

  // ---- chat -----------------------------------------------------------------------

  private registerChat(): void {
    if (this.chatRegistered) return;
    this.chatRegistered = true;
    this.lifecycle.register("chat", {
      load: async ({ threads }) => {
        const r = await this.bridge.chatLoad(threads, CHAT_CTX, this.lite);
        this.loadedThreads = r.threads;
        this.lastLoadMs = r.loadMs;
        this.record("load", r.loadMs);
      },
      unload: async () => {
        await this.bridge.chatUnload();
        this.loadedThreads = 0;
      },
    });
  }

  /** A chat window opened: hold the model for the session. */
  async openChat(): Promise<void> {
    const lite = await this.pickChat();
    if (lite === null) throw new Error("Local Chat is not installed.");
    // The other model is loaded (the choice changed in Settings): swap at this safe boundary.
    if (this.loadedThreads && lite !== this.lite) await this.lifecycle.unloadNow("chat");
    this.lite = lite;
    this.registerChat();
    await this.lifecycle.acquire("chat");
  }

  /** The chat window closed: the model unloads after the mode's grace period. */
  closeChat(): void {
    this.lifecycle.release("chat");
  }

  chatState() {
    return this.lifecycle.state("chat");
  }

  /** Stream one reply. Serialised with all other AI work. */
  reply(requestId: string, messages: Msg[], onToken: (t: string) => void, maxTokens = 220, temperature = 0.7, opts?: ReplyOptions): Promise<GenStats> {
    return this.enqueue("generate", async () => {
      if (this.cancelled.delete(requestId)) return { text: "", firstTokenMs: 0, totalMs: 0, tokens: 0, tokensPerSecond: 0, promptTokens: 0, promptMs: 0, finishReason: "cancelled", cancelled: true };
      this.registerChat();
      // The reply holds the model for as long as it runs, so the idle timer
      // can never unload it mid-sentence - even with Battery Saver's short grace.
      await this.lifecycle.acquire("chat");
      try {
        // Battery Saver (or Performance) chosen mid-session: the new thread
        // count is applied here, between replies - a safe boundary.
        const want = this.lifecycle.threads();
        if (this.loadedThreads && this.loadedThreads !== want) {
          const r = await this.bridge.chatLoad(want, CHAT_CTX, this.lite);
          this.loadedThreads = r.threads;
        }
        try {
          return await this.bridge.chatGenerate(requestId, messages, maxTokens, temperature, onToken, opts);
        } catch (e) {
          // The model process died (crash, kill, out of memory): the cat is
          // unaffected. Wake the model once more and retry this reply once.
          if (!LOST.test(String(e instanceof Error ? e.message : e))) throw e;
          await this.lifecycle.recover("chat");
          return await this.bridge.chatGenerate(requestId, messages, maxTokens, temperature, onToken, opts);
        }
      } finally {
        this.lifecycle.release("chat");
        this.cancelled.delete(requestId);
      }
    });
  }

  /** Structured JSON under a grammar (the persona classifier). Cancellable with cancelReply(requestId). */
  json(requestId: string, messages: Msg[], schema: unknown): Promise<string> {
    return this.enqueue("generate", async () => {
      // The next message usually arrives while this is still queued: a cancel
      // sent to Rust then found nothing to stop, and the reply waited ~4 s.
      if (this.cancelled.delete(requestId)) throw new Error("cancelled");
      this.registerChat();
      await this.lifecycle.acquire("chat");
      try {
        return await this.bridge.chatJson(requestId, messages, schema, 80);
      } finally {
        this.lifecycle.release("chat");
        this.cancelled.delete(requestId);
      }
    });
  }

  /** Read a prompt into the model's cache ahead of the reply that extends it. Best effort. */
  warm(messages: Msg[]): void {
    this.reply(`warm-${this.now()}`, messages, () => undefined, 1).catch(() => undefined);
  }

  cancelReply(requestId: string): Promise<void> {
    // Callers only cancel requests they know are unfinished, so the id is
    // either queued (skipped, and removed, when its turn comes) or running.
    this.cancelled.add(requestId);
    return this.bridge.chatCancel(requestId).catch(() => undefined);
  }

  // ---- voice ----------------------------------------------------------------------

  transcribe(path: string, language: string): Promise<Transcript> {
    return this.enqueue("transcribe", async () => {
      if (!(await this.installed("voice"))) throw new Error("Local Voice is not installed.");
      return this.bridge.transcribe(path, language, this.lifecycle.threads());
    });
  }

  cancelTranscription(): Promise<void> {
    return this.bridge.voiceCancel().catch(() => undefined);
  }

  /** Free everything that is idle right now (Battery Saver, low memory, module removal). */
  async unloadIdle(): Promise<void> {
    await this.lifecycle.unloadNow("chat");
  }

  /** Before a module is removed: stop and forget it. */
  async forget(id: "voice" | "chat" | "chat-lite"): Promise<void> {
    if ((id === "chat" || id === "chat-lite") && this.chatRegistered) {
      await this.lifecycle.unregister("chat");
      this.chatRegistered = false;
      this.loadedThreads = 0;
    }
    if (id === "voice") await this.cancelTranscription();
  }

  private enqueue<T>(kind: WorkRecord["kind"], job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busyKind = kind;
      this.busySince = this.now();
      try {
        return await job();
      } finally {
        this.record(kind, this.now() - this.busySince);
        this.busyKind = null;
      }
    });
    // A failed job must not block the next one.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private record(kind: WorkRecord["kind"], ms: number): void {
    this.work.push({ kind, ms, at: this.now() });
    if (this.work.length > 200) this.work.splice(0, this.work.length - 200);
  }
}
