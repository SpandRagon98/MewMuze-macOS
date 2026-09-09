import { DEFAULT_SETTINGS, type Settings } from "./defaultSettings";
import type { CatAccessory, CatPattern } from "../animation/spriteLoader";
import { clampStackLimit } from "../integrations/mailStack";

/** The accessories bundled for direct user selection. */
const DEFAULT_ACCESSORIES: CatAccessory[] = [
  "none",
  "flowerCrown",
  "bandana",
  "sunglasses",
  "headphones",
  "glasses",
];
const COSTUME_CATALOG_MIGRATION_VERSION = 1;

/** Every coat pattern the sanitiser will accept from persisted settings. */
const PATTERNS: CatPattern[] = [
  "solid",
  "tuxedo",
  "tabby",
  "socks",
  "spotted",
  "calico",
  "bicolour",
];

export type { Settings } from "./defaultSettings";

/**
 * Thin persistence layer over the Rust `load_settings` / `save_settings`
 * commands. Kept dependency-light and defensive so it also works in a plain
 * browser / test context (where Tauri is absent) by falling back to memory.
 *
 * `sanitizeSettings` is exported and pure so persistence can be unit-tested
 * without any Tauri runtime.
 */

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
function str(v: unknown, fallback: string, maxLen = 200): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}
function hexColor(v: unknown, fallback: string): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

/** Merge unknown persisted data onto defaults, dropping anything invalid. */
export function sanitizeSettings(raw: unknown): Settings {
  const s: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;

  s.soundEnabled = bool(r.soundEnabled, s.soundEnabled);
  s.masterMuted = bool(r.masterMuted, s.masterMuted);
  if (r.activityLevel === "calm" || r.activityLevel === "balanced" || r.activityLevel === "playful")
    s.activityLevel = r.activityLevel;
  // Sizes are now small/medium/large; migrate legacy "tiny" to small.
  if (r.catSize === "small" || r.catSize === "medium" || r.catSize === "large") s.catSize = r.catSize;
  else if (r.catSize === "tiny") s.catSize = "small";
  s.cursorChasing = bool(r.cursorChasing, s.cursorChasing);
  s.startWithWindows = bool(r.startWithWindows, s.startWithWindows);
  s.lastMonitorIndex = Math.floor(num(r.lastMonitorIndex, s.lastMonitorIndex, 0, 64));
  s.paused = bool(r.paused, s.paused);
  s.catOff = bool(r.catOff, s.catOff);

  s.eyeTracking = bool(r.eyeTracking, s.eyeTracking);
  s.dragStretch = bool(r.dragStretch, s.dragStretch);
  s.keyboardReactions = bool(r.keyboardReactions, s.keyboardReactions);
  s.scrollReactions = bool(r.scrollReactions, s.scrollReactions);
  s.pettingEnabled = bool(r.pettingEnabled, s.pettingEnabled);
  s.peekAuto = bool(r.peekAuto, s.peekAuto);
  s.peekManual = bool(r.peekManual, s.peekManual);
  s.drowsyAfterSec = num(r.drowsyAfterSec, s.drowsyAfterSec, 5, 3600);

  s.userName = str(r.userName, s.userName, 40);
  const note = r.note as Record<string, unknown> | undefined;
  if (note && typeof note === "object") {
    s.note = { text: str(note.text, "", 280), visible: bool(note.visible, false) };
  }
  const stretch = r.stretchReminder as Record<string, unknown> | undefined;
  if (stretch && typeof stretch === "object") {
    s.stretchReminder = { enabled: bool(stretch.enabled, false), intervalMin: num(stretch.intervalMin, 45, 5, 480) };
  }
  const water = r.waterReminder as Record<string, unknown> | undefined;
  if (water && typeof water === "object") {
    s.waterReminder = { enabled: bool(water.enabled, false), intervalMin: num(water.intervalMin, 60, 5, 480) };
  }
  const workRest = r.workRest as Record<string, unknown> | undefined;
  if (workRest && typeof workRest === "object") {
    s.workRest = { enabled: bool(workRest.enabled, true), intervalMin: num(workRest.intervalMin, 45, 10, 240) };
  }
  s.motivation = bool(r.motivation, s.motivation);
  const clipboard = r.clipboardAssistant as Record<string, unknown> | undefined;
  if (clipboard && typeof clipboard === "object") {
    if (clipboard.mode === "off" || clipboard.mode === "manual" || clipboard.mode === "badge") {
      s.clipboardAssistant.mode = clipboard.mode;
    }
    if (Array.isArray(clipboard.excludedApplications)) {
      s.clipboardAssistant.excludedApplications = clipboard.excludedApplications
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 32);
    }
    s.clipboardAssistant.maxPreviewLength = Math.floor(
      num(clipboard.maxPreviewLength, s.clipboardAssistant.maxPreviewLength, 250, 10_000),
    );
    s.clipboardAssistant.maxInputLength = Math.floor(
      num(clipboard.maxInputLength, s.clipboardAssistant.maxInputLength, 1_000, 500_000),
    );
    if (
      clipboard.forgetAfterSeconds === 0 ||
      clipboard.forgetAfterSeconds === 60 ||
      clipboard.forgetAfterSeconds === 300 ||
      clipboard.forgetAfterSeconds === 900
    ) {
      s.clipboardAssistant.forgetAfterSeconds = clipboard.forgetAfterSeconds;
    }
    s.clipboardAssistant.suppressSensitiveCodes = bool(
      clipboard.suppressSensitiveCodes,
      s.clipboardAssistant.suppressSensitiveCodes,
    );
  }
  s.contextAwareness = bool(r.contextAwareness, s.contextAwareness);
  s.musicReactions = bool(r.musicReactions, s.musicReactions);
  const gmail = r.gmail as Record<string, unknown> | undefined;
  if (gmail && typeof gmail === "object") {
    s.gmail = {
      connected: bool(gmail.connected, false),
      email: str(gmail.email, "", 120),
      appPassword: str(gmail.appPassword, "", 100),
      notify: bool(gmail.notify, true),
      // clampStackLimit also rounds, so a hand-edited 3.7 or "4" lands on a
      // real slot count rather than producing a fractional stack.
      maxStack: clampStackLimit(gmail.maxStack ?? s.gmail.maxStack),
    };
  }
  const calendar = r.calendar as Record<string, unknown> | undefined;
  if (calendar && typeof calendar === "object") {
    s.calendar = {
      connected: bool(calendar.connected, false),
      icsUrl: str(calendar.icsUrl, "", 500),
      notify: bool(calendar.notify, true),
      earlyWarnMin: Math.floor(num(calendar.earlyWarnMin, 10, 0, 120)),
    };
  }
  if (Array.isArray(r.customReminders)) {
    s.customReminders = r.customReminders
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .slice(0, 12)
      .map((c, i) => ({
        id: str(c.id, `reminder-${i}`, 40),
        message: str(c.message, "", 200),
        intervalMin: num(c.intervalMin, 60, 1, 24 * 60),
        enabled: bool(c.enabled, true),
      }))
      .filter((c) => c.message.length > 0);
  }
  if (Array.isArray(r.scheduledReminders)) {
    s.scheduledReminders = r.scheduledReminders
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .slice(0, 32)
      .map((c, i) => ({
        id: str(c.id, `sch-${i}`, 60),
        title: str(c.title, "", 60),
        dueUnix: Math.floor(num(c.dueUnix, 0, 0, Number.MAX_SAFE_INTEGER)),
        earlyWarnMin: Math.floor(num(c.earlyWarnMin, 0, 0, 120)),
        snoozedUntil: Math.floor(num(c.snoozedUntil, 0, 0, Number.MAX_SAFE_INTEGER)),
        done: bool(c.done, false),
      }))
      .filter((c) => c.title.length > 0 && c.dueUnix > 0);
  }
  const pomo = r.pomodoro as Record<string, unknown> | undefined;
  if (pomo && typeof pomo === "object") {
    s.pomodoro = {
      enabled: bool(pomo.enabled, false),
      focusMin: num(pomo.focusMin, 25, 5, 120),
      shortBreakMin: num(pomo.shortBreakMin, 5, 1, 60),
      longBreakMin: num(pomo.longBreakMin, 15, 1, 90),
      cyclesBeforeLongBreak: Math.floor(num(pomo.cyclesBeforeLongBreak, 4, 1, 12)),
    };
  }
  const app = r.appearance as Record<string, unknown> | undefined;
  if (app && typeof app === "object") {
    const storedAccessory = app.accessory as CatAccessory;
    const keptAccessory = DEFAULT_ACCESSORIES.includes(storedAccessory)
      ? storedAccessory
      : s.appearance.accessory;
    s.appearance = {
      furColor: hexColor(app.furColor, s.appearance.furColor),
      eyeColor: hexColor(app.eyeColor, s.appearance.eyeColor),
      earColor: hexColor(app.earColor, s.appearance.earColor),
      species:
        app.species === "classic" ||
        app.species === "chonk" ||
        app.species === "fluffy" ||
        app.species === "siamese" ||
        app.species === "kitten"
          ? app.species
          : s.appearance.species,
      pattern: PATTERNS.includes(app.pattern as CatPattern)
        ? (app.pattern as CatPattern)
        : s.appearance.pattern,
      accessory: keptAccessory,
      eyelashes: bool(app.eyelashes, s.appearance.eyelashes),
      stroke: bool(app.stroke, s.appearance.stroke),
      strokeColor: hexColor(app.strokeColor, s.appearance.strokeColor),
    };
    const previousMigration = Math.floor(num(r.costumeCatalogMigrationVersion, 0, 0, 10_000));
    if (
      previousMigration < COSTUME_CATALOG_MIGRATION_VERSION &&
      typeof app.accessory === "string" &&
      !DEFAULT_ACCESSORIES.includes(storedAccessory)
    ) {
      s.costumeMigrationNoticePending = true;
    }
  }
  // Seasonal and paid-style built-ins were retired. Retain the legacy field in
  // persisted JSON so older builds can still read the file, but never enable it.
  s.seasonalCostumes = false;
  const selectedCostumeId = str(r.selectedCostumeId, "", 80);
  s.selectedCostumeId = /^[a-z0-9][a-z0-9.-]{2,79}$/.test(selectedCostumeId)
    ? selectedCostumeId
    : "";
  s.costumeCatalogMigrationVersion = COSTUME_CATALOG_MIGRATION_VERSION;
  s.costumeMigrationNoticePending =
    bool(r.costumeMigrationNoticePending, false) || s.costumeMigrationNoticePending;
  if (r.uiTheme === "dark" || r.uiTheme === "light") s.uiTheme = r.uiTheme;
  // Hex only, so a hand-edited settings.json cannot inject a colour string
  // that reaches a canvas fillStyle.
  const tint = str(r.costumeTint, "", 9);
  s.costumeTint = /^#[0-9a-f]{6}$/i.test(tint) ? tint : "";
  s.photoFolder = str(r.photoFolder, "", 500);
  s.agentStatusFile = str(r.agentStatusFile, "", 500);
  s.licenseKey = str(r.licenseKey, "", 400);
  s.autoUpdate = bool(r.autoUpdate, s.autoUpdate);
  // A first-run stamp in the future would grant an unlimited trial; clamp it.
  const firstRun = num(r.firstRunUnix, 0, 0, Number.MAX_SAFE_INTEGER);
  const nowUnix = Math.floor(Date.now() / 1000);
  s.firstRunUnix = firstRun > nowUnix ? nowUnix : firstRun;

  const pos = r.lastPosition;
  if (
    pos &&
    typeof pos === "object" &&
    typeof (pos as Record<string, unknown>).x === "number" &&
    typeof (pos as Record<string, unknown>).y === "number" &&
    Number.isFinite((pos as { x: number }).x) &&
    Number.isFinite((pos as { y: number }).y)
  ) {
    s.lastPosition = { x: (pos as { x: number }).x, y: (pos as { y: number }).y };
  }
  return s;
}

async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    // Import lazily so tests / non-Tauri contexts don't need the runtime.
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

let memoryCache: Settings = { ...DEFAULT_SETTINGS };

export async function loadSettings(): Promise<Settings> {
  const raw = await invokeSafe<unknown>("load_settings");
  memoryCache = sanitizeSettings(raw ?? memoryCache);
  return { ...memoryCache };
}

/** Debounced-ish save; callers can await for confirmation if they need it. */
export async function saveSettings(settings: Settings): Promise<void> {
  memoryCache = { ...settings };
  await invokeSafe<void>("save_settings", { settings });
}

export function getCachedSettings(): Settings {
  return { ...memoryCache };
}
