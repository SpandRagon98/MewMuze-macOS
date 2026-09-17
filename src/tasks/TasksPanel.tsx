//! The Tasks panel: today's list beside the cat, and a wider Insights view with
//! a one-day Gantt chart. The same floating shell, placement and type as every
//! other panel next to the cat; everything it shows is derived from the task
//! data (taskModel.ts), and every edit goes through the store (taskStore.ts).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import { Icon } from "../components/icons";
import { confirmAction, type ConfirmOptions } from "../components/ConfirmDialog";
import {
  addDays,
  addTask,
  canReparent,
  dateLabel,
  dayKey,
  dayLabel,
  deleteTask,
  descendantIds,
  duplicateTask,
  formatMinutes,
  ganttFor,
  MAX_DEPTH,
  insightsFor,
  moveToDay,
  msUntilMidnight,
  progressOf,
  reparent,
  rowsFor,
  setDone,
  spanOf,
  tasksOn,
  unfinishedRoots,
  updateTask,
  type Task,
} from "./taskModel";
import type { TaskStore } from "./taskStore";

export const TASKS_PANEL_SIZE = { width: 360, height: 480 };
export const INSIGHTS_PANEL_SIZE = { width: 720, height: 540 };
const DURATIONS = [15, 30, 45, 60, 90, 120];

type View = "list" | "insights";

export function TasksPanel({
  cat,
  area,
  store,
  onClose,
  now = Date.now,
  confirm = confirmAction,
}: {
  cat: Box;
  area: Area;
  store: TaskStore;
  onClose: () => void;
  now?: () => number;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
}) {
  const doc = useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribe(fn), [store]),
    () => store.get(),
  );
  const [ready, setReady] = useState(store.state !== "loading");
  useEffect(() => {
    void store.load().then(() => setReady(true));
  }, [store]);

  // ---- which day ----
  const [today, setToday] = useState(() => dayKey(now()));
  const [day, setDay] = useState(today);
  // At local midnight Today moves on; a view of the old today follows it. One
  // timer per day while the panel is open - nothing ticks otherwise.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = dayKey(now());
      setDay((d) => (d === today ? next : d));
      setToday(next);
    }, msUntilMidnight(now()) + 50);
    return () => clearTimeout(t);
  }, [today, now]);

  const [view, setView] = useState<View>("list");
  const [editing, setEditing] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  // The input is disabled until the file has loaded, which autoFocus misses on a first open.
  useEffect(() => {
    if (ready) addRef.current?.focus();
  }, [ready]);

  const tasks = useMemo(() => tasksOn(doc, day), [doc, day]);
  const rows = useMemo(() => rowsFor(tasks), [tasks]);
  const progress = progressOf(tasks);
  const leftOver = day < today ? unfinishedRoots(doc, day) : [];
  const readOnly = store.state === "readOnly";

  const apply = (edit: Parameters<TaskStore["apply"]>[0]) => store.apply(edit);
  const add = (title: string, parentId: string | null = null) => {
    let added: string | null = null;
    apply((d) => {
      const r = addTask(d, { day, title, parentId }, now());
      added = r.id;
      return r.doc;
    });
    return added;
  };
  const remove = async (task: Task) => {
    const under = descendantIds(tasks, task.id).size;
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      message: under ? `Its ${under === 1 ? "subtask goes" : `${under} subtasks go`} too. This can't be undone.` : "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (editing && (editing === task.id || descendantIds(tasks, task.id).has(editing))) setEditing(null);
    apply((d) => deleteTask(d, task.id));
  };

  // ---- placement: beside the cat, inside the work area, re-placed on every real size change ----
  const boxRef = useRef<HTMLDivElement>(null);
  const size = view === "insights" ? INSIGHTS_PANEL_SIZE : TASKS_PANEL_SIZE;
  const width = Math.min(size.width, Math.max(280, area.right - area.left - 16));
  const [placement, setPlacement] = useState(() => placePanel({ cat, panel: { width, height: size.height }, area }));
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const next = placePanel({ cat, panel: { width, height: r.height > 1 ? r.height : size.height }, area });
      setPlacement((p) => (p.x === next.x && p.y === next.y ? p : next));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cat, area, width, size.height]);

  // ---- keyboard: arrows change day, T is today, I the chart, Esc steps back ----
  const onKey = (e: React.KeyboardEvent) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === "Escape") {
      e.stopPropagation();
      if (menuFor) setMenuFor(null);
      else if (editing) setEditing(null);
      else if (addingUnder) setAddingUnder(null);
      else if (!typing || !(e.target as HTMLInputElement).value) onClose();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowLeft") setDay((d) => addDays(d, -1));
    else if (e.key === "ArrowRight") setDay((d) => addDays(d, 1));
    else if (e.key === "t" || e.key === "T") setDay(today);
    else if (e.key === "i" || e.key === "I") setView((v) => (v === "list" ? "insights" : "list"));
    else return;
    e.preventDefault();
  };

  const editingTask = editing ? tasks.find((t) => t.id === editing) ?? null : null;

  return (
    <div
      ref={boxRef}
      className={`quick-tools pixel-ui tasks-panel${view === "insights" ? " wide" : ""}`}
      role="dialog"
      aria-label="Tasks"
      style={{ left: placement.x, top: placement.y, width, maxHeight: Math.max(240, area.bottom - area.top - 16) }}
      onKeyDown={onKey}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="qt-head">
        <span className="qt-title">
          <Icon name="check" size={18} /> Tasks
        </span>
        <span className="tk-head-actions">
          <button
            className={`tk-view${view === "insights" ? " on" : ""}`}
            aria-pressed={view === "insights"}
            title={view === "insights" ? "Back to the list" : "Daily insights and timeline"}
            onClick={() => setView((v) => (v === "list" ? "insights" : "list"))}
          >
            <Icon name={view === "insights" ? "note" : "clock"} size={15} />
            <span>{view === "insights" ? "List" : "Insights"}</span>
          </button>
          <button className="qt-x" onClick={onClose} title="Close" aria-label="Close tasks">
            <Icon name="close" size={16} />
          </button>
        </span>
      </div>

      <div className="tk-day" role="group" aria-label="Day">
        <button className="qt-x" aria-label="Previous day" title="Previous day (←)" onClick={() => setDay((d) => addDays(d, -1))}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="tk-day-label" aria-live="polite">
          <strong>{dayLabel(day, today)}</strong>
          {dayLabel(day, today) !== dateLabel(day) && <small>{dateLabel(day)}</small>}
        </span>
        <button className="qt-x" aria-label="Next day" title="Next day (→)" onClick={() => setDay((d) => addDays(d, 1))}>
          <Icon name="chevronRight" size={16} />
        </button>
        <button className="mm-btn ghost small tk-today" disabled={day === today} onClick={() => setDay(today)}>
          Today
        </button>
      </div>

      <div className="tk-progress" aria-label={`${progress.done} of ${progress.total} done`}>
        <div className="mm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
          <span style={{ width: `${progress.pct}%` }} />
        </div>
        <span className="tk-progress-text">
          {progress.total ? `${progress.done} / ${progress.total} done · ${progress.pct}%` : "Nothing planned yet"}
        </span>
      </div>

      {store.issues.length > 0 && ready && (
        <p className="tk-notice" role="status">
          {!readOnly
            ? "Some tasks couldn't be read and were repaired; the original file was kept."
            : store.issues.includes("tasks could not be read")
              ? "Your task list couldn't be opened just now, so it's read-only. Nothing on disk was changed."
              : "These tasks were saved by a newer MewMuze, so they're read-only here."}
        </p>
      )}

      {editingTask && (
        <TaskEditor
          key={editingTask.id}
          task={editingTask}
          tasks={tasks}
          readOnly={readOnly}
          onPatch={(patch) => apply((d) => updateTask(d, editingTask.id, patch, now()))}
          onParent={(parentId) => apply((d) => reparent(d, editingTask.id, parentId, now()))}
          onClose={() => setEditing(null)}
          dayName={dayLabel(day, today)}
        />
      )}

      {view === "list" ? (
        <>
          <div className="tk-add">
            <Icon name="check" size={15} />
            <input
              ref={addRef}
              className="cp-input tk-add-input"
              placeholder={readOnly ? "Read-only" : "Add a task…"}
              aria-label="New task title"
              value={draft}
              disabled={!ready || readOnly}
              maxLength={200}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  add(draft);
                  setDraft("");
                }
              }}
            />
          </div>

          {leftOver.length > 0 && !readOnly && (
            <div className="tk-carry">
              <span>{leftOver.length === 1 ? "1 task was left unfinished." : `${leftOver.length} tasks were left unfinished.`}</span>
              <button className="mm-btn ghost small" onClick={() => apply((d) => leftOver.reduce((acc, t) => moveToDay(acc, t.id, today, now()), d))}>
                Move to today
              </button>
            </div>
          )}

          <ul className="tk-list" aria-label={`Tasks for ${dayLabel(day, today)}`}>
            {!ready && <li className="tk-empty">Loading…</li>}
            {ready && rows.length === 0 && <li className="tk-empty">{day === today ? "A clear day. Add something above." : "Nothing on this day."}</li>}
            {rows.map((r) => (
              <TaskRow
                key={r.task.id}
                row={r}
                selected={editing === r.task.id}
                menuOpen={menuFor === r.task.id}
                readOnly={readOnly}
                showMove={day !== today && r.task.parentId === null && !r.done}
                onToggle={() => apply((d) => setDone(d, r.task.id, !r.done, now()))}
                onEdit={() => setEditing((e) => (e === r.task.id ? null : r.task.id))}
                onMenu={() => setMenuFor((m) => (m === r.task.id ? null : r.task.id))}
                onAddSub={() => {
                  setMenuFor(null);
                  setAddingUnder(r.task.id);
                }}
                onDuplicate={() => {
                  setMenuFor(null);
                  apply((d) => duplicateTask(d, r.task.id, now()).doc);
                }}
                onMove={() => {
                  setMenuFor(null);
                  apply((d) => moveToDay(d, r.task.id, today, now()));
                }}
                onDelete={() => {
                  setMenuFor(null);
                  void remove(r.task);
                }}
                subInput={
                  addingUnder === r.task.id ? (
                    <SubtaskInput
                      depth={r.depth + 1}
                      onAdd={(title) => add(title, r.task.id)}
                      onDone={() => setAddingUnder(null)}
                    />
                  ) : null
                }
              />
            ))}
          </ul>
        </>
      ) : (
        <Insights tasks={tasks} day={day} now={now} onEdit={setEditing} />
      )}
    </div>
  );
}


// ---- one row -------------------------------------------------------------------------

function TaskRow(props: {
  row: ReturnType<typeof rowsFor>[number];
  selected: boolean;
  menuOpen: boolean;
  readOnly: boolean;
  showMove: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onMenu: () => void;
  onAddSub: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
  subInput: React.ReactNode;
}) {
  const { row, readOnly } = props;
  const t = row.task;
  const span = spanOf(t);
  const when = t.start ? (span ? `${t.start}–${span.end}` : t.start) : t.durationMin ? formatMinutes(t.durationMin) : "";
  return (
    <li className={`tk-row${row.done ? " done" : ""}${props.selected ? " selected" : ""}`} style={{ paddingLeft: 4 + row.depth * 18 }} data-depth={row.depth}>
      <div className="tk-line">
        <button
          className={`tk-check${row.done ? " on" : ""}${!row.leaf && !row.done && row.leavesDone ? " partial" : ""}`}
          role="checkbox"
          aria-checked={row.done ? true : !row.leaf && row.leavesDone ? "mixed" : false}
          aria-label={`${row.done ? "Reopen" : "Complete"} ${t.title}`}
          disabled={readOnly}
          onClick={props.onToggle}
        >
          {row.done && <Icon name="check" size={12} />}
        </button>
        <button
          className="tk-title"
          onClick={props.onEdit}
          onKeyDown={(e) => {
            if (e.key === "Delete" && !readOnly) {
              e.preventDefault();
              props.onDelete();
            }
          }}
          title="Edit"
        >
          <span className="tk-title-text">{t.title}</span>
          {!row.leaf && <span className="tk-count">{row.leavesDone}/{row.leaves}</span>}
          {span?.pastMidnight && <span className="tk-warn" title="Runs past midnight">↷</span>}
        </button>
        {when && <span className={`tk-when${t.start ? " timed" : ""}`}>{when}</span>}
        {!readOnly && (
          <button className="qt-x tk-more" aria-label={`More for ${t.title}`} aria-haspopup="menu" aria-expanded={props.menuOpen} onClick={props.onMenu}>
            <Icon name="more" size={15} />
          </button>
        )}
      </div>
      {t.notes && !props.selected && <p className="tk-notes">{t.notes}</p>}
      {props.menuOpen && (
        <div className="tk-menu" role="menu">
          <button role="menuitem" onClick={props.onEdit}>Edit</button>
          {row.depth < MAX_DEPTH && <button role="menuitem" onClick={props.onAddSub}>Add subtask</button>}
          <button role="menuitem" onClick={props.onDuplicate}>Duplicate</button>
          {props.showMove && <button role="menuitem" onClick={props.onMove}>Move to today</button>}
          <button role="menuitem" className="danger" onClick={props.onDelete}>Delete…</button>
        </div>
      )}
      {props.subInput}
    </li>
  );
}

function SubtaskInput({ depth, onAdd, onDone }: { depth: number; onAdd: (title: string) => void; onDone: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="tk-add sub" style={{ marginLeft: depth * 6 }}>
      <input
        className="cp-input tk-add-input"
        placeholder="Add a subtask…"
        aria-label="New subtask title"
        value={v}
        autoFocus
        maxLength={200}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !v.trim() && onDone()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) {
            onAdd(v);
            setV("");
          }
        }}
      />
    </div>
  );
}

// ---- the editor ----------------------------------------------------------------------------

function TaskEditor({
  task,
  tasks,
  readOnly,
  onPatch,
  onParent,
  onClose,
  dayName,
}: {
  task: Task;
  tasks: Task[];
  readOnly: boolean;
  onPatch: (p: Parameters<typeof updateTask>[2]) => void;
  onParent: (parentId: string | null) => void;
  onClose: () => void;
  dayName: string;
}) {
  const [title, setTitle] = useState(task.title);
  const span = spanOf(task);
  const parents = tasks.filter((t) => t.id !== task.id && canReparent(tasks, task.id, t.id));
  const commitTitle = () => {
    if (title.trim() && title !== task.title) onPatch({ title });
    else setTitle(task.title);
  };
  return (
    <div className="tk-editor" role="group" aria-label={`Edit ${task.title}`}>
      <input
        className="cp-input tk-edit-title"
        aria-label="Title"
        value={title}
        disabled={readOnly}
        maxLength={200}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitTitle();
            onClose();
          }
        }}
      />
      <textarea
        className="cp-input tk-edit-notes"
        aria-label="Notes"
        placeholder="Notes"
        rows={2}
        disabled={readOnly}
        defaultValue={task.notes}
        maxLength={4000}
        onBlur={(e) => e.target.value !== task.notes && onPatch({ notes: e.target.value })}
      />
      <div className="tk-edit-row">
        <label>
          <span>Start</span>
          <input className="sk-input" type="time" aria-label="Start time" disabled={readOnly} value={task.start ?? ""} onChange={(e) => onPatch({ start: e.target.value || null })} />
        </label>
        <label>
          <span>Estimate</span>
          <select
            className="sk-input"
            aria-label="Estimated duration"
            disabled={readOnly}
            value={task.durationMin ?? ""}
            onChange={(e) => onPatch({ durationMin: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">None</option>
            {[...new Set([...DURATIONS, ...(task.durationMin ? [task.durationMin] : [])])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {formatMinutes(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {span && (
        <p className={`tk-ends${span.pastMidnight ? " warn" : ""}`} role={span.pastMidnight ? "alert" : undefined}>
          {span.pastMidnight ? `Ends ${span.end} after midnight — it stays on ${dayName}.` : `Ends ${span.end}`}
        </p>
      )}
      <div className="tk-edit-row">
        <label className="grow">
          <span>Subtask of</span>
          <select className="sk-input" aria-label="Parent task" disabled={readOnly} value={task.parentId ?? ""} onChange={(e) => onParent(e.target.value || null)}>
            <option value="">None (top level)</option>
            {task.parentId && !parents.some((p) => p.id === task.parentId) && (
              <option value={task.parentId}>{tasks.find((t) => t.id === task.parentId)?.title}</option>
            )}
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <button className="sk-btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

// ---- Daily insights + one-day Gantt -----------------------------------------------------------

function Insights({ tasks, day, now, onEdit }: { tasks: Task[]; day: string; now: () => number; onEdit: (id: string) => void }) {
  // The current-time marker moves once a minute, and only while today is on screen.
  const [tick, setTick] = useState(() => now());
  const isToday = day === dayKey(tick);
  useEffect(() => {
    if (!isToday) return;
    const id = setInterval(() => setTick(now()), 60_000);
    return () => clearInterval(id);
  }, [isToday, now]);
  const ins = insightsFor(tasks, day, tick);
  const g = ganttFor(tasks, day, tick);
  const stats: [string, string][] = [
    ["Done", `${ins.done} / ${ins.total}`],
    ["Completion", `${ins.pct}%`],
    ["Estimated work", ins.estimatedMin ? formatMinutes(ins.estimatedMin) : "—"],
    ["Scheduled", ins.scheduledMin ? formatMinutes(ins.scheduledMin) : "—"],
    ["Remaining", ins.remainingMin ? formatMinutes(ins.remainingMin) : "—"],
    [isToday ? "Overdue" : "Left open", String(isToday ? ins.overdue.length : ins.open)],
  ];
  return (
    <div className="tk-insights">
      <div className="tk-stats">
        {stats.map(([k, v]) => (
          <div key={k} className={`tk-stat${k === "Overdue" && ins.overdue.length ? " alert" : ""}`}>
            <span>{k}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>

      <div className="qt-section">Timeline</div>
      <div className="tk-gantt" role="list" aria-label="Scheduled tasks timeline">
        <div className="tk-axis" aria-hidden="true">
          <span className="tk-axis-gutter" />
          <div className="tk-axis-track">
            {g.hours.map((h) => (
              <span key={h.min} style={{ left: `${h.left}%` }}>
                {h.label}
              </span>
            ))}
          </div>
        </div>
        {g.bars.length === 0 && <p className="tk-empty">Nothing scheduled. Give a task a start time to see it here.</p>}
        {g.bars.map((b) => (
          <div key={b.task.id} className={`tk-grow${b.done ? " done" : ""}`} role="listitem">
            <span className="tk-glabel" style={{ paddingLeft: b.depth * 12 }} title={b.task.title}>
              {b.task.title}
            </span>
            <div className="tk-gtrack">
              {g.hours.map((h) => (
                <i key={h.min} className="tk-grid" style={{ left: `${h.left}%` }} />
              ))}
              <button
                className={`tk-bar${b.marker ? " marker" : ""}${b.pastMidnight ? " overflow" : ""}`}
                style={{ left: `${b.left}%`, width: b.marker ? undefined : `${b.width}%` }}
                title={`${b.task.title} · ${b.task.start}${b.marker ? "" : `–${spanOf(b.task)!.end}`}${b.pastMidnight ? " (past midnight)" : ""}`}
                aria-label={`Edit ${b.task.title}, ${b.task.start}`}
                onClick={() => onEdit(b.task.id)}
              />
              {g.nowLeft !== null && <i className="tk-now" style={{ left: `${g.nowLeft}%` }} />}
            </div>
          </div>
        ))}
      </div>

      {g.unscheduled.length > 0 && (
        <>
          <div className="qt-section">Unscheduled</div>
          <ul className="tk-unscheduled">
            {g.unscheduled.map((r) => (
              <li key={r.task.id} style={{ paddingLeft: r.depth * 14 }} className={r.done ? "done" : ""}>
                <button className="tk-title" onClick={() => onEdit(r.task.id)}>
                  <span className="tk-title-text">{r.task.title}</span>
                  {r.task.durationMin ? <span className="tk-when">{formatMinutes(r.task.durationMin)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
