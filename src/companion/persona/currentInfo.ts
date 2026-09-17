//! Current information for chat - kept apart from the persona on purpose.
//!
//! The persona decides HOW MewMuze answers; this decides WHAT it may state as
//! fact. When a question needs live data, the existing companion sources are
//! asked (the same ones, behind the same switches: Internet paused, Weather
//! off, no location -> nothing is fetched). What comes back is a short fact
//! line for the model; when nothing can be fetched the model is told so, so it
//! says "I can't check that right now" instead of inventing a temperature.

import { searchZones, wallClockAt } from "../../calctime/timezones";
import type { Headline } from "../news";
import type { CompanionSettings } from "../profile";
import { weatherSummary, type WeatherSnapshot } from "../weather";
import type { CurrentKind } from "./router";

export interface CurrentInfoHost {
  settings(): CompanionSettings;
  now(): number;
  tz(): string;
  /** The companion's cached forecast, if it has one. */
  cachedWeather(): WeatherSnapshot | null;
  fetchWeather(lat: number, lon: number): Promise<WeatherSnapshot | null>;
  headlines(phrase: string): Promise<Headline[] | null>;
  rate(base: string, quote: string): Promise<number | null>;
}

const CURRENCIES: Record<string, string> = {
  dollar: "USD", dollars: "USD", usd: "USD", rupee: "INR", rupees: "INR", inr: "INR", euro: "EUR", euros: "EUR", eur: "EUR",
  pound: "GBP", pounds: "GBP", gbp: "GBP", yen: "JPY", jpy: "JPY", dirham: "AED", aed: "AED", yuan: "CNY", cny: "CNY",
  "singapore dollar": "SGD", sgd: "SGD", "canadian dollar": "CAD", cad: "CAD", "australian dollar": "AUD", aud: "AUD", franc: "CHF", chf: "CHF",
};

const WEATHER_FRESH_MS = 2 * 3_600_000;

function clockLine(ms: number, zone: string, label: string, h12: boolean): string {
  const w = wallClockAt(ms, zone);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute));
  const time = d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: h12 });
  const date = d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  return `In ${label} it is ${time} on ${date}.`;
}

/** "what time is it in Tokyo" -> the zone, from the calculator's city list. */
function zoneIn(text: string) {
  const m = /\b(?:in|at)\s+([a-z][a-z .'-]{1,30}?)(?:\s+(?:now|right now|today))?[?.!]*$/i.exec(text.trim());
  if (!m) return null;
  return searchZones(m[1].trim()).find(Boolean) ?? null;
}

export async function currentInfo(kind: CurrentKind, text: string, host: CurrentInfoHost): Promise<string | null> {
  const s = host.settings();
  const now = host.now();
  const h12 = s.timeFormat === "12h";
  // The clock needs no internet.
  if (kind === "time") {
    const z = zoneIn(text);
    return z ? clockLine(now, z.id, z.label, h12) : clockLine(now, host.tz(), "your time zone", h12);
  }
  if (s.internetPaused) return "Internet use is paused in Settings, so there is no live data right now.";
  if (kind === "weather") {
    if (!s.features.weather) return "Weather is switched off in Settings (Privacy & Battery), so there is no forecast.";
    const { lat, lon, label } = s.location;
    if (lat === null || lon === null) return "No location is set in Settings, so there is no forecast.";
    let snap = host.cachedWeather();
    if (!snap || now - snap.fetchedAt > WEATHER_FRESH_MS) snap = (await host.fetchWeather(lat, lon)) ?? snap;
    if (!snap) return null;
    const w = weatherSummary(snap, now, host.tz(), s.temperature, h12);
    return w ? `Weather${label ? ` in ${label}` : ""} now: ${w.now}.${w.later ? ` ${w.later}.` : ""} (MET Norway forecast)` : null;
  }
  if (kind === "price") {
    const found = [...text.toLowerCase().matchAll(/\b(singapore dollar|canadian dollar|australian dollar|[a-z]{3,7})\b/g)]
      .map((m) => CURRENCIES[m[1]])
      .filter(Boolean);
    const [base, quote] = found.length >= 2 ? found : found.length === 1 ? [found[0], found[0] === "INR" ? "USD" : "INR"] : [];
    if (!base || !quote || base === quote) return null; // stocks, crypto, gold: no source here
    const r = await host.rate(base, quote);
    return r ? `1 ${base} = ${r.toFixed(r >= 10 ? 2 : 4)} ${quote} (Frankfurter, latest reference rate).` : null;
  }
  if (kind === "news") {
    const about = /\bnews (?:about|on|of|regarding)\s+(.{2,40}?)[?.!]*$/i.exec(text.trim())?.[1] ?? s.interests[0];
    if (!about) return null;
    const items = await host.headlines(about);
    if (!items?.length) return null;
    return `Latest headlines about ${about} (GDELT, last 24 h): ${items.slice(0, 3).map((h) => `"${h.title}" (${h.domain})`).join("; ")}.`;
  }
  return null;
}

/** The note the model gets: facts it may use, or an instruction not to guess. */
export function factsNote(facts: string | null): string {
  return facts
    ? `Live information you can rely on: ${facts} Use it; do not add numbers it does not contain.`
    : "You have no live data for this. Say briefly that you can't check it right now instead of guessing numbers, names or events.";
}
