//! The companion's only door to the internet.
//!
//! Every request goes through ONE Rust command, `companion_http`, which only
//! knows four named services and builds the URL itself - the frontend cannot
//! ask it to fetch an arbitrary address. It sends an identifying User-Agent
//! (which MET Norway and OpenStreetMap require), caps response size, times out,
//! and refuses everything while "Pause Companion Internet" is on.

export type NetTarget = "met" | "nominatim" | "gdelt" | "frankfurter";

export interface NetResult {
  ok: boolean;
  status: number;
  body: string;
  error: string | null;
}

export interface NetStats {
  requests: number;
  bytes: number;
  refusedWhilePaused: number;
}

/** Who each service is, for the privacy dashboard and the attribution line. */
export const NET_SERVICES: Record<NetTarget, { name: string; purpose: string; terms: string }> = {
  met: { name: "MET Norway (api.met.no)", purpose: "Weather forecast", terms: "CC BY 4.0, free commercial use with attribution" },
  nominatim: { name: "OpenStreetMap Nominatim", purpose: "Finding a city you type", terms: "ODbL; only on your explicit search" },
  gdelt: { name: "GDELT Project", purpose: "News for your interests and watches", terms: "Open data, free use with attribution" },
  frankfurter: { name: "Frankfurter (api.frankfurter.dev, ECB rates)", purpose: "Currency watches", terms: "Open source, ECB reference rates" },
};

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) invokeFn = (await import("@tauri-apps/api/core")).invoke as unknown as Invoke;
  return invokeFn<T>(cmd, args);
}

const OFFLINE: NetResult = { ok: false, status: 0, body: "", error: "Not available outside the app." };

export async function companionGet(target: NetTarget, pathAndQuery: string): Promise<NetResult> {
  try {
    return await invoke<NetResult>("companion_http", { target, path: pathAndQuery });
  } catch {
    return OFFLINE;
  }
}

export async function setNetPaused(paused: boolean): Promise<void> {
  try {
    await invoke("companion_net_set_paused", { paused });
  } catch {
    // Outside Tauri there is no network to pause.
  }
}

export async function netStats(): Promise<NetStats | null> {
  try {
    return await invoke<NetStats>("companion_net_stats");
  } catch {
    return null;
  }
}

/** Parse JSON without throwing; null when the body is not JSON. */
export function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
