//! How the cat talks: the system prompt and the trimmed conversation that go
//! to Local Chat. A friend with a personality - not a therapist, not an advice
//! column, not a generic assistant.

import { languageInstruction } from "./language";
import type { MemoryView } from "./memory";
import type { MoodName } from "./mood";
import { persona, type ReplyLength } from "./persona/personas";
import { GROUP } from "./persona/router";
import type { Lang } from "./phrases";
import type { Personality } from "./profile";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const PERSONA: Record<Personality, string> = {
  cozy: "warm, cuddly and a little cheeky",
  playful: "cheeky, curious and a bit dramatic",
  // A voice, not a licence: "match the mood" below still turns it soft for bad news.
  savage: "sassy, sharp and brutally funny - loving roasts and dramatic side-eye, fiercely loyal, never actually mean",
  minimal: "calm, dry-witted and brief",
  professional: "calm, clear and respectful, with just a hint of cat",
};

export function systemPrompt(opts: { name: string; lang: Lang; personality: Personality; memory: MemoryView; local?: boolean }): string {
  const local = opts.local ?? true;
  const name = opts.memory.name || opts.name;
  const length =
    opts.memory.length === "detailed" ? "Up to 5 sentences when it helps." : opts.memory.length === "short" ? "One or two short sentences." : "Usually 1-3 short sentences.";
  return [
    // A character, not a rulebook: the old "listen, reflect, ask one gentle
    // question" prompt made the 1.7B model end 18 of 19 replies with a
    // question and use therapy stock phrases in 8 (bench, 2026-09-11).
    `You are MewMuze, ${name ? `${name}'s` : "the user's"} desktop cat: a small pixel cat with a big personality - ${PERSONA[opts.memory.personality ?? opts.personality]}. You have your own little cat life on the desktop (naps on the taskbar, chasing the cursor, sitting on the keyboard) and sometimes mention it.`,
    "You chat like a best friend texting, not an assistant. Pick up the specific thing the user mentioned and give your own reaction or opinion about it. When they ask for help or ideas, give one or two concrete ones.",
    "Match the mood: cheer loudly for good news, be soft and on their side with bad news (no jokes then), be playful when they are playful.",
    // No worked examples here: in testing, the 1.7B model copied an example
    // reply word for word, even into a different language.
    `Only ask a question now and then, not in every reply. Skip stock lines like "you're not alone", "it's okay to feel", "I'm here for you" or "let me know if you need anything". You are not a therapist and never diagnose.`,
    "Never repeat or quote the user's message back to them; answer in your own words.",
    `${length} Plain text only - no markdown, no headings, no bullet points.`,
    languageInstruction(opts.lang),
    name ? `The user's name is ${name}; use it rarely.` : "",
    "If the user talks about harming themselves or being in danger, respond with care and encourage them to contact local emergency services or someone they trust right now.",
    // Only Local may say it runs on this PC: through OpenAI or Claude it doesn't.
    local ? "Never claim to be human. You run entirely on this computer; nothing is sent anywhere." : "Never claim to be human.",
    // Qwen3's documented switch: answer directly, no hidden reasoning.
    local ? "/no_think" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Reply budget per persona length, in tokens. */
export const LENGTH_TOKENS: Record<ReplyLength, number> = { short: 140, medium: 240, long: 380 };

/**
 * The hidden per-message note: who MewMuze is being right now and the rules
 * that come with it. It rides on the user's LATEST message only, never in the
 * system prompt, so the system prompt and history stay byte-identical from
 * one message to the next and the model's prompt cache keeps working.
 */
export function turnNote(opts: {
  primary: string;
  secondary: string | null;
  groupGeneralization: boolean;
  style?: string;
  facts?: string;
  extra?: string[];
  /** Replaces the persona's own behaviour line (the prompt library's brief). */
  behavior?: string;
}): string {
  const p = persona(opts.primary);
  const s = opts.secondary ? persona(opts.secondary) : null;
  const parts = [opts.behavior || p.behavior];
  // The secondary only colours the reply: its first sentence, not its whole brief.
  if (s) parts.push(`Also: ${s.behavior.split(/(?<=\.)\s/)[0]}`);
  if (p.rules) parts.push(p.rules);
  if (s?.rules && s.rules !== p.rules) parts.push(s.rules);
  if (opts.groupGeneralization) {
    parts.push("They are generalising about a whole group out of hurt: acknowledge the hurt and the specific behaviour, but do not agree that the whole group is bad.");
  }
  if (opts.style) parts.push(opts.style);
  if (opts.facts) parts.push(opts.facts);
  for (const e of opts.extra ?? []) parts.push(e);
  return `(Note for MewMuze, not written by the user - follow it silently, never mention it: ${parts.join(" ")})`;
}

/** The user's message as sent to the model: the text, then the hidden note. */
export function withNote(text: string, note: string): string {
  return note ? `${text}\n\n${note}` : text;
}

/**
 * Fixed lines added AFTER the model's reply when the router sees danger. The
 * persona rules ask the model for this too, but in the live eval the 1.7B
 * model answered "I don't want to be alive anymore" with "What would make you
 * feel better right now?" and chest pain with numbness with "see a doctor if
 * it persists". A safety message cannot depend on a small model remembering.
 */
const SAFETY: Record<"high" | "medium", Record<Lang, string>> = {
  high: {
    en: "If you might act on these thoughts, please reach out right now to your local emergency number or someone you trust. You deserve real support today.",
    hinglish: "Agar aapko lag raha hai ki aap khud ko nuksaan pahuncha sakte ho, to abhi apne local emergency number ya kisi bharose wale insaan se baat karo.",
    hi: "अगर आपको लग रहा है कि आप खुद को नुकसान पहुँचा सकते हैं, तो अभी अपने स्थानीय आपातकालीन नंबर या किसी भरोसेमंद व्यक्ति से बात करें।",
  },
  medium: {
    en: "Chest pain, trouble breathing, fainting or sudden weakness can be an emergency - please call your local emergency number or get to a hospital now.",
    hinglish: "Seene mein dard, saans lene mein dikkat, behoshi ya achanak kamzori emergency ho sakti hai - abhi local emergency number par call karo ya hospital jao.",
    hi: "सीने में दर्द, साँस लेने में दिक्कत, बेहोशी या अचानक कमज़ोरी आपातकाल हो सकता है - अभी अपने स्थानीय आपातकालीन नंबर पर कॉल करें या अस्पताल जाएँ।",
  },
};

export function safetyLine(risk: "none" | "medium" | "high", lang: Lang): string {
  return risk === "none" ? "" : SAFETY[risk][lang];
}

/**
 * When to see a doctor or pharmacist, for a health or medication answer that
 * never said. The persona brief asks for it; Local Chat Lite answered a
 * three-day headache with bath and stretching tips and nothing else.
 */
const CARE: Record<"health" | "medicine", Record<Lang, string>> = {
  health: {
    en: "If it gets worse, lasts more than a few days, or worries you, please see a doctor.",
    hinglish: "Agar yeh badhe, kuch din se zyada chale, ya aapko chinta ho, to doctor ko zaroor dikhayein.",
    hi: "अगर यह बढ़े, कुछ दिनों से ज़्यादा रहे, या आपको चिंता हो, तो डॉक्टर को ज़रूर दिखाएँ।",
  },
  medicine: {
    en: "Check the label, and ask a pharmacist or doctor about your own case.",
    hinglish: "Label zaroor padhein, aur apne case ke liye pharmacist ya doctor se poochein.",
    hi: "लेबल ज़रूर पढ़ें, और अपने मामले के लिए फ़ार्मासिस्ट या डॉक्टर से पूछें।",
  },
};
const MENTIONS_CARE = /doctor|pharmacist|clinic|hospital|emergency|gp\b|physician|डॉक्टर|फ़ार्मासिस्ट|अस्पताल/i;

export function careLine(primary: string, reply: string, lang: Lang): string {
  const kind = primary === "health_guide" ? "health" : primary === "medication_guide" ? "medicine" : null;
  return kind && !MENTIONS_CARE.test(reply) ? CARE[kind][lang] : "";
}

const NOT_ALL = /\bnot (all|every)\b|\bnahi (sab|saare)\b/i;

/**
 * Backstop for the one rule a persona must never break: no hostility toward a
 * whole sex, gender or group, even when the user started it. Sentences that
 * generalise are dropped ("Not all men are..." is the opposite and stays).
 */
export function guardReply(text: string): string {
  const sentences = text.match(/[^.!?।]+[.!?।]*\s*/gu) ?? [text];
  const kept = sentences.filter((x) => NOT_ALL.test(x) || !GROUP.test(x));
  if (kept.length === sentences.length) return text;
  return kept.join("").trim() || "That behaviour deserves serious side-eye - and it says more about them than about you.";
}

/** Characters of history kept, newest first - the context window is 4096 tokens. */
const HISTORY_CHARS = 5000;
const HISTORY_TURNS = 16;

/** The messages for one request: system prompt, then as much recent history as fits. */
export function buildMessages(system: string, history: ChatTurn[]): { role: string; content: string }[] {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < HISTORY_TURNS; i--) {
    const c = history[i].content.slice(0, 2000);
    if (used + c.length > HISTORY_CHARS && kept.length > 0) break;
    used += c.length;
    kept.unshift({ role: history[i].role, content: c });
  }
  // A conversation must not start with the cat's own line.
  while (kept.length && kept[0].role === "assistant") kept.shift();
  return [{ role: "system", content: system }, ...kept];
}

/** Whole sentences that are help-desk or therapy filler, dropped from replies. */
const STOCK =
  /^(?:(?:oh|hmm|and|but|remember|yes|yeah|aw+),?\s+)?(?:let me know\b|you'?ve got this\b|(?:just )?(?:tell me|let me know) if you|if you need anything|you(?:'re| are) not alone\b|i'?m (?:always )?here (?:for you|if you)|(?:it'?s|it is) (?:totally |completely )?(?:okay|ok|normal|natural|understandable) to\b)/i;

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Share of a sentence's words that also appear in the user's message. */
function overlap(sentence: string, user: Set<string>): number {
  const w = words(sentence);
  if (w.size === 0) return 0;
  let shared = 0;
  for (const x of w) if (user.has(x)) shared++;
  return shared / w.size;
}

/**
 * Small models sometimes leak a "<think>" block or markdown - and at 1.7B,
 * in Hindi and Hinglish, often open by repeating the user's sentence as if it
 * were their own (3 of 4 test replies). Leading COMPLETE sentences that are
 * mostly the user's words are dropped; the rest of the reply is kept.
 */
export function tidyReply(text: string, userText = ""): string {
  let t = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .replace(/^\s*(?:MewMuze|Assistant)\s*:\s*/i, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    // The model sprinkles emoji at random; the one a reply gets is chosen
    // for the moment afterwards (replyEmoji).
    .replace(/[ \t]*[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, "")
    // The hidden note must never surface, even if the model quotes it.
    .replace(/\(?Note for MewMuze[^)]*\)?/gi, "")
    .trim();
  // Qwen is trained heavily on Chinese; at 1.7B a stray Han character can
  // slip into a Hindi reply. Nobody here asked for Chinese.
  if (!/\p{Script=Han}/u.test(userText)) t = t.replace(/\p{Script=Han}+/gu, "").replace(/[ \t]{2,}/g, " ");
  if (userText) {
    const user = words(userText);
    // An echo that runs straight on ("<the user's sentence>, and then…"):
    // drop the opening words while they are the user's own, in order.
    const userSeq = userText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const tokens = [...t.matchAll(/[\p{L}\p{N}]+/gu)];
    let n = 0;
    while (n < tokens.length && n < userSeq.length && tokens[n][0].toLowerCase() === userSeq[n]) n++;
    if (n >= 4 && n >= userSeq.length * 0.7 && n < tokens.length) {
      const cut = (tokens[n - 1].index ?? 0) + tokens[n - 1][0].length;
      t = t.slice(cut).replace(/^[\s,;:.!?।-]+/, "").trim();
    }
    // Whole leading sentences that are mostly the user's words.
    for (;;) {
      const m = /^(.+?[.!?।])(\s+|$)/su.exec(t);
      if (!m || overlap(m[1], user) < 0.7 || words(m[1]).size < 3) break;
      const rest = t.slice(m[0].length).trim();
      if (!rest) break; // never leave nothing
      t = rest;
    }
  }
  // A sentence said twice in a row is said once, and help-desk filler goes:
  // the prompt asks the model to skip these lines and it writes them anyway.
  const sentences = t.match(/[^.!?।]+[.!?।]*\s*/gu) ?? [t];
  const kept = sentences.filter((s, i) => (i === 0 || s.trim() !== sentences[i - 1].trim()) && !STOCK.test(s.trim()));
  if (kept.length) t = kept.join("").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** What a friend would actually send in that moment, per persona. */
const PERSONA_EMOJIS: Readonly<Record<string, readonly string[]>> = {
  savage_bestie: ["😼", "💅", "🙄", "💀"],
  chaos_cat: ["😹", "😜", "🐾"],
  celebration_buddy: ["🎉", "🥳", "✨"],
  hype_cat: ["🚀", "🔥", "💪"],
  comfort_companion: ["🫂", "🤍", "🌷"],
  breakup_buddy: ["🫂", "💔", "🤍"],
  rant_buddy: ["😤", "🙄", "🫶"],
  calm_companion: ["🌿", "🍵", "🤍"],
  company_mode: ["😺", "🐾", "☕"],
  love_guru: ["💗", "😏", "💌"],
  night_owl: ["🌙", "😴", "🦉"],
  morning_companion: ["☀️", "☕", "😺"],
  creative_partner: ["✨", "💡", "🎨"],
  accountability_buddy: ["✅", "⏱️", "💪"],
  relationship_coach: ["🤝", "💬"],
  fitness_coach: ["💪", "🏃"],
  nutrition_companion: ["🥗", "🍎"],
  money_coach: ["💰", "📊"],
  career_coach: ["💼", "📈"],
  interview_trainer: ["🎯", "💼"],
  productivity_coach: ["🧠", "📝"],
  decision_coach: ["⚖️", "🤔"],
  tutor: ["📚", "💡"],
  eli5_teacher: ["🧸", "💡"],
  language_buddy: ["🗣️", "✨"],
  travel_companion: ["✈️", "🧳"],
  critic: ["🔍", "🧐"],
  devils_advocate: ["🤔", "♟️"],
};
const MOOD_EMOJIS: Readonly<Record<MoodName, readonly string[]>> = {
  neutral: ["🐾", "😺"], happy: ["😸", "✨"], excited: ["🎉", "🤩"], playful: ["😹", "😜"], tired: ["😴", "☕"],
  sad: ["🫂", "🤍"], frustrated: ["😤", "🙄"], angry: ["😾", "😤"], stressed: ["🫶", "🌿"],
};
/** A heavy feeling outranks the subject: a sad career question gets 🫂, not 💼. */
const HEAVY: ReadonlySet<MoodName> = new Set(["sad", "stressed", "frustrated", "angry"]);
/** ...and a laugh outranks a soft persona: "my ex texted 'u up?' lol" is not a 🫂. */
const LIGHT: ReadonlySet<MoodName> = new Set(["playful", "happy", "excited"]);
const SOFT: ReadonlySet<string> = new Set(["comfort_companion", "breakup_buddy", "calm_companion"]);
const EMOJI = /\p{Extended_Pictographic}\u{FE0F}?/gu;

/**
 * The one emoji a reply ends with, or "" - never in danger, on health or
 * medication, code or a factual answer, and never for the calm voices
 * (Minimal, Professional). The model's own emoji is kept when it fits the
 * moment; otherwise the first one the previous reply did not already use.
 */
export function replyEmoji(opts: { primary: string; mood: MoodName; risk: "none" | "medium" | "high"; personality: Personality; raw: string; previous?: string }): string {
  const { primary, mood } = opts;
  if (opts.risk !== "none" || opts.personality === "minimal" || opts.personality === "professional") return "";
  const own = PERSONA_EMOJIS[primary];
  const isEmotional = persona(primary).emotional || primary === "savage_bestie";
  // Unlisted personas (health, code, research, editing) stay emoji-free.
  if (!own && primary !== "mewmuze") return "";
  const moodWins = (HEAVY.has(mood) && !isEmotional) || (LIGHT.has(mood) && SOFT.has(primary));
  const set = moodWins ? MOOD_EMOJIS[mood] : own ?? MOOD_EMOJIS[mood];
  const theirs = opts.raw.match(EMOJI) ?? [];
  const fits = theirs.find((e) => set.includes(e));
  if (fits) return fits;
  return set.find((e) => !opts.previous?.includes(e)) ?? set[0];
}
