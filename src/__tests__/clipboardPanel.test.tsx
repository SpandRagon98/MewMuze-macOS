import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardPanel } from "../clipboard-assistant/ClipboardPanel";
import {
  CLIPBOARD_BADGE_SIZE,
  ClipboardBadge,
} from "../clipboard-assistant/ClipboardBadge";
import { CatContextMenu } from "../components/OverlayUI";
import { openSubmenu } from "./menuHelpers";

const session = {
  id: 1,
  original: "Hello world",
  result: "Hello world",
  sourceApp: "notepad.exe",
  createdAt: 1,
  expiresAt: null,
};

describe("ClipboardPanel actions", () => {
  let host: HTMLDivElement;
  let root: Root;

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
    vi.restoreAllMocks();
  });

  const render = (
    onCopy = vi.fn(async () => undefined),
    onClear = vi.fn(async () => undefined),
  ) => {
    act(() => {
      root.render(
        <ClipboardPanel
          session={session}
          cat={{ x: 400, y: 300, width: 88, height: 88 }}
          area={{ left: 0, top: 0, right: 1280, bottom: 720 }}
          maxPreviewLength={2000}
          onCopy={onCopy}
          onClear={onClear}
          onOpenLink={vi.fn(async () => undefined)}
          onReaction={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    return { onCopy, onClear };
  };

  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    )!;

  const selectTransform = (id: string) => {
    const select = host.querySelector<HTMLSelectElement>("#clipboard-transform")!;
    act(() => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("chains transformations from the current result and writes only on Copy Result", async () => {
    const { onCopy } = render();
    selectTransform("lowercase");
    act(() => {
      button("Apply").click();
    });
    selectTransform("title-case");
    act(() => {
      button("Apply").click();
    });
    expect(host.querySelector(".clipboard-preview.result")?.textContent).toBe("Hello World");
    expect(onCopy).not.toHaveBeenCalled();
    await act(async () => button("Copy Result").click());
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith("Hello World");
  });

  it("undoes, redoes, resets and restores without silently changing the clipboard", async () => {
    const { onCopy } = render();
    selectTransform("uppercase");
    act(() => button("Apply").click());
    expect(host.querySelector(".clipboard-preview.result")?.textContent).toBe("HELLO WORLD");
    act(() => button("Undo").click());
    expect(host.querySelector(".clipboard-preview.result")?.textContent).toBe("Hello world");
    act(() => button("Redo").click());
    expect(host.querySelector(".clipboard-preview.result")?.textContent).toBe("HELLO WORLD");
    act(() => button("Restore Original").click());
    expect(host.querySelector(".clipboard-preview.result")?.textContent).toBe("Hello world");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("requires confirmation before clearing", async () => {
    const { onClear } = render();
    // The in-app confirmation: Cancel keeps the clipboard, Clear clears it.
    const answer = async (label: string) => {
      const b = [...document.body.querySelectorAll<HTMLButtonElement>(".mm-confirm button")].find((x) => x.textContent === label);
      if (!b) throw new Error(`no confirmation button "${label}"`);
      await act(async () => b.click());
    };
    await act(async () => button("Clear").click());
    await answer("Cancel");
    expect(onClear).not.toHaveBeenCalled();
    await act(async () => button("Clear").click());
    await answer("Clear");
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows every clipboard transform and every result action", () => {
    render();
    const labels = [...host.querySelectorAll<HTMLOptionElement>("#clipboard-transform option")].map(
      (option) => option.textContent,
    );
    expect(labels).toEqual([
      "Paste without formatting",
      "Trim outer whitespace",
      "Clean extra spaces",
      "Reduce multiple blank lines to one",
      "Join wrapped PDF lines",
      "Clean while preserving paragraphs",
      "Remove empty lines",
      "Normalize line endings",
      "Remove tabs",
      "Convert tabs to spaces",
      "UPPERCASE",
      "lowercase",
      "Title Case",
      "Sentence case",
      "tOGGLE cASE",
      "Remove bullets",
      "Remove numbering",
      "Numbered list → bullets",
      "Bullets → numbered list",
      "Normalize list spacing",
      "Remove duplicate lines",
      "Sort lines alphabetically",
      "Reverse line order",
      "Remove leading spaces",
      "Remove trailing spaces",
      "Extract links",
      "Copy as Markdown",
      "Markdown code block",
    ]);
    for (const label of ["Apply", "Undo", "Redo", "Reset", "Copy Result", "Restore Original", "Clear", "Close"]) {
      expect(button(label)).toBeDefined();
    }
    expect(host.querySelector(".clipboard-footer")?.parentElement?.classList.contains("clipboard-action-dock")).toBe(true);
  });

  it("places the compact badge four pixels from the cat", () => {
    act(() => {
      root.render(
        <ClipboardBadge
          cat={{ x: 400, y: 300, width: 88, height: 88 }}
          area={{ left: 0, top: 0, right: 1280, bottom: 720 }}
          onOpen={vi.fn()}
        />,
      );
    });
    const badge = host.querySelector<HTMLElement>(".clipboard-badge")!;
    expect(badge.style.left).toBe("492px");
    expect(CLIPBOARD_BADGE_SIZE).toEqual({ width: 22, height: 22 });
  });

  it("removes the right-click launcher while Clipboard Assistant is off", () => {
    const renderMenu = (clipboardEnabled: boolean) =>
      act(() => {
        root.render(
          <CatContextMenu
            state={{ x: 10, y: 10 }}
            workMode={false}
            session={null}
            clipboardEnabled={clipboardEnabled}
            onCommand={vi.fn()}
            onClose={vi.fn()}
          />,
        );
      });
    // It lives in the Quick Tools submenu.
    renderMenu(false);
    openSubmenu(host, "Quick Tools");
    expect(host.textContent).not.toContain("Clipboard Assistant");
    renderMenu(true);
    expect(host.textContent).toContain("Clipboard Assistant");
  });
});
