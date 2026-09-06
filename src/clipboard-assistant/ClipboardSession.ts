import type { ClipboardSnapshot, NativeClipboardEvent } from "./clipboardTypes";

export class ClipboardSession {
  private snapshotValue: ClipboardSnapshot | null = null;
  private nextId = 1;

  get snapshot(): ClipboardSnapshot | null {
    return this.snapshotValue ? { ...this.snapshotValue } : null;
  }

  replace(event: NativeClipboardEvent, now: number, forgetAfterSeconds: number): ClipboardSnapshot {
    this.snapshotValue = {
      id: this.nextId++,
      original: event.text,
      result: event.text,
      sourceApp: event.sourceApp,
      createdAt: now,
      expiresAt: forgetAfterSeconds > 0 ? now + forgetAfterSeconds * 1000 : null,
    };
    return { ...this.snapshotValue };
  }

  setResult(result: string): ClipboardSnapshot | null {
    if (!this.snapshotValue) return null;
    this.snapshotValue = { ...this.snapshotValue, result };
    return { ...this.snapshotValue };
  }

  restoreOriginal(): ClipboardSnapshot | null {
    if (!this.snapshotValue) return null;
    this.snapshotValue = { ...this.snapshotValue, result: this.snapshotValue.original };
    return { ...this.snapshotValue };
  }

  isDuplicate(text: string): boolean {
    return this.snapshotValue?.original === text;
  }

  expire(now: number): boolean {
    if (!this.snapshotValue?.expiresAt || now < this.snapshotValue.expiresAt) return false;
    this.clear();
    return true;
  }

  clear(): void {
    this.snapshotValue = null;
  }
}
