//! How the user likes to be talked to - learned slowly, never about who they are.
//!
//! A handful of averages over the user's own messages: how long they write,
//! how casual, how much they joke or use emoji, whether they ask for it
//! straight, which language, whether they mind questions. Nothing else can be
//! stored: the profile has exactly these fields (STYLE_KEYS), so identity
//! attributes - religion, politics, health, sexuality and the like - have
//! nowhere to go. Explicit choices (Settings, "keep it short") always win.

export interface StyleProfile {
  /** Messages learned from. Nothing is applied before MIN_SAMPLES. */
  n: number;
  /** Average words per message. */
  words: number;
  /** 0 formal .. 1 casual. */
  casual: number;
  humour: number;
  emoji: number;
  /** -1 gentle .. 1 direct. Only moves on explicit asks. */
  direct: number;
  /** Share of messages in each language. */
  en: number;
  hi: number;
  hinglish: number;
  /** 0 "stop asking me questions" .. 1 happy to be asked. */
  questions: number;
}

export const STYLE_KEYS = ["n", "words", "casual", "humour", "emoji", "direct", "en", "hi", "hinglish", "questions"] as const;

export const EMPTY_STYLE: StyleProfile = { n: 0, words: 12, casual: 0.5, humour: 0.2, emoji: 0.1, direct: 0, en: 0, hi: 0, hinglish: 0, questions: 0.5 };

/** Learn conservatively: a trait needs this many messages behind it. */
export const MIN_SAMPLES = 8;
const ALPHA = 0.1;

const CASUAL = /\b(lol|lmao|yaar|bro|dude|gonna|wanna|gotta|ya|u|ur|pls|plz|btw|idk|tbh|haha|hehe|ok+)\b/i;
const FORMAL = /\b(please|kindly|could you|would you|thank you|regards|dear|sir|madam)\b/i;
const LAUGH = /\b(lol|lmao|rofl|haha+|hehe+)\b|😂|🤣|😆/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const DIRECT = /\b(just tell me|get to the point|be (direct|blunt|honest)|straight answer|no fluff|seedha bolo|bina ghumaye)\b/i;
const GENTLE = /\b(be gentle|go easy|be kind|softly|dheere se)\b/i;
const NO_QUESTIONS = /\b(stop asking (me )?(so many )?questions|don'?t ask me (questions|anything)|no more questions|sawal mat pucho)\b/i;
const MORE_QUESTIONS = /\b(ask me (more|anything)|ask me questions)\b/i;

const ema = (old: number, x: number) => old + ALPHA * (x - old);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fold one message in. The text is read and dropped: only the averages remain. */
export function learn(p: StyleProfile, text: string, lang: "en" | "hi" | "hinglish" | null): StyleProfile {
  const words = (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
  if (words === 0) return p;
  const casualHit = CASUAL.test(text) || (text === text.toLowerCase() && /[a-z]/.test(text) && !/[.!?]$/.test(text.trim()));
  const next: StyleProfile = {
    ...p,
    n: p.n + 1,
    words: ema(p.words, Math.min(words, 80)),
    casual: ema(p.casual, FORMAL.test(text) ? 0 : casualHit ? 1 : 0.5),
    humour: ema(p.humour, LAUGH.test(text) ? 1 : 0),
    emoji: ema(p.emoji, EMOJI.test(text) ? 1 : 0),
    // Directness only moves when they say so - a curt message may just be a busy day.
    direct: DIRECT.test(text) ? clamp(p.direct + 0.5, -1, 1) : GENTLE.test(text) ? clamp(p.direct - 0.5, -1, 1) : p.direct,
    questions: NO_QUESTIONS.test(text) ? 0 : MORE_QUESTIONS.test(text) ? 1 : p.questions,
    en: lang ? ema(p.en, lang === "en" ? 1 : 0) : p.en,
    hi: lang ? ema(p.hi, lang === "hi" ? 1 : 0) : p.hi,
    hinglish: lang ? ema(p.hinglish, lang === "hinglish" ? 1 : 0) : p.hinglish,
  };
  return next;
}

export interface StyleTraits {
  length?: "short" | "detailed";
  tone?: "casual" | "formal";
  humour?: boolean;
  emoji?: boolean;
  directness?: "direct" | "gentle";
  language?: "en" | "hi" | "hinglish";
  fewQuestions?: boolean;
}

/**
 * What has been learned firmly enough to use. Explicit asks ("stop asking
 * questions", "be direct") apply at once; habits wait for MIN_SAMPLES.
 */
export function traits(p: StyleProfile): StyleTraits {
  const t: StyleTraits = {};
  if (p.direct >= 0.5) t.directness = "direct";
  else if (p.direct <= -0.5) t.directness = "gentle";
  if (p.questions <= 0.2) t.fewQuestions = true;
  if (p.n < MIN_SAMPLES) return t;
  if (p.words <= 7) t.length = "short";
  else if (p.words >= 30) t.length = "detailed";
  if (p.casual >= 0.7) t.tone = "casual";
  else if (p.casual <= 0.3) t.tone = "formal";
  if (p.humour >= 0.35) t.humour = true;
  if (p.emoji >= 0.4) t.emoji = true;
  const top = (["en", "hi", "hinglish"] as const).reduce((a, b) => (p[b] > p[a] ? b : a));
  if (p[top] >= 0.7) t.language = top;
  return t;
}

/** One short line for the model, or "" when nothing is known yet. */
export function styleNote(t: StyleTraits): string {
  const bits: string[] = [];
  if (t.length === "short") bits.push("keep it brief");
  if (t.length === "detailed") bits.push("a bit more detail is welcome");
  if (t.tone === "casual") bits.push("casual tone");
  if (t.tone === "formal") bits.push("polite, tidy tone");
  if (t.humour) bits.push("they enjoy humour when the moment is light");
  if (t.emoji) bits.push("one emoji is fine");
  if (t.directness === "direct") bits.push("be direct, no fluff");
  if (t.directness === "gentle") bits.push("be gentle");
  if (t.fewQuestions) bits.push("do not ask questions unless essential");
  return bits.length ? `How they like to be talked to: ${bits.join("; ")}.` : "";
}

/** Plain lines for "What MewMuze remembers". */
export function describeTraits(t: StyleTraits): string[] {
  const out: string[] = [];
  if (t.length) out.push(t.length === "short" ? "Learned: you like short replies" : "Learned: you like more detail");
  if (t.tone) out.push(t.tone === "casual" ? "Learned: casual tone" : "Learned: polite tone");
  if (t.humour) out.push("Learned: you enjoy some humour");
  if (t.emoji) out.push("Learned: an emoji now and then is fine");
  if (t.directness) out.push(t.directness === "direct" ? "Learned: you like it straight" : "Learned: you like it gentle");
  if (t.fewQuestions) out.push("Learned: fewer questions");
  if (t.language) out.push(`Learned: you usually write in ${{ en: "English", hi: "Hindi", hinglish: "Hinglish" }[t.language]}`);
  return out;
}

/** Decrypted blob -> profile. Unknown keys are dropped, values clamped. */
export function parseStyle(raw: string | null): StyleProfile {
  if (!raw) return EMPTY_STYLE;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...EMPTY_STYLE };
    for (const k of STYLE_KEYS) {
      const x = v[k];
      if (typeof x === "number" && Number.isFinite(x)) out[k] = k === "n" ? Math.max(0, Math.floor(x)) : k === "words" ? clamp(x, 0, 80) : k === "direct" ? clamp(x, -1, 1) : clamp(x, 0, 1);
    }
    return out;
  } catch {
    return EMPTY_STYLE;
  }
}
