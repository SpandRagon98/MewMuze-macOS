//! Google Calendar connector — reads the user's **private .ics address**.
//!
//! Every Google calendar exposes a "Secret address in iCal format" under
//! Settings → Integrate calendar. It needs no OAuth and no verification: it is
//! just an HTTPS URL returning a standard iCalendar file. We fetch it, parse
//! the VEVENTs locally, and hand the frontend the upcoming ones. Date/time
//! components are returned raw so the frontend can resolve them against the
//! machine's real local time zone (which std alone cannot do reliably).

use serde::Serialize;
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// Only surface events starting within this window (seconds). Generous enough
/// that a floating/TZID event is never wrongly dropped by a time-zone offset.
const WINDOW_AHEAD: i64 = 48 * 3600;
const WINDOW_BEHIND: i64 = 3600;
const MAX_EVENTS: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub summary: String,
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// DTSTART was a VALUE=DATE (all-day) — no meaningful time-of-day.
    pub all_day: bool,
    /// DTSTART carried a trailing Z (UTC). Otherwise treat as local wall time.
    pub utc: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalResult {
    pub ok: bool,
    pub error: Option<String>,
    pub events: Vec<CalEvent>,
}

fn err(msg: impl Into<String>) -> CalResult {
    CalResult { ok: false, error: Some(msg.into()), events: Vec::new() }
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Coarse UTC epoch for a set of components — used only for windowing.
fn coarse_unix(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    days_from_civil(y as i64, mo as i64, d as i64) * 86400 + (h as i64) * 3600 + (mi as i64) * 60
}

/// Unfold RFC 5545 folded lines: a leading space or tab means "continuation of
/// the previous line". Returns logical lines.
fn unfold(raw: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.split(['\r', '\n']).filter(|l| !l.is_empty()) {
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(line.trim_start());
        } else {
            lines.push(line.to_string());
        }
    }
    lines
}

/// Parse a DTSTART value + its parameters into components.
/// Handles: `20260724T140000Z`, `20260724T140000`, `VALUE=DATE:20260724`.
fn parse_dtstart(prop: &str, value: &str) -> Option<(i32, u32, u32, u32, u32, bool, bool)> {
    let all_day = prop.to_uppercase().contains("VALUE=DATE") || (!value.contains('T') && value.len() == 8);
    let utc = value.ends_with('Z');
    let v = value.trim_end_matches('Z');
    let date = v.split('T').next()?;
    if date.len() < 8 {
        return None;
    }
    let year: i32 = date.get(0..4)?.parse().ok()?;
    let month: u32 = date.get(4..6)?.parse().ok()?;
    let day: u32 = date.get(6..8)?.parse().ok()?;
    let (hour, minute) = if all_day {
        (0, 0)
    } else {
        let time = v.split('T').nth(1).unwrap_or("000000");
        let h: u32 = time.get(0..2).unwrap_or("0").parse().ok()?;
        let m: u32 = time.get(2..4).unwrap_or("0").parse().ok()?;
        (h, m)
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day, hour, minute, all_day, utc))
}

fn parse_ics(body: &str, now_unix: i64) -> Vec<CalEvent> {
    let mut events: Vec<CalEvent> = Vec::new();
    let mut in_event = false;
    let mut summary = String::new();
    let mut dt: Option<(i32, u32, u32, u32, u32, bool, bool)> = None;

    for line in unfold(body) {
        let upper = line.to_uppercase();
        if upper == "BEGIN:VEVENT" {
            in_event = true;
            summary = String::new();
            dt = None;
        } else if upper == "END:VEVENT" {
            if let Some((y, mo, d, h, mi, all_day, utc)) = dt.take() {
                let start = coarse_unix(y, mo, d, h, mi);
                if start >= now_unix - WINDOW_BEHIND && start <= now_unix + WINDOW_AHEAD {
                    events.push(CalEvent {
                        summary: if summary.is_empty() { "(untitled event)".into() } else { summary.clone() },
                        year: y,
                        month: mo,
                        day: d,
                        hour: h,
                        minute: mi,
                        all_day,
                        utc,
                    });
                }
            }
            in_event = false;
        } else if in_event {
            if let Some((prop, value)) = line.split_once(':') {
                let key = prop.split(';').next().unwrap_or("").to_uppercase();
                if key == "SUMMARY" {
                    // Unescape the handful of iCal escapes we care about.
                    summary = value
                        .replace("\\,", ",")
                        .replace("\\;", ";")
                        .replace("\\n", " ")
                        .replace("\\\\", "\\");
                } else if key == "DTSTART" {
                    dt = parse_dtstart(prop, value);
                }
            }
        }
    }

    events.sort_by_key(|e| coarse_unix(e.year, e.month, e.day, e.hour, e.minute));
    events.truncate(MAX_EVENTS);
    events
}

fn fetch(url: &str, now_unix: i64) -> Result<Vec<CalEvent>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(FETCH_TIMEOUT)
        .timeout_read(FETCH_TIMEOUT)
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("Could not fetch the calendar: {e}"))?;
    let body = resp
        .into_string()
        .map_err(|e| format!("Calendar response was unreadable: {e}"))?;
    if !body.contains("BEGIN:VCALENDAR") {
        return Err("That address did not return a calendar. Copy the *secret* iCal address from Google Calendar settings.".into());
    }
    Ok(parse_ics(&body, now_unix))
}

/// Fetch + parse the private ICS feed, returning upcoming events. `now_unix` is
/// supplied by the frontend so windowing matches the machine clock.
#[tauri::command]
pub async fn calendar_fetch(ics_url: String, now_unix: i64) -> CalResult {
    let url = ics_url.trim().to_string();
    if url.is_empty() {
        return err("Paste your private iCal address first.");
    }
    if !url.starts_with("https://") {
        return err("The calendar address must start with https://");
    }
    tauri::async_runtime::spawn_blocking(move || match fetch(&url, now_unix) {
        Ok(events) => CalResult { ok: true, error: None, events },
        Err(e) => err(e),
    })
    .await
    .unwrap_or_else(|_| err("The calendar check could not run."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_all_day_and_floating() {
        let now = coarse_unix(2026, 7, 24, 0, 0);
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:UTC Meeting\r\nDTSTART:20260724T140000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:All Day\r\nDTSTART;VALUE=DATE:20260724\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Local\r\nDTSTART;TZID=America/New_York:20260724T100000\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let events = parse_ics(ics, now);
        assert_eq!(events.len(), 3);
        let utc = events.iter().find(|e| e.summary == "UTC Meeting").unwrap();
        assert!(utc.utc && !utc.all_day && utc.hour == 14);
        let allday = events.iter().find(|e| e.summary == "All Day").unwrap();
        assert!(allday.all_day);
        let local = events.iter().find(|e| e.summary == "Local").unwrap();
        assert!(!local.utc && !local.all_day && local.hour == 10);
    }

    #[test]
    fn drops_events_outside_the_window() {
        let now = coarse_unix(2026, 7, 24, 0, 0);
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Way Later\r\nDTSTART:20260801T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
        assert_eq!(parse_ics(ics, now).len(), 0);
    }

    #[test]
    fn unfolds_continuation_lines() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Long tit\r\n le here\r\nDTSTART:20260724T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let now = coarse_unix(2026, 7, 24, 0, 0);
        let events = parse_ics(ics, now);
        assert_eq!(events[0].summary, "Long title here");
    }
}
