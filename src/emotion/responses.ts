//! How MewMuze responds to how the user seems to feel - not a mirror.
//!
//! A friend does not burst into tears when you are sad: they soften and stay
//! close. So the chat's mood label (companion/mood.ts) is mapped to a RESPONSE
//! emotion, and the active persona adds a bias (Savage Bestie leans smug,
//! Health Guide leans attentive) without locking the cat into one face.

import type { MoodName } from "../companion/mood";
import type { EmotionId } from "./emotions";
import type { GestureId } from "./gestures";

export interface Response {
  emotion: EmotionId;
  intensity: number;
  secondary?: { emotion: EmotionId; intensity: number };
}

/** The user's mood → what the cat does about it. */
export function respondToMood(mood: MoodName, intensity: number): Response | null {
  const i = Math.max(0, Math.min(1, intensity));
  if (i < 0.15) return null;
  switch (mood) {
    case "sad":
      // Gentle and close; a little of the sadness shows at the brows when it is strong.
      return { emotion: "comforting", intensity: 0.55 + i * 0.4, secondary: i > 0.6 ? { emotion: "sad", intensity: 0.35 } : undefined };
    case "stressed":
      return { emotion: "comforting", intensity: 0.45 + i * 0.35 };
    case "frustrated":
      // On their side: annoyed WITH them at the situation, never at them.
      return { emotion: "annoyed", intensity: 0.3 + i * 0.3 };
    case "angry":
      // Attentive and concerned rather than angry back.
      return { emotion: "comforting", intensity: 0.4 + i * 0.3, secondary: { emotion: "sad", intensity: 0.2 } };
    case "tired":
      return { emotion: "sleepy", intensity: 0.35 + i * 0.3 };
    case "happy":
      return { emotion: "happy", intensity: 0.45 + i * 0.4 };
    case "excited":
      return { emotion: i > 0.6 ? "excited" : "happy", intensity: 0.5 + i * 0.45 };
    case "playful":
      return { emotion: "mischievous", intensity: 0.4 + i * 0.4 };
    default:
      return null;
  }
}

/** Each persona's lean. It biases the cat while the persona is active; it is not a costume. */
const PERSONA_BIAS: Record<string, Response> = {
  mewmuze: { emotion: "happy", intensity: 0.3 },
  rant_buddy: { emotion: "annoyed", intensity: 0.5 },
  comfort_companion: { emotion: "comforting", intensity: 0.7 },
  grounding_listener: { emotion: "comforting", intensity: 0.55 },
  calm_companion: { emotion: "comforting", intensity: 0.5 },
  company_mode: { emotion: "affectionate", intensity: 0.5 },
  love_guru: { emotion: "affectionate", intensity: 0.6, secondary: { emotion: "happy", intensity: 0.4 } },
  breakup_buddy: { emotion: "comforting", intensity: 0.7, secondary: { emotion: "sad", intensity: 0.3 } },
  relationship_coach: { emotion: "comforting", intensity: 0.45 },
  savage_bestie: { emotion: "savage", intensity: 0.8 },
  health_guide: { emotion: "determined", intensity: 0.4 },
  medication_guide: { emotion: "determined", intensity: 0.4 },
  fitness_coach: { emotion: "determined", intensity: 0.6 },
  nutrition_companion: { emotion: "happy", intensity: 0.4 },
  money_coach: { emotion: "determined", intensity: 0.45 },
  investment_researcher: { emotion: "thinking", intensity: 0.4 },
  career_coach: { emotion: "determined", intensity: 0.6 },
  interview_trainer: { emotion: "determined", intensity: 0.6 },
  productivity_coach: { emotion: "determined", intensity: 0.5 },
  accountability_buddy: { emotion: "determined", intensity: 0.55 },
  decision_coach: { emotion: "thinking", intensity: 0.5 },
  tutor: { emotion: "curious", intensity: 0.4 },
  eli5_teacher: { emotion: "happy", intensity: 0.45 },
  developer_buddy: { emotion: "thinking", intensity: 0.45 },
  tech_support: { emotion: "thinking", intensity: 0.45 },
  researcher: { emotion: "curious", intensity: 0.45 },
  language_buddy: { emotion: "happy", intensity: 0.45 },
  travel_companion: { emotion: "excited", intensity: 0.45 },
  creative_partner: { emotion: "excited", intensity: 0.55 },
  editor: { emotion: "thinking", intensity: 0.4 },
  critic: { emotion: "suspicious", intensity: 0.45 },
  devils_advocate: { emotion: "mischievous", intensity: 0.5 },
  hype_cat: { emotion: "cheering", intensity: 0.8 },
  celebration_buddy: { emotion: "victory", intensity: 0.85 },
  chaos_cat: { emotion: "mischievous", intensity: 0.75 },
  night_owl: { emotion: "sleepy", intensity: 0.55 },
  morning_companion: { emotion: "happy", intensity: 0.6 },
};

export function personaBias(persona: string | null | undefined): Response | null {
  return (persona && PERSONA_BIAS[persona]) || null;
}

/**
 * A paw sign when a persona takes over the conversation - once, not on every
 * message. Serious personas have none: a listener does not wave.
 */
const PERSONA_GESTURE: Record<string, GestureId> = {
  mewmuze: "wave",
  morning_companion: "wave",
  hype_cat: "clap",
  celebration_buddy: "victory",
  fitness_coach: "thumbsUp",
  accountability_buddy: "thumbsUp",
  productivity_coach: "salute",
  savage_bestie: "dismiss",
  love_guru: "pawHeart",
  chaos_cat: "shrug",
  devils_advocate: "shrug",
  language_buddy: "wave",
  creative_partner: "cheer",
};

export function personaGesture(persona: string | null | undefined): GestureId | null {
  if (!persona || SERIOUS_PERSONAS.has(persona)) return null;
  return PERSONA_GESTURE[persona] ?? null;
}

/** Personas where edginess is never welcome, whatever the setting. */
const SERIOUS_PERSONAS = new Set([
  "health_guide", "medication_guide", "grounding_listener", "comfort_companion", "calm_companion", "breakup_buddy",
  "relationship_coach", "career_coach", "interview_trainer", "money_coach", "investment_researcher", "tutor", "eli5_teacher",
]);
const SERIOUS_MOODS: ReadonlySet<MoodName> = new Set<MoodName>(["sad", "stressed"]);

/** Is this a moment where anything flippant is out of place? */
export function isSerious(persona: string | null | undefined, userMood: MoodName | null): boolean {
  return (!!persona && SERIOUS_PERSONAS.has(persona)) || (!!userMood && SERIOUS_MOODS.has(userMood));
}

/**
 * A savage-banter moment the user is clearly in on: Savage Bestie with a
 * playful or light user. It only INVITES - the Edgy gestures setting (off by
 * default) and the serious-context check still decide.
 */
export function edgyInvite(persona: string | null | undefined, userMood: MoodName | null): boolean {
  return persona === "savage_bestie" && (userMood === null || userMood === "neutral" || userMood === "playful" || userMood === "happy" || userMood === "excited");
}

/**
 * What the cat shows for a chat turn: the user's feeling first when it is
 * clear and heavy (comfort beats a persona's playful lean), otherwise the
 * persona's lean, softened by a mild user mood.
 */
export function chatResponse(mood: MoodName, intensity: number, persona: string | null | undefined): Response | null {
  const toMood = respondToMood(mood, intensity);
  const bias = personaBias(persona);
  if (toMood && (SERIOUS_MOODS.has(mood) || intensity >= 0.6)) return toMood;
  if (bias && toMood) return { ...bias, secondary: bias.secondary ?? { emotion: toMood.emotion, intensity: toMood.intensity * 0.6 } };
  return bias ?? toMood;
}
