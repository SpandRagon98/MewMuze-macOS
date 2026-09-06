import { describe, it, expect } from "vitest";
import {
  addMail,
  visibleMail,
  queuedCount,
  dismissMail,
  clampStackLimit,
  MAIL_STACK_DEFAULT,
  MAIL_QUEUE_MAX,
  type MailItem,
} from "../integrations/mailStack";
import { gmailMessageUrl, mailLine, mailNotice, newMessages, type GmailStatus } from "../integrations/gmail";
import { sanitizeSettings } from "../settings/settingsStore";

function mail(uid: number, over: Partial<MailItem> = {}): MailItem {
  return { uid, from: `Sender ${uid}`, subject: `Subject ${uid}`, messageId: `id${uid}@mail.test`, ...over };
}

/** `n` arrivals, oldest first, exactly as a poll reports them. */
function burst(count: number, startUid = 1): MailItem[] {
  return Array.from({ length: count }, (_, i) => mail(startUid + i));
}

describe("stack limit", () => {
  it("defaults to five and clamps anything outside 1–5", () => {
    expect(MAIL_STACK_DEFAULT).toBe(5);
    expect(clampStackLimit(3)).toBe(3);
    expect(clampStackLimit(0)).toBe(1);
    expect(clampStackLimit(9)).toBe(5);
    expect(clampStackLimit(-4)).toBe(1);
  });

  it("rounds and survives junk from a hand-edited settings file", () => {
    expect(clampStackLimit(3.7)).toBe(4);
    expect(clampStackLimit("2")).toBe(2);
    expect(clampStackLimit("nonsense")).toBe(MAIL_STACK_DEFAULT);
    expect(clampStackLimit(null)).toBe(MAIL_STACK_DEFAULT);
    expect(clampStackLimit(undefined)).toBe(MAIL_STACK_DEFAULT);
  });

  it("persists through the settings sanitiser, defaulting to five", () => {
    expect(sanitizeSettings({}).gmail.maxStack).toBe(5);
    expect(sanitizeSettings({ gmail: { maxStack: 2 } }).gmail.maxStack).toBe(2);
    // Out of range and wrong type both land on something usable.
    expect(sanitizeSettings({ gmail: { maxStack: 99 } }).gmail.maxStack).toBe(5);
    expect(sanitizeSettings({ gmail: { maxStack: "x" } }).gmail.maxStack).toBe(5);
  });
});

describe("stacking newly arrived mail", () => {
  it("shows the newest first, so the freshest card sits nearest the cat", () => {
    const items = addMail([], burst(3));
    expect(items.map((m) => m.uid)).toEqual([3, 2, 1]);
  });

  it("the worked example: 8 arrive with the limit at 5", () => {
    const items = addMail([], burst(8));
    const visible = visibleMail(items, 5);

    // The latest five are shown...
    expect(visible.map((m) => m.uid)).toEqual([8, 7, 6, 5, 4]);
    // ...and the remaining three are kept, not dropped.
    expect(queuedCount(items, 5)).toBe(3);
    expect(items).toHaveLength(8);
  });

  it("dismissing one reveals the next queued message", () => {
    let items = addMail([], burst(8));
    expect(visibleMail(items, 5).map((m) => m.uid)).toEqual([8, 7, 6, 5, 4]);

    items = dismissMail(items, 8); // OK on the newest card
    expect(visibleMail(items, 5).map((m) => m.uid)).toEqual([7, 6, 5, 4, 3]);
    expect(queuedCount(items, 5)).toBe(2);

    // Dismissing out of the MIDDLE promotes the next one just the same.
    items = dismissMail(items, 5);
    expect(visibleMail(items, 5).map((m) => m.uid)).toEqual([7, 6, 4, 3, 2]);
    expect(queuedCount(items, 5)).toBe(1);
  });

  it("drains to empty without ever resurrecting a dismissed card", () => {
    let items = addMail([], burst(6));
    for (const uid of [1, 2, 3, 4, 5, 6]) items = dismissMail(items, uid);
    expect(items).toEqual([]);
    expect(visibleMail(items, 5)).toEqual([]);
    expect(queuedCount(items, 5)).toBe(0);
  });

  it("honours a lower user limit, queueing the rest", () => {
    const items = addMail([], burst(4));
    expect(visibleMail(items, 1).map((m) => m.uid)).toEqual([4]);
    expect(queuedCount(items, 1)).toBe(3);
    expect(visibleMail(items, 3).map((m) => m.uid)).toEqual([4, 3, 2]);
    expect(queuedCount(items, 3)).toBe(1);
  });

  it("never stacks the same message twice across overlapping polls", () => {
    // Two polls whose reported windows overlap on uids 2 and 3.
    const first = addMail([], burst(3));
    const second = addMail(first, [mail(2), mail(3), mail(4)]);
    expect(second.map((m) => m.uid)).toEqual([4, 3, 2, 1]);
  });

  it("re-fetching an envelope refreshes the card rather than duplicating it", () => {
    const items = addMail(addMail([], [mail(1, { subject: "Draft" })]), [mail(1, { subject: "Final" })]);
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe("Final");
  });

  it("caps total retention so a flood cannot grow without bound", () => {
    const items = addMail([], burst(MAIL_QUEUE_MAX + 25));
    expect(items).toHaveLength(MAIL_QUEUE_MAX);
    // The newest survive; the oldest queued are what gets dropped.
    expect(items[0].uid).toBe(MAIL_QUEUE_MAX + 25);
  });

  it("dismissing an unknown uid is a no-op", () => {
    const items = addMail([], burst(2));
    expect(dismissMail(items, 999)).toEqual(items);
  });
});

function status(over: Partial<GmailStatus> = {}): GmailStatus {
  return { ok: true, error: null, unseen: 0, latestUid: 0, latestFrom: "", latestSubject: "", ...over };
}

describe("selecting what is new from a poll", () => {
  it("stays silent on the first successful poll (no baseline yet)", () => {
    const st = status({ latestUid: 3, messages: burst(3) });
    expect(newMessages(0, st)).toEqual([]);
  });

  it("returns every message past the baseline, oldest first", () => {
    const st = status({ latestUid: 5, messages: burst(5) });
    expect(newMessages(2, st).map((m) => m.uid)).toEqual([3, 4, 5]);
  });

  it("returns nothing when the whole window is already seen", () => {
    expect(newMessages(5, status({ latestUid: 5, messages: burst(5) }))).toEqual([]);
  });

  it("never fires on a failed poll", () => {
    expect(newMessages(2, status({ ok: false, latestUid: 9, messages: burst(9) }))).toEqual([]);
  });

  it("falls back to the single latest envelope when no list is sent", () => {
    const st = status({ latestUid: 7, latestFrom: "Alice", latestSubject: "Hi" });
    const fresh = newMessages(6, st);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ uid: 7, from: "Alice", subject: "Hi", messageId: "" });
    // Still respects the baseline rule.
    expect(newMessages(7, st)).toEqual([]);
  });

  it("greets with the local name from Settings, whatever it is", () => {
    // The exact path App uses: persisted settings → userName → card label.
    const settings = sanitizeSettings({ userName: "Spandy" });
    const card = mailLine(mail(1, { from: "SPANDAN TALUKDAR", subject: "Heyy" }), settings.userName);
    expect(card).toBe("Spandy, new email from SPANDAN TALUKDAR — Heyy");

    // Rename in Settings and the greeting follows, with no other wording change.
    const renamed = sanitizeSettings({ userName: "Bunny" });
    expect(mailLine(mail(1, { from: "SPANDAN TALUKDAR", subject: "Heyy" }), renamed.userName)).toBe(
      "Bunny, new email from SPANDAN TALUKDAR — Heyy",
    );

    // Left blank (it is optional) the sentence simply starts at "new email".
    const blank = sanitizeSettings({});
    expect(blank.userName).toBe("");
    expect(mailLine(mail(1, { from: "SPANDAN TALUKDAR", subject: "Heyy" }), blank.userName)).toBe(
      "new email from SPANDAN TALUKDAR — Heyy",
    );
  });

  it("labels each card with the same sentence the single notice always used", () => {
    const m = mail(1, { from: "Alice", subject: "Review" });
    expect(mailLine(m, "Spandan")).toBe("Spandan, new email from Alice — Review");
    // Identical phrasing to mailNotice, so a stacked card reads as it always did.
    expect(mailLine(m, "Spandan")).toBe(
      mailNotice(status({ latestFrom: "Alice", latestSubject: "Review" }), "Spandan"),
    );
    expect(mailLine(m, "")).toBe("new email from Alice — Review");
    expect(mailLine(mail(1, { from: "Alice", subject: "" }), "Spandan")).toBe("Spandan, new email from Alice");
    expect(mailLine(mail(1, { from: "", subject: "" }), "")).toBe("new email from someone");
  });
});

describe("the Open button's destination", () => {
  it("deep-links to the exact message when a Message-ID is available", () => {
    expect(gmailMessageUrl("abc123@mail.gmail.com")).toBe(
      "https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc123%40mail.gmail.com",
    );
  });

  it("falls back to the inbox when there is no usable identifier", () => {
    const inbox = "https://mail.google.com/mail/u/0/#inbox";
    expect(gmailMessageUrl("")).toBe(inbox);
    expect(gmailMessageUrl("   ")).toBe(inbox);
    // No @ — not an addr-spec, so not a Message-ID we trust.
    expect(gmailMessageUrl("just-a-string")).toBe(inbox);
  });

  it("refuses anything that is not a plain Message-ID rather than building a URL from it", () => {
    const inbox = "https://mail.google.com/mail/u/0/#inbox";
    expect(gmailMessageUrl("a b@c.com")).toBe(inbox); // whitespace
    expect(gmailMessageUrl("<abc@x.com>")).toBe(inbox); // brackets should be stripped upstream
    expect(gmailMessageUrl(`${"x".repeat(300)}@y.com`)).toBe(inbox); // absurdly long
  });

  it("always stays on Gmail's own origin", () => {
    for (const id of ["abc@x.com", "", "javascript:alert(1)@x", "//evil.com@x.com"]) {
      expect(gmailMessageUrl(id).startsWith("https://mail.google.com/mail/u/0/")).toBe(true);
    }
  });
});
