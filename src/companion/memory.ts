//! What Local Chat may remember between conversations - and only that.
//!
//! Safe preferences, picked out by fixed patterns (no model decides what to
//! keep): the name to use, the reply language, preferred reply length and the
//! companion's personality. Two small companions sit beside them: the learned
//! conversation style (a fixed set of averages - persona/style.ts) and pending
//! check-ins (a kind and two dates - persona/followUps.ts). The conversation
//! itself is never stored. Everything is visible in Settings, each item can
//! be forgotten, and each blob is encrypted on disk (Windows DPAPI, or a
//! Keychain-held AES key on macOS).

import { parseFollowUps, type FollowUp } from "./persona/followUps";
import { STYLE_KEYS, parseStyle, type StyleProfile } from "./persona/style";
import type { Personality } from "./profile";
import type { Lang } from "./phrases";

export interface MemoryItem {
  key: "name" | "language" | "length" | "personality";
  value: string;
  /** The conversation it was learned in, so "Forget this conversation" can undo it. */
  conversation: string;
  at: number;
}

export interface ChatMemory {
  items: MemoryItem[];
}

export const EMPTY_MEMORY: ChatMemory = { items: [] };

/** The phrase may start a sentence ("Call me…"); the name itself must be capitalised. */
const NAME = /\b(?:[Cc]all me|[Mm]y name is|[Mm]y name's|I'm called|[Mm]era naam)\s+([A-Z][a-zA-Z]{1,19})\b/;
const LANGUAGE = /\b(?:reply|talk|speak|answer|write|baat karo)\b[^.?!]{0,20}?\b(hindi|english|hinglish)\b/i;
const SHORT = /\b(?:keep it short|be brief|shorter (?:replies|answers|messages)|reply (?:briefly|shortly)|short (?:replies|answers))\b/i;
const LONG = /\b(?:more detail|longer (?:replies|answers)|explain more|in detail)\b/i;
const PERSONALITY = /\bbe (?:more )?(cozy|playful|savage|minimal|professional)\b/i;

/** Preferences stated in one message. Nothing else is ever extracted. */
export function extractPreferences(text: string): Omit<MemoryItem, "conversation" | "at">[] {
  const out: Omit<MemoryItem, "conversation" | "at">[] = [];
  const name = NAME.exec(text);
  if (name) out.push({ key: "name", value: name[1] });
  const lang = LANGUAGE.exec(text);
  if (lang) out.push({ key: "language", value: lang[1].toLowerCase() });
  if (SHORT.test(text)) out.push({ key: "length", value: "short" });
  else if (LONG.test(text)) out.push({ key: "length", value: "detailed" });
  const p = PERSONALITY.exec(text);
  if (p) out.push({ key: "personality", value: p[1].toLowerCase() });
  return out;
}

/** Merge newly stated preferences: the latest statement of a key wins. */
export function remember(mem: ChatMemory, found: Omit<MemoryItem, "conversation" | "at">[], conversation: string, now: number): ChatMemory {
  if (found.length === 0) return mem;
  const keys = new Set(found.map((f) => f.key));
  return { items: [...mem.items.filter((i) => !keys.has(i.key)), ...found.map((f) => ({ ...f, conversation, at: now }))] };
}

export function forgetConversation(mem: ChatMemory, conversation: string): ChatMemory {
  return { items: mem.items.filter((i) => i.conversation !== conversation) };
}

export function forgetItem(mem: ChatMemory, key: MemoryItem["key"]): ChatMemory {
  return { items: mem.items.filter((i) => i.key !== key) };
}

export interface MemoryView {
  name?: string;
  language?: Lang;
  length?: "short" | "detailed";
  personality?: Personality;
}

export function view(mem: ChatMemory): MemoryView {
  const get = (k: MemoryItem["key"]) => mem.items.find((i) => i.key === k)?.value;
  const language = get("language");
  const length = get("length");
  const personality = get("personality");
  return {
    name: get("name"),
    language: language === "hindi" ? "hi" : language === "english" ? "en" : language === "hinglish" ? "hinglish" : undefined,
    length: length === "short" || length === "detailed" ? length : undefined,
    personality: personality as Personality | undefined,
  };
}

export function describeItem(i: MemoryItem): string {
  switch (i.key) {
    case "name":
      return `Call you ${i.value}`;
    case "language":
      return `Reply in ${i.value[0].toUpperCase()}${i.value.slice(1)}`;
    case "length":
      return i.value === "short" ? "Keep replies short" : "Give more detail";
    case "personality":
      return `Be ${i.value}`;
  }
}

/** Parse the decrypted blob; anything unexpected is dropped. */
export function parseMemory(raw: string | null): ChatMemory {
  if (!raw) return EMPTY_MEMORY;
  try {
    const v = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(v.items)) return EMPTY_MEMORY;
    const keys = ["name", "language", "length", "personality"];
    const items = v.items.filter(
      (i): i is MemoryItem =>
        typeof i === "object" && i !== null && keys.includes((i as MemoryItem).key) && typeof (i as MemoryItem).value === "string" && (i as MemoryItem).value.length <= 20,
    );
    return { items: items.slice(0, 8) };
  } catch {
    return EMPTY_MEMORY;
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = async (cmd, args) => ((await import("@tauri-apps/api/core")).invoke as unknown as Invoke)(cmd, args);
const STORE = "chat-memory";

export async function loadMemory(): Promise<ChatMemory> {
  return parseMemory(await readBlob(STORE));
}

export async function saveMemory(mem: ChatMemory): Promise<void> {
  await writeBlob(STORE, mem.items.length === 0 ? null : JSON.stringify(mem));
}

/** One encrypted blob (DPAPI / Keychain-keyed AES); null deletes it. Failure = session-only memory. */
async function writeBlob(name: string, text: string | null): Promise<void> {
  try {
    if (text === null) await invoke("secure_delete", { name });
    else await invoke("secure_write", { name, text });
  } catch {
    // Unavailable outside the app; memory then simply lasts for the session.
  }
}

async function readBlob(name: string): Promise<string | null> {
  try {
    return await invoke<string | null>("secure_read", { name });
  } catch {
    return null;
  }
}

// Learned conversation style and pending check-ins: separate blobs, same rules.
export const loadStyle = async () => parseStyle(await readBlob("chat-style"));
export const saveStyle = (p: StyleProfile) => writeBlob("chat-style", p.n === 0 ? null : JSON.stringify(Object.fromEntries(STYLE_KEYS.map((k) => [k, p[k]]))));
export const loadFollowUps = async () => parseFollowUps(await readBlob("chat-followups"));
export const saveFollowUps = (list: FollowUp[]) => writeBlob("chat-followups", list.length === 0 ? null : JSON.stringify(list));
