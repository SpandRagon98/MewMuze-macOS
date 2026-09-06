//! Gmail connector (frontend side).
//!
//! Thin wrapper over the Rust `gmail_fetch` IMAP poll, plus the pure logic that
//! decides when a *new* message warrants a notification. Kept separate from any
//! Tauri runtime so the decision functions are unit-testable.

/** One message's envelope — sender, subject and Message-ID. Never the body. */
export interface GmailMessage {
  uid: number;
  from: string;
  subject: string;
  /** RFC822 Message-ID without angle brackets; "" when the header was absent. */
  messageId: string;
}

export interface GmailStatus {
  ok: boolean;
  error: string | null;
  unseen: number;
  latestUid: number;
  latestFrom: string;
  latestSubject: string;
  /** Newest envelopes, oldest-first. Absent on older backends. */
  messages?: GmailMessage[];
}

/** How often the App polls the inbox while connected (ms). */
export const GMAIL_POLL_MS = 60_000;

const GMAIL_BASE = "https://mail.google.com/mail/u/0/";

/**
 * Where the [Open] button sends the browser.
 *
 * Gmail's web UI can jump straight to a message by its RFC822 Message-ID via
 * the `rfc822msgid:` search operator — which needs nothing but the header we
 * already read for the notification, so the button costs no extra scope, no
 * OAuth and no API call. Anything unusable (missing header, or characters that
 * have no business in a Message-ID) falls back to the plain inbox rather than
 * building a URL out of untrusted text.
 */
export function gmailMessageUrl(messageId: string): string {
  const id = messageId.trim();
  // A Message-ID is `addr-spec`-shaped: no spaces, no quotes, no angle
  // brackets, and never long enough to be a smuggled URL.
  if (!id || id.length > 200 || !/^[!-;=?-~]+$/.test(id) || !id.includes("@")) {
    return `${GMAIL_BASE}#inbox`;
  }
  return `${GMAIL_BASE}#search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: Invoke | null = null;

/** Poll the inbox once via the backend. Returns null in a non-Tauri context. */
export async function pollGmail(email: string, appPassword: string): Promise<GmailStatus | null> {
  try {
    if (!invokeFn) {
      const mod = await import("@tauri-apps/api/core");
      invokeFn = mod.invoke as unknown as Invoke;
    }
    return await invokeFn("gmail_fetch", { email, appPassword });
  } catch {
    return null;
  }
}

/**
 * A message is "new" only when a successful poll reports a UID strictly higher
 * than the last one we surfaced — and only once we have a baseline (prevUid > 0),
 * so connecting to an inbox that already has mail doesn't fire a burst.
 */
export function isNewMail(prevUid: number, status: GmailStatus): boolean {
  return status.ok && status.latestUid > 0 && prevUid > 0 && status.latestUid > prevUid;
}

/** Build the single-line notice for a freshly arrived message. */
export function mailNotice(status: GmailStatus, userName: string): string {
  const who = status.latestFrom.trim() || "someone";
  const hey = userName.trim() ? `${userName.trim()}, ` : "";
  const subject = status.latestSubject.trim();
  return subject
    ? `${hey}new email from ${who} — ${subject}`
    : `${hey}new email from ${who}`;
}

/**
 * The envelopes in this poll that arrived after `prevUid`, oldest-first.
 *
 * Same baseline rule as `isNewMail`: without a previous UID this is the first
 * successful poll, so everything already sitting in the inbox is history, not
 * news. Falls back to the single `latest*` envelope when the backend did not
 * send a `messages` list (an older build, or a server that returned none).
 */
export function newMessages(prevUid: number, status: GmailStatus): GmailMessage[] {
  if (!status.ok || prevUid <= 0) return [];
  const list = status.messages;
  if (!list || list.length === 0) {
    return isNewMail(prevUid, status)
      ? [
          {
            uid: status.latestUid,
            from: status.latestFrom,
            subject: status.latestSubject,
            messageId: "",
          },
        ]
      : [];
  }
  return list.filter((m) => m.uid > prevUid).sort((a, b) => a.uid - b.uid);
}

/**
 * One stacked card's single line of text. Same sentence the single mail notice
 * always used — the reader's name, that it is a new email, then who it is from
 * and what about — so a stacked card reads exactly like the old one did.
 */
export function mailLine(message: GmailMessage, userName: string): string {
  const who = message.from.trim() || "someone";
  const hey = userName.trim() ? `${userName.trim()}, ` : "";
  const subject = message.subject.trim();
  return subject
    ? `${hey}new email from ${who} — ${subject}`
    : `${hey}new email from ${who}`;
}
