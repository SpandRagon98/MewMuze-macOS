import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalcTimePanel, CALC_PANEL_SIZE } from "../components/CalcTimePanel";
import { CatContextMenu } from "../components/OverlayUI";
import { overlaps, type Area, type Box } from "../quicktools/panelPlacement";
import { openSubmenu } from "./menuHelpers";

// A cat parked mid-screen with plenty of room on every side.
const cat: Box = { x: 700, y: 500, width: 64, height: 64 };
const area: Area = { left: 0, top: 0, right: 1920, bottom: 1032 };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

const panel = () => host.querySelector<HTMLElement>(".calc-tools");
const clickText = (selector: string, text: string) => {
  const el = [...host.querySelectorAll<HTMLElement>(selector)].find(
    (n) => n.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No ${selector} with text "${text}"`);
  act(() => el.click());
};

describe("Calc & Time: menu activation", () => {
  it("is no longer marked coming soon, and dispatches its command", () => {
    const seen: string[] = [];
    render(
      <CatContextMenu
        state={{ x: 10, y: 10 }}
        workMode={false}
        session={null}
        clipboardEnabled
        onCommand={(cmd) => seen.push(cmd)}
        onClose={() => undefined}
      />,
    );
    // It lives in the Quick Tools submenu.
    openSubmenu(host, "Quick Tools");
    const entry = [...host.querySelectorAll<HTMLElement>(".cat-menu-item")].find((n) =>
      n.textContent?.includes("Calculator & time"),
    );
    expect(entry, "the Calc & Time menu entry should exist").toBeTruthy();
    // The regression this guards: a `soon` item renders a badge and swallows
    // the click, which is exactly how this feature was disabled before.
    expect(entry!.className).not.toContain("soon");
    expect(entry!.querySelector(".cat-menu-soon")).toBeNull();

    act(() => entry!.click());
    expect(seen).toEqual(["calc-time"]);
  });

  it("Tasks is a working entry now, not a Coming soon badge", () => {
    const seen: string[] = [];
    render(
      <CatContextMenu
        state={{ x: 10, y: 10 }}
        workMode={false}
        session={null}
        clipboardEnabled
        onCommand={(c) => seen.push(c)}
        onClose={() => undefined}
      />,
    );
    openSubmenu(host, "Quick Tools");
    const tasks = [...host.querySelectorAll<HTMLElement>(".cat-menu-item")].find((n) =>
      n.textContent?.includes("Tasks"),
    );
    expect(tasks!.className).not.toContain("soon");
    expect(tasks!.querySelector(".cat-menu-soon")).toBeNull();
    act(() => tasks!.click());
    expect(seen).toEqual(["tasks"]);
  });
});

describe("Calc & Time: theme consistency", () => {
  it("reuses the shared panel classes rather than restyling", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    const el = panel()!;
    // `quick-tools` carries the skeuomorphic surface + the .sk-light variant;
    // `pixel-ui` the typography. Losing either means the panel drifts out of
    // theme, especially in light mode.
    expect(el.classList.contains("quick-tools")).toBe(true);
    expect(el.classList.contains("pixel-ui")).toBe(true);
  });

  it("uses the same header, section and button furniture as Quick Tools", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    expect(host.querySelector(".qt-head")).toBeTruthy();
    expect(host.querySelector(".qt-title")).toBeTruthy();
    expect(host.querySelector(".qt-x")).toBeTruthy();
    expect(host.querySelector(".qt-section")).toBeTruthy();
    clickText(".ct-chip", "Split bill");
    expect(host.querySelector(".pixel-btn")).toBeTruthy();
  });

  it("closes via the shared ✕ affordance", () => {
    let closed = false;
    render(<CalcTimePanel cat={cat} area={area} onClose={() => (closed = true)} />);
    act(() => host.querySelector<HTMLElement>(".qt-x")!.click());
    expect(closed).toBe(true);
  });
});

describe("Calc & Time: placement", () => {
  it("opens beside the cat and never covers it", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    const el = panel()!;
    const box: Box = {
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      width: CALC_PANEL_SIZE.width,
      height: CALC_PANEL_SIZE.height,
    };
    expect(overlaps(box, cat)).toBe(false);
    expect(el.dataset.side).toBeTruthy();
  });

  it("stays inside the work area when the cat is cornered", () => {
    const corner: Box = { x: 1850, y: 980, width: 64, height: 64 };
    render(<CalcTimePanel cat={corner} area={area} onClose={() => undefined} />);
    const el = panel()!;
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    expect(left).toBeGreaterThanOrEqual(area.left);
    expect(top).toBeGreaterThanOrEqual(area.top);
    expect(left + CALC_PANEL_SIZE.width).toBeLessThanOrEqual(area.right);
  });
});

describe("Calc & Time: tabs", () => {
  it("offers exactly the three tabs, calculator first", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    const tabs = [...host.querySelectorAll<HTMLElement>(".ct-tab")].map((t) => t.textContent);
    expect(tabs).toEqual(["Calculator", "Units", "Time"]);
    expect(host.querySelector(".ct-tab.active")!.textContent).toBe("Calculator");
  });

  it("switches to Units and shows the Value | From | swap | To row", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    clickText(".ct-tab", "Units");
    expect(host.querySelector(".ct-convert")).toBeTruthy();
    expect(host.querySelectorAll(".ct-convert select")).toHaveLength(2);
    expect(host.querySelector(".ct-swap")).toBeTruthy();
  });

  it("switches to Time and shows both searchable zone pickers", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    clickText(".ct-tab", "Time");
    expect(host.querySelectorAll(".ct-zone")).toHaveLength(2);
    expect(host.querySelectorAll(".ct-zone-search")).toHaveLength(2);
    expect(host.querySelector(".ct-time-big")).toBeTruthy();
  });
});

describe("Calc & Time: calculator behaviour", () => {
  it("previews a result live as the expression is typed", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    for (const key of ["1", "2", "×", "4"]) clickText(".ct-key", key);
    expect(host.querySelector(".ct-preview")!.textContent).toBe("= 48");
  });

  it("shows an error message instead of a wrong number", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    for (const key of ["1", "÷", "0"]) clickText(".ct-key", key);
    const preview = host.querySelector(".ct-preview")!;
    expect(preview.className).toContain("error");
    expect(preview.textContent).toContain("divide by zero");
  });

  it("records equals presses in the history tape", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    for (const key of ["8", "+", "9"]) clickText(".ct-key", key);
    clickText(".ct-key", "=");
    const rows = host.querySelectorAll(".ct-hist-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("17");
  });

  it("opens each money tool and computes it", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    clickText(".ct-chip", "GST / Tax");
    // Defaults are 1000 at 18%, added on top.
    expect(host.querySelector(".ct-result-value")!.textContent).toContain("1,180");

    clickText(".ct-chip", "Split bill");
    expect(host.querySelector(".ct-result-label")!.textContent).toBe("Each person");

    clickText(".ct-chip", "Margin");
    // cost 100 / sell 150 => the margin-vs-markup distinction is shown.
    const text = host.querySelector(".ct-result-value")!.textContent!;
    expect(text).toContain("margin 33.3%");
    expect(text).toContain("markup 50%");
  });
});

describe("Calc & Time: time conversion in the UI", () => {
  it("shows a day-shift badge when the date rolls over", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    clickText(".ct-tab", "Time");

    const [dateInput, timeInput] = host.querySelectorAll<HTMLInputElement>(".ct-datetime .ct-input");
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const selects = host.querySelectorAll<HTMLSelectElement>(".ct-zone select");
    const setSelect = (el: HTMLSelectElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    setSelect(selects[0], "Asia/Kolkata");
    setSelect(selects[1], "Australia/Sydney");
    setValue(dateInput, "2026-08-12");
    setValue(timeInput, "23:00");

    expect(host.querySelector(".ct-dayshift")!.textContent).toBe("next day");
  });

  it("switches between 12- and 24-hour display", () => {
    render(<CalcTimePanel cat={cat} area={area} onClose={() => undefined} />);
    clickText(".ct-tab", "Time");
    clickText(".ct-chip", "24h");
    expect(host.querySelector(".ct-time-big")!.textContent).toMatch(/^\d{2}:\d{2}$/);
    clickText(".ct-chip", "12h");
    expect(host.querySelector(".ct-time-big")!.textContent).toMatch(/(AM|PM)$/);
  });
});
