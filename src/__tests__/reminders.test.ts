import { describe, it, expect } from "vitest";
import { ReminderScheduler } from "../productivity/reminders";

const on = (min: number) => ({ enabled: true, intervalMin: min });
const off = { enabled: false, intervalMin: 45 };

describe("ReminderScheduler", () => {
  it("fires a stretch reminder after its interval, personalised with the name", () => {
    const s = new ReminderScheduler();
    s.configure(on(1), off, [], "Spandan", 0);
    expect(s.due(30, false)).toBeNull();
    const due = s.due(61, false);
    expect(due?.kind).toBe("stretch");
    expect(due?.message).toContain("Spandan");
  });

  it("dismiss reschedules for a full interval; snooze for 5 minutes", () => {
    const s = new ReminderScheduler();
    s.configure(on(10), off, [], "", 0);
    expect(s.due(601, false)?.id).toBe("stretch");
    s.snooze("stretch", 601);
    expect(s.due(602, false)).toBeNull();
    expect(s.due(601 + 301, false)?.id).toBe("stretch");
    s.dismiss("stretch", 1000);
    expect(s.due(1000 + 599, false)).toBeNull();
    expect(s.due(1000 + 601, false)?.id).toBe("stretch");
  });

  it("suppresses reminders while a full-screen app is active", () => {
    const s = new ReminderScheduler();
    s.configure(on(1), off, [], "", 0);
    expect(s.due(61, true)).toBeNull(); // presenting: stay quiet
    expect(s.due(62, false)).not.toBeNull();
  });

  it("stays quiet during full screen even for a reminder that had already surfaced", () => {
    const s = new ReminderScheduler();
    s.configure(on(1), off, [], "", 0);
    // Surfaces normally...
    expect(s.due(61, false)?.id).toBe("stretch");
    // ...then the user starts a film. It must not keep being handed back.
    expect(s.due(70, true)).toBeNull();
    expect(s.due(600, true)).toBeNull();
    // And it is not lost: the same reminder returns once full screen ends.
    expect(s.due(601, false)?.id).toBe("stretch");
  });

  it("reports which reminder is on screen, so the caller can retire its notice", () => {
    const s = new ReminderScheduler();
    s.configure(on(1), off, [], "", 0);
    expect(s.activeId).toBeNull();
    s.due(61, false);
    expect(s.activeId).toBe("stretch");
    // Being suppressed by full screen does not clear the schedule.
    s.due(62, true);
    expect(s.activeId).toBe("stretch");
    s.dismiss("stretch", 62);
    expect(s.activeId).toBeNull();
  });

  it("supports custom reminders and drops removed ones on reconfigure", () => {
    const s = new ReminderScheduler();
    s.configure(off, off, [{ id: "c1", message: "Check the oven", intervalMin: 1, enabled: true }], "", 0);
    const due = s.due(61, false);
    expect(due?.message).toBe("Check the oven");
    // Reconfigure without the custom reminder: nothing further fires.
    s.configure(off, off, [], "", 61);
    expect(s.due(300, false)).toBeNull();
  });

  it("surfaces only one reminder at a time", () => {
    const s = new ReminderScheduler();
    s.configure(on(1), on(1), [], "", 0);
    const first = s.due(61, false);
    expect(first).not.toBeNull();
    // Second poll returns the same active reminder, not a new one.
    expect(s.due(62, false)?.id).toBe(first?.id);
    s.dismiss(first!.id, 62);
    const second = s.due(63, false);
    expect(second?.id).not.toBe(first?.id);
  });
});
