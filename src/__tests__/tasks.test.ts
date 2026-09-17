import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  addTask,
  canReparent,
  dayKey,
  dayLabel,
  deleteTask,
  duplicateTask,
  EMPTY_DOC,
  ganttFor,
  insightsFor,
  isDayKey,
  isDone,
  MAX_DEPTH,
  moveToDay,
  msUntilMidnight,
  parseTaskDoc,
  progressOf,
  reparent,
  rowsFor,
  scheduledMinutes,
  setDone,
  spanOf,
  tasksOn,
  unfinishedRoots,
  updateTask,
  type TaskDoc,
} from "../tasks/taskModel";
import { SAVE_DEBOUNCE_MS, TaskStore, type TaskBridge } from "../tasks/taskStore";

const DAY = "2026-09-14";
const at = (h: number, m = 0, d = 14) => new Date(2026, 8, d, h, m).getTime();
const NOW = at(10);

/** Build a document from a compact spec; ids are the titles, so tests read naturally. */
function build(spec: { title: string; parent?: string; start?: string; dur?: number; day?: string }[]): TaskDoc {
  let doc = EMPTY_DOC;
  for (const s of spec) {
    const r = addTask(doc, { day: s.day ?? DAY, title: s.title, parentId: s.parent ?? null, start: s.start ?? null, durationMin: s.dur ?? null }, NOW, s.title);
    if (!r.id) throw new Error(`could not add ${s.title}`);
    doc = r.doc;
  }
  return doc;
}
const on = (doc: TaskDoc, day = DAY) => tasksOn(doc, day);
const byId = (doc: TaskDoc, id: string) => doc.tasks.find((t) => t.id === id)!;

// ---- CRUD -------------------------------------------------------------------------------

describe("tasks: CRUD", () => {
  it("adds with only a title; everything else is optional", () => {
    const { doc, id } = addTask(EMPTY_DOC, { day: DAY, title: "  Water   the plants " }, NOW, "a");
    expect(id).toBe("a");
    expect(byId(doc, "a")).toMatchObject({ title: "Water the plants", notes: "", start: null, durationMin: null, done: false, parentId: null, day: DAY });
    expect(EMPTY_DOC.tasks).toHaveLength(0); // never mutated
  });

  it("refuses an empty title or a bad day", () => {
    expect(addTask(EMPTY_DOC, { day: DAY, title: "   " }, NOW).id).toBeNull();
    expect(addTask(EMPTY_DOC, { day: "2026-02-30", title: "x" }, NOW).id).toBeNull();
  });

  it("edits title, notes, start and estimate, and ignores junk values", () => {
    let doc = build([{ title: "a" }]);
    doc = updateTask(doc, "a", { title: "Write report", notes: "for Friday", start: "09:30", durationMin: 45 }, NOW + 1);
    expect(byId(doc, "a")).toMatchObject({ title: "Write report", notes: "for Friday", start: "09:30", durationMin: 45, updatedAt: NOW + 1 });
    doc = updateTask(doc, "a", { title: "  ", start: "25:00", durationMin: -5 }, NOW + 2);
    expect(byId(doc, "a")).toMatchObject({ title: "Write report", start: null, durationMin: null });
  });

  it("completes and reopens", () => {
    let doc = build([{ title: "a" }]);
    doc = setDone(doc, "a", true, NOW + 5);
    expect(byId(doc, "a")).toMatchObject({ done: true, completedAt: NOW + 5 });
    doc = setDone(doc, "a", false, NOW + 6);
    expect(byId(doc, "a")).toMatchObject({ done: false, completedAt: null });
  });

  it("deletes a task with its whole subtree", () => {
    const doc = deleteTask(build([{ title: "a" }, { title: "b", parent: "a" }, { title: "c", parent: "b" }, { title: "d" }]), "a");
    expect(doc.tasks.map((t) => t.id)).toEqual(["d"]);
  });
});

// ---- hierarchy + cycles -------------------------------------------------------------------

describe("tasks: hierarchy", () => {
  it("lists parents before their subtasks, indented by depth", () => {
    const rows = rowsFor(on(build([{ title: "a" }, { title: "b", parent: "a" }, { title: "c", parent: "b" }, { title: "d" }])));
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 0]]);
  });

  it("orders scheduled siblings by start time, then the rest as added", () => {
    const rows = rowsFor(on(build([{ title: "x" }, { title: "late", start: "15:00" }, { title: "early", start: "09:00" }, { title: "y" }])));
    expect(rows.map((r) => r.task.id)).toEqual(["early", "late", "x", "y"]);
  });

  it("caps nesting at MAX_DEPTH", () => {
    let doc = build([{ title: "l0" }, { title: "l1", parent: "l0" }, { title: "l2", parent: "l1" }, { title: "l3", parent: "l2" }]);
    expect(rowsFor(on(doc))[3].depth).toBe(MAX_DEPTH);
    expect(addTask(doc, { day: DAY, title: "l4", parentId: "l3" }, NOW).id).toBeNull();
    doc = build([{ title: "p" }, { title: "q" }, { title: "q1", parent: "q" }, { title: "q2", parent: "q1" }, { title: "q3", parent: "q2" }]);
    expect(canReparent(on(doc), "q", "p"), "moving a 4-deep subtree under a parent would make 5 levels").toBe(false);
  });

  it("subtasks stay on their parent's day", () => {
    const doc = build([{ title: "a" }, { title: "other", day: addDays(DAY, 1) }]);
    expect(addTask(doc, { day: addDays(DAY, 1), title: "x", parentId: "a" }, NOW).id).toBeNull();
    expect(canReparent(doc.tasks, "other", "a")).toBe(false);
  });
});

describe("tasks: cycle prevention", () => {
  const doc = build([{ title: "a" }, { title: "b", parent: "a" }, { title: "c", parent: "b" }]);

  it("never lets a task become its own parent or its descendant's child", () => {
    expect(canReparent(doc.tasks, "a", "a")).toBe(false);
    expect(canReparent(doc.tasks, "a", "b")).toBe(false);
    expect(canReparent(doc.tasks, "a", "c")).toBe(false);
    expect(reparent(doc, "a", "c", NOW)).toBe(doc);
  });

  it("allows legal moves, including back to the top level", () => {
    const moved = reparent(doc, "c", "a", NOW);
    expect(byId(moved, "c").parentId).toBe("a");
    expect(byId(reparent(doc, "b", null, NOW), "b").parentId).toBeNull();
  });

  it("repairs a looped file on load instead of hanging or losing tasks", () => {
    const raw = {
      version: 1,
      tasks: [
        { id: "x", day: DAY, parentId: "y", title: "X" },
        { id: "y", day: DAY, parentId: "x", title: "Y" },
      ],
    };
    const { doc: fixed, issues } = parseTaskDoc(raw, NOW);
    expect(fixed.tasks).toHaveLength(2);
    expect(issues.some((i) => i.includes("loop"))).toBe(true);
    expect(rowsFor(fixed.tasks)).toHaveLength(2); // walkable: no infinite recursion
  });
});

// ---- roll-up + progress -------------------------------------------------------------------

describe("tasks: parent roll-up and progress", () => {
  const base = () => build([{ title: "p" }, { title: "p1", parent: "p" }, { title: "p2", parent: "p" }, { title: "solo" }]);

  it("a parent is done only when every actionable task under it is", () => {
    let doc = setDone(base(), "p1", true, NOW);
    expect(isDone(on(doc), "p")).toBe(false);
    doc = setDone(doc, "p2", true, NOW);
    expect(isDone(on(doc), "p")).toBe(true);
    const row = rowsFor(on(doc)).find((r) => r.task.id === "p")!;
    expect(row).toMatchObject({ leaf: false, done: true, leaves: 2, leavesDone: 2 });
  });

  it("completing or reopening a parent applies to its subtasks", () => {
    let doc = setDone(base(), "p", true, NOW);
    expect(["p1", "p2"].map((id) => byId(doc, id).done)).toEqual([true, true]);
    doc = setDone(doc, "p", false, NOW);
    expect(["p1", "p2"].map((id) => byId(doc, id).done)).toEqual([false, false]);
  });

  it("counts actionable tasks only: a parent and its subtasks are never double-counted", () => {
    const doc = setDone(base(), "p1", true, NOW);
    // p1, p2, solo are actionable; p is not.
    expect(progressOf(on(doc))).toEqual({ done: 1, total: 3, pct: 33 });
    expect(progressOf(on(setDone(doc, "p", true, NOW)))).toEqual({ done: 2, total: 3, pct: 67 });
    expect(progressOf([])).toEqual({ done: 0, total: 0, pct: 0 });
  });

  it("a stale done flag on a parent does not count once it has subtasks", () => {
    let doc = build([{ title: "p" }]);
    doc = setDone(doc, "p", true, NOW);
    doc = addTask(doc, { day: DAY, title: "child", parentId: "p" }, NOW, "child").doc;
    expect(isDone(on(doc), "p")).toBe(false);
    expect(progressOf(on(doc))).toEqual({ done: 0, total: 1, pct: 0 });
  });
});

// ---- duplication --------------------------------------------------------------------------

describe("tasks: duplicate", () => {
  it("copies the subtree with fresh ids, unfinished, right after the original", () => {
    let doc = build([{ title: "a" }, { title: "b" }, { title: "b1", parent: "b" }, { title: "b2", parent: "b", start: "09:00", dur: 30 }, { title: "c" }]);
    doc = setDone(doc, "b1", true, NOW);
    let n = 0;
    const r = duplicateTask(doc, "b", NOW + 9, () => `new${n++}`);
    expect(r.id).toBe("new0");
    const copy = byId(r.doc, "new0");
    expect(copy).toMatchObject({ title: "b (copy)", parentId: null, done: false });
    const kids = r.doc.tasks.filter((t) => t.parentId === "new0");
    expect(kids.map((k) => k.title).sort()).toEqual(["b1", "b2"]);
    expect(kids.every((k) => !k.done && k.completedAt === null)).toBe(true);
    expect(kids.find((k) => k.title === "b2")).toMatchObject({ start: "09:00", durationMin: 30 });
    // The original is untouched and the copy sits between b and c.
    expect(byId(r.doc, "b1").done).toBe(true);
    expect(rowsFor(on(r.doc)).filter((row) => row.depth === 0).map((row) => row.task.title)).toEqual(["a", "b", "b (copy)", "c"]);
    expect(new Set(r.doc.tasks.map((t) => t.id)).size).toBe(r.doc.tasks.length);
  });
});

// ---- scheduling -------------------------------------------------------------------------

describe("tasks: scheduling and end time", () => {
  it("start + estimate gives the end time", () => {
    expect(spanOf({ start: "09:15", durationMin: 50 })).toEqual({ startMin: 555, endMin: 605, end: "10:05", pastMidnight: false });
  });

  it("warns past midnight but never moves the task to the next day", () => {
    const doc = build([{ title: "late", start: "23:30", dur: 90 }]);
    const span = spanOf(byId(doc, "late"))!;
    expect(span).toMatchObject({ end: "01:00", pastMidnight: true });
    expect(byId(doc, "late").day).toBe(DAY);
    expect(spanOf({ start: "22:00", durationMin: 120 })!.pastMidnight).toBe(false); // ends exactly at 24:00
  });

  it("unscheduled tasks have no span and still work", () => {
    expect(spanOf({ start: null, durationMin: 30 })).toBeNull();
    expect(spanOf({ start: "10:00", durationMin: null })).toBeNull();
    const doc = setDone(build([{ title: "u" }]), "u", true, NOW);
    expect(progressOf(on(doc)).pct).toBe(100);
  });

  it("counts overlapping scheduled time once", () => {
    const doc = build([
      { title: "p", start: "09:00", dur: 120 },
      { title: "p1", parent: "p", start: "09:00", dur: 60 },
      { title: "x", start: "12:00", dur: 30 },
    ]);
    expect(scheduledMinutes(on(doc))).toBe(150);
  });
});

// ---- days + midnight ---------------------------------------------------------------------

describe("tasks: days and midnight rollover", () => {
  it("uses the local calendar day, not UTC", () => {
    expect(dayKey(at(0, 30))).toBe(DAY);
    expect(dayKey(at(23, 59))).toBe(DAY);
    expect(dayKey(at(0, 0, 15))).toBe(addDays(DAY, 1));
  });

  it("steps days across month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(isDayKey("2026-02-29")).toBe(false);
  });

  it("knows how long until midnight", () => {
    expect(msUntilMidnight(at(23, 0))).toBe(60 * 60 * 1000);
  });

  it("labels nearby days", () => {
    expect(dayLabel(DAY, DAY)).toBe("Today");
    expect(dayLabel(addDays(DAY, -1), DAY)).toBe("Yesterday");
    expect(dayLabel(addDays(DAY, 1), DAY)).toBe("Tomorrow");
  });

  it("keeps yesterday's tasks where they were and never carries them forward on its own", () => {
    const doc = build([{ title: "done", day: "2026-09-13" }, { title: "open", day: "2026-09-13" }, { title: "sub", parent: "open", day: "2026-09-13" }]);
    const d2 = setDone(doc, "done", true, NOW);
    expect(tasksOn(d2, DAY)).toHaveLength(0);
    expect(unfinishedRoots(d2, "2026-09-13").map((t) => t.id)).toEqual(["open"]);
  });

  it("Move to today takes the task and its subtasks, and only when asked", () => {
    const doc = build([{ title: "open", day: "2026-09-13" }, { title: "sub", parent: "open", day: "2026-09-13" }, { title: "t" }]);
    const moved = moveToDay(doc, "open", DAY, NOW);
    expect(tasksOn(moved, "2026-09-13")).toHaveLength(0);
    expect(byId(moved, "open")).toMatchObject({ day: DAY, parentId: null, order: 1 });
    expect(byId(moved, "sub")).toMatchObject({ day: DAY, parentId: "open" });
    // A subtask moved on its own becomes top-level on the new day.
    expect(byId(moveToDay(doc, "sub", DAY, NOW), "sub")).toMatchObject({ day: DAY, parentId: null });
  });
});

// ---- insights ---------------------------------------------------------------------------

describe("tasks: daily insights", () => {
  const doc = () =>
    setDone(
      build([
        { title: "p", dur: 999 }, // own estimate ignored: its subtasks have estimates
        { title: "p1", parent: "p", dur: 30 },
        { title: "p2", parent: "p", dur: 60 },
        { title: "meet", start: "08:00", dur: 60 },
        { title: "later", start: "15:00", dur: 45 },
        { title: "loose" },
      ]),
      "p1",
      true,
      NOW,
    );

  it("computes the numbers from the tasks alone", () => {
    const ins = insightsFor(on(doc()), DAY, NOW);
    expect(ins).toMatchObject({ done: 1, total: 5, pct: 20, estimatedMin: 195, scheduledMin: 105, remainingMin: 165, open: 4 });
    expect(ins.overdue.map((t) => t.id)).toEqual(["meet"]); // ended 09:00, still open at 10:00
  });

  it("counts overdue actionable tasks only, using a scheduled parent's end for its unscheduled subtasks", () => {
    const d = build([
      { title: "p", start: "08:00", dur: 60 },
      { title: "p1", parent: "p", start: "08:00", dur: 30 },
      { title: "p2", parent: "p" }, // due when p ends, 09:00
      { title: "later", parent: "p", start: "11:00", dur: 30 }, // its own end wins
    ]);
    expect(insightsFor(on(d), DAY, NOW).overdue.map((t) => t.id)).toEqual(["p1", "p2"]);
  });

  it("on a past day, everything still open is overdue", () => {
    const d = build([{ title: "a", day: "2026-09-13" }, { title: "b", day: "2026-09-13" }]);
    const ins = insightsFor(tasksOn(setDone(d, "a", true, NOW), "2026-09-13"), "2026-09-13", NOW);
    expect(ins.overdue.map((t) => t.id)).toEqual(["b"]);
  });

  it("a parent without subtask estimates uses its own", () => {
    const d = build([{ title: "p", dur: 40 }, { title: "p1", parent: "p" }]);
    expect(insightsFor(on(d), DAY, NOW).estimatedMin).toBe(40);
    expect(insightsFor(on(setDone(d, "p", true, NOW)), DAY, NOW).remainingMin).toBe(0);
  });
});

// ---- Gantt ------------------------------------------------------------------------------

describe("tasks: one-day Gantt", () => {
  it("defaults to 08:00-20:00 and places bars by start and duration", () => {
    const g = ganttFor(on(build([{ title: "a", start: "11:00", dur: 120 }])), DAY, at(10, 0, 20));
    expect([g.fromMin, g.toMin]).toEqual([8 * 60, 20 * 60]);
    expect(g.bars[0].left).toBeCloseTo(25);
    expect(g.bars[0].width).toBeCloseTo((120 / 720) * 100);
    expect(g.nowLeft).toBeNull(); // not today
    expect(g.hours[0]).toMatchObject({ label: "08:00", left: 0 });
  });

  it("widens to fit early and late tasks, clamping at midnight", () => {
    const g = ganttFor(on(build([{ title: "e", start: "06:30", dur: 15 }, { title: "l", start: "23:00", dur: 120 }])), DAY, at(10, 0, 20));
    expect([g.fromMin, g.toMin]).toEqual([6 * 60, 24 * 60]);
    const late = g.bars.find((b) => b.task.id === "l")!;
    expect(late.pastMidnight).toBe(true);
    expect(late.left + late.width).toBeLessThanOrEqual(100.0001);
    expect(g.hours[g.hours.length - 1].label).toBe("24:00");
    expect(g.hours[1].min - g.hours[0].min).toBe(120); // an 18 h window steps by 2 h
  });

  it("shows the current-time marker only on today", () => {
    const g = ganttFor(on(build([{ title: "a", start: "09:00", dur: 30 }])), DAY, at(14));
    expect(g.nowLeft).toBeCloseTo(50);
  });

  it("indents subtask bars, marks tasks without an estimate, and lists the unscheduled", () => {
    const g = ganttFor(
      on(build([{ title: "p", start: "09:00" }, { title: "p1", parent: "p", start: "09:00", dur: 30 }, { title: "free" }])),
      DAY,
      NOW,
    );
    expect(g.bars.map((b) => [b.task.id, b.depth, b.marker])).toEqual([["p", 0, true], ["p1", 1, false]]);
    expect(g.unscheduled.map((r) => r.task.id)).toEqual(["free"]);
  });
});

// ---- loading with recovery -----------------------------------------------------------------

describe("tasks: reading a damaged file", () => {
  it("keeps every good entry and drops or repairs only the bad ones", () => {
    const { doc, issues, newerVersion } = parseTaskDoc(
      {
        version: 1,
        tasks: [
          { id: "ok", day: DAY, title: "Fine", start: "09:00", durationMin: 30, done: true },
          { id: "ok", day: DAY, title: "Duplicate id" },
          { id: "noday", title: "No day" },
          "garbage",
          { id: "blank", day: DAY, title: "" },
          { id: "orphan", day: DAY, title: "Orphan", parentId: "gone", start: "99:99", durationMin: "abc" },
        ],
      },
      NOW,
    );
    expect(newerVersion).toBe(false);
    expect(doc.tasks.map((t) => t.id)).toEqual(["ok", "blank", "orphan"]);
    expect(byId(doc, "ok")).toMatchObject({ title: "Fine", start: "09:00", durationMin: 30, done: true });
    expect(byId(doc, "blank").title).toBe("Untitled task");
    expect(byId(doc, "orphan")).toMatchObject({ parentId: null, start: null, durationMin: null });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it("flags a file from a newer version", () => {
    expect(parseTaskDoc({ version: 7, tasks: [] }, NOW).newerVersion).toBe(true);
  });

  it("treats nothing on disk as a clean empty start", () => {
    expect(parseTaskDoc(undefined, NOW)).toEqual({ doc: EMPTY_DOC, issues: [], newerVersion: false });
  });
});

// ---- the store --------------------------------------------------------------------------

function fakeBridge(main: string | null, backup: string | null = null) {
  const log: string[] = [];
  const disk = { main, backup, corrupt: [] as string[] };
  let failSaves = 0;
  const bridge: TaskBridge = {
    load: async () => ({ main: disk.main, backup: disk.backup }),
    save: async (json) => {
      if (failSaves > 0) {
        failSaves--;
        throw new Error("disk full");
      }
      log.push("save");
      disk.main = json;
    },
    quarantine: async () => {
      log.push("quarantine");
      if (disk.main !== null) disk.corrupt.push(disk.main);
      return "tasks.corrupt-1.json";
    },
  };
  return { bridge, disk, log, failNext: (n = 1) => (failSaves = n) };
}

const add = (store: TaskStore, title: string) =>
  store.apply((d) => addTask(d, { day: DAY, title }, NOW, title).doc);
const saved = (json: string | null) => (JSON.parse(json!) as TaskDoc).tasks.map((t) => t.title);

describe("tasks: store and storage recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces edits into one save", async () => {
    const f = fakeBridge(null);
    const store = new TaskStore(f.bridge, () => NOW);
    await store.load();
    add(store, "a");
    add(store, "b");
    expect(f.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(f.log).toEqual(["save"]);
    expect(saved(f.disk.main)).toEqual(["a", "b"]);
  });

  it("flush writes at once (panel close, app quit) and is idempotent", async () => {
    const f = fakeBridge(null);
    const store = new TaskStore(f.bridge, () => NOW);
    await store.load();
    add(store, "a");
    await store.flush();
    await store.flush();
    expect(f.log).toEqual(["save"]);
  });

  it("refuses edits before the file has loaded", () => {
    const store = new TaskStore(fakeBridge(null).bridge);
    expect(add(store, "a")).toBe(false);
  });

  it("restores from the backup when the main file is damaged, and keeps the damaged copy first", async () => {
    const good = JSON.stringify({ version: 1, tasks: [{ id: "k", day: DAY, title: "Kept" }] });
    const f = fakeBridge("{ half written", good);
    const store = new TaskStore(f.bridge, () => NOW);
    await store.load();
    expect(store.state).toBe("ready");
    expect(store.get().tasks.map((t) => t.title)).toEqual(["Kept"]);
    expect(store.issues).toContain("restored from backup");
    add(store, "new");
    await store.flush();
    expect(f.log).toEqual(["quarantine", "save"]);
    expect(f.disk.corrupt).toEqual(["{ half written"]);
    expect(saved(f.disk.main)).toEqual(["Kept", "new"]);
  });

  it("restores from the backup when the main file is missing", async () => {
    const good = JSON.stringify({ version: 1, tasks: [{ id: "k", day: DAY, title: "Kept" }] });
    const store = new TaskStore(fakeBridge(null, good).bridge, () => NOW);
    await store.load();
    expect(store.get().tasks.map((t) => t.title)).toEqual(["Kept"]);
  });

  it("never saves over a file from a newer MewMuze", async () => {
    const f = fakeBridge(JSON.stringify({ version: 2, tasks: [{ id: "n", day: DAY, title: "Future" }] }));
    const store = new TaskStore(f.bridge, () => NOW);
    await store.load();
    expect(store.state).toBe("readOnly");
    expect(store.get().tasks).toHaveLength(1);
    expect(add(store, "x")).toBe(false);
    await store.flush();
    expect(f.log).toEqual([]);
  });

  it("goes read-only when storage is unavailable, rather than risk an overwrite", async () => {
    const store = new TaskStore({ ...fakeBridge(null).bridge, load: () => Promise.reject(new Error("no tauri")) });
    await store.load();
    expect(store.state).toBe("readOnly");
    const odd = new TaskStore({ ...fakeBridge(null).bridge, load: async () => null as never });
    await odd.load();
    expect(odd.state).toBe("readOnly");
  });

  it("keeps the edit and retries after a failed save", async () => {
    const f = fakeBridge(null);
    const store = new TaskStore(f.bridge, () => NOW);
    await store.load();
    add(store, "a");
    f.failNext();
    await store.flush();
    expect(f.disk.main).toBeNull();
    await store.flush();
    expect(saved(f.disk.main)).toEqual(["a"]);
  });
});
