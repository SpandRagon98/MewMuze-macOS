//! Email companion: which of the new mail might actually need the user.
//!
//! Reuses the existing Gmail connection (IMAP, envelope only - the body is
//! never fetched). The strongest signal is Gmail's own "Important" marker,
//! which the Rust side now reads; subject and sender heuristics refine it.
//! Nothing here ever shows more than a sender and a trimmed subject.

export interface MailMsg {
  uid: number;
  from: string;
  subject: string;
  /** Gmail marked it Important. */
  important?: boolean;
  unread?: boolean;
}

const ATTENTION = /\b(urgent|asap|action required|action needed|deadline|due today|overdue|invoice|payment|interview|offer letter|contract|approval|approve|security alert|password|verify your|sign(ed)? in|confirm)\b/i;
const BULK_SENDER = /(no-?reply|do-?not-?reply|newsletter|notifications?@|mailer|marketing|promo|digest|updates@|news@|info@)/i;
const BULK_SUBJECT = /\b(newsletter|unsubscribe|% off|sale|deal|webinar|digest|weekly|daily|recap)\b/i;

/** 3 or more means "may need your attention". */
export const ATTENTION_SCORE = 3;

export function mailScore(m: MailMsg): number {
  let s = 0;
  if (m.important) s += 3;
  if (ATTENTION.test(m.subject)) s += 2;
  if (m.subject.trim().startsWith("Re:")) s += 1; // someone replied to you
  if (BULK_SENDER.test(m.from)) s -= 3;
  if (BULK_SUBJECT.test(m.subject)) s -= 2;
  return s;
}

export const needsAttention = (m: MailMsg): boolean => mailScore(m) >= ATTENTION_SCORE;

/** "Priya Sharma" rather than "priya.sharma@example.com" where possible. */
export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  return (name || from).slice(0, 40);
}

export function shortSubject(subject: string, max = 48): string {
  const s = subject.replace(/\s+/g, " ").trim() || "(no subject)";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const count = (n: number) => WORDS[n] ?? String(n);

/**
 * Lines describing a batch of arrivals. Null when nothing needs attention AND
 * the batch is small - "three newsletters arrived" is not worth interrupting
 * anyone for.
 */
export function describeArrivals(arrivals: MailMsg[], whileAway: boolean): string[] | null {
  if (arrivals.length === 0) return null;
  const hot = arrivals.filter(needsAttention).sort((a, b) => mailScore(b) - mailScore(a));
  if (hot.length === 0 && arrivals.length < 5) return null;
  const n = arrivals.length;
  const head = `${n === 1 ? "One email" : `${n} emails`} arrived${whileAway ? " while you were away" : ""}.`;
  const lines = [hot.length ? `${head} ${count(hot.length)} may need your attention.` : head];
  // Sender and subject only, and only for the ones that matter.
  for (const m of hot.slice(0, 3)) lines.push(`${senderName(m.from)}: ${shortSubject(m.subject)}`);
  return lines;
}
