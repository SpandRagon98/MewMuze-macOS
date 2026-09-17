import type { ClipboardAssistantSettings, NativeClipboardEvent } from "./clipboardTypes";

export const DEFAULT_CLIPBOARD_EXCLUSIONS = [
  "1password.exe",
  "bitwarden.exe",
  "dashlane.exe",
  "keepass.exe",
  "keepassxc.exe",
  "lastpass.exe",
  // macOS reports the owning app's name, lower-cased.
  "1password",
  "1password 7",
  "bitwarden",
  "dashlane",
  "keepassxc",
  "lastpass",
  "keychain access",
  "passwords",
];

export type ClipboardRejectionReason =
  | "disabled"
  | "manual-only"
  | "empty"
  | "too-large"
  | "excluded"
  | "sensitive-code"
  | "locked"
  | "hidden"
  | "paused"
  | "fullscreen";

export interface ClipboardRuntimePrivacy {
  sessionLocked: boolean;
  hidden: boolean;
  paused: boolean;
  fullscreen: boolean;
}

export function normalizeApplicationName(value: string): string {
  return value.trim().replace(/^.*[\\/]/u, "").toLocaleLowerCase();
}

export function isExcludedApplication(sourceApp: string | null, exclusions: string[]): boolean {
  if (!sourceApp) return false;
  const source = normalizeApplicationName(sourceApp);
  return exclusions.some((entry) => normalizeApplicationName(entry) === source);
}

/**
 * Credentials that announce themselves through a well-known prefix or wrapper.
 *
 * Only unambiguous markers belong here: each one is issued by a specific
 * service and effectively never appears in ordinary prose, so matching it
 * cannot swallow text the user actually wanted help with.
 */
const SECRET_MARKERS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, // PEM private keys
  /\bsk-[A-Za-z0-9_-]{16,}/u, // OpenAI-style secret keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u, // GitHub fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/u, // AWS access key IDs
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/u, // Google API keys
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, // JWTs
];

/** The Luhn checksum every real payment card satisfies. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Does this look like something that should never be picked up and offered
 * back to the user?
 *
 * Deliberately broader than the one-time codes it started as: a card number or
 * an API key is exactly what someone would hate to find sitting in a companion
 * app's panel. Three families are recognised —
 *
 * 1. short one-time codes (the original behaviour),
 * 2. payment-card numbers, verified with Luhn so a plain 16-digit order
 *    reference is not mistaken for one,
 * 3. credentials carrying an unmistakable issuer prefix.
 *
 * A false positive is cheap here: the Clipboard Assistant simply ignores that
 * copy. The system clipboard itself is untouched, so nothing is ever lost.
 */
export function looksLikeSensitiveCode(text: string): boolean {
  const value = text.trim();
  if (!value) return false;

  // Issuer-marked credentials can appear anywhere in the text, including in a
  // longer snippet that was copied around them.
  if (value.length <= 4096 && SECRET_MARKERS.some((re) => re.test(value))) return true;

  // Card numbers are written with spaces or dashes far more often than not, so
  // the separators are stripped before testing rather than used to bail out.
  const compact = value.replace(/[\s-]/gu, "");
  if (/^\d{13,19}$/u.test(compact) && passesLuhn(compact)) return true;

  // The original one-time-code rules, unchanged, on the untouched text.
  if (/\s/u.test(value)) return false;
  return /^\d{4,8}$/u.test(value) || (/^[A-Z0-9]{6,8}$/u.test(value) && /\d/u.test(value));
}

export function rejectClipboardEvent(
  event: NativeClipboardEvent,
  settings: ClipboardAssistantSettings,
  runtime: ClipboardRuntimePrivacy,
  manual = false,
): ClipboardRejectionReason | null {
  if (settings.mode === "off") return "disabled";
  if (!manual && settings.mode === "manual") return "manual-only";
  if (!event.text.trim()) return "empty";
  if (event.text.length > settings.maxInputLength) return "too-large";
  if (isExcludedApplication(event.sourceApp, settings.excludedApplications)) return "excluded";
  if (settings.suppressSensitiveCodes && looksLikeSensitiveCode(event.text)) return "sensitive-code";
  if (runtime.sessionLocked) return "locked";
  if (runtime.hidden) return "hidden";
  if (runtime.paused) return "paused";
  if (runtime.fullscreen) return "fullscreen";
  return null;
}
