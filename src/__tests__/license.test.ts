import { describe, it, expect } from "vitest";
import { resolveLicenseState, canUse, licenseSummary, TRIAL_DAYS } from "../licensing/license";

const DAY = 86400;
const now = 1_800_000_000;

describe("licence + trial state", () => {
  it("grants full features on first run and counts the trial down", () => {
    const fresh = resolveLicenseState({ licensed: false, firstRunUnix: now, nowUnix: now });
    expect(fresh.premium).toBe(true);
    expect(fresh.trialActive).toBe(true);
    expect(fresh.trialDaysLeft).toBe(TRIAL_DAYS);

    const midway = resolveLicenseState({ licensed: false, firstRunUnix: now - 10 * DAY, nowUnix: now });
    expect(midway.trialDaysLeft).toBe(TRIAL_DAYS - 10);
    expect(midway.premium).toBe(true);
  });

  it("drops to the free tier once the trial expires", () => {
    const expired = resolveLicenseState({ licensed: false, firstRunUnix: now - (TRIAL_DAYS + 1) * DAY, nowUnix: now });
    expect(expired.trialActive).toBe(false);
    expect(expired.trialDaysLeft).toBe(0);
    expect(expired.premium).toBe(false);
    expect(canUse(expired, "breeds")).toBe(false);
    expect(canUse(expired, "productivity")).toBe(false);
  });

  it("a licence restores everything regardless of trial age", () => {
    const licensed = resolveLicenseState({
      licensed: true,
      name: "Jane",
      firstRunUnix: now - 900 * DAY,
      nowUnix: now,
    });
    expect(licensed.premium).toBe(true);
    expect(canUse(licensed, "context")).toBe(true);
    expect(licenseSummary(licensed)).toContain("Jane");
  });

  it("cannot be extended by moving the clock backwards", () => {
    // firstRun stamped in the "future" relative to now must not yield an
    // endless trial — it collapses to day zero, not negative elapsed days.
    const skewed = resolveLicenseState({ licensed: false, firstRunUnix: now + 500 * DAY, nowUnix: now });
    expect(skewed.trialDaysLeft).toBeLessThanOrEqual(TRIAL_DAYS);
    expect(skewed.trialDaysLeft).toBeGreaterThanOrEqual(0);
  });

  describe("with a trusted anchor from the credential vault", () => {
    it("a start date in the future is tampering, not a fresh trial", () => {
      // Untrusted (vault unavailable): stay lenient, as it always was — a
      // wrong system clock must never cost an honest user their trial.
      const lenient = resolveLicenseState({ licensed: false, firstRunUnix: now + 500 * DAY, nowUnix: now });
      expect(lenient.trialDaysLeft).toBe(TRIAL_DAYS);
      expect(lenient.premium).toBe(true);

      // Trusted: the backend's watermark only moves forwards, so a start in
      // the future cannot happen honestly. It reads as spent.
      const trusted = resolveLicenseState({
        licensed: false,
        firstRunUnix: now + 500 * DAY,
        nowUnix: now,
        trustedAnchor: true,
      });
      expect(trusted.trialDaysLeft).toBe(0);
      expect(trusted.trialActive).toBe(false);
      expect(trusted.premium).toBe(false);
    });

    it("an honest trial is unaffected by the anchor being trusted", () => {
      const mid = resolveLicenseState({
        licensed: false,
        firstRunUnix: now - 3 * DAY,
        nowUnix: now,
        trustedAnchor: true,
      });
      expect(mid.trialDaysLeft).toBe(TRIAL_DAYS - 3);
      expect(mid.premium).toBe(true);
    });

    it("a paying customer is never locked out by anchor rules", () => {
      const licensed = resolveLicenseState({
        licensed: true,
        firstRunUnix: now + 900 * DAY, // nonsense stamp
        nowUnix: now,
        trustedAnchor: true,
      });
      expect(licensed.premium).toBe(true);
    });

    it("an expired trial stays expired whether or not the anchor is trusted", () => {
      for (const trustedAnchor of [true, false]) {
        const expired = resolveLicenseState({
          licensed: false,
          firstRunUnix: now - (TRIAL_DAYS + 5) * DAY,
          nowUnix: now,
          trustedAnchor,
        });
        expect(expired.premium).toBe(false);
      }
    });
  });

  it("summarises each state for the settings panel", () => {
    expect(licenseSummary(resolveLicenseState({ licensed: false, firstRunUnix: now, nowUnix: now }))).toContain("Trial");
    const lastDay = resolveLicenseState({ licensed: false, firstRunUnix: now - (TRIAL_DAYS - 1) * DAY, nowUnix: now });
    expect(licenseSummary(lastDay)).toContain("last day");
    const free = resolveLicenseState({ licensed: false, firstRunUnix: now - 99 * DAY, nowUnix: now });
    expect(licenseSummary(free)).toContain("Free version");
  });
});
