export type ClipboardAssistantMode = "off" | "manual" | "badge";
export type ClipboardForgetAfterSeconds = 0 | 60 | 300 | 900;

export interface ClipboardAssistantSettings {
  mode: ClipboardAssistantMode;
  excludedApplications: string[];
  maxPreviewLength: number;
  maxInputLength: number;
  forgetAfterSeconds: ClipboardForgetAfterSeconds;
  suppressSensitiveCodes: boolean;
}

export interface NativeClipboardEvent {
  sequence: number;
  text: string;
  sourceApp: string | null;
}

export interface ClipboardSnapshot {
  id: number;
  original: string;
  result: string;
  sourceApp: string | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface TextStats {
  words: number;
  charactersWithSpaces: number;
  charactersWithoutSpaces: number;
  lines: number;
  paragraphs: number;
  readingTimeMinutes: number;
}

export type ClipboardReaction =
  | "notice"
  | "hold"
  | "clean"
  | "arrange"
  | "success"
  | "error";

export type ClipboardTransformId =
  | "plain"
  | "trim"
  | "clean-spaces"
  | "collapse-blank-lines"
  | "join-wrapped"
  | "preserve-paragraphs"
  | "remove-empty-lines"
  | "normalize-line-endings"
  | "remove-tabs"
  | "tabs-to-spaces"
  | "uppercase"
  | "lowercase"
  | "title-case"
  | "sentence-case"
  | "toggle-case"
  | "remove-bullets"
  | "remove-numbering"
  | "numbered-to-bullets"
  | "bullets-to-numbered"
  | "normalize-bullets"
  | "remove-duplicate-lines"
  | "sort-lines"
  | "reverse-lines"
  | "remove-leading-spaces"
  | "remove-trailing-spaces"
  | "extract-links"
  | "markdown"
  | "markdown-code";
