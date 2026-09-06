import { normalizeBulletSpacing, normalizeLineEndings } from "./ClipboardTransforms";

function obviousHeading(line: string, previousBlank: boolean, nextBlank: boolean): boolean {
  const value = line.trim();
  if (!value || value.length > 72 || /[.!?;:]$/u.test(value)) return false;
  if (!previousBlank || !nextBlank) return false;
  const words = value.split(/\s+/);
  if (words.length > 10) return false;
  return value === value.toLocaleUpperCase() || /^[\p{Lu}\d][^.!?]*$/u.test(value);
}

export function toMarkdown(text: string, options: { codeBlock?: boolean } = {}): string {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return "";
  if (options.codeBlock) {
    const fence = normalized.includes("```") ? "````" : "```";
    return `${fence}\n${normalized}\n${fence}`;
  }

  const lines = normalizeBulletSpacing(normalized).split("\n");
  return lines
    .map((line, index) => {
      const numbered = line.match(/^(\s*)\d+[.)]\s+(.+)$/u);
      if (numbered) return `${numbered[1]}1. ${numbered[2]}`;
      if (
        obviousHeading(
          line,
          index === 0 || lines[index - 1].trim() === "",
          index === lines.length - 1 || lines[index + 1].trim() === "",
        )
      ) {
        return `## ${line.trim()}`;
      }
      return line.replace(/^(\s*)•\s+/u, "$1- ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
