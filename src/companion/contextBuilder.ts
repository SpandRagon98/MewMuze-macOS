//! Everything that goes into ONE reply, assembled in one place.
//!
//!   system prompt        who MewMuze is - byte-identical across the chat, so
//!                        llama-server's prompt cache is reused
//!   trimmed history      as much recent conversation as fits
//!   hidden turn note     on the latest user message only: the persona brief,
//!                        its shape and example (promptLibrary), how they like
//!                        to be talked to, live facts, follow-up context, what
//!                        MewMuze just did (so it does not repeat itself), and
//!                        the reply language LAST, right before generation
//!   sampling             per persona: temperature, top-p, token budget, and
//!                        the writing system the reply must stay in
//!   check                what replyCheck.review holds the reply to

import { buildMessages, LENGTH_TOKENS, turnNote, withNote, type ChatTurn } from "./chatPrompt";
import { HINGLISH, languageInstruction } from "./language";
import type { Msg, ReplyOptions } from "./localAI";
import { persona, temperatureFor, type ReplyLength } from "./persona/personas";
import { briefForbidsAdvice, guideNote } from "./persona/promptLibrary";
import { styleNote, type StyleTraits } from "./persona/style";
import type { Mood, MoodName } from "./mood";
import type { Lang } from "./phrases";
import type { ReplyContext } from "./replyCheck";

export interface TurnInput {
  system: string;
  /** The conversation so far, ending with the user's new message. */
  history: ChatTurn[];
  who: { primary: string; secondary: string | null };
  groupGeneralization: boolean;
  /** The user is venting (not asking): listen before solving. */
  venting: boolean;
  lang: Lang;
  learned: StyleTraits;
  /** An explicit "keep it short" / "more detail" from memory. */
  preferredLength?: "short" | "detailed";
  facts?: string;
  extra?: string[];
  /** How they seem to feel, read by the router: the reply reacts to it first. */
  mood?: Mood;
}

export interface Turn {
  messages: Msg[];
  maxTokens: number;
  temperature: number;
  options: ReplyOptions;
  check: ReplyContext;
}

const SENTENCES: Record<ReplyLength, number> = { short: 3, medium: 5, long: 12 };
const LENGTH_NOTE: Record<ReplyLength, string> = {
  short: "One to three short sentences.",
  medium: "Two to four sentences.",
  long: "No padding.",
};

/**
 * One line on the feeling behind the message. Personas cover the obvious
 * cases; this is what makes a practical answer ("how do I ask for a raise")
 * still land right when it was written in a fury.
 */
const FEEL: Record<Exclude<MoodName, "neutral">, string> = {
  happy: "match their good mood",
  excited: "match their excitement, loudly",
  playful: "they are joking around: be witty back",
  tired: "keep it gentle and light",
  sad: "open by gently naming that feeling in your own words; no jokes",
  stressed: "be steady and calming first",
  frustrated: "take their side about it first",
  angry: "take their side first; do not tell them to calm down",
};
export function feelingNote(mood: Mood | undefined): string {
  if (!mood || mood.mood === "neutral") return "";
  return `They sound ${mood.intensity > 0.6 ? "very " : ""}${mood.mood}: ${FEEL[mood.mood]}.`;
}

/** Personas whose replies may legitimately use another language or script. */
const MULTILINGUAL = new Set(["language_buddy"]);
const OTHER_LANGUAGE = /\b(translate|translation|in hindi|in devanagari|hindi script|in english|in spanish|in french|in german|in japanese|how do (you|i) say)\b|हिंदी में/i;

/** Top-p by persona: tighter for safety topics, looser for creative play. */
export function topPFor(primary: string, secondary: string | null): number {
  const p = persona(primary);
  if (p.safety || (secondary && persona(secondary).safety)) return 0.7;
  return p.bucket === "playful" || primary === "creative_partner" ? 0.9 : 0.8;
}

const STOP = new Set(
  ("about after again also always because been before being could didn't does doesn't doing done don't from have haven't having into isn't it's just know like make made more most much need only other over really same should some such than that that's their them then there these they this those through today under until very want wasn't what when where which while will with won't would your yours i'm i've i'll can't myself anything something everything nothing thing things feel feels feeling " +
    // Hinglish function words beyond the language detector's list.
    "karta karti karte kiya kiye liye mein wale wala wali apna apni apne uska uski unka unki isko usko yeh woh").split(" "),
);

/**
 * The words that make this message THIS message - "instagram", "leftovers" -
 * for the model to pick up on. In the eval, a third of replies to feelings
 * could have been sent to anyone ("I can see how hard that must be").
 */
export function keyWords(text: string, n = 3): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{M}\p{N}']+/gu) ?? []) {
    if (w.length < 4 || STOP.has(w) || HINGLISH.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  // The longest words carry the most meaning: "instagram" before "keep".
  return out.sort((a, b) => b.length - a.length).slice(0, n);
}

/** What MewMuze just did, so it does not do it again. */
function conversationNotes(history: ChatTurn[]): string[] {
  const last = [...history].reverse().find((t) => t.role === "assistant")?.content;
  if (!last) return [];
  const notes: string[] = [];
  if (last.includes("?")) notes.push("You asked a question last time: no question now.");
  const opener = last.match(/[\p{L}']+/gu)?.slice(0, 2).join(" ");
  if (opener) notes.push(`Don't start with "${opener}" again.`);
  return notes;
}

export function buildTurn(t: TurnInput): Turn {
  const p = persona(t.who.primary);
  const length: ReplyLength =
    t.preferredLength === "short" || t.learned.length === "short" ? "short" : t.preferredLength === "detailed" ? "long" : p.length;
  const message = t.history[t.history.length - 1]?.content ?? "";
  const anyLanguage = MULTILINGUAL.has(t.who.primary) || OTHER_LANGUAGE.test(message);
  const words = keyWords(message);

  // Every word here is read before the first word of the reply (~80 tokens a
  // second on this CPU), so each line says one thing, once.
  const extra = [
    feelingNote(t.mood),
    t.venting && !briefForbidsAdvice(t.who.primary) ? "Listen only: no tips unless they asked." : "",
    ...conversationNotes(t.history.slice(0, -1)),
    ...(t.extra ?? []),
    // Near the end, where a small model still has it in mind when it starts writing.
    words.length ? `Your reply must mention what they said (${words.map((w) => `"${w}"`).join(", ")}) in your own words.` : "",
    LENGTH_NOTE[length],
    // The language again, LAST - right before the model starts writing. In the
    // live eval Hinglish came back in English 7 times in 12 with it only in the
    // system prompt.
    t.lang !== "en" ? languageInstruction(t.lang) : "",
  ].filter(Boolean);
  const note = turnNote({
    primary: t.who.primary, secondary: t.who.secondary, groupGeneralization: t.groupGeneralization, style: styleNote(t.learned), facts: t.facts, extra,
    behavior: guideNote(t.who.primary),
  });
  const sent = [...t.history.slice(0, -1), { role: "user" as const, content: withNote(message, note) }];

  return {
    messages: buildMessages(t.system, sent),
    maxTokens: LENGTH_TOKENS[length],
    temperature: temperatureFor(t.who.primary, t.who.secondary),
    options: {
      topP: topPFor(t.who.primary, t.who.secondary),
      // Hindi stays in Devanagari, everything else in Latin letters - unless
      // another language is the point of the conversation.
      script: anyLanguage ? undefined : t.lang === "hi" ? "devanagari" : "latin",
    },
    check: {
      lang: t.lang, venting: t.venting, maxSentences: SENTENCES[length], anyLanguage,
      previous: [...t.history.slice(0, -1)].reverse().find((h) => h.role === "assistant")?.content,
      earlier: t.history.filter((h) => h.role === "assistant").map((h) => h.content),
    },
  };
}

/** The one constrained rewrite: the same conversation, the draft, and exactly what to change. */
export function rewriteMessages(turn: Turn, draft: string, instruction: string): Msg[] {
  return [
    ...turn.messages,
    { role: "assistant", content: draft },
    { role: "user", content: `(Note for MewMuze, not written by the user - follow it silently, never mention it: ${instruction} Keep what you meant and stay just as short. Reply with the new version only.)` },
  ];
}
