//! The stack of unread-mail notifications waiting above the cat.
//!
//! Pure list logic, no React and no Tauri, so the awkward parts — a burst that
//! overflows the visible limit, dismissing out of the middle, the same UID
//! arriving twice across two polls — are unit-testable.
//!
//! One invariant runs through the whole module: `items` is always sorted
//! **newest first**. "Show the latest N" is then just the head of the list, and
//! dismissing any card promotes whatever queued message now falls inside the
//! window, with no separate queue to keep in sync.

import type { GmailMessage } from "./gmail";

/** A card in the stack. Same envelope-only shape the poll returns. */
export type MailItem = GmailMessage;

export const MAIL_STACK_MIN = 1;
export const MAIL_STACK_MAX = 5;
export const MAIL_STACK_DEFAULT = 5;

/**
 * Hard ceiling on everything held, visible plus queued. A mailbox that receives
 * hundreds of messages while the user is in a full-screen film must not grow an
 * unbounded array; past this point the oldest queued mail is dropped, which is
 * the one the user is least likely to still care about.
 */
export const MAIL_QUEUE_MAX = 50;

/**
 * Clamp a persisted/user-chosen limit into the supported 1–5 range.
 *
 * Only numbers and numeric strings count as a value. `Number()` alone would
 * turn `null`, `false` and `""` into 0, which then clamps to 1 — so a missing
 * or nulled-out setting would silently shrink the stack to a single card
 * instead of falling back to the default.
 */
export function clampStackLimit(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return MAIL_STACK_DEFAULT;
  if (typeof value === "string" && value.trim() === "") return MAIL_STACK_DEFAULT;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MAIL_STACK_DEFAULT;
  return Math.min(MAIL_STACK_MAX, Math.max(MAIL_STACK_MIN, n));
}

/**
 * Merge freshly polled messages into the stack, newest first.
 *
 * De-duplicates on UID: a poll reports a window of recent envelopes, so the
 * same message legitimately appears in consecutive polls and must not stack up
 * twice. Incoming copies win, so a re-fetched envelope refreshes its card.
 */
export function addMail(items: MailItem[], incoming: MailItem[]): MailItem[] {
  if (incoming.length === 0) return items;
  const byUid = new Map<number, MailItem>();
  for (const item of items) byUid.set(item.uid, item);
  for (const item of incoming) byUid.set(item.uid, item);
  return [...byUid.values()].sort((a, b) => b.uid - a.uid).slice(0, MAIL_QUEUE_MAX);
}

/** The cards actually on screen: the newest `limit` of them. */
export function visibleMail(items: MailItem[], limit: number): MailItem[] {
  return items.slice(0, clampStackLimit(limit));
}

/** How many messages are held back behind the visible ones. */
export function queuedCount(items: MailItem[], limit: number): number {
  return Math.max(0, items.length - clampStackLimit(limit));
}

/**
 * Remove one card (OK, or Open once the browser has it). Whatever was queued
 * directly behind the visible window becomes visible on the next render —
 * that promotion is implicit in the ordering, not a separate step.
 */
export function dismissMail(items: MailItem[], uid: number): MailItem[] {
  return items.filter((item) => item.uid !== uid);
}
