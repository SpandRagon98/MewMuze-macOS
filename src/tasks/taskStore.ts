//! The tasks file on disk <-> the document in memory.
//!
//! Edits apply at once in memory and are written a moment later (debounced), so
//! typing never waits on the disk; `flush()` writes immediately and is called
//! when the panel closes and when the app quits. Loading never throws away the
//! user's data: an unreadable file falls back to the last good backup and is
//! copied aside before anything is written over it, and a file from a newer
//! MewMuze is shown but never overwritten.

import { EMPTY_DOC, parseTaskDoc, type TaskDoc } from "./taskModel";

/** What crosses into Rust (src-tauri/src/tasks.rs); injectable for tests. */
export interface TaskBridge {
  load(): Promise<{ main: string | null; backup: string | null }>;
  save(json: string): Promise<void>;
  quarantine(): Promise<string | null>;
}

export type LoadState = "loading" | "ready" | "readOnly";

export const SAVE_DEBOUNCE_MS = 400;

export class TaskStore {
  private doc: TaskDoc = EMPTY_DOC;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  /** The file on disk could not be read as it was: copy it aside before the first write. */
  private keepOriginal = false;
  private loading: Promise<void> | null = null;
  state: LoadState = "loading";
  /** What was repaired on load (for the panel's one-line notice). */
  issues: string[] = [];

  constructor(
    private readonly bridge: TaskBridge,
    private readonly now: () => number = Date.now,
  ) {}

  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    let files: { main: string | null; backup: string | null } = { main: null, backup: null };
    try {
      files = await this.bridge.load();
      if (!files || typeof files !== "object") throw new Error("no task files answer");
    } catch {
      // No disk access at all (a browser preview): start empty, never save over anything.
      this.state = "readOnly";
      this.issues = ["tasks could not be read"];
      this.emit();
      return;
    }
    const json = (text: string | null): unknown => {
      if (text === null) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    let raw = json(files.main);
    const issues: string[] = [];
    if (raw === null || (files.main === null && files.backup !== null)) {
      // The main file is damaged or gone: use the previous good one, and keep any damaged copy.
      issues.push(raw === null ? "tasks file damaged" : "tasks file missing");
      this.keepOriginal = raw === null;
      const backup = json(files.backup);
      if (backup) {
        raw = backup;
        issues.push("restored from backup");
      } else raw = undefined;
    }
    const parsed = parseTaskDoc(raw, this.now());
    if (parsed.issues.length) this.keepOriginal = true;
    this.doc = parsed.doc;
    this.issues = [...issues, ...parsed.issues];
    this.state = parsed.newerVersion ? "readOnly" : "ready";
    this.emit();
  }

  get(): TaskDoc {
    return this.doc;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Apply an edit. Refused until loaded, and when the file belongs to a newer MewMuze. */
  apply(edit: (doc: TaskDoc) => TaskDoc): boolean {
    if (this.state !== "ready") return false;
    const next = edit(this.doc);
    if (next === this.doc) return false;
    this.doc = next;
    this.dirty = true;
    this.emit();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
    return true;
  }

  /** Write now if anything is pending. Safe to call any number of times. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.state !== "ready") return this.saving;
    this.dirty = false;
    const json = JSON.stringify(this.doc);
    this.saving = this.saving.then(async () => {
      try {
        if (this.keepOriginal) {
          await this.bridge.quarantine();
          this.keepOriginal = false;
        }
        await this.bridge.save(json);
      } catch {
        // Try again with the next edit or flush; the data is still in memory.
        this.dirty = true;
      }
    });
    return this.saving;
  }
}
