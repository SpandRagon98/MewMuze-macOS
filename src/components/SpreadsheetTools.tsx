import { useEffect, useState } from "react";
import {
  cancelSheetOp,
  csvToXlsx,
  isCsvPath,
  mergeSheets,
  onSheetProgress,
  pickDestination,
  pickSpreadsheet,
  pickSpreadsheets,
  pickWorkbook,
  sheetInfo,
  sheetPreview,
  splitWorkbook,
  withExtension,
  xlsxToCsv,
  type Delimiter,
  type MergeMode,
  type SheetPreview,
} from "../quicktools/sheets";
import { baseName, countLabel, pickFolder } from "../quicktools/convert";

type Busy = null | "convert" | "merge" | "split";

/**
 * Spreadsheet half of Work Mode. Everything runs locally through the Rust
 * commands in `sheets.rs`; this component only collects choices and reports
 * what happened. It reuses Quick Tools' own classes, so it inherits the
 * existing theme, light/dark handling and tactile states rather than
 * introducing a second visual language.
 */
export function SpreadsheetTools() {
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [delimiter, setDelimiter] = useState<Delimiter>("comma");

  // Convert
  const [source, setSource] = useState<string | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  const [preview, setPreview] = useState<SheetPreview | null>(null);

  // Merge
  const [mergeList, setMergeList] = useState<string[]>([]);
  const [mergeMode, setMergeMode] = useState<MergeMode>("columns");
  const [addSource, setAddSource] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Split
  const [book, setBook] = useState<string | null>(null);
  const [bookSheets, setBookSheets] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [splitAsCsv, setSplitAsCsv] = useState(false);

  const working = busy !== null;
  const csvSource = source !== null && isCsvPath(source);

  const run = async (kind: Busy, fn: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setStatus("");
    setProgress("");
    // Only listen while work is in flight, so an idle panel registers no
    // handler and adds nothing to idle CPU.
    const unlisten = await onSheetProgress((done, total) =>
      setProgress(total > 1 ? `${done}/${total}` : ""),
    );
    try {
      setStatus(await fn());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      unlisten();
      setBusy(null);
      setProgress("");
    }
  };

  const label = (kind: Busy, idle: string) =>
    busy !== kind ? idle : progress ? `${progress}…` : "Working…";

  // ---- Convert ----
  const onChooseSource = async () => {
    const picked = await pickSpreadsheet();
    if (!picked) return;
    setSource(picked);
    setPreview(null);
    setStatus("");
    setError("");
    setSheets([]);
    setSheet("");
    if (!isCsvPath(picked)) {
      try {
        const info = await sheetInfo(picked);
        setSheets(info.sheets);
        setSheet(info.sheets[0] ?? "");
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      }
    }
  };

  const onPreview = async () => {
    if (!source) return;
    setError("");
    try {
      setPreview(await sheetPreview(source, sheet, delimiter));
    } catch (err) {
      setPreview(null);
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const onConvert = () =>
    run("convert", async () => {
      if (!source) return "";
      const toXlsx = csvSource;
      const out = await pickDestination(
        withExtension(source, toXlsx ? "xlsx" : "csv"),
        toXlsx ? "xlsx" : "csv",
      );
      if (!out) return "";
      // The native save dialog already confirms replacing an existing file,
      // but it cannot know the source is also the destination.
      if (out === source) {
        throw new Error("That is the file you are converting. Choose a different name.");
      }
      const written = toXlsx
        ? await csvToXlsx(source, out, delimiter, true)
        : await xlsxToCsv(source, sheet, out, delimiter, true);
      return `Saved ${baseName(written)}.`;
    });

  // ---- Merge ----
  const onAddMerge = async () => {
    const picked = await pickSpreadsheets();
    if (!picked.length) return;
    setMergeList((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))]);
    setStatus("");
    setError("");
  };

  /** Move one entry by `delta`, clamped. Order decides merge order. */
  const moveMerge = (index: number, delta: number) =>
    setMergeList((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  /** Drag reorder: lift `from` out and drop it at `to`. */
  const dropMerge = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    if (from === null || from === to) return;
    setMergeList((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const onMerge = () =>
    run("merge", async () => {
      const out = await pickDestination("merged.xlsx", "xlsx");
      if (!out) return "";
      if (mergeList.includes(out)) {
        throw new Error("That is one of the files being merged. Choose a different name.");
      }
      const res = await mergeSheets(mergeList, out, mergeMode, addSource, delimiter, true);
      return mergeMode === "sheets"
        ? `Saved ${baseName(res.output)} — ${countLabel(res.sheets, "worksheet")} from ${countLabel(res.files, "file")}.`
        : `Saved ${baseName(res.output)} — ${countLabel(res.rows, "row")} from ${countLabel(res.files, "file")}.`;
    });

  // ---- Split ----
  const onChooseBook = async () => {
    const picked = await pickWorkbook();
    if (!picked) return;
    setBook(picked);
    setStatus("");
    setError("");
    try {
      const info = await sheetInfo(picked);
      setBookSheets(info.sheets);
      setChosen(info.sheets);
    } catch (err) {
      setBookSheets([]);
      setChosen([]);
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const toggleSheet = (name: string) =>
    setChosen((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));

  const onSplit = () =>
    run("split", async () => {
      if (!book) return "";
      const dir = await pickFolder();
      if (!dir) return "";
      const written = await splitWorkbook(book, chosen, dir, splitAsCsv, delimiter);
      return `Wrote ${countLabel(written.length, "file")} to ${baseName(dir)}.`;
    });

  // Cancel any in-flight operation if the panel closes mid-run, so a
  // background conversion cannot outlive the UI that started it.
  useEffect(() => {
    return () => {
      void cancelSheetOp().catch(() => {});
    };
  }, []);

  return (
    <>
      <div className="qt-section">CSV ↔ XLSX Converter</div>
      <div className="qt-row">
        <button className="pixel-btn" onClick={onChooseSource} disabled={working}>
          Choose file…
        </button>
        <span className="qt-file">{source ? baseName(source) : "none chosen"}</span>
      </div>
      {source && !csvSource && sheets.length > 0 && (
        <div className="qt-row">
          <select
            value={sheet}
            onChange={(e) => {
              setSheet(e.target.value);
              setPreview(null);
            }}
            disabled={working}
            aria-label="Worksheet"
          >
            {sheets.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="qt-hint">worksheet to export</span>
        </div>
      )}
      <div className="qt-row">
        <select
          value={delimiter}
          onChange={(e) => {
            setDelimiter(e.target.value as Delimiter);
            setPreview(null);
          }}
          disabled={working}
          aria-label="CSV delimiter"
        >
          <option value="comma">Comma</option>
          <option value="semicolon">Semicolon</option>
          <option value="tab">Tab</option>
          <option value="pipe">Pipe</option>
        </select>
        <button className="pixel-btn" onClick={onPreview} disabled={working || !source}>
          Preview
        </button>
        <button className="pixel-btn primary" onClick={onConvert} disabled={working || !source}>
          {label("convert", csvSource ? "To XLSX" : "To CSV")}
        </button>
      </div>
      {preview && (
        <div className="qt-preview" role="region" aria-label="File preview">
          <table>
            <thead>
              <tr>
                {preview.headers.map((h, i) => (
                  <th key={i}>{h || "—"}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, r) => (
                <tr key={r}>
                  {preview.headers.map((_, c) => (
                    <td key={c}>{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="qt-hint">
            {countLabel(preview.totalRows, "row")} total
            {preview.truncated ? ", first few shown" : ""}
          </div>
        </div>
      )}

      <div className="qt-section">Merge Spreadsheet Files</div>
      <div className="qt-row">
        <button className="pixel-btn" onClick={onAddMerge} disabled={working}>
          Add files…
        </button>
        <span className="qt-file">
          {mergeList.length ? countLabel(mergeList.length, "file") : "none chosen"}
        </span>
        {mergeList.length > 0 && (
          <button
            className="pixel-btn"
            onClick={() => setMergeList([])}
            disabled={working}
            title="Remove all"
          >
            Clear
          </button>
        )}
      </div>
      {mergeList.length > 0 && (
        <ol className="qt-list">
          {mergeList.map((p, i) => (
            <li
              key={p}
              className={`qt-list-row${dragIndex === i ? " dragging" : ""}`}
              draggable={!working}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropMerge(i)}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className="qt-list-num">{i + 1}.</span>
              <span className="qt-list-name" title={p}>
                {baseName(p)}
              </span>
              <button
                className="qt-mini"
                onClick={() => moveMerge(i, -1)}
                disabled={working || i === 0}
                title="Move up"
                aria-label={`Move ${baseName(p)} up`}
              >
                ↑
              </button>
              <button
                className="qt-mini"
                onClick={() => moveMerge(i, 1)}
                disabled={working || i === mergeList.length - 1}
                title="Move down"
                aria-label={`Move ${baseName(p)} down`}
              >
                ↓
              </button>
              <button
                className="qt-mini"
                onClick={() => setMergeList((prev) => prev.filter((x) => x !== p))}
                disabled={working}
                title="Remove"
                aria-label={`Remove ${baseName(p)}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="qt-row">
        <select
          value={mergeMode}
          onChange={(e) => setMergeMode(e.target.value as MergeMode)}
          disabled={working}
          aria-label="Merge mode"
        >
          <option value="columns">Matching columns</option>
          <option value="sheets">Separate worksheets</option>
        </select>
        <button
          className="pixel-btn primary"
          onClick={onMerge}
          disabled={working || mergeList.length < 2}
        >
          {label("merge", "Merge")}
        </button>
      </div>
      {mergeMode === "columns" && (
        <label className="qt-check">
          <input
            type="checkbox"
            checked={addSource}
            onChange={(e) => setAddSource(e.target.checked)}
            disabled={working}
          />
          Add a &ldquo;Source File&rdquo; column
        </label>
      )}
      <div className="qt-hint">
        {mergeMode === "columns"
          ? "one worksheet, columns matched by header name"
          : "one worksheet per file, in the order above"}
      </div>

      <div className="qt-section">Split Excel Workbook</div>
      <div className="qt-row">
        <button className="pixel-btn" onClick={onChooseBook} disabled={working}>
          Choose workbook…
        </button>
        <span className="qt-file">{book ? baseName(book) : "none chosen"}</span>
      </div>
      {bookSheets.length > 0 && (
        <>
          <div className="qt-row">
            <button
              className="pixel-btn"
              onClick={() => setChosen(chosen.length === bookSheets.length ? [] : bookSheets)}
              disabled={working}
            >
              {chosen.length === bookSheets.length ? "Select none" : "Select all"}
            </button>
            <span className="qt-hint">
              {chosen.length} of {bookSheets.length} selected
            </span>
          </div>
          <div className="qt-sheets" role="group" aria-label="Worksheets to split out">
            {bookSheets.map((s) => (
              <label key={s} className="qt-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(s)}
                  onChange={() => toggleSheet(s)}
                  disabled={working}
                />
                <span title={s}>{s}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="qt-row">
        <label className="qt-check">
          <input
            type="checkbox"
            checked={splitAsCsv}
            onChange={(e) => setSplitAsCsv(e.target.checked)}
            disabled={working}
          />
          Export as CSV
        </label>
        <button
          className="pixel-btn primary"
          onClick={onSplit}
          disabled={working || !book || chosen.length === 0}
        >
          {label("split", "Split")}
        </button>
      </div>
      <div className="qt-hint">one file per worksheet, into a folder you choose</div>

      <div className="qt-status-slot">
        {working && (
          <button className="pixel-btn qt-cancel" onClick={() => void cancelSheetOp()}>
            Cancel
          </button>
        )}
        {status && <div className="qt-status ok">{status}</div>}
        {error && <div className="qt-status err">{error}</div>}
      </div>
    </>
  );
}
