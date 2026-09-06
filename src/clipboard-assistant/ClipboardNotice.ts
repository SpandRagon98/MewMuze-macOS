export const CLIPBOARD_BADGE_MS = 5_000;

export function scheduleClipboardBadgeDismiss(
  dismiss: () => void,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
): ReturnType<typeof setTimeout> {
  return schedule(dismiss, CLIPBOARD_BADGE_MS);
}
