import { describe, expect, it } from "vitest";
// Vitest stubs CSS imports (even with ?raw), so the stylesheet is read from
// disk. @ts-expect-error: no @types/node in this project's `types` list.
// @ts-expect-error -- node:fs is available at runtime under vitest.
import { readFileSync } from "node:fs";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import panelSource from "../components/QuickToolsPanel.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import sheetsSource from "../components/SpreadsheetTools.tsx?raw";
import { isCsvPath, withExtension } from "../quicktools/sheets";

// Relative to the project root, which is vitest's working directory.
const css: string = readFileSync("src/components/ui.css", "utf8");
const panel: string = panelSource;
const sheets: string = sheetsSource;

describe("spreadsheet path helpers", () => {
  it("recognises delimited text by extension, case-insensitively", () => {
    expect(isCsvPath("C:\\data\\books.csv")).toBe(true);
    expect(isCsvPath("C:\\data\\BOOKS.CSV")).toBe(true);
    expect(isCsvPath("/home/a/notes.txt")).toBe(true);
    expect(isCsvPath("C:\\data\\books.xlsx")).toBe(false);
    // A .csv earlier in the path must not count as the file's own type.
    expect(isCsvPath("C:\\csv\\books.xlsx")).toBe(false);
  });

  it("suggests a save name by swapping the extension", () => {
    expect(withExtension("C:\\data\\books.csv", "xlsx")).toBe("books.xlsx");
    expect(withExtension("/home/a/report.xlsx", "csv")).toBe("report.csv");
    // A name with no extension still gains one rather than going out bare.
    expect(withExtension("C:\\data\\books", "xlsx")).toBe("books.xlsx");
    expect(withExtension("C:\\a.b\\my.data.csv", "xlsx")).toBe("my.data.xlsx");
  });
});

describe("spreadsheet tools reuse the existing visual language", () => {
  it("styles the category cards and Back control for both themes", () => {
    for (const rule of [".qt-card", ".qt-back", ".qt-preview", ".qt-sheets", ".qt-check"]) {
      expect(css, `${rule} has no dark style`).toContain(`${rule} {`);
    }
    // Light theme is an override layer; anything with its own surface colour
    // needs one or it renders as a dark block on the light card.
    for (const rule of [".qt-card", ".qt-preview", ".qt-sheets"]) {
      expect(css, `${rule} has no .sk-light override`).toContain(`.sk-light ${rule}`);
    }
  });

  it("gives the tactile hover and pressed states the other controls have", () => {
    expect(css).toContain(".qt-card:hover");
    expect(css).toContain(".qt-card:active");
    // Keyboard users need a visible focus ring, not just a hover state.
    expect(css).toContain(".qt-card:focus-visible");
    expect(css).toContain(".qt-back:focus-visible");
  });

  it("borrows Quick Tools' own classes rather than inventing a second style", () => {
    for (const cls of ["qt-section", "qt-row", "qt-hint", "qt-file", "qt-status", "pixel-btn"]) {
      expect(sheets, `SpreadsheetTools does not use ${cls}`).toContain(cls);
    }
  });
});

describe("Work Mode panel wiring", () => {
  it("renders each view exclusively, so tools never stack", () => {
    expect(panel).toContain('view === "menu"');
    expect(panel).toContain('view === "pdf"');
    expect(panel).toContain('view === "sheets"');
  });

  it("re-places the panel when the view changes size", () => {
    // The menu, PDF and spreadsheet views are different heights; without this
    // the panel can overhang the work area or cover the cat after a switch.
    expect(panel).toMatch(/\}, \[cat, area, view\]\)/);
  });

  it("still routes PDF work through the untouched convert bridge", () => {
    for (const fn of ["imagesToPdf", "pdfToImages", "mergePdfs", "splitPdf"]) {
      expect(panel, `PDF tool ${fn} is no longer wired up`).toContain(fn);
    }
  });

  it("cancels any in-flight spreadsheet work when the panel unmounts", () => {
    // Closing Work Mode must not leave a conversion running behind it.
    expect(sheets).toContain("cancelSheetOp");
    expect(sheets).toMatch(/return \(\) => \{\s*void cancelSheetOp\(\)/);
  });

  it("never offers to write over the file being read", () => {
    expect(sheets).toContain("That is the file you are converting");
    expect(sheets).toContain("That is one of the files being merged");
  });
});
