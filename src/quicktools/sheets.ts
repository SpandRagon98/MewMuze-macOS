// Spreadsheet bridge for Work Mode. Mirrors convert.ts: it deliberately
// bypasses App's invokeSafe, whose 4s watchdog is for wedged status polls
// rather than a real conversion the user is watching progress for.
//
// Everything here is local. No uploads, no telemetry, no background service.

export type Delimiter = "comma" | "semicolon" | "tab" | "pipe";
export type MergeMode = "columns" | "sheets";

export interface SheetInfo {
  sheets: string[];
  rows: number;
}

export interface SheetPreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

export interface MergeSummary {
  output: string;
  files: number;
  rows: number;
  sheets: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

const SPREADSHEET_EXTS = ["csv", "txt", "xlsx", "xlsm", "xls", "ods"];

export async function pickSpreadsheet(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Spreadsheets", extensions: SPREADSHEET_EXTS }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export async function pickSpreadsheets(): Promise<string[]> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      filters: [{ name: "Spreadsheets", extensions: SPREADSHEET_EXTS }],
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    return [];
  }
}

export async function pickWorkbook(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Excel workbook", extensions: ["xlsx", "xlsm", "xls", "ods"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export async function pickDestination(
  defaultName: string,
  kind: "xlsx" | "csv",
): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      defaultPath: defaultName,
      filters:
        kind === "xlsx"
          ? [{ name: "Excel workbook", extensions: ["xlsx"] }]
          : [{ name: "CSV", extensions: ["csv"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export function sheetInfo(path: string): Promise<SheetInfo> {
  return invoke<SheetInfo>("sheet_info", { path });
}

export function sheetPreview(
  path: string,
  sheet: string,
  delimiter: Delimiter,
): Promise<SheetPreview> {
  return invoke<SheetPreview>("sheet_preview", { path, sheet, delimiter });
}

export function csvToXlsx(
  input: string,
  output: string,
  delimiter: Delimiter,
  overwrite: boolean,
): Promise<string> {
  return invoke<string>("csv_to_xlsx", { input, output, delimiter, overwrite });
}

export function xlsxToCsv(
  input: string,
  sheet: string,
  output: string,
  delimiter: Delimiter,
  overwrite: boolean,
): Promise<string> {
  return invoke<string>("xlsx_to_csv", { input, sheet, output, delimiter, overwrite });
}

export function mergeSheets(
  paths: string[],
  output: string,
  mode: MergeMode,
  addSourceColumn: boolean,
  delimiter: Delimiter,
  overwrite: boolean,
): Promise<MergeSummary> {
  return invoke<MergeSummary>("merge_sheets", {
    paths,
    output,
    mode,
    addSourceColumn,
    delimiter,
    overwrite,
  });
}

export function splitWorkbook(
  path: string,
  sheets: string[],
  outputDir: string,
  asCsv: boolean,
  delimiter: Delimiter,
): Promise<string[]> {
  return invoke<string[]>("split_workbook", { path, sheets, outputDir, asCsv, delimiter });
}

/** Ask the running operation to stop at its next checkpoint. */
export function cancelSheetOp(): Promise<void> {
  return invoke<void>("cancel_sheet_op");
}

/** `{done,total}` while a merge/split runs. Returns an unlisten function. */
export async function onSheetProgress(
  handler: (done: number, total: number) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ done: number; total: number }>("sheet-progress", (e) =>
      handler(e.payload.done, e.payload.total),
    );
  } catch {
    return () => {};
  }
}

/** Swap a path's extension, for suggesting a save name. */
export function withExtension(path: string, ext: string): string {
  const name = path.split(/[\\/]/).pop() || path;
  return name.replace(/(\.[^.]+)?$/, `.${ext}`);
}

/** True when the path looks like delimited text rather than a workbook. */
export function isCsvPath(path: string): boolean {
  return /\.(csv|txt)$/i.test(path);
}
