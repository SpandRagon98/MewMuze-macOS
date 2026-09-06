import { describe, it, expect } from "vitest";
import { isNewMail, mailNotice, type GmailStatus } from "../integrations/gmail";
import { calendarAlert, eventStartMs, type CalEventRaw } from "../integrations/calendar";

function status(over: Partial<GmailStatus> = {}): GmailStatus {
  return { ok: true, error: null, unseen: 0, latestUid: 0, latestFrom: "", latestSubject: "", ...over };
}

describe("gmail new-mail detection", () => {
  it("never fires without a baseline (first successful poll)", () => {
    expect(isNewMail(0, status({ latestUid: 42 }))).toBe(false);
  });

  it("fires only when the UID climbs past the last seen", () => {
    expect(isNewMail(42, status({ latestUid: 43 }))).toBe(true);
    expect(isNewMail(42, status({ latestUid: 42 }))).toBe(false);
    expect(isNewMail(42, status({ latestUid: 41 }))).toBe(false);
  });

  it("never fires on a failed poll", () => {
    expect(isNewMail(42, status({ ok: false, latestUid: 99 }))).toBe(false);
  });

  it("builds a friendly one-line notice with name, sender and subject", () => {
    const s = status({ latestFrom: "Alice", latestSubject: "Project review" });
    expect(mailNotice(s, "Spandan")).toBe("Spandan, new email from Alice — Project review");
    expect(mailNotice(s, "")).toBe("new email from Alice — Project review");
    expect(mailNotice(status({ latestFrom: "Bob" }), "")).toBe("new email from Bob");
  });
});

const MIN = 60_000;

function event(startMs: number, summary = "Standup", allDay = false): CalEventRaw {
  const d = new Date(startMs);
  return {
    summary,
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    allDay,
    utc: false,
  };
}

describe("calendar alerts", () => {
  const now = new Date(2026, 6, 24, 9, 0, 0).getTime(); // local 09:00

  it("resolves a local (floating) event to local wall time", () => {
    const e = event(now);
    expect(eventStartMs(e)).toBe(now);
  });

  it("resolves a UTC event via Date.UTC", () => {
    const e: CalEventRaw = { summary: "X", year: 2026, month: 7, day: 24, hour: 14, minute: 0, allDay: false, utc: true };
    expect(eventStartMs(e)).toBe(Date.UTC(2026, 6, 24, 14, 0));
  });

  it("stays silent when nothing is within the warn window", () => {
    const e = event(now + 60 * MIN); // an hour out, warn is 10 min
    expect(calendarAlert([e], now, 10, "Spandan")).toBeNull();
  });

  it("warns inside the early window with a green phase", () => {
    const e = event(now + 5 * MIN);
    const a = calendarAlert([e], now, 10, "Spandan");
    expect(a).not.toBeNull();
    expect(a!.phase).toBe("warn");
    expect(a!.message).toBe("Spandan, Standup in 5 minutes");
  });

  it("switches to due at start time and for a short grace period", () => {
    const e = event(now);
    const a = calendarAlert([e], now, 10, "");
    expect(a!.phase).toBe("due");
    expect(a!.message).toBe("Standup is starting now");
    // Still due 2 minutes in, gone after the grace period.
    expect(calendarAlert([e], now + 2 * MIN, 10, "")!.phase).toBe("due");
    expect(calendarAlert([e], now + 30 * MIN, 10, "")).toBeNull();
  });

  it("a due event outranks a warning from another", () => {
    const soon = event(now + 4 * MIN, "Later");
    const nowish = event(now, "Now");
    const a = calendarAlert([soon, nowish], now, 10, "");
    expect(a!.message).toBe("Now is starting now");
    expect(a!.phase).toBe("due");
  });

  it("ignores all-day events for timed alarms", () => {
    const e = event(now, "Holiday", true);
    expect(calendarAlert([e], now, 10, "")).toBeNull();
  });

  it("gives every alert a stable id for de-duping", () => {
    const e = event(now + 3 * MIN);
    const a1 = calendarAlert([e], now, 10, "");
    const a2 = calendarAlert([e], now + MIN, 10, "");
    expect(a1!.id).toBe(a2!.id); // same event, same id even as time passes
  });
});
