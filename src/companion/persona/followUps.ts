//! Gentle follow-ups: "You weren't feeling great yesterday. How are you today?"
//!
//! A follow-up is a tiny record - a kind from a fixed list, when it is due,
//! when it expires. Never the conversation, never a diagnosis: "I have a
//! fever and my throat hurts" becomes { kind: "unwell" }, nothing more.
//!
//!   Follow up on things I tell you  OFF -> none, ever (and none are offered)
//!   Gentle follow-ups                OFF -> MewMuze asks first ("Want me to check in tomorrow?")
//!                                    ON  -> short-lived ones are created on their own
//!   Remember useful things           OFF -> nothing crosses sessions
//!
//! Each one is asked at most once per session, twice in all, and expires.

import type { Lang } from "../phrases";

export const FOLLOW_UP_KINDS = ["unwell", "rough_day", "stress", "interview", "presentation", "event"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export interface FollowUp {
  id: string;
  kind: FollowUpKind;
  createdAt: number;
  dueAt: number;
  expiresAt: number;
  status: "pending" | "done";
  /** Times it has been asked; it is dropped after MAX_ASKS. */
  asked: number;
  /** The conversation it came from, so "Forget this conversation" removes it. */
  conversation: string;
}

export const MAX_PENDING = 3;
const MAX_ASKS = 2;
const DAY = 86_400_000;

const DETECT: readonly (readonly [FollowUpKind, RegExp])[] = [
  ["unwell", /\b(not feeling (well|good|great)|feeling (sick|unwell|ill|terrible)|i'?m (sick|ill|unwell)|i am (sick|ill|unwell)|got (a )?(fever|cold|flu|migraine)|have (a )?(fever|cold|flu|migraine|headache)|bimaar|beemar|bukhar|tabiyat (kharab|theek nahi|thik nahi))\b|तबीयत|बुखार|बीमार/i],
  ["interview", /\b(interview|hr round|technical round)\b.{0,40}\b(tomorrow|today|tonight|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next week|kal)\b|\b(tomorrow|kal)\b.{0,30}\binterview\b/i],
  ["presentation", /\b(presentation|pitch|demo|viva|exam|test|recital|performance)\b.{0,40}\b(tomorrow|today|tonight|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next week|kal)\b|\b(tomorrow|kal)\b.{0,30}\b(presentation|pitch|exam|viva)\b/i],
  ["event", /\b(big day|surgery|operation|court date|first day at|moving (house|out)|wedding)\b.{0,30}\b(tomorrow|today|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next week|kal)\b/i],
  ["rough_day", /\b(rough day|bad day|terrible day|awful day|worst day|horrible day|bura din|kharab din)\b/i],
  ["stress", /\b(so stressed|really stressed|stressed out|overwhelmed|burn(ed|t) out|too much pressure|bahut tension)\b/i],
];

/** A follow-up worth offering in this message, if any. */
export function detectFollowUp(text: string): FollowUpKind | null {
  return DETECT.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Local midnight after `t` - "tomorrow" in the user's own day. */
function nextDay(t: number, days = 1): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + days * DAY;
}

export function makeFollowUp(kind: FollowUpKind, now: number, conversation: string, text = ""): FollowUp {
  // An interview "tomorrow" is asked about the day after it, not the morning of.
  const ahead = (kind === "interview" || kind === "presentation" || kind === "event") && /\b(tomorrow|kal)\b/i.test(text) ? 2 : 1;
  const dueAt = nextDay(now, ahead);
  return { id: `fu-${now.toString(36)}-${kind}`, kind, createdAt: now, dueAt, expiresAt: dueAt + 2 * DAY, status: "pending", asked: 0, conversation };
}

/** Add one, replacing any pending one of the same kind; never more than MAX_PENDING. */
export function addFollowUp(list: FollowUp[], f: FollowUp): FollowUp[] {
  const rest = list.filter((x) => !(x.status === "pending" && x.kind === f.kind));
  return [...rest, f].filter((x) => x.status === "pending").slice(-MAX_PENDING);
}

/** Drop expired, finished and over-asked ones. */
export function prune(list: FollowUp[], now: number): FollowUp[] {
  return list.filter((f) => f.status === "pending" && f.expiresAt > now && f.asked < MAX_ASKS);
}

/** The one follow-up to ask about now, if any is due. */
export function due(list: FollowUp[], now: number): FollowUp | null {
  return prune(list, now).find((f) => f.dueAt <= now) ?? null;
}

export function markAsked(list: FollowUp[], id: string): FollowUp[] {
  return list.map((f) => (f.id === id ? { ...f, asked: f.asked + 1 } : f));
}

export function resolve(list: FollowUp[], id: string): FollowUp[] {
  return list.filter((f) => f.id !== id);
}

export function forgetConversationFollowUps(list: FollowUp[], conversation: string): FollowUp[] {
  return list.filter((f) => f.conversation !== conversation);
}

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|please|please do|sounds good|that'?d be (nice|great)|haan|han|ha|haa|theek hai|thik hai|zaroor|bilkul|of course|why not)\b/i;
const NO = /^(no|nope|nah|no thanks|don'?t|nahi|nahin|mat|rehne do)\b/i;

/** The user's answer to "Want me to check in tomorrow?": true, false, or null (they talked about something else). */
export function answerToOffer(text: string): boolean | null {
  const t = text.trim();
  if (NO.test(t)) return false;
  if (YES.test(t)) return true;
  return null;
}

const OFFER: Record<Lang, string> = {
  en: "Want me to check in on you tomorrow?",
  hinglish: "Kal main tumhara haal poochun?",
  hi: "क्या मैं कल आपका हाल पूछूँ?",
};

export function offerLine(lang: Lang): string {
  return OFFER[lang];
}

const ASK: Record<FollowUpKind, Record<Lang, (name: string) => string>> = {
  unwell: {
    en: (n) => `You weren't feeling great yesterday. Feeling any better today${n ? `, ${n}` : ""}?`,
    hinglish: (n) => `Kal tumhari tabiyat theek nahi thi. Aaj kaisa feel ho raha hai${n ? `, ${n}` : ""}?`,
    hi: (n) => `कल आपकी तबीयत ठीक नहीं थी। आज कैसा लग रहा है${n ? `, ${n}` : ""}?`,
  },
  rough_day: {
    en: (n) => `Yesterday sounded rough. How's today going${n ? `, ${n}` : ""}?`,
    hinglish: (n) => `Kal ka din mushkil tha. Aaj kaisa ja raha hai${n ? `, ${n}` : ""}?`,
    hi: (n) => `कल का दिन मुश्किल था। आज कैसा जा रहा है${n ? `, ${n}` : ""}?`,
  },
  stress: {
    en: (n) => `You were under a lot of pressure. Is it any lighter today${n ? `, ${n}` : ""}?`,
    hinglish: (n) => `Tum kaafi pressure mein the. Aaj thoda halka laga${n ? `, ${n}` : ""}?`,
    hi: (n) => `आप काफ़ी दबाव में थे। आज कुछ हल्का लगा${n ? `, ${n}` : ""}?`,
  },
  interview: {
    en: (n) => `How did the interview go${n ? `, ${n}` : ""}?`,
    hinglish: (n) => `Interview kaisa gaya${n ? `, ${n}` : ""}?`,
    hi: (n) => `इंटरव्यू कैसा रहा${n ? `, ${n}` : ""}?`,
  },
  presentation: {
    en: (n) => `How did it go${n ? `, ${n}` : ""}? I've been curious.`,
    hinglish: (n) => `Kaisa gaya${n ? `, ${n}` : ""}? Mujhe jaanna tha.`,
    hi: (n) => `कैसा रहा${n ? `, ${n}` : ""}? मैं जानना चाहता था।`,
  },
  event: {
    en: (n) => `How did your big day go${n ? `, ${n}` : ""}?`,
    hinglish: (n) => `Tumhara bada din kaisa gaya${n ? `, ${n}` : ""}?`,
    hi: (n) => `आपका बड़ा दिन कैसा रहा${n ? `, ${n}` : ""}?`,
  },
};

export function askLine(f: FollowUp, lang: Lang, name: string): string {
  return ASK[f.kind][lang](name);
}

export function describeFollowUp(f: FollowUp): string {
  const what: Record<FollowUpKind, string> = {
    unwell: "how you're feeling",
    rough_day: "how your day is going",
    stress: "how the pressure is",
    interview: "how the interview went",
    presentation: "how it went",
    event: "how your big day went",
  };
  const when = new Date(f.dueAt).toLocaleDateString(undefined, { weekday: "long" });
  return `Check in about ${what[f.kind]} · ${when}`;
}

/** Decrypted blob -> list; anything unexpected is dropped. */
export function parseFollowUps(raw: string | null): FollowUp[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (f): f is FollowUp =>
          typeof f === "object" && f !== null &&
          FOLLOW_UP_KINDS.includes((f as FollowUp).kind) &&
          typeof (f as FollowUp).id === "string" && typeof (f as FollowUp).dueAt === "number" && typeof (f as FollowUp).expiresAt === "number" &&
          typeof (f as FollowUp).createdAt === "number" && typeof (f as FollowUp).asked === "number" && typeof (f as FollowUp).conversation === "string" &&
          (f as FollowUp).status === "pending",
      )
      .map((f) => ({ id: f.id, kind: f.kind, createdAt: f.createdAt, dueAt: f.dueAt, expiresAt: f.expiresAt, status: f.status, asked: f.asked, conversation: f.conversation }))
      .slice(-MAX_PENDING);
  } catch {
    return [];
  }
}
