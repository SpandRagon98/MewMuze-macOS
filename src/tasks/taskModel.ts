//! Tasks: the data, and everything derived from it. Pure - no React, no Tauri.
//!
//! One flat list of tasks, each on a local calendar day ("YYYY-MM-DD") and
//! optionally under a parent on the same day. Only LEAVES are actionable:
//! a parent is done when every actionable task under it is, so progress never
//! counts a parent and its subtasks twice. Nothing derived (progress, totals,
//! insights) is stored - it is all computed from the tasks on demand.

export const TASKS_SCHEMA_VERSION = 1;
/** Deepest subtask level (0 is a top-level task): four levels in all. */
export const MAX_DEPTH = 3;
const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const DAY_MIN = 24 * 60;

export interface Task {
  id: string;
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  parentId: string | null;
  /** Position among its siblings (unscheduled ones are listed in this order). */
  order: number;
  title: string;
  notes: string;
  /** Local start time "HH:MM", or null when unscheduled. */
  start: string | null;
  /** Estimated minutes, or null. */
  durationMin: number | null;
  /** Meaningful for actionable (leaf) tasks; a parent's state is derived. */
  done: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface TaskDoc {
  version: number;
  tasks: Task[];
}

export const EMPTY_DOC: TaskDoc = { version: TASKS_SCHEMA_VERSION, tasks: [] };

// ---- days --------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The local calendar day of `ms` (never UTC: a task made at 00:30 belongs to today). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** `key` moved by `n` days, on the calendar (DST-safe: built from parts, not ms). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12).getTime());
}

/** Milliseconds until the next local midnight. */
export function msUntilMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - ms;
}

/** "Mon 14 Sep" in the user's locale. */
export function dateLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "Today", "Yesterday", "Tomorrow", or the date. */
export function dayLabel(key: string, today: string): string {
  if (key === today) return "Today";
  if (key === addDays(today, -1)) return "Yesterday";
  if (key === addDays(today, 1)) return "Tomorrow";
  return dateLabel(key);
}

// ---- time --------------------------------------------------------------------------------

export function isTime(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(min: number): string {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export interface Span {
  startMin: number;
  /** May exceed 1440 when the task runs past midnight. */
  endMin: number;
  end: string;
  pastMidnight: boolean;
}

/** Start + estimate -> end. Past midnight is reported, never moved to the next day. */
export function spanOf(t: Pick<Task, "start" | "durationMin">): Span | null {
  if (!t.start || !t.durationMin) return null;
  const startMin = toMinutes(t.start);
  const endMin = startMin + t.durationMin;
  return { startMin, endMin, end: fromMinutes(endMin), pastMidnight: endMin > DAY_MIN };
}

/** "1 h 30 min", "45 min". */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- ids ---------------------------------------------------------------------------------

/** A stable, collision-safe id. */
export function newTaskId(): string {
  const rnd = new Uint32Array(2);
  globalThis.crypto.getRandomValues(rnd);
  return `t${Date.now().toString(36)}${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}

// ---- hierarchy ---------------------------------------------------------------------------

export function tasksOn(doc: TaskDoc, day: string): Task[] {
  return doc.tasks.filter((t) => t.day === day);
}

/** Siblings in display order: scheduled by start time, then the rest by position. */
function sortSiblings(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.start && b.start) return toMinutes(a.start) - toMinutes(b.start) || a.order - b.order;
    if (a.start) return -1;
    if (b.start) return 1;
    return a.order - b.order;
  });
}

export function childrenOf(tasks: Task[], id: string | null): Task[] {
  return sortSiblings(tasks.filter((t) => t.parentId === id));
}

export function isLeaf(tasks: Task[], id: string): boolean {
  return !tasks.some((t) => t.parentId === id);
}

/** Every task under `id`, at any depth. */
export function descendantIds(tasks: Task[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of tasks) {
      if (t.parentId === cur && !out.has(t.id)) {
        out.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

export function depthOf(tasks: Task[], id: string): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let depth = 0;
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
    depth++;
  }
  return depth;
}

/** Can `id` go under `parentId` without making a loop, crossing days or nesting too deep? */
export function canReparent(tasks: Task[], id: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  if (parentId === id) return false;
  const task = tasks.find((t) => t.id === id);
  const parent = tasks.find((t) => t.id === parentId);
  if (!task || !parent || task.day !== parent.day) return false;
  if (descendantIds(tasks, id).has(parentId)) return false;
  return depthOf(tasks, parentId) + 1 + subtreeHeight(tasks, id) <= MAX_DEPTH;
}

function subtreeHeight(tasks: Task[], id: string): number {
  const kids = tasks.filter((t) => t.parentId === id);
  return kids.length ? 1 + Math.max(...kids.map((k) => subtreeHeight(tasks, k.id))) : 0;
}

/** A task is done when it is a finished leaf, or every actionable task under it is. */
export function isDone(tasks: Task[], id: string): boolean {
  const kids = tasks.filter((t) => t.parentId === id);
  if (!kids.length) return tasks.find((t) => t.id === id)?.done ?? false;
  return kids.every((k) => isDone(tasks, k.id));
}

export interface Row {
  task: Task;
  depth: number;
  leaf: boolean;
  done: boolean;
  /** Actionable tasks under this one (1 for a leaf) and how many are done. */
  leaves: number;
  leavesDone: number;
}

/** The day as an indented list, parents before their subtasks. */
export function rowsFor(tasks: Task[]): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const task of childrenOf(tasks, parentId)) {
      const leaf = isLeaf(tasks, task.id);
      const under = leaf ? [task] : [...descendantIds(tasks, task.id)].map((i) => tasks.find((t) => t.id === i)!).filter((t) => isLeaf(tasks, t.id));
      rows.push({ task, depth, leaf, done: isDone(tasks, task.id), leaves: under.length, leavesDone: under.filter((t) => t.done).length });
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// ---- progress and insights (all derived) -----------------------------------------------------

export interface Progress {
  done: number;
  total: number;
  pct: number;
}

/** Completed actionable tasks / actionable tasks. Parents are never counted. */
export function progressOf(tasks: Task[]): Progress {
  const leaves = tasks.filter((t) => isLeaf(tasks, t.id));
  const done = leaves.filter((t) => t.done).length;
  return { done, total: leaves.length, pct: leaves.length ? Math.round((100 * done) / leaves.length) : 0 };
}

/**
 * Estimated minutes of a task. A parent's is its subtasks' when they have
 * estimates, otherwise its own - never both, so nothing is counted twice.
 */
function estimate(tasks: Task[], t: Task, onlyOpen: boolean): number {
  const kids = tasks.filter((k) => k.parentId === t.id);
  if (kids.length) {
    const sum = kids.reduce((a, k) => a + estimate(tasks, k, onlyOpen), 0);
    const anyEstimate = kids.some((k) => estimate(tasks, k, false) > 0);
    if (anyEstimate) return sum;
    return onlyOpen && isDone(tasks, t.id) ? 0 : t.durationMin ?? 0;
  }
  return onlyOpen && t.done ? 0 : t.durationMin ?? 0;
}

/** Minutes covered by scheduled tasks, overlaps counted once (a parent's bar around its subtasks included). */
export function scheduledMinutes(tasks: Task[]): number {
  const spans = tasks
    .map(spanOf)
    .filter((s): s is Span => !!s)
    .map((s) => [s.startMin, s.endMin] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

export interface Insights extends Progress {
  estimatedMin: number;
  scheduledMin: number;
  remainingMin: number;
  /** Actionable tasks still open. */
  open: number;
  /**
   * Open actionable tasks that are late. Today: those whose scheduled end (their
   * own, or the nearest scheduled parent's) has passed. An earlier day: all of them.
   */
  overdue: Task[];
}

/** When a task is due by: its own end, else the nearest scheduled parent's. */
function dueMin(tasks: Task[], t: Task): number | null {
  const seen = new Set<string>();
  for (let cur: Task | undefined = t; cur && !seen.has(cur.id); cur = tasks.find((p) => p.id === cur!.parentId)) {
    seen.add(cur.id);
    const s = spanOf(cur);
    if (s) return s.endMin;
  }
  return null;
}

export function insightsFor(tasks: Task[], day: string, nowMs: number): Insights {
  const today = dayKey(nowMs);
  const top = tasks.filter((t) => t.parentId === null);
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = tasks.filter((t) => isLeaf(tasks, t.id) && !t.done);
  let overdue: Task[] = [];
  if (day < today) overdue = open;
  else if (day === today)
    overdue = open.filter((t) => {
      const due = dueMin(tasks, t);
      return due !== null && due <= nowMin;
    });
  return {
    ...progressOf(tasks),
    estimatedMin: top.reduce((a, t) => a + estimate(tasks, t, false), 0),
    scheduledMin: scheduledMinutes(tasks),
    remainingMin: top.reduce((a, t) => a + estimate(tasks, t, true), 0),
    open: open.length,
    overdue,
  };
}

// ---- the one-day Gantt -----------------------------------------------------------------------

export interface GanttBar {
  task: Task;
  depth: number;
  done: boolean;
  /** Percent of the axis. */
  left: number;
  width: number;
  startMin: number;
  endMin: number;
  /** The bar is only a start marker: the task has a time but no estimate. */
  marker: boolean;
  pastMidnight: boolean;
}

export interface Gantt {
  /** Axis window, minutes from the day's midnight. */
  fromMin: number;
  toMin: number;
  hours: { min: number; label: string; left: number }[];
  bars: GanttBar[];
  unscheduled: Row[];
  /** Current-time marker, percent, when the day is today and it is in view. */
  nowLeft: number | null;
}

/** A readable window: 08:00-20:00 by default, widened to whatever is scheduled. */
export function ganttFor(tasks: Task[], day: string, nowMs: number): Gantt {
  const rows = rowsFor(tasks);
  const timed = rows.filter((r) => r.task.start);
  let from = 8 * 60;
  let to = 20 * 60;
  for (const r of timed) {
    const s = toMinutes(r.task.start!);
    const e = Math.min(DAY_MIN, s + (r.task.durationMin ?? 15));
    from = Math.min(from, Math.floor(s / 60) * 60);
    to = Math.max(to, Math.ceil(e / 60) * 60);
  }
  const isToday = day === dayKey(nowMs);
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (isToday) {
    from = Math.min(from, Math.floor(nowMin / 60) * 60);
    to = Math.max(to, Math.min(DAY_MIN, Math.ceil((nowMin + 1) / 60) * 60));
  }
  from = Math.max(0, from);
  to = Math.min(DAY_MIN, Math.max(to, from + 60));
  const span = to - from;
  const pct = (m: number) => ((m - from) / span) * 100;
  const step = span > 12 * 60 ? 120 : 60;
  const hours: Gantt["hours"] = [];
  for (let m = Math.ceil(from / step) * step; m <= to; m += step) hours.push({ min: m, label: m === DAY_MIN ? "24:00" : fromMinutes(m), left: pct(m) });
  const bars: GanttBar[] = timed.map((r) => {
    const startMin = toMinutes(r.task.start!);
    const marker = !r.task.durationMin;
    const endMin = startMin + (r.task.durationMin ?? 0);
    const shownEnd = Math.min(to, marker ? startMin : endMin);
    return {
      task: r.task,
      depth: r.depth,
      done: r.done,
      left: pct(startMin),
      width: marker ? 0 : Math.max(0.8, pct(shownEnd) - pct(startMin)),
      startMin,
      endMin,
      marker,
      pastMidnight: endMin > DAY_MIN,
    };
  });
  return { fromMin: from, toMin: to, hours, bars, unscheduled: rows.filter((r) => !r.task.start), nowLeft: isToday && nowMin >= from && nowMin <= to ? pct(nowMin) : null };
}

// ---- edits (each returns a new document; the input is never changed) ---------------------------

export interface TaskInput {
  day: string;
  title: string;
  parentId?: string | null;
  notes?: string;
  start?: string | null;
  durationMin?: number | null;
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

function cleanDuration(v: unknown): number | null {
  const n = typeof v === "number" ? Math.round(v) : typeof v === "string" && v.trim() ? Math.round(Number(v)) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= DAY_MIN ? n : null;
}

function nextOrder(tasks: Task[], day: string, parentId: string | null): number {
  const sib = tasks.filter((t) => t.day === day && t.parentId === parentId);
  return sib.length ? Math.max(...sib.map((t) => t.order)) + 1 : 0;
}

export function addTask(doc: TaskDoc, input: TaskInput, now: number, id = newTaskId()): { doc: TaskDoc; id: string | null } {
  const title = cleanTitle(input.title);
  if (!title || !isDayKey(input.day)) return { doc, id: null };
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = doc.tasks.find((t) => t.id === parentId);
    if (!parent || parent.day !== input.day || depthOf(doc.tasks, parentId) + 1 > MAX_DEPTH) return { doc, id: null };
  }
  const task: Task = {
    id,
    day: input.day,
    parentId,
    order: nextOrder(doc.tasks, input.day, parentId),
    title,
    notes: (input.notes ?? "").slice(0, MAX_NOTES),
    start: isTime(input.start) ? input.start : null,
    durationMin: cleanDuration(input.durationMin),
    done: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  return { doc: { ...doc, tasks: [...doc.tasks, task] }, id };
}

export type TaskPatch = Partial<Pick<Task, "title" | "notes" | "start" | "durationMin">>;

export function updateTask(doc: TaskDoc, id: string, patch: TaskPatch, now: number): TaskDoc {
  return {
    ...doc,
    tasks: doc.tasks.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, updatedAt: now };
      if (patch.title !== undefined) next.title = cleanTitle(patch.title) || t.title;
      if (patch.notes !== undefined) next.notes = patch.notes.slice(0, MAX_NOTES);
      if (patch.start !== undefined) next.start = isTime(patch.start) ? patch.start : null;
      if (patch.durationMin !== undefined) next.durationMin = cleanDuration(patch.durationMin);
      return next;
    }),
  };
}

/** Complete or reopen. On a parent it applies to every actionable task under it. */
export function setDone(doc: TaskDoc, id: string, done: boolean, now: number): TaskDoc {
  const under = descendantIds(doc.tasks, id);
  const targets = under.size ? new Set([...under].filter((i) => isLeaf(doc.tasks, i))) : new Set([id]);
  return {
    ...doc,
    tasks: doc.tasks.map((t) => (targets.has(t.id) && t.done !== done ? { ...t, done, completedAt: done ? now : null, updatedAt: now } : t)),
  };
}

/** Move `id` under `parentId` (null = top level). Refused when it would make a loop. */
export function reparent(doc: TaskDoc, id: string, parentId: string | null, now: number): TaskDoc {
  if (!canReparent(doc.tasks, id, parentId)) return doc;
  const task = doc.tasks.find((t) => t.id === id)!;
  const order = nextOrder(doc.tasks.filter((t) => t.id !== id), task.day, parentId);
  return { ...doc, tasks: doc.tasks.map((t) => (t.id === id ? { ...t, parentId, order, updatedAt: now } : t)) };
}

/** Delete a task and everything under it. */
export function deleteTask(doc: TaskDoc, id: string): TaskDoc {
  const gone = descendantIds(doc.tasks, id);
  gone.add(id);
  return { ...doc, tasks: doc.tasks.filter((t) => !gone.has(t.id)) };
}

/** A fresh, unfinished copy of a task and its subtasks, right after the original. */
export function duplicateTask(doc: TaskDoc, id: string, now: number, makeId: () => string = newTaskId): { doc: TaskDoc; id: string | null } {
  const root = doc.tasks.find((t) => t.id === id);
  if (!root) return { doc, id: null };
  const ids = new Map<string, string>();
  const subtree = [root, ...[...descendantIds(doc.tasks, id)].map((i) => doc.tasks.find((t) => t.id === i)!)];
  for (const t of subtree) ids.set(t.id, makeId());
  const copies = subtree.map((t) => ({
    ...t,
    id: ids.get(t.id)!,
    parentId: t.id === id ? t.parentId : ids.get(t.parentId!)!,
    order: t.id === id ? t.order + 0.5 : t.order,
    title: t.id === id ? `${t.title} (copy)`.slice(0, MAX_TITLE) : t.title,
    done: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  return { doc: { ...doc, tasks: renumber([...doc.tasks, ...copies], root.day, root.parentId) }, id: ids.get(id)! };
}

function renumber(tasks: Task[], day: string, parentId: string | null): Task[] {
  const sib = tasks.filter((t) => t.day === day && t.parentId === parentId).sort((a, b) => a.order - b.order);
  const pos = new Map(sib.map((t, i) => [t.id, i]));
  return tasks.map((t) => (pos.has(t.id) && t.order !== pos.get(t.id) ? { ...t, order: pos.get(t.id)! } : t));
}

/**
 * "Move to today": the task and its subtasks go to `day`. A subtask moved on
 * its own becomes a top-level task there. Nothing is ever moved automatically.
 */
export function moveToDay(doc: TaskDoc, id: string, day: string, now: number): TaskDoc {
  const root = doc.tasks.find((t) => t.id === id);
  if (!root || !isDayKey(day) || root.day === day) return doc;
  const moving = descendantIds(doc.tasks, id);
  moving.add(id);
  const order = nextOrder(doc.tasks, day, null);
  return {
    ...doc,
    tasks: doc.tasks.map((t) => {
      if (!moving.has(t.id)) return t;
      return t.id === id ? { ...t, day, parentId: null, order, updatedAt: now } : { ...t, day, updatedAt: now };
    }),
  };
}

/** Top-level tasks on `day` with something still open under them - the "Move to today" candidates. */
export function unfinishedRoots(doc: TaskDoc, day: string): Task[] {
  const tasks = tasksOn(doc, day);
  return childrenOf(tasks, null).filter((t) => !isDone(tasks, t.id));
}

// ---- loading, with recovery ---------------------------------------------------------------------

export interface ParseResult {
  doc: TaskDoc;
  /** What had to be repaired or dropped (empty when the file was clean). */
  issues: string[];
  /** Written by a newer MewMuze: shown, but never saved over. */
  newerVersion: boolean;
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Whatever is on disk -> a usable document. Bad entries are repaired or
 * dropped one by one; the rest of the user's tasks always survive.
 */
export function parseTaskDoc(raw: unknown, now: number): ParseResult {
  const issues: string[] = [];
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const list = root && Array.isArray(root.tasks) ? (root.tasks as unknown[]) : null;
  if (!list) {
    if (raw !== null && raw !== undefined) issues.push("no task list");
    return { doc: { ...EMPTY_DOC, tasks: [] }, issues, newerVersion: false };
  }
  const version = num(root!.version, TASKS_SCHEMA_VERSION);
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const [i, item] of list.entries()) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const id = r ? str(r.id) : "";
    if (!r || !id || seen.has(id) || !isDayKey(r.day)) {
      issues.push(`entry ${i} dropped`);
      continue;
    }
    seen.add(id);
    const title = cleanTitle(str(r.title));
    if (!title) issues.push(`${id}: empty title`);
    tasks.push({
      id,
      day: r.day as string,
      parentId: typeof r.parentId === "string" && r.parentId ? r.parentId : null,
      order: num(r.order, i),
      title: title || "Untitled task",
      notes: str(r.notes).slice(0, MAX_NOTES),
      start: isTime(r.start) ? r.start : null,
      durationMin: cleanDuration(r.durationMin),
      done: r.done === true,
      createdAt: num(r.createdAt, now),
      updatedAt: num(r.updatedAt, now),
      completedAt: typeof r.completedAt === "number" ? r.completedAt : null,
    });
  }
  // Parents that are missing, on another day, or part of a loop: the task becomes top-level.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    const p = t.parentId ? byId.get(t.parentId) : null;
    if (t.parentId && (!p || p.day !== t.day)) {
      issues.push(`${t.id}: parent missing`);
      t.parentId = null;
    }
  }
  for (const t of tasks) {
    const chain = new Set<string>([t.id]);
    let cur = t.parentId ? byId.get(t.parentId) : undefined;
    while (cur) {
      if (chain.has(cur.id)) {
        issues.push(`${t.id}: loop broken`);
        t.parentId = null;
        break;
      }
      chain.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return { doc: { version: TASKS_SCHEMA_VERSION, tasks }, issues, newerVersion: version > TASKS_SCHEMA_VERSION };
}
