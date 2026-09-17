//! Google Calendar connector — reads the user's **private .ics address**.
//!
//! Every Google calendar exposes a "Secret address in iCal format" under
//! Settings → Integrate calendar. It needs no OAuth and no verification: it is
//! just an HTTPS URL returning a standard iCalendar file. We fetch it, parse
//! the VEVENTs locally, and hand the frontend the upcoming ones. Date/time
//! components are returned raw so the frontend can resolve them against the
//! machine's real local time zone (which std alone cannot do reliably).
//!
//! Paper build: the parser also reads UID, duration, location, a meeting link,
//! STATUS:CANCELLED, and expands recurring meetings (RRULE with EXDATE and
//! RECURRENCE-ID overrides) - without that, a weekly stand-up never appeared
//! at all. Nothing here ever writes to the calendar.

use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// Only surface events starting within this window (seconds). Generous enough
/// that a floating/TZID event is never wrongly dropped by a time-zone offset.
const WINDOW_AHEAD: i64 = 48 * 3600;
const WINDOW_BEHIND: i64 = 3600;
const MAX_EVENTS: usize = 80;
/// A recurrence is walked day by day from its start; this bounds the walk
/// (~68 years) so a malformed rule can never spin.
const MAX_RULE_DAYS: i64 = 25_000;

#[derive(Serialize, Clone, Default, Debug)]
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
    /// iCal UID ("" when absent). Shared by every instance of a recurring series.
    pub uid: String,
    /// From DTEND or DURATION.
    pub duration_min: Option<u32>,
    pub location: String,
    /// An https meeting link found in URL / LOCATION / DESCRIPTION, or "".
    pub link: String,
    pub cancelled: bool,
    /// Expanded from an RRULE, or an override of one instance.
    pub recurring: bool,
    /// For a RECURRENCE-ID override: the slot this instance originally had.
    pub orig_year: Option<i32>,
    pub orig_month: Option<u32>,
    pub orig_day: Option<u32>,
    pub orig_hour: Option<u32>,
    pub orig_minute: Option<u32>,
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

/// The inverse: civil (y, m, d) for days since the epoch.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

/// 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday.
fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let next = if m == 12 { days_from_civil(y as i64 + 1, 1, 1) } else { days_from_civil(y as i64, m as i64 + 1, 1) };
    (next - days_from_civil(y as i64, m as i64, 1)) as u32
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

/// (year, month, day, hour, minute, all_day, utc)
type Dt = (i32, u32, u32, u32, u32, bool, bool);

fn dt_unix(d: &Dt) -> i64 {
    coarse_unix(d.0, d.1, d.2, d.3, d.4)
}

/// Parse a DTSTART value + its parameters into components.
/// Handles: `20260724T140000Z`, `20260724T140000`, `VALUE=DATE:20260724`.
fn parse_dtstart(prop: &str, value: &str) -> Option<Dt> {
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
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    Some((year, month, day, hour, minute, all_day, utc))
}

/// Unescape the iCal text escapes.
fn unescape(v: &str) -> String {
    v.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

/// `PT1H30M`, `P1D`, `PT45M` → minutes. Negative or unparseable → None.
fn parse_duration(v: &str) -> Option<u32> {
    let v = v.trim();
    let rest = v.strip_prefix('P').or_else(|| v.strip_prefix("+P"))?;
    let (mut total, mut num, mut in_time) = (0u64, String::new(), false);
    for c in rest.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' => in_time = true,
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: u64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('W', _) => n * 7 * 1440,
                    ('D', _) => n * 1440,
                    ('H', true) => n * 60,
                    ('M', true) => n,
                    ('S', true) => n / 60,
                    _ => return None,
                };
            }
            _ => return None,
        }
    }
    u32::try_from(total).ok()
}

const MEETING_HOSTS: [&str; 8] = [
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com",
    "whereby.com",
    "gotomeeting.com",
    "chime.aws",
];

/// Every https URL in a piece of text, cut at the first character that cannot
/// belong to one.
fn https_urls(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("https://") {
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')' | ']' | '\\'))
            .unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches(['.', ',', ';']);
        if url.len() > "https://".len() && url.len() <= 400 {
            out.push(url.to_string());
        }
        rest = &tail[end..];
    }
    out
}

fn host_of(url: &str) -> &str {
    let after = &url["https://".len()..];
    after.split(['/', '?', '#']).next().unwrap_or("")
}

/// The meeting's join link: a known video-call host wins, from any field;
/// otherwise the event's own URL property.
fn meeting_link(url_prop: &str, location: &str, description: &str) -> String {
    let all: Vec<String> = [description, location, url_prop].iter().flat_map(|t| https_urls(t)).collect();
    all.iter()
        .find(|u| {
            let h = host_of(u).to_ascii_lowercase();
            MEETING_HOSTS.iter().any(|m| h == *m || h.ends_with(&format!(".{m}")))
        })
        .cloned()
        .or_else(|| https_urls(url_prop).into_iter().next())
        .unwrap_or_default()
}

// ---- recurrence ---------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug)]
struct Rule {
    freq: Freq,
    interval: i64,
    count: Option<u32>,
    until: Option<i64>,
    /// (ordinal, weekday) — ordinal 0 = every such weekday.
    byday: Vec<(i32, u32)>,
    bymonthday: Vec<i32>,
    bymonth: Vec<u32>,
}

fn weekday_code(s: &str) -> Option<u32> {
    ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].iter().position(|d| *d == s).map(|p| p as u32)
}

/// Parse an RRULE. Returns None for anything this parser does not fully
/// understand (BYSETPOS, hourly rules...) - the master is then shown once
/// rather than expanded wrongly.
fn parse_rrule(v: &str) -> Option<Rule> {
    let mut rule = Rule { freq: Freq::Daily, interval: 1, count: None, until: None, byday: vec![], bymonthday: vec![], bymonth: vec![] };
    let mut has_freq = false;
    for part in v.split(';').filter(|p| !p.is_empty()) {
        let (k, val) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => {
                rule.freq = match val.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                };
                has_freq = true;
            }
            "INTERVAL" => rule.interval = val.parse::<i64>().ok().filter(|n| *n >= 1)?,
            "COUNT" => rule.count = Some(val.parse().ok()?),
            "UNTIL" => {
                let d = parse_dtstart("", val)?;
                // A date-only UNTIL includes that whole day.
                rule.until = Some(if d.5 { dt_unix(&d) + 86_399 } else { dt_unix(&d) });
            }
            "BYDAY" => {
                for item in val.split(',') {
                    let item = item.trim().to_ascii_uppercase();
                    if !item.is_ascii() {
                        return None; // split_at below indexes bytes
                    }
                    let (num, code) = item.split_at(item.len().checked_sub(2)?);
                    let ord = if num.is_empty() { 0 } else { num.parse::<i32>().ok()? };
                    rule.byday.push((ord, weekday_code(code)?));
                }
            }
            "BYMONTHDAY" => {
                for item in val.split(',') {
                    rule.bymonthday.push(item.trim().parse().ok()?);
                }
            }
            "BYMONTH" => {
                for item in val.split(',') {
                    rule.bymonth.push(item.trim().parse().ok().filter(|m| (1..=12).contains(m))?);
                }
            }
            "WKST" => {}
            _ => return None,
        }
    }
    has_freq.then_some(rule)
}

fn monthday_matches(list: &[i32], y: i32, m: u32, d: u32) -> bool {
    let dim = days_in_month(y, m) as i32;
    list.iter().any(|&n| if n > 0 { n == d as i32 } else { dim + 1 + n == d as i32 })
}

/// Does a BYDAY entry match this day, counting ordinals within the month?
fn byday_matches(list: &[(i32, u32)], y: i32, m: u32, d: u32, wd: u32) -> bool {
    let dim = days_in_month(y, m);
    list.iter().any(|&(ord, w)| {
        w == wd
            && match ord {
                0 => true,
                n if n > 0 => ((d - 1) / 7 + 1) as i32 == n,
                n => ((dim - d) / 7 + 1) as i32 == -n,
            }
    })
}

/// Does this candidate day belong to the series? `start` = the DTSTART day.
fn rule_matches(rule: &Rule, start: i64, cand: i64) -> bool {
    let (sy, sm, sd) = civil_from_days(start);
    let (y, m, d) = civil_from_days(cand);
    let wd = weekday(cand);
    if !rule.bymonth.is_empty() && !rule.bymonth.contains(&m) {
        return false;
    }
    match rule.freq {
        Freq::Daily => {
            (cand - start) % rule.interval == 0
                && (rule.byday.is_empty() || rule.byday.iter().any(|&(_, w)| w == wd))
                && (rule.bymonthday.is_empty() || monthday_matches(&rule.bymonthday, y, m, d))
        }
        Freq::Weekly => {
            let monday = |x: i64| x - ((weekday(x) + 6) % 7) as i64;
            let weeks = (monday(cand) - monday(start)) / 7;
            let on_day = if rule.byday.is_empty() { wd == weekday(start) } else { rule.byday.iter().any(|&(_, w)| w == wd) };
            on_day && weeks % rule.interval == 0
        }
        Freq::Monthly => {
            let months = (y as i64 - sy as i64) * 12 + (m as i64 - sm as i64);
            let on_day = if !rule.bymonthday.is_empty() {
                monthday_matches(&rule.bymonthday, y, m, d)
            } else if !rule.byday.is_empty() {
                byday_matches(&rule.byday, y, m, d, wd)
            } else {
                d == sd
            };
            months % rule.interval == 0 && on_day
        }
        Freq::Yearly => {
            let in_month = if rule.bymonth.is_empty() { m == sm } else { true };
            let on_day = if !rule.bymonthday.is_empty() {
                monthday_matches(&rule.bymonthday, y, m, d)
            } else if !rule.byday.is_empty() {
                byday_matches(&rule.byday, y, m, d, wd)
            } else {
                d == sd
            };
            (y as i64 - sy as i64) % rule.interval == 0 && in_month && on_day
        }
    }
}

/// Occurrence starts of a series that fall inside [from, to], honouring
/// COUNT, UNTIL and EXDATE. COUNT is counted from the series start, so the
/// walk always begins at DTSTART.
fn expand(start: &Dt, rule: &Rule, exdates: &[Dt], from: i64, to: i64) -> Vec<Dt> {
    let first = days_from_civil(start.0 as i64, start.1 as i64, start.2 as i64);
    let last = (to.div_euclid(86_400) + 1).min(first + MAX_RULE_DAYS);
    let excluded: HashSet<(i32, u32, u32, u32, u32)> =
        exdates.iter().map(|e| if start.5 { (e.0, e.1, e.2, 0, 0) } else { (e.0, e.1, e.2, e.3, e.4) }).collect();
    let mut out = Vec::new();
    let mut n = 0u32;
    let mut day = first;
    while day <= last {
        if rule_matches(rule, first, day) {
            let (y, m, d) = civil_from_days(day);
            let occ: Dt = (y, m, d, start.3, start.4, start.5, start.6);
            let t = dt_unix(&occ);
            if rule.until.is_some_and(|u| t > u) {
                break;
            }
            n += 1;
            if rule.count.is_some_and(|c| n > c) {
                break;
            }
            // EXDATEs still count toward COUNT (RFC 5545), they just are not shown.
            if t >= from && t <= to && !excluded.contains(&(y, m, d, occ.3, occ.4)) {
                out.push(occ);
            }
        }
        day += 1;
    }
    out
}

// ---- parsing ------------------------------------------------------------------

#[derive(Default)]
struct RawEvent {
    summary: String,
    start: Option<Dt>,
    end: Option<Dt>,
    duration: Option<u32>,
    uid: String,
    location: String,
    url: String,
    description: String,
    cancelled: bool,
    rrule: Option<String>,
    exdates: Vec<Dt>,
    recurrence_id: Option<Dt>,
}

impl RawEvent {
    fn duration_min(&self, start: &Dt) -> Option<u32> {
        if let Some(end) = &self.end {
            let mins = (dt_unix(end) - dt_unix(start)) / 60;
            if mins > 0 && mins <= 14 * 1440 {
                return Some(mins as u32);
            }
        }
        self.duration.filter(|m| *m > 0)
    }

    fn instance(&self, at: &Dt, recurring: bool) -> CalEvent {
        let start = self.start.unwrap_or(*at);
        CalEvent {
            summary: if self.summary.is_empty() { "(untitled event)".into() } else { self.summary.clone() },
            year: at.0,
            month: at.1,
            day: at.2,
            hour: at.3,
            minute: at.4,
            all_day: at.5,
            utc: at.6,
            uid: self.uid.clone(),
            duration_min: self.duration_min(&start),
            location: self.location.chars().take(100).collect(),
            link: meeting_link(&self.url, &self.location, &self.description),
            cancelled: self.cancelled,
            recurring,
            ..Default::default()
        }
    }
}

fn read_events(body: &str) -> Vec<RawEvent> {
    let mut events = Vec::new();
    let mut cur: Option<RawEvent> = None;
    for line in unfold(body) {
        let upper = line.to_uppercase();
        if upper == "BEGIN:VEVENT" {
            cur = Some(RawEvent::default());
        } else if upper == "END:VEVENT" {
            if let Some(ev) = cur.take() {
                events.push(ev);
            }
        } else if let Some(ev) = cur.as_mut() {
            // Nested components (VALARM) carry their own DESCRIPTION etc.
            let Some((prop, value)) = line.split_once(':') else { continue };
            let key = prop.split(';').next().unwrap_or("").to_uppercase();
            match key.as_str() {
                "SUMMARY" => ev.summary = unescape(value),
                "DTSTART" => ev.start = parse_dtstart(prop, value),
                "DTEND" => ev.end = parse_dtstart(prop, value),
                "DURATION" => ev.duration = parse_duration(value),
                "UID" => ev.uid = value.trim().chars().take(200).collect(),
                "LOCATION" => ev.location = unescape(value).trim().to_string(),
                "URL" => ev.url = value.trim().to_string(),
                "DESCRIPTION" if ev.description.is_empty() => ev.description = unescape(value),
                "STATUS" => ev.cancelled = value.trim().eq_ignore_ascii_case("CANCELLED"),
                "RRULE" => ev.rrule = Some(value.trim().to_string()),
                "EXDATE" => ev.exdates.extend(value.split(',').filter_map(|v| parse_dtstart(prop, v.trim()))),
                "RECURRENCE-ID" => ev.recurrence_id = parse_dtstart(prop, value),
                _ => {}
            }
        }
    }
    events
}

fn parse_ics(body: &str, now_unix: i64) -> Vec<CalEvent> {
    let from = now_unix - WINDOW_BEHIND;
    let to = now_unix + WINDOW_AHEAD;
    let in_window = |d: &Dt| (from..=to).contains(&dt_unix(d));
    let raw = read_events(body);

    // Instances replaced by a RECURRENCE-ID override, by (UID, original slot).
    let overridden: HashSet<(String, i32, u32, u32, u32, u32)> = raw
        .iter()
        .filter_map(|e| e.recurrence_id.map(|r| (e.uid.clone(), r.0, r.1, r.2, r.3, r.4)))
        .collect();

    let mut events: Vec<CalEvent> = Vec::new();
    for e in &raw {
        let Some(start) = e.start else { continue };
        if let Some(orig) = e.recurrence_id {
            // Shown if either its new or its original slot is in view, so a
            // meeting moved out of the window reads as moved, not cancelled.
            if in_window(&start) || in_window(&orig) {
                let mut ev = e.instance(&start, true);
                (ev.orig_year, ev.orig_month, ev.orig_day, ev.orig_hour, ev.orig_minute) =
                    (Some(orig.0), Some(orig.1), Some(orig.2), Some(orig.3), Some(orig.4));
                events.push(ev);
            }
            continue;
        }
        match e.rrule.as_deref().and_then(parse_rrule) {
            Some(rule) => {
                for occ in expand(&start, &rule, &e.exdates, from, to) {
                    if !overridden.contains(&(e.uid.clone(), occ.0, occ.1, occ.2, occ.3, occ.4)) {
                        events.push(e.instance(&occ, true));
                    }
                }
            }
            None if in_window(&start) => events.push(e.instance(&start, false)),
            None => {}
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

    fn cal(events: &str) -> String {
        format!("BEGIN:VCALENDAR\r\n{events}END:VCALENDAR\r\n")
    }

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

    #[test]
    fn civil_round_trip_and_weekdays() {
        for d in [-1000i64, 0, 59, 60, 10_957, 20_000, 20_658] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y as i64, m as i64, dd as i64), d);
        }
        assert_eq!(weekday(days_from_civil(2026, 9, 10)), 4); // a Thursday
        assert_eq!(days_in_month(2028, 2), 29);
        assert_eq!(days_in_month(2026, 2), 28);
    }

    #[test]
    fn reads_uid_duration_location_link_and_status() {
        let now = coarse_unix(2026, 9, 10, 8, 0);
        let ics = cal(concat!(
            "BEGIN:VEVENT\r\nUID:abc@google.com\r\nSUMMARY:Product Review\r\n",
            "DTSTART:20260910T100000\r\nDTEND:20260910T113000\r\n",
            "LOCATION:Room 4\\, Floor 2\r\n",
            "DESCRIPTION:Agenda first.\\nJoin: https://meet.google.com/abc-defg-hij\\nMore at https://example.com/doc\r\n",
            "END:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:x2\r\nSUMMARY:Standup\r\nDTSTART:20260910T120000\r\nDURATION:PT15M\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n",
        ));
        let ev = parse_ics(&ics, now);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].uid, "abc@google.com");
        assert_eq!(ev[0].duration_min, Some(90));
        assert_eq!(ev[0].location, "Room 4, Floor 2");
        assert_eq!(ev[0].link, "https://meet.google.com/abc-defg-hij");
        assert!(!ev[0].cancelled && !ev[0].recurring);
        assert_eq!(ev[1].duration_min, Some(15));
        assert!(ev[1].cancelled);
        assert_eq!(ev[1].link, "");
    }

    #[test]
    fn meeting_link_prefers_call_hosts_and_falls_back_to_url() {
        assert_eq!(meeting_link("", "", "see https://acme.zoom.us/j/123?pwd=x."), "https://acme.zoom.us/j/123?pwd=x");
        assert_eq!(meeting_link("https://example.com/e/1", "", "no call"), "https://example.com/e/1");
        assert_eq!(meeting_link("http://insecure.example", "", ""), "");
        // A look-alike host is not a meeting host.
        assert_eq!(meeting_link("", "https://zoom.us.evil.example/j/1", ""), "");
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(90));
        assert_eq!(parse_duration("P1D"), Some(1440));
        assert_eq!(parse_duration("P1W"), Some(10080));
        assert_eq!(parse_duration("-PT5M"), None);
        assert_eq!(parse_duration("junk"), None);
    }

    #[test]
    fn expands_weekly_byday_series_into_the_window() {
        // Standup every Mon/Wed/Fri at 09:30 since 2024. 2026-09-10 is a Thursday;
        // the 48h window reaches Friday 11th (and the start of Saturday).
        let now = coarse_unix(2026, 9, 10, 8, 0);
        let ics = cal("BEGIN:VEVENT\r\nUID:su\r\nSUMMARY:Standup\r\nDTSTART;TZID=Asia/Kolkata:20240101T093000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEND:VEVENT\r\n");
        let ev = parse_ics(&ics, now);
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0].year, ev[0].month, ev[0].day, ev[0].hour, ev[0].minute), (2026, 9, 11, 9, 30));
        assert!(ev[0].recurring);
        assert_eq!(ev[0].uid, "su");
    }

    #[test]
    fn honours_count_until_interval_and_exdate() {
        let now = coarse_unix(2026, 9, 10, 0, 0);
        // Daily from Sep 8, 3 occurrences: 8, 9, 10 -> only the 10th is in view.
        let counted = cal("BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:C\r\nDTSTART:20260908T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n");
        let ev = parse_ics(&counted, now);
        assert_eq!(ev.iter().map(|e| e.day).collect::<Vec<_>>(), vec![10]);
        // UNTIL the 10th (date-only = the whole day).
        let until = cal("BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:U\r\nDTSTART:20260901T180000\r\nRRULE:FREQ=DAILY;UNTIL=20260910\r\nEND:VEVENT\r\n");
        assert_eq!(parse_ics(&until, now).iter().map(|e| e.day).collect::<Vec<_>>(), vec![10]);
        // Every other day from the 1st: 1,3,5,7,9,11 -> the 11th.
        let every2 = cal("BEGIN:VEVENT\r\nUID:i\r\nSUMMARY:I\r\nDTSTART:20260901T120000\r\nRRULE:FREQ=DAILY;INTERVAL=2\r\nEND:VEVENT\r\n");
        assert_eq!(parse_ics(&every2, now).iter().map(|e| e.day).collect::<Vec<_>>(), vec![11]);
        // EXDATE removes the 11th from a daily series.
        let ex = cal("BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:E\r\nDTSTART:20260901T120000\r\nRRULE:FREQ=DAILY\r\nEXDATE:20260911T120000\r\nEND:VEVENT\r\n");
        assert_eq!(parse_ics(&ex, now).iter().map(|e| e.day).collect::<Vec<_>>(), vec![10]);
    }

    #[test]
    fn monthly_ordinal_weekdays_and_month_days() {
        // Second Thursday of the month: 2026-09-10.
        let now = coarse_unix(2026, 9, 10, 0, 0);
        let second_thu = cal("BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:M\r\nDTSTART:20260108T150000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TH\r\nEND:VEVENT\r\n");
        assert_eq!(parse_ics(&second_thu, now).iter().map(|e| e.day).collect::<Vec<_>>(), vec![10]);
        // Last day of the month, viewed on Sep 29 -> Sep 30.
        let now2 = coarse_unix(2026, 9, 29, 0, 0);
        let last = cal("BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:L\r\nDTSTART:20260131T170000\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1\r\nEND:VEVENT\r\n");
        assert_eq!(parse_ics(&last, now2).iter().map(|e| (e.month, e.day)).collect::<Vec<_>>(), vec![(9, 30)]);
        // Yearly on the start date.
        let yearly = cal("BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Y\r\nDTSTART;VALUE=DATE:20200911\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n");
        let ev = parse_ics(&yearly, now);
        assert_eq!(ev.len(), 1);
        assert!(ev[0].all_day && ev[0].year == 2026 && ev[0].day == 11);
    }

    #[test]
    fn overrides_replace_their_instance_and_report_the_original_slot() {
        let now = coarse_unix(2026, 9, 10, 8, 0);
        let ics = cal(concat!(
            "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly Sync\r\nDTSTART:20260903T160000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n",
            // This week's instance moved from 16:00 to 16:30.
            "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly Sync\r\nRECURRENCE-ID:20260910T160000\r\nDTSTART:20260910T163000\r\nEND:VEVENT\r\n",
        ));
        let ev = parse_ics(&ics, now);
        assert_eq!(ev.len(), 1, "the original 16:00 instance is replaced, not duplicated");
        assert_eq!((ev[0].hour, ev[0].minute), (16, 30));
        assert_eq!((ev[0].orig_hour, ev[0].orig_minute), (Some(16), Some(0)));
        assert!(ev[0].recurring);

        // A cancelled instance comes through flagged, so it can be announced.
        let cancelled = cal(concat!(
            "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly Sync\r\nDTSTART:20260903T160000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly Sync\r\nRECURRENCE-ID:20260910T160000\r\nDTSTART:20260910T160000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n",
        ));
        let ev = parse_ics(&cancelled, now);
        assert_eq!(ev.len(), 1);
        assert!(ev[0].cancelled);
    }

    #[test]
    fn unsupported_rules_fall_back_to_the_single_master() {
        let now = coarse_unix(2026, 9, 10, 8, 0);
        let ics = cal("BEGIN:VEVENT\r\nUID:h\r\nSUMMARY:H\r\nDTSTART:20260910T100000\r\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1\r\nEND:VEVENT\r\n");
        let ev = parse_ics(&ics, now);
        assert_eq!(ev.len(), 1);
        assert!(!ev[0].recurring);
        assert!(parse_rrule("FREQ=HOURLY").is_none());
        assert!(parse_rrule("INTERVAL=0;FREQ=DAILY").is_none());
    }
}
