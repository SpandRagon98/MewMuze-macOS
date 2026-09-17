import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import appSource from "../App.tsx?raw";
import { TasksPanel, TASKS_PANEL_SIZE } from "../tasks/TasksPanel";
import { TaskStore, type TaskBridge } from "../tasks/taskStore";
import { addDays, addTask, setDone, type TaskDoc } from "../tasks/taskModel";
import { overlaps, type Area, type Box } from "../quicktools/panelPlacement";
import type { ConfirmOptions } from "../components/ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = "2026-09-14";
const at = (h: number, m = 0, d = 14) => new Date(2026, 8, d, h, m).getTime();
const cat: Box = { x: 700, y: 500, width: 64, height: 64 };
const area: Area = { left: 0, top: 0, right: 1920, bottom: 1032 };

let host: HTMLDivElement;
let root: Root;
let clock = at(10);
const now = () => clock;

beforeEach(() => {
  clock = at(10);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function memoryBridge(initial: TaskDoc | null = null): TaskBridge & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    load: async () => ({ main: initial ? JSON.stringify(initial) : null, backup: null }),
    save: async (json) => void saved.push(json),
    quarantine: async () => null,
  };
}

async function open(opts: { doc?: TaskDoc; onClose?: () => void; confirm?: (opts: ConfirmOptions) => Promise<boolean> } = {}) {
  const store = new TaskStore(memoryBridge(opts.doc ?? null), now);
  await store.load();
  await act(async () =>
    root.render(
      <TasksPanel cat={cat} area={area} store={store} onClose={opts.onClose ?? (() => undefined)} now={now} confirm={opts.confirm} />,
    ),
  );
  return store;
}

function seed(spec: { title: string; parent?: string; start?: string; dur?: number; day?: string }[]): TaskDoc {
  let doc: TaskDoc = { version: 1, tasks: [] };
  for (const s of spec) doc = addTask(doc, { day: s.day ?? DAY, title: s.title, parentId: s.parent, start: s.start, durationMin: s.dur }, at(9), s.title).doc;
  return doc;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const panel = () => $(".tasks-panel")!;
const titles = () => $$(".tk-row .tk-title-text").map((n) => n.textContent);
const dayText = () => $(".tk-day-label strong")!.textContent;
const click = (el: HTMLElement | null | undefined) => act(() => el!.click());
const byLabel = (label: string) => $(`[aria-label="${label}"]`);
const press = (el: HTMLElement, key: string) =>
  act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const menuItem = (text: string) => $$(".tk-menu button").find((b) => b.textContent === text);

describe("Tasks panel: part of the overlay", () => {
  it("uses the shared floating-panel shell", async () => {
    await open();
    expect(panel().classList.contains("quick-tools")).toBe(true);
    expect(panel().classList.contains("pixel-ui")).toBe(true);
    expect($(".qt-head .qt-title")!.textContent).toContain("Tasks");
    expect(panel().getAttribute("role")).toBe("dialog");
  });

  it("opens beside the cat without covering it, inside the work area", async () => {
    await open();
    const box: Box = { x: parseFloat(panel().style.left), y: parseFloat(panel().style.top), width: TASKS_PANEL_SIZE.width, height: TASKS_PANEL_SIZE.height };
    expect(overlaps(box, cat)).toBe(false);
    expect(box.x).toBeGreaterThanOrEqual(area.left);
    expect(box.x + box.width).toBeLessThanOrEqual(area.right);
  });

  it("keeps its own clicks and right-clicks from reaching the cat behind it", async () => {
    await open();
    const down = new Event("pointerdown", { bubbles: true });
    // The cat's own handlers live above the React root; the panel must not reach them.
    const outer = vi.fn();
    document.body.addEventListener("pointerdown", outer);
    act(() => void panel().dispatchEvent(down));
    document.body.removeEventListener("pointerdown", outer);
    expect(outer).not.toHaveBeenCalled();
    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void panel().dispatchEvent(ctx));
    expect(ctx.defaultPrevented).toBe(true);
  });

  it("closes from the ✕", async () => {
    const onClose = vi.fn();
    await open({ onClose });
    click(byLabel("Close tasks"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Tasks panel: quick add and progress", () => {
  it("adds a task with a title and Enter", async () => {
    const store = await open();
    const input = byLabel("New task title") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    type(input, "Call the vet");
    press(input, "Enter");
    expect(titles()).toEqual(["Call the vet"]);
    expect(input.value).toBe("");
    expect(store.get().tasks[0]).toMatchObject({ title: "Call the vet", day: DAY, start: null, durationMin: null });
    press(input, "Enter"); // empty: nothing
    expect(titles()).toHaveLength(1);
  });

  it("focuses quick add once the file has loaded, even on a first open", async () => {
    const store = new TaskStore(memoryBridge(), now);
    await act(async () => root.render(<TasksPanel cat={cat} area={area} store={store} onClose={() => undefined} now={now} />));
    expect(document.activeElement).toBe(byLabel("New task title"));
  });

  it("shows completed / total actionable with a percentage", async () => {
    await open({ doc: setDone(seed([{ title: "p" }, { title: "a", parent: "p" }, { title: "b", parent: "p" }, { title: "c" }]), "a", true, at(9)) });
    expect($(".tk-progress-text")!.textContent).toBe("1 / 3 done · 33%");
    expect($(".mm-progress")!.getAttribute("aria-valuenow")).toBe("33");
    // The parent shows its roll-up.
    expect($$(".tk-count")[0].textContent).toBe("1/2");
    expect(byLabel("Complete p")!.getAttribute("aria-checked")).toBe("mixed");
  });

  it("completes and reopens from the checkbox, and a parent's box completes its subtasks", async () => {
    await open({ doc: seed([{ title: "p" }, { title: "a", parent: "p" }, { title: "b", parent: "p" }]) });
    click(byLabel("Complete a"));
    expect(byLabel("Reopen a")!.getAttribute("aria-checked")).toBe("true");
    click(byLabel("Complete p"));
    expect($(".tk-progress-text")!.textContent).toBe("2 / 2 done · 100%");
    click(byLabel("Reopen p"));
    expect($(".tk-progress-text")!.textContent).toBe("0 / 2 done · 0%");
  });

  it("adds a subtask from the row menu", async () => {
    await open({ doc: seed([{ title: "Trip" }]) });
    click(byLabel("More for Trip"));
    click(menuItem("Add subtask"));
    const sub = byLabel("New subtask title") as HTMLInputElement;
    type(sub, "Pack");
    press(sub, "Enter");
    const sub1 = $$(".tk-row").find((r) => r.dataset.depth === "1")!;
    expect(sub1.querySelector(".tk-title-text")!.textContent).toBe("Pack");
    expect($$(".tk-count")[0].textContent).toBe("0/1");
  });

  it("duplicates from the row menu", async () => {
    await open({ doc: seed([{ title: "Stretch" }]) });
    click(byLabel("More for Stretch"));
    click(menuItem("Duplicate"));
    expect(titles()).toEqual(["Stretch", "Stretch (copy)"]);
  });

  it("deletes only after confirming", async () => {
    let answer = false;
    const confirm = vi.fn(async (_opts: ConfirmOptions) => answer);
    await open({ doc: seed([{ title: "Old" }, { title: "kid", parent: "Old" }]), confirm });
    click(byLabel("More for Old"));
    await act(async () => menuItem("Delete…")!.click());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete "Old"?', danger: true }));
    expect(confirm.mock.calls[0][0].message).toContain("subtask");
    expect(titles()).toEqual(["Old", "kid"]);
    answer = true;
    click(byLabel("More for Old"));
    await act(async () => menuItem("Delete…")!.click());
    expect(titles()).toEqual([]);
  });
});

describe("Tasks panel: editing and scheduling", () => {
  it("edits a task and shows its end time", async () => {
    const store = await open({ doc: seed([{ title: "Report" }]) });
    click($(".tk-title"));
    const start = byLabel("Start time") as HTMLInputElement;
    type(start, "09:30");
    const est = byLabel("Estimated duration") as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(est, "45");
      est.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect($(".tk-ends")!.textContent).toBe("Ends 10:15");
    expect(store.get().tasks[0]).toMatchObject({ start: "09:30", durationMin: 45 });
    expect($(".tk-when")!.textContent).toBe("09:30–10:15");
  });

  it("warns when a task runs past midnight and keeps it on its day", async () => {
    await open({ doc: seed([{ title: "Late", start: "23:30", dur: 90 }]) });
    click($(".tk-title"));
    const ends = $(".tk-ends")!;
    expect(ends.classList.contains("warn")).toBe(true);
    expect(ends.getAttribute("role")).toBe("alert");
    expect(ends.textContent).toContain("after midnight");
    expect(ends.textContent).toContain("stays on Today");
    expect($(".tk-warn")).toBeTruthy();
  });

  it("offers only parents that cannot make a loop", async () => {
    await open({ doc: seed([{ title: "a" }, { title: "b", parent: "a" }, { title: "c" }]) });
    click($$(".tk-title")[0]); // edit a
    const opts = [...(byLabel("Parent task") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts).toContain("c");
    expect(opts).not.toContain("a");
    expect(opts).not.toContain("b"); // its own subtask
  });
});

describe("Tasks panel: days", () => {
  it("navigates days with the buttons and comes back with Today", async () => {
    await open({ doc: seed([{ title: "today's" }, { title: "yesterday's", day: addDays(DAY, -1) }]) });
    expect(dayText()).toBe("Today");
    expect((byLabel("Previous day")!.parentElement!.querySelector(".tk-today") as HTMLButtonElement).disabled).toBe(true);
    click(byLabel("Previous day"));
    expect(dayText()).toBe("Yesterday");
    expect(titles()).toEqual(["yesterday's"]);
    click(byLabel("Next day"));
    click(byLabel("Next day"));
    expect(dayText()).toBe("Tomorrow");
    click($(".tk-today"));
    expect(dayText()).toBe("Today");
    expect(titles()).toEqual(["today's"]);
  });

  it("offers Move to today for unfinished work, and moves nothing by itself", async () => {
    const store = await open({ doc: seed([{ title: "left", day: addDays(DAY, -1) }]) });
    expect(titles()).toEqual([]);
    click(byLabel("Previous day"));
    expect($(".tk-carry")!.textContent).toContain("1 task was left unfinished.");
    click($$(".tk-carry button")[0]);
    expect(store.get().tasks[0].day).toBe(DAY);
    click($(".tk-today"));
    expect(titles()).toEqual(["left"]);
  });

  it("rolls Today over at local midnight, keeping the previous day", async () => {
    vi.useFakeTimers();
    clock = at(23, 59);
    await open({ doc: seed([{ title: "late night" }]) });
    expect(dayText()).toBe("Today");
    expect(titles()).toEqual(["late night"]);
    clock = at(0, 0, 15) + 100;
    act(() => void vi.advanceTimersByTime(61_000));
    expect(dayText()).toBe("Today");
    expect(titles()).toEqual([]);
    click(byLabel("Previous day"));
    expect(dayText()).toBe("Yesterday");
    expect(titles()).toEqual(["late night"]);
  });
});

describe("Tasks panel: keyboard", () => {
  it("arrows change day, T goes to today, I opens insights", async () => {
    await open();
    press(panel(), "ArrowLeft");
    expect(dayText()).toBe("Yesterday");
    press(panel(), "ArrowRight");
    press(panel(), "ArrowRight");
    expect(dayText()).toBe("Tomorrow");
    press(panel(), "t");
    expect(dayText()).toBe("Today");
    press(panel(), "i");
    expect($(".tk-insights")).toBeTruthy();
    press(panel(), "I");
    expect($(".tk-insights")).toBeNull();
  });

  it("ignores those keys while typing", async () => {
    await open();
    const input = byLabel("New task title") as HTMLInputElement;
    press(input, "ArrowLeft");
    press(input, "t");
    expect(dayText()).toBe("Today");
  });

  it("Escape steps back: menu, then editor, then the panel", async () => {
    const onClose = vi.fn();
    await open({ doc: seed([{ title: "a" }]), onClose });
    click(byLabel("More for a"));
    expect($(".tk-menu")).toBeTruthy();
    press(panel(), "Escape");
    expect($(".tk-menu")).toBeNull();
    click($(".tk-title"));
    expect($(".tk-editor")).toBeTruthy();
    press(panel(), "Escape");
    expect($(".tk-editor")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    press(byLabel("New task title")!, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape in a half-typed title does not throw the text away by closing", async () => {
    const onClose = vi.fn();
    await open({ onClose });
    const input = byLabel("New task title") as HTMLInputElement;
    type(input, "half");
    press(input, "Escape");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Tasks panel: Insights and timeline", () => {
  const doc = () =>
    setDone(
      seed([
        { title: "Standup", start: "09:00", dur: 30 },
        { title: "Build", start: "11:00", dur: 120 },
        { title: "step", parent: "Build", start: "11:00", dur: 60 },
        { title: "Inbox" },
      ]),
      "Standup",
      true,
      at(9),
    );

  it("shows the day's numbers", async () => {
    await open({ doc: doc() });
    click($(".tk-view"));
    expect($(".tk-view")!.getAttribute("aria-pressed")).toBe("true");
    const stats = Object.fromEntries($$(".tk-stat").map((s) => [s.querySelector("span")!.textContent, s.querySelector("strong")!.textContent]));
    expect(stats).toMatchObject({ Done: "1 / 3", Completion: "33%", "Estimated work": "1 h 30 min", Scheduled: "2 h 30 min", Remaining: "1 h", Overdue: "0" });
  });

  it("draws the Gantt with indented subtasks, a now marker and the unscheduled list", async () => {
    await open({ doc: doc() });
    press(panel(), "i");
    const bars = $$(".tk-bar");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual(["Edit Standup, 09:00", "Edit Build, 11:00", "Edit step, 11:00"]);
    expect(bars[1].style.left).toBe("25%"); // 11:00 on an 08:00-20:00 axis
    expect($$(".tk-glabel")[2].style.paddingLeft).toBe("12px");
    expect($(".tk-now")).toBeTruthy();
    expect($$(".tk-unscheduled .tk-title-text").map((n) => n.textContent)).toEqual(["Inbox"]);
    expect($(".tasks-panel")!.classList.contains("wide")).toBe(true);
  });

  it("clicking a bar opens that task's editor", async () => {
    await open({ doc: doc() });
    press(panel(), "i");
    click($$(".tk-bar")[1]);
    expect(($(".tk-edit-title") as HTMLInputElement).value).toBe("Build");
  });

  it("has no current-time marker on another day", async () => {
    await open({ doc: seed([{ title: "x", start: "10:00", dur: 30, day: addDays(DAY, 1) }]) });
    press(panel(), "ArrowRight");
    press(panel(), "i");
    expect($(".tk-bar")).toBeTruthy();
    expect($(".tk-now")).toBeNull();
    expect($$(".tk-stat span").map((s) => s.textContent)).toContain("Left open");
  });
});

describe("Tasks panel: wiring in the overlay (App.tsx)", () => {
  const APP: string = appSource;

  it("the right-click Tasks entry toggles the panel beside the cat", () => {
    const block = APP.slice(APP.indexOf('case "tasks":'), APP.indexOf('case "tasks":') + 300);
    expect(block).toContain("closeTasksPanel()");
    expect(block).toContain("setTasksUI({ cat: catCssBox(), area: catCssArea() })");
  });

  it("saves on close, on quit and when the page goes away", () => {
    expect(APP.slice(APP.indexOf("const closeTasksPanel"), APP.indexOf("const closeTasksPanel") + 120)).toContain("taskStore.flush()");
    const quitting = APP.slice(APP.indexOf('listen("app-quitting"'), APP.indexOf('listen("app-quitting"') + 160);
    expect(quitting).toContain("void taskStore.flush();");
    expect(APP).toContain('window.addEventListener("pagehide", onPageHide)');
    // Quit waits for the tasks write (alongside the Diary's) before the app goes.
    expect(APP).toMatch(/Promise\.allSettled\(\[taskStore\.flush\(\), [^\]]+\]\)\.finally\(\(\) => void invokeSafe\("quit_app"\)\)/);
  });

  it("follows the fullscreen retreat", () => {
    const retreat = APP.slice(APP.indexOf('case "retreat":'), APP.indexOf('case "fadeOut":'));
    expect(retreat).toContain("closeTasksPanel()");
  });
});
