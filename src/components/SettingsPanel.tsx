import { useEffect, useState } from "react";
import type { Settings } from "../settings/settingsStore";
import type { CatAccessory, CatPattern, CatSpecies } from "../animation/spriteLoader";
import { licenseSummary, type LicenseState } from "../licensing/license";
import {
  minimizeSettingsWindow,
  setSettingsWindowMode,
  watchSettingsWindowFocus,
} from "../native/settingsWindow";
import { CatPreview } from "./CatPreview";
import { clampStackLimit, MAIL_STACK_MAX, MAIL_STACK_MIN } from "../integrations/mailStack";

/**
 * The in-overlay settings panel. Receives a settings snapshot and reports every
 * change upward; App owns persistence and live application of the values.
 */
/**
 * Platform label switch. The autostart plugin registers a LaunchAgent on macOS
 * and a registry Run entry on Windows, so the setting itself is identical — it
 * is only the wording that has to match the OS the user is looking at.
 * `navigator.platform` is deprecated but still the most reliable signal inside
 * a WKWebView/WebView2 that never sees a real user agent switch.
 */
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");

/** 1…5 — how many email cards may sit above the cat at once. */
const STACK_CHOICES = Array.from(
  { length: MAIL_STACK_MAX - MAIL_STACK_MIN + 1 },
  (_, i) => MAIL_STACK_MIN + i,
);

type TabId = "appearance" | "behaviour" | "productivity" | "connections" | "application";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "🎨" },
  { id: "behaviour", label: "Behaviour", icon: "🐾" },
  { id: "productivity", label: "Productivity", icon: "⏱" },
  { id: "connections", label: "Connections", icon: "🔗" },
  { id: "application", label: "Application", icon: "⚙" },
];

export function SettingsPanel({
  settings,
  license,
  updateStatus,
  onChange,
  onClose,
  onResetPosition,
  onResetSettings,
  onQuit,
  onApplyLicense,
  onDeactivateLicense,
  onCompleteRemoval,
  onCheckUpdates,
  onOpenLink,
  onVisibilityChange,
}: {
  settings: Settings;
  license: LicenseState;
  updateStatus: string;
  onChange: (next: Settings) => void;
  onClose: () => void;
  onResetPosition: () => void;
  onResetSettings: () => void;
  onQuit: () => void;
  onApplyLicense: (key: string) => Promise<string>;
  onDeactivateLicense: () => Promise<string>;
  onCompleteRemoval: () => Promise<string>;
  onCheckUpdates: () => void;
  onOpenLink: (url: string) => Promise<void>;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const [reminderDraft, setReminderDraft] = useState({ message: "", intervalMin: 60 });
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [tab, setTab] = useState<TabId>("appearance");
  const [maximized, setMaximized] = useState(false);
  const [showGmailSteps, setShowGmailSteps] = useState(false);
  const [showCalSteps, setShowCalSteps] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);
  const s = settings;
  const set = (patch: Partial<Settings>) => onChange({ ...s, ...patch });
  /** Marks a control that needs a licence once the trial is over. */
  const lock = license.premium ? null : <span className="locked-tag">Locked</span>;

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    setWindowFocused(true);
    onVisibilityChange(true);
    void setSettingsWindowMode(true);
    void watchSettingsWindowFocus((focused) => {
      if (disposed) return;
      setWindowFocused(focused);
      onVisibilityChange(focused);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten();
      onVisibilityChange(false);
      void setSettingsWindowMode(false);
    };
  }, [onVisibilityChange]);

  /** Skeuomorphic rocker switch; same semantics as the old checkbox row. */
  const toggle = (label: string, key: keyof Settings) => (
    <div className="sk-row" key={key}>
      <label className="sk-label">{label}</label>
      <button
        role="switch"
        aria-checked={Boolean(s[key])}
        aria-label={label}
        className={`sk-switch${s[key] ? " on" : ""}`}
        onClick={() => set({ [key]: !s[key] } as Partial<Settings>)}
      >
        <span className="sk-switch-knob" />
      </button>
    </div>
  );

  const switchRow = (label: string, checked: boolean, onToggle: (v: boolean) => void) => (
    <div className="sk-row">
      <label className="sk-label">{label}</label>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`sk-switch${checked ? " on" : ""}`}
        onClick={() => onToggle(!checked)}
      >
        <span className="sk-switch-knob" />
      </button>
    </div>
  );

  if (!windowFocused) return null;

  return (
    <div className={`sk-backdrop${maximized ? " max" : ""}`}>
      <div className={`sk-panel${maximized ? " max" : ""}`} role="dialog" aria-label="MewMuze settings">
        <div className="sk-titlebar">
          <span className="sk-title">
            <span className="sk-title-badge">🐈‍⬛</span> MewMuze Settings
          </span>
          <div className="sk-window-btns">
            <button
              className="sk-winbtn"
              type="button"
              title="Minimize"
              aria-label="Minimize Settings"
              onClick={() => void minimizeSettingsWindow()}
            >
              —
            </button>
            <button
              className="sk-winbtn"
              type="button"
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore" : "Maximize"}
              onClick={() => setMaximized((m) => !m)}
            >
              {maximized ? "🗗" : "🗖"}
            </button>
            <button className="sk-winbtn close" type="button" title="Close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="sk-body">
          <nav className="sk-tabs" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`sk-tab${tab === t.id ? " on" : ""}`}
                aria-current={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                <span className="sk-tab-icon">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="sk-main">
            <div className={`sk-license ${license.licensed ? "licensed" : license.trialActive ? "trial" : "free"}`}>
              <div className="sk-license-status">{licenseSummary(license)}</div>
              {license.licensed ? (
                <div className="sk-license-actions">
                  <span className="sk-license-hint">
                    {license.source === "dodo"
                      ? license.devicesUsed !== undefined
                        ? `${license.devicesUsed} of ${license.deviceLimit} devices activated. Deactivate before moving MewMuze to another computer.`
                        : `This device is active. Your lifetime licence supports up to ${license.deviceLimit} devices.`
                      : "This existing offline licence remains valid exactly as before."}
                  </span>
                  <button
                    className="sk-btn"
                    disabled={unlocking}
                    onClick={async () => {
                      setUnlocking(true);
                      const err = await onDeactivateLicense();
                      setUnlocking(false);
                      setKeyError(err);
                    }}
                  >
                    {unlocking ? "Working…" : "Deactivate this computer"}
                  </button>
                  {keyError && <div className="sk-license-error">{keyError}</div>}
                </div>
              ) : (
                <>
                  <div className="sk-license-hint">
                    A licence unlocks every breed, all costumes, appearance colours and the whole
                    productivity suite. New purchase keys activate securely and keep working
                    offline for up to 30 days between checks.
                  </div>
                  <div className="sk-license-entry">
                    <input
                      type="text"
                      className="sk-input mono"
                      placeholder="Paste your licence key"
                      value={keyDraft}
                      onChange={(e) => {
                        setKeyDraft(e.target.value);
                        setKeyError("");
                      }}
                    />
                    <button
                      className="sk-btn primary"
                      disabled={unlocking || !keyDraft.trim()}
                      onClick={async () => {
                        setUnlocking(true);
                        const err = await onApplyLicense(keyDraft);
                        setUnlocking(false);
                        setKeyError(err);
                        if (!err) setKeyDraft("");
                      }}
                    >
                      {unlocking ? "Checking…" : "Unlock"}
                    </button>
                  </div>
                  {keyError && <div className="sk-license-error">{keyError}</div>}
                </>
              )}
            </div>

            <div className="sk-scroll">
              {tab === "appearance" && (
                <section className="sk-group">
                  <h3 className="sk-group-title">Look</h3>
                  <div className="sk-row">
                    <label className="sk-label">
                      Theme
                      <span className="sk-hint">Dark, or light with warm orange</span>
                    </label>
                    <select
                      className="sk-input"
                      value={s.uiTheme}
                      onChange={(e) => set({ uiTheme: e.target.value as Settings["uiTheme"] })}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Breed{lock}</label>
                    <select
                      className="sk-input"
                      value={s.appearance.species}
                      onChange={(e) => set({ appearance: { ...s.appearance, species: e.target.value as CatSpecies } })}
                    >
                      <option value="classic">Classic — balanced house cat</option>
                      <option value="chonk">Chonk — round and stubby</option>
                      <option value="fluffy">Fluffy — long-haired with tufts</option>
                      <option value="siamese">Siamese — slender with dark points</option>
                      <option value="kitten">Kitten — tiny with a big head</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Cat size</label>
                    <select
                      className="sk-input"
                      value={s.catSize}
                      onChange={(e) => set({ catSize: e.target.value as Settings["catSize"] })}
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </div>
                  {switchRow("Eyelashes", s.appearance.eyelashes, (v) =>
                    set({ appearance: { ...s.appearance, eyelashes: v } }),
                  )}
                  {switchRow("Stroke", s.appearance.stroke, (v) =>
                    set({ appearance: { ...s.appearance, stroke: v } }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">
                      Stroke colour
                      <span className="sk-hint">Border around the cat in every pose</span>
                    </label>
                    <input
                      type="color"
                      className="sk-colour"
                      aria-label="Stroke colour"
                      disabled={!s.appearance.stroke}
                      value={s.appearance.strokeColor}
                      onChange={(e) =>
                        set({ appearance: { ...s.appearance, strokeColor: e.target.value } })
                      }
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Fur colour{lock}</label>
                    <input
                      type="color"
                      className="sk-colour"
                      value={s.appearance.furColor}
                      onChange={(e) => set({ appearance: { ...s.appearance, furColor: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Eye colour</label>
                    <input
                      type="color"
                      className="sk-colour"
                      value={s.appearance.eyeColor}
                      onChange={(e) => set({ appearance: { ...s.appearance, eyeColor: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Inner-ear colour</label>
                    <input
                      type="color"
                      className="sk-colour"
                      value={s.appearance.earColor}
                      onChange={(e) => set({ appearance: { ...s.appearance, earColor: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Pattern</label>
                    <select
                      className="sk-input"
                      value={s.appearance.pattern}
                      onChange={(e) => set({ appearance: { ...s.appearance, pattern: e.target.value as CatPattern } })}
                    >
                      <option value="solid">Solid</option>
                      <option value="tuxedo">Tuxedo</option>
                      <option value="tabby">Tabby</option>
                      <option value="socks">Socks</option>
                      <option value="spotted">Spotted</option>
                      <option value="calico">Calico</option>
                      <option value="bicolour">Bicolour</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Accessory{lock}</label>
                    <select
                      className="sk-input"
                      value={s.appearance.accessory}
                      onChange={(e) =>
                        set({ appearance: { ...s.appearance, accessory: e.target.value as CatAccessory } })
                      }
                    >
                      <option value="none">None</option>
                      <option value="flowerCrown">Flower Band</option>
                      <option value="bandana">Bandana</option>
                      <option value="sunglasses">Sunglasses</option>
                      <option value="headphones">Headphones</option>
                      <option value="glasses">Glasses</option>
                    </select>
                  </div>
                  <div className="costume-manager" aria-labelledby="costume-manager-title">
                    <div className="costume-manager-head">
                      <div>
                        <h3 id="costume-manager-title" className="sk-group-title">
                          Costumes <span className="costume-coming-soon">Coming soon</span>
                        </h3>
                        <span className="sk-hint">
                          Costume installation and management are being refined for a future update.
                        </span>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {tab === "behaviour" && (
                <section className="sk-group">
                  <h3 className="sk-group-title">Temperament</h3>
                  <div className="sk-row">
                    <label className="sk-label">Activity level</label>
                    <select
                      className="sk-input"
                      value={s.activityLevel}
                      onChange={(e) => set({ activityLevel: e.target.value as Settings["activityLevel"] })}
                    >
                      <option value="calm">Calm</option>
                      <option value="balanced">Balanced</option>
                      <option value="playful">Playful</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">
                      Doze off after
                      <span className="sk-hint">seconds without mouse or keyboard input before it yawns and sleeps</span>
                    </label>
                    <span className="sk-stepper">
                      <input
                        type="range"
                        className="sk-range"
                        min={5}
                        max={300}
                        step={5}
                        value={s.drowsyAfterSec}
                        onChange={(e) => set({ drowsyAfterSec: Number(e.target.value) || 20 })}
                      />
                      <input
                        type="number"
                        className="sk-input narrow"
                        min={5}
                        max={3600}
                        value={s.drowsyAfterSec}
                        onChange={(e) => set({ drowsyAfterSec: Number(e.target.value) || 20 })}
                      />
                    </span>
                  </div>
                  {toggle("Cursor hunting", "cursorChasing")}
                  {toggle("Eye tracking", "eyeTracking")}
                  {toggle("Petting", "pettingEnabled")}
                  {toggle("Drag stretch", "dragStretch")}
                  {toggle("Keyboard reactions (activity only, never keys)", "keyboardReactions")}
                  {toggle("Scroll reactions", "scrollReactions")}
                  {toggle("Auto peek in full-screen apps", "peekAuto")}
                  {toggle("Peek mode (manual)", "peekManual")}
                  {toggle("App awareness (foreground app name only)", "contextAwareness")}
                  {toggle("Music reactions (playback state only)", "musicReactions")}
                  {toggle("Motivation messages", "motivation")}
                </section>
              )}

              {tab === "productivity" && (
                <section className="sk-group">
                  <h3 className="sk-group-title">You</h3>
                  <div className="sk-row">
                    <label className="sk-label">Your name (optional, local only)</label>
                    <input
                      type="text"
                      className="sk-input"
                      value={s.userName}
                      maxLength={40}
                      onChange={(e) => set({ userName: e.target.value })}
                    />
                  </div>

                  <h3 className="sk-group-title">Clipboard Assistant</h3>
                  {switchRow(
                    "Enable Clipboard Assistant",
                    s.clipboardAssistant.mode !== "off",
                    (enabled) =>
                      set({
                        clipboardAssistant: {
                          ...s.clipboardAssistant,
                          mode: enabled ? "badge" : "off",
                        },
                      }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">
                      When text is copied
                      <span className="sk-hint">local only; never stores clipboard history</span>
                    </label>
                    <select
                      className="sk-input"
                      value={s.clipboardAssistant.mode === "manual" ? "manual" : "badge"}
                      disabled={s.clipboardAssistant.mode === "off"}
                      onChange={(e) =>
                        set({
                          clipboardAssistant: {
                            ...s.clipboardAssistant,
                            mode: e.target.value as Settings["clipboardAssistant"]["mode"],
                          },
                        })
                      }
                    >
                      <option value="badge">Show icon when text is copied</option>
                      <option value="manual">Manual open only</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Preview characters</label>
                    <input
                      type="number"
                      className="sk-input narrow"
                      min={250}
                      max={10000}
                      value={s.clipboardAssistant.maxPreviewLength}
                      onChange={(e) =>
                        set({
                          clipboardAssistant: {
                            ...s.clipboardAssistant,
                            maxPreviewLength: Number(e.target.value) || 2000,
                          },
                        })
                      }
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">
                      Safety limit
                      <span className="sk-hint">maximum copied-text size</span>
                    </label>
                    <select
                      className="sk-input"
                      value={s.clipboardAssistant.maxInputLength}
                      onChange={(e) =>
                        set({
                          clipboardAssistant: {
                            ...s.clipboardAssistant,
                            maxInputLength: Number(e.target.value),
                          },
                        })
                      }
                    >
                      <option value={25000}>25,000 characters</option>
                      <option value={100000}>100,000 characters</option>
                      <option value={250000}>250,000 characters</option>
                      <option value={500000}>500,000 characters</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Forget copied text</label>
                    <select
                      className="sk-input"
                      value={s.clipboardAssistant.forgetAfterSeconds}
                      onChange={(e) =>
                        set({
                          clipboardAssistant: {
                            ...s.clipboardAssistant,
                            forgetAfterSeconds: Number(e.target.value) as
                              Settings["clipboardAssistant"]["forgetAfterSeconds"],
                          },
                        })
                      }
                    >
                      <option value={0}>when the panel closes</option>
                      <option value={60}>after 1 minute</option>
                      <option value={300}>after 5 minutes</option>
                      <option value={900}>after 15 minutes</option>
                    </select>
                  </div>
                  {switchRow(
                    "Ignore likely one-time codes",
                    s.clipboardAssistant.suppressSensitiveCodes,
                    (value) =>
                      set({
                        clipboardAssistant: {
                          ...s.clipboardAssistant,
                          suppressSensitiveCodes: value,
                        },
                      }),
                  )}
                  <div className="sk-row stack">
                    <label className="sk-label">
                      Excluded applications
                      <span className="sk-hint">one executable name per line</span>
                    </label>
                    <textarea
                      className="sk-input wide clipboard-exclusions"
                      rows={4}
                      value={s.clipboardAssistant.excludedApplications.join("\n")}
                      onChange={(e) =>
                        set({
                          clipboardAssistant: {
                            ...s.clipboardAssistant,
                            excludedApplications: e.target.value
                              .split(/\r?\n|,/)
                              .map((name) => name.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </div>

                  <h3 className="sk-group-title">Reminders</h3>
                  {switchRow("Stretch reminder", s.stretchReminder.enabled, (v) =>
                    set({ stretchReminder: { ...s.stretchReminder, enabled: v } }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">Stretch interval (min)</label>
                    <input
                      type="number"
                      className="sk-input narrow"
                      min={5}
                      max={480}
                      value={s.stretchReminder.intervalMin}
                      onChange={(e) =>
                        set({ stretchReminder: { ...s.stretchReminder, intervalMin: Number(e.target.value) || 45 } })
                      }
                    />
                  </div>
                  {switchRow("Water reminder", s.waterReminder.enabled, (v) =>
                    set({ waterReminder: { ...s.waterReminder, enabled: v } }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">Water interval (min)</label>
                    <input
                      type="number"
                      className="sk-input narrow"
                      min={5}
                      max={480}
                      value={s.waterReminder.intervalMin}
                      onChange={(e) =>
                        set({ waterReminder: { ...s.waterReminder, intervalMin: Number(e.target.value) || 60 } })
                      }
                    />
                  </div>
                  {switchRow("Work-rest reminder (active-use time)", s.workRest.enabled, (v) =>
                    set({ workRest: { ...s.workRest, enabled: v } }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">Rest after (active minutes)</label>
                    <input
                      type="number"
                      className="sk-input narrow"
                      min={10}
                      max={240}
                      value={s.workRest.intervalMin}
                      onChange={(e) => set({ workRest: { ...s.workRest, intervalMin: Number(e.target.value) || 45 } })}
                    />
                  </div>

                  <h3 className="sk-group-title">Pomodoro</h3>
                  <div className="sk-row">
                    <label className="sk-label">Focus / break (min)</label>
                    <span className="sk-stepper">
                      <input
                        type="number"
                        className="sk-input narrow"
                        min={5}
                        max={120}
                        value={s.pomodoro.focusMin}
                        onChange={(e) => set({ pomodoro: { ...s.pomodoro, focusMin: Number(e.target.value) || 25 } })}
                      />
                      <span className="sk-sep">/</span>
                      <input
                        type="number"
                        className="sk-input narrow"
                        min={1}
                        max={60}
                        value={s.pomodoro.shortBreakMin}
                        onChange={(e) =>
                          set({ pomodoro: { ...s.pomodoro, shortBreakMin: Number(e.target.value) || 5 } })
                        }
                      />
                    </span>
                  </div>

                  <h3 className="sk-group-title">Pinned note</h3>
                  {switchRow("Show pinned note", s.note.visible, (v) => set({ note: { ...s.note, visible: v } }))}
                  <div className="sk-row">
                    <label className="sk-label">Note text</label>
                    <input
                      type="text"
                      className="sk-input"
                      value={s.note.text}
                      maxLength={280}
                      onChange={(e) => set({ note: { ...s.note, text: e.target.value } })}
                    />
                  </div>

                  <h3 className="sk-group-title">Custom reminders</h3>
                  <div className="sk-row">
                    <label className="sk-label">New reminder message</label>
                    <input
                      type="text"
                      className="sk-input"
                      value={reminderDraft.message}
                      maxLength={200}
                      onChange={(e) => setReminderDraft({ ...reminderDraft, message: e.target.value })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Every (min)</label>
                    <span className="sk-stepper">
                      <input
                        type="number"
                        className="sk-input narrow"
                        min={1}
                        max={1440}
                        value={reminderDraft.intervalMin}
                        onChange={(e) =>
                          setReminderDraft({ ...reminderDraft, intervalMin: Number(e.target.value) || 60 })
                        }
                      />
                      <button
                        className="sk-btn"
                        onClick={() => {
                          if (!reminderDraft.message.trim()) return;
                          set({
                            customReminders: [
                              ...s.customReminders,
                              {
                                id: `custom-${Date.now()}`,
                                message: reminderDraft.message.trim(),
                                intervalMin: reminderDraft.intervalMin,
                                enabled: true,
                              },
                            ],
                          });
                          setReminderDraft({ message: "", intervalMin: 60 });
                        }}
                      >
                        Add
                      </button>
                    </span>
                  </div>
                  {s.customReminders.map((c) => (
                    <div className="sk-row" key={c.id}>
                      <label className="sk-label">
                        ⏰ {c.message} — every {c.intervalMin}m
                      </label>
                      <button
                        className="sk-btn"
                        onClick={() => set({ customReminders: s.customReminders.filter((x) => x.id !== c.id) })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}

                  <h3 className="sk-group-title">AI-agent status</h3>
                  <div className="sk-row stack">
                    <label className="sk-label">
                      Status file
                      <span className="sk-hint">a local JSON path this app may read; empty disables it</span>
                    </label>
                    <input
                      type="text"
                      className="sk-input wide"
                      placeholder="C:\path\to\agent-status.json"
                      value={s.agentStatusFile}
                      onChange={(e) => set({ agentStatusFile: e.target.value })}
                    />
                  </div>
                </section>
              )}

              {tab === "connections" && (
                <section className="sk-group">
                  <h3 className="sk-group-title">Gmail</h3>
                  <p className="sk-connect-blurb">
                    Get a gentle notification the moment a new email lands. Uses a Google{" "}
                    <b>app password</b> over a secure connection — private, no Google sign-in prompts,
                    and nothing but the newest senders + subjects is ever read.
                  </p>
                  <div className="sk-row stack">
                    <label className="sk-label">Gmail address</label>
                    <input
                      type="email"
                      className="sk-input wide"
                      placeholder="you@gmail.com"
                      value={s.gmail.email}
                      onChange={(e) => set({ gmail: { ...s.gmail, email: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row stack">
                    <label className="sk-label">App password</label>
                    <input
                      type="password"
                      className="sk-input wide mono"
                      placeholder="16-character app password"
                      value={s.gmail.appPassword}
                      onChange={(e) => set({ gmail: { ...s.gmail, appPassword: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">
                      {s.gmail.connected ? (
                        <span className="sk-conn-on">● Connected</span>
                      ) : (
                        <span className="sk-conn-off">○ Not connected</span>
                      )}
                    </label>
                    <button
                      className={`sk-btn${s.gmail.connected ? " danger" : " primary"}`}
                      disabled={!s.gmail.connected && !(s.gmail.email.trim() && s.gmail.appPassword.trim())}
                      onClick={() =>
                        set({ gmail: { ...s.gmail, connected: !s.gmail.connected } })
                      }
                    >
                      {s.gmail.connected ? "Disconnect" : "Connect Gmail"}
                    </button>
                  </div>
                  {switchRow("Notify me on new email", s.gmail.notify, (v) =>
                    set({ gmail: { ...s.gmail, notify: v } }),
                  )}
                  <div className="sk-row">
                    <label className="sk-label">
                      Maximum stacked email notifications
                      <span className="sk-hint">Extra emails wait their turn</span>
                    </label>
                    <select
                      className="sk-input"
                      value={String(clampStackLimit(s.gmail.maxStack))}
                      onChange={(e) =>
                        set({ gmail: { ...s.gmail, maxStack: clampStackLimit(e.target.value) } })
                      }
                    >
                      {STACK_CHOICES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="sk-steps-toggle" onClick={() => setShowGmailSteps((v) => !v)}>
                    {showGmailSteps ? "▾ Hide setup steps" : "▸ How do I get an app password?"}
                  </button>
                  {showGmailSteps && (
                    <div className="sk-connection-guide">
                      <p>To connect your Gmail account, first create a Google App Password.</p>
                      <h4>Step 1: Turn on 2-Step Verification</h4>
                      <p>Google requires 2-Step Verification before you can create an App Password.</p>
                      <button
                        className="sk-btn guide-link"
                        type="button"
                        onClick={() => void onOpenLink("https://myaccount.google.com/signinoptions/two-step-verification")}
                      >
                        Turn On 2-Step Verification
                      </button>
                      <p className="sk-guide-note">Already enabled? Proceed to the next step.</p>
                      <h4>Step 2: Create an App Password</h4>
                      <p>Open Google&rsquo;s App Passwords page:</p>
                      <button
                        className="sk-btn guide-link"
                        type="button"
                        onClick={() => void onOpenLink("https://myaccount.google.com/apppasswords")}
                      >
                        Get App Password
                      </button>
                      <ol className="sk-steps">
                        <li>Sign in to the Gmail account you want to connect.</li>
                        <li>Enter any app name, such as <b>MewMuze</b> or <b>MewMuze Gmail Connector</b>.</li>
                        <li>Click <b>Create</b>.</li>
                        <li>Google will generate a <b>16-character App Password</b>.</li>
                        <li>Copy it and paste it into the App Password field above, with or without spaces.</li>
                        <li>Click <b>Connect Gmail</b>.</li>
                      </ol>
                      <p className="sk-guide-timing">
                        After a new email arrives, MewMuze usually shows its notification within about
                        1–3 minutes. A full-screen app or another active notice may delay it briefly.
                      </p>
                    </div>
                  )}

                  <h3 className="sk-group-title">Google Calendar</h3>
                  <p className="sk-connect-blurb">
                    The cat reminds you before meetings using your calendar's <b>private iCal address</b>.
                    No sign-in — just paste the secret link and pick how early to warn you.
                  </p>
                  <div className="sk-row stack">
                    <label className="sk-label">Private iCal address (.ics)</label>
                    <input
                      type="url"
                      className="sk-input wide mono"
                      placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                      value={s.calendar.icsUrl}
                      onChange={(e) => set({ calendar: { ...s.calendar, icsUrl: e.target.value } })}
                    />
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Warn me before an event</label>
                    <select
                      className="sk-input"
                      value={s.calendar.earlyWarnMin}
                      onChange={(e) => set({ calendar: { ...s.calendar, earlyWarnMin: Number(e.target.value) } })}
                    >
                      <option value={5}>5 minutes</option>
                      <option value={10}>10 minutes</option>
                      <option value={15}>15 minutes</option>
                      <option value={30}>30 minutes</option>
                    </select>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">
                      {s.calendar.connected ? (
                        <span className="sk-conn-on">● Connected</span>
                      ) : (
                        <span className="sk-conn-off">○ Not connected</span>
                      )}
                    </label>
                    <button
                      className={`sk-btn${s.calendar.connected ? " danger" : " primary"}`}
                      disabled={!s.calendar.connected && !s.calendar.icsUrl.trim().startsWith("https://")}
                      onClick={() => set({ calendar: { ...s.calendar, connected: !s.calendar.connected } })}
                    >
                      {s.calendar.connected ? "Disconnect" : "Connect Calendar"}
                    </button>
                  </div>
                  {switchRow("Notify me before events", s.calendar.notify, (v) =>
                    set({ calendar: { ...s.calendar, notify: v } }),
                  )}
                  <button className="sk-steps-toggle" onClick={() => setShowCalSteps((v) => !v)}>
                    {showCalSteps ? "▾ Hide setup steps" : "▸ Where is my private iCal address?"}
                  </button>
                  {showCalSteps && (
                    <div className="sk-connection-guide">
                      <h4>Connect Google Calendar to MewMuze</h4>
                      <h4>Step 1: Open Google Calendar</h4>
                      <p>Sign in to the Google account containing the calendar you want to connect.</p>
                      <button
                        className="sk-btn guide-link"
                        type="button"
                        onClick={() => void onOpenLink("https://calendar.google.com/calendar/u/0/r")}
                      >
                        Open Google Calendar
                      </button>
                      <h4>Step 2: Open Calendar Integration Settings</h4>
                      <button
                        className="sk-btn guide-link"
                        type="button"
                        onClick={() => void onOpenLink("https://calendar.google.com/calendar/u/0/r/settings/calendar")}
                      >
                        Open Integrate Calendar
                      </button>
                      <ol className="sk-steps">
                        <li>Select your calendar under <b>Settings for my calendars</b>.</li>
                        <li>Scroll to <b>Integrate calendar</b>.</li>
                        <li>Copy the <b>Secret address in iCal format</b>.</li>
                        <li>Paste the copied address into the field above.</li>
                        <li>Click <b>Connect Calendar</b>.</li>
                      </ol>
                      <p className="sk-guide-warning">
                        Keep the Secret iCal address private, as anyone with this link may be able to
                        view your calendar information.
                      </p>
                    </div>
                  )}
                </section>
              )}

              {tab === "application" && (
                <section className="sk-group">
                  <h3 className="sk-group-title">System</h3>
                  {toggle(IS_MAC ? "Start at login" : "Start with Windows", "startWithWindows")}
                  {toggle("Sound", "soundEnabled")}
                  {toggle("Check for updates automatically", "autoUpdate")}
                  <div className="sk-row">
                    <label className="sk-label">
                      Updates
                      <span className="sk-hint">
                        {updateStatus || "Downloaded and verified before installing."}
                      </span>
                    </label>
                    <button className="sk-btn" onClick={onCheckUpdates}>
                      Check now
                    </button>
                  </div>

                  <h3 className="sk-group-title">Maintenance</h3>
                  <div className="sk-row">
                    <label className="sk-label">Reset cat position</label>
                    <button className="sk-btn" onClick={onResetPosition}>
                      Reset
                    </button>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Reset all settings</label>
                    <button className="sk-btn" onClick={onResetSettings}>
                      Reset
                    </button>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">
                      Complete removal
                      <span className="sk-hint">deactivates this device, removes all local data, then quits</span>
                    </label>
                    <button
                      className="sk-btn danger"
                      disabled={unlocking}
                      onClick={async () => {
                        const confirmed = window.confirm(
                          "Completely remove MewMuze data from this computer? Your settings, reminders, appearance, costumes and activation will be removed. You will need your licence key again.",
                        );
                        if (!confirmed) return;
                        setUnlocking(true);
                        const error = await onCompleteRemoval();
                        setUnlocking(false);
                        setKeyError(error);
                      }}
                    >
                      Remove data…
                    </button>
                  </div>
                  <div className="sk-row">
                    <label className="sk-label">Quit application</label>
                    <button className="sk-btn danger" onClick={onQuit}>
                      Quit
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>

          <aside className="sk-aside">
            <div className="sk-aside-title">Live preview</div>
            <CatPreview sizePx={maximized ? 300 : 210} />
            <div className="sk-aside-note">
              Changes apply to your cat immediately — this shows exactly what it looks like now.
            </div>
          </aside>
        </div>

        <div className="sk-footer">
          <span className="sk-footer-brand">MewMuze</span>
          <button className="sk-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
