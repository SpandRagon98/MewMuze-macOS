import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  convertSupport,
  imagesToPdf,
  mergePdfs,
  onPdfProgress,
  pdfToImages,
  pickFolder,
  pickImages,
  pickPdf,
  pickPdfDestination,
  pickPdfs,
  splitPdf,
  baseName,
  countLabel,
  type ConvertSupport,
  type ImageFormat,
  type SplitMode,
} from "../quicktools/convert";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import { SpreadsheetTools } from "./SpreadsheetTools";
import { Icon } from "./icons";

// Width is exact (box-sizing: border-box); height is measured with the status
// slot reserved, so the layout-effect re-place below is a no-op in practice.
export const PANEL_SIZE = { width: 306, height: 470 };
/** The tools themselves: wide enough that a row of controls stops wrapping. */
export const TOOL_PANEL_SIZE = { width: 462, height: 560 };

type Busy = null | "images" | "pdf" | "merge" | "split";

/** Work Mode opens on the category menu; the tools themselves are unchanged. */
type View = "menu" | "pdf" | "sheets";

// A blocky pixel-art lightning bolt on an 11x16 grid (1 = lit). Rendered on a
// tiny canvas and scaled up nearest-neighbour, so it stays crisply pixelated.
const BOLT_GRID = [
  "00000011100",
  "00000111000",
  "00001110000",
  "00011100000",
  "00111000000",
  "01111111000",
  "00011111000",
  "00001110000",
  "00011100000",
  "00111000000",
  "01110000000",
  "11100000000",
  "11000000000",
  "10000000000",
  "00000000000",
  "00000000000",
];
const BOLT_W = 11;
const BOLT_H = 16;

/**
 * The work-mode strike: a 2D pixel-art bolt scaled to the cat's height, with
 * only a faint glow. `x`/`y` = cat centre, `size` = cat height.
 */
export function ThunderStrike({ x, y, size }: { x: number; y: number; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    cv.width = BOLT_W;
    cv.height = BOLT_H;
    ctx.clearRect(0, 0, BOLT_W, BOLT_H);
    for (let r = 0; r < BOLT_H; r++) {
      for (let c = 0; c < BOLT_W; c++) {
        if (BOLT_GRID[r][c] === "1") {
          // Icy core with a one-pixel teal outline for definition.
          const edge = r === 0 || r === BOLT_H - 1;
          ctx.fillStyle = edge ? "#5fd3e3" : "#e6fbff";
          ctx.fillRect(c, r, 1, 1);
        }
      }
    }
  }, []);
  // The bolt is exactly the cat's height, centred on it.
  const h = size;
  const w = (size * BOLT_W) / BOLT_H;
  return (
    <div className="thunder-strike" style={{ left: x, top: y }} aria-hidden="true">
      <div className="ts-glow" style={{ width: size * 0.9, height: size * 0.9 }} />
      <canvas
        ref={ref}
        className="ts-bolt-px"
        style={{ width: w, height: h, marginLeft: -w / 2, marginTop: -h / 2 }}
      />
    </div>
  );
}

export function QuickToolsPanel({
  cat,
  area,
  onClose,
}: {
  cat: Box;
  area: Area;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("menu");
  const [support, setSupport] = useState<ConvertSupport | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [format, setFormat] = useState<ImageFormat>("png");
  const [dpi, setDpi] = useState(150);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // Merge
  const [mergeList, setMergeList] = useState<string[]>([]);
  // Split
  const [splitPdfPath, setSplitPdfPath] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<SplitMode>("every");
  const [splitPages, setSplitPages] = useState("");
  // "2/5" while a merge or split runs.
  const [progress, setProgress] = useState("");

  // Placement is computed once per open and then held: recomputing as the cat
  // wanders would make the panel skitter around under the pointer. The cat is
  // parked while the panel is open anyway.
  const boxRef = useRef<HTMLDivElement>(null);
  const size = view === "menu" ? PANEL_SIZE : TOOL_PANEL_SIZE;
  const [placement, setPlacement] = useState(() => placePanel({ cat, panel: PANEL_SIZE, area }));

  // PANEL_SIZE is only an estimate — fonts, wrapping and the platform's
  // scrollbar all move the real height a little. Measure once before paint and
  // re-place if it was meaningfully off, so "never covers the cat" holds against
  // the box that actually rendered rather than the one we guessed.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - size.width) > 2 || Math.abs(r.height - size.height) > 2) {
      setPlacement(placePanel({ cat, panel: { width: r.width, height: r.height }, area }));
    }
    // `view` matters: the menu, PDF and spreadsheet views are different
    // sizes, so a switch has to re-place against the box that just rendered.
  }, [cat, area, view, size]);

  useEffect(() => {
    let alive = true;
    void convertSupport().then((s) => {
      if (alive) setSupport(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (kind: Busy, fn: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setStatus("");
    setProgress("");
    // Only listen while work is in flight, so an idle panel registers no
    // event handler and adds nothing to idle CPU.
    const unlisten = await onPdfProgress((done, total) =>
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

  const onChooseImages = async () => {
    const picked = await pickImages();
    if (picked.length) {
      setImages(picked);
      setStatus("");
      setError("");
    }
  };

  const onMakePdf = () =>
    run("images", async () => {
      // The optional group means a name with no extension still gains ".pdf"
      // rather than being offered to the save dialog bare.
      const suggested =
        images.length === 1 ? baseName(images[0]).replace(/(\.[^.]+)?$/, ".pdf") : "images.pdf";
      const out = await pickPdfDestination(suggested);
      if (!out) return "";
      const written = await imagesToPdf(images, out);
      return `Saved ${baseName(written)} (${countLabel(images.length, "page")}).`;
    });

  const onChoosePdf = async () => {
    const picked = await pickPdf();
    if (picked) {
      setPdf(picked);
      setStatus("");
      setError("");
    }
  };

  const onExportImages = () =>
    run("pdf", async () => {
      if (!pdf) return "";
      const dir = await pickFolder();
      if (!dir) return "";
      const written = await pdfToImages(pdf, dir, format, dpi);
      return `Exported ${countLabel(written.length, "page")} to ${baseName(dir)}.`;
    });

  const onChooseMerge = async () => {
    const picked = await pickPdfs();
    if (picked.length) {
      // Append rather than replace, so a second pick adds to the order.
      setMergeList((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))]);
      setStatus("");
      setError("");
    }
  };

  /** Move one entry by `delta`, clamped. Reorder is what decides page order. */
  const moveMerge = (index: number, delta: number) =>
    setMergeList((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  const onMerge = () =>
    run("merge", async () => {
      const out = await pickPdfDestination("merged.pdf");
      if (!out) return "";
      const res = await mergePdfs(mergeList, out);
      return `Saved ${baseName(res.output)} (${countLabel(res.pages, "page")}).`;
    });

  const onChooseSplit = async () => {
    const picked = await pickPdf();
    if (picked) {
      setSplitPdfPath(picked);
      setStatus("");
      setError("");
    }
  };

  const onSplit = () =>
    run("split", async () => {
      if (!splitPdfPath) return "";
      const dir = await pickFolder();
      if (!dir) return "";
      const written = await splitPdf(splitPdfPath, splitMode, splitPages, dir);
      return `Wrote ${countLabel(written.length, "file")} to ${baseName(dir)}.`;
    });

  const working = busy !== null;
  const label = (kind: Busy, idle: string) =>
    busy !== kind ? idle : progress ? `${progress}…` : "Working…";

  return (
    <div
      ref={boxRef}
      className={`quick-tools pixel-ui${view === "menu" ? "" : " qt-tools"}`}
      data-side={placement.side}
      style={{ left: placement.x, top: placement.y, width: size.width }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Suppress both the cat's menu and the webview's own default menu.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="qt-head">
        {view === "menu" ? (
          <span className="qt-title">
            <Icon name="bolt" size={18} /> Quick Tools
          </span>
        ) : (
          <button
            className="qt-back"
            onClick={() => setView("menu")}
            title="Back to Quick Tools"
            aria-label="Back to Quick Tools"
          >
            <Icon name="chevronLeft" size={16} />
            {view === "pdf" ? "PDF Tools" : "Spreadsheet Tools"}
          </button>
        )}
        <button className="qt-x" onClick={onClose} title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      {view === "menu" && (
        <div className="qt-menu">
          <button className="qt-card" onClick={() => setView("pdf")}>
            <span className="qt-card-icon" aria-hidden="true">
              <Icon name="note" size={18} />
            </span>
            <span className="qt-card-text">
              <strong>PDF Tools</strong>
              <small>Images to PDF, export, merge, split</small>
            </span>
            <span className="qt-card-go" aria-hidden="true">
              <Icon name="chevronRight" size={16} />
            </span>
          </button>
          <button className="qt-card" onClick={() => setView("sheets")}>
            <span className="qt-card-icon" aria-hidden="true">
              <Icon name="grid" size={18} />
            </span>
            <span className="qt-card-text">
              <strong>Spreadsheet Tools</strong>
              <small>CSV and XLSX, merge, split workbook</small>
            </span>
            <span className="qt-card-go" aria-hidden="true">
              <Icon name="chevronRight" size={16} />
            </span>
          </button>
        </div>
      )}

      {view === "sheets" && <SpreadsheetTools />}

      {view === "pdf" && (
        <>
      <section className="qt-group">
        <h3 className="qt-group-head">Images → PDF</h3>
        <div className="qt-row">
          <button className="pixel-btn" onClick={onChooseImages} disabled={working}>
            Choose images…
          </button>
          <span className="qt-file">{images.length ? countLabel(images.length, "image") : "none chosen"}</span>
          <button className="pixel-btn primary" onClick={onMakePdf} disabled={working || images.length === 0}>
            {label("images", "Make PDF")}
          </button>
        </div>
        <div className="qt-hint">one image per page, in the order picked</div>
      </section>

      <section className="qt-group">
        <h3 className="qt-group-head">PDF → Images</h3>
      {support && !support.pdfRender ? (
        <div className="qt-unavailable">{support.reason}</div>
      ) : (
        <>
          <div className="qt-row">
            <button className="pixel-btn" onClick={onChoosePdf} disabled={working}>
              Choose PDF…
            </button>
            <span className="qt-file">{pdf ? baseName(pdf) : "none chosen"}</span>
          </div>
          <div className="qt-row">
            <select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)} disabled={working}>
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
            </select>
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={working}>
              <option value={96}>96 dpi</option>
              <option value={150}>150 dpi</option>
              <option value={300}>300 dpi</option>
            </select>
            <button className="pixel-btn primary" onClick={onExportImages} disabled={working || !pdf}>
              {label("pdf", "Export")}
            </button>
          </div>
        </>
      )}
      </section>

      <section className="qt-group">
        <h3 className="qt-group-head">Merge PDF</h3>
      {support && !support.pdfRender ? (
        <div className="qt-unavailable">{support.reason}</div>
      ) : (
        <>
          <div className="qt-row">
            <button className="pixel-btn" onClick={onChooseMerge} disabled={working}>
              Add PDFs…
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
                <li key={p} className="qt-list-row">
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
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="qt-row">
            <button
              className="pixel-btn primary"
              onClick={onMerge}
              disabled={working || mergeList.length < 2}
            >
              {label("merge", "Merge")}
            </button>
            <span className="qt-hint">joined top to bottom, in the order above</span>
          </div>
        </>
      )}
      </section>

      <section className="qt-group">
        <h3 className="qt-group-head">Split PDF</h3>
      {support && !support.pdfRender ? (
        <div className="qt-unavailable">{support.reason}</div>
      ) : (
        <>
          <div className="qt-row">
            <button className="pixel-btn" onClick={onChooseSplit} disabled={working}>
              Choose PDF…
            </button>
            <span className="qt-file">{splitPdfPath ? baseName(splitPdfPath) : "none chosen"}</span>
          </div>
          <div className="qt-row">
            <select
              value={splitMode}
              onChange={(e) => setSplitMode(e.target.value as SplitMode)}
              disabled={working}
            >
              <option value="every">Every page</option>
              <option value="select">Chosen pages</option>
            </select>
            {splitMode === "select" && (
              <input
                className="qt-input"
                type="text"
                inputMode="numeric"
                value={splitPages}
                onChange={(e) => setSplitPages(e.target.value)}
                placeholder="1,3,5-7"
                aria-label="Pages to keep"
                disabled={working}
              />
            )}
            <button
              className="pixel-btn primary"
              onClick={onSplit}
              disabled={
                working || !splitPdfPath || (splitMode === "select" && splitPages.trim() === "")
              }
            >
              {label("split", "Split")}
            </button>
          </div>
          <div className="qt-hint">
            {splitMode === "every"
              ? "one PDF per page, into a folder you choose"
              : "one PDF with just those pages — 1,3,5-7"}
          </div>
        </>
      )}
      </section>

      <div className="qt-status-slot">
        {status && <div className="qt-status ok">{status}</div>}
        {error && <div className="qt-status err">{error}</div>}
      </div>
        </>
      )}
    </div>
  );
}
