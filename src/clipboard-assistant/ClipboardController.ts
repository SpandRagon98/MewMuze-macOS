import { rejectClipboardEvent, type ClipboardRuntimePrivacy, type ClipboardRejectionReason } from "./ClipboardPrivacy";
import { ClipboardSession } from "./ClipboardSession";
import type { ClipboardAssistantSettings, ClipboardSnapshot, NativeClipboardEvent } from "./clipboardTypes";

export interface ClipboardAcceptResult {
  accepted: boolean;
  showBadge: boolean;
  reason: ClipboardRejectionReason | "duplicate" | "self-write" | null;
  snapshot: ClipboardSnapshot | null;
}

export class ClipboardController {
  readonly session = new ClipboardSession();
  private ownWrite: string | null = null;
  private ownWriteUntil = 0;

  accept(
    event: NativeClipboardEvent,
    settings: ClipboardAssistantSettings,
    runtime: ClipboardRuntimePrivacy,
    now: number,
    manual = false,
  ): ClipboardAcceptResult {
    if (this.ownWrite !== null && now <= this.ownWriteUntil && event.text === this.ownWrite) {
      this.ownWrite = null;
      this.ownWriteUntil = 0;
      return { accepted: false, showBadge: false, reason: "self-write", snapshot: this.session.snapshot };
    }
    const rejected = rejectClipboardEvent(event, settings, runtime, manual);
    if (rejected) return { accepted: false, showBadge: false, reason: rejected, snapshot: this.session.snapshot };
    if (this.session.isDuplicate(event.text)) {
      return { accepted: false, showBadge: false, reason: "duplicate", snapshot: this.session.snapshot };
    }
    const snapshot = this.session.replace(event, now, settings.forgetAfterSeconds);
    return {
      accepted: true,
      showBadge: !manual && settings.mode === "badge",
      reason: null,
      snapshot,
    };
  }

  markOwnWrite(text: string, now: number): void {
    this.ownWrite = text;
    this.ownWriteUntil = now + 3000;
  }

  clearOwnWrite(): void {
    this.ownWrite = null;
    this.ownWriteUntil = 0;
  }

  close(_forgetAfterSeconds: number): void {
    // Closing a preview is an explicit privacy boundary. Timeout choices cover
    // unopened/current sessions; a closed panel never leaves copied text alive.
    this.session.clear();
  }

  expire(now: number): boolean {
    return this.session.expire(now);
  }

  clear(): void {
    this.clearOwnWrite();
    this.session.clear();
  }
}
