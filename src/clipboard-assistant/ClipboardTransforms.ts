import type { TextStats } from "./clipboardTypes";

const BULLET_RE = /^(\s*)[-*•]\s+(.+)$/u;
const NUMBER_RE = /^(\s*)(\d{1,4})[.)]\s+(.+)$/u;
const SMALL_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "the",
  "to",
  "up",
  "via",
  "with",
]);
const COMMON_ACRONYMS = new Set(["AI", "API", "CPU", "CSS", "FAQ", "HTML", "HTTP", "HTTPS", "PDF", "UI", "URL", "USB"]);

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function trimOuterWhitespace(text: string): string {
  return text.trim();
}

export function stripUnsupportedControlCharacters(text: string): string {
  // These exact non-printing ranges are intentionally removed for plain-text output.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export function pasteWithoutFormatting(text: string): string {
  return stripUnsupportedControlCharacters(normalizeLineEndings(text));
}

export function cleanExtraSpaces(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
}

export function collapseBlankLines(text: string): string {
  return normalizeLineEndings(text).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
}

export function removeTabs(text: string): string {
  return text.replace(/\t/g, "");
}

export function convertTabsToSpaces(text: string): string {
  return text.replace(/\t/g, "    ");
}

function isListLine(line: string): boolean {
  return BULLET_RE.test(line) || NUMBER_RE.test(line);
}

function joinParagraphLines(lines: string[]): string {
  const output: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!line) continue;
    const previous = output[output.length - 1];
    if (!previous || isListLine(line) || isListLine(previous)) {
      output.push(line);
      continue;
    }
    if (/[\p{L}\p{N}]-$/u.test(previous) && /^\p{Ll}/u.test(line)) {
      output[output.length - 1] = `${previous.slice(0, -1)}${line}`;
    } else {
      output[output.length - 1] = `${previous} ${line}`;
    }
  }
  return output.join("\n");
}

export function joinWrappedLines(text: string): string {
  return normalizeLineEndings(text)
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => joinParagraphLines(paragraph.split("\n")))
    .filter(Boolean)
    .join("\n\n");
}

export function preserveParagraphsWhileCleaning(text: string): string {
  return normalizeLineEndings(text)
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => joinParagraphLines(paragraph.split("\n")))
    .filter(Boolean)
    .join("\n\n");
}

export function removeEmptyLines(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function toUpperCase(text: string): string {
  return text.toLocaleUpperCase();
}

export function toLowerCase(text: string): string {
  return text.toLocaleLowerCase();
}

export function toggleCase(text: string): string {
  return Array.from(text, (character) => {
    const upper = character.toLocaleUpperCase();
    const lower = character.toLocaleLowerCase();
    if (upper === lower) return character;
    return character === upper ? lower : upper;
  }).join("");
}

function titleWord(word: string, index: number, count: number): string {
  if (/^[A-Z0-9]{2,6}$/.test(word) && /[A-Z]/.test(word)) return word;
  const lower = word.toLocaleLowerCase();
  if (index > 0 && index < count - 1 && SMALL_TITLE_WORDS.has(lower)) return lower;
  return lower.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

export function toTitleCase(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const words = line.split(/(\s+)/);
      const wordIndexes = words
        .map((word, index) => (/\p{L}/u.test(word) ? index : -1))
        .filter((index) => index >= 0);
      return words
        .map((word, index) => {
          const position = wordIndexes.indexOf(index);
          return position >= 0 ? titleWord(word, position, wordIndexes.length) : word;
        })
        .join("");
    })
    .join("\n");
}

function sentenceWord(word: string, capitalize: boolean): string {
  if (COMMON_ACRONYMS.has(word.toLocaleUpperCase()) || /^[A-Z]{2,6}$/.test(word)) return word.toLocaleUpperCase();
  const lower = word.toLocaleLowerCase();
  return capitalize ? lower.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase()) : lower;
}

export function toSentenceCase(text: string): string {
  let start = true;
  return text.toLocaleLowerCase().replace(
    /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|[.!?]\s+|\n+/gu,
    (token) => {
      if (/^(?:[.!?]\s+|\n+)$/u.test(token)) {
        start = true;
        return token;
      }
      const result = sentenceWord(token, start);
      start = false;
      return result;
    },
  );
}

function linesWithNumbering(text: string): number {
  return normalizeLineEndings(text).split("\n").filter((line) => NUMBER_RE.test(line)).length;
}

export function removeBullets(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const match = line.match(BULLET_RE);
      return match ? `${match[1]}${match[2]}` : line;
    })
    .join("\n");
}

export function removeNumbering(text: string): string {
  if (linesWithNumbering(text) < 2) return normalizeLineEndings(text);
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const match = line.match(NUMBER_RE);
      return match ? `${match[1]}${match[3]}` : line;
    })
    .join("\n");
}

export function convertNumberedListToBullets(text: string): string {
  if (linesWithNumbering(text) < 2) return normalizeLineEndings(text);
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const match = line.match(NUMBER_RE);
      return match ? `${match[1]}• ${match[3]}` : line;
    })
    .join("\n");
}

export function convertBulletsToNumberedList(text: string): string {
  let number = 0;
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const match = line.match(BULLET_RE);
      if (!match) return line;
      number += 1;
      return `${match[1]}${number}. ${match[2]}`;
    })
    .join("\n");
}

export function normalizeBulletSpacing(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => {
      const bullet = line.match(BULLET_RE);
      if (bullet) return `${bullet[1]}• ${bullet[2].trim()}`;
      const numbered = line.match(NUMBER_RE);
      return numbered ? `${numbered[1]}${numbered[2]}. ${numbered[3].trim()}` : line;
    })
    .join("\n");
}

export function removeDuplicateLines(text: string): string {
  const seen = new Set<string>();
  return normalizeLineEndings(text)
    .split("\n")
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

export function sortLinesAlphabetically(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .join("\n");
}

export function reverseLineOrder(text: string): string {
  return normalizeLineEndings(text).split("\n").reverse().join("\n");
}

export function removeLeadingSpaces(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/g, ""))
    .join("\n");
}

export function removeTrailingSpaces(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

export function calculateTextStats(text: string): TextStats {
  const normalized = normalizeLineEndings(text);
  const words =
    normalized.match(
      /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’_-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu,
    ) ?? [];
  const nonEmpty = normalized.trim().length > 0;
  const paragraphs = nonEmpty
    ? normalized.split(/\n[ \t]*\n+/).filter((paragraph) => paragraph.trim().length > 0).length
    : 0;
  return {
    words: words.length,
    charactersWithSpaces: text.length,
    charactersWithoutSpaces: text.replace(/\s/gu, "").length,
    lines: nonEmpty ? normalized.split("\n").length : 0,
    paragraphs,
    readingTimeMinutes: words.length ? Math.max(1, Math.ceil(words.length / 200)) : 0,
  };
}
