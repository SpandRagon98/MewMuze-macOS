//! Which language the user is writing in, so the cat can answer in the same one.
//!
//! English, Hindi (Devanagari) and Hinglish (Hindi in Latin letters, usually
//! mixed with English). Deterministic and cheap: script, then a short list of
//! Hindi function words that rarely occur in English.

import type { Lang } from "./phrases";

const DEVANAGARI = /[ऀ-ॿ]/g;

/** Romanised Hindi words that are not also common English words. */
export const HINGLISH = new Set([
  "hai", "hain", "hoon", "hu", "tha", "thi", "kya", "kyun", "kyu", "kaise", "kaisa", "kaisi", "kab", "kahan",
  "nahi", "nahin", "mujhe", "mera", "meri", "mere", "tum", "tumhe", "tera", "teri", "aap", "aapka", "hum",
  "humein", "acha", "accha", "achha", "yaar", "bahut", "bohot", "bhot", "thoda", "kuch", "abhi", "raha", "rahi",
  "rahe", "karna", "karo", "kar", "gaya", "gayi", "gaye", "bhi", "lekin", "aaj", "kal", "bas", "haan", "sab",
  "wala", "wali", "matlab", "chal", "chalo", "hota", "hoti", "sakta", "sakti", "chahiye", "pata", "samajh", "dost",
  "ghar", "kaam", "sach", "bilkul", "zyada", "jaldi", "phir", "arre", "arey", "na", "hoga", "hogi",
]);

export function detectLanguage(text: string): Lang | null {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return null;
  const deva = (text.match(DEVANAGARI) ?? []).length;
  if (deva / letters.length > 0.3) return "hi";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return null;
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  if (hits >= 2 || (hits >= 1 && words.length <= 4) || hits / words.length >= 0.15) return "hinglish";
  // "ok", "yes", "hmm lol" say nothing about the language: keep the conversation's.
  if (words.length < 3) return null;
  return "en";
}

/**
 * The language to answer in: whatever the user just wrote in; if that is
 * unclear (an emoji, "ok"), the language of the conversation so far; then the
 * profile's choice.
 */
export function replyLanguage(latest: string, previous: Lang | null, profile: Lang): Lang {
  return detectLanguage(latest) ?? previous ?? profile;
}

export function languageInstruction(lang: Lang): string {
  switch (lang) {
    case "hi":
      return "Reply in Hindi, written in Devanagari script.";
    case "hinglish":
      // No sample sentence: the 1.7B model pasted one into its reply word for
      // word. The grammar in local_ai.rs rules out Devanagari anyway.
      return "Reply in Hinglish, the way the user writes: Hindi words in English letters, mixed with English. Not pure English, and no Devanagari.";
    default:
      return "Reply in English.";
  }
}
