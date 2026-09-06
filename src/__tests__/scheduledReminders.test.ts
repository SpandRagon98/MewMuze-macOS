import { describe, it, expect } from "vitest";
import {
  activeScheduled,
  snoozeScheduled,
  completeScheduled,
  pruneScheduled,
  makeScheduled,
  scheduledMessage,
  SNOOZE_S,
} from "../productivity/scheduledReminders";
import type { ScheduledReminder } from "../settings/defaultSettings";

const BASE = 1_800_000_000; // an arbitrary fixed unix time

function reminder(over: Partial<ScheduledReminder> = {}): ScheduledReminder {
  return {
    id: "r1",
    title: "Stakeholder Meeting",
    dueUnix: BASE + 600, // due in 10 minutes
    earlyWarnMin: 5,
    snoozedUntil: 0,
    done: false,
    ...over,
  };
}

describe("scheduled reminders", () => {
  it("is silent before the warn window", () => {
    expect(activeScheduled([reminder()], BASE, "Spandan")).toBeNull();
  });

  it("enters warn at due - earlyWarnMin with a light-green message", () => {
    const a = activeScheduled([reminder()], BASE + 301, "Spandan");
    expect(a).not.toBeNull();
    expect(a!.phase).toBe("warn");
    expect(a!.message).toBe("Spandan, Stakeholder Meeting in 5 minutes.");
  });

  it("switches to due at the due time", () => {
    const a = activeScheduled([reminder()], BASE + 600, "Spandan");
    expect(a!.phase).toBe("due");
    expect(a!.message).toBe("Spandan, Stakeholder Meeting is now. Please join.");
  });

  it("falls back to neutral wording without a name", () => {
    expect(scheduledMessage("Standup", "due", 0, "")).toBe("Standup is now. Please join.");
    expect(scheduledMessage("Standup", "warn", 3, "  ")).toBe("Standup in 3 minutes.");
  });

  it("skips reminders with no early warning until they are due", () => {
    const r = reminder({ earlyWarnMin: 0 });
    expect(activeScheduled([r], BASE + 599, "")).toBeNull();
    expect(activeScheduled([r], BASE + 600, "")!.phase).toBe("due");
  });

  it("snooze hides it for five minutes, then it returns still due", () => {
    let list = [reminder()];
    list = snoozeScheduled(list, "r1", BASE + 600);
    expect(activeScheduled(list, BASE + 600 + SNOOZE_S - 1, "")).toBeNull();
    expect(activeScheduled(list, BASE + 600 + SNOOZE_S, "")!.phase).toBe("due");
  });

  it("complete retires it for good and prune drops it", () => {
    let list = [reminder()];
    list = completeScheduled(list, "r1");
    expect(activeScheduled(list, BASE + 900, "")).toBeNull();
    expect(pruneScheduled(list, BASE)).toHaveLength(0);
  });

  it("a due reminder outranks a warn from another", () => {
    const warn = reminder({ id: "later", dueUnix: BASE + 240, earlyWarnMin: 5 });
    const due = reminder({ id: "now", dueUnix: BASE - 30 });
    const a = activeScheduled([warn, due], BASE, "");
    expect(a!.id).toBe("now");
    expect(a!.phase).toBe("due");
  });

  it("reminders more than a day past due expire silently", () => {
    const stale = reminder({ dueUnix: BASE - 25 * 3600 });
    expect(activeScheduled([stale], BASE, "")).toBeNull();
    expect(pruneScheduled([stale], BASE)).toHaveLength(0);
  });

  it("makeScheduled builds a valid reminder and rejects junk", () => {
    const r = makeScheduled("Standup", "2026-08-01", "09:30", 5);
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Standup");
    expect(r!.earlyWarnMin).toBe(5);
    const d = new Date(r!.dueUnix * 1000);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(makeScheduled("", "2026-08-01", "09:30", 5)).toBeNull();
    expect(makeScheduled("X", "", "09:30", 5)).toBeNull();
    expect(makeScheduled("X", "junk", "junk", 5)).toBeNull();
  });
});
