//! Weather awareness - significance based, never chatty.
//!
//! Source: MET Norway Locationforecast 2.0 (api.met.no). Free for commercial
//! use under CC BY 4.0 with attribution, no API key (so no secret ships in the
//! app), and its terms ask only for an identifying User-Agent - which is why
//! requests go out from the Rust side, where that header can actually be set.
//!
//! The detector below only raises events that change what the user might do:
//! rain arriving while it is currently dry, heavy rain, storms, snow, heat that
//! is genuinely dangerous to sit in, real cold, and a big day-on-day swing.
//! 28°C becoming 29°C is never an event.

import type { AnimationName } from "../types/cat";
import { dayKey, formatSpokenClock, localParts } from "./clock";
import type { TempUnit } from "./profile";

export interface WeatherHour {
  /** Start of the hour, epoch ms. */
  t: number;
  temp: number;
  humidity: number | null;
  /** m/s. */
  wind: number | null;
  /** mm over the hour. */
  precip: number;
  /** MET symbol code with the _day/_night suffix removed, e.g. "lightrain". */
  symbol: string;
}

export interface WeatherSnapshot {
  fetchedAt: number;
  hours: WeatherHour[];
}

export type WeatherEventKind = "rain" | "heavyRain" | "storm" | "snow" | "heat" | "cold" | "swing";

export interface WeatherEvent {
  kind: WeatherEventKind;
  /** When it starts (or peaks), epoch ms. */
  at: number;
  /** De-duplication id: the same weather fact always maps to the same id. */
  id: string;
  value?: number;
}

export interface WeatherMemory {
  /** Yesterday's daytime high, for the day-on-day swing. */
  lastDayMax: { day: string; max: number } | null;
}

// ---- parsing ----------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null ? (v as Rec) : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a Locationforecast "compact" response. Null if it is not one. */
export function parseMet(json: unknown, fetchedAt: number): WeatherSnapshot | null {
  const series = rec(rec(json)?.properties)?.timeseries;
  if (!Array.isArray(series)) return null;
  const hours: WeatherHour[] = [];
  for (const entry of series) {
    const e = rec(entry);
    const t = typeof e?.time === "string" ? Date.parse(e.time) : NaN;
    const data = rec(e?.data);
    const inst = rec(rec(data?.instant)?.details);
    const temp = n(inst?.air_temperature);
    if (!Number.isFinite(t) || temp === null) continue;
    // Hourly detail for the first ~2.5 days, then 6-hourly: spread a 6-hour
    // total evenly so "rain tomorrow" still has something to go on.
    const one = rec(data?.next_1_hours);
    const six = rec(data?.next_6_hours);
    const block = one ?? six;
    const precipTotal = n(rec(block?.details)?.precipitation_amount) ?? 0;
    const symbol = String(rec(block?.summary)?.symbol_code ?? "").replace(/_(day|night|polartwilight)$/, "");
    hours.push({
      t,
      temp,
      humidity: n(inst?.relative_humidity),
      wind: n(inst?.wind_speed),
      precip: one ? precipTotal : precipTotal / 6,
      symbol,
    });
  }
  return hours.length ? { fetchedAt, hours } : null;
}

// ---- derived values -----------------------------------------------------------

/** Apparent temperature in °C: heat index when hot and humid, wind chill when cold and windy. */
export function feelsLike(h: WeatherHour): number {
  const t = h.temp;
  if (t >= 27 && h.humidity !== null && h.humidity >= 40) {
    // NOAA Rothfusz regression, evaluated in °F.
    const f = t * 1.8 + 32;
    const r = h.humidity;
    const hi =
      -42.379 + 2.04901523 * f + 10.14333127 * r - 0.22475541 * f * r - 0.00683783 * f * f -
      0.05481717 * r * r + 0.00122874 * f * f * r + 0.00085282 * f * r * r - 0.00000199 * f * f * r * r;
    return Math.round(((hi - 32) / 1.8) * 10) / 10;
  }
  const kmh = (h.wind ?? 0) * 3.6;
  if (t <= 10 && kmh > 4.8) {
    const v = kmh ** 0.16;
    return Math.round((13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v) * 10) / 10;
  }
  return t;
}

const WET = /rain|sleet|showers|drizzle/;
const isWet = (h: WeatherHour) => h.precip >= 0.5 || (WET.test(h.symbol) && h.precip >= 0.1);

export function formatTemp(c: number, unit: TempUnit): string {
  return unit === "f" ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`;
}

const SYMBOL_TEXT: [RegExp, string][] = [
  [/thunder/, "thunderstorms"],
  [/heavysnow|^snow/, "snow"],
  [/sleet/, "sleet"],
  [/heavyrain/, "heavy rain"],
  [/showers/, "showers"],
  [/lightrain|drizzle/, "light rain"],
  [/rain/, "rain"],
  [/fog/, "fog"],
  [/clearsky/, "clear"],
  [/fair/, "mostly clear"],
  [/partlycloudy/, "partly cloudy"],
  [/cloudy/, "cloudy"],
];

export function describeSymbol(symbol: string): string {
  for (const [re, label] of SYMBOL_TEXT) if (re.test(symbol)) return label;
  return symbol || "unknown";
}

/** The hour containing `now`, or the nearest one after it. */
export function currentHour(snap: WeatherSnapshot, now: number): WeatherHour | null {
  let best: WeatherHour | null = null;
  for (const h of snap.hours) {
    if (h.t <= now) best = h;
    else return best ?? h;
  }
  return best;
}

// ---- significance -------------------------------------------------------------

const HOUR = 3_600_000;
export const HEAT_FEELS_C = 38;
export const COLD_C = 4;
export const SWING_C = 8;
/** Heavy rain: at least this much in one hour. */
export const HEAVY_MM = 4;

/**
 * The weather facts worth telling the user about, from one snapshot. Pure:
 * the same snapshot, time and memory always give the same events, which is
 * what makes their ids safe to de-duplicate on.
 */
export function detectWeatherEvents(
  snap: WeatherSnapshot,
  now: number,
  tz: string,
  memory: WeatherMemory,
): { events: WeatherEvent[]; memory: WeatherMemory } {
  const events: WeatherEvent[] = [];
  const today = dayKey(now, tz);
  const cur = currentHour(snap, now);
  const within = (hrs: number) => snap.hours.filter((h) => h.t > now - HOUR && h.t <= now + hrs * HOUR);

  // Rain ARRIVING: only when it is dry now. Already raining is not news.
  if (cur && !isWet(cur)) {
    const next6 = within(6).filter((h) => h.t > (cur?.t ?? now));
    const start = next6.find(isWet);
    if (start) {
      const burst = next6.filter((h) => h.t >= start.t && h.t < start.t + 3 * HOUR);
      const heavy = burst.some((h) => h.precip >= HEAVY_MM || /heavy/.test(h.symbol));
      const hour = localParts(start.t, tz).hour;
      events.push({ kind: heavy ? "heavyRain" : "rain", at: start.t, id: `weather:rain:${today}:${hour}` });
    }
  }

  const storm = within(6).find((h) => /thunder/.test(h.symbol));
  if (storm) events.push({ kind: "storm", at: storm.t, id: `weather:storm:${today}` });

  const snow = within(12).find((h) => /snow/.test(h.symbol) && h.precip > 0);
  if (snow) events.push({ kind: "snow", at: snow.t, id: `weather:snow:${today}` });

  // Heat and the day's high: the rest of today, until the evening.
  const restOfDay = snap.hours.filter((h) => h.t >= now - HOUR && dayKey(h.t, tz) === today && localParts(h.t, tz).hour <= 21);
  if (restOfDay.length) {
    const hottest = restOfDay.reduce((a, b) => (feelsLike(b) > feelsLike(a) ? b : a));
    if (feelsLike(hottest) >= HEAT_FEELS_C) {
      events.push({ kind: "heat", at: hottest.t, id: `weather:heat:${today}`, value: feelsLike(hottest) });
    }
  }

  const next12 = within(12);
  if (next12.length) {
    const coldest = next12.reduce((a, b) => (b.temp < a.temp ? b : a));
    if (coldest.temp <= COLD_C) events.push({ kind: "cold", at: coldest.t, id: `weather:cold:${today}`, value: coldest.temp });
  }

  // Day-on-day swing, against yesterday's remembered daytime high.
  const todayHours = snap.hours.filter((h) => dayKey(h.t, tz) === today && localParts(h.t, tz).hour >= 9 && localParts(h.t, tz).hour <= 18);
  let next = memory;
  if (todayHours.length >= 4) {
    const max = Math.max(...todayHours.map((h) => h.temp));
    const prev = memory.lastDayMax;
    const yesterday = dayKey(now - 24 * HOUR, tz);
    if (prev && prev.day === yesterday && Math.abs(max - prev.max) >= SWING_C) {
      events.push({ kind: "swing", at: now, id: `weather:swing:${today}`, value: Math.round(max - prev.max) });
    }
    if (!prev || prev.day !== today) next = { lastDayMax: { day: today, max } };
  }
  return { events, memory: next };
}

/** One sentence, in the cat's voice. */
export function describeWeatherEvent(ev: WeatherEvent, name: string, h12: boolean, unit: TempUnit, tz: string): string {
  const who = name ? `, ${name}` : "";
  const when = formatSpokenClock(ev.at, h12, tz);
  switch (ev.kind) {
    case "rain":
      return `Rain's coming${who}. Showers expected around ${when}.`;
    case "heavyRain":
      return `Heavy rain's coming${who}. Expected around ${when}.`;
    case "storm":
      return `Thunderstorms likely around ${when}${who}.`;
    case "snow":
      return `Snow on the way${who}, from about ${when}.`;
    case "heat":
      return `It'll feel like ${formatTemp(ev.value ?? 0, unit)} today${who}. Keep water close.`;
    case "cold":
      return `Getting cold${who}: down to ${formatTemp(ev.value ?? 0, unit)} by ${when}.`;
    case "swing": {
      const d = ev.value ?? 0;
      const deg = unit === "f" ? Math.round(Math.abs(d) * 1.8) : Math.abs(d);
      return `${d > 0 ? "Much warmer" : "Much colder"} today${who}, about ${deg}° ${d > 0 ? "up on" : "down from"} yesterday.`;
    }
  }
}

/**
 * The cat's reaction, drawn from animations it already has - no new assets.
 * Rain has it look up at the sky, heat reuses the overheated steam, cold the
 * shake-off, a storm the startle.
 */
export function catReactionFor(kind: WeatherEventKind | "sunny"): AnimationName | undefined {
  switch (kind) {
    case "rain":
    case "heavyRain":
      return "lookUp";
    case "storm":
      return "startled";
    case "snow":
      return "happy";
    case "heat":
      return "overheat";
    case "cold":
      return "shake";
    case "sunny":
      return "happy";
    default:
      return undefined;
  }
}

/** Is it pleasant and clear right now? Drives the relaxed morning reaction. */
export function isSunny(snap: WeatherSnapshot, now: number): boolean {
  const h = currentHour(snap, now);
  return !!h && /clearsky|fair/.test(h.symbol) && h.temp >= 12 && h.temp <= 32;
}

/** "27°C, partly cloudy" and the one upcoming thing worth knowing. */
export function weatherSummary(
  snap: WeatherSnapshot,
  now: number,
  tz: string,
  unit: TempUnit,
  h12: boolean,
): { now: string; later: string | null } | null {
  const h = currentHour(snap, now);
  if (!h) return null;
  const { events } = detectWeatherEvents(snap, now, tz, { lastDayMax: null });
  const rain = events.find((e) => e.kind === "rain" || e.kind === "heavyRain");
  const storm = events.find((e) => e.kind === "storm");
  const later = storm
    ? `Storms around ${formatSpokenClock(storm.at, h12, tz)}`
    : rain
      ? `${rain.kind === "heavyRain" ? "Heavy rain" : "Rain"} after ${formatSpokenClock(rain.at, h12, tz)}`
      : null;
  return { now: `${formatTemp(h.temp, unit)}, ${describeSymbol(h.symbol)}`, later };
}

/** Will it rain tomorrow (local)? Total mm, or 0. */
export function rainTomorrowMm(snap: WeatherSnapshot, now: number, tz: string): number {
  const tomorrow = dayKey(now + 24 * HOUR, tz);
  return snap.hours.filter((h) => dayKey(h.t, tz) === tomorrow).reduce((s, h) => s + h.precip, 0);
}
