import type { ActivityLevel, CatSize } from "../types/cat";
import type { CatAppearance } from "../animation/spriteLoader";
import type { ClipboardAssistantSettings } from "../clipboard-assistant/clipboardTypes";
import { MAIL_STACK_DEFAULT } from "../integrations/mailStack";

/**
 * Persisted, user-facing settings. Everything is local-only: no cursor history,
 * no keystrokes, nothing about which applications the user opens. The typing
 * and scroll features consume only aggregate activity counts.
 */

export interface PomodoroConfig {
  enabled: boolean;
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  cyclesBeforeLongBreak: number;
}

export interface ReminderConfig {
  enabled: boolean;
  intervalMin: number;
}

/** Gmail connector (IMAP + app password). Stored locally like every setting. */
export interface GmailConfig {
  connected: boolean;
  email: string;
  /** Google 16-char app password. Local-only, same store as the licence key. */
  appPassword: string;
  /** Show a notification when new mail arrives. */
  notify: boolean;
  /**
   * How many email notifications may be stacked above the cat at once (1–5).
   * Further arrivals queue and take a slot as the visible ones are dealt with.
   */
  maxStack: number;
}

/** Google Calendar connector (private iCal address). */
export interface CalendarConfig {
  connected: boolean;
  icsUrl: string;
  notify: boolean;
  /** Minutes of early warning before an event starts. */
  earlyWarnMin: number;
}

export interface CustomReminder {
  id: string;
  message: string;
  intervalMin: number;
  enabled: boolean;
}

/** A one-off date/time reminder set from the right-click "Set Reminder" panel. */
export interface ScheduledReminder {
  id: string;
  title: string;
  /** Due moment, unix seconds (local wall clock at creation). */
  dueUnix: number;
  /** Minutes of early warning (0 = none; typically 1/5/10/15). */
  earlyWarnMin: number;
  /** Hidden until this unix time after a snooze (0 = not snoozed). */
  snoozedUntil: number;
  /** Dismissed or marked complete; pruned on the next save. */
  done: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  masterMuted: boolean;
  activityLevel: ActivityLevel;
  catSize: CatSize;
  cursorChasing: boolean;
  startWithWindows: boolean;
  /** Index of the monitor the cat was last on (best-effort restore). */
  lastMonitorIndex: number;
  /** Last known safe position in overlay-local logical pixels. */
  lastPosition: { x: number; y: number } | null;
  paused: boolean;
  /** Cat Off: hidden entirely; app stays in the tray. */
  catOff: boolean;

  // Interaction toggles
  eyeTracking: boolean;
  dragStretch: boolean;
  keyboardReactions: boolean;
  scrollReactions: boolean;
  pettingEnabled: boolean;
  /** Automatically enter peek mode when a full-screen app is detected. */
  peekAuto: boolean;
  /** Manual peek override. */
  peekManual: boolean;
  /** Seconds without mouse or keyboard input before the cat yawns and dozes off. */
  drowsyAfterSec: number;

  // Productivity
  userName: string;
  note: { text: string; visible: boolean };
  stretchReminder: ReminderConfig;
  waterReminder: ReminderConfig;
  /** Active-computer-use rest reminder (counts activity, not wall time). */
  workRest: ReminderConfig;
  customReminders: CustomReminder[];
  /** One-off date/time reminders (Set Reminder panel). */
  scheduledReminders: ScheduledReminder[];
  pomodoro: PomodoroConfig;
  /** Occasional encouragement (glasses + nod + notebook message). */
  motivation: boolean;
  /** Local, event-driven clipboard helper. Copied content is never persisted. */
  clipboardAssistant: ClipboardAssistantSettings;

  // Context awareness (foreground app name + media playback state only)
  contextAwareness: boolean;
  musicReactions: boolean;

  // Connectors (opt-in, off by default; talk only to Gmail / Google Calendar)
  gmail: GmailConfig;
  calendar: CalendarConfig;

  // Appearance
  appearance: CatAppearance;
  /** Installed Store costume ID, or empty when the visual skin is disabled. */
  selectedCostumeId: string;
  /**
   * Chosen colour for costumes that offer one, as a hex string. Empty means
   * the costume's own default, which is what every existing settings.json
   * sanitises to.
   */
  costumeTint: string;
  /** Legacy setting retained for backwards-compatible persistence; always false. */
  seasonalCostumes: boolean;
  /** Completed version of the built-in costume-catalog migration. */
  costumeCatalogMigrationVersion: number;
  /** Cleared after the friendly migration message is shown once. */
  costumeMigrationNoticePending: boolean;
  /** Panel/menu theme: dark (default) or light (white with warm orange). */
  uiTheme: "dark" | "light";
  /**
   * Remembered Photo Mode save folder. Empty (the default, and what every
   * existing settings.json will sanitise to) means ask with the save dialog.
   */
  photoFolder: string;

  /**
   * Optional AI-agent status integration: absolute path to a small JSON file
   * (e.g. {"state":"thinking"}) that a local tool writes. Empty = disabled.
   * Nothing else is ever inspected.
   */
  agentStatusFile: string;

  /** Licence key pasted by the buyer (verified offline against a public key). */
  licenseKey: string;
  /** Unix seconds of first launch, used to measure the free trial. */
  firstRunUnix: number;
  /** Check for updates on launch (paid users expect silent fixes). */
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: false,
  masterMuted: true,
  activityLevel: "balanced",
  catSize: "medium", // Medium is the new default
  cursorChasing: true,
  startWithWindows: false,
  lastMonitorIndex: 0,
  lastPosition: null,
  paused: false,
  catOff: false,

  eyeTracking: true,
  dragStretch: false,
  keyboardReactions: true,
  scrollReactions: true,
  pettingEnabled: true,
  peekAuto: true,
  peekManual: false,
  drowsyAfterSec: 20,

  userName: "",
  note: { text: "", visible: false },
  stretchReminder: { enabled: false, intervalMin: 45 },
  waterReminder: { enabled: false, intervalMin: 60 },
  workRest: { enabled: true, intervalMin: 45 },
  customReminders: [],
  scheduledReminders: [],
  pomodoro: { enabled: false, focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLongBreak: 4 },
  motivation: true,
  clipboardAssistant: {
    mode: "badge",
    excludedApplications: ["1Password.exe", "Bitwarden.exe", "KeePass.exe", "KeePassXC.exe"],
    maxPreviewLength: 2_000,
    maxInputLength: 100_000,
    forgetAfterSeconds: 300,
    suppressSensitiveCodes: true,
  },

  contextAwareness: true,
  musicReactions: true,

  gmail: { connected: false, email: "", appPassword: "", notify: true, maxStack: MAIL_STACK_DEFAULT },
  calendar: { connected: false, icsUrl: "", notify: true, earlyWarnMin: 10 },

  appearance: {
    furColor: "#FAFAFA",
    eyeColor: "#76df31",
    earColor: "#e06e91",
    pattern: "solid",
    accessory: "none",
    species: "classic",
    eyelashes: false,
    stroke: false,
    strokeColor: "#ffffff",
  },
  selectedCostumeId: "",
  costumeTint: "",
  seasonalCostumes: false,
  costumeCatalogMigrationVersion: 1,
  costumeMigrationNoticePending: false,
  uiTheme: "dark",

  photoFolder: "",
  agentStatusFile: "",

  licenseKey: "",
  firstRunUnix: 0,
  autoUpdate: true,
};

/** Logical sprite size (px) for each cat-size option, before DPI scaling. */
export const SIZE_TO_LOGICAL_PX: Record<CatSize, number> = {
  small: 64,
  medium: 88,
  large: 108,
};

/**
 * Activity level tunes how energetic / cursor-driven the cat is. These
 * multipliers are consumed by the behaviour-weight system.
 */
export interface ActivityProfile {
  /** Scales the weight of high-energy playful behaviours. */
  playfulness: number;
  /** Scales how often the cat chooses to chase the cursor. */
  chaseEagerness: number;
  /** Scales the weight of restful behaviours. */
  restfulness: number;
}

export const ACTIVITY_PROFILES: Record<ActivityLevel, ActivityProfile> = {
  calm: { playfulness: 0.4, chaseEagerness: 0.4, restfulness: 1.6 },
  balanced: { playfulness: 1.0, chaseEagerness: 1.0, restfulness: 1.0 },
  playful: { playfulness: 1.8, chaseEagerness: 1.7, restfulness: 0.6 },
};
