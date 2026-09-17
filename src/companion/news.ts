//! News for the user's own interests - not a news feed.
//!
//! Source: the GDELT Project's DOC 2.0 API (open data, free use with
//! attribution, no key). Only the interests the user listed are ever searched.
//! In the background it refreshes rarely and surfaces at most one new
//! headline per interest per day; the fuller briefing is on demand, from My Day.

import { companionGet, safeJson } from "./net";

export interface Headline {
  url: string;
  title: string;
  domain: string;
  /** Epoch ms GDELT first saw it. */
  seen: number;
}

/** GDELT's "20260910T141500Z" to epoch ms. */
function gdeltTime(s: unknown): number {
  if (typeof s !== "string") return 0;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

export function parseGdelt(json: unknown): Headline[] {
  const arts = (json as { articles?: unknown })?.articles;
  if (!Array.isArray(arts)) return [];
  const out: Headline[] = [];
  const titles = new Set<string>();
  for (const a of arts) {
    const o = a as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : "";
    const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
    // Syndicated copies share a headline; keep the first.
    const key = title.toLowerCase();
    if (!url.startsWith("https://") || title.length < 12 || titles.has(key)) continue;
    titles.add(key);
    out.push({ url, title, domain: typeof o.domain === "string" ? o.domain : "", seen: gdeltTime(o.seendate) });
  }
  return out;
}

export function gdeltPath(phrase: string, max = 8): string {
  const query = `${phrase.includes(" ") ? `"${phrase}"` : phrase} sourcelang:english`;
  return `/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${max}&format=json&timespan=24h&sort=hybridrel`;
}

export async function fetchHeadlines(phrase: string): Promise<Headline[] | null> {
  const res = await companionGet("gdelt", gdeltPath(phrase));
  if (!res.ok) return null;
  // GDELT answers rate limits and bad queries with plain text, not JSON.
  const json = safeJson(res.body);
  return json === null ? null : parseGdelt(json);
}

/** Headlines not seen before, newest first. `seen` is the remembered URL set. */
export function freshHeadlines(items: Headline[], seen: readonly string[]): Headline[] {
  const known = new Set(seen);
  return items.filter((h) => !known.has(h.url)).sort((a, b) => b.seen - a.seen);
}

/** Keep the remembered set bounded. */
export function rememberHeadlines(seen: readonly string[], items: Headline[], cap = 60): string[] {
  return [...new Set([...items.map((h) => h.url), ...seen])].slice(0, cap);
}

export function shortTitle(title: string, max = 70): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}
