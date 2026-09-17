import { useEffect, useState } from "react";
import {
  minimizeActivationWindow,
  setActivationWindowMode,
} from "../native/activationWindow";
import { Icon } from "./icons";

/**
 * Blocking activation window.
 *
 * Shown instead of the cat when MewMuze is neither licensed nor inside its
 * trial. There is always a way out that does not need the network to succeed
 * on the first try: enter a key, start the trial (once), or quit. A customer
 * who is already activated never sees this, because `check_dodo_license`
 * keeps returning valid through its offline grace period.
 */
export function LicenseGate({
  trialStarted,
  onApplyLicense,
  onStartTrial,
  onBuy,
  onHelp,
  onQuit,
}: {
  trialStarted: boolean;
  onApplyLicense: (key: string) => Promise<string>;
  onStartTrial: () => Promise<void>;
  onBuy: () => void;
  onHelp: () => void;
  onQuit: () => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The companion normally stays out of the taskbar. While this blocking gate
  // is mounted, expose the window there so a customer can minimise it, find
  // the Dodo email, and restore MewMuze without losing the activation screen.
  useEffect(() => {
    void setActivationWindowMode(true);
    return () => {
      void setActivationWindowMode(false);
    };
  }, []);

  const unlock = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      setError(await onApplyLicense(key));
    } catch {
      setError("Activation failed. Check your internet connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-backdrop">
      <div className="sk-panel license-gate" role="dialog" aria-label="Activate MewMuze">
        <div className="sk-titlebar">
          <span className="sk-title">
            <span className="sk-title-badge">
            <Icon name="cat" size={16} />
          </span>{" "}
          Activate MewMuze
          </span>
          <div className="sk-window-btns" aria-label="Activation window controls">
            <button
              className="sk-winbtn"
              type="button"
              aria-label="Minimize activation window"
              title="Minimize"
              onClick={() => void minimizeActivationWindow()}
            >
              <Icon name="minus" size={16} />
            </button>
            <button
              className="sk-winbtn close"
              type="button"
              aria-label="Close MewMuze"
              title="Close MewMuze"
              onClick={onQuit}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        <div className="gate-body">
          <p className="gate-lede">
            {trialStarted
              ? "Your trial has ended. Enter your licence key to bring the cat back."
              : "Enter your licence key, or take MewMuze for a 14-day trial first."}
          </p>

          <div className="gate-important" role="note" aria-label="Important licence email instructions">
            <strong>Your key is in your email</strong>
            <p>
              Dodo Payments sent your MewMuze licence key to the email address used at purchase.
              Copy the key from that email and paste it below.
            </p>
            <small>Can't find it? Check your Spam and Promotions folders.</small>
          </div>

          <label className="sk-label" htmlFor="gate-key">
            Licence key
          </label>
          <input
            id="gate-key"
            className="sk-input mono"
            value={key}
            autoFocus
            spellCheck={false}
            placeholder="Paste the key from your purchase email"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
          />

          {error && (
            <p className="gate-error" role="alert">
              {error}
            </p>
          )}

          <div className="gate-actions">
            <button className="sk-btn primary" disabled={busy || !key.trim()} onClick={() => void unlock()}>
              {busy ? "Activating…" : "Unlock MewMuze"}
            </button>
            {!trialStarted && (
              <button className="sk-btn" disabled={busy} onClick={() => void onStartTrial()}>
                Start 14-day trial
              </button>
            )}
            <button className="sk-btn" disabled={busy} onClick={onQuit}>
              Quit
            </button>
          </div>

          <p className="gate-foot">
            Your key is saved securely after the first activation and keeps working through updates.
          </p>
          <div className="gate-links" aria-label="Purchase and licence help">
            <button className="gate-link" type="button" onClick={onBuy}>
              Buy MewMuze
            </button>
            <button className="gate-link" type="button" onClick={onHelp}>
              Find a key or get help
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
