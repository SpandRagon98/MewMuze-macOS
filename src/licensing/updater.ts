/**
 * In-app updates via tauri-plugin-updater.
 *
 * Update manifests are signed with the seller's private key and verified
 * against the public key baked into tauri.conf.json, so a hijacked release
 * host still cannot push a malicious build.
 *
 * This is the ONLY component that contacts the network, and only to fetch the
 * release manifest — never any user data. It can be switched off entirely in
 * settings (`autoUpdate`).
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
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // No point sleeping after the final attempt.
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw last;
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

/**
 * Download + install the update found by `checkForUpdate`, reporting progress
 * 0..1, then relaunch. Resolves false if nothing was pending or it failed.
 */
export async function installUpdate(onProgress?: (fraction: number) => void): Promise<boolean> {
  const update = pending;
  if (!update) return false;
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
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return true;
  } catch {
    return false;
  }
}
