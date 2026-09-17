//! Gmail connector — IMAP over TLS using a Google **app password**.
//!
//! Deliberately no OAuth: app passwords need no Google verification / CASA
//! audit, so anyone can connect their own inbox instantly. We do not hold an
//! IDLE connection open; instead the frontend polls `gmail_fetch` a couple of
//! times a minute, which keeps the background footprint tiny and the code
//! simple. Nothing is stored here — credentials arrive per-call from the
//! frontend (which persists them in the local settings file) and only the
//! newest messages' envelopes (from + subject + Message-ID) are ever read,
//! never the body.

use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const HOST: &str = "imap.gmail.com";
const PORT: u16 = 993;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(20);

/// How many of the newest envelopes a single poll reports. The frontend shows
/// at most five at once and queues the rest, so this only has to cover a burst
/// arriving between two polls — not the whole mailbox.
const RECENT_LIMIT: usize = 15;

/// One message's envelope. Strictly headers the notification needs: who it is
/// from, what it is about, and the RFC822 Message-ID used to deep-link the
/// message in the browser. No body, no flags, no recipients.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub uid: u32,
    pub from: String,
    pub subject: String,
    /// RFC822 Message-ID with the angle brackets stripped, empty when absent.
    pub message_id: String,
    /// Still unread.
    pub unread: bool,
    /// Unread AND carrying Gmail's own "Important" marker - the strongest
    /// signal the companion has that a message may need the user.
    pub important: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    /// The poll succeeded (credentials valid, inbox reachable).
    pub ok: bool,
    /// Human-readable failure reason when `ok` is false.
    pub error: Option<String>,
    /// Number of unread (\Unseen) messages in the inbox.
    pub unseen: u32,
    /// Unread messages Gmail marked Important.
    pub important_unseen: u32,
    /// Highest UID present — the frontend compares this against the last value
    /// it saw to decide whether a *new* message has arrived.
    pub latest_uid: u32,
    /// Display name (or address) the newest message is from.
    pub latest_from: String,
    /// Subject of the newest message.
    pub latest_subject: String,
    /// The newest envelopes, oldest-first, capped at `RECENT_LIMIT`. Lets the
    /// frontend stack several arrivals instead of only ever showing the newest.
    pub messages: Vec<GmailMessage>,
}

fn err(msg: impl Into<String>) -> GmailStatus {
    GmailStatus { ok: false, error: Some(msg.into()), ..Default::default() }
}

/// Decode an RFC822 header word list (Cow<[u8]>) into a lossy UTF-8 string.
fn bytes_to_string(b: Option<&[u8]>) -> String {
    b.map(|v| String::from_utf8_lossy(v).into_owned()).unwrap_or_default()
}

/// Google displays app passwords in four groups for readability. IMAP expects
/// the same 16 characters without separators, so accept either pasted form.
fn normalize_app_password(password: &str) -> String {
    password.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// `<abc123@mail.example>` → `abc123@mail.example`. Gmail's `rfc822msgid:`
/// search wants the bare id; the header carries the angle brackets.
fn strip_angle_brackets(raw: &str) -> String {
    raw.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

/// Sender display name, falling back to the bare address when absent. Takes the
/// raw header fields rather than the envelope itself: `imap_proto` (which owns
/// the `Envelope` type) is only a transitive dependency, so its types cannot be
/// named here.
fn sender_label(name: Option<&[u8]>, mailbox: Option<&[u8]>, host: Option<&[u8]>) -> String {
    let name = bytes_to_string(name);
    if !name.is_empty() {
        return name;
    }
    let mbox = bytes_to_string(mailbox);
    let host = bytes_to_string(host);
    if host.is_empty() {
        mbox
    } else {
        format!("{mbox}@{host}")
    }
}

/// Poll the inbox once. Blocking — the frontend calls it from a background
/// tick, and the command is async + spawn_blocking so the UI never stalls.
fn poll(email: &str, app_password: &str) -> Result<GmailStatus, String> {
    // Resolve + connect with an explicit timeout so a dead network can never
    // wedge the worker thread indefinitely.
    let addr = (HOST, PORT)
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve {HOST}: {e}"))?
        .next()
        .ok_or_else(|| format!("Could not resolve {HOST}"))?;
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("Could not reach Gmail: {e}"))?;
    tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();

    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS setup failed: {e}"))?;
    let tls_stream = tls
        .connect(HOST, tcp)
        .map_err(|e| format!("Secure connection failed: {e}"))?;

    let mut client = imap::Client::new(tls_stream);
    // Consume the server greeting before issuing commands.
    client
        .read_greeting()
        .map_err(|e| format!("Gmail did not respond: {e}"))?;

    let normalized_password = normalize_app_password(app_password);
    let mut session = client
        .login(email, &normalized_password)
        .map_err(|(e, _client)| {
            // The most common cause by far: wrong/removed app password, or 2FA
            // not enabled. Give a clear, non-technical nudge.
            format!("Sign-in failed — check the app password (and that 2-Step Verification is on). [{e}]")
        })?;

    let result = (|| -> imap::error::Result<GmailStatus> {
        session.select("INBOX")?;
        let unseen_uids = session.uid_search("UNSEEN")?;
        let unseen = unseen_uids.len() as u32;
        // Gmail's own importance marker, via its IMAP search extension. Not a
        // failure if the server does not support it - there is just no signal.
        let important_uids = session.uid_search("UNSEEN X-GM-RAW \"is:important\"").unwrap_or_default();
        let mut all = session.uid_search("ALL")?.into_iter().collect::<Vec<u32>>();
        all.sort_unstable();
        let latest_uid = all.last().copied().unwrap_or(0);

        let mut status = GmailStatus {
            ok: true,
            unseen,
            important_unseen: important_uids.len() as u32,
            latest_uid,
            ..Default::default()
        };
        if latest_uid > 0 {
            // Only the newest slice is ever fetched, so the request stays small
            // no matter how large the mailbox is.
            let recent: Vec<u32> = all.iter().rev().take(RECENT_LIMIT).rev().copied().collect();
            let set = recent.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
            let fetches = session.uid_fetch(set, "ENVELOPE")?;
            let mut messages: Vec<GmailMessage> = Vec::new();
            for fetch in fetches.iter() {
                let Some(uid) = fetch.uid else { continue };
                let Some(env) = fetch.envelope() else { continue };
                let from = env
                    .from
                    .as_ref()
                    .and_then(|v| v.first())
                    .map(|a| sender_label(a.name, a.mailbox, a.host))
                    .unwrap_or_default();
                messages.push(GmailMessage {
                    uid,
                    from,
                    subject: bytes_to_string(env.subject),
                    message_id: strip_angle_brackets(&bytes_to_string(env.message_id)),
                    unread: unseen_uids.contains(&uid),
                    important: important_uids.contains(&uid),
                });
            }
            // The server may answer in any order; the frontend relies on UID
            // order to decide what is new and which card sits on top.
            messages.sort_by_key(|m| m.uid);
            if let Some(newest) = messages.last() {
                status.latest_from = newest.from.clone();
                status.latest_subject = newest.subject.clone();
            }
            status.messages = messages;
        }
        Ok(status)
    })();

    let _ = session.logout();
    result.map_err(|e| format!("Could not read the inbox: {e}"))
}

/// Poll Gmail once and report the newest-message envelope + unread count.
/// Credentials are passed per-call; nothing is cached in the backend.
#[tauri::command]
pub async fn gmail_fetch(email: String, app_password: String) -> GmailStatus {
    if email.trim().is_empty() || app_password.trim().is_empty() {
        return err("Enter your Gmail address and app password first.");
    }
    tauri::async_runtime::spawn_blocking(move || match poll(email.trim(), app_password.trim()) {
        Ok(s) => s,
        Err(e) => err(e),
    })
    .await
    .unwrap_or_else(|_| err("The mail check could not run."))
}

#[cfg(test)]
mod tests {
    use super::{normalize_app_password, sender_label, strip_angle_brackets};

    #[test]
    fn accepts_google_app_passwords_with_or_without_spaces() {
        assert_eq!(normalize_app_password("abcd efgh ijkl mnop"), "abcdefghijklmnop");
        assert_eq!(normalize_app_password("abcdefghijklmnop"), "abcdefghijklmnop");
    }

    #[test]
    fn unwraps_message_ids_for_gmail_search() {
        assert_eq!(strip_angle_brackets("<abc@mail.example>"), "abc@mail.example");
        assert_eq!(strip_angle_brackets("  <abc@mail.example>  "), "abc@mail.example");
        // Already bare, or missing entirely.
        assert_eq!(strip_angle_brackets("abc@mail.example"), "abc@mail.example");
        assert_eq!(strip_angle_brackets(""), "");
    }

    #[test]
    fn prefers_display_name_then_falls_back_to_address() {
        assert_eq!(sender_label(Some(b"Alice"), Some(b"alice"), Some(b"x.com")), "Alice");
        assert_eq!(sender_label(None, Some(b"alice"), Some(b"x.com")), "alice@x.com");
        assert_eq!(sender_label(None, Some(b"alice"), None), "alice");
        assert_eq!(sender_label(None, None, None), "");
    }
}
