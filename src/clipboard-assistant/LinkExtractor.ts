const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/giu;

function trimTrailingPunctuation(value: string): string {
  let result = value;
  while (/[.,;:!?}\]]$/u.test(result)) result = result.slice(0, -1);
  while (result.endsWith(")") && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
    result = result.slice(0, -1);
  }
  return result;
}

export function safeWebUrl(value: string): string | null {
  const candidate = trimTrailingPunctuation(value.trim());
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || /\s/u.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function extractLinks(text: string): string[] {
  const unique = new Set<string>();
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const safe = safeWebUrl(match[0]);
    if (safe) unique.add(safe);
  }
  return [...unique];
}
