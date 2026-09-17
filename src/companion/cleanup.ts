//! Deterministic transcript cleanup for Local Voice. No model, no guessing.
//!
//! The RAW transcript is always kept; this only produces the CLEAN version.
//! Every rule is one a person would apply without having to understand the
//! sentence: fillers, stutters, spoken punctuation, spacing, capitals, and a
//! self-correction only when BOTH sides are the same kind of thing
//! ("Thursday, sorry, Friday" - never "the report, sorry, it's late").

/** A filler and the commas around it: "I, um, think" -> "I think". */
const FILLERS = /,?\s*\b(?:u+m+|u+h+|e+r+m+|e+r+|h+m+|m{2,}|ah+)\b,?/gi;

/** Whisper's non-speech tags: [BLANK_AUDIO], (music), [inaudible]... */
const TAGS = /\s*[[(](?:blank_audio|music|inaudible|silence|noise|laughter|applause|no speech|sound|background noise)[^\])]*[\])]\s*/gi;

/** Words people stutter on; a doubled one is dropped. "very very" is kept - that's emphasis. */
const STUTTER_WORDS = new Set(["i", "the", "a", "an", "to", "and", "but", "so", "we", "it", "is", "in", "of", "that", "this", "my", "you", "he", "she", "they", "on", "for", "at", "with"]);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_WORDS = ["today", "tomorrow", "tonight", "yesterday"];
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "noon", "midnight"];

type Category = "weekday" | "month" | "day" | "number" | null;

function category(word: string): Category {
  const w = word.toLowerCase().replace(/[^a-z0-9:]/g, "");
  if (WEEKDAYS.includes(w)) return "weekday";
  if (MONTHS.includes(w)) return "month";
  if (DAY_WORDS.includes(w)) return "day";
  if (NUMBER_WORDS.includes(w) || /^\d{1,2}(:\d{2})?(am|pm)?$/.test(w)) return "number";
  return null;
}

/** "X, sorry, Y" / "X I mean Y" / "X no wait Y" where X and Y are the same kind of word. */
const CORRECTION = /\b([A-Za-z0-9:]+)[,]?\s+(?:sorry|i mean|no wait|no,? no|actually|rather|or rather)[,]?\s+([A-Za-z0-9:]+)\b/gi;

function applyCorrections(text: string): string {
  return text.replace(CORRECTION, (whole, before: string, after: string) => {
    const a = category(before);
    return a !== null && a === category(after) ? after : whole;
  });
}

const SPOKEN: [RegExp, string][] = [
  [/\s*\b(?:new paragraph)\b[,.]?\s*/gi, "\n\n"],
  [/\s*\b(?:new line|next line)\b[,.]?\s*/gi, "\n"],
  [/\s*\b(?:full stop)\b[,.]?/gi, "."],
  [/\s*\bquestion mark\b[,.]?/gi, "?"],
  [/\s*\bexclamation (?:mark|point)\b[,.]?/gi, "!"],
  [/\s*\bcomma\b[,.]?/gi, ","],
  [/\s*\bcolon\b[,.]?/gi, ":"],
  // "period" is also an ordinary word ("the trial period"): only at the very end.
  [/\s*\bperiod\b[,.]?\s*$/gi, "."],
];

export interface CleanupOptions {
  spokenPunctuation: boolean;
  /** Add a full stop when the text ends without one (dictation). */
  finalPunctuation: boolean;
}

const DEFAULTS: CleanupOptions = { spokenPunctuation: true, finalPunctuation: true };

const DEVANAGARI = /[ऀ-ॿ]/;

export function cleanTranscript(raw: string, opts: Partial<CleanupOptions> = {}): string {
  const o = { ...DEFAULTS, ...opts };
  let t = raw.replace(TAGS, " ").replace(/[ \t]+/g, " ").trim();
  if (!t) return "";

  t = t.replace(FILLERS, " ");
  t = applyCorrections(t);
  if (o.spokenPunctuation) for (const [re, rep] of SPOKEN) t = t.replace(re, rep);

  // Stutters: "the the" -> "the", "I I I" -> "I" (only for STUTTER_WORDS).
  t = t.replace(/\b([A-Za-z']+)(?:[\s,]+\1\b)+/gi, (whole, w: string) => (STUTTER_WORDS.has(w.toLowerCase()) ? w : whole));

  // Punctuation and spacing.
  t = t
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+([,.;:!?])/g, "$1")
        // A space after commas only - colons and dots also live inside times,
        // URLs and "e.g.", which must not be split.
        .replace(/([,;])(?=[^\s\d])/g, "$1 ")
        .replace(/,{2,}/g, ",")
        .replace(/([?!.])\1+/g, "$1")
        .replace(/[,;:]+([.!?])/g, "$1")
        .replace(/^[,;:.\s]+/, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!DEVANAGARI.test(t)) {
    t = t.replace(/\bi\b/g, "I").replace(/\bi'(m|ll|ve|d)\b/gi, (_m, s: string) => `I'${s.toLowerCase()}`);
    // Capital at the start of every sentence and line.
    t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  }

  // \p{M}: Devanagari words often end in a vowel sign (the "ा" of "था"), which is a mark, not a letter.
  if (o.finalPunctuation && /[\p{L}\p{N}\p{M}]$/u.test(t)) t += DEVANAGARI.test(t) ? "।" : ".";
  return t;
}
