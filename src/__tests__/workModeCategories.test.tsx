import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickToolsPanel } from "../components/QuickToolsPanel";

// The panel only reaches Tauri through these two bridges; stubbing them keeps
// the test on the navigation itself rather than on IPC.
vi.mock("../quicktools/convert", async () => {
  const actual = await vi.importActual<typeof import("../quicktools/convert")>(
    "../quicktools/convert",
  );
  return {
    ...actual,
    convertSupport: vi.fn(async () => ({ pdfRender: true, reason: "" })),
    onPdfProgress: vi.fn(async () => () => undefined),
    pickFolder: vi.fn(async () => null),
  };
});

vi.mock("../quicktools/sheets", async () => {
  const actual = await vi.importActual<typeof import("../quicktools/sheets")>(
    "../quicktools/sheets",
  );
  return {
    ...actual,
    onSheetProgress: vi.fn(async () => () => undefined),
    cancelSheetOp: vi.fn(async () => undefined),
  };
});

const cat = { x: 400, y: 400, width: 64, height: 64 };
const area = { left: 0, top: 0, right: 1920, bottom: 1080 };

let host: HTMLDivElement;
let root: Root;

const render = async () => {
  await act(async () => {
    root.render(<QuickToolsPanel cat={cat} area={area} onClose={() => undefined} />);
  });
};

/** Click the first button whose visible text contains `text`. */
const clickButton = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`No button containing "${text}"`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("Work Mode category selector", () => {
  it("opens on the category menu, not straight into a tool", async () => {
    await render();
    expect(host.textContent).toContain("PDF Tools");
    expect(host.textContent).toContain("Spreadsheet Tools");
    // Neither tool's controls are mounted yet.
    expect(host.textContent).not.toContain("Images → PDF");
    expect(host.textContent).not.toContain("CSV ↔ XLSX Converter");
  });

  it("opens the existing PDF tools unchanged", async () => {
    await render();
    await clickButton("PDF Tools");

    // Every section and control the panel had before the category selector.
    for (const section of ["Images → PDF", "PDF → Images", "Merge PDF", "Split PDF"]) {
      expect(host.textContent, `missing "${section}"`).toContain(section);
    }
    for (const control of ["Choose images…", "Make PDF", "Choose PDF…", "Add PDFs…", "Export"]) {
      expect(host.textContent, `missing "${control}"`).toContain(control);
    }
    // And none of the spreadsheet UI leaks into it.
    expect(host.textContent).not.toContain("CSV ↔ XLSX Converter");
  });

  it("opens the spreadsheet tools with all three utilities", async () => {
    await render();
    await clickButton("Spreadsheet Tools");

    expect(host.textContent).toContain("CSV ↔ XLSX Converter");
    expect(host.textContent).toContain("Merge Spreadsheet Files");
    expect(host.textContent).toContain("Split Excel Workbook");
    // PDF tools are not mounted alongside them.
    expect(host.textContent).not.toContain("Images → PDF");
  });

  it("returns to the category menu from either tool via Back", async () => {
    await render();

    await clickButton("Spreadsheet Tools");
    expect(host.textContent).toContain("CSV ↔ XLSX Converter");
    await clickButton("Spreadsheet Tools"); // the Back control, now in the header
    expect(host.textContent).toContain("PDF Tools");
    expect(host.textContent).not.toContain("CSV ↔ XLSX Converter");

    await clickButton("PDF Tools");
    expect(host.textContent).toContain("Images → PDF");
    await clickButton("PDF Tools"); // Back again
    expect(host.textContent).toContain("Spreadsheet Tools");
    expect(host.textContent).not.toContain("Images → PDF");
  });

  it("gives the menu and Back control keyboard-reachable buttons", async () => {
    await render();
    const cards = [...host.querySelectorAll<HTMLButtonElement>(".qt-card")];
    expect(cards).toHaveLength(2);
    // Real <button>s, so Tab and Enter work without extra key handling.
    for (const card of cards) expect(card.tagName).toBe("BUTTON");

    await clickButton("Spreadsheet Tools");
    const back = host.querySelector<HTMLButtonElement>(".qt-back");
    expect(back?.tagName).toBe("BUTTON");
    expect(back?.getAttribute("aria-label")).toBe("Back to Quick Tools");
  });

  it("keeps the close button available in every view", async () => {
    await render();
    expect(host.querySelector(".qt-x")).not.toBeNull();
    await clickButton("PDF Tools");
    expect(host.querySelector(".qt-x")).not.toBeNull();
    await clickButton("PDF Tools");
    await clickButton("Spreadsheet Tools");
    expect(host.querySelector(".qt-x")).not.toBeNull();
  });
});
