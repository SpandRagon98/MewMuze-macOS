/**
 * Time-zone conversion built on IANA zone names and the engine's own `Intl`
 * time-zone database.
 *
 * Fixed UTC offsets are deliberately NOT used anywhere: "New York is UTC-5" is
 * wrong for eight months of the year, and any table of offsets goes stale the
 * next time a government moves its DST dates. Asking `Intl` for the offset *at
 * a specific instant* is the only approach that stays correct across DST
 * transitions, and it needs no dependency and no network.
 *
 * Everything here is pure apart from reading the supplied `Date`, so it is
 * fully unit-testable and idle-free.
 */

export interface Zone {
  /** IANA identifier — the source of truth. */
  id: string;
  /** City / region shown in the picker. */
  label: string;
  /** Country or area, for disambiguation in the list. */
  region: string;
  /**
   * Extra search terms: the abbreviations people actually type (IST, EST, PT),
   * which are NOT valid IANA ids and must never be used for the maths.
   */
  aliases: string[];
}

/**
 * A curated list rather than all ~600 IANA zones: this is a desk tool, and a
 * shorter searchable list is faster to use than an exhaustive one. Every entry
 * is a real IANA id, so DST is handled by the engine.
 */
export const ZONES: Zone[] = [
  { id: "Asia/Kolkata", label: "India", region: "Mumbai · Delhi · Bengaluru", aliases: ["IST", "india", "kolkata", "calcutta", "mumbai", "delhi", "bangalore", "bengaluru", "chennai", "hyderabad", "pune"] },
  { id: "America/New_York", label: "New York", region: "US Eastern", aliases: ["ET", "EST", "EDT", "eastern", "usa", "us", "nyc", "boston", "atlanta", "miami", "toronto"] },
  { id: "America/Chicago", label: "Chicago", region: "US Central", aliases: ["CT", "CST", "CDT", "central", "usa", "us", "dallas", "houston", "austin"] },
  { id: "America/Denver", label: "Denver", region: "US Mountain", aliases: ["MT", "MST", "MDT", "mountain", "usa", "us", "phoenix"] },
  { id: "America/Los_Angeles", label: "Los Angeles", region: "US Pacific", aliases: ["PT", "PST", "PDT", "pacific", "usa", "us", "san francisco", "seattle", "sf", "silicon valley"] },
  { id: "Europe/London", label: "London", region: "United Kingdom", aliases: ["GMT", "BST", "UK", "britain", "england", "uk time"] },
  { id: "Europe/Dublin", label: "Dublin", region: "Ireland", aliases: ["IST", "ireland"] },
  { id: "Europe/Paris", label: "Paris", region: "France", aliases: ["CET", "CEST", "france", "central european"] },
  { id: "Europe/Berlin", label: "Berlin", region: "Germany", aliases: ["CET", "CEST", "germany", "munich", "frankfurt"] },
  { id: "Europe/Madrid", label: "Madrid", region: "Spain", aliases: ["CET", "spain", "barcelona"] },
  { id: "Europe/Amsterdam", label: "Amsterdam", region: "Netherlands", aliases: ["CET", "netherlands", "holland"] },
  { id: "Europe/Zurich", label: "Zurich", region: "Switzerland", aliases: ["CET", "switzerland", "geneva"] },
  { id: "Europe/Moscow", label: "Moscow", region: "Russia", aliases: ["MSK", "russia"] },
  { id: "Europe/Lisbon", label: "Lisbon", region: "Portugal", aliases: ["WET", "portugal"] },
  { id: "Asia/Dubai", label: "Dubai", region: "UAE", aliases: ["GST", "uae", "abu dhabi", "emirates"] },
  { id: "Asia/Karachi", label: "Karachi", region: "Pakistan", aliases: ["PKT", "pakistan", "lahore", "islamabad"] },
  { id: "Asia/Dhaka", label: "Dhaka", region: "Bangladesh", aliases: ["BST", "bangladesh"] },
  { id: "Asia/Colombo", label: "Colombo", region: "Sri Lanka", aliases: ["sri lanka"] },
  { id: "Asia/Kathmandu", label: "Kathmandu", region: "Nepal", aliases: ["nepal"] },
  { id: "Asia/Singapore", label: "Singapore", region: "Singapore", aliases: ["SGT", "singapore"] },
  { id: "Asia/Hong_Kong", label: "Hong Kong", region: "Hong Kong", aliases: ["HKT", "hongkong"] },
  { id: "Asia/Shanghai", label: "Shanghai", region: "China", aliases: ["CST", "china", "beijing", "shenzhen"] },
  { id: "Asia/Tokyo", label: "Tokyo", region: "Japan", aliases: ["JST", "japan", "osaka"] },
  { id: "Asia/Seoul", label: "Seoul", region: "South Korea", aliases: ["KST", "korea"] },
  { id: "Asia/Jakarta", label: "Jakarta", region: "Indonesia", aliases: ["WIB", "indonesia", "bali"] },
  { id: "Asia/Bangkok", label: "Bangkok", region: "Thailand", aliases: ["ICT", "thailand"] },
  { id: "Asia/Manila", label: "Manila", region: "Philippines", aliases: ["PHT", "philippines"] },
  { id: "Asia/Jerusalem", label: "Jerusalem", region: "Israel", aliases: ["IST", "israel", "tel aviv"] },
  { id: "Asia/Riyadh", label: "Riyadh", region: "Saudi Arabia", aliases: ["AST", "saudi"] },
  { id: "Australia/Sydney", label: "Sydney", region: "Australia Eastern", aliases: ["AEST", "AEDT", "australia", "melbourne", "canberra"] },
  { id: "Australia/Brisbane", label: "Brisbane", region: "Australia (no DST)", aliases: ["AEST", "queensland"] },
  { id: "Australia/Perth", label: "Perth", region: "Australia Western", aliases: ["AWST", "western australia"] },
  { id: "Pacific/Auckland", label: "Auckland", region: "New Zealand", aliases: ["NZST", "NZDT", "new zealand", "nz"] },
  { id: "America/Sao_Paulo", label: "São Paulo", region: "Brazil", aliases: ["BRT", "brazil", "sao paulo"] },
  { id: "America/Mexico_City", label: "Mexico City", region: "Mexico", aliases: ["CST", "mexico"] },
  { id: "America/Bogota", label: "Bogotá", region: "Colombia", aliases: ["COT", "colombia"] },
  { id: "America/Argentina/Buenos_Aires", label: "Buenos Aires", region: "Argentina", aliases: ["ART", "argentina"] },
  { id: "America/Vancouver", label: "Vancouver", region: "Canada Pacific", aliases: ["PT", "PST", "PDT", "canada"] },
  { id: "Africa/Johannesburg", label: "Johannesburg", region: "South Africa", aliases: ["SAST", "south africa", "cape town"] },
  { id: "Africa/Lagos", label: "Lagos", region: "Nigeria", aliases: ["WAT", "nigeria"] },
  { id: "Africa/Cairo", label: "Cairo", region: "Egypt", aliases: ["EET", "egypt"] },
  { id: "Africa/Nairobi", label: "Nairobi", region: "Kenya", aliases: ["EAT", "kenya"] },
  { id: "UTC", label: "UTC", region: "Coordinated Universal Time", aliases: ["UTC", "GMT", "zulu", "universal"] },
];

/** Case-insensitive search across label, region, IANA id and abbreviations. */
export function searchZones(query: string, zones: Zone[] = ZONES): Zone[] {
  const q = query.trim().toLowerCase();
  if (!q) return zones;
  const score = (z: Zone): number => {
    const label = z.label.toLowerCase();
    if (label === q) return 0;
    if (z.aliases.some((a) => a.toLowerCase() === q)) return 1;
    if (label.startsWith(q)) return 2;
    if (z.aliases.some((a) => a.toLowerCase().startsWith(q))) return 3;
    if (label.includes(q)) return 4;
    if (z.region.toLowerCase().includes(q)) return 5;
    if (z.id.toLowerCase().includes(q)) return 6;
    if (z.aliases.some((a) => a.toLowerCase().includes(q))) return 7;
    return -1;
  };
  return zones
    .map((z) => ({ z, s: score(z) }))
    .filter((e) => e.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((e) => e.z);
}

export function findZone(id: string): Zone | undefined {
  return ZONES.find((z) => z.id === id);
}

/** Wall-clock fields, independent of any zone. */
export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    // `hourCycle: "h23"` avoids the "24" that h24 can produce at midnight,
    // which would otherwise parse as an out-of-range hour.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** The wall clock shown in `timeZone` at a given UTC instant. */
export function wallClockAt(utcMs: number, timeZone: string): WallClock & { second: number } {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * The zone's UTC offset in minutes at a given instant.
 *
 * Derived by asking what the wall clock reads there and comparing — so it is
 * automatically correct on both sides of a DST transition.
 */
export function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const w = wallClockAt(utcMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Round to the minute: the seconds match by construction, and floating
  // fractions here would show up as one-minute errors after conversion.
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Turn a wall-clock reading in `timeZone` into a UTC instant.
 *
 * Iterated twice because the offset depends on the very instant we are solving
 * for: near a DST jump the first guess can land on the wrong side of the
 * transition, and one correction pass settles it.
 */
export function zonedTimeToUtc(wall: WallClock, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let utc = naive - offsetMinutesAt(naive, timeZone) * 60000;
  utc = naive - offsetMinutesAt(utc, timeZone) * 60000;
  return utc;
}

export interface ConversionResult {
  /** The resolved UTC instant. */
  utcMs: number;
  /** Wall clock in the destination zone. */
  wall: WallClock;
  /** Destination offset in minutes at that instant. */
  offsetMinutes: number;
  /**
   * Calendar-day difference vs. the source date: -1 previous day, 0 same day,
   * +1 next day. Surfaced because it is the detail people get wrong.
   */
  dayShift: number;
}

/** Convert a wall clock from one zone to another, DST-correct on both ends. */
export function convertZone(wall: WallClock, fromZone: string, toZone: string): ConversionResult {
  const utcMs = zonedTimeToUtc(wall, fromZone);
  const w = wallClockAt(utcMs, toZone);
  const target: WallClock = {
    year: w.year,
    month: w.month,
    day: w.day,
    hour: w.hour,
    minute: w.minute,
  };
  // Compare calendar dates as plain day numbers so the shift is right across
  // month and year boundaries too.
  const srcDay = Date.UTC(wall.year, wall.month - 1, wall.day);
  const dstDay = Date.UTC(target.year, target.month - 1, target.day);
  return {
    utcMs,
    wall: target,
    offsetMinutes: offsetMinutesAt(utcMs, toZone),
    dayShift: Math.round((dstDay - srcDay) / 86400000),
  };
}

/** Short zone abbreviation at an instant (EST, EDT, IST…), from the engine. */
export function zoneAbbreviation(utcMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(utcMs));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** "+05:30" / "-04:00" for display beside the result. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue, 12 Aug 2026" — unambiguous, avoiding the US/UK numeric date trap. */
export function formatDate(wall: WallClock): string {
  const weekday = WEEKDAYS[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()];
  return `${weekday}, ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}`;
}

/** Clock time in either 12- or 24-hour form. */
export function formatTime(wall: WallClock, hour12: boolean): string {
  const mm = String(wall.minute).padStart(2, "0");
  if (!hour12) return `${String(wall.hour).padStart(2, "0")}:${mm}`;
  const suffix = wall.hour < 12 ? "AM" : "PM";
  const h = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  return `${h}:${mm} ${suffix}`;
}

/** Human phrasing for the date rollover, or "" when the day is unchanged. */
export function dayShiftLabel(shift: number): string {
  if (shift === 0) return "";
  if (shift === 1) return "next day";
  if (shift === -1) return "previous day";
  return shift > 0 ? `+${shift} days` : `${shift} days`;
}

/** The machine's own zone, used as the sensible default "from". */
export function localZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && findZone(tz) ? tz : tz || "UTC";
  } catch {
    return "UTC";
  }
}
