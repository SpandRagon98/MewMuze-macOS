//! Conversation mood - structured metadata from the same Qwen model, validated
//! here, and turned into a gentle, decaying influence on the cat.
//!
//! This is about how the cat should respond right now, not a label on the
//! user: it is never stored, it fades within minutes of the conversation
//! ending, and it never names a condition.

import type { AnimationName } from "../types/cat";

export const MOODS = ["neutral", "happy", "excited", "playful", "tired", "sad", "frustrated", "angry", "stressed"] as const;

export type MoodName = (typeof MOODS)[number];

export interface Mood {
  mood: MoodName;
  intensity: number;
}

export const NEUTRAL: Mood = { mood: "neutral", intensity: 0 };

/**
 * Handed to llama-server, which turns it into a grammar the model cannot step
 * outside. Intensity is an integer 0-3 because the grammar can enforce an
 * enum but not a numeric range (a free number came back as "2" on a 0-1 scale
 * in testing); it is mapped to 0..1 here.
 */
export const MOOD_SCHEMA = {
  type: "object",
  properties: {
    mood: { type: "string", enum: [...MOODS] },
    intensity: { type: "integer", enum: [0, 1, 2, 3] },
  },
  // Only what catReaction reads: the model generates every field listed here
  // on every message, and a response style / cat state nobody used doubled it.
  required: ["mood", "intensity"],
  additionalProperties: false,
} as const;

/**
 * Validate the model's JSON. Anything malformed, out of range or unknown is
 * rejected (null) rather than trusted - the caller then stays neutral.
 */
export function validateMood(raw: string): Mood | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const mood = MOODS.find((m) => m === o.mood);
  const level = o.intensity;
  if (!mood || typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 3) return null;
  return { mood, intensity: level / 3 };
}

const GUIDE =
  "Guide: tired/exhausted/sleepy/thak gaya -> tired; annoyed/fed up/pareshaan -> frustrated; furious -> angry; " +
  "worried/overwhelmed/tension -> stressed; down/lonely/upset/dukhi -> sad; great news/can't wait -> excited; " +
  "jokes/teasing -> playful; glad/good day/khush -> happy; plain questions or facts -> neutral. " +
  "intensity: 0 none, 1 mild, 2 clear, 3 very strong. Never diagnose anything.";

/**
 * The mood question asked as the next turn of the SAME conversation. With one
 * llama-server slot, a separate mood prompt evicted the cached conversation,
 * so every following reply had to re-read the whole history (first words took
 * ~7 s instead of ~3 s in the real app). As a follow-up, the cache is reused.
 */
// (Tried: moving GUIDE into the cached system prompt to shorten this. The
// 1.7B model then answered every chat message with a JSON label instead of
// a reply - so the guide stays here, and the mood request is cancellable.)
export const MOOD_FOLLOW_UP =
  "(Not part of the chat - an internal note for the desktop cat.) Label the emotional tone of the user's last message above. " +
  GUIDE +
  " Answer only with the JSON. /no_think";


/** Minutes for the influence to fall to about a third. */
const DECAY_MS = 4 * 60_000;
/** Below this the cat is simply itself again. */
export const MOOD_FLOOR = 0.15;

export class MoodInfluence {
  private current: Mood = NEUTRAL;
  private at = 0;

  set(mood: Mood, now: number): void {
    this.current = mood;
    this.at = now;
  }

  /** The mood, with its intensity decayed for the time since it was set. */
  get(now: number): Mood {
    const k = Math.exp(-(now - this.at) / DECAY_MS);
    const intensity = this.current.intensity * k;
    return intensity < MOOD_FLOOR ? NEUTRAL : { ...this.current, intensity };
  }

  clear(): void {
    this.current = NEUTRAL;
    this.at = 0;
  }
}

/**
 * Existing animations only. A one-shot reaction when the mood arrives, and an
 * optional calm pose held (loop) while the feeling is still strong.
 */
export function catReaction(m: Mood): { once?: AnimationName; hold?: AnimationName } {
  if (m.intensity < MOOD_FLOOR) return {};
  switch (m.mood) {
    case "sad":
      return { once: "cuteNod", hold: "sit" }; // sits calmly nearby
    case "frustrated":
    case "angry":
      return { hold: "watch" }; // attentive, calmer
    case "stressed":
      return { once: "cuteNod", hold: "sit" };
    case "tired":
      return { once: "yawn", hold: "lieDown" };
    case "happy":
    case "playful":
      return { once: "happy" }; // tail up
    case "excited":
      return { once: m.intensity > 0.6 ? "celebrate" : "happy" };
    default:
      return {};
  }
}
