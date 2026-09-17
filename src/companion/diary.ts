//! The Diary: after a meaningful conversation, MewMuze quietly writes it up as
//! a short entry in the user's own voice and keeps it on this computer.
//!
//! Diary and Memory are different things. Memory is the handful of facts
//! MewMuze uses to talk to you (encrypted, cleared by "Clear companion
//! memory"). The Diary is YOUR readable record: plain Markdown files in
//! <app-data>/diary/, one per conversation, which Forget Chat and clearing
//! memory never delete - only Delete entry / Clear Diary do.
//!
//! One conversation is one entry. It is (re)written when the chat closes, a new
//! chat starts, the chat goes quiet or the app quits - and the same entry is
//! updated if the conversation carries on. Until an entry is summarised, the
//! conversation waits in an encrypted pending list, so nothing is lost when no
//! summariser is available; it is summarised the next time one is.

import type { ChatAI } from "./chatController";
import type { Msg } from "./localAI";
import type { Lang } from "./phrases";
import type { ExternalId, ProviderId } from "./providers";

export interface DiaryLine {
  role: "user" | "assistant";
  text: string;
}

/** One conversation, as the chat hands it over. */
export interface DiarySession {
  id: string;
  startedAt: number;
  endedAt: number;
  lines: DiaryLine[];
  lang: Lang;
  provider: ProviderId;
}

export interface DiaryEntry {
  id: string;
  file: string;
  startedAt: number;
  endedAt: number;
  title: string;
  summary: string;
  /** How many chat lines the summary covers: an unchanged session is never re-summarised. */
  lines: number;
  /** Who wrote the summary. */
  by: "local" | ExternalId;
}

// ---- when a conversation is worth an entry ------------------------------------------

const SMALL_TALK =
  /^(hi+|hey+|hello+|hii+|yo|sup|ok(ay)?|k+|thanks?( you)?|thx|ty|lol|haha+|hmm+|bye|good (morning|night|evening|afternoon)|gm|gn|namaste|test(ing)?|nothing|nm)[\s.!?]*$/i;

/** Not "hi", not one accidental line: two real messages, or one long one, with an answer. */
export function meaningful(lines: DiaryLine[]): boolean {
  const said = lines.filter((l) => l.role === "user" && !SMALL_TALK.test(l.text.trim()));
  const words = said.reduce((n, l) => n + (l.text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0), 0);
  const answered = lines.some((l) => l.role === "assistant" && l.text.trim().length > 0);
  return answered && ((said.length >= 2 && words >= 12) || words >= 40);
}

// ---- the summary ------------------------------------------------------------------------

const WRITE_IN: Record<Lang, string> = {
  en: "Write in English.",
  hi: "Write in Hindi, in Devanagari.",
  hinglish: "Write in Hinglish (Hindi in Latin letters, mixed with English as they wrote).",
};
/** Characters of transcript sent to the summariser; the newest part wins. */
const TRANSCRIPT_CHARS = 6000;

export function summaryMessages(s: DiarySession, name: string): Msg[] {
  const me = name.trim() || "Me";
  const text = s.lines.map((l) => `${l.role === "user" ? me : "MewMuze"}: ${l.text}`).join("\n");
  const transcript = text.length > TRANSCRIPT_CHARS ? `…${text.slice(-TRANSCRIPT_CHARS)}` : text;
  return [
    {
      role: "system",
      content:
        `You keep ${me}'s private diary. From the chat below between ${me} and MewMuze (a desktop cat), write the diary entry in ${me}'s own voice: ` +
        `first person ("I"), past tense, warm and natural, like someone writing in their journal - not meeting minutes, not a report. ` +
        `Two or three short paragraphs, under 150 words. Only what was actually said: never invent events, feelings, names or outcomes. ` +
        `Mention what MewMuze helped with in passing. First line: "Title: " and a title of at most six words. Then a blank line, then the entry. ` +
        `Plain text, no markdown. ${WRITE_IN[s.lang]} /no_think`,
    },
    { role: "user", content: transcript },
  ];
}

/** "Title: …" then the entry. Null when the model gave nothing usable. */
export function parseSummary(raw: string): { title: string; summary: string } | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    // The chat's emoji belong to the chat: the local model copied a 😼 into an entry.
    .replace(/[ \t]*[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, "")
    .trim();
  const m = /^\s*title\s*[:：-]\s*(.+)$/im.exec(text);
  let title = m ? m[1].trim().replace(/^["“'`]+|["”'`.]+$/g, "") : "";
  let summary = (m ? text.slice(m.index + m[0].length) : text).trim();
  if (!title) {
    title = (summary.match(/[\p{L}\p{N}']+/gu) ?? []).slice(0, 5).join(" ");
  }
  summary = summary.replace(/\n{3,}/g, "\n\n");
  if (summary.length < 30) return null;
  return { title: title.slice(0, 80), summary };
}

// ---- how an entry looks on disk ----------------------------------------------------------

export function dateLabel(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(at);
}

export function timeLabel(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

/** `YYYY-MM-DD_HH-mm_<id>.md`, in local time. */
export function fileName(e: { id: string; startedAt: number }): string {
  const d = new Date(e.startedAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const id = e.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "entry";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}_${id}.md`;
}

export function entryMarkdown(e: Pick<DiaryEntry, "startedAt" | "endedAt" | "title" | "summary">, timeZone?: string): string {
  const start = timeLabel(e.startedAt, timeZone);
  const end = timeLabel(e.endedAt, timeZone);
  return `# ${dateLabel(e.startedAt, timeZone)}\n${start === end ? start : `${start} – ${end}`}\n\n"${e.title}"\n\n${e.summary}\n`;
}

// ---- who writes it ---------------------------------------------------------------------------

export type Summarize = (messages: Msg[]) => Promise<{ text: string; by: "local" | ExternalId } | null>;

/**
 * The local model whenever it is installed - even while chatting through
 * OpenAI or Claude, so the Diary stays private and costs nothing. Otherwise
 * the chosen provider (one compact request), only if Settings allow it.
 * Null means "not now": the conversation stays pending.
 */
export function makeSummarizer(o: { localInstalled(): boolean; local: ChatAI; external(): { id: ExternalId; ai: ChatAI } | null }): Summarize {
  return async (messages) => {
    const id = `diary-${Date.now()}`;
    if (o.localInstalled()) {
      await o.local.openChat();
      try {
        const r = await o.local.reply(id, messages, () => undefined, 360, 0.4);
        return r.text.trim() ? { text: r.text, by: "local" } : null;
      } finally {
        o.local.closeChat();
      }
    }
    const ext = o.external();
    if (!ext) return null;
    const r = await ext.ai.reply(id, messages, () => undefined, 360, 0.4);
    return r.text.trim() ? { text: r.text, by: ext.id } : null;
  };
}

// ---- the store ----------------------------------------------------------------------------------

export interface DiaryBridge {
  dir(): Promise<string>;
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  clear(): Promise<void>;
  /** The pending list, encrypted like chat memory (it holds conversation text). */
  loadPending(): Promise<string | null>;
  savePending(json: string | null): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = async (cmd, args) => (await import("@tauri-apps/api/core")).invoke(cmd, args);

export const tauriDiary: DiaryBridge = {
  dir: () => invoke("diary_dir"),
  read: (name) => invoke("diary_read", { name }),
  write: (name, text) => invoke("diary_write", { name, text }),
  remove: (name) => invoke("diary_delete", { name }),
  clear: () => invoke("diary_clear"),
  loadPending: () => invoke("secure_read", { name: "diary-pending" }),
  savePending: (json) => (json === null ? invoke("secure_delete", { name: "diary-pending" }) : invoke("secure_write", { name: "diary-pending", text: json })),
};

const INDEX = "index.json";
/** Pending conversations kept at most: a summariser that never comes back cannot grow this forever. */
const MAX_PENDING = 20;

export class Diary {
  private index: DiaryEntry[] | null = null;
  private pending: DiarySession[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bridge: DiaryBridge,
    private readonly summarize: Summarize,
    private readonly opts: { name(): string; enabled(): boolean; onChange?(): void },
  ) {}

  /** One thing at a time: a close and an idle flush must not write the index over each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async entries(): Promise<DiaryEntry[]> {
    if (!this.index) {
      try {
        const raw = JSON.parse((await this.bridge.read(INDEX)) ?? "[]") as unknown;
        this.index = Array.isArray(raw) ? (raw as DiaryEntry[]).filter((e) => e && typeof e.id === "string" && typeof e.file === "string") : [];
      } catch {
        this.index = [];
      }
    }
    return this.index;
  }

  private async queue(): Promise<DiarySession[]> {
    if (!this.pending) {
      try {
        const raw = JSON.parse((await this.bridge.loadPending()) ?? "[]") as unknown;
        this.pending = Array.isArray(raw) ? (raw as DiarySession[]) : [];
      } catch {
        this.pending = [];
      }
    }
    return this.pending;
  }

  private async savePending(): Promise<void> {
    const list = await this.queue();
    await this.bridge.savePending(list.length ? JSON.stringify(list) : null);
  }

  /** Newest first. */
  async list(): Promise<DiaryEntry[]> {
    return [...(await this.entries())].sort((a, b) => b.startedAt - a.startedAt);
  }

  read(e: DiaryEntry): Promise<string | null> {
    return this.bridge.read(e.file);
  }

  dir(): Promise<string> {
    return this.bridge.dir();
  }

  /**
   * Keep this conversation for the Diary (pending, encrypted) - fast, no model.
   * The app-close path stops here; everything else also calls process().
   */
  hold(s: DiarySession | null): Promise<boolean> {
    return this.serial(async () => {
      if (!s || !this.opts.enabled() || !meaningful(s.lines)) return false;
      const done = (await this.entries()).find((e) => e.id === s.id);
      if (done && done.lines === s.lines.length) return false;
      const list = (await this.queue()).filter((p) => p.id !== s.id);
      list.push(s);
      this.pending = list.slice(-MAX_PENDING);
      await this.savePending();
      return true;
    });
  }

  /** Hold, then summarise what is waiting. */
  async remember(s: DiarySession | null): Promise<void> {
    if (await this.hold(s)) await this.process();
  }

  /** Summarise every pending conversation it can. Stops at the first "not now". */
  process(): Promise<void> {
    return this.serial(async () => {
      if (!this.opts.enabled()) return;
      for (const s of [...(await this.queue())]) {
        const r = await this.summarize(summaryMessages(s, this.opts.name())).catch(() => null);
        const parsed = r ? parseSummary(r.text) : null;
        if (!r || !parsed) return; // stays pending for next time
        const list = await this.entries();
        const old = list.find((e) => e.id === s.id);
        const entry: DiaryEntry = { id: s.id, file: old?.file ?? fileName(s), startedAt: s.startedAt, endedAt: s.endedAt, title: parsed.title, summary: parsed.summary, lines: s.lines.length, by: r.by };
        await this.bridge.write(entry.file, entryMarkdown(entry));
        this.index = [...list.filter((e) => e.id !== s.id), entry];
        await this.bridge.write(INDEX, JSON.stringify(this.index));
        this.pending = (await this.queue()).filter((p) => p.id !== s.id || p.lines.length !== s.lines.length);
        await this.savePending();
        this.opts.onChange?.();
      }
    });
  }

  /** Delete one entry (and any update to it still waiting). */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const list = await this.entries();
      const e = list.find((x) => x.id === id);
      if (e) await this.bridge.remove(e.file);
      this.index = list.filter((x) => x.id !== id);
      await this.bridge.write(INDEX, JSON.stringify(this.index));
      this.pending = (await this.queue()).filter((p) => p.id !== id);
      await this.savePending();
      this.opts.onChange?.();
    });
  }

  /** Every entry and everything pending. Chat memory is not touched. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.bridge.clear();
      await this.bridge.savePending(null);
      this.index = [];
      this.pending = [];
      this.opts.onChange?.();
    });
  }

  async pendingCount(): Promise<number> {
    return (await this.queue()).length;
  }
}
