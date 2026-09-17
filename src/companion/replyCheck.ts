//! A cheap check of every reply before it is final - no model involved.
//!
//! What can be repaired by removing whole sentences is repaired here: a second
//! question, a stock "I'm so sorry to hear that" opener, tips while someone is
//! venting, a reply far longer than its persona's length. What cannot - the
//! wrong language, an empty reply - asks for ONE constrained rewrite (the
//! caller decides whether to spend it; it never loops).

import { detectLanguage } from "./language";
import type { Lang } from "./phrases";

export interface ReplyContext {
  lang: Lang;
  /** Listening, not solving: tips are dropped. */
  venting: boolean;
  maxSentences: number;
  /** Language practice and translation: another language in the reply is the point. */
  anyLanguage?: boolean;
  /** MewMuze's previous reply: a sentence said last time is not said again. */
  previous?: string;
  /** Every earlier reply in this conversation: nothing said before is said again, even reworded a little. */
  earlier?: string[];
}

export interface Review {
  text: string;
  /** What was repaired or found, for the eval and the debug line. */
  issues: string[];
  /** The instruction for one rewrite, or null when the reply stands. */
  rewrite: string | null;
}

/** Template sympathy that could follow any message at all. */
const STOCK_OPENER =
  /^(?:(?:oh no|aw+|oh|ugh)[,!.]*\s*)?(?:i'?m (?:so |really |very |truly )?sorry (?:to hear|that|you|about)|that(?:'s| is| sounds| must be| must have been) (?:really |so |super |incredibly )?(?:tough|hard|frustrating|difficult|rough|awful|stressful|exhausting|annoying|overwhelming|terrible)[.!]|i (?:can |totally |completely )?understand (?:how|that|why|what)|i can (?:see|imagine) how (?:hard|tough|difficult|frustrating|painful|heartbreaking)|i hear you)/i;
/** A tip or instruction: fine for a question, wrong while someone vents. */
const ADVICE = /\b(?:try (?:to |and )?|you should|you could|consider|make sure|i'?d (?:suggest|recommend)|i (?:suggest|recommend)|here are|remember to|don'?t forget to|it'?s (?:important|a good idea) to|maybe (?:try|you|set|use|take|ask|talk)|talk to (?:someone|a friend|a professional)|take a break|let (?:them|him|her) know|prioriti[sz]e|don'?t hesitate to|focus on|stay strong)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The model talking ABOUT the conversation instead of in it - Lite once
 * answered "Okay, let's break down what the user is asking for now. The note
 * mentions that MewMuze should respond as a playful cat...". The hidden note
 * must never surface, not even paraphrased.
 */
const META = /\b(the (hidden |internal )?note (says|mentions|asks|tells)|the user (just )?(said|says|is asking|wants|asked|wrote)|let'?s break down what|as an ai\b|which translates to|mewmuze is (silently|quietly|now|just) \w+ing)|\(\s*note\s*:/i;

function split(text: string): string[] {
  return (text.match(/[^.!?।]+(?:[.!?।]+["')\]]*|$)\s*/gu) ?? [text]).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export function review(reply: string, ctx: ReplyContext): Review {
  const issues: string[] = [];
  let s = split(reply.trim());
  const keep = (next: string[], why: string) => {
    if (next.length && next.length < s.length) {
      s = next;
      issues.push(why);
    }
  };
  const meta = s.some((x) => META.test(x));
  keep(s.filter((x) => !META.test(x)), "talked about the note");
  // "You don't have to handle everything alone." twice in a row reads as a bot,
  // and so does "You deserve some rest and a snack" / "...some peace and a snack"
  // four turns running: a sentence mostly made of an earlier one's words goes.
  const said = [ctx.previous ?? "", ...(ctx.earlier ?? [])].flatMap(split).map(norm).filter(Boolean);
  const saidWords = said.map((x) => new Set(x.split(" ")));
  const seen = (x: string) => {
    const n = norm(x);
    if (said.includes(n)) return true;
    const w = n.split(" ").filter((v) => v.length > 3);
    return w.length >= 3 && saidWords.some((b) => w.filter((v) => b.has(v)).length / w.length >= 0.6);
  };
  const repeated = s.length > 0 && s.every(seen);
  keep(s.filter((x) => !seen(x)), "repeated an earlier reply");
  // A verbal tic: a three-word phrase already in two earlier replies ("you
  // deserve some" rest / peace / comfort, turn after turn).
  const grams = (t: string) => {
    const w = norm(t).split(" ");
    return new Set(w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`));
  };
  const uses = new Map<string, number>();
  for (const e of ctx.earlier ?? []) for (const g of grams(e)) uses.set(g, (uses.get(g) ?? 0) + 1);
  keep(s.filter((x) => ![...grams(x)].some((g) => (uses.get(g) ?? 0) >= 2)), "verbal tic");
  // Every tip goes - wherever it is - as long as a reaction is left to send.
  const allAdvice = ctx.venting && s.length > 0 && s.every((x) => ADVICE.test(x));
  if (ctx.venting) keep(s.filter((x) => !ADVICE.test(x)), "advice while venting");
  if (s.length >= 2 && STOCK_OPENER.test(s[0].trim())) keep(s.slice(1), "stock opener");
  // A question every single turn ("How does that feel?") reads as an interview:
  // after a reply that asked one, this one does not, if it has more to say.
  if ((ctx.previous ?? "").includes("?")) keep(s.filter((x) => !x.includes("?")), "question twice in a row");
  let asked = false;
  keep(s.filter((x) => !x.includes("?") || (asked ? false : (asked = true))), "more than one question");
  if (s.length > ctx.maxSentences && !/```|\n\s*\S+\(/.test(reply)) keep(s.slice(0, ctx.maxSentences), "too long");
  const text = s.join("").trim();

  let rewrite: string | null = null;
  const words = text.split(/\s+/).filter(Boolean).length;
  const got = detectLanguage(text);
  if (words < 2) rewrite = "Answer their message properly, in one or two sentences.";
  // Nothing but meta-talk was left: say it to them instead.
  else if (meta && s.every((x) => META.test(x))) rewrite = "Answer them directly as MewMuze, in one or two sentences - never mention notes or 'the user'.";
  else if (repeated) rewrite = "You already said this earlier. Answer their new message with something new, in one or two sentences.";
  // Nothing but tips for someone venting: trimming would leave nothing to send.
  else if (allAdvice) rewrite = "They are venting, not asking for advice. React to what happened, on their side, in one or two sentences - no tips.";
  else if (ctx.anyLanguage) rewrite = null;
  else if (ctx.lang === "hinglish" && got === "en" && words >= 6)
    rewrite = "Say the same thing in Hinglish: Hindi words written in English letters, mixed with English, the way the user writes. No Devanagari.";
  else if (ctx.lang === "hi" && got !== "hi") rewrite = "Say the same thing in Hindi, in Devanagari script.";
  else if (ctx.lang === "en" && (got === "hi" || got === "hinglish")) rewrite = "Say the same thing in English.";
  if (rewrite) issues.push(`rewrite: ${rewrite.split(":")[0]}`);
  return { text, issues, rewrite };
}
