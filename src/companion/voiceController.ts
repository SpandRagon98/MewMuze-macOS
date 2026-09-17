//! Voice flows: push-to-talk dictation, the recorder, and voice input for chat.
//!
//!   Start -> microphone open (indicator on) -> Stop -> transcribe locally
//!   -> deterministic cleanup -> insert / copy / hand to chat
//!
//! The microphone is open only between Start and Stop. The RAW transcript is
//! always kept next to the CLEAN one. The temp recording is deleted as soon as
//! it is no longer needed, unless the user saves it.

import { cleanTranscript } from "./cleanup";
import type { Transcript } from "./localAI";

export type VoiceMode = "dictation" | "recorder" | "chat";
export type VoicePhase = "idle" | "starting" | "recording" | "transcribing" | "done" | "error";

export interface VoiceState {
  phase: VoicePhase;
  mode: VoiceMode | null;
  seconds: number;
  level: number;
  raw: string;
  clean: string;
  language: string;
  error: string | null;
  /** Temp recording kept for "Save recording" (recorder only). */
  recordingPath: string | null;
  transcript: Transcript | null;
}

export const IDLE: VoiceState = { phase: "idle", mode: null, seconds: 0, level: 0, raw: "", clean: "", language: "", error: null, recordingPath: null, transcript: null };

export interface VoiceBridge {
  start(maxSeconds: number): Promise<{ device: string }>;
  level(): Promise<{ recording: boolean; level: number; seconds: number; atLimit: boolean }>;
  stop(): Promise<{ path: string; seconds: number }>;
  cancel(): Promise<void>;
  discard(path: string): Promise<void>;
  save(path: string, destination: string): Promise<void>;
  copy(text: string): Promise<void>;
  paste(): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = async (cmd, args) => ((await import("@tauri-apps/api/core")).invoke as unknown as Invoke)(cmd, args);

export const tauriVoiceBridge: VoiceBridge = {
  start: (maxSeconds) => invoke("audio_start", { maxSeconds }),
  level: () => invoke("audio_level"),
  stop: () => invoke("audio_stop"),
  cancel: () => invoke("audio_cancel"),
  discard: (path) => invoke("audio_discard", { path }),
  save: (path, destination) => invoke("audio_save", { path, destination }),
  copy: (text) => invoke("clipboard_write_text", { text }),
  paste: () => invoke("dictation_paste"),
};

const LIMIT_S: Record<VoiceMode, number> = { dictation: 120, chat: 120, recorder: 1800 };

export interface VoiceOptions {
  language: () => "auto" | "en" | "hi";
  spokenPunctuation: () => boolean;
  insertMode: () => "paste" | "copy";
  /** Chat hands the cleaned text on instead of inserting it. */
  onChatText?: (text: string) => void;
}

export class VoiceController {
  private s: VoiceState = IDLE;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bridge: VoiceBridge,
    private readonly ai: { transcribe(path: string, language: string): Promise<Transcript>; cancelTranscription(): Promise<void> },
    private readonly opts: VoiceOptions,
    private readonly onChange: (s: VoiceState) => void,
  ) {}

  state(): VoiceState {
    return this.s;
  }

  /** Recording or transcribing - the battery guard waits until this is over. */
  active(): boolean {
    return this.s.phase === "starting" || this.s.phase === "recording" || this.s.phase === "transcribing";
  }

  private set(patch: Partial<VoiceState>): void {
    this.s = { ...this.s, ...patch };
    this.onChange(this.s);
  }

  async start(mode: VoiceMode): Promise<void> {
    if (this.active()) return;
    await this.dropRecording();
    this.set({ ...IDLE, phase: "starting", mode });
    try {
      await this.bridge.start(LIMIT_S[mode]);
    } catch (e) {
      this.set({ phase: "error", error: String(e instanceof Error ? e.message : e) });
      return;
    }
    this.set({ phase: "recording" });
    this.poll = setInterval(() => {
      void this.bridge.level().then((l) => {
        if (this.s.phase !== "recording") return;
        this.set({ level: l.level, seconds: l.seconds });
        if (l.atLimit) void this.stop();
      });
    }, 120);
  }

  /** Stop, transcribe locally, clean up, then insert / copy / hand to chat. */
  async stop(): Promise<void> {
    if (this.s.phase !== "recording") return;
    this.stopPolling();
    const mode = this.s.mode ?? "dictation";
    this.set({ phase: "transcribing", level: 0 });
    let rec: { path: string; seconds: number };
    try {
      rec = await this.bridge.stop();
    } catch (e) {
      this.set({ phase: "error", error: String(e instanceof Error ? e.message : e) });
      return;
    }
    try {
      const t = await this.ai.transcribe(rec.path, this.opts.language());
      const clean = cleanTranscript(t.text, { spokenPunctuation: this.opts.spokenPunctuation() });
      this.set({ phase: "done", raw: t.text, clean, language: t.language, transcript: t, recordingPath: mode === "recorder" ? rec.path : null });
      if (mode !== "recorder") await this.bridge.discard(rec.path);
      if (!clean) return;
      if (mode === "chat") this.opts.onChatText?.(clean);
      if (mode === "dictation") {
        await this.bridge.copy(clean);
        if (this.opts.insertMode() === "paste") await this.bridge.paste().catch(() => undefined);
      }
    } catch (e) {
      await this.bridge.discard(rec.path).catch(() => undefined);
      this.set({ phase: "error", error: String(e instanceof Error ? e.message : e) });
    }
  }

  /** Abandon a recording or transcription without keeping anything. */
  async cancel(): Promise<void> {
    this.stopPolling();
    if (this.s.phase === "recording" || this.s.phase === "starting") await this.bridge.cancel().catch(() => undefined);
    if (this.s.phase === "transcribing") await this.ai.cancelTranscription();
    await this.dropRecording();
    this.set(IDLE);
  }

  async saveRecording(destination: string): Promise<void> {
    if (!this.s.recordingPath) return;
    await this.bridge.save(this.s.recordingPath, destination);
    this.set({ recordingPath: null });
  }

  /** Forget the finished result (panel closed or a new take). */
  async reset(): Promise<void> {
    if (this.active()) return;
    await this.dropRecording();
    this.set(IDLE);
  }

  private async dropRecording(): Promise<void> {
    if (this.s.recordingPath) {
      await this.bridge.discard(this.s.recordingPath).catch(() => undefined);
      this.s = { ...this.s, recordingPath: null };
    }
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}
