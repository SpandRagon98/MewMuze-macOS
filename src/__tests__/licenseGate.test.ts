import { describe, it, expect } from "vitest";
// Vite's raw loader: no @types/node needed just to read one file in a test.
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import appSource from "../App.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import gateSource from "../components/LicenseGate.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import activationWindowSource from "../native/activationWindow.ts?raw";
import { resolveLicenseState, licenseSummary } from "../licensing/license";

/**
 * App.tsx withholds the cat when `!licensed && !trialActive`. These lock in the
 * four states that decides, so a change to trial maths cannot silently either
 * lock out a paying customer or hand out an unlimited free copy.
 */
const blocked = (s: { licensed: boolean; trialActive: boolean }) => !s.licensed && !s.trialActive;

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("licence gate", () => {
  it("blocks a fresh install before the trial is started", () => {
    // firstRunUnix stays 0 until the gate's Start trial button stamps it.
    const state = resolveLicenseState({ licensed: false, firstRunUnix: 0, nowUnix: NOW });
    expect(state.trialActive).toBe(false);
    expect(blocked(state)).toBe(true);
  });

  it("lets the cat out once the trial is started", () => {
    const state = resolveLicenseState({ licensed: false, firstRunUnix: NOW, nowUnix: NOW });
    expect(state.trialDaysLeft).toBe(14);
    expect(blocked(state)).toBe(false);
  });

  it("blocks again when the trial has run out", () => {
    const state = resolveLicenseState({
      licensed: false,
      firstRunUnix: NOW - 15 * DAY,
      nowUnix: NOW,
    });
    expect(state.trialDaysLeft).toBe(0);
    expect(blocked(state)).toBe(true);
  });

  it("never blocks a licensed customer, including on offline grace", () => {
    const state = resolveLicenseState({
      licensed: true,
      firstRunUnix: NOW - 900 * DAY,
      nowUnix: NOW,
      source: "dodo",
      offlineGrace: true,
    });
    expect(blocked(state)).toBe(false);
  });

  it("directs purchasers to the Dodo email before asking for their key", () => {
    expect(gateSource).toContain("Your key is in your email");
    expect(gateSource).toContain("Dodo Payments sent your MewMuze licence key");
    expect(gateSource).toMatch(/Spam and Promotions/i);
  });

  it("offers minimise and close controls during activation", () => {
    expect(gateSource).toContain('aria-label="Minimize activation window"');
    expect(gateSource).toContain('aria-label="Close MewMuze"');
    expect(gateSource).toContain("minimizeActivationWindow()");
    expect(gateSource).toContain("onClick={onQuit}");
  });

  it("shows a taskbar entry only while the activation gate is mounted", () => {
    expect(gateSource).toContain("setActivationWindowMode(true)");
    expect(gateSource).toContain("setActivationWindowMode(false)");
    expect(activationWindowSource).toContain('invoke("set_activation_window_mode", { active })');
  });

  it("tells an activated buyer the purchase is permanent", () => {
    const state = resolveLicenseState({ licensed: true, firstRunUnix: NOW, nowUnix: NOW, source: "dodo" });
    // A buyer arriving from the trial needs to see this is not another countdown.
    expect(licenseSummary(state)).toMatch(/lifetime/i);
    expect(licenseSummary(state)).not.toMatch(/trial|days left/i);
  });
});

/**
 * Guards the activation bug: activating used to succeed and then immediately
 * re-validate over the network, and that second call died on the 4s invokeSafe
 * timeout, so a real purchase displayed as "Trial: N days left".
 */
describe("activation does not re-check over the network", () => {
  const app: string = appSource;
  // Anchor on the quoted command name so prose mentioning it does not match.
  const activateBlock = app.slice(
    app.indexOf('"activate_dodo_license"'),
    app.indexOf("return dodo?.error"),
  );

  it("publishes the activation response instead of calling check_dodo_license", () => {
    expect(activateBlock).toContain("publishLicense");
    expect(activateBlock).not.toContain("refreshLicense(");
    expect(activateBlock).not.toContain('"check_dodo_license"');
  });

  it("gives every networked licence command more time than the Rust side takes", () => {
    // Rust allows 5s connect + 8s read/write; a shorter JS guard steals the answer.
    const guard = Number(/LICENSE_INVOKE_TIMEOUT_MS = (\d+)/.exec(app)?.[1]);
    expect(guard).toBeGreaterThan(13000);
    for (const cmd of ["activate_dodo_license", "deactivate_dodo_license"]) {
      const callPattern = new RegExp(
        `invokeSafe<NativeLicenseStatus>\\(\\s*"${cmd}"[\\s\\S]{0,180}LICENSE_INVOKE_TIMEOUT_MS`,
      );
      expect(app, `${cmd} must use the licence timeout`).toMatch(callPattern);
    }
    expect(app).toMatch(
      /invokeSafe<NativeLicenseStatus>\(\s*dodoCommand,[\s\S]{0,120}LICENSE_INVOKE_TIMEOUT_MS/,
    );
  });

  it("restores locally before scheduling silent online validation", () => {
    const restoreAt = app.indexOf("await restoreLicense(current.licenseKey)");
    const silentAt = app.indexOf("const silentLicenseCheck");
    expect(restoreAt).toBeGreaterThan(0);
    expect(silentAt).toBeGreaterThan(restoreAt);
    expect(app).toContain("24 * 60 * 60_000");
  });
});
