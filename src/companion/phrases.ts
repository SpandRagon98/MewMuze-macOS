//! The companion's voice: greetings and headings in the user's language and
//! the chosen personality.
//!
//! Deliberately a small table, not a translation framework. Phase 1 localises
//! what the cat SAYS unprompted - greetings, "welcome back", My Day's heading.
//! Detailed notices (a meeting title, an email subject) are the user's own
//! data and are shown as-is.

import type { CompanionLanguage, Personality } from "./profile";
import type { DayPart } from "./clock";

export type Lang = "en" | "hi" | "hinglish";

/** "auto" follows the OS language: Hindi for hi-*, English otherwise. */
export function resolveLang(pref: CompanionLanguage, osLanguage: string = navigatorLanguage()): Lang {
  if (pref !== "auto") return pref;
  return osLanguage.toLowerCase().startsWith("hi") ? "hi" : "en";
}

function navigatorLanguage(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
}

const withName = (base: string, name: string, sep = ", ") => (name ? `${base}${sep}${name}` : base);

type Table = Record<Lang, Record<Personality, (name: string) => string>>;

const GREETINGS: Record<DayPart, Table> = {
  morning: {
    en: {
      cozy: (n) => `${withName("Good morning", n)} ☀️`,
      playful: (n) => `${withName("Morning", n)}! Ready to pounce on the day? 🐾`,
      savage: (n) => `${withName("Morning", n)}. Coffee first, excuses later ☕😼`,
      minimal: (n) => `${withName("Morning", n)}.`,
      professional: (n) => `${withName("Good morning", n)}.`,
    },
    hi: {
      cozy: (n) => `${withName("सुप्रभात", n)} ☀️`,
      playful: (n) => `${withName("सुप्रभात", n)}! आज क्या करें? 🐾`,
      savage: (n) => `${withName("सुप्रभात", n)}! पहले चाय, फिर बहाने ☕😼`,
      minimal: (n) => `${withName("सुप्रभात", n)}।`,
      professional: (n) => `${withName("सुप्रभात", n)}।`,
    },
    hinglish: {
      cozy: (n) => `${withName("Good morning", n)}! ☀️`,
      playful: (n) => `${withName("Good morning", n)}! Chalo, din shuru karein? 🐾`,
      savage: (n) => `${withName("Good morning", n)}! Pehle chai, phir bahane ☕😼`,
      minimal: (n) => `${withName("Morning", n)}.`,
      professional: (n) => `${withName("Good morning", n)}.`,
    },
  },
  afternoon: {
    en: {
      cozy: (n) => `${withName("Good afternoon", n)} 🌤️`,
      playful: (n) => `${withName("Afternoon", n)}! Snack break soon? 🍪`,
      savage: (n) => `${withName("Afternoon", n)}. Working, or just looking busy? 😼`,
      minimal: (n) => `${withName("Afternoon", n)}.`,
      professional: (n) => `${withName("Good afternoon", n)}.`,
    },
    hi: {
      cozy: (n) => `${withName("नमस्ते", n)} 🌤️`,
      playful: (n) => `${withName("नमस्ते", n)}! दोपहर कैसी चल रही है? 🍪`,
      savage: (n) => `${withName("नमस्ते", n)}! काम हो रहा है या बस दिखावा? 😼`,
      minimal: (n) => `${withName("नमस्ते", n)}।`,
      professional: (n) => `${withName("नमस्ते", n)}।`,
    },
    hinglish: {
      cozy: (n) => `${withName("Good afternoon", n)}! 🌤️`,
      playful: (n) => `${withName("Hey", n)}! Lunch ho gaya? 🍪`,
      savage: (n) => `${withName("Hey", n)}! Kaam ho raha hai ya bas acting? 😼`,
      minimal: (n) => `${withName("Afternoon", n)}.`,
      professional: (n) => `${withName("Good afternoon", n)}.`,
    },
  },
  evening: {
    en: {
      cozy: (n) => `${withName("Good evening", n)} 🌆`,
      playful: (n) => `${withName("Evening", n)}! Almost cozy time 🛋️`,
      savage: (n) => `${withName("Evening", n)}. You survived the day. Barely 💅`,
      minimal: (n) => `${withName("Evening", n)}.`,
      professional: (n) => `${withName("Good evening", n)}.`,
    },
    hi: {
      cozy: (n) => `${withName("शुभ संध्या", n)} 🌆`,
      playful: (n) => `${withName("शुभ संध्या", n)}! शाम हो गई 🛋️`,
      savage: (n) => `${withName("शुभ संध्या", n)}! दिन निकल गया, किसी तरह 💅`,
      minimal: (n) => `${withName("शुभ संध्या", n)}।`,
      professional: (n) => `${withName("शुभ संध्या", n)}।`,
    },
    hinglish: {
      cozy: (n) => `${withName("Good evening", n)}! 🌆`,
      playful: (n) => `${withName("Good evening", n)}! Shaam ho gayi 🛋️`,
      savage: (n) => `${withName("Good evening", n)}! Din nikal gaya, kaise bhi 💅`,
      minimal: (n) => `${withName("Evening", n)}.`,
      professional: (n) => `${withName("Good evening", n)}.`,
    },
  },
  late: {
    en: {
      cozy: (n) => `Still up${n ? `, ${n}` : ""}? 🌙`,
      playful: (n) => `Still up${n ? `, ${n}` : ""}? Night owl mode 🦉`,
      savage: (n) => `Still up${n ? `, ${n}` : ""}? Your sleep schedule called. It's crying 🙄🌙`,
      minimal: (n) => `Still up${n ? `, ${n}` : ""}?`,
      professional: (n) => `Working late${n ? `, ${n}` : ""}?`,
    },
    hi: {
      cozy: (n) => `${n ? `${n}, ` : ""}अभी तक जाग रहे हो? 🌙`,
      playful: (n) => `${n ? `${n}, ` : ""}अभी तक जाग रहे हो? उल्लू मोड! 🦉`,
      savage: (n) => `${n ? `${n}, ` : ""}अभी तक जाग रहे हो? नींद रो रही है 🙄🌙`,
      minimal: (n) => `${n ? `${n}, ` : ""}अभी तक जाग रहे हो?`,
      professional: (n) => `${n ? `${n}, ` : ""}देर तक काम?`,
    },
    hinglish: {
      cozy: (n) => `${n ? `${n}, ` : ""}abhi tak jaag rahe ho? 🌙`,
      playful: (n) => `${n ? `${n}, ` : ""}abhi tak jaag rahe ho? Night owl! 🦉`,
      savage: (n) => `${n ? `${n}, ` : ""}abhi tak jaag rahe ho? Neend ro rahi hai 🙄🌙`,
      minimal: (n) => `Still up${n ? `, ${n}` : ""}?`,
      professional: (n) => `Late night${n ? `, ${n}` : ""}?`,
    },
  },
};

export function greeting(part: DayPart, lang: Lang, personality: Personality, name: string): string {
  return GREETINGS[part][lang][personality](name.trim());
}

const WELCOME: Record<Lang, (name: string) => string> = {
  en: (n) => `${withName("Welcome back", n)}.`,
  hi: (n) => `${withName("वापसी पर स्वागत है", n)}।`,
  hinglish: (n) => `${withName("Welcome back", n)}!`,
};

export function welcomeBack(lang: Lang, name: string): string {
  return WELCOME[lang](name.trim());
}

const AWAY_HEADING: Record<Lang, string> = {
  en: "While you were away:",
  hi: "जब आप दूर थे:",
  hinglish: "Jab aap away the:",
};

export function awayHeading(lang: Lang): string {
  return AWAY_HEADING[lang];
}

const WRAP_UP: Record<Lang, string> = {
  en: "Looks like you're wrapping up.",
  hi: "लगता है आज का काम पूरा हुआ।",
  hinglish: "Lagta hai aaj ka kaam wrap up ho raha hai.",
};

export function wrapUpHeading(lang: Lang): string {
  return WRAP_UP[lang];
}
