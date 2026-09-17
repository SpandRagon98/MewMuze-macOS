//! Where the weather is for.
//!
//! Two ways, both explicit and both approximate:
//!   * the user types a city, and OpenStreetMap Nominatim finds it - one
//!     request per search, only when they press Search;
//!   * "use my approximate location" asks Windows once, through its own
//!     location permission. If the user has location off for desktop apps,
//!     it simply fails and they type a city instead.
//! Coordinates are rounded to two decimals (~1 km) before they are stored.

import { companionGet, safeJson } from "./net";

export interface Place {
  label: string;
  lat: number;
  lon: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parse a Nominatim jsonv2 search response into short, rounded places. */
export function parseNominatim(json: unknown): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  for (const r of json) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    const name = typeof o.display_name === "string" ? o.display_name : "";
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) continue;
    // "Bengaluru, Bangalore North, Karnataka, India" -> "Bengaluru, India"
    const parts = name.split(",").map((s) => s.trim());
    const label = parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts[0];
    out.push({ label: label.slice(0, 60), lat: round2(lat), lon: round2(lon) });
  }
  return out.slice(0, 5);
}

export async function searchCity(query: string): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await companionGet("nominatim", `/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`);
  return res.ok ? parseNominatim(safeJson(res.body)) : [];
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Ask the OS for an approximate position, once. Null if unavailable or refused. */
export async function deviceLocation(): Promise<Place | null> {
  try {
    const invoke = (await import("@tauri-apps/api/core")).invoke as unknown as Invoke;
    const r = await invoke<{ ok: boolean; lat: number; lon: number; error: string | null }>("approx_location");
    if (!r?.ok) return null;
    return { label: "Approximate location", lat: round2(r.lat), lon: round2(r.lon) };
  } catch {
    return null;
  }
}
