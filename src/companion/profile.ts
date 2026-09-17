//! The Personal Companion's settings: who the user is, and what it may do.
//!
//! Lives as one nested `companion` object inside the app's existing
//! settings.json. Every feature has its own switch, and the sanitiser below is
//! the only way a value gets in - settings.json is a file a user can edit, and
//! some of these strings end up in notifications.

import { DEFAULT_MODEL } from "./providers";

export type CompanionLanguage = "auto" | "en" | "hi" | "hinglish";
export type Personality = "cozy" | "playful" | "savage" | "minimal" | "professional";
export type PowerMode = "saver" | "balanced" | "performance";
export type TempUnit = "c" | "f";
export type LocationMode = "off" | "city" | "device";

export interface CompanionFeatures {
  morningGreeting: boolean;
  weather: boolean;
  calendar: boolean;
  gmail: boolean;
  routineLearning: boolean;
  whileAway: boolean;
  endOfDay: boolean;
  internet: boolean;
  importantAlerts: boolean;
  news: boolean;
  watchlists: boolean;
}

export interface CompanionLocation {
  mode: LocationMode;
  /** Display label, e.g. "Bengaluru". */
  label: string;
  /** Rounded to two decimals (~1 km). Precise coordinates are never kept. */
  lat: number | null;
  lon: number | null;
}

export type ImportantDateKind = "birthday" | "anniversary" | "interview" | "deadline" | "event";

export interface ImportantDate {
  id: string;
  label: string;
  kind: ImportantDateKind;
  month: number; // 1-12
  day: number; // 1-31
  /** Set for one-off dates (an interview); null for yearly ones (a birthday). */
  year: number | null;
  /** Also mention it the day before. */
  dayBefore: boolean;
}

export type WatchKind = "fx" | "rain-tomorrow" | "keyword";

export interface Watch {
  id: string;
  kind: WatchKind;
  label: string;
  paused: boolean;
  /** fx: "USD". */
  base: string;
  /** fx: "INR". */
  quote: string;
  /** fx: the level to watch for. */
  threshold: number;
  /** fx: notify when the rate goes above or below the threshold. */
  direction: "above" | "below";
  /** keyword: the phrase to watch the news for. */
  phrase: string;
}

export interface WorkHours {
  enabled: boolean;
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

export interface CompanionSettings {
  enabled: boolean;
  preferredName: string;
  language: CompanionLanguage;
  timeFormat: "12h" | "24h";
  temperature: TempUnit;
  personality: Personality;
  workHours: WorkHours;
  /** Quiet hours: only urgent companion notices get through. */
  quietHours: WorkHours;
  features: CompanionFeatures;
  location: CompanionLocation;
  powerMode: PowerMode;
  /** Global kill switch for every companion network request. */
  internetPaused: boolean;
  importantDates: ImportantDate[];
  interests: string[];
  watches: Watch[];
  /** Set by "Don't remind me again" on the battery guard (used in Phase 2). */
  batteryGuardMuted: boolean;
  voice: VoiceSettings;
  chat: ChatSettings;
}

export interface VoiceSettings {
  /** Global shortcut that starts and stops dictation. */
  shortcut: string;
  /** Put dictated text straight into the app you are typing in, or only copy it. */
  insertMode: "paste" | "copy";
  language: "auto" | "en" | "hi";
  /** "comma", "full stop", "new line"... become punctuation. */
  spokenPunctuation: boolean;
}

export type ConversationStyle = "auto" | "mewmuze" | "listener" | "coach" | "playful" | "direct";
export const CONVERSATION_STYLES: readonly ConversationStyle[] = ["auto", "mewmuze", "listener", "coach", "playful", "direct"];

export interface ChatSettings {
  /** Remember safe preferences (name, language, reply length) between chats. */
  rememberUseful: boolean;
  /** Check in later on things the user mentioned (feeling unwell, an interview). */
  followUps: boolean;
  /** Create those check-ins without asking first. Off: MewMuze asks. */
  gentleFollowUps: boolean;
  /** Automatic persona routing, or one fixed family of personas. */
  style: ConversationStyle;
  /**
   * "MewMuze · 🩺 Health Guide" in the chat header. Stored under a new key:
   * the old `showMode` (default off) is dropped, so everyone gets the new default.
   */
  showActiveMode: boolean;
  /** Developer only: the internal routing under the header. */
  debugRouting: boolean;
  /** Which chat model: automatic (standard if installed), standard, or Lite. */
  model: "auto" | "standard" | "lite";
  /** Who answers: MewMuze Local (default), or the user's own OpenAI / Claude key. */
  provider: "local" | "openai" | "anthropic";
  /** Model ids for the external providers (the key itself is in the OS vault). */
  openaiModel: string;
  anthropicModel: string;
  /** Turn meaningful conversations into private local Diary entries. */
  diary: boolean;
  /** Without Local Chat, may the chosen provider write the Diary summary (one request per conversation)? */
  diaryExternal: boolean;
}

export const SHORTCUT_PATTERN = /^(?:(?:Ctrl|Alt|Shift)\+){1,3}(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-2]))$/;

export const MAX_DATES = 40;
export const MAX_INTERESTS = 8;
export const MAX_WATCHES = 12;

export const DEFAULT_COMPANION: CompanionSettings = {
  // On by default, but every feature that needs the internet or an account is
  // off until the user turns it on and configures it.
  enabled: true,
  preferredName: "",
  language: "auto",
  timeFormat: "12h",
  temperature: "c",
  personality: "cozy",
  workHours: { enabled: false, start: 9 * 60 + 30, end: 18 * 60 },
  quietHours: { enabled: true, start: 23 * 60, end: 7 * 60 },
  features: {
    morningGreeting: true,
    weather: false,
    calendar: true,
    gmail: true,
    routineLearning: true,
    whileAway: true,
    endOfDay: false,
    internet: false,
    importantAlerts: true,
    news: false,
    watchlists: false,
  },
  location: { mode: "off", label: "", lat: null, lon: null },
  powerMode: "balanced",
  internetPaused: false,
  importantDates: [],
  interests: [],
  watches: [],
  batteryGuardMuted: false,
  voice: { shortcut: "Ctrl+Alt+Space", insertMode: "paste", language: "auto", spokenPunctuation: true },
  chat: {
    rememberUseful: true, followUps: true, gentleFollowUps: false, style: "auto", showActiveMode: true, debugRouting: false, model: "auto",
    provider: "local", openaiModel: DEFAULT_MODEL.openai, anthropicModel: DEFAULT_MODEL.anthropic, diary: true, diaryExternal: true,
  },
};

// ---- sanitiser -------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  allowed.includes(v as T) ? (v as T) : d;
/** Plain text only: control characters stripped, length capped. */
const text = (v: unknown, d: string, max: number) =>
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : d;
const round2 = (n: number) => Math.round(n * 100) / 100;

function hours(v: unknown, d: WorkHours): WorkHours {
  if (!isRec(v)) return { ...d };
  return {
    enabled: bool(v.enabled, d.enabled),
    start: Math.round(num(v.start, d.start, 0, 1439)),
    end: Math.round(num(v.end, d.end, 0, 1439)),
  };
}

function location(v: unknown): CompanionLocation {
  const d = DEFAULT_COMPANION.location;
  if (!isRec(v)) return { ...d };
  const lat = typeof v.lat === "number" && Math.abs(v.lat) <= 90 ? round2(v.lat) : null;
  const lon = typeof v.lon === "number" && Math.abs(v.lon) <= 180 ? round2(v.lon) : null;
  const mode = oneOf(v.mode, ["off", "city", "device"] as const, "off");
  return {
    // A mode that needs coordinates is off until it has them.
    mode: lat === null || lon === null ? "off" : mode,
    label: text(v.label, "", 60),
    lat,
    lon,
  };
}

function dates(v: unknown): ImportantDate[] {
  if (!Array.isArray(v)) return [];
  const out: ImportantDate[] = [];
  for (const d of v) {
    if (!isRec(d)) continue;
    const label = text(d.label, "", 60);
    const month = Math.round(num(d.month, 0, 0, 12));
    const day = Math.round(num(d.day, 0, 0, 31));
    if (!label || month < 1 || day < 1) continue;
    out.push({
      id: text(d.id, "", 40) || `date-${out.length}-${month}-${day}`,
      label,
      kind: oneOf(d.kind, ["birthday", "anniversary", "interview", "deadline", "event"] as const, "event"),
      month,
      day,
      year: typeof d.year === "number" && d.year >= 1970 && d.year <= 2200 ? Math.round(d.year) : null,
      dayBefore: bool(d.dayBefore, true),
    });
    if (out.length >= MAX_DATES) break;
  }
  return out;
}

function watches(v: unknown): Watch[] {
  if (!Array.isArray(v)) return [];
  const out: Watch[] = [];
  for (const w of v) {
    if (!isRec(w)) continue;
    const kind = oneOf(w.kind, ["fx", "rain-tomorrow", "keyword"] as const, "keyword");
    const base = text(w.base, "", 3).toUpperCase();
    const quote = text(w.quote, "", 3).toUpperCase();
    const phrase = text(w.phrase, "", 60);
    // A watch that could never fire is dropped rather than kept half-formed.
    if (kind === "fx" && (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote))) continue;
    if (kind === "keyword" && phrase.length < 2) continue;
    out.push({
      id: text(w.id, "", 40) || `watch-${out.length}`,
      kind,
      label: text(w.label, "", 60),
      paused: bool(w.paused, false),
      base,
      quote,
      threshold: num(w.threshold, 0, 0, 1e9),
      direction: oneOf(w.direction, ["above", "below"] as const, "above"),
      phrase,
    });
    if (out.length >= MAX_WATCHES) break;
  }
  return out;
}

export function sanitizeCompanion(raw: unknown): CompanionSettings {
  const d = DEFAULT_COMPANION;
  if (!isRec(raw)) return structuredClone(d);
  const f = isRec(raw.features) ? raw.features : {};
  const features = Object.fromEntries(
    (Object.keys(d.features) as (keyof CompanionFeatures)[]).map((k) => [k, bool(f[k], d.features[k])]),
  ) as unknown as CompanionFeatures;
  const interests = Array.isArray(raw.interests)
    ? [...new Set(raw.interests.map((i) => text(i, "", 40)).filter((i) => i.length >= 2))].slice(0, MAX_INTERESTS)
    : [];
  return {
    enabled: bool(raw.enabled, d.enabled),
    preferredName: text(raw.preferredName, "", 40),
    language: oneOf(raw.language, ["auto", "en", "hi", "hinglish"] as const, d.language),
    timeFormat: oneOf(raw.timeFormat, ["12h", "24h"] as const, d.timeFormat),
    temperature: oneOf(raw.temperature, ["c", "f"] as const, d.temperature),
    personality: oneOf(raw.personality, ["cozy", "playful", "savage", "minimal", "professional"] as const, d.personality),
    workHours: hours(raw.workHours, d.workHours),
    quietHours: hours(raw.quietHours, d.quietHours),
    features,
    location: location(raw.location),
    powerMode: oneOf(raw.powerMode, ["saver", "balanced", "performance"] as const, d.powerMode),
    internetPaused: bool(raw.internetPaused, d.internetPaused),
    importantDates: dates(raw.importantDates),
    interests,
    watches: watches(raw.watches),
    batteryGuardMuted: bool(raw.batteryGuardMuted, d.batteryGuardMuted),
    voice: voiceSettings(raw.voice),
    chat: chatSettings(raw.chat),
  };
}

function chatSettings(v: unknown): ChatSettings {
  const d = DEFAULT_COMPANION.chat;
  if (!isRec(v)) return { ...d };
  return {
    rememberUseful: bool(v.rememberUseful, d.rememberUseful),
    followUps: bool(v.followUps, d.followUps),
    gentleFollowUps: bool(v.gentleFollowUps, d.gentleFollowUps),
    style: oneOf(v.style, CONVERSATION_STYLES, d.style),
    showActiveMode: bool(v.showActiveMode, d.showActiveMode),
    debugRouting: bool(v.debugRouting, d.debugRouting),
    model: oneOf(v.model, ["auto", "standard", "lite"] as const, d.model),
    provider: oneOf(v.provider, ["local", "openai", "anthropic"] as const, d.provider),
    openaiModel: modelId(v.openaiModel, d.openaiModel),
    anthropicModel: modelId(v.anthropicModel, d.anthropicModel),
    diary: bool(v.diary, d.diary),
    diaryExternal: bool(v.diaryExternal, d.diaryExternal),
  };
}

/** A model id as providers write them ("gpt-5.6-luna", "claude-sonnet-5"); anything else falls back. */
function modelId(v: unknown, d: string): string {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(v.trim()) ? v.trim() : d;
}

function voiceSettings(v: unknown): VoiceSettings {
  const d = DEFAULT_COMPANION.voice;
  if (!isRec(v)) return { ...d };
  const shortcut = text(v.shortcut, d.shortcut, 30);
  return {
    shortcut: SHORTCUT_PATTERN.test(shortcut) ? shortcut : d.shortcut,
    insertMode: oneOf(v.insertMode, ["paste", "copy"] as const, d.insertMode),
    language: oneOf(v.language, ["auto", "en", "hi"] as const, d.language),
    spokenPunctuation: bool(v.spokenPunctuation, d.spokenPunctuation),
  };
}

/** Is a minute-of-day inside a (possibly overnight) window? */
export function inWindow(minute: number, w: WorkHours): boolean {
  if (!w.enabled || w.start === w.end) return false;
  return w.start < w.end ? minute >= w.start && minute < w.end : minute >= w.start || minute < w.end;
}
