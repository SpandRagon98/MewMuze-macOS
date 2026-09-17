/**
 * In-app updates via tauri-plugin-updater.
 *
 * Update manifests are signed with the seller's private key and verified
 * against the public key baked into tauri.conf.json, so a hijacked release
 * host still cannot push a malicious build.
 *
 * It fetches the release manifest only - never any user data. The automatic
 * check can be switched off in settings (`autoUpdate`); when it finds a new
 * version it only OFFERS it (a small notice by the cat). Installing happens
 * when the user says so: the notice's Update button, or Check for updates.
 */

export interface UpdateInfo {
  available: boolean;
  version: string;
  notes: string;
  error?: string;
}

type TauriUpdate = {
  version: string;
  body?: string;
  downloadAndInstall: (cb?: (p: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};

let pending: TauriUpdate | null = null;

/**
 * Retry a flaky network call, backing off a little each time.
 *
 * mewmuze.com sits behind a CDN that intermittently drops a TLS handshake
 * mid-request, so a single attempt fails often enough that people were
 * clicking "Check now" repeatedly to get an update that was there all along.
 * Retrying here is what that clicking was doing by hand.
 *
 * Exported for the test: the loop is small but a mistake in it either kills
 * retries silently or spins forever.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 1200,
  /** Some failures are final (a bad signature stays bad): don't repeat those. */
  retryIf: (e: unknown) => boolean = () => true,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!retryIf(e)) break;
      // No point sleeping after the final attempt.
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw last;
}

// ---- the "new version" notice ----

/** How often the automatic check runs while the app stays open. */
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;
/** "OK" on the notice quiets that version for this long, then it may ask once more. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60_000;
const DISMISSED_KEY = "mewmuze.update.dismissed";

export interface Dismissed {
  version: string;
  at: number;
}

/** Offer `version`, unless that same version was waved off recently. A newer one always asks. */
export function shouldNotify(version: string, dismissed: Dismissed | null, now: number): boolean {
  return !dismissed || dismissed.version !== version || now - dismissed.at >= UPDATE_SNOOZE_MS;
}

export function loadDismissed(): Dismissed | null {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "null") as Partial<Dismissed> | null;
    return v && typeof v.version === "string" && typeof v.at === "number" ? { version: v.version, at: v.at } : null;
  } catch {
    return null;
  }
}

export function saveDismissed(d: Dismissed): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(d));
  } catch {
    // Storage blocked: the notice may simply ask again next time.
  }
}

/** A plain sentence for Settings; the raw error is for logs, not people. */
export function friendlyUpdateError(raw: string): string {
  if (/sign|signature|verify/i.test(raw)) return "The update didn't pass its safety check, so it wasn't installed.";
  if (/network|connect|dns|timed? ?out|tls|request|fetch|status/i.test(raw)) return "Couldn't reach the update server. Check your connection and try again.";
  return "Couldn't check for updates right now. Try again later.";
}

/** Check the release endpoint. Returns `available: false` outside Tauri. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = (await withRetry(() => check())) as TauriUpdate | null;
    if (!update) return { available: false, version: "", notes: "" };
    pending = update;
    return { available: true, version: update.version, notes: update.body ?? "" };
  } catch (e) {
    return { available: false, version: "", notes: "", error: e instanceof Error ? e.message : String(e) };
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A download that fails its signature check will fail the same way every time. */
const isVerificationError = (e: unknown) => /sign|signature|verif/i.test(message(e));

/**
 * Download + install the update found by `checkForUpdate`, reporting progress
 * 0..1, then relaunch. Resolves null on success (the app restarts), otherwise
 * the reason it did not install.
 */
export async function installUpdate(onProgress?: (fraction: number) => void): Promise<string | null> {
  const update = pending;
  if (!update) return "no update is pending";
  try {
    // Retrying is safe here: a failure means the download did not complete, so
    // nothing was installed. Once the installer itself launches, Windows exits
    // the app, so there is no path where this retries a half-applied install.
    await withRetry(async () => {
      // Per attempt, not per call: a retry restarts the download at zero, and
      // carried-over counters would report a percentage above 100.
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((p) => {
        if (p.event === "Started") total = p.data?.contentLength ?? 0;
        else if (p.event === "Progress") {
          received += p.data?.chunkLength ?? 0;
          if (total > 0) onProgress?.(Math.min(1, received / total));
        } else if (p.event === "Finished") onProgress?.(1);
      });
    }, 3, 1200, (e) => !isVerificationError(e));
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return null;
  } catch (e) {
    return message(e);
  }
}
