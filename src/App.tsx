import { useEffect, useRef, useState } from "react";
import { Overlay } from "./components/Overlay";
import type { CatRendererHandle } from "./components/CatRenderer";
import {
  CatContextMenu,
  RetroNotice,
  CatNote,
  PomodoroChip,
  ScrollPaper,
  SessionTimer,
  BreakPicker,
  MailStack,
  type BubbleState,
  type MenuState,
  type MenuCommand,
} from "./components/OverlayUI";
import { SettingsPanel } from "./components/SettingsPanel";
import { LicenseGate } from "./components/LicenseGate";
import { ReminderPanel, NotePanel } from "./components/ReminderPanel";
import { focusDrift, startFocus, startBreak, type Session } from "./productivity/session";
import { pollGmail, newMessages, mailLine, gmailMessageUrl, GMAIL_POLL_MS } from "./integrations/gmail";
import {
  addMail,
  visibleMail,
  queuedCount,
  clampStackLimit,
  dismissMail as removeMail,
  type MailItem,
} from "./integrations/mailStack";
import {
  pollCalendar,
  calendarAlert,
  CALENDAR_POLL_MS,
  type CalEventRaw,
} from "./integrations/calendar";
import {
  stepFullscreen,
  isWithdrawn,
  INITIAL_FULLSCREEN_STATE,
} from "./behaviour/fullscreenRetreat";
import { QuickToolsPanel, ThunderStrike } from "./components/QuickToolsPanel";
import { CalcTimePanel } from "./components/CalcTimePanel";
import { PhotoModePanel, type PhotoSelection } from "./photo/PhotoModePanel";
import { findExpression, findPose } from "./photo/photoMode";
import type { Area, Box } from "./quicktools/panelPlacement";
import { CatEngine } from "./engine/catEngine";
import { CursorTracker, resolveUserIdle } from "./interaction/cursorTracker";
import { PettingDetector } from "./interaction/pettingDetector";
import { DragController } from "./interaction/dragController";
import { TypingDetector, type TypingLevel } from "./interaction/typingDetector";
import { categorizeApp, describeContext, type AppCategory } from "./interaction/contextAwareness";
import { Pomodoro, type PomodoroSnapshot } from "./productivity/pomodoro";
import { ReminderScheduler } from "./productivity/reminders";
import {
  activeScheduled,
  snoozeScheduled,
  completeScheduled,
  pruneScheduled,
} from "./productivity/scheduledReminders";
import { fetchWindows } from "./native/windowPlatforms";
import {
  fetchMonitors,
  computeOverlayOrigin,
  computeVirtualBounds,
  setClickThrough,
  positionOverlayToVirtualScreen,
} from "./native/monitorManager";
import { buildPlatforms, monitorAt } from "./physics/platformResolver";
import { loadSettings, saveSettings, sanitizeSettings, type Settings } from "./settings/settingsStore";
import { ACTIVITY_PROFILES, DEFAULT_SETTINGS, SIZE_TO_LOGICAL_PX } from "./settings/defaultSettings";
import { clearSpriteCache, configureAppearance, setSpriteCacheLimit } from "./animation/spriteLoader";
import { activateCostumeOverlay, setCostumeTint } from "./costumes/costumeOverlay";
import { CostumeInstallPanel } from "./costumes/CostumeInstallPanel";
import { resolveLicenseState, type LicenseState } from "./licensing/license";
import { FrameBudget, setQualityLevel, CACHE_LIMIT as QUALITY_CACHE_LIMIT, type QualityLevel } from "./perf/quality";
import { checkForUpdate, installUpdate } from "./licensing/updater";
import { SoundManager } from "./audio/soundManager";
import type { AnimationName } from "./types/cat";
import { ClipboardBadge } from "./clipboard-assistant/ClipboardBadge";
import { ClipboardPanel } from "./clipboard-assistant/ClipboardPanel";
import { ClipboardController } from "./clipboard-assistant/ClipboardController";
import {
  clearClipboard,
  isWindowsSessionLocked,
  listenForClipboardText,
  openClipboardLink,
  readClipboardText,
  writeClipboardText,
} from "./clipboard-assistant/clipboardBridge";
import type {
  ClipboardReaction,
  ClipboardSnapshot,
  NativeClipboardEvent,
} from "./clipboard-assistant/clipboardTypes";
import { scheduleClipboardBadgeDismiss } from "./clipboard-assistant/ClipboardNotice";
import { canPlayClipboardReaction } from "./clipboard-assistant/ClipboardPriority";
import "./components/ui.css";
import "./clipboard-assistant/clipboard.css";

const WORLD_REFRESH_MS = 1000;
const PERSIST_MS = 5000;
const INPUT_POLL_MS = 125;
const FULLSCREEN_POLL_MS = 2000;
const AGENT_POLL_MS = 2000;

// Work mode entrance: the cat swaps to its work pose at STRIKE_SWAP_MS, the
// flash's peak, so the change is hidden inside the brightest moment.
const STRIKE_TOTAL_MS = 640;
const STRIKE_SWAP_MS = 240;

/** Unbroken seconds of typing before the cat tips from overheating into panic. */
const PANIC_AFTER_S = 25;
/** Seconds without a single pet before the cat mopes. */
const SAD_AFTER_S = 20 * 60;
/** How long the cat holds a placard up after a milestone. */
const PLACARD_MS = 5200;
const CALM_VISUAL_ANIMATIONS = new Set<AnimationName>([
  "idle",
  "sideIdle",
  "backIdle",
  "sit",
  "sitSide",
  "blink",
  "tailFlick",
  "lookAround",
  "lookUp",
  "lookDown",
  "watch",
  "sleep",
  "sad",
  "readBook",
  "clipboardHold",
  "quickTools",
  "calcTools",
]);
/** Shown on the notebook bubble while the placard is held aloft. */
const PLACARD_LINES = [
  "you are a Rockstar! ⭐",
  "nice progress — keep going!",
  "that was focused work. 🤓",
  "you've got this. One task at a time.",
  "look at you go! 🏆",
  "another one done. Proud of you!",
];

/**
 * Resolved once and reused. This is on the hot path — the input poll alone
 * calls it several times a second — and re-entering the dynamic import for
 * every single IPC call adds a needless promise hop each time.
 */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeFn: InvokeFn | null = null;

/**
 * Nothing the cat does is worth waiting on for longer than this. A native
 * command that never returns previously left its caller awaiting forever, and
 * the polling timers kept firing, piling up pending promises for the life of
 * the session. Timing out degrades one reading instead of the whole app.
 */
const INVOKE_TIMEOUT_MS = 4000;

/**
 * Licence commands are the exception: they talk to Dodo over the network, and
 * the Rust side already bounds them at 5s connect plus 8s read/write. A 4s
 * guard here expires first and resolves null, which reads as "not licensed" —
 * so a merely slow connection looked exactly like an invalid key, and the
 * 14-day offline grace never got to run because its verdict is computed in
 * Rust after the point JS had already given up. This sits above that ceiling.
 */
const LICENSE_INVOKE_TIMEOUT_MS = 20000;

async function invokeSafe<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs: number = INVOKE_TIMEOUT_MS,
): Promise<T | null> {
  try {
    if (!invokeFn) {
      const mod = await import("@tauri-apps/api/core");
      invokeFn = mod.invoke as InvokeFn;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([invokeFn<T>(cmd, args), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function syncAutostart(enable: boolean): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-autostart");
    const on = await mod.isEnabled();
    if (enable && !on) await mod.enable();
    if (!enable && on) await mod.disable();
  } catch {
    /* plugin unavailable outside Tauri */
  }
}

async function updateTray(settings: Settings): Promise<void> {
  await invokeSafe("update_tray", {
    state: {
      paused: settings.paused,
      cursorChasing: settings.cursorChasing,
      soundEnabled: settings.soundEnabled,
      activityLevel: settings.activityLevel,
      catSize: settings.catSize,
      startWithWindows: settings.startWithWindows,
      catOff: settings.catOff,
      clipboardEnabled: settings.clipboardAssistant.mode !== "off",
    },
  });
}

type AgentState = "idle" | "typingPrompt" | "thinking" | "running" | "waiting" | "success" | "failed" | "attention";

interface Bridge {
  command: (cmd: MenuCommand | string) => void;
  updateSettings: (next: Settings) => void;
  dismissBubble: () => void;
  snoozeBubble: () => void;
  /** Mark Complete for scheduled reminders (retires the reminder). */
  completeBubble: () => void;
  /** Open one stacked email in the browser and retire its card. */
  openMail: (uid: number) => void;
  /** OK on one stacked email: dismiss just that card. */
  dismissMail: (uid: number) => void;
  /** Verify + store a licence key. Resolves to "" on success, else an error. */
  applyLicense: (key: string) => Promise<string>;
  /** Release this computer's activation (or remove a legacy local key). */
  deactivateLicense: () => Promise<string>;
  /** Explicitly deactivate, remove all local data, and quit. */
  completeRemoval: () => Promise<string>;
  /** Begin the 14-day trial from the licence gate. */
  startTrial: () => Promise<void>;
  /** Manual "check for updates" from the settings panel. */
  checkUpdates: () => void;
  copyClipboard: (text: string) => Promise<void>;
  clearClipboard: () => Promise<void>;
  closeClipboard: () => void;
  openClipboardLink: (url: string) => Promise<void>;
  reactClipboard: (reaction: ClipboardReaction) => void;
  /** Park the real cat in the pose Photo Mode is previewing. */
  holdPhotoPose: (selection: PhotoSelection) => void;
}

interface NativeLicenseStatus {
  valid: boolean;
  name: string;
  order: string;
  error: string;
  source?: "legacy" | "dodo" | "";
  offlineGrace?: boolean;
  devicesUsed?: number;
  deviceLimit?: number;
  activationStatus?: string;
}

export default function App() {
  const rendererRef = useRef<CatRendererHandle>(null);
  const bridgeRef = useRef<Bridge | null>(null);

  // UI state (React); the engine itself stays imperative inside the effect.
  const [settingsUI, setSettingsUI] = useState<Settings>(DEFAULT_SETTINGS);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsForeground, setSettingsForeground] = useState(false);
  const [costumeInstallOpen, setCostumeInstallOpen] = useState(false);
  const [reminderPanelOpen, setReminderPanelOpen] = useState(false);
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  /** Active focus/break session (null = neither running). */
  const [session, setSession] = useState<Session | null>(null);
  /** Break duration picker is open, awaiting a length choice. */
  const [breakPickerOpen, setBreakPickerOpen] = useState(false);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  /** Unread-mail cards, newest first. Visible ones are the head of this list. */
  const [mailItems, setMailItems] = useState<MailItem[]>([]);
  /** Overlay withdrawn behind a full-screen app: nothing renders, nothing ticks. */
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [pomoSnap, setPomoSnap] = useState<PomodoroSnapshot>({ phase: "idle", remaining: 0, cycle: 0, completed: null });
  // CSS px: cat position + size, and the monitor work-area's horizontal range
  // (the retro notice clamps itself inside it).
  const [anchor, setAnchor] = useState({ x: 200, y: 200, size: 64, areaLeft: 0, areaRight: 1920, areaTop: 0 });
  const [paperLen, setPaperLen] = useState(0);
  const [licenseUI, setLicenseUI] = useState<LicenseState>({
    licensed: false,
    name: "",
    trialActive: true,
    trialDaysLeft: 14,
    premium: true,
    source: "",
    offlineGrace: false,
    deviceLimit: 3,
    activationStatus: "",
  });
  const [updateStatus, setUpdateStatus] = useState("");
  /** Work mode panel: null when off, else the geometry it was placed against. */
  const [quickTools, setQuickTools] = useState<{ cat: Box; area: Area } | null>(null);
  /** Lightning strike overlay while work mode is being entered. */
  const [strike, setStrike] = useState<{ x: number; y: number; size: number } | null>(null);
  const [clipboardSession, setClipboardSession] = useState<ClipboardSnapshot | null>(null);
  const [clipboardBadge, setClipboardBadge] = useState<{ cat: Box; area: Area } | null>(null);
  const [clipboardPanel, setClipboardPanel] = useState<{ cat: Box; area: Area } | null>(null);
  /** Calc & Time panel: same open-beside-the-cat contract as Quick Tools. */
  const [calcTime, setCalcTime] = useState<{ cat: Box; area: Area } | null>(null);
  /** Photo Mode panel: same open-beside-the-cat contract as Quick Tools. */
  const [photoMode, setPhotoMode] = useState<{ cat: Box; area: Area } | null>(null);

  // Neither bought nor in trial: the cat is withheld until a key or a trial
  // unlocks it. Offline grace keeps an already-activated customer out of here.
  const gateBlocked = !licenseUI.licensed && !licenseUI.trialActive;

  const menuRef = useRef(menu);
  menuRef.current = menu;
  const gateRef = useRef(gateBlocked);
  gateRef.current = gateBlocked;
  const panelRef = useRef(panelOpen);
  panelRef.current = panelOpen && settingsForeground;
  const costumeInstallRef = useRef(costumeInstallOpen);
  costumeInstallRef.current = costumeInstallOpen;
  const reminderPanelRef = useRef(reminderPanelOpen);
  reminderPanelRef.current = reminderPanelOpen;
  const notePanelRef = useRef(notePanelOpen);
  notePanelRef.current = notePanelOpen;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const breakPickerRef = useRef(breakPickerOpen);
  breakPickerRef.current = breakPickerOpen;
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const mailItemsRef = useRef(mailItems);
  mailItemsRef.current = mailItems;
  const quickToolsRef = useRef(quickTools);
  quickToolsRef.current = quickTools;
  const clipboardBadgeRef = useRef(clipboardBadge);
  clipboardBadgeRef.current = clipboardBadge;
  const clipboardPanelRef = useRef(clipboardPanel);
  clipboardPanelRef.current = clipboardPanel;
  const calcTimeRef = useRef(calcTime);
  calcTimeRef.current = calcTime;
  const photoModeRef = useRef(photoMode);
  photoModeRef.current = photoMode;

  useEffect(() => {
    let disposed = false;
    const cleanup: Array<() => void> = [];
    let raf = 0;

    (async () => {
      let current: Settings = await loadSettings();

      // ---- licence + trial ----
      // firstRunUnix stays 0 until the customer starts the trial from the
      // licence gate, so an unactivated copy is blocked rather than silently
      // burning its 14 days while nobody is using it.
      //
      // The authoritative copy of that date lives in the OS credential vault,
      // not in settings.json — a plain-text stamp could be deleted, edited, or
      // outrun by winding the system clock back, each of which handed out a
      // fresh 14 days. `trial_status` also returns a monotonic clock so a
      // backwards jump buys nothing.
      let trialAnchor = {
        startedUnix: current.firstRunUnix,
        effectiveNowUnix: Math.floor(Date.now() / 1000),
        trusted: false,
      };
      /**
       * The clock the trial is judged against: never behind the watermark the
       * vault has already seen, but still advancing normally as time passes.
       */
      const trialNow = () => Math.max(Math.floor(Date.now() / 1000), trialAnchor.effectiveNowUnix);
      const refreshTrialAnchor = async (): Promise<void> => {
        const info = await invokeSafe<{
          vaultAvailable: boolean;
          startedUnix: number;
          effectiveNowUnix: number;
        }>("trial_status", { settingsFirstRun: current.firstRunUnix });
        if (!info || info.vaultAvailable !== true) {
          // Vault unavailable: fall back to exactly the old behaviour rather
          // than risk locking out someone who has done nothing wrong.
          trialAnchor = {
            startedUnix: current.firstRunUnix,
            effectiveNowUnix: Math.floor(Date.now() / 1000),
            trusted: false,
          };
          return;
        }
        trialAnchor = {
          startedUnix: info.startedUnix,
          effectiveNowUnix: info.effectiveNowUnix,
          trusted: true,
        };
        // Keep settings.json in step with the anchor (it drives the gate's
        // "trial already started" copy, and is the fallback if the vault later
        // becomes unreadable).
        if (info.startedUnix > 0 && info.startedUnix !== current.firstRunUnix) {
          current = { ...current, firstRunUnix: info.startedUnix };
          void saveSettings(current);
        }
      };
      await refreshTrialAnchor();

      // Declared before refreshLicense so the first call can assign to it.
      let license: LicenseState = resolveLicenseState({
        licensed: false,
        firstRunUnix: trialAnchor.startedUnix,
        nowUnix: trialNow(),
        trustedAnchor: trialAnchor.trusted,
      });
      /**
       * Publish licence state we already hold, without asking the network
       * again. `activate_dodo_license` returns the very same status shape that
       * `check_dodo_license` does, so re-validating a fresh activation over the
       * network only adds a second chance to fail.
       */
      const publishLicense = (opts: {
        licensed: boolean;
        name?: string;
        source?: LicenseState["source"];
        offlineGrace?: boolean;
        devicesUsed?: number;
        deviceLimit?: number;
        activationStatus?: string;
      }): LicenseState => {
        const state = resolveLicenseState({
          ...opts,
          firstRunUnix: trialAnchor.startedUnix,
          nowUnix: trialNow(),
          trustedAnchor: trialAnchor.trusted,
        });
        license = state;
        setLicenseUI(state);
        return state;
      };

      const resolveNativeLicense = async (
        key: string,
        dodoCommand: "restore_dodo_license" | "check_dodo_license",
      ): Promise<LicenseState> => {
        let licensed = false;
        let name = "";
        let source: LicenseState["source"] = "";
        let offlineGrace = false;
        if (key.trim()) {
          const res = await invokeSafe<NativeLicenseStatus>("verify_license", { key });
          licensed = res?.valid === true;
          name = res?.name ?? "";
          if (licensed) source = "legacy";
        }
        if (!licensed) {
          const dodo = await invokeSafe<NativeLicenseStatus>(
            dodoCommand,
            undefined,
            LICENSE_INVOKE_TIMEOUT_MS,
          );
          licensed = dodo?.valid === true;
          name = dodo?.name ?? "";
          if (licensed) {
            source = "dodo";
            offlineGrace = dodo?.offlineGrace === true;
          }
          return publishLicense({
            licensed,
            name,
            source,
            offlineGrace,
            devicesUsed: dodo?.devicesUsed,
            deviceLimit: dodo?.deviceLimit,
            activationStatus: dodo?.activationStatus,
          });
        }
        return publishLicense({ licensed, name, source, offlineGrace });
      };
      const restoreLicense = (key: string) => resolveNativeLicense(key, "restore_dodo_license");
      const refreshLicense = (key: string) => resolveNativeLicense(key, "check_dodo_license");

      // Restore from the OS vault first. This is deliberately local-only, so a
      // normal update opens immediately and network validation happens later.
      try {
        await restoreLicense(current.licenseKey);
      } catch (err) {
        console.error("licence check failed; continuing", err);
      }

      // Premium features fall back to safe defaults once the trial ends, so an
      // unlicensed cat is still charming — just not customised.
      const gated = (s: Settings): Settings =>
        license.premium
          ? s
          : {
              ...s,
              appearance: { ...s.appearance, species: "classic", accessory: "none" },
              seasonalCostumes: false,
              contextAwareness: false,
              musicReactions: false,
              pomodoro: { ...s.pomodoro, enabled: false },
              stretchReminder: { ...s.stretchReminder, enabled: false },
              waterReminder: { ...s.waterReminder, enabled: false },
              workRest: { ...s.workRest, enabled: false },
              motivation: false,
            };

      /** What the running app actually obeys (user settings after gating). */
      let effective: Settings = gated(current);
      configureAppearance(effective.appearance);
      setCostumeTint(effective.costumeTint);
      void activateCostumeOverlay(effective.selectedCostumeId).catch(() => activateCostumeOverlay(""));

      /**
       * Re-apply the entitlement after the licence or trial changed.
       *
       * `effective` is derived from `license`, but only `applySettings`
       * recomputed it, and it skips `configureAppearance` when the settings
       * themselves did not change. Unlocking therefore left the app obeying the
       * previous entitlement — customisation stayed stripped until some
       * unrelated setting was touched. Every licence transition calls this.
       */
      const regate = () => {
        effective = gated(current);
        configureAppearance(effective.appearance);
        setCostumeTint(effective.costumeTint);
        void activateCostumeOverlay(effective.selectedCostumeId).catch(() =>
          activateCostumeOverlay(""),
        );
        pomodoro.setConfig(effective.pomodoro);
        reminders.configure(
          effective.stretchReminder,
          effective.waterReminder,
          effective.customReminders,
          current.userName,
          performance.now() / 1000,
        );
      };
      // Panel/menu theme: a single class on the root re-skins every sk surface.
      const applyTheme = (t: Settings["uiTheme"]) =>
        document.documentElement.classList.toggle("sk-light", t === "light");
      applyTheme(current.uiTheme);
      setSettingsUI(current);

      // ---- native world bootstrap ----
      let monitors = await fetchMonitors();
      let origin = computeOverlayOrigin(monitors);
      let bounds = computeVirtualBounds(monitors, origin);
      let worldW = Math.max(1, Math.round(bounds.right));
      let worldH = Math.max(1, Math.round(bounds.bottom));
      // Engine px -> CSS px. Shared so it isn't recomputed inline at every call site.
      const cssScale = () => ({ x: window.innerWidth / worldW, y: window.innerHeight / worldH });
      const startMon = monitors.find((m) => m.isPrimary) ?? monitors[0];
      let scale = startMon?.scale ?? 1;
      await positionOverlayToVirtualScreen();

      // ---- systems ----
      const tracker = new CursorTracker();
      tracker.setOrigin(origin);
      await tracker.start();
      cleanup.push(() => tracker.stop());

      const petting = new PettingDetector();
      const drag = new DragController();
      const typing = new TypingDetector();
      const pomodoro = new Pomodoro(current.pomodoro);
      const reminders = new ReminderScheduler();
      const sound = new SoundManager();
      const clipboardController = new ClipboardController();
      sound.setEnabled(current.soundEnabled && !current.masterMuted);
      reminders.configure(current.stretchReminder, current.waterReminder, current.customReminders, current.userName, performance.now() / 1000);

      const engine = new CatEngine({
        sizePx: SIZE_TO_LOGICAL_PX[current.catSize] * scale,
        scale,
        activity: ACTIVITY_PROFILES[current.activityLevel],
        bounds,
        start: current.lastPosition ?? undefined,
      });
      engine.setWorld({ platforms: [], bounds, monitors, origin, scale });
      engine.setPaused(current.paused);
      engine.setEyeTracking(current.eyeTracking);
      engine.setDragStretch(current.dragStretch);
      engine.setDrowsyAfterS(current.drowsyAfterSec);

      await syncAutostart(current.startWithWindows);
      await updateTray(current);

      // ---- visibility (Cat On/Off transitions) ----
      const vis = { v: current.catOff ? 0 : 1, target: current.catOff ? 0 : 1 };
      let windowHidden = false;
      if (current.catOff) {
        windowHidden = true;
        void invokeSafe("set_cat_visible", { visible: false });
      }
      let exitAt = 0; // while >0, waiting for the wave animation before fading

      // ---- feature state ----
      let typingLevel: TypingLevel = "none";
      // Windows reports one privacy-safe duration covering BOTH mouse and
      // keyboard input. Null keeps browser previews on the cursor fallback.
      let nativeIdleMs: number | null = null;
      // Context awareness (app exe name + media playback state only).
      let foregroundExe: string | null = null;
      let appCategory: AppCategory = "other";
      let mediaPlaying = false;
      // Whether another app is CAPTURING audio (never the audio itself).
      let micActive = false;
      let micWasActive = false;
      let readingSince = 0; // sustained slow browser scrolling → reading
      // Work-rest + motivation (local active-use tracking; no history kept).
      let activeUseS = 0;
      let workRestShown = false;
      let motivationNextAt = performance.now() + (35 + Math.random() * 35) * 60_000;
      let motivationUntil = 0;
      let appliedAccessory = current.appearance.accessory;
      let scrollDir: 1 | -1 | 0 = 0;
      let scrollAccum = 0;
      let scrollLastAt = 0;
      let fullscreenActive = false;
      // ---- full-screen retreat (wave → fade → hide the window entirely) ----
      let fsState = INITIAL_FULLSCREEN_STATE;
      /** Where the cat was standing before it withdrew, to come back to. */
      let fsReturnPos: { x: number; y: number } | null = null;
      /**
       * Edge detector for notices specifically. Separate from `fsState`, which
       * only moves when `peekAuto` allows the cat to withdraw — reminders are
       * suppressed during full screen either way, so this has to follow the raw
       * signal rather than the retreat.
       */
      let noticesSawFullscreen = false;
      let agentLoop: AnimationName | null = null;
      let lastAgentState: AgentState = "idle";
      let lastAnchor = { x: -1, y: -1, size: 0 };
      let paperShown = 0;
      /** True from the moment the bolt strikes, so the cat suits up mid-flash. */
      let workModeArmed = false;
      // Set at the strike so the cat is already holding the calculator
      // before the flash clears, rather than popping in after it.
      let calcModeArmed = false;
      let typingStreakS = 0;
      let sinceLastPetS = 0;
      let placardUntil = 0;
      /** id+phase of the scheduled reminder currently surfaced (anim edge detect). */
      let lastSchedKey = "";
      /** Next moment (perf ms) the focused cat allows itself a little cheer. */
      let focusCheerAt = 0;
      /**
       * The app focus mode is guarding, locked in on the first real app seen
       * after the session starts. It cannot be captured when the session
       * begins, because right-clicking the cat makes MewMuze itself the
       * foreground window.
       */
      let focusApp: string | null = null;
      let clipboardBadgeTimer: ReturnType<typeof setTimeout> | null = null;
      let clipboardForgetTimer: ReturnType<typeof setTimeout> | null = null;
      // ---- connector polling state (Gmail + Google Calendar) ----
      let lastGmailUid = 0; // highest UID surfaced so far (0 = no baseline yet)
      let gmailPolling = false;
      let calEvents: CalEventRaw[] = [];
      let calPolling = false;
      let nextCalAt = 0;
      let lastCalAlertKey = "";
      let dismissedCalKey = "";
      // Scales animation detail to what this machine can actually sustain.
      const budget = new FrameBudget();
      let appliedQuality: QualityLevel = "high";

      const catCssBox = (): Box => {
        const { x: sx, y: sy } = cssScale();
        const b = engine.getBounds();
        return { x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy };
      };
      const catCssArea = (): Area => {
        const { x: sx, y: sy } = cssScale();
        const mon = monitorAt(engine.state.x, engine.state.y, monitors, origin);
        // Work area, not monitor bounds: the taskbar sits above the overlay and
        // would swallow the panel's clicks.
        if (!mon) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        return {
          left: (mon.workLeft - origin.left) * sx,
          top: (mon.workTop - origin.top) * sy,
          right: (mon.workRight - origin.left) * sx,
          bottom: (mon.workBottom - origin.top) * sy,
        };
      };

      // ---- world refresh (windows + monitors) at a low frequency ----
      const refresh = async () => {
        const [wins, mons] = await Promise.all([fetchWindows(), fetchMonitors()]);
        if (mons.length > 0) monitors = mons;
        origin = computeOverlayOrigin(monitors);
        bounds = computeVirtualBounds(monitors, origin);
        worldW = Math.max(1, Math.round(bounds.right));
        worldH = Math.max(1, Math.round(bounds.bottom));
        const platforms = buildPlatforms(wins, monitors, origin);
        const mon = monitorAt(engine.state.x, engine.state.y, monitors, origin);
        scale = mon?.scale ?? scale;
        engine.setWorld({ platforms, bounds, monitors, origin, scale });
        engine.setSize(SIZE_TO_LOGICAL_PX[current.catSize] * scale);
        tracker.setOrigin(origin);
        if (clipboardPanelRef.current) {
          setClipboardPanel({ cat: catCssBox(), area: catCssArea() });
        }
      };
      await refresh();
      const refreshTimer = setInterval(() => {
        // Enumerating every top-level window is the most expensive poll we do;
        // there is nothing to climb on while the cat is hidden in the tray.
        // Cat On triggers a fresh refresh within one interval anyway.
        if (current.catOff) return;
        void refresh();
      }, WORLD_REFRESH_MS);
      cleanup.push(() => clearInterval(refreshTimer));

      // ---- input activity polls (privacy-safe aggregates only) ----
      const inputTimer = setInterval(async () => {
        if (current.catOff) return;
        const nowS = performance.now() / 1000;
        const idleMs = await invokeSafe<number>("get_user_idle_ms");
        if (typeof idleMs === "number" && Number.isFinite(idleMs) && idleMs >= 0) {
          nativeIdleMs = idleMs;
        }
        if (current.keyboardReactions) {
          const count = await invokeSafe<number>("get_keyboard_activity");
          if (typeof count === "number") typingLevel = typing.sample(count, nowS);
        } else {
          typingLevel = "none";
        }
        if (current.scrollReactions) {
          const delta = await invokeSafe<number>("get_scroll_delta");
          if (typeof delta === "number" && delta !== 0) {
            scrollDir = delta > 0 ? -1 : 1; // wheel forward => content up => look up
            scrollAccum = Math.min(600, scrollAccum + Math.abs(delta) / 4);
            scrollLastAt = performance.now();
          }
        }
      }, INPUT_POLL_MS);
      cleanup.push(() => clearInterval(inputTimer));

      const fsTimer = setInterval(async () => {
        const fs = await invokeSafe<boolean>("is_fullscreen_active");
        fullscreenActive = fs === true;
      }, FULLSCREEN_POLL_MS);
      cleanup.push(() => clearInterval(fsTimer));

      // ---- optional AI-agent status (explicit local file, off by default) ----
      const agentTimer = setInterval(async () => {
        if (!current.agentStatusFile || current.catOff) {
          agentLoop = null;
          return;
        }
        const rawText = await invokeSafe<string | null>("read_agent_status", { path: current.agentStatusFile });
        if (!rawText) {
          agentLoop = null;
          return;
        }
        let state: AgentState = "idle";
        try {
          const parsed = JSON.parse(rawText) as { state?: string };
          if (typeof parsed.state === "string") state = parsed.state as AgentState;
        } catch {
          return;
        }
        if (state !== lastAgentState) {
          if (state === "success") {
            engine.playOneShot("celebrate");
            sound.play("meow");
            showInfoBubble(`${current.userName ? current.userName + ", " : ""}the agent finished! ✅`);
          } else if (state === "failed") {
            engine.playOneShot("confused");
            showInfoBubble("The agent hit an error 🐾");
          } else if (state === "attention") {
            engine.playOneShot("startled");
          }
          lastAgentState = state;
        }
        agentLoop = state === "thinking" ? "think" : state === "running" ? "knead" : state === "waiting" ? "watch" : null;
      }, AGENT_POLL_MS);
      cleanup.push(() => clearInterval(agentTimer));

      // ---- context poll: foreground app category + media playback ---------
      const contextTimer = setInterval(async () => {
        if (current.catOff) return;
        // Focus mode needs the foreground app even when Context Awareness is
        // off, so the guard is asked for independently of that setting. When
        // neither wants it, nothing is read at all.
        const guardingFocus = sessionRef.current?.kind === "focus";
        if (effective.contextAwareness || guardingFocus) {
          const exe = await invokeSafe<string | null>("get_foreground_app");
          foregroundExe = exe ?? null;
          // The category still respects the setting: it drives idle animations,
          // which the focus guard has no business turning on.
          appCategory = effective.contextAwareness ? categorizeApp(foregroundExe) : "other";
          if (guardingFocus) {
            const drift = focusDrift(foregroundExe, focusApp);
            if (drift.kind === "lock") {
              focusApp = drift.app;
            } else if (drift.kind === "drift") {
              // End the session: the timer chip disappears with it.
              setSession(null);
              focusApp = null;
              engine.playOneShot("angry");
              showInfoBubble("You said you would focus! But you are not focusing… 😾");
            }
          }
        } else {
          foregroundExe = null;
          appCategory = "other";
        }
        mediaPlaying = effective.musicReactions ? (await invokeSafe<boolean>("get_media_playing")) === true : false;
        // Mic ACTIVITY only: a boolean saying some app has the mic open.
        micActive = (await invokeSafe<boolean>("get_mic_active")) === true;
      }, 2500);
      cleanup.push(() => clearInterval(contextTimer));

      // ---- pointer (button state only; positions come from the global tracker) ----
      let buttonDown = false;
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        // Clicking outside an open menu closes it.
        if (menuRef.current) {
          // Guard the type: a pointerdown whose target isn't an Element (window
          // or document) would throw here and abort the whole handler, silently
          // killing dragging for the rest of the session.
          const target = e.target;
          const inMenu = target instanceof Element && target.closest(".cat-menu");
          if (!inMenu) setMenu(null);
        }
        const s = tracker.getSample();
        if (!s || !engine.containsPoint(s.x, s.y)) return;
        buttonDown = true;
        drag.onDown(s.x, s.y, performance.now());
      };
      const onUp = () => {
        if (!buttonDown) return;
        buttonDown = false;
        const res = drag.onUp(performance.now());
        if (res.wasClick) {
          const s = tracker.getSample();
          if (s && engine.containsPoint(s.x, s.y)) engine.poke();
        } else {
          engine.grabEnd(res.releaseVelocity);
        }
      };
      const onContext = (e: MouseEvent) => {
        e.preventDefault();
        const s = tracker.getSample();
        if (s && engine.containsPoint(s.x, s.y) && !current.catOff) {
          setMenu({ x: e.clientX, y: e.clientY });
        } else {
          setMenu(null);
        }
      };
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("contextmenu", onContext);
      cleanup.push(() => {
        window.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("contextmenu", onContext);
      });

      // ---- bubbles ----
      const showInfoBubble = (message: string) => {
        setBubble({ id: `info-${Date.now()}`, message, snoozable: false });
      };
      if (current.costumeMigrationNoticePending) {
        showInfoBubble(
          "This costume is no longer included by default. Your other appearance settings are unchanged.",
        );
        current = { ...current, costumeMigrationNoticePending: false };
        effective = gated(current);
        setSettingsUI(current);
        void saveSettings(current);
      }

      // ---- settings application ----
      const applySettings = (next: Settings, prev: Settings) => {
        current = next;
        setSettingsUI(next);
        // The user's raw choices are always persisted; only what actually gets
        // applied is gated, so everything returns intact when they unlock.
        const eff = gated(next);
        effective = eff;
        if (next.appearance !== prev.appearance || !license.premium) configureAppearance(eff.appearance);
        if (
          next.selectedCostumeId !== prev.selectedCostumeId ||
          next.costumeTint !== prev.costumeTint
        ) {
          // Re-activating rebuilds the painter around the new colour and moves
          // the sprite cache key with it.
          setCostumeTint(eff.costumeTint);
          void activateCostumeOverlay(eff.selectedCostumeId).catch(() => activateCostumeOverlay(""));
        }
        if (next.uiTheme !== prev.uiTheme) applyTheme(next.uiTheme);
        engine.setActivity(ACTIVITY_PROFILES[next.activityLevel]);
        engine.setSize(SIZE_TO_LOGICAL_PX[next.catSize] * scale);
        engine.setPaused(next.paused);
        engine.setEyeTracking(next.eyeTracking);
        engine.setDragStretch(next.dragStretch);
        engine.setDrowsyAfterS(next.drowsyAfterSec);
        sound.setEnabled(next.soundEnabled && !next.masterMuted);
        pomodoro.setConfig(eff.pomodoro);
        reminders.configure(eff.stretchReminder, eff.waterReminder, eff.customReminders, next.userName, performance.now() / 1000);
        if (next.clipboardAssistant.mode === "off") {
          clearClipboardTimers();
          clipboardController.clear();
          setClipboardSession(null);
          setClipboardBadge(null);
          setClipboardPanel(null);
        }
        if (next.startWithWindows !== prev.startWithWindows) void syncAutostart(next.startWithWindows);
        void saveSettings(next);
        void updateTray(next);
      };

      /** Existing signed keys stay offline; new purchase keys activate through Dodo. */
      const applyLicenseKey = async (key: string): Promise<string> => {
        const legacy = await invokeSafe<NativeLicenseStatus>("verify_license", { key });
        if (legacy?.valid) {
          const next = { ...current, licenseKey: key.trim() };
          publishLicense({ licensed: true, name: legacy.name, source: "legacy" });
          applySettings(next, current);
          regate();
          engine.playOneShot("celebrate");
          showInfoBubble(`Unlocked${legacy.name ? ", " + legacy.name : ""} — thank you! 💚`);
          return "";
        }

        const dodo = await invokeSafe<NativeLicenseStatus>(
          "activate_dodo_license",
          { key },
          LICENSE_INVOKE_TIMEOUT_MS,
        );
        if (dodo?.valid) {
          // Trust this response instead of calling check_dodo_license straight
          // afterwards: Rust builds both from the same helper, so a second
          // round trip could only turn a successful activation into a failure.
          publishLicense({
            licensed: true,
            name: dodo.name,
            source: "dodo",
            offlineGrace: dodo.offlineGrace === true,
            devicesUsed: dodo.devicesUsed,
            deviceLimit: dodo.deviceLimit,
            activationStatus: dodo.activationStatus,
          });
          // The purchased key now lives in the OS credential vault, not JSON.
          applySettings({ ...current, licenseKey: "" }, current);
          regate();
          engine.playOneShot("celebrate");
          showInfoBubble("MewMuze is unlocked on this computer — thank you! 💚");
          return "";
        }
        return dodo?.error || legacy?.error || "That licence key isn't valid.";
      };

      const deactivateLicense = async (): Promise<string> => {
        if (license.source === "dodo") {
          const result = await invokeSafe<NativeLicenseStatus>(
            "deactivate_dodo_license",
            undefined,
            LICENSE_INVOKE_TIMEOUT_MS,
          );
          if (result?.error) return result.error;
        }
        const next = { ...current, licenseKey: "" };
        // Re-gate before applying, so the settings pass recomputes against the
        // now-unlicensed state instead of leaving premium features running.
        publishLicense({ licensed: false });
        applySettings(next, current);
        regate();
        showInfoBubble("Licence removed from this computer.");
        return "";
      };

      const completeRemoval = async (): Promise<string> => {
        const deactivationError = await deactivateLicense();
        if (deactivationError) return deactivationError;
        const removed = await invokeSafe<boolean>("clear_mewmuze_local_data");
        return removed === true ? "" : "MewMuze could not remove its local data.";
      };

      /** Start the 14-day trial from the licence gate. One time only. */
      const startTrial = async (): Promise<void> => {
        if (current.firstRunUnix || trialAnchor.startedUnix > 0) return;
        // Anchor it in the vault first. `trial_begin` is idempotent, so if this
        // machine has already used its trial the existing (possibly spent)
        // anchor comes back and no second trial is granted.
        const info = await invokeSafe<{
          vaultAvailable: boolean;
          startedUnix: number;
          effectiveNowUnix: number;
        }>("trial_begin");
        const startedUnix = info?.startedUnix && info.startedUnix > 0
          ? info.startedUnix
          : Math.floor(Date.now() / 1000);
        trialAnchor = {
          startedUnix,
          effectiveNowUnix: Math.max(info?.effectiveNowUnix ?? 0, startedUnix),
          trusted: info?.vaultAvailable === true,
        };
        // Stamp settings too so publishLicense reads the new date, then re-gate:
        // the trial grants premium, which nothing else would recompute.
        applySettings({ ...current, firstRunUnix: startedUnix }, current);
        publishLicense({
          licensed: license.licensed,
          name: license.name,
          source: license.source,
          offlineGrace: license.offlineGrace,
          devicesUsed: license.devicesUsed,
          deviceLimit: license.deviceLimit,
          activationStatus: license.activationStatus,
        });
        regate();
      };

      // Declared before setCatOff, which calls it: a const used before its
      // initialiser throws a TDZ error that silently kills the whole bootstrap.
      const exitWorkMode = () => {
        workModeArmed = false;
        setStrike(null);
        setQuickTools(null);
      };

      const exitCalcMode = () => {
        calcModeArmed = false;
        setStrike(null);
        setCalcTime(null);
      };

      const setCatOff = (off: boolean) => {
        if (off === current.catOff) return;
        // A hidden cat cannot be photographed, and leaving the pose hold set
        // would freeze it on the way back in.
        if (off) closePhotoMode();
        const prev = current;
        if (off) {
          // Exit: wave goodbye, then fade+shrink, then hide the window.
          engine.setLoopOverride(null);
          engine.playOneShot("wave");
          exitAt = performance.now() + 850;
          setMenu(null);
          setPanelOpen(false);
          setSettingsForeground(false);
          setBubble(null);
          setClipboardBadge(null);
          setClipboardPanel(null);
          clipboardController.clear();
          setClipboardSession(null);
          exitWorkMode();
        } else {
          windowHidden = false;
          void invokeSafe("set_cat_visible", { visible: true });
          engine.enterFromTop();
          vis.target = 1;
          exitAt = 0;
        }
        applySettings({ ...current, catOff: off }, prev);
      };

      // ---- Quick Tools -------------------------------------------------
      const clearClipboardTimers = () => {
        if (clipboardBadgeTimer) clearTimeout(clipboardBadgeTimer);
        if (clipboardForgetTimer) clearTimeout(clipboardForgetTimer);
        clipboardBadgeTimer = null;
        clipboardForgetTimer = null;
      };
      cleanup.push(clearClipboardTimers);

      const scheduleClipboardForget = (snapshot: ClipboardSnapshot) => {
        if (clipboardForgetTimer) clearTimeout(clipboardForgetTimer);
        clipboardForgetTimer = null;
        if (snapshot.expiresAt === null) return;
        clipboardForgetTimer = setTimeout(() => {
          if (!clipboardController.expire(Date.now())) return;
          setClipboardSession(null);
          setClipboardBadge(null);
          setClipboardPanel(null);
        }, Math.max(0, snapshot.expiresAt - Date.now()));
      };

      const clipboardRuntime = async () => ({
        sessionLocked: await isWindowsSessionLocked().catch(() => false),
        hidden: current.catOff,
        paused: current.paused,
        fullscreen: fullscreenActive || current.peekManual,
      });

      const clipboardMayReact = () =>
        canPlayClipboardReaction({
          hidden: current.catOff,
          paused: current.paused,
          fullscreen: fullscreenActive,
          dragging: drag.isDragging,
          grounded: engine.state.isGrounded,
          activeNotice: Boolean(bubbleRef.current),
          quickTools: Boolean(quickToolsRef.current || workModeArmed),
        });

      const reactClipboard = (reaction: ClipboardReaction) => {
        if (!clipboardMayReact()) return;
        const animation: Record<ClipboardReaction, AnimationName> = {
          notice: "clipboardNotice",
          hold: "clipboardHold",
          clean: "clipboardClean",
          arrange: "clipboardArrange",
          success: "clipboardSuccess",
          error: "clipboardError",
        };
        engine.playOneShot(animation[reaction]);
      };

      const acceptClipboardEvent = async (event: NativeClipboardEvent, manual = false) => {
        const accepted = clipboardController.accept(
          event,
          current.clipboardAssistant,
          await clipboardRuntime(),
          Date.now(),
          manual,
        );
        if (!accepted.accepted || !accepted.snapshot) return accepted;
        setClipboardSession(accepted.snapshot);
        scheduleClipboardForget(accepted.snapshot);
        if (accepted.showBadge) {
          setClipboardBadge({ cat: catCssBox(), area: catCssArea() });
          if (clipboardBadgeTimer) clearTimeout(clipboardBadgeTimer);
          clipboardBadgeTimer = scheduleClipboardBadgeDismiss(() => setClipboardBadge(null));
          reactClipboard("notice");
        }
        return accepted;
      };

      const openClipboardAssistant = async () => {
        setMenu(null);
        setClipboardBadge(null);
        if (clipboardBadgeTimer) {
          clearTimeout(clipboardBadgeTimer);
          clipboardBadgeTimer = null;
        }
        if (current.clipboardAssistant.mode === "off") {
          showInfoBubble("Clipboard Assistant is off. Enable it in Productivity settings.");
          return;
        }
        if (current.catOff) {
          setCatOff(false);
          const timer = setTimeout(() => void openClipboardAssistant(), 950);
          cleanup.push(() => clearTimeout(timer));
          return;
        }
        if (quickToolsRef.current || workModeArmed) exitWorkMode();

        let snapshot = clipboardController.session.snapshot;
        if (!snapshot) {
          let text: string | null;
          try {
            text = await readClipboardText();
          } catch {
            showInfoBubble("MewMuze couldn’t read this clipboard item. Please try copying it again.");
            reactClipboard("error");
            return;
          }
          if (!text) {
            showInfoBubble("This clipboard item is empty or not supported. Copy some text first.");
            return;
          }
          const accepted = await acceptClipboardEvent(
            {
              text,
              sourceApp: foregroundExe,
              sequence: 0,
            },
            true,
          );
          snapshot = accepted.snapshot;
          if (!accepted.accepted || !snapshot) {
            const message =
              accepted.reason === "too-large"
                ? "That copy is above the Clipboard Assistant safety limit."
                : accepted.reason === "excluded" || accepted.reason === "sensitive-code"
                  ? "That copy was ignored by your clipboard privacy settings."
                  : "Clipboard Assistant is unavailable while the cat is paused or hidden.";
            showInfoBubble(message);
            return;
          }
        }
        setClipboardSession(snapshot);
        setClipboardPanel({ cat: catCssBox(), area: catCssArea() });
        reactClipboard("hold");
      };

      const strikeIntoWorkMode = () => {
        const box = catCssBox();
        setStrike({ x: box.x + box.width / 2, y: box.y + box.height / 2, size: box.height });
        // No startle one-shot: it's in AIRBORNE_ANIMS, so it launches the cat and
        // the grounded work-pose override can't apply until it lands (measured:
        // several seconds of sunglasses with no laptop). The flash sells the hit.
        workModeArmed = true;
        const swap = setTimeout(() => {
          setQuickTools({ cat: catCssBox(), area: catCssArea() });
        }, STRIKE_SWAP_MS);
        const clear = setTimeout(() => setStrike(null), STRIKE_TOTAL_MS);
        cleanup.push(() => {
          clearTimeout(swap);
          clearTimeout(clear);
        });
      };

      const strikeIntoCalcMode = () => {
        const box = catCssBox();
        setStrike({ x: box.x + box.width / 2, y: box.y + box.height / 2, size: box.height });
        calcModeArmed = true;
        const swap = setTimeout(() => {
          setCalcTime({ cat: catCssBox(), area: catCssArea() });
        }, STRIKE_SWAP_MS);
        const clear = setTimeout(() => setStrike(null), STRIKE_TOTAL_MS);
        cleanup.push(() => {
          clearTimeout(swap);
          clearTimeout(clear);
        });
      };

      // ---- Photo Mode ----------------------------------------------------
      // Declared above enterCalcMode/enterWorkMode, which close it when they
      // take over; a const referenced before its initialiser throws a TDZ error
      // that silently kills the whole bootstrap.
      const closePhotoMode = () => {
        // Order matters only in that both must happen: the pose hold and the
        // expression override are the ONLY engine state Photo Mode touches, so
        // clearing them hands the cat back exactly as it was found.
        engine.setPhotoPose(null);
        engine.setPhotoExpression(null);
        setPhotoMode(null);
      };

      const openPhotoMode = () => {
        setMenu(null);
        // Work mode, calc mode and a photo session are all "the cat is busy
        // with one thing"; the existing panels already exclude each other.
        if (quickToolsRef.current || workModeArmed) exitWorkMode();
        if (calcTimeRef.current || calcModeArmed) exitCalcMode();
        // Nothing to photograph while the cat is away.
        if (current.catOff) setCatOff(false);
        setPhotoMode({ cat: catCssBox(), area: catCssArea() });
      };

      /** The panel tells us what it is showing; the real cat matches it. */
      const holdPhotoPose = (selection: PhotoSelection) => {
        const expression = findExpression(selection.expressionId);
        engine.setPhotoPose(findPose(selection.poseId).anim);
        engine.setPhotoExpression(
          expression.eyes || expression.mouth
            ? { eyes: expression.eyes, mouth: expression.mouth }
            : null,
        );
      };

      const enterCalcMode = () => {
        setMenu(null);
        closePhotoMode();
        // Work mode and calc mode are both "parked at a tool"; only one at a time.
        if (quickToolsRef.current || workModeArmed) exitWorkMode();
        if (current.catOff) {
          // Land the cat first, or the bolt hits it mid-fall from screen top.
          setCatOff(false);
          const t = setTimeout(strikeIntoCalcMode, 950);
          cleanup.push(() => clearTimeout(t));
          return;
        }
        strikeIntoCalcMode();
      };

      const enterWorkMode = () => {
        setMenu(null);
        closePhotoMode();
        if (calcTimeRef.current || calcModeArmed) exitCalcMode();
        if (current.catOff) {
          // Land the cat first, or the bolt hits it mid-fall from the top of screen.
          setCatOff(false);
          const t = setTimeout(strikeIntoWorkMode, 950);
          cleanup.push(() => clearTimeout(t));
          return;
        }
        strikeIntoWorkMode();
      };


      // ---- command handling (tray + context menu share this) ----
      const command = (cmd: string) => {
        switch (cmd) {
          case "cat-off":
            setCatOff(true);
            return;
          case "cat-on":
            setCatOff(false);
            return;
          case "settings":
            if (current.catOff) setCatOff(false);
            setSettingsForeground(true);
            setPanelOpen(true);
            return;
          case "set-reminder":
            setMenu(null);
            setReminderPanelOpen(true);
            return;
          case "add-note":
            setMenu(null);
            setNotePanelOpen(true);
            return;
          case "focus-mode":
            setMenu(null);
            setBreakPickerOpen(false);
            // Either direction starts a clean guard: a new session must not
            // inherit the app the previous one was watching.
            focusApp = null;
            if (sessionRef.current?.kind === "focus") {
              setSession(null); // toggle off
            } else {
              if (quickToolsRef.current || workModeArmed) exitWorkMode();
              setSession(startFocus(Date.now()));
              engine.playOneShot("happy");
            }
            return;
          case "break":
            setMenu(null);
            if (sessionRef.current?.kind === "break") {
              setSession(null); // "End break"
            } else {
              // Open the duration picker; the pick handler starts the session.
              setBreakPickerOpen(true);
            }
            return;
          case "tasks":
            // Coming soon — the menu item is inert, nothing to do.
            return;
          case "calc-time":
            if (calcTimeRef.current || calcModeArmed) exitCalcMode();
            else enterCalcMode();
            return;
          case "photo-mode":
            // Toggle, like the other panels: the same menu entry closes it.
            if (photoModeRef.current) closePhotoMode();
            else openPhotoMode();
            return;
          case "work-mode":
            // Toggle: the menu offers "Exit work mode" while it is on.
            if (quickToolsRef.current || workModeArmed) exitWorkMode();
            else enterWorkMode();
            return;
          case "clipboard-assistant":
            if (clipboardPanelRef.current) {
              clipboardController.close(current.clipboardAssistant.forgetAfterSeconds);
              setClipboardPanel(null);
              if (!clipboardController.session.snapshot) setClipboardSession(null);
            } else {
              void openClipboardAssistant();
            }
            return;
          case "quit":
            void invokeSafe("quit_app");
            return;
          case "about":
            showInfoBubble("MewMuze — a tiny local cat. No network, no tracking. 🐈‍⬛");
            return;
          case "explain":
            // Privacy-safe: describes only the foreground app NAME + category.
            showInfoBubble(describeContext(foregroundExe, appCategory, mediaPlaying));
            engine.playOneShot("think");
            return;
          case "pomodoro-start": {
            if (pomodoro.currentPhase === "idle") pomodoro.start(performance.now() / 1000);
            return;
          }
          case "pomodoro-stop": {
            pomodoro.reset();
            setPomoSnap({ phase: "idle", remaining: 0, cycle: 0, completed: null });
            return;
          }
          case "toggle-peek":
            applySettings({ ...current, peekManual: !current.peekManual }, current);
            return;
          case "pomodoro-toggle": {
            const nowS = performance.now() / 1000;
            if (pomodoro.currentPhase === "idle") {
              pomodoro.start(nowS);
              showInfoBubble(`Focus time${current.userName ? ", " + current.userName : ""}! 🍅`);
            } else {
              pomodoro.reset();
              setPomoSnap({ phase: "idle", remaining: 0, cycle: 0, completed: null });
            }
            return;
          }
          case "pause":
          case "resume":
            engine.command(cmd as "pause" | "resume", performance.now());
            applySettings({ ...current, paused: cmd === "pause" }, current);
            return;
          case "pet":
          case "call":
          case "sleep":
          case "reset":
            engine.command(cmd as "pet" | "call" | "sleep" | "reset", performance.now());
            return;
          case "toggle-chase":
            applySettings({ ...current, cursorChasing: !current.cursorChasing }, current);
            return;
          case "toggle-sound": {
            const enabled = !current.soundEnabled;
            applySettings({ ...current, soundEnabled: enabled, masterMuted: !enabled }, current);
            return;
          }
          case "toggle-startup":
            applySettings({ ...current, startWithWindows: !current.startWithWindows }, current);
            return;
          default:
            if (cmd.startsWith("activity-")) {
              applySettings({ ...current, activityLevel: cmd.slice(9) as Settings["activityLevel"] }, current);
            } else if (cmd.startsWith("size-")) {
              applySettings({ ...current, catSize: cmd.slice(5) as Settings["catSize"] }, current);
            }
        }
      };

      /** Update the scheduled-reminder list and persist in one step. */
      const setScheduled = (next: Settings["scheduledReminders"]) => {
        applySettings({ ...current, scheduledReminders: next }, current);
      };

      bridgeRef.current = {
        command,
        updateSettings: (next) => applySettings(next, current),
        dismissBubble: () => {
          const b = bubbleRef.current;
          if (!b) return;
          if (b.id === "workrest") {
            activeUseS = 0;
            workRestShown = false;
          } else if (b.id.startsWith("sch:")) {
            setScheduled(completeScheduled(current.scheduledReminders, b.id.slice(4)));
          } else if (b.id.startsWith("cal:")) {
            // Remember this event so the same alert doesn't reappear.
            dismissedCalKey = b.id.slice(4);
          } else if (!b.id.startsWith("info-")) {
            reminders.dismiss(b.id, performance.now() / 1000);
          }
          setBubble(null);
        },
        snoozeBubble: () => {
          const b = bubbleRef.current;
          if (!b) return;
          if (b.id === "workrest") {
            // Ask again in ~5 minutes of further active use.
            activeUseS = Math.max(0, current.workRest.intervalMin * 60 - 300);
            workRestShown = false;
          } else if (b.id.startsWith("sch:")) {
            setScheduled(snoozeScheduled(current.scheduledReminders, b.id.slice(4), Math.floor(Date.now() / 1000)));
          } else if (b.id.startsWith("cal:")) {
            // Snooze a calendar alert for ~5 minutes.
            dismissedCalKey = b.id.slice(4);
            window.setTimeout(() => {
              if (dismissedCalKey === b.id.slice(4)) dismissedCalKey = "";
            }, 5 * 60_000);
          } else if (!b.id.startsWith("info-")) {
            reminders.snooze(b.id, performance.now() / 1000);
          }
          setBubble(null);
        },
        completeBubble: () => {
          const b = bubbleRef.current;
          if (!b) return;
          if (b.id.startsWith("sch:")) {
            setScheduled(completeScheduled(current.scheduledReminders, b.id.slice(4)));
            engine.playOneShot("celebrate");
          }
          setBubble(null);
        },
        openMail: (uid) => {
          const item = mailItemsRef.current.find((m) => m.uid === uid);
          if (!item) return;
          // Deep-links straight to the message when the header gave us a usable
          // Message-ID, otherwise the inbox. Reuses the existing vetted link
          // opener — no new permission, no Gmail API, no OAuth.
          void openClipboardLink(gmailMessageUrl(item.messageId));
          setMailItems((prev) => removeMail(prev, uid));
        },
        dismissMail: (uid) => setMailItems((prev) => removeMail(prev, uid)),
        applyLicense: applyLicenseKey,
        deactivateLicense,
        completeRemoval,
        startTrial,
        checkUpdates: () => void runUpdateCheck(true),
        copyClipboard: async (text) => {
          clipboardController.markOwnWrite(text, Date.now());
          await writeClipboardText(text);
          const snapshot = clipboardController.session.setResult(text);
          if (snapshot) setClipboardSession(snapshot);
        },
        clearClipboard: async () => {
          await clearClipboard();
          clearClipboardTimers();
          clipboardController.clear();
          setClipboardSession(null);
          setClipboardBadge(null);
          setClipboardPanel(null);
        },
        closeClipboard: () => {
          setClipboardPanel(null);
          clipboardController.close(current.clipboardAssistant.forgetAfterSeconds);
          if (!clipboardController.session.snapshot) setClipboardSession(null);
        },
        openClipboardLink,
        reactClipboard,
        holdPhotoPose,
      };

      // Validate only after the UI and cat are already running, then once per
      // day while MewMuze remains open. Temporary outages use the protected
      // record's 30-day grace period and never erase customer settings.
      const silentLicenseCheck = async () => {
        // Advance the trial watermark on the same schedule. A session left open
        // for days would otherwise judge the trial against the timestamp taken
        // at launch, and the vault copy would never learn time had passed.
        await refreshTrialAnchor();
        if (license.source !== "dodo") {
          regate();
          return;
        }
        await refreshLicense(current.licenseKey);
        regate();
      };
      const initialLicenceCheck = setTimeout(() => void silentLicenseCheck(), 12_000);
      const periodicLicenceCheck = setInterval(() => void silentLicenseCheck(), 24 * 60 * 60_000);
      cleanup.push(() => clearTimeout(initialLicenceCheck));
      cleanup.push(() => clearInterval(periodicLicenceCheck));

      /**
       * Look for a newer release. `manual` reports "you're up to date" too;
       * the automatic launch check stays silent unless something is available.
       */
      const runUpdateCheck = async (manual: boolean) => {
        setUpdateStatus("Checking for updates…");
        const info = await checkForUpdate();
        if (info.error) {
          setUpdateStatus(manual ? `Couldn't check for updates: ${info.error}` : "");
          return;
        }
        if (!info.available) {
          setUpdateStatus(manual ? "You're on the latest version." : "");
          return;
        }
        setUpdateStatus(`Downloading v${info.version}…`);
        const ok = await installUpdate((f) => setUpdateStatus(`Downloading v${info.version}… ${Math.round(f * 100)}%`));
        setUpdateStatus(ok ? "Restarting…" : "Update failed — try again later.");
      };
      // Silent check shortly after launch so fixes arrive without nagging.
      if (current.autoUpdate) {
        const t = setTimeout(() => void runUpdateCheck(false), 8000);
        cleanup.push(() => clearTimeout(t));
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un = await listen<string>("tray-command", (ev) => command(ev.payload));
        cleanup.push(() => un());
      } catch {
        /* no tray events outside Tauri */
      }

      try {
        const un = await listenForClipboardText((event) => {
          void acceptClipboardEvent(event);
        });
        cleanup.push(() => un());
      } catch {
        /* native clipboard events are unavailable in the browser preview */
      }


      // ---- Gmail connector: poll the inbox, stack newly arrived mail --------
      // On its own timer rather than inside the render loop, because that loop
      // stops doing work entirely while the overlay is withdrawn behind a
      // full-screen app — and mail must keep arriving and queueing there, so
      // the whole batch is waiting when the user comes back rather than being
      // silently missed. Nothing is drawn from here; it only fills the stack.
      const pollMailOnce = () => {
        if (!current.gmail.connected || !current.gmail.email || !current.gmail.appPassword) {
          lastGmailUid = 0; // reset baseline so a reconnect doesn't burst
          if (mailItemsRef.current.length > 0) setMailItems([]);
          return;
        }
        if (gmailPolling) return;
        gmailPolling = true;
        void pollGmail(current.gmail.email, current.gmail.appPassword).then((st) => {
          gmailPolling = false;
          if (!st || !st.ok) return;
          if (lastGmailUid === 0) {
            lastGmailUid = st.latestUid; // first poll = baseline, never notifies
            return;
          }
          const fresh = newMessages(lastGmailUid, st);
          if (fresh.length === 0) return;
          // Advance the baseline whether or not the notification is wanted, so
          // turning notifications back on doesn't replay old mail.
          lastGmailUid = Math.max(lastGmailUid, st.latestUid);
          if (!current.gmail.notify) return;
          setMailItems((prev) => addMail(prev, fresh));
          // Only react where the reaction can actually be seen.
          if (!isWithdrawn(fsState) && !fullscreenActive && !current.catOff) {
            engine.playOneShot("wave");
            sound.play("meow");
          }
        });
      };
      pollMailOnce(); // establish the baseline now, not a minute from now
      const gmailTimer = setInterval(pollMailOnce, GMAIL_POLL_MS);
      cleanup.push(() => clearInterval(gmailTimer));

      // ---- main loop ----
      let last = performance.now();
      let prevAnim = engine.state.currentAnimation;
      let lastThrough: boolean | null = null;
      let frame = 0;
      let lastPaint = 0;
      // Cached layout rects for the floating UI (see the click-through block).
      const uiRects: DOMRect[] = [];
      let uiRectsAt = 0;

      // Rate-limited logging so a persistent per-frame error can never flood
      // the console (which itself becomes a memory/perf problem over hours).
      let loopErrAt = 0;
      const loop = (t: number) => {
        if (disposed) return;
        // Reschedule FIRST: a throw in the body must never stop the loop, so the
        // cat degrades to a stutter rather than freezing dead — the app stays
        // alive and self-heals on the next good frame.
        raf = requestAnimationFrame(loop);
        try {
          loopBody(t);
        } catch (err) {
          if (t - loopErrAt > 5000) {
            loopErrAt = t;
            console.error("render loop frame failed (continuing)", err);
          }
        }
      };
      const loopBody = (t: number) => {
        // A true full-screen app (video, game, presentation) gets the screen to
        // itself: the cat waves, withdraws and the overlay window is hidden
        // outright — no sliver of sprite, no peek pose, no interactive region.
        // Gated on peekAuto, which is exactly the "get out of the way when
        // something is full screen" preference, so anyone who turned it off
        // keeps the cat they asked for. Cat Off owns visibility on its own.
        const fsHide = current.peekAuto && fullscreenActive && !current.catOff;
        // Manual peek is untouched by any of this.
        const peeking = current.peekManual;
        const anim0 = engine.state.currentAnimation;
        const sleeping = anim0 === "sleep";
        // Everything visible runs at the display's full rate: the cat is on
        // screen next to smoothly-animating apps, and anything less reads as
        // stutter. This is affordable because a frame is now just a cached
        // sprite blit into a small dirty rect. Only genuinely invisible or
        // fully-dormant states are throttled.
        const interval =
          (current.catOff && windowHidden) || isWithdrawn(fsState)
            ? 500 // hidden in the tray or behind a full-screen app: effectively idle
            : peeking
              ? 1000 / 20 // peeking out from behind a fullscreen app
              : sleeping
                ? 1000 / 30 // asleep: only slow breathing and a drifting tail
                : 1000 / 60; // cap high-refresh displays without reducing active smoothness
        const elapsed = t - last;
        if (elapsed + 1.5 < interval) return;
        last = t;
        const dt = elapsed / 1000;
        const now = t;
        const nowS = now / 1000;
        frame++;

        // Only judge the machine on frames we actually intended to run flat out;
        // a throttled peek/sleep frame is slow by design, not by weakness. When
        // the level changes, also resize the sprite cache — a weak machine both
        // renders fewer distinct poses and needs the memory back.
        if (interval === 0) {
          const level = budget.sample(elapsed, now);
          if (level !== appliedQuality) {
            appliedQuality = level;
            setQualityLevel(level);
            setSpriteCacheLimit(QUALITY_CACHE_LIMIT[level]);
          }
        }

        // An interval reminder that had already surfaced used to sit there
        // through the whole film: `due()` kept handing back the active one, and
        // nothing ever took it off screen. Retire the notice on the way in and
        // leave the scheduler's active reminder untouched, so it comes straight
        // back when full screen ends instead of being lost. Only this app's own
        // interval reminders are touched; scheduled and calendar alerts own
        // their own re-surfacing, and info bubbles are user-triggered.
        if (fullscreenActive !== noticesSawFullscreen) {
          noticesSawFullscreen = fullscreenActive;
          if (fullscreenActive) {
            const b = bubbleRef.current;
            if (b && reminders.activeId !== null && b.id === reminders.activeId) setBubble(null);
          }
        }

        // ---- full-screen retreat / return ----------------------------------
        const fsStep = stepFullscreen(fsState, { hide: fsHide, now, faded: windowHidden });
        fsState = fsStep.state;
        switch (fsStep.effect) {
          case "retreat":
            // Remember the spot to come back to BEFORE moving, via the engine's
            // own safe position so an edge-peeking cat doesn't record a centre
            // that sits off-screen.
            fsReturnPos = engine.getSafePosition();
            engine.setLoopOverride(null);
            engine.playOneShot("wave"); // the existing goodbye, same as Cat Off
            setMenu(null);
            // The cat is about to walk off screen and the window is about to be
            // hidden; there is nothing left to photograph.
            closePhotoMode();
            break;
          case "fadeOut":
            vis.target = 0;
            break;
          case "hidden":
            setOverlayHidden(true);
            break;
          case "restore":
            // Cat Off may have taken over while we were away, in which case
            // visibility is not ours to restore.
            setOverlayHidden(false);
            if (!current.catOff) {
              windowHidden = false;
              void invokeSafe("set_cat_visible", { visible: true });
              if (fsReturnPos) engine.enterAt(fsReturnPos.x, fsReturnPos.y);
              else engine.enterFromTop();
              vis.target = 1;
            }
            fsReturnPos = null;
            break;
          case "abort":
            // Full screen ended before the cat finished leaving: stay put.
            vis.target = current.catOff ? 0 : 1;
            fsReturnPos = null;
            break;
          case "none":
            break;
        }

        // Visibility transition (Cat Off exit / Cat On entrance).
        if (exitAt > 0 && now >= exitAt) {
          vis.target = 0;
          exitAt = 0;
        }
        vis.v += (vis.target - vis.v) * Math.min(1, dt * 6);
        if (vis.target === 0 && vis.v < 0.03 && !windowHidden) {
          windowHidden = true;
          rendererRef.current?.draw(null, worldW, worldH);
          clearSpriteCache();
          void invokeSafe("set_cat_visible", { visible: false });
          void setClickThrough(true);
          lastThrough = true;
        }
        if (current.catOff && windowHidden) return; // fully off: near-zero work
        // Withdrawn behind a full-screen app. The window is hidden and
        // click-through, so there is nothing to draw, hit-test or animate — the
        // loop just idles at 500 ms until full screen ends.
        if (fsHide && windowHidden) return;

        const sample = tracker.getSample();
        const userIdle = resolveUserIdle(nativeIdleMs, tracker.idleSeconds(now));
        engine.setUserIdle(userIdle.idle, userIdle.idleSeconds);
        let overCat = false;
        // Reset per frame: without a cursor sample there is no petting, and a
        // stale true would keep resetting the sad timer forever.
        let petActiveThisFrame = false;
        if (sample) {
          overCat = engine.containsPoint(sample.x, sample.y);

          if (buttonDown) {
            const r = drag.onMove(sample.x, sample.y, now);
            if (r.startedDrag) engine.grabStart();
            if (drag.isDragging) engine.grabMove(sample.x, sample.y, sample.speed);
          }

          const petActive = current.pettingEnabled && petting.update(sample, overCat, drag.isDragging, now);
          engine.setPetting(petActive);
          petActiveThisFrame = petActive;
          if (petActive) sound.play("purr");

          // The cat always SEES the cursor (eyes and head keep tracking it);
          // only whether it may walk toward it is gated. Work mode parks it at
          // its laptop, but it still looks up at you.
          engine.setCursor(sample);
          engine.setCursorChasing(
            current.cursorChasing &&
              pomodoro.currentPhase !== "focus" &&
              !quickToolsRef.current &&
              !clipboardPanelRef.current &&
              // Same reason as the others: chasing the cursor while you are
              // typing into a panel walks the cat out from under it.
              !calcTimeRef.current &&
              // The engine already refuses to wander while a photo pose is
              // held; clearing this too keeps the intent in one obvious place.
              !photoModeRef.current,
          );
        }

        // Peek + loop-override resolution (agent > typing > scroll).
        engine.setPeek(peeking);
        const scrollActive = now - scrollLastAt < 700 && scrollAccum > 8;
        if (!scrollActive) scrollAccum = Math.max(0, scrollAccum - 40 * dt);

        // Sustained slow scrolling in a browser reads as "reading".
        if (appCategory === "browser" && scrollActive && scrollAccum < 220) {
          if (readingSince === 0) readingSince = now;
        } else if (!scrollActive) {
          readingSince = 0;
        }
        const reading = readingSince > 0 && now - readingSince > 2500;

        // Context resolver (priority: agent > dance > writing > typing > reading > scroll).
        const dancing = mediaPlaying && !peeking;
        // Performance finished: take a bow, then resume whatever it was doing.
        if (micWasActive && !micActive) engine.playOneShot("bow");
        micWasActive = micActive;

        // Outranks every other loop. workModeArmed flips at the strike, so the
        // cat is already suited up before the flash clears, not after.
        const toolsOpen = quickToolsRef.current !== null || workModeArmed;
        const calcOpen = calcTimeRef.current !== null || calcModeArmed;
        const clipboardOpen = clipboardPanelRef.current !== null;

        // Panic escalates ABOVE overheat: overheat is a short "you're typing
        // fast" reaction, panic is what happens if it just never stops.
        if (typingLevel !== "none") typingStreakS += dt;
        else typingStreakS = 0;
        const panicking = typingStreakS >= PANIC_AFTER_S;

        // Sad is the lowest-priority mood: it only surfaces when nothing else
        // is going on, so it never masks a reaction the user triggered.
        if (petActiveThisFrame) sinceLastPetS = 0;
        else sinceLastPetS += dt;
        const moping = sinceLastPetS >= SAD_AFTER_S;

        const celebrating = now < placardUntil;

        // Reminder-driven poses: the water reminder sits the cat at its bowl
        // lapping until dismissed; a DUE scheduled reminder puts on the cute
        // urgent dance (jumpy, concerned, never frightening).
        const activeBubble = bubbleRef.current;
        // Any due-now alert (scheduled reminder OR calendar event) → urgent dance.
        const schedDueActive = activeBubble?.variant === "due";
        // Any early warning → up on the hind legs clapping, "look at the clock!".
        const schedWarnActive = activeBubble?.variant === "warn";
        const drinkingActive = activeBubble?.id === "water";

        // Focus mode: the cat settles into a still front-facing sit and, every
        // 20–35 s, gives a small cheer so it feels present without distracting.
        const focusing = sessionRef.current?.kind === "focus";
        if (focusing) {
          if (focusCheerAt === 0) focusCheerAt = now + (20 + Math.random() * 15) * 1000;
          else if (now >= focusCheerAt) {
            engine.playOneShot(Math.random() < 0.5 ? "happy" : "cuteNod");
            focusCheerAt = now + (20 + Math.random() * 15) * 1000;
          }
        } else {
          focusCheerAt = 0;
        }

        const loopAnim: AnimationName | null = toolsOpen
          ? "quickTools"
          : calcOpen
            ? "calcTools"
            : focusing
            ? "sit"
            : celebrating
            ? "placard"
            : schedDueActive
              ? "panic"
              : schedWarnActive
                ? "alarmClap"
                : drinkingActive
                  ? "drinkWater"
                  : panicking
                  ? "panic"
                  : clipboardOpen
                    ? "clipboardHold"
                    : micActive
                    ? "sing"
                    : agentLoop ??
          (dancing
            ? "danceBop"
            : appCategory === "writing" && typingLevel !== "none"
              ? typingLevel === "overheat"
                ? "overheat"
                : "writeNotes"
              : typingLevel === "overheat"
                ? "overheat"
                : typingLevel === "typing"
                  ? "typeKeys"
                  : reading
                    ? "readBook"
                    : scrollActive
                      ? scrollDir < 0
                        ? "lookUp"
                        : "lookDown"
                      : moping
                        ? "sad"
                        : null);
        engine.setLoopOverride(loopAnim);

        // Accessory auto-switch: headphones while music plays and glasses while
        // coding or during motivation mode. The customer's chosen built-in
        // accessory returns as soon as the temporary reaction ends.
        const baseAccessory = effective.appearance.accessory;
        const wantedAccessory = toolsOpen
          ? ("sunglasses" as const) // part of the costume, not gated by licence
          : dancing && mediaPlaying
            ? ("headphones" as const)
            : appCategory === "coding" || motivationUntil > now
              ? ("glasses" as const)
              : baseAccessory;
        if (wantedAccessory !== appliedAccessory) {
          appliedAccessory = wantedAccessory;
          // `effective`, not `current`: an unlicensed cat must not get premium
          // breeds/patterns back through the runtime accessory swap.
          configureAppearance({ ...effective.appearance, accessory: wantedAccessory });
        }

        // Work-rest: count ACTIVE use only (input within the last minute, not
        // full-screen, not paused). Timer pauses whenever the user is away.
        const userActive = !userIdle.idle;
        if (userActive && !fullscreenActive && !current.paused && !current.catOff) activeUseS += dt;
        if (
          effective.workRest.enabled &&
          !workRestShown &&
          activeUseS >= effective.workRest.intervalMin * 60 &&
          !bubbleRef.current &&
          !fullscreenActive
        ) {
          workRestShown = true;
          const name = current.userName ? `${current.userName}, ` : "";
          // Single line, always: the retro notice never wraps.
          setBubble({ id: "workrest", message: `${name}take a short rest — stretch with me!`, snoozable: true });
          engine.playOneShot("stretch");
        }

        // Motivation mode: rare, cooldown-gated encouragement with glasses.
        if (
          effective.motivation &&
          now >= motivationNextAt &&
          activeUseS > 20 * 60 &&
          typingLevel !== "none" &&
          !bubbleRef.current &&
          !fullscreenActive
        ) {
          motivationNextAt = now + (45 + Math.random() * 45) * 60_000;
          motivationUntil = now + 12_000;
          const name = current.userName ? `${current.userName}, ` : "";
          setBubble({
            id: "info-motivation",
            message: `${name}${PLACARD_LINES[Math.floor(Math.random() * PLACARD_LINES.length)]}`,
            snoozable: false,
          });
          // Hold the placard up alongside the message rather than a quick nod.
          placardUntil = now + PLACARD_MS;
        }

        // Reminders + Pomodoro.
        const snap = pomodoro.tick(nowS);
        if (snap.completed) {
          const name = current.userName ? `${current.userName}, ` : "";
          if (snap.completed === "focus") {
            // Session finished: this is the milestone the placard is for.
            placardUntil = now + PLACARD_MS;
            showInfoBubble(`${name}focus done — take a break! ☕`);
            sound.play("meow");
          } else {
            engine.playOneShot("stretch");
            showInfoBubble(`${name}break over — back to it! 🍅`);
          }
        }
        if (frame % 15 === 0) setPomoSnap({ ...snap });

        // Scheduled (date/time) reminders: polled a couple of times a second.
        // A due reminder is allowed to replace any bubble except another
        // scheduled one; an early warning waits its turn politely.
        if (frame % 30 === 0) {
          const sched = activeScheduled(current.scheduledReminders, Math.floor(Date.now() / 1000), current.userName);
          if (sched && !fullscreenActive) {
            const key = `${sched.id}|${sched.phase}`;
            const b = bubbleRef.current;
            const canShow = !b || b.id === `sch:${sched.id}` || (sched.phase === "due" && !b.id.startsWith("sch:"));
            if (canShow && (key !== lastSchedKey || b?.message !== sched.message)) {
              setBubble({
                id: `sch:${sched.id}`,
                message: sched.message,
                snoozable: true,
                completable: true,
                variant: sched.phase === "due" ? "due" : "warn",
              });
              if (key !== lastSchedKey) {
                lastSchedKey = key;
                // Both phases are loop overrides (warn = alarm clap on the hind
                // legs, due = the urgent dance); a meow catches the ear.
                sound.play("meow");
              }
            }
          } else if (lastSchedKey) {
            // Nothing active any more (snoozed/completed elsewhere).
            lastSchedKey = "";
            const b = bubbleRef.current;
            if (b?.id.startsWith("sch:")) setBubble(null);
          }
        }

        if (!bubbleRef.current) {
          const due = reminders.due(nowS, fullscreenActive);
          if (due) {
            setBubble({ id: due.id, message: due.message, snoozable: true });
            engine.playOneShot(due.kind === "stretch" ? "stretch" : "happy");
            sound.play("meow");
          }
        }

        // ---- Google Calendar connector: poll the feed, warn before events ----
        if (current.calendar.connected && current.calendar.icsUrl) {
          if (!fullscreenActive && now >= nextCalAt && !calPolling) {
            calPolling = true;
            nextCalAt = now + CALENDAR_POLL_MS;
            void pollCalendar(current.calendar.icsUrl).then((res) => {
              calPolling = false;
              if (res && res.ok) calEvents = res.events;
            });
          }
          if (frame % 30 === 0 && current.calendar.notify && !fullscreenActive) {
            const alert = calendarAlert(calEvents, Date.now(), current.calendar.earlyWarnMin, current.userName);
            if (alert && alert.id !== dismissedCalKey) {
              const b = bubbleRef.current;
              const canShow =
                !b ||
                b.id === `cal:${alert.id}` ||
                (alert.phase === "due" && !b.id.startsWith("cal:") && !b.id.startsWith("sch:"));
              if (canShow && (alert.id !== lastCalAlertKey || b?.variant !== alert.phase || b?.message !== alert.message)) {
                lastCalAlertKey = alert.id;
                setBubble({ id: `cal:${alert.id}`, message: `📅 ${alert.message}`, snoozable: true, variant: alert.phase });
                sound.play("meow");
              }
            } else if (!alert && lastCalAlertKey) {
              lastCalAlertKey = "";
              const b = bubbleRef.current;
              if (b?.id.startsWith("cal:")) setBubble(null);
            }
          }
        } else {
          calEvents = [];
        }

        // Dynamic click-through: interactive over the cat, while dragging, when
        // a menu/panel is open, or when the cursor is over any overlay UI.
        let overUI = false;
        if (
          gateRef.current ||
          menuRef.current ||
          panelRef.current ||
          costumeInstallRef.current ||
          quickToolsRef.current ||
          reminderPanelRef.current ||
          notePanelRef.current ||
          breakPickerRef.current ||
          clipboardPanelRef.current ||
          // Every panel MUST be listed here. The overlay is click-through by
          // default, so a panel missing from this gate renders normally but
          // swallows nothing — every click passes through to the app behind it
          // and the panel looks frozen.
          calcTimeRef.current ||
          photoModeRef.current
        )
          overUI = true;
        else if (
          sample &&
          (
            bubbleRef.current ||
            mailItemsRef.current.length > 0 ||
            current.note.visible ||
            pomodoro.currentPhase !== "idle" ||
            sessionRef.current ||
            clipboardBadgeRef.current
          )
        ) {
          // querySelectorAll + getBoundingClientRect forces layout, so refresh
          // the rects a few times a second rather than on every frame; floating
          // UI doesn't move fast enough for the difference to be visible.
          if (now - uiRectsAt > 150) {
            uiRectsAt = now;
            uiRects.length = 0;
            for (const el of document.querySelectorAll<HTMLElement>(
              // .mail-card, not .mail-stack: the container's rect spans the
              // transparent gaps between cards, which must stay click-through.
              ".retro-notice,.mail-card,.cat-note,.pomo-chip,.session-timer,.break-picker,.clipboard-badge,.clipboard-panel",
            )) {
              uiRects.push(el.getBoundingClientRect());
            }
          }
          const { x: sx, y: sy } = cssScale();
          const cx = sample.x * sx;
          const cy = sample.y * sy;
          for (const r of uiRects) {
            if (cx >= r.left - 4 && cx <= r.right + 4 && cy >= r.top - 4 && cy <= r.bottom + 4) {
              overUI = true;
              break;
            }
          }
        } else if (uiRects.length) {
          uiRects.length = 0;
        }
        const interactive = overCat || drag.isDragging || overUI;
        const desiredThrough = !interactive;
        if (lastThrough === null || desiredThrough !== lastThrough) {
          lastThrough = desiredThrough;
          void setClickThrough(desiredThrough);
        }

        engine.tick(dt, now);

        // Sound cues on animation transitions.
        const anim = engine.state.currentAnimation;
        if (anim !== prevAnim) {
          if (anim === "land" || anim === "landSafe" || anim === "softLand" || anim === "hardLand") sound.play("land");
          else if (anim === "happy") sound.play("meow");
          else if (anim === "sleep") sound.play("sleep");
          prevAnim = anim;
        }

        const calmVisual =
          CALM_VISUAL_ANIMATIONS.has(anim) &&
          !engine.state.isDragging &&
          Math.abs(engine.state.velocityX) < 1 &&
          Math.abs(engine.state.velocityY) < 1;
        const paintInterval = calmVisual ? 1000 / 30 : 1000 / 60;
        if (now - lastPaint + 1.5 >= paintInterval) {
          lastPaint = now;
          rendererRef.current?.draw(engine.getRender(), worldW, worldH, vis.v);
        }

        // Anchor for bubbles/notes/chips (CSS px above the cat). Updated EVERY
        // frame the cat has actually moved, so an attached note rides along at
        // the full display rate instead of visibly stuttering behind a walking
        // cat. When nothing anchored is visible, no React state churn at all.
        const anchoredVisible =
          bubbleRef.current ||
          mailItemsRef.current.length > 0 ||
          current.note.visible ||
          pomodoro.currentPhase !== "idle" ||
          scrollActive ||
          sessionRef.current !== null ||
          breakPickerRef.current ||
          clipboardBadgeRef.current ||
          clipboardPanelRef.current;
        if (clipboardPanelRef.current && frame % 6 === 0) {
          const previous = clipboardPanelRef.current;
          const nextCat = catCssBox();
          const nextArea = catCssArea();
          const moved =
            Math.abs(previous.cat.x - nextCat.x) > 1 ||
            Math.abs(previous.cat.y - nextCat.y) > 1 ||
            Math.abs(previous.cat.width - nextCat.width) > 1 ||
            Math.abs(previous.cat.height - nextCat.height) > 1;
          const workAreaChanged =
            previous.area.left !== nextArea.left ||
            previous.area.top !== nextArea.top ||
            previous.area.right !== nextArea.right ||
            previous.area.bottom !== nextArea.bottom;
          if (moved || workAreaChanged) {
            setClipboardPanel({ cat: nextCat, area: nextArea });
          }
        }
        if (anchoredVisible) {
          const { x: cssScaleX, y: cssScaleY } = cssScale();
          const size = engine.getRender().sizePx * cssScaleY;
          const ax = engine.state.x * cssScaleX;
          const ay = engine.state.y * cssScaleY;
          if (Math.abs(ax - lastAnchor.x) > 0.4 || Math.abs(ay - lastAnchor.y) > 0.4 || size !== lastAnchor.size) {
            lastAnchor = { x: ax, y: ay, size };
            const area = catCssArea();
            setAnchor({ x: ax, y: ay, size, areaLeft: area.left, areaRight: area.right, areaTop: area.top });
          }
        }
        const paperTarget = scrollActive ? Math.round(scrollAccum / 6) : 0;
        if (paperTarget !== paperShown && frame % 3 === 0) {
          paperShown = paperTarget;
          setPaperLen(paperTarget);
        }
      };
      raf = requestAnimationFrame(loop);
      cleanup.push(() => cancelAnimationFrame(raf));
      cleanup.push(clearSpriteCache);

      // ---- periodic persistence of safe position ----
      const persistTimer = setInterval(() => {
        if (current.catOff) return;
        const pos = engine.getSafePosition();
        const mon = monitorAt(pos.x, pos.y, monitors, origin);
        current = {
          ...current,
          lastPosition: pos,
          lastMonitorIndex: mon ? Math.max(0, monitors.indexOf(mon)) : current.lastMonitorIndex,
        };
        void saveSettings(current);
      }, PERSIST_MS);
      cleanup.push(() => clearInterval(persistTimer));
    })().catch((err) => {
      // A throw anywhere in bootstrap leaves the overlay blank with no clue
      // why (the tray keeps working, so it looks like the cat "vanished").
      console.error("cat bootstrap failed", err);
    });

    return () => {
      disposed = true;
      // The bootstrap is async, so teardown can land before it has finished
      // registering everything. Draining the array as it grows (rather than
      // iterating a snapshot) ensures listeners and timers registered after
      // this point are still torn down — otherwise React StrictMode's
      // mount/unmount/remount leaves a second engine and duplicate global
      // listeners running forever.
      const drain = () => {
        while (cleanup.length) {
          const fn = cleanup.pop();
          try {
            fn?.();
          } catch {
            /* keep tearing the rest down */
          }
        }
      };
      drain();
      queueMicrotask(drain);
      setTimeout(drain, 0);
    };
  }, []);

  const bridge = bridgeRef.current;

  return (
    <>
      {/* The engine keeps ticking while gated; only the cat is withheld, so
          unlocking brings it straight back with no re-initialisation. */}
      <div style={gateBlocked ? { visibility: "hidden" } : undefined}>
        <Overlay rendererRef={rendererRef} />
      </div>
      {gateBlocked && bridge && (
        <LicenseGate
          trialStarted={settingsUI.firstRunUnix > 0}
          onApplyLicense={bridge.applyLicense}
          onStartTrial={bridge.startTrial}
          onBuy={() => void bridge.openClipboardLink("https://mewmuze.com/#pricing")}
          onHelp={() => void bridge.openClipboardLink("https://mewmuze.com/support/")}
          onQuit={() => bridge.command("quit")}
        />
      )}
      <CostumeInstallPanel onOpenChange={setCostumeInstallOpen} />
      {paperLen > 0 && <ScrollPaper x={anchor.x + anchor.size * 0.4} y={anchor.y - anchor.size * 0.28} length={paperLen} />}
      {settingsUI.note.visible && settingsUI.note.text && !bubble && (
        // The note steps aside whenever a notification is up and returns the
        // moment it's dealt with — the two never fight for the same spot.
        <CatNote
          text={settingsUI.note.text}
          catCx={anchor.x}
          catTop={anchor.y - anchor.size}
          areaLeft={anchor.areaLeft}
          areaRight={anchor.areaRight}
        />
      )}
      {pomoSnap.phase !== "idle" && <PomodoroChip snapshot={pomoSnap} x={anchor.x - anchor.size * 0.62} y={Math.max(6, anchor.y - anchor.size - 22)} />}
      {bubble && bridge && (
        <RetroNotice
          bubble={bubble}
          catCx={anchor.x}
          catTop={anchor.y - anchor.size}
          areaLeft={anchor.areaLeft}
          areaRight={anchor.areaRight}
          onDismiss={bridge.dismissBubble}
          onSnooze={bridge.snoozeBubble}
          onComplete={bridge.completeBubble}
        />
      )}
      {mailItems.length > 0 && !overlayHidden && bridge && (
        <MailStack
          items={visibleMail(mailItems, settingsUI.gmail.maxStack).map((m) => ({
            uid: m.uid,
            line: mailLine(m, settingsUI.userName),
          }))}
          limit={clampStackLimit(settingsUI.gmail.maxStack)}
          queued={queuedCount(mailItems, settingsUI.gmail.maxStack)}
          catCx={anchor.x}
          catTop={anchor.y - anchor.size}
          areaLeft={anchor.areaLeft}
          areaRight={anchor.areaRight}
          areaTop={anchor.areaTop}
          // Re-place above the anchored notice whenever it appears or changes.
          noticeKey={bubble ? `${bubble.id}|${bubble.message}` : ""}
          onOpen={bridge.openMail}
          onDismiss={bridge.dismissMail}
        />
      )}
      {session && (
        <SessionTimer
          session={session}
          catCx={anchor.x}
          catTop={anchor.y - anchor.size}
          areaLeft={anchor.areaLeft}
          areaRight={anchor.areaRight}
          onEnd={() => setSession(null)}
        />
      )}
      {breakPickerOpen && (
        <BreakPicker
          catCx={anchor.x}
          catTop={anchor.y - anchor.size}
          areaLeft={anchor.areaLeft}
          areaRight={anchor.areaRight}
          onPick={(minutes) => {
            setBreakPickerOpen(false);
            setSession(startBreak(minutes, Date.now()));
          }}
          onClose={() => setBreakPickerOpen(false)}
        />
      )}
      {strike && <ThunderStrike x={strike.x} y={strike.y} size={strike.size} />}
      {clipboardBadge && clipboardSession && bridge && !clipboardPanel && (
        <ClipboardBadge
          cat={clipboardBadge.cat}
          area={clipboardBadge.area}
          onOpen={() => bridge.command("clipboard-assistant")}
        />
      )}
      {clipboardPanel && clipboardSession && bridge && (
        <ClipboardPanel
          session={clipboardSession}
          cat={clipboardPanel.cat}
          area={clipboardPanel.area}
          maxPreviewLength={settingsUI.clipboardAssistant.maxPreviewLength}
          notificationVisible={bubble !== null}
          onCopy={bridge.copyClipboard}
          onClear={bridge.clearClipboard}
          onOpenLink={bridge.openClipboardLink}
          onReaction={bridge.reactClipboard}
          onClose={bridge.closeClipboard}
        />
      )}
      {calcTime && bridge && (
        <CalcTimePanel
          cat={calcTime.cat}
          area={calcTime.area}
          // Routed through the same command the menu uses, so closing from the
          // ✕, the menu and the tray all follow one path (and clear the strike).
          onClose={() => bridge.command("calc-time")}
          // Reuse the existing clipboard reaction animations rather than
          // introducing a parallel set for the same "worked / didn't" beats.
          onResult={(kind) => bridge.reactClipboard(kind === "copy" ? "success" : "error")}
        />
      )}
      {photoMode && bridge && (
        <PhotoModePanel
          cat={photoMode.cat}
          area={photoMode.area}
          theme={settingsUI.uiTheme}
          folder={settingsUI.photoFolder}
          onSelectionChange={bridge.holdPhotoPose}
          onFolderChange={(photoFolder) => bridge.updateSettings({ ...settingsUI, photoFolder })}
          // Routed through the same command the menu uses, so the close button,
          // the menu and the tray all shut it down one path.
          onClose={() => bridge.command("photo-mode")}
        />
      )}
      {quickTools && bridge && (
        <QuickToolsPanel
          cat={quickTools.cat}
          area={quickTools.area}
          onClose={() => bridge.command("work-mode")}
        />
      )}
      {menu && bridge && (
        <CatContextMenu
          state={menu}
          workMode={quickTools !== null}
          session={session}
          clipboardEnabled={settingsUI.clipboardAssistant.mode !== "off"}
          onCommand={(cmd: MenuCommand) => bridge.command(cmd)}
          onClose={() => setMenu(null)}
        />
      )}
      {notePanelOpen && bridge && (
        <NotePanel
          initial={settingsUI.note.visible ? settingsUI.note.text : ""}
          onSave={(text) => {
            bridge.updateSettings({ ...settingsUI, note: { text, visible: true } });
            setNotePanelOpen(false);
          }}
          onHide={() => {
            bridge.updateSettings({ ...settingsUI, note: { ...settingsUI.note, visible: false } });
            setNotePanelOpen(false);
          }}
          onClose={() => setNotePanelOpen(false)}
        />
      )}
      {reminderPanelOpen && bridge && (
        <ReminderPanel
          onSave={(r) => {
            const s = settingsUI;
            bridge.updateSettings({
              ...s,
              scheduledReminders: [...pruneScheduled(s.scheduledReminders, Math.floor(Date.now() / 1000)), r],
            });
            setReminderPanelOpen(false);
          }}
          onClose={() => setReminderPanelOpen(false)}
        />
      )}
      {panelOpen && bridge && (
        <SettingsPanel
          settings={settingsUI}
          license={licenseUI}
          updateStatus={updateStatus}
          onChange={(next) => bridge.updateSettings(next)}
          onClose={() => {
            setSettingsForeground(false);
            setPanelOpen(false);
          }}
          onResetPosition={() => bridge.command("reset")}
          onResetSettings={() => bridge.updateSettings(sanitizeSettings(null))}
          onQuit={() => bridge.command("quit")}
          onApplyLicense={bridge.applyLicense}
          onDeactivateLicense={bridge.deactivateLicense}
          onCompleteRemoval={bridge.completeRemoval}
          onCheckUpdates={bridge.checkUpdates}
          onOpenLink={bridge.openClipboardLink}
          onVisibilityChange={setSettingsForeground}
        />
      )}
    </>
  );
}
