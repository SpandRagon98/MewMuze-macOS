//! The Personal Companion's only network door (Paper build).
//!
//! The frontend names a SERVICE and a path; this module owns the host names,
//! so the webview can never make it fetch an arbitrary address. Each service
//! also has a fixed path prefix, a local minimum spacing between requests (a
//! runaway loop cannot hammer anyone), a response size cap and a timeout.
//! "Pause Companion Internet" flips one flag here that refuses everything.
//!
//! No API keys: every service used is keyless by design. MET Norway and
//! OpenStreetMap require an identifying User-Agent, which is sent on every
//! request.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY: u64 = 2 * 1024 * 1024;
/// MET Norway's terms require the app name and a contact. Set a real support
/// address before this build is ever given to anyone else.
const USER_AGENT: &str = concat!(
    "MewMuzePaper/",
    env!("CARGO_PKG_VERSION"),
    " (experimental desktop companion; contact: github.com/SpandRagon98)"
);

static PAUSED: AtomicBool = AtomicBool::new(false);
static REQUESTS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static REFUSED: AtomicU64 = AtomicU64::new(0);
static LAST: Mutex<Option<HashMap<&'static str, Instant>>> = Mutex::new(None);

struct Service {
    host: &'static str,
    prefix: &'static str,
    min_gap: Duration,
}

fn service(target: &str) -> Option<Service> {
    Some(match target {
        // Weather: Locationforecast 2.0, CC BY 4.0.
        "met" => Service { host: "https://api.met.no", prefix: "/weatherapi/locationforecast/2.0/compact?", min_gap: Duration::from_secs(60) },
        // City search, only on an explicit user search. Policy: max 1 req/s.
        "nominatim" => Service { host: "https://nominatim.openstreetmap.org", prefix: "/search?", min_gap: Duration::from_secs(1) },
        // News for interests / keyword watches. GDELT asks for 1 req per 5 s.
        "gdelt" => Service { host: "https://api.gdeltproject.org", prefix: "/api/v2/doc/doc?", min_gap: Duration::from_secs(5) },
        // ECB reference rates for currency watches.
        // (api.frankfurter.app now only 301-redirects here; redirects are refused.)
        "frankfurter" => Service { host: "https://api.frankfurter.dev", prefix: "/v1/latest?", min_gap: Duration::from_secs(2) },
        _ => return None,
    })
}

/// A path is acceptable only if it is plain, printable, URL-shaped ASCII under
/// the service's prefix - no scheme, no authority, no traversal, no fragment.
fn valid_path(svc: &Service, path: &str) -> bool {
    path.len() <= 600
        && path.starts_with(svc.prefix)
        && !path.contains("..")
        && !path.contains("//")
        && path.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'#' | b'@' | b'\\' | b'<' | b'>' | b'"' | b'`' | b'{' | b'}' | b'|' | b'^'))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetResult {
    pub ok: bool,
    pub status: u16,
    pub body: String,
    pub error: Option<String>,
}

fn fail(msg: impl Into<String>) -> NetResult {
    NetResult { ok: false, error: Some(msg.into()), ..Default::default() }
}

/// Reserve a request slot for this service, or say how long to wait.
fn take_slot(target: &'static str, gap: Duration) -> Result<(), Duration> {
    let mut guard = LAST.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    if let Some(prev) = map.get(target) {
        let since = now.duration_since(*prev);
        if since < gap {
            return Err(gap - since);
        }
    }
    map.insert(target, now);
    Ok(())
}

fn get(url: &str) -> NetResult {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(TIMEOUT)
        .timeout_read(TIMEOUT)
        .user_agent(USER_AGENT)
        .redirects(0)
        .build();
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    let (status, resp) = match agent.get(url).call() {
        Ok(r) => (r.status(), r),
        Err(ureq::Error::Status(code, r)) => (code, r),
        Err(e) => return fail(format!("Network error: {e}")),
    };
    let mut buf = Vec::new();
    if let Err(e) = resp.into_reader().take(MAX_BODY + 1).read_to_end(&mut buf) {
        return fail(format!("Read error: {e}"));
    }
    BYTES.fetch_add(buf.len() as u64, Ordering::Relaxed);
    if buf.len() as u64 > MAX_BODY {
        return NetResult { ok: false, status, body: String::new(), error: Some("Response too large".into()) };
    }
    NetResult {
        ok: (200..300).contains(&status),
        status,
        body: String::from_utf8_lossy(&buf).into_owned(),
        error: if (200..300).contains(&status) { None } else { Some(format!("HTTP {status}")) },
    }
}

#[tauri::command]
pub async fn companion_http(target: String, path: String) -> NetResult {
    if PAUSED.load(Ordering::Relaxed) {
        REFUSED.fetch_add(1, Ordering::Relaxed);
        return fail("Companion internet is paused.");
    }
    let Some(svc) = service(&target) else { return fail("Unknown service") };
    if !valid_path(&svc, &path) {
        return fail("Refused: unexpected request path");
    }
    // `service` only returns hosts for the four fixed names, so this is one of them.
    let key: &'static str = match target.as_str() {
        "met" => "met",
        "nominatim" => "nominatim",
        "gdelt" => "gdelt",
        _ => "frankfurter",
    };
    if let Err(wait) = take_slot(key, svc.min_gap) {
        return fail(format!("Too soon; try again in {}s", wait.as_secs() + 1));
    }
    let url = format!("{}{}", svc.host, path);
    tauri::async_runtime::spawn_blocking(move || get(&url))
        .await
        .unwrap_or_else(|_| fail("The request could not run."))
}

#[tauri::command]
pub fn companion_net_set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStats {
    pub requests: u64,
    pub bytes: u64,
    pub refused_while_paused: u64,
}

#[tauri::command]
pub fn companion_net_stats() -> NetStats {
    NetStats {
        requests: REQUESTS.load(Ordering::Relaxed),
        bytes: BYTES.load(Ordering::Relaxed),
        refused_while_paused: REFUSED.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_services_exist() {
        assert!(service("met").is_some());
        assert!(service("gdelt").is_some());
        assert!(service("https://evil.example").is_none());
        assert!(service("").is_none());
    }

    #[test]
    fn paths_must_stay_under_the_service_prefix() {
        let met = service("met").unwrap();
        assert!(valid_path(&met, "/weatherapi/locationforecast/2.0/compact?lat=12.97&lon=77.59"));
        assert!(!valid_path(&met, "/weatherapi/locationforecast/2.0/complete?lat=1&lon=2"));
        assert!(!valid_path(&met, "//evil.example/x"));
        assert!(!valid_path(&met, "/weatherapi/locationforecast/2.0/compact?../../x"));
        assert!(!valid_path(&met, "/weatherapi/locationforecast/2.0/compact?a=1#frag"));
        assert!(!valid_path(&met, "/weatherapi/locationforecast/2.0/compact?a=b c"));
        let nom = service("nominatim").unwrap();
        assert!(valid_path(&nom, "/search?format=jsonv2&limit=5&q=New%20Delhi"));
        assert!(!valid_path(&nom, "/reverse?lat=1&lon=2"));
        let fx = service("frankfurter").unwrap();
        assert!(valid_path(&fx, "/v1/latest?base=USD&symbols=INR"));
        assert!(!valid_path(&fx, "/latest?from=USD&to=INR"));
    }

    #[test]
    fn requests_are_spaced_per_service() {
        assert!(take_slot("test-a", Duration::from_secs(60)).is_ok());
        assert!(take_slot("test-a", Duration::from_secs(60)).is_err());
        assert!(take_slot("test-b", Duration::from_secs(60)).is_ok());
    }

    #[test]
    fn pause_refuses_before_any_request() {
        companion_net_set_paused(true);
        let before = REQUESTS.load(Ordering::Relaxed);
        let r = tauri::async_runtime::block_on(companion_http(
            "met".into(),
            "/weatherapi/locationforecast/2.0/compact?lat=1&lon=2".into(),
        ));
        companion_net_set_paused(false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("paused"));
        assert_eq!(REQUESTS.load(Ordering::Relaxed), before);
        assert!(companion_net_stats().refused_while_paused >= 1);
    }
}
