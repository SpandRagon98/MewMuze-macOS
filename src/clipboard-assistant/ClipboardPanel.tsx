import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { PANEL_GAP, placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import {
  calculateTextStats,
  cleanExtraSpaces,
  collapseBlankLines,
  convertBulletsToNumberedList,
  convertNumberedListToBullets,
  convertTabsToSpaces,
  joinWrappedLines,
  normalizeBulletSpacing,
  normalizeLineEndings,
  pasteWithoutFormatting,
  preserveParagraphsWhileCleaning,
  removeBullets,
  removeDuplicateLines,
  removeEmptyLines,
  removeLeadingSpaces,
  removeNumbering,
  removeTabs,
  removeTrailingSpaces,
  reverseLineOrder,
  sortLinesAlphabetically,
  toLowerCase,
  toSentenceCase,
  toTitleCase,
  toUpperCase,
  toggleCase,
  trimOuterWhitespace,
} from "./ClipboardTransforms";
import { extractLinks } from "./LinkExtractor";
import { toMarkdown } from "./MarkdownFormatter";
import type {
  ClipboardReaction,
  ClipboardSnapshot,
  ClipboardTransformId,
} from "./clipboardTypes";
import { Icon } from "../components/icons";
import { confirmAction } from "../components/ConfirmDialog";

export const CLIPBOARD_PANEL_SIZE = { width: 420, height: 620 };
export const CLIPBOARD_PANEL_MARGIN = 14;
export const CLIPBOARD_HISTORY_LIMIT = 20;

interface TransformChoice {
  id: ClipboardTransformId;
  label: string;
  reaction: ClipboardReaction;
}

interface AppliedStep extends TransformChoice {
  key: number;
  result: string;
}

const TRANSFORMS: TransformChoice[] = [
  { id: "plain", label: "Paste without formatting", reaction: "clean" },
  { id: "trim", label: "Trim outer whitespace", reaction: "clean" },
  { id: "clean-spaces", label: "Clean extra spaces", reaction: "clean" },
  { id: "collapse-blank-lines", label: "Reduce multiple blank lines to one", reaction: "clean" },
  { id: "join-wrapped", label: "Join wrapped PDF lines", reaction: "clean" },
  { id: "preserve-paragraphs", label: "Clean while preserving paragraphs", reaction: "clean" },
  { id: "remove-empty-lines", label: "Remove empty lines", reaction: "clean" },
  { id: "normalize-line-endings", label: "Normalize line endings", reaction: "clean" },
  { id: "remove-tabs", label: "Remove tabs", reaction: "clean" },
  { id: "tabs-to-spaces", label: "Convert tabs to spaces", reaction: "clean" },
  { id: "uppercase", label: "UPPERCASE", reaction: "arrange" },
  { id: "lowercase", label: "lowercase", reaction: "arrange" },
  { id: "title-case", label: "Title Case", reaction: "arrange" },
  { id: "sentence-case", label: "Sentence case", reaction: "arrange" },
  { id: "toggle-case", label: "tOGGLE cASE", reaction: "arrange" },
  { id: "remove-bullets", label: "Remove bullets", reaction: "arrange" },
  { id: "remove-numbering", label: "Remove numbering", reaction: "arrange" },
  { id: "numbered-to-bullets", label: "Numbered list → bullets", reaction: "arrange" },
  { id: "bullets-to-numbered", label: "Bullets → numbered list", reaction: "arrange" },
  { id: "normalize-bullets", label: "Normalize list spacing", reaction: "arrange" },
  { id: "remove-duplicate-lines", label: "Remove duplicate lines", reaction: "arrange" },
  { id: "sort-lines", label: "Sort lines alphabetically", reaction: "arrange" },
  { id: "reverse-lines", label: "Reverse line order", reaction: "arrange" },
  { id: "remove-leading-spaces", label: "Remove leading spaces", reaction: "clean" },
  { id: "remove-trailing-spaces", label: "Remove trailing spaces", reaction: "clean" },
  { id: "extract-links", label: "Extract links", reaction: "arrange" },
  { id: "markdown", label: "Copy as Markdown", reaction: "arrange" },
  { id: "markdown-code", label: "Markdown code block", reaction: "arrange" },
];

export function transformClipboardText(id: ClipboardTransformId, text: string): string {
  switch (id) {
    case "plain": return pasteWithoutFormatting(text);
    case "trim": return trimOuterWhitespace(text);
    case "clean-spaces": return cleanExtraSpaces(text);
    case "collapse-blank-lines": return collapseBlankLines(text);
    case "join-wrapped": return joinWrappedLines(text);
    case "preserve-paragraphs": return preserveParagraphsWhileCleaning(text);
    case "remove-empty-lines": return removeEmptyLines(text);
    case "normalize-line-endings": return normalizeLineEndings(text);
    case "remove-tabs": return removeTabs(text);
    case "tabs-to-spaces": return convertTabsToSpaces(text);
    case "uppercase": return toUpperCase(text);
    case "lowercase": return toLowerCase(text);
    case "title-case": return toTitleCase(text);
    case "sentence-case": return toSentenceCase(text);
    case "toggle-case": return toggleCase(text);
    case "remove-bullets": return removeBullets(text);
    case "remove-numbering": return removeNumbering(text);
    case "numbered-to-bullets": return convertNumberedListToBullets(text);
    case "bullets-to-numbered": return convertBulletsToNumberedList(text);
    case "normalize-bullets": return normalizeBulletSpacing(text);
    case "remove-duplicate-lines": return removeDuplicateLines(text);
    case "sort-lines": return sortLinesAlphabetically(text);
    case "reverse-lines": return reverseLineOrder(text);
    case "remove-leading-spaces": return removeLeadingSpaces(text);
    case "remove-trailing-spaces": return removeTrailingSpaces(text);
    case "extract-links": return extractLinks(text).join("\n");
    case "markdown": return toMarkdown(text);
    case "markdown-code": return toMarkdown(text, { codeBlock: true });
  }
}

function preview(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n… ${text.length - maxLength} more characters`;
}

export function clipboardSafeArea(area: Area): Area {
  return {
    left: area.left + CLIPBOARD_PANEL_MARGIN,
    top: area.top + CLIPBOARD_PANEL_MARGIN,
    right: area.right - CLIPBOARD_PANEL_MARGIN,
    bottom: area.bottom - CLIPBOARD_PANEL_MARGIN,
  };
}

export function clipboardPanelSizeFor(cat: Box, area: Area): { width: number; maxHeight: number } {
  const safeArea = clipboardSafeArea(area);
  const availableWidth = Math.max(220, safeArea.right - safeArea.left);
  const availableHeight = Math.max(220, safeArea.bottom - safeArea.top);
  const leftRoom = cat.x - safeArea.left - PANEL_GAP;
  const rightRoom = safeArea.right - (cat.x + cat.width) - PANEL_GAP;
  const widestSide = Math.max(leftRoom, rightRoom);
  const sideFriendlyWidth = widestSide >= 280 ? widestSide : availableWidth;
  return {
    width: Math.min(CLIPBOARD_PANEL_SIZE.width, availableWidth, sideFriendlyWidth),
    maxHeight: Math.min(CLIPBOARD_PANEL_SIZE.height, availableHeight),
  };
}

function samePlacement(
  a: ReturnType<typeof placePanel>,
  b: ReturnType<typeof placePanel>,
): boolean {
  return a.x === b.x && a.y === b.y && a.side === b.side && a.clamped === b.clamped;
}

export function ClipboardPanel({
  session,
  cat,
  area,
  maxPreviewLength,
  notificationVisible = false,
  onCopy,
  onClear,
  onOpenLink,
  onReaction,
  onClose,
}: {
  session: ClipboardSnapshot;
  cat: Box;
  area: Area;
  maxPreviewLength: number;
  notificationVisible?: boolean;
  onCopy: (text: string) => Promise<void>;
  onClear: () => Promise<void>;
  onOpenLink: (url: string) => Promise<void>;
  onReaction: (reaction: ClipboardReaction) => void;
  onClose: () => void;
}) {
  const safeArea = useMemo(() => clipboardSafeArea(area), [area]);
  const panelSize = useMemo(() => clipboardPanelSizeFor(cat, area), [cat, area]);
  const panelWidth = panelSize.width;
  const panelMaxHeight = panelSize.maxHeight;
  const exclusion = useMemo(
    () => notificationVisible
      ? { ...cat, y: Math.max(safeArea.top, cat.y - 82), height: cat.height + Math.min(82, cat.y - safeArea.top) }
      : cat,
    [cat, notificationVisible, safeArea.top],
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const nextStepKey = useRef(1);
  const [placement, setPlacement] = useState(() =>
    placePanel({ cat: exclusion, panel: { width: panelWidth, height: panelMaxHeight }, area: safeArea }),
  );
  const [transform, setTransform] = useState<ClipboardTransformId>("plain");
  const [steps, setSteps] = useState<AppliedStep[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selectedLink, setSelectedLink] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const previousSessionId = useRef(session.id);
  const result = cursor === 0 ? session.original : steps[cursor - 1]?.result ?? session.original;
  const links = useMemo(() => extractLinks(result), [result]);
  const originalStats = useMemo(() => calculateTextStats(session.original), [session.original]);
  const stats = useMemo(() => calculateTextStats(result), [result]);

  useEffect(() => {
    const changed = previousSessionId.current !== session.id;
    previousSessionId.current = session.id;
    setSteps([]);
    setCursor(0);
    setSelectedLink(0);
    setStatus(changed ? "The clipboard changed. Showing the latest copy." : "");
    setError("");
  }, [session.id, session.original]);

  const updatePlacement = useCallback(() => {
    const rect = boxRef.current?.getBoundingClientRect();
    const panel = {
      width: rect?.width || panelWidth,
      height: Math.min(rect?.height || panelMaxHeight, panelMaxHeight),
    };
    const next = placePanel({ cat: exclusion, panel, area: safeArea });
    setPlacement((current) => samePlacement(current, next) ? current : next);
  }, [exclusion, panelMaxHeight, panelWidth, safeArea]);

  useLayoutEffect(updatePlacement, [updatePlacement, steps, cursor, status, error]);

  useEffect(() => {
    const element = boxRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updatePlacement);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updatePlacement]);

  useEffect(() => {
    selectRef.current?.focus({ preventScroll: true });
  }, []);

  const apply = useCallback(() => {
    const choice = TRANSFORMS.find((entry) => entry.id === transform);
    if (!choice) return;
    if (cursor >= CLIPBOARD_HISTORY_LIMIT) {
      setError(`This session already has ${CLIPBOARD_HISTORY_LIMIT} steps. Remove a step or reset first.`);
      setStatus("");
      return;
    }
    const nextResult = transformClipboardText(transform, result);
    const nextSteps = steps.slice(0, cursor);
    nextSteps.push({ ...choice, key: nextStepKey.current++, result: nextResult });
    setSteps(nextSteps);
    setCursor(nextSteps.length);
    setStatus(`${choice.label} applied. Clipboard unchanged.`);
    setError("");
    onReaction(choice.reaction);
  }, [cursor, onReaction, result, steps, transform]);

  const undo = useCallback(() => {
    if (cursor === 0) return;
    setCursor(cursor - 1);
    setStatus("Last transformation undone.");
    setError("");
  }, [cursor]);

  const redo = useCallback(() => {
    if (cursor >= steps.length) return;
    setCursor(cursor + 1);
    setStatus("Transformation redone.");
    setError("");
  }, [cursor, steps.length]);

  const reset = useCallback((message = "All transformations reset. Clipboard unchanged.") => {
    setSteps([]);
    setCursor(0);
    setStatus(message);
    setError("");
  }, []);

  const removeStep = (key: number) => {
    let current = session.original;
    const remaining = steps
      .slice(0, cursor)
      .filter((step) => step.key !== key)
      .map((step) => {
        current = transformClipboardText(step.id, current);
        return { ...step, result: current };
      });
    setSteps(remaining);
    setCursor(remaining.length);
    setStatus("Transformation removed. Later steps were recalculated.");
    setError("");
  };

  const copy = useCallback(async (text: string, message: string) => {
    setError("");
    try {
      await onCopy(text);
      setStatus(message);
      onReaction("success");
    } catch {
      setStatus("");
      setError("MewMuze couldn’t update the clipboard.");
      onReaction("error");
    }
  }, [onCopy, onReaction]);

  const clear = async () => {
    if (!(await confirmAction({ title: "Clear the clipboard?", message: "What you copied is removed from the clipboard.", confirmLabel: "Clear", danger: true }))) return;
    try {
      await onClear();
      onReaction("success");
    } catch {
      setError("MewMuze couldn’t clear the clipboard.");
      onReaction("error");
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      apply();
    } else if (event.ctrlKey && event.key.toLocaleLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (
      (event.ctrlKey && event.key.toLocaleLowerCase() === "y") ||
      (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === "z")
    ) {
      event.preventDefault();
      redo();
    } else if (event.altKey && event.key.toLocaleLowerCase() === "c") {
      event.preventDefault();
      void copy(result, "Result copied.");
    }
  };

  return (
    <div
      ref={boxRef}
      className="clipboard-panel pixel-ui"
      data-side={placement.side}
      style={{
        left: placement.x,
        top: placement.y,
        width: panelWidth,
        maxHeight: panelMaxHeight,
      }}
      role="dialog"
      aria-label="Clipboard Assistant"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="clipboard-head">
        <span className="clipboard-title"><Icon name="clipboard" size={18} /> Clipboard Assistant</span>
        <button className="clipboard-x" type="button" onClick={onClose} title="Close" aria-label="Close"><Icon name="close" size={16} /></button>
      </div>

      <div className="clipboard-shell">
        <div className="clipboard-scroll">
          <section className="clipboard-card">
            <div className="clipboard-label">Original text</div>
            <pre className="clipboard-preview">{preview(session.original, maxPreviewLength)}</pre>
            <div className="clipboard-counts">
              <span>{originalStats.words} words</span>
              <span>{originalStats.charactersWithSpaces} characters</span>
            </div>
          </section>

          <section className="clipboard-card compact">
            <label className="clipboard-label" htmlFor="clipboard-transform">Add transformation</label>
            <div className="clipboard-action-row">
              <select
                ref={selectRef}
                id="clipboard-transform"
                className="clipboard-select"
                value={transform}
                onChange={(event) => setTransform(event.target.value as ClipboardTransformId)}
              >
                {TRANSFORMS.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
              </select>
              <button className="pixel-btn primary" type="button" onClick={apply}>Apply</button>
            </div>
          </section>

          <section className="clipboard-card">
            <div className="clipboard-label">Current result</div>
            <pre className="clipboard-preview result">{preview(result, maxPreviewLength)}</pre>
            <details className="clipboard-details">
              <summary>Text statistics</summary>
              <div className="clipboard-stats" aria-label="Text statistics">
                <span><b>{stats.words}</b> words</span>
                <span><b>{stats.charactersWithSpaces}</b> chars</span>
                <span><b>{stats.charactersWithoutSpaces}</b> no spaces</span>
                <span><b>{stats.lines}</b> lines</span>
                <span><b>{stats.paragraphs}</b> paragraphs</span>
                <span><b>{stats.readingTimeMinutes}</b> min read</span>
              </div>
            </details>
          </section>

          <section className="clipboard-card compact">
            <div className="clipboard-label">Applied transformations · {cursor}/{CLIPBOARD_HISTORY_LIMIT}</div>
            {cursor === 0 ? (
              <div className="clipboard-empty">No transformations yet. Choose one above and press Apply.</div>
            ) : (
              <ol className="clipboard-history">
                {steps.slice(0, cursor).map((step, index) => (
                  <li key={step.key}>
                    <span>{index + 1}. {step.label}</span>
                    <button type="button" onClick={() => removeStep(step.key)} aria-label={`Remove ${step.label}`}>×</button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {links.length > 0 && (
            <section className="clipboard-card links">
              <div className="clipboard-label">Links found · {links.length}</div>
              <select
                className="clipboard-select"
                value={Math.min(selectedLink, links.length - 1)}
                onChange={(event) => setSelectedLink(Number(event.target.value))}
                aria-label="Extracted links"
              >
                {links.map((link, index) => <option value={index} key={link}>{link}</option>)}
              </select>
              <div className="clipboard-link-actions">
                <button className="pixel-btn" type="button" onClick={() => void copy(links[selectedLink] ?? links[0], "Selected link copied.")}>Copy link</button>
                <button className="pixel-btn" type="button" onClick={() => void copy(links.join("\n"), "All links copied.")}>Copy all</button>
                <button
                  className="pixel-btn"
                  type="button"
                  onClick={async () => {
                    const link = links[selectedLink] ?? links[0];
                    if (await confirmAction({ title: "Open this link?", message: link, confirmLabel: "Open" })) {
                      void onOpenLink(link).catch(() => {
                        setError("MewMuze couldn’t open this link.");
                        onReaction("error");
                      });
                    }
                  }}
                >
                  Open…
                </button>
              </div>
            </section>
          )}
        </div>

        <div className="clipboard-action-dock">
          {status && <div className="clipboard-status ok" role="status">{status}</div>}
          {error && <div className="clipboard-status err" role="alert">{error}</div>}
          <div className="clipboard-footer">
            <button className="pixel-btn" type="button" onClick={undo} disabled={cursor === 0}>Undo</button>
            <button className="pixel-btn" type="button" onClick={redo} disabled={cursor >= steps.length}>Redo</button>
            <button className="pixel-btn" type="button" onClick={() => reset()}>Reset</button>
            <button className="pixel-btn" type="button" onClick={() => reset("Original text restored. Clipboard unchanged.")}>Restore Original</button>
            <button className="pixel-btn primary copy-result" type="button" onClick={() => void copy(result, "Result copied.")}>Copy Result</button>
            <button className="pixel-btn danger" type="button" onClick={() => void clear()}>Clear</button>
            <button className="pixel-btn" type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
