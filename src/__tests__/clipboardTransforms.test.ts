import { describe, expect, it } from "vitest";
import {
  calculateTextStats,
  cleanExtraSpaces,
  collapseBlankLines,
  convertBulletsToNumberedList,
  convertNumberedListToBullets,
  convertTabsToSpaces,
  joinWrappedLines,
  normalizeBulletSpacing,
  normalizeLineEndings,
  pasteWithoutFormatting,
  preserveParagraphsWhileCleaning,
  removeBullets,
  removeDuplicateLines,
  removeEmptyLines,
  removeLeadingSpaces,
  removeNumbering,
  removeTabs,
  removeTrailingSpaces,
  reverseLineOrder,
  sortLinesAlphabetically,
  toLowerCase,
  toSentenceCase,
  toTitleCase,
  toUpperCase,
  toggleCase,
  trimOuterWhitespace,
} from "../clipboard-assistant/ClipboardTransforms";
import { extractLinks, safeWebUrl } from "../clipboard-assistant/LinkExtractor";
import { toMarkdown } from "../clipboard-assistant/MarkdownFormatter";
import { transformClipboardText } from "../clipboard-assistant/ClipboardPanel";

describe("clipboard text transformations", () => {
  it("normalizes Windows/Mac endings and removes unsupported controls only", () => {
    expect(normalizeLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
    expect(pasteWithoutFormatting("Important\u0000 notice\r\nMonday")).toBe("Important notice\nMonday");
  });

  it("cleans repeated horizontal whitespace", () => {
    expect(cleanExtraSpaces("  one \t  two  \n trois   quatre ")).toBe("one two\ntrois quatre");
    expect(trimOuterWhitespace("\n  one  \n")).toBe("one");
    expect(collapseBlankLines("one\n\n\n \ntwo")).toBe("one\n\ntwo");
    expect(removeTabs("a\tb")).toBe("ab");
    expect(convertTabsToSpaces("a\tb")).toBe("a    b");
  });

  it("joins wrapped PDF lines but preserves paragraphs and lists", () => {
    const input = "The project will begin\nnext Monday and the team\nwill finish.\n\nSecond paragraph\nstays separate.";
    expect(joinWrappedLines(input)).toBe(
      "The project will begin next Monday and the team will finish.\n\nSecond paragraph stays separate.",
    );
    expect(preserveParagraphsWhileCleaning("- first\n- second\n\nFinal\nparagraph")).toBe(
      "- first\n- second\n\nFinal paragraph",
    );
  });

  it("removes empty lines without changing words", () => {
    expect(removeEmptyLines("one\n\n  \ntwo")).toBe("one\ntwo");
    expect(removeEmptyLines("")).toBe("");
  });

  it("changes case for Unicode and preserves practical acronyms", () => {
    expect(toUpperCase("Français, हिंदी, Straße 🙂")).toContain("FRANÇAIS");
    expect(toLowerCase("ÉCOLE ÜBER")).toBe("école über");
    expect(toTitleCase("the cat in the API window")).toBe("The Cat in the API Window");
    expect(toSentenceCase("HELLO API WORLD. BONJOUR URL MONDE!\nनमस्ते दुनिया")).toBe(
      "Hello API world. Bonjour URL monde!\nनमस्ते दुनिया",
    );
    expect(toggleCase("Hello Straße 🙂")).toBe("hELLO sTRASSE 🙂");
  });

  it("supports deterministic line transformations", () => {
    expect(removeDuplicateLines("Beta\nAlpha\nBeta")).toBe("Beta\nAlpha");
    expect(sortLinesAlphabetically("zeta\nAlpha\nbeta")).toBe("Alpha\nbeta\nzeta");
    expect(reverseLineOrder("one\ntwo\nthree")).toBe("three\ntwo\none");
    expect(removeLeadingSpaces("  one\n\ttwo")).toBe("one\ntwo");
    expect(removeTrailingSpaces("one  \ntwo\t")).toBe("one\ntwo");
  });

  it("handles bullets, numbering, indentation and ordinary numbered sentences", () => {
    const bullets = "- alpha\n  * beta\n• gamma";
    expect(removeBullets(bullets)).toBe("alpha\n  beta\ngamma");
    expect(convertBulletsToNumberedList(bullets)).toBe("1. alpha\n  2. beta\n3. gamma");
    expect(normalizeBulletSpacing("- alpha\n* beta")).toBe("• alpha\n• beta");

    const numbered = "1. alpha\n2) beta";
    expect(removeNumbering(numbered)).toBe("alpha\nbeta");
    expect(convertNumberedListToBullets(numbered)).toBe("• alpha\n• beta");
    expect(removeNumbering("2026. This is an ordinary sentence.")).toBe(
      "2026. This is an ordinary sentence.",
    );
  });

  it("calculates non-mutating text statistics", () => {
    const input = "Bonjour monde 🙂\n\nनमस्ते दुनिया";
    expect(calculateTextStats(input)).toEqual({
      words: 4,
      charactersWithSpaces: input.length,
      charactersWithoutSpaces: input.replace(/\s/gu, "").length,
      lines: 3,
      paragraphs: 2,
      readingTimeMinutes: 1,
    });
    expect(calculateTextStats("")).toMatchObject({ words: 0, lines: 0, paragraphs: 0, readingTimeMinutes: 0 });
  });

  it("supports very long input without truncating the transform", () => {
    const input = Array.from({ length: 20_000 }, () => "word").join("  ");
    const output = cleanExtraSpaces(input);
    expect(output.length).toBeGreaterThan(80_000);
    expect(output.includes("  ")).toBe(false);
    expect(calculateTextStats(output).words).toBe(20_000);
  });

  it("applies the required clean → sentence case → uppercase chain to the current result", () => {
    const original = "My Name     is     Spandnan Talukdar";
    const cleaned = transformClipboardText("clean-spaces", original);
    const sentence = transformClipboardText("sentence-case", cleaned);
    const upper = transformClipboardText("uppercase", sentence);
    expect(cleaned).toBe("My Name is Spandnan Talukdar");
    expect(sentence).toBe("My name is spandnan talukdar");
    expect(upper).toBe("MY NAME IS SPANDNAN TALUKDAR");
  });
});

describe("clipboard links and Markdown", () => {
  it("extracts safe links, strips punctuation and removes duplicates", () => {
    expect(
      extractLinks("See https://example.com/docs, and (http://example.org/a_(b)). Again https://example.com/docs"),
    ).toEqual(["https://example.com/docs", "http://example.org/a_(b)"]);
  });

  it("rejects malformed and unsafe protocols", () => {
    expect(safeWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebUrl("file:///C:/secret.txt")).toBeNull();
    expect(safeWebUrl("https://")).toBeNull();
  });

  it("creates lightweight Markdown and optional code fences", () => {
    expect(toMarkdown("NOTES\n\n• one\n2) two")).toBe("## NOTES\n\n- one\n1. two");
    expect(toMarkdown("const x = 1;", { codeBlock: true })).toBe("```\nconst x = 1;\n```");
    expect(toMarkdown("contains ``` fence", { codeBlock: true })).toBe(
      "````\ncontains ``` fence\n````",
    );
  });
});
