//! Travel context - a cautious prototype.
//!
//! Only fires when a meeting title says so in plain words ("Flight to London",
//! "Trip to Delhi", "✈ Mumbai"), and only when the destination is a city we
//! know the time zone of. It never guesses travel from a location field alone:
//! a meeting "at" an address across town is not a trip.

import { dayKey, formatClock, zoneOffsetMinutes } from "./clock";
import type { Meeting } from "./calendarCompanion";

/**
 * Major travel destinations and their IANA zones. The zone - not a fixed
 * offset - is what makes the time difference right across DST changes.
 */
export const CITY_ZONES: Record<string, string> = {
  delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", bengaluru: "Asia/Kolkata",
  bangalore: "Asia/Kolkata", chennai: "Asia/Kolkata", hyderabad: "Asia/Kolkata", kolkata: "Asia/Kolkata",
  pune: "Asia/Kolkata", goa: "Asia/Kolkata", ahmedabad: "Asia/Kolkata", jaipur: "Asia/Kolkata", kochi: "Asia/Kolkata",
  london: "Europe/London", dublin: "Europe/Dublin", paris: "Europe/Paris", berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam", madrid: "Europe/Madrid", rome: "Europe/Rome", zurich: "Europe/Zurich",
  munich: "Europe/Berlin", frankfurt: "Europe/Berlin", lisbon: "Europe/Lisbon", stockholm: "Europe/Stockholm",
  istanbul: "Europe/Istanbul", moscow: "Europe/Moscow",
  dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", doha: "Asia/Qatar", riyadh: "Asia/Riyadh",
  singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur", bangkok: "Asia/Bangkok", jakarta: "Asia/Jakarta",
  "hong kong": "Asia/Hong_Kong", shanghai: "Asia/Shanghai", beijing: "Asia/Shanghai", tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul", kathmandu: "Asia/Kathmandu", colombo: "Asia/Colombo", dhaka: "Asia/Dhaka",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", auckland: "Pacific/Auckland",
  "new york": "America/New_York", boston: "America/New_York", washington: "America/New_York", toronto: "America/Toronto",
  chicago: "America/Chicago", austin: "America/Chicago", denver: "America/Denver", seattle: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", "los angeles": "America/Los_Angeles", vancouver: "America/Vancouver",
  "mexico city": "America/Mexico_City", "sao paulo": "America/Sao_Paulo", johannesburg: "Africa/Johannesburg",
  cairo: "Africa/Cairo", nairobi: "Africa/Nairobi", lagos: "Africa/Lagos",
};

const TRAVEL = /(?:\bflight\b|\bflying\b|\bfly\b|✈️?|\btrip\b|\btravel(?:l?ing)?\b)\s*(?:to|:|-)?\s*([a-z .]{3,24})/i;

export interface TravelInfo {
  meeting: Meeting;
  city: string;
  zone: string;
  /** Minutes the destination is ahead of here (negative = behind). */
  offsetMin: number;
  when: "today" | "tomorrow";
}

function findCity(text: string): string | null {
  const lower = text.toLowerCase();
  // Longest names first, so "new delhi" wins over "delhi".
  for (const city of Object.keys(CITY_ZONES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${city.replace(/ /g, "\\s+")}\\b`).test(lower)) return city;
  }
  return null;
}

export function detectTravel(meetings: Meeting[], now: number, tz: string): TravelInfo | null {
  const today = dayKey(now, tz);
  const tomorrow = dayKey(now + 24 * 3_600_000, tz);
  for (const m of meetings) {
    if (m.cancelled || m.start < now - 3_600_000) continue;
    const day = dayKey(m.start, tz);
    if (day !== today && day !== tomorrow) continue;
    const hit = TRAVEL.exec(m.title);
    if (!hit) continue;
    const city = findCity(hit[1] ?? "") ?? findCity(m.title);
    if (!city) continue;
    const zone = CITY_ZONES[city];
    return { meeting: m, city, zone, offsetMin: zoneOffsetMinutes(now, zone, tz), when: day === today ? "today" : "tomorrow" };
  }
  return null;
}

const title = (city: string) => city.replace(/\b\w/g, (c) => c.toUpperCase());

function offsetText(min: number): string {
  if (min === 0) return "the same time as here";
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  const span = `${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""}`;
  return `${span} ${min > 0 ? "ahead" : "behind"}`;
}

export function describeTravel(t: TravelInfo, now: number, h12: boolean): string {
  const there = formatClock(now, h12, t.zone);
  return `Travelling to ${title(t.city)} ${t.when}? It's ${there} there now (${offsetText(t.offsetMin)}).`;
}
