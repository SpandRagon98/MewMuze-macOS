import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Settings } from "../settings/settingsStore";
import { ART, DEFAULT_POSE, renderFrameWith, spriteEpoch, type CatAccessory, type CatPattern, type CatSpecies } from "../animation/spriteLoader";
import { licenseSummary, type LicenseState } from "../licensing/license";
import { minimizeSettingsWindow, setSettingsWindowMode, watchSettingsWindowFocus } from "../native/settingsWindow";
import { CatPreview } from "./CatPreview";
import { CostumeManager } from "../costumes/CostumeManager";
import { clampStackLimit, MAIL_STACK_MAX, MAIL_STACK_MIN } from "../integrations/mailStack";
import { STATE_LABEL } from "../companion/modules";
import { ChatPage, CompanionNotifications, CompanionPage, PrivacyBatteryPage, VoicePage, useModules, type CompanionPanelApi } from "./CompanionSettings";
import { FeaturedLooks } from "./FeaturedLooks";
import { confirmAction } from "./ConfirmDialog";
import { Icon, type IconName } from "./icons";
import { Advanced, Page, Row, Section, Select, Toggle, slug } from "./settingsKit";

/**
 * Settings: a sidebar of ten sections, a search bar, and one page at a time.
 * Receives a settings snapshot and reports every change upward; App owns
 * persistence and live application of the values.
 *
 * The autostart plugin registers a LaunchAgent on macOS and a registry Run
 * entry on Windows, so the setting is identical - only its wording follows
 * the OS.
 */
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");

/** 1…5 — how many email cards may sit above the cat at once. */
const STACK_CHOICES = Array.from({ length: MAIL_STACK_MAX - MAIL_STACK_MIN + 1 }, (_, i) => MAIL_STACK_MIN + i);

export type SettingsPageId = "home" | "companion" | "looks" | "voice" | "chat" | "tools" | "connections" | "notifications" | "privacy" | "about";

const NAV: { id: SettingsPageId; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "companion", label: "Companion", icon: "sparkle" },
  { id: "looks", label: "Cat & Looks", icon: "paw" },
  { id: "voice", label: "Voice", icon: "mic" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "tools", label: "Tools", icon: "tools" },
  { id: "connections", label: "Connections", icon: "link" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "privacy", label: "Privacy & Battery", icon: "shield" },
  { id: "about", label: "About", icon: "info" },
];
const NAV_STEP = 40; // item height 38 + gap 2: where the indicator glides to

/** Everything search can find: the row's label, its page, and other words people use. */
const SEARCH: { label: string; page: SettingsPageId; words?: string }[] = [
  { label: "Personal Companion", page: "companion", words: "assistant on off" },
  { label: "My Day", page: "companion" },
  { label: "What should MewMuze call you?", page: "companion", words: "name nickname" },
  { label: "Language", page: "companion", words: "hindi hinglish english" },
  { label: "Time format", page: "companion", words: "12 24 hour clock" },
  { label: "Temperature", page: "companion", words: "celsius fahrenheit" },
  { label: "Personality", page: "companion", words: "tone cozy playful savage sassy roast minimal professional" },
  { label: "Work hours", page: "companion" },
  { label: "Morning greeting", page: "companion" },
  { label: "Weather", page: "companion", words: "rain forecast" },
  { label: "Find a city", page: "companion", words: "location weather" },
  { label: "Your topics", page: "companion", words: "interests news" },
  { label: "Add a date", page: "companion", words: "birthday anniversary important" },
  { label: "Check now", page: "companion", words: "watches currency" },
  { label: "Breed", page: "looks", words: "species kitten siamese chonk" },
  { label: "Size", page: "looks", words: "cat size big small" },
  { label: "Fur colour", page: "looks", words: "color" },
  { label: "Eye colour", page: "looks", words: "color eyes" },
  { label: "Pattern", page: "looks", words: "tabby tuxedo calico" },
  { label: "Accessory", page: "looks", words: "hat glasses" },
  { label: "Outline", page: "looks", words: "stroke border" },
  { label: "Costumes", page: "looks", words: "outfit look looks skin batcat corporate cyberpunk install store mewcostume preview" },
  { label: "Energy", page: "looks", words: "activity calm playful" },
  { label: "Doze off after", page: "looks", words: "sleep nap" },
  { label: "Chase the cursor", page: "looks", words: "mouse hunting" },
  { label: "Expressions", page: "looks", words: "emotion feelings face subtle dramatic intensity" },
  { label: "Butterfly visits", page: "looks", words: "butterfly visitor play" },
  { label: "Edgy gestures", page: "looks", words: "rude savage middle finger paw gesture" },
  { label: "Petting", page: "looks" },
  { label: "Peek out of full-screen apps", page: "looks", words: "fullscreen video game" },
  { label: "Dictation shortcut", page: "voice", words: "hotkey keyboard speech" },
  { label: "After dictating", page: "voice", words: "paste copy" },
  { label: "Spoken language", page: "voice" },
  { label: "Local Voice", page: "voice", words: "whisper microphone download" },
  { label: "Local Chat", page: "chat", words: "qwen ai download" },
  { label: "Remember useful things", page: "chat", words: "memory" },
  { label: "Conversation style", page: "chat", words: "listener coach playful direct tone persona" },
  { label: "Show active mode", page: "chat", words: "persona mode health guide love guru chip header" },
  { label: "Chat model", page: "chat", words: "lite standard qwen small" },
  { label: "Clear companion memory", page: "chat", words: "forget" },
  { label: "Chat with", page: "chat", words: "openai gpt chatgpt claude anthropic api key provider model cloud local" },
  { label: "Diary", page: "chat", words: "diary journal summary entries clear diary" },
  { label: "Your name", page: "tools" },
  { label: "Clipboard Assistant", page: "tools", words: "copy paste" },
  { label: "Stretch reminder", page: "tools" },
  { label: "Water reminder", page: "tools", words: "drink" },
  { label: "Rest breaks", page: "tools", words: "work rest" },
  { label: "Pomodoro", page: "tools", words: "focus timer" },
  { label: "Show pinned note", page: "tools", words: "note sticky" },
  { label: "Your own reminders", page: "tools", words: "custom" },
  { label: "Gmail", page: "connections", words: "email app password" },
  { label: "Google Calendar", page: "connections", words: "ical meetings" },
  { label: "New email", page: "notifications", words: "gmail notify" },
  { label: "Before meetings", page: "notifications", words: "calendar notify warn" },
  { label: "Quiet hours", page: "notifications", words: "do not disturb" },
  { label: "Sound", page: "notifications", words: "mute audio" },
  { label: "Encouraging messages", page: "notifications", words: "motivation" },
  { label: "Power use", page: "privacy", words: "battery saver performance" },
  { label: "Pause internet features", page: "privacy", words: "offline network" },
  { label: "Delete local history", page: "privacy" },
  { label: "Licence", page: "about", words: "license key activate trial" },
  { label: "Check for updates automatically", page: "about", words: "update" },
  { label: IS_MAC ? "Start at login" : "Start with Windows", page: "about", words: "startup autostart" },
  { label: "Reset all settings", page: "about" },
  { label: "Remove MewMuze's data", page: "about", words: "uninstall delete" },
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
  companionApi = null,
  initialPage = "home",
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
  /** Paper build: the live Personal Companion, when the app has one running. */
  companionApi?: CompanionPanelApi | null;
  /** Page to open on (the cat's menu can open Cat & Looks directly). */
  initialPage?: SettingsPageId;
}) {
  const [page, setPage] = useState<SettingsPageId>(initialPage);
  const [leaving, setLeaving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const s = settings;
  const set = (patch: Partial<Settings>) => onChange({ ...s, ...patch });
  /** Marks a control that needs a licence once the trial is over. */
  const lock = license.premium ? null : <span className="locked-tag">PRO</span>;

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

  useEffect(() => setPage(initialPage), [initialPage]);

  /** Move to a page: the old one steps out (90 ms), the new one steps in. */
  const go = (next: SettingsPageId, then?: () => void) => {
    setQuery("");
    if (next === page) return then?.();
    setLeaving(true);
    window.setTimeout(() => {
      setPage(next);
      setLeaving(false);
      if (pageRef.current) pageRef.current.scrollTop = 0;
      if (then) window.setTimeout(then, 60);
    }, 90);
  };

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return SEARCH.filter((e) => {
      const hay = `${e.label} ${e.words ?? ""} ${NAV.find((n) => n.id === e.page)!.label}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 8);
  }, [query]);

  /** Jump to a setting: its page, open any Advanced it sits in, scroll, flash. */
  const reveal = (e: (typeof SEARCH)[number]) =>
    go(e.page, () => {
      const row = pageRef.current?.querySelector<HTMLElement>(`[data-setting="${slug(e.label)}"]`);
      if (!row) return;
      row.closest("details")?.setAttribute("open", "");
      row.scrollIntoView?.({ block: "center" });
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
    });

  /**
   * Maximize / restore. The panel's size changes in one layout, and a View
   * Transition morphs the named pieces (panel, sidebar, hero, tiles, posters)
   * from where they were to where they land - compositor-only, so no card
   * snaps or teleports. Without the API, or with Reduce Motion, it just
   * switches.
   */
  const toggleMaximized = () => {
    const flip = () => flushSync(() => setMaximized((m) => !m));
    const vt = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
    const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (vt && !still) vt.call(document, flip);
    else flip();
  };

  if (!windowFocused) return null;

  const navIndex = NAV.findIndex((n) => n.id === page);
  const planKind = license.licensed ? "" : license.trialActive ? " trial" : " free";

  return (
    <div className={`mm-settings-backdrop${maximized ? " max" : ""}`}>
      <div className={`mm-settings${maximized ? " max" : ""}`} role="dialog" aria-label="MewMuze settings">
        <aside className="mm-side">
          <div className="mm-brand">
            <span className="mm-brand-mark">
              <CatFaceMark />
            </span>
            <span>
              <span className="mm-brand-name">MewMuze</span>
              <span className="mm-brand-tag">Paper · experimental</span>
            </span>
          </div>
          <nav className="mm-nav" aria-label="Settings sections">
            <span className="mm-nav-indicator" style={{ transform: `translateY(${navIndex * NAV_STEP}px)` }} aria-hidden="true" />
            {NAV.map((n) => (
              <button key={n.id} className={`mm-nav-item${page === n.id ? " on" : ""}`} aria-current={page === n.id ? "page" : undefined} onClick={() => go(n.id)}>
                <span className="mm-nav-icon">
                  <Icon name={n.icon} size={18} />
                </span>
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="mm-side-foot">
            <button
              className="mm-theme-toggle mm-btn ghost small"
              role="switch"
              aria-checked={s.theme === "light"}
              aria-label="Light theme"
              title={s.theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"}
              onClick={() => set({ theme: s.theme === "light" ? "dark" : "light" })}
            >
              <Icon name={s.theme === "light" ? "sun" : "moon"} size={16} />
              <span>{s.theme === "light" ? "Light" : "Dark"}</span>
            </button>
            <button className="mm-plan mm-btn ghost small" onClick={() => go("about")} title={licenseSummary(license)}>
              <span className={`mm-plan-dot${planKind}`} />
              <span className="mm-plan-label">{license.licensed ? "Licensed" : license.trialActive ? "Trial" : "Not activated"}</span>
            </button>
          </div>
        </aside>

        <div className="mm-main">
          <div className="mm-topbar">
            <div className="mm-search">
              <span className="mm-search-icon">
                <Icon name="search" size={16} />
              </span>
              <input
                className="mm-search-input"
                type="search"
                placeholder="Search settings"
                aria-label="Search settings"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHit(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") setHit((i) => Math.min(i + 1, results.length - 1));
                  else if (e.key === "ArrowUp") setHit((i) => Math.max(i - 1, 0));
                  else if (e.key === "Enter" && results[hit]) reveal(results[hit]);
                  else if (e.key === "Escape") setQuery("");
                  else return;
                  e.preventDefault();
                }}
              />
              {query.trim() && (
                <div className="mm-search-results" role="listbox" aria-label="Matching settings">
                  {results.length === 0 && <div className="mm-search-empty">No setting matches "{query}".</div>}
                  {results.map((r, i) => (
                    <button key={r.label} role="option" aria-selected={i === hit} className={`mm-search-hit${i === hit ? " active" : ""}`} onMouseEnter={() => setHit(i)} onClick={() => reveal(r)}>
                      <span>{r.label}</span>
                      <small>{NAV.find((n) => n.id === r.page)!.label}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mm-window-btns">
              <button className="mm-winbtn" type="button" title="Minimize" aria-label="Minimize Settings" onClick={() => void minimizeSettingsWindow()}>
                <Icon name="minus" size={16} />
              </button>
              <button className="mm-winbtn" type="button" title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximized}>
                <Icon name={maximized ? "restore" : "maximize"} size={15} />
              </button>
              <button className="mm-winbtn close" type="button" title="Close" aria-label="Close" onClick={onClose}>
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>

          <div className="mm-page" ref={pageRef}>
            <div key={page} className={`mm-page-inner${leaving ? " leaving" : ""}`}>
              {page === "home" && <HomePage s={s} onChange={onChange} license={license} api={companionApi} go={go} />}
              {page === "companion" && (
                <CompanionPage value={s.companion} onChange={(companion) => set({ companion })} api={companionApi} gmailConnected={s.gmail.connected} calendarConnected={s.calendar.connected} />
              )}
              {page === "looks" && (
                <Page title="Cat & Looks" sub="Make MewMuze yours. Every change shows on your cat straight away.">
                  <Section wide bare>
                    <CostumeManager settings={s} onChange={onChange} premium={license.premium} />
                  </Section>
                  <Section title="Appearance" wide bare>
                    <div className="mm-looks-studio">
                      <CatPreview sizePx={maximized ? 240 : 200} />
                      <div className="mm-card">
                        <Select
                          label="Breed"
                          badge={lock}
                          value={s.appearance.species}
                          options={[["classic", "Classic — a balanced house cat"], ["chonk", "Chonk — round and stubby"], ["fluffy", "Fluffy — long hair and tufts"], ["siamese", "Siamese — slender with dark points"], ["kitten", "Kitten — tiny, with a big head"]] as const}
                          onChange={(v: CatSpecies) => set({ appearance: { ...s.appearance, species: v } })}
                        />
                        <Select label="Size" hint="How big the cat is on your desktop." value={s.catSize} options={[["small", "Small"], ["medium", "Medium"], ["large", "Large"]] as const} onChange={(v) => set({ catSize: v })} />
                        <Select
                          label="Pattern"
                          value={s.appearance.pattern}
                          options={[["solid", "Solid"], ["tuxedo", "Tuxedo"], ["tabby", "Tabby"], ["socks", "Socks"], ["spotted", "Spotted"], ["calico", "Calico"], ["bicolour", "Bicolour"]] as const}
                          onChange={(v: CatPattern) => set({ appearance: { ...s.appearance, pattern: v } })}
                        />
                        <Row label="Fur colour" badge={lock}>
                          <input type="color" className="sk-colour" aria-label="Fur colour" value={s.appearance.furColor} onChange={(e) => set({ appearance: { ...s.appearance, furColor: e.target.value } })} />
                        </Row>
                        <Row label="Eye colour">
                          <input type="color" className="sk-colour" aria-label="Eye colour" value={s.appearance.eyeColor} onChange={(e) => set({ appearance: { ...s.appearance, eyeColor: e.target.value } })} />
                        </Row>
                        <Row label="Inner-ear colour">
                          <input type="color" className="sk-colour" aria-label="Inner-ear colour" value={s.appearance.earColor} onChange={(e) => set({ appearance: { ...s.appearance, earColor: e.target.value } })} />
                        </Row>
                        <Select
                          label="Accessory"
                          badge={lock}
                          value={s.appearance.accessory}
                          options={[["none", "None"], ["cap", "Baseball cap"], ["earStuds", "Ear piercings"], ["faceMask", "Face mask"], ["flowerCrown", "Flower band"], ["bandana", "Bandana"], ["sunglasses", "Sunglasses"], ["headphones", "Headphones"], ["glasses", "Glasses"]] as const}
                          onChange={(v: CatAccessory) => set({ appearance: { ...s.appearance, accessory: v } })}
                        />
                        <Toggle label="Eyelashes" checked={s.appearance.eyelashes} onChange={(v) => set({ appearance: { ...s.appearance, eyelashes: v } })} />
                        <Toggle label="Outline" hint="A thin border around the cat in every pose." checked={s.appearance.stroke} onChange={(v) => set({ appearance: { ...s.appearance, stroke: v } })} />
                        <Row label="Outline colour">
                          <input type="color" className="sk-colour" aria-label="Outline colour" disabled={!s.appearance.stroke} value={s.appearance.strokeColor} onChange={(e) => set({ appearance: { ...s.appearance, strokeColor: e.target.value } })} />
                        </Row>
                      </div>
                    </div>
                  </Section>
                  <Section title="Behaviour">
                    <Select label="Energy" hint="How lively MewMuze is." value={s.activityLevel} options={[["calm", "Calm"], ["balanced", "Balanced"], ["playful", "Playful"]] as const} onChange={(v) => set({ activityLevel: v })} />
                    <Select label="Expressions" hint="How big its feelings look: head, eyes and paws." value={s.expressionIntensity} options={[["subtle", "Subtle"], ["balanced", "Balanced"], ["dramatic", "Dramatic"]] as const} onChange={(v) => set({ expressionIntensity: v })} />
                    <Row label="Doze off after" hint="Seconds without mouse or keyboard before it yawns and naps.">
                      <span className="sk-stepper">
                        <input type="range" className="sk-range" aria-label="Doze off after (slider)" min={5} max={300} step={5} value={s.drowsyAfterSec} onChange={(e) => set({ drowsyAfterSec: Number(e.target.value) || 20 })} />
                        <input type="number" className="sk-input narrow" aria-label="Doze off after, seconds" min={5} max={3600} value={s.drowsyAfterSec} onChange={(e) => set({ drowsyAfterSec: Number(e.target.value) || 20 })} />
                      </span>
                    </Row>
                    <Toggle label="Chase the cursor" hint="Now and then MewMuze hunts your mouse pointer." checked={s.cursorChasing} onChange={(v) => set({ cursorChasing: v })} />
                    <Toggle label="Petting" hint="Stroke the cat by moving the mouse over it." checked={s.pettingEnabled} onChange={(v) => set({ pettingEnabled: v })} />
                    <Toggle label="Watch the cursor" hint="Its eyes follow your mouse." checked={s.eyeTracking} onChange={(v) => set({ eyeTracking: v })} />
                    <Toggle label="Butterfly visits" hint="Now and then a butterfly drops by for it to watch." checked={s.butterflyVisits} onChange={(v) => set({ butterflyVisits: v })} />
                    <Advanced>
                      <Toggle label="Stretch when dragged" hint="Squishes like a mochi when you pick it up." checked={s.dragStretch} onChange={(v) => set({ dragStretch: v })} />
                      <Toggle label="React to typing" hint="Only notices that you are typing — never what." checked={s.keyboardReactions} onChange={(v) => set({ keyboardReactions: v })} />
                      <Toggle label="React to scrolling" checked={s.scrollReactions} onChange={(v) => set({ scrollReactions: v })} />
                      <Toggle label="Peek out of full-screen apps" hint="Hides during videos and games, then peeks back." checked={s.peekAuto} onChange={(v) => set({ peekAuto: v })} />
                      <Toggle label="Peek mode" hint="Keep the cat peeking from the screen edge." checked={s.peekManual} onChange={(v) => set({ peekManual: v })} />
                      <Toggle label="Notice which app I'm using" hint="Only the app's name — never what is in it." checked={s.contextAwareness} onChange={(v) => set({ contextAwareness: v })} />
                      <Toggle label="React to music" hint="Only whether something is playing." checked={s.musicReactions} onChange={(v) => set({ musicReactions: v })} />
                      <Toggle label="Edgy gestures" hint="A rude paw, only when you tease it or make it rage - never in serious chats. Off: a dismissive wave instead." checked={s.edgyGestures} onChange={(v) => set({ edgyGestures: v })} />
                    </Advanced>
                  </Section>
                </Page>
              )}
              {page === "voice" && <VoicePage value={s.companion} onChange={(companion) => set({ companion })} api={companionApi} />}
              {page === "chat" && <ChatPage value={s.companion} onChange={(companion) => set({ companion })} api={companionApi} />}
              {page === "tools" && <ToolsPage s={s} set={set} />}
              {page === "connections" && <ConnectionsPage s={s} set={set} onOpenLink={onOpenLink} />}
              {page === "notifications" && (
                <Page title="Notifications" sub="When and how MewMuze gets your attention.">
                  <Section title="Email">
                    <Toggle label="New email" hint={s.gmail.connected ? "A small card when mail arrives." : "Connect Gmail in Connections first."} checked={s.gmail.notify} onChange={(v) => set({ gmail: { ...s.gmail, notify: v } })} />
                    <Select
                      label="Emails shown at once"
                      hint="Extra emails wait their turn."
                      value={clampStackLimit(s.gmail.maxStack)}
                      options={STACK_CHOICES.map((n) => [n, String(n)] as const)}
                      onChange={(v) => set({ gmail: { ...s.gmail, maxStack: clampStackLimit(v) } })}
                    />
                  </Section>
                  <Section title="Calendar">
                    <Toggle label="Before meetings" hint={s.calendar.connected ? "A heads-up before each event." : "Connect Google Calendar in Connections first."} checked={s.calendar.notify} onChange={(v) => set({ calendar: { ...s.calendar, notify: v } })} />
                    <Select label="How early" value={s.calendar.earlyWarnMin} options={[[5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"], [30, "30 minutes"]] as const} onChange={(v) => set({ calendar: { ...s.calendar, earlyWarnMin: v } })} />
                  </Section>
                  <CompanionNotifications value={s.companion} onChange={(companion) => set({ companion })} />
                  <Section title="General">
                    <Toggle label="Encouraging messages" hint="Now and then, a kind word." checked={s.motivation} onChange={(v) => set({ motivation: v })} />
                    <Toggle label="Sound" hint="Little sounds when the cat reacts." checked={s.soundEnabled} onChange={(v) => set({ soundEnabled: v })} />
                  </Section>
                </Page>
              )}
              {page === "privacy" && (
                <PrivacyBatteryPage value={s.companion} onChange={(companion) => set({ companion })} api={companionApi} gmailConnected={s.gmail.connected} calendarConnected={s.calendar.connected} />
              )}
              {page === "about" && (
                <AboutPage
                  s={s}
                  set={set}
                  license={license}
                  updateStatus={updateStatus}
                  onResetPosition={onResetPosition}
                  onResetSettings={onResetSettings}
                  onQuit={onQuit}
                  onApplyLicense={onApplyLicense}
                  onDeactivateLicense={onDeactivateLicense}
                  onCompleteRemoval={onCompleteRemoval}
                  onCheckUpdates={onCheckUpdates}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The brand mark: MewMuze's own face, drawn by the real renderer in the user's colours (never in a costume). */
function CatFaceMark() {
  const ref = useRef<HTMLCanvasElement>(null);
  const epoch = spriteEpoch();
  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (!c) return;
    const art = renderFrameWith({ ...DEFAULT_POSE, body: "sit" }, null, ART);
    // The head, ears included: design units 11-37 across and 1-27 down of the 48-unit frame.
    const k = art.width / 48;
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.imageSmoothingQuality = "high";
    c.drawImage(art, 11 * k, 1 * k, 26 * k, 26 * k, 0, 0, c.canvas.width, c.canvas.height);
  }, [epoch]);
  return <canvas ref={ref} className="mm-brand-face" width={68} height={68} aria-hidden="true" />;
}
// ---- Home ---------------------------------------------------------------------

const BREED: Record<string, string> = { classic: "Classic", chonk: "Chonk", fluffy: "Fluffy", siamese: "Siamese", kitten: "Kitten" };
const POWER: Record<string, string> = { balanced: "Balanced", saver: "Battery Saver", performance: "Performance" };

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function HomePage({ s, onChange, license, api, go }: { s: Settings; onChange: (next: Settings) => void; license: LicenseState; api: CompanionPanelApi | null; go: (p: SettingsPageId) => void }) {
  const modules = useModules(api);
  const name = s.companion.preferredName || s.userName;
  const featuresOn = Object.values(s.companion.features).filter(Boolean).length;
  const connected = [s.gmail.connected, s.calendar.connected].filter(Boolean).length;
  const tiles: { page: SettingsPageId; icon: IconName; title: string; text: string; foot: string }[] = [
    { page: "looks", icon: "paw", title: "Your MewMuze", text: `${BREED[s.appearance.species] ?? "Classic"} · ${s.catSize} · ${s.appearance.pattern}`, foot: s.selectedCostumeId ? "Wearing a costume" : "Change the look" },
    { page: "companion", icon: "sparkle", title: "Personal Companion", text: s.companion.enabled ? `On · ${featuresOn} smart updates` : "Off — the cat keeps to itself", foot: "Choose what it notices" },
    { page: "voice", icon: "mic", title: "Local Voice", text: `Talk instead of typing. ${STATE_LABEL[modules.get("voice").state]}.`, foot: "Voice settings" },
    { page: "chat", icon: "chat", title: "Local Chat", text: `Private conversations. ${STATE_LABEL[modules.get("chat").state]}.`, foot: "Chat settings" },
    { page: "privacy", icon: "battery", title: "Power use", text: POWER[s.companion.powerMode] ?? "Balanced", foot: "Change power use" },
    { page: "connections", icon: "link", title: "Connections", text: connected ? `${connected} of 2 connected` : "Gmail and Calendar", foot: "Connect your accounts" },
  ];
  return (
    <>
      <div className="mm-hero">
        <div className="mm-hero-copy">
          <div className="mm-hero-eyebrow">Your MewMuze</div>
          <h1 className="mm-hero-title">
            {greeting()}
            {name ? `, ${name}` : ""}.
          </h1>
          <p className="mm-hero-sub">
            {s.companion.enabled ? "Your companion is keeping an eye on your day." : "Your cat is here, keeping you company."} {license.licensed ? "" : license.trialActive ? "You're on the free trial." : ""}
          </p>
          <div className="mm-hero-actions">
            <button className="mm-btn primary" onClick={() => go("looks")}>
              <Icon name="palette" size={16} /> Change the look
            </button>
            <button className="mm-btn" onClick={() => go("companion")}>
              Personal Companion
            </button>
          </div>
        </div>
        <div className="mm-hero-art">
          <CatPreview bare sizePx={190} />
        </div>
      </div>

      <Section wide bare>
        <div className="mm-grid">
          {tiles.map((t) => (
            <button key={t.title} className="mm-tile" onClick={() => go(t.page)}>
              <span className="mm-tile-head">
                <span className="mm-tile-icon">
                  <Icon name={t.icon} size={18} />
                </span>
                <Icon name="chevronRight" size={16} />
              </span>
              <span className="mm-tile-title">{t.title}</span>
              <span className="mm-tile-text">{t.text}</span>
              <span className="mm-tile-foot">{t.foot}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Featured Looks" action={<button className="mm-btn ghost small" onClick={() => go("looks")}>All looks <Icon name="chevronRight" size={14} /></button>} wide bare>
        <FeaturedLooks settings={s} onChange={onChange} premium={license.premium} />
      </Section>
    </>
  );
}

// ---- Tools --------------------------------------------------------------------

function ToolsPage({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const [reminderDraft, setReminderDraft] = useState({ message: "", intervalMin: 60 });
  const clip = s.clipboardAssistant;
  const setClip = (patch: Partial<Settings["clipboardAssistant"]>) => set({ clipboardAssistant: { ...clip, ...patch } });
  return (
    <Page title="Tools" sub="Handy extras that live in the cat's menu.">
      <Section>
        <Row label="Your name" hint="Used in greetings. Stays on this computer.">
          <input type="text" className="sk-input" aria-label="Your name" value={s.userName} maxLength={40} onChange={(e) => set({ userName: e.target.value })} />
        </Row>
      </Section>

      <Section title="Clipboard Assistant" sub="Tidy, convert and reuse text you copy. Never keeps a history.">
        <Toggle label="Clipboard Assistant" hint="Adds a small button by the cat when you copy text." checked={clip.mode !== "off"} onChange={(on) => setClip({ mode: on ? "badge" : "off" })} />
        <Select label="When you copy text" value={clip.mode === "manual" ? "manual" : "badge"} disabled={clip.mode === "off"} options={[["badge", "Show the button by the cat"], ["manual", "Only when I open it"]] as const} onChange={(v) => setClip({ mode: v })} />
        <Select label="Forget copied text" value={clip.forgetAfterSeconds} options={[[0, "When the panel closes"], [60, "After 1 minute"], [300, "After 5 minutes"], [900, "After 15 minutes"]] as const} onChange={(v) => setClip({ forgetAfterSeconds: v })} />
        <Toggle label="Ignore one-time codes" hint="Skips text that looks like a login code." checked={clip.suppressSensitiveCodes} onChange={(v) => setClip({ suppressSensitiveCodes: v })} />
        <Advanced>
          <Row label="Preview length" hint="How many characters the panel shows.">
            <input type="number" className="sk-input narrow" aria-label="Preview length" min={250} max={10000} value={clip.maxPreviewLength} onChange={(e) => setClip({ maxPreviewLength: Number(e.target.value) || 2000 })} />
          </Row>
          <Select label="Largest text it will read" value={clip.maxInputLength} options={[[25000, "25,000 characters"], [100000, "100,000 characters"], [250000, "250,000 characters"], [500000, "500,000 characters"]] as const} onChange={(v) => setClip({ maxInputLength: v })} />
          <Row label="Apps to ignore" hint="One program name per line, e.g. KeePass.exe." stack>
            <textarea
              className="sk-input wide clipboard-exclusions"
              aria-label="Apps to ignore"
              rows={4}
              value={clip.excludedApplications.join("\n")}
              onChange={(e) =>
                setClip({
                  excludedApplications: e.target.value
                    .split(/\r?\n|,/)
                    .map((n) => n.trim())
                    .filter(Boolean),
                })
              }
            />
          </Row>
        </Advanced>
      </Section>

      <Section title="Reminders">
        <Toggle label="Stretch reminder" checked={s.stretchReminder.enabled} onChange={(v) => set({ stretchReminder: { ...s.stretchReminder, enabled: v } })} />
        <Row label="Stretch every" hint="Minutes.">
          <input type="number" className="sk-input narrow" aria-label="Stretch every, minutes" min={5} max={480} value={s.stretchReminder.intervalMin} onChange={(e) => set({ stretchReminder: { ...s.stretchReminder, intervalMin: Number(e.target.value) || 45 } })} />
        </Row>
        <Toggle label="Water reminder" checked={s.waterReminder.enabled} onChange={(v) => set({ waterReminder: { ...s.waterReminder, enabled: v } })} />
        <Row label="Water every" hint="Minutes.">
          <input type="number" className="sk-input narrow" aria-label="Water every, minutes" min={5} max={480} value={s.waterReminder.intervalMin} onChange={(e) => set({ waterReminder: { ...s.waterReminder, intervalMin: Number(e.target.value) || 60 } })} />
        </Row>
        <Toggle label="Rest breaks" hint="Counts only time you are actually using the computer." checked={s.workRest.enabled} onChange={(v) => set({ workRest: { ...s.workRest, enabled: v } })} />
        <Row label="Rest after" hint="Minutes of use.">
          <input type="number" className="sk-input narrow" aria-label="Rest after, minutes" min={10} max={240} value={s.workRest.intervalMin} onChange={(e) => set({ workRest: { ...s.workRest, intervalMin: Number(e.target.value) || 45 } })} />
        </Row>
      </Section>

      <Section title="Pomodoro" sub="Focus in blocks with short breaks between.">
        <Row label="Pomodoro" hint="Focus minutes / break minutes.">
          <span className="sk-stepper">
            <input type="number" className="sk-input narrow" aria-label="Focus minutes" min={5} max={120} value={s.pomodoro.focusMin} onChange={(e) => set({ pomodoro: { ...s.pomodoro, focusMin: Number(e.target.value) || 25 } })} />
            <span className="sk-sep">/</span>
            <input type="number" className="sk-input narrow" aria-label="Break minutes" min={1} max={60} value={s.pomodoro.shortBreakMin} onChange={(e) => set({ pomodoro: { ...s.pomodoro, shortBreakMin: Number(e.target.value) || 5 } })} />
          </span>
        </Row>
      </Section>

      <Section title="Pinned note">
        <Toggle label="Show pinned note" hint="A short note that rides above the cat." checked={s.note.visible} onChange={(v) => set({ note: { ...s.note, visible: v } })} />
        <Row label="Note">
          <input type="text" className="sk-input" aria-label="Note" value={s.note.text} maxLength={280} onChange={(e) => set({ note: { ...s.note, text: e.target.value } })} />
        </Row>
      </Section>

      <Section title="Your own reminders" sub="Repeat a message every so often.">
        {s.customReminders.map((c) => (
          <Row key={c.id} label={c.message} hint={`Every ${c.intervalMin} min`}>
            <button className="mm-btn" onClick={() => set({ customReminders: s.customReminders.filter((x) => x.id !== c.id) })}>
              Remove
            </button>
          </Row>
        ))}
        <Row label="New reminder" stack>
          <span className="sk-stepper">
            <input type="text" className="sk-input" placeholder="Check the oven" aria-label="Reminder message" value={reminderDraft.message} maxLength={200} onChange={(e) => setReminderDraft({ ...reminderDraft, message: e.target.value })} />
            <span className="sk-hint">every</span>
            <input type="number" className="sk-input narrow" aria-label="Every, minutes" min={1} max={1440} value={reminderDraft.intervalMin} onChange={(e) => setReminderDraft({ ...reminderDraft, intervalMin: Number(e.target.value) || 60 })} />
            <span className="sk-hint">min</span>
            <button
              className="mm-btn primary"
              disabled={!reminderDraft.message.trim()}
              onClick={() => {
                set({ customReminders: [...s.customReminders, { id: `custom-${Date.now()}`, message: reminderDraft.message.trim(), intervalMin: reminderDraft.intervalMin, enabled: true }] });
                setReminderDraft({ message: "", intervalMin: 60 });
              }}
            >
              Add
            </button>
          </span>
        </Row>
      </Section>

      <Advanced>
        <Row label="AI-agent status file" hint="A local JSON file MewMuze may read to show an assistant's progress. Empty turns it off." stack>
          <input type="text" className="sk-input wide" aria-label="AI-agent status file" placeholder="C:\path\to\agent-status.json" value={s.agentStatusFile} onChange={(e) => set({ agentStatusFile: e.target.value })} />
        </Row>
      </Advanced>
    </Page>
  );
}

// ---- Connections ------------------------------------------------------------------

function ConnectionsPage({ s, set, onOpenLink }: { s: Settings; set: (patch: Partial<Settings>) => void; onOpenLink: (url: string) => Promise<void> }) {
  const [showGmailSteps, setShowGmailSteps] = useState(false);
  const [showCalSteps, setShowCalSteps] = useState(false);
  const status = (on: boolean) => <span className={`mm-badge${on ? " ok" : ""}`}>{on ? "Connected" : "Not connected"}</span>;
  return (
    <Page title="Connections" sub="Let MewMuze see your email and calendar. Read-only, and only what it needs.">
      <Section title="Gmail" action={status(s.gmail.connected)}>
        <Row label="Gmail" hint="New senders and subjects only, over a secure connection. No Google sign-in window." stack>
          <input type="email" className="sk-input wide" aria-label="Gmail address" placeholder="you@gmail.com" value={s.gmail.email} onChange={(e) => set({ gmail: { ...s.gmail, email: e.target.value } })} />
          <input type="password" className="sk-input wide mono" aria-label="App password" placeholder="16-character app password" value={s.gmail.appPassword} onChange={(e) => set({ gmail: { ...s.gmail, appPassword: e.target.value } })} />
          <span className="sk-stepper">
            <button
              className={`mm-btn${s.gmail.connected ? " danger" : " primary"}`}
              disabled={!s.gmail.connected && !(s.gmail.email.trim() && s.gmail.appPassword.trim())}
              onClick={() => set({ gmail: { ...s.gmail, connected: !s.gmail.connected } })}
            >
              {s.gmail.connected ? "Disconnect" : "Connect Gmail"}
            </button>
            <button className="sk-steps-toggle" onClick={() => setShowGmailSteps((v) => !v)}>
              {showGmailSteps ? "Hide the steps" : "How do I get an app password?"}
            </button>
          </span>
        </Row>
        {showGmailSteps && (
          <div className="sk-connection-guide">
            <p>To connect your Gmail account, first create a Google App Password.</p>
            <h4>Step 1: Turn on 2-Step Verification</h4>
            <p>Google requires 2-Step Verification before you can create an App Password.</p>
            <button className="mm-btn guide-link" type="button" onClick={() => void onOpenLink("https://myaccount.google.com/signinoptions/two-step-verification")}>
              Turn On 2-Step Verification
            </button>
            <p className="sk-guide-note">Already enabled? Go to the next step.</p>
            <h4>Step 2: Create an App Password</h4>
            <p>Open Google&rsquo;s App Passwords page:</p>
            <button className="mm-btn guide-link" type="button" onClick={() => void onOpenLink("https://myaccount.google.com/apppasswords")}>
              Get App Password
            </button>
            <ol className="sk-steps">
              <li>Sign in to the Gmail account you want to connect.</li>
              <li>
                Enter any app name, such as <b>MewMuze</b>.
              </li>
              <li>
                Click <b>Create</b>.
              </li>
              <li>
                Google shows a <b>16-character App Password</b>.
              </li>
              <li>Copy it and paste it into the App Password field above, with or without spaces.</li>
              <li>
                Click <b>Connect Gmail</b>.
              </li>
            </ol>
            <p className="sk-guide-timing">After a new email arrives, MewMuze usually shows it within about 1–3 minutes. A full-screen app or another notice may delay it briefly.</p>
          </div>
        )}
      </Section>

      <Section title="Google Calendar" action={status(s.calendar.connected)}>
        <Row label="Google Calendar" hint="Reminders before your meetings, from your calendar's private link. No sign-in." stack>
          <input type="url" className="sk-input wide mono" aria-label="Private iCal address" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={s.calendar.icsUrl} onChange={(e) => set({ calendar: { ...s.calendar, icsUrl: e.target.value } })} />
          <span className="sk-stepper">
            <button
              className={`mm-btn${s.calendar.connected ? " danger" : " primary"}`}
              disabled={!s.calendar.connected && !s.calendar.icsUrl.trim().startsWith("https://")}
              onClick={() => set({ calendar: { ...s.calendar, connected: !s.calendar.connected } })}
            >
              {s.calendar.connected ? "Disconnect" : "Connect Calendar"}
            </button>
            <button className="sk-steps-toggle" onClick={() => setShowCalSteps((v) => !v)}>
              {showCalSteps ? "Hide the steps" : "Where is my private calendar link?"}
            </button>
          </span>
        </Row>
        {showCalSteps && (
          <div className="sk-connection-guide">
            <h4>Step 1: Open Google Calendar</h4>
            <p>Sign in to the Google account with the calendar you want to connect.</p>
            <button className="mm-btn guide-link" type="button" onClick={() => void onOpenLink("https://calendar.google.com/calendar/u/0/r")}>
              Open Google Calendar
            </button>
            <h4>Step 2: Open the calendar's settings</h4>
            <button className="mm-btn guide-link" type="button" onClick={() => void onOpenLink("https://calendar.google.com/calendar/u/0/r/settings/calendar")}>
              Open Integrate Calendar
            </button>
            <ol className="sk-steps">
              <li>
                Select your calendar under <b>Settings for my calendars</b>.
              </li>
              <li>
                Scroll to <b>Integrate calendar</b>.
              </li>
              <li>
                Copy the <b>Secret address in iCal format</b>.
              </li>
              <li>Paste it into the field above.</li>
              <li>
                Click <b>Connect Calendar</b>.
              </li>
            </ol>
            <p className="sk-guide-warning">Keep the Secret iCal address private: anyone with this link may be able to see your calendar.</p>
          </div>
        )}
      </Section>
    </Page>
  );
}

// ---- About --------------------------------------------------------------------------

function AboutPage({
  s,
  set,
  license,
  updateStatus,
  onResetPosition,
  onResetSettings,
  onQuit,
  onApplyLicense,
  onDeactivateLicense,
  onCompleteRemoval,
  onCheckUpdates,
}: {
  s: Settings;
  set: (patch: Partial<Settings>) => void;
  license: LicenseState;
  updateStatus: string;
  onResetPosition: () => void;
  onResetSettings: () => void;
  onQuit: () => void;
  onApplyLicense: (key: string) => Promise<string>;
  onDeactivateLicense: () => Promise<string>;
  onCompleteRemoval: () => Promise<string>;
  onCheckUpdates: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState("");
  const [working, setWorking] = useState(false);
  return (
    <Page title="About" sub="MewMuze Paper — an experimental build of MewMuze.">
      <Section title="Licence">
        <div className={`sk-license sk-row stack ${license.licensed ? "licensed" : license.trialActive ? "trial" : "free"}`} data-setting="licence">
          <div className="sk-license-status">{licenseSummary(license)}</div>
          {license.licensed ? (
            <div className="sk-license-actions">
              <span className="sk-license-hint">
                {license.source === "dodo"
                  ? license.devicesUsed != null
                    ? `${license.devicesUsed} of ${license.deviceLimit} devices activated. Deactivate before moving MewMuze to another computer.`
                    : `This device is active. Your lifetime licence supports up to ${license.deviceLimit} devices.`
                  : "This existing offline licence remains valid exactly as before."}
              </span>
              <button
                className="mm-btn"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  const err = await onDeactivateLicense();
                  setWorking(false);
                  setKeyError(err);
                }}
              >
                {working ? "Working…" : "Deactivate this computer"}
              </button>
            </div>
          ) : (
            <>
              <div className="sk-license-hint">A licence unlocks every breed, all costumes, colours and every tool. Keys activate securely and keep working offline for up to 30 days between checks.</div>
              <div className="sk-license-entry">
                <input
                  type="text"
                  className="sk-input mono"
                  aria-label="Licence key"
                  placeholder="Paste your licence key"
                  value={keyDraft}
                  onChange={(e) => {
                    setKeyDraft(e.target.value);
                    setKeyError("");
                  }}
                />
                <button
                  className="mm-btn primary"
                  disabled={working || !keyDraft.trim()}
                  onClick={async () => {
                    setWorking(true);
                    const err = await onApplyLicense(keyDraft);
                    setWorking(false);
                    setKeyError(err);
                    if (!err) setKeyDraft("");
                  }}
                >
                  {working ? "Checking…" : "Unlock"}
                </button>
              </div>
            </>
          )}
          {keyError && <div className="sk-license-error">{keyError}</div>}
        </div>
      </Section>

      <Section title="Updates and startup">
        <Toggle label="Check for updates automatically" checked={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
        <Row label="Updates" hint={updateStatus || "Downloaded and checked before installing."}>
          <button className="mm-btn" onClick={onCheckUpdates}>
            Check now
          </button>
        </Row>
        <Toggle label={IS_MAC ? "Start at login" : "Start with Windows"} hint="MewMuze appears when you sign in." checked={s.startWithWindows} onChange={(v) => set({ startWithWindows: v })} />
      </Section>

      <Section title="Maintenance">
        <Row label="Bring the cat back" hint="Moves MewMuze back to the middle of your screen.">
          <button className="mm-btn" onClick={onResetPosition}>
            Reset position
          </button>
        </Row>
        <Row label="Reset all settings" hint="Everything back to how it was on day one.">
          <button
            className="mm-btn"
            onClick={() => void confirmAction({ title: "Reset all settings?", message: "Every setting goes back to its default. Costumes you own stay installed.", confirmLabel: "Reset" }).then((ok) => ok && onResetSettings())}
          >
            Reset
          </button>
        </Row>
        <Row label="Remove MewMuze's data" hint="Deactivates this computer, deletes everything MewMuze stored, then quits.">
          <button
            className="mm-btn danger"
            disabled={working}
            onClick={async () => {
              const ok = await confirmAction({
                title: "Remove all MewMuze data from this computer?",
                message: "Your settings, reminders, appearance, costumes and activation are removed. You will need your licence key again.",
                confirmLabel: "Remove everything",
                danger: true,
              });
              if (!ok) return;
              setWorking(true);
              const error = await onCompleteRemoval();
              setWorking(false);
              setKeyError(error);
            }}
          >
            Remove data…
          </button>
        </Row>
        <Row label="Quit MewMuze">
          <button className="mm-btn danger" onClick={onQuit}>
            Quit
          </button>
        </Row>
      </Section>

      <Section>
        <Row label="Third-party licences" hint="Listed in THIRD-PARTY-NOTICES.txt in the app's folder, including the Montserrat typeface (SIL Open Font License)." />
      </Section>
    </Page>
  );
}
