import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; the typography test reads the same way.
import { readFileSync } from "node:fs";

// Settings talks to Tauri for its window, costumes and events: stand those in.
vi.mock("../native/settingsWindow", () => ({
  setSettingsWindowMode: vi.fn(async () => undefined),
  minimizeSettingsWindow: vi.fn(async () => undefined),
  watchSettingsWindowFocus: vi.fn(async () => () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
const installed = vi.fn(async () => [] as unknown[]);
vi.mock("../costumes/costumeApi", () => ({
  listInstalledCostumes: () => installed(),
  openMewMuzeStore: vi.fn(async () => undefined),
  chooseAndInstallCostume: vi.fn(async () => null),
  setCostumeEnabled: vi.fn(async () => undefined),
  uninstallCostume: vi.fn(async () => undefined),
}));

import { CatContextMenu } from "../components/OverlayUI";
import { SettingsPanel } from "../components/SettingsPanel";
import { confirmAction } from "../components/ConfirmDialog";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";
import { resolveLicenseState } from "../licensing/license";
import { BATCAT_ID } from "../costumes/batCat";
import { CYBERPUNK_CAT_ID } from "../costumes/cyberpunkCat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.useRealTimers();
});

// Keys go where the browser sends them: the focused element (the open menu).
const key = (k: string) => act(() => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
const active = () => host.querySelector(".mm-menu-item.active")?.textContent ?? "";

describe("right-click menu", () => {
  const render = (onCommand = vi.fn(), onClose = vi.fn()) => {
    act(() => root.render(<CatContextMenu state={{ x: 10, y: 10 }} workMode={false} session={null} clipboardEnabled onCommand={onCommand} onClose={onClose} />));
    return { onCommand, onClose };
  };

  it("keeps the root short and grouped instead of listing every tool", () => {
    render();
    const items = host.querySelectorAll(".mm-menu-item");
    expect(items.length).toBeLessThanOrEqual(12);
    expect(host.querySelectorAll(".mm-menu-sep").length).toBeGreaterThanOrEqual(4);
    expect(host.textContent).not.toContain("Calculator"); // one level down
    // Every item has an SVG icon rather than an emoji.
    for (const item of items) expect(item.querySelector("svg"), item.textContent ?? "").toBeTruthy();
  });

  it("works by keyboard alone: arrows, Right into a submenu, Escape back, Enter to run", () => {
    const { onCommand, onClose } = render();
    expect(active()).toContain("Chat with MewMuze");
    key("ArrowDown");
    expect(active()).toContain("My Day");
    key("ArrowUp");
    key("ArrowUp"); // wraps to the last item
    expect(active()).toContain("Quit");
    key("Home");
    for (let i = 0; i < 5; i++) key("ArrowDown"); // → Quick Tools
    expect(active()).toContain("Quick Tools");
    key("ArrowRight");
    expect(host.querySelector(".mm-menu-head")?.textContent).toContain("Quick Tools");
    key("Escape"); // back to the root, not closed
    expect(host.querySelector(".mm-menu-head")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    key("Home");
    key("Enter");
    expect(onCommand).toHaveBeenCalledWith("chat");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers only the deliberate play actions — no Come here, no cursor chasing", () => {
    render();
    const play = [...host.querySelectorAll<HTMLElement>(".mm-menu-item")].find((b) => b.textContent?.includes("Play"));
    act(() => play!.click());
    const items = [...host.querySelectorAll(".cat-menu-item")].map((n) => n.textContent);
    expect(items).toContain("Pet MewMuze");
    expect(items).toContain("Take a nap");
    // Both were removed: chasing stays a Settings preference, not a play toy.
    expect(items.some((t) => t?.includes("Come here"))).toBe(false);
    expect(items.some((t) => t?.includes("Chase the cursor"))).toBe(false);
  });

  it("closes on Escape from the top level", () => {
    const { onCommand, onClose } = render();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("marks what is on, and opens Cat & Looks from Appearance", () => {
    const onCommand = vi.fn();
    act(() => root.render(<CatContextMenu state={{ x: 10, y: 10 }} workMode session={null} clipboardEnabled catSize="large" onCommand={onCommand} onClose={() => undefined} />));
    expect(host.querySelector(".mm-menu-item.on")?.textContent).toContain("Leave Work Mode");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[data-submenu]")].find((b) => b.textContent?.includes("Appearance"))!.click());
    expect([...host.querySelectorAll(".mm-menu-item.on")].map((n) => n.textContent)).toContain("Large");
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".mm-menu-item")].find((b) => b.textContent?.includes("Cat & Looks"))!.click());
    expect(onCommand).toHaveBeenCalledWith("settings:looks");
  });
});

describe("Settings", () => {
  const license = resolveLicenseState({ licensed: true, firstRunUnix: 0, nowUnix: 1_800_000_000, source: "dodo" });
  const render = (settings = DEFAULT_SETTINGS) => {
    const changes: (typeof DEFAULT_SETTINGS)[] = [];
    act(() =>
      root.render(
        <SettingsPanel
          settings={settings}
          license={license}
          updateStatus=""
          onChange={(n) => changes.push(n)}
          onClose={() => undefined}
          onResetPosition={() => undefined}
          onResetSettings={() => undefined}
          onQuit={() => undefined}
          onApplyLicense={async () => ""}
          onDeactivateLicense={async () => ""}
          onCompleteRemoval={async () => ""}
          onCheckUpdates={() => undefined}
          onOpenLink={async () => undefined}
          onVisibilityChange={() => undefined}
        />,
      ),
    );
    return changes;
  };
  const title = () => host.querySelector(".mm-page-title")?.textContent;

  it("offers a light theme from the sidebar, dark by default", () => {
    const changes = render();
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Light theme"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    act(() => sw.click());
    expect(changes[changes.length - 1]?.theme).toBe("light");
    // The brand mark is the cat's own face, not a generic icon.
    expect(host.querySelector(".mm-brand-mark canvas.mm-brand-face")).toBeTruthy();
  });

  it("has the ten sections and opens on Home", () => {
    render();
    expect([...host.querySelectorAll(".mm-nav-item")].map((n) => n.textContent)).toEqual([
      "Home",
      "Companion",
      "Cat & Looks",
      "Voice",
      "Chat",
      "Tools",
      "Connections",
      "Notifications",
      "Privacy & Battery",
      "About",
    ]);
    expect(host.querySelector(".mm-hero")).toBeTruthy();
  });

  it("moves between sections with the indicator following", async () => {
    vi.useFakeTimers();
    render();
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".mm-nav-item")][5].click());
    await act(async () => vi.advanceTimersByTime(200));
    expect(title()).toBe("Tools");
    expect(host.querySelector<HTMLElement>(".mm-nav-indicator")!.style.transform).toBe("translateY(200px)");
  });

  it("finds a setting by what people call it and goes straight to it", async () => {
    vi.useFakeTimers();
    render();
    const input = host.querySelector<HTMLInputElement>(".mm-search-input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "drink");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const hits = [...host.querySelectorAll(".mm-search-hit")].map((n) => n.textContent);
    expect(hits[0]).toContain("Water reminder");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(100)); // the page changes...
    await act(async () => vi.advanceTimersByTime(100)); // ...then the row is found and flashed
    expect(title()).toBe("Tools");
    expect(host.querySelector('[data-setting="water-reminder"]')?.classList.contains("flash")).toBe(true);
  });

  it("shows the three Featured Looks with honest states", async () => {
    installed.mockResolvedValue([
      { costumeId: BATCAT_ID, enabled: true, supportedBodies: ["classic"], name: "BatCat" },
      { costumeId: CYBERPUNK_CAT_ID, enabled: true, supportedBodies: ["classic"], name: "Cyberpunk" },
    ]);
    render({ ...DEFAULT_SETTINGS, selectedCostumeId: CYBERPUNK_CAT_ID });
    await act(async () => undefined);
    const looks = [...host.querySelectorAll(".mm-look")].map((n) => n.textContent ?? "");
    expect(looks).toHaveLength(3);
    expect(looks[0]).toMatch(/Corporate.*Ready for business\..*In the Store/);
    expect(looks[1]).toMatch(/BatCat.*Own the night\..*Owned/);
    expect(looks[2]).toMatch(/Cyberpunk.*Built for the neon hours\..*Wearing/);
    // Licensed: no PRO badges.
    expect(host.querySelector(".mm-badge.pro")).toBeNull();
  });

  it("offers Expressions (Balanced), Butterfly visits (on) and Edgy gestures (off) in Cat & Looks", async () => {
    vi.useFakeTimers();
    const changes = render();
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".mm-nav-item")][2].click());
    await act(async () => vi.advanceTimersByTime(200));
    const sw = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
    expect(sw("Butterfly visits").getAttribute("aria-checked")).toBe("true");
    expect(sw("Edgy gestures").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Expressions"]')?.value).toBe("balanced");
    act(() => sw("Edgy gestures").click());
    expect(changes[changes.length - 1]?.edgyGestures).toBe(true);
  });
});

describe("in-app confirmation", () => {
  it("resolves true on confirm, false on Escape, and focuses the answer", async () => {
    let answer: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      answer = confirmAction({ title: "Remove it?", confirmLabel: "Remove", danger: true });
    });
    const dialog = document.querySelector(".mm-confirm")!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect((document.activeElement as HTMLElement).textContent).toBe("Remove");
    await act(async () => (document.activeElement as HTMLElement).click());
    await expect(answer).resolves.toBe(true);
    expect(document.querySelector(".mm-confirm")).toBeNull();

    await act(async () => {
      answer = confirmAction({ title: "Again?" });
    });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await expect(answer).resolves.toBe(false);
  });
});

describe("crisp cat", () => {
  it("rasterises each frame at the size it is shown, cached per size", async () => {
    const { renderFrame, DEFAULT_POSE, ART } = await import("../animation/spriteLoader");
    const medium = renderFrame(DEFAULT_POSE, 88);
    expect([medium.width, medium.height]).toEqual([88, 88]); // blitted 1:1, nothing dropped
    expect(renderFrame(DEFAULT_POSE, 88)).toBe(medium); // a cache hit
    expect(renderFrame(DEFAULT_POSE, 64)).not.toBe(medium); // another size is its own frame
    expect(renderFrame(DEFAULT_POSE).width).toBe(ART); // Photo Mode's default is unchanged
  });
});

describe("design system guards", () => {
  const read = (p: string) => readFileSync(p, "utf8") as string;
  const css = ["src/components/ui.css", "src/components/calctime.css", "src/clipboard-assistant/clipboard.css"].map(read).join("\n");

  it("defines the tokens, a light theme built from the same tokens, and a Reduce Motion rule", () => {
    expect(css).toContain(':root[data-theme="light"] {');
    for (const t of ["--mm-bg", "--mm-surface-1", "--mm-surface-2", "--mm-surface-raised", "--mm-border", "--mm-text", "--mm-text-muted", "--mm-accent", "--mm-accent-hover", "--mm-success", "--mm-warning", "--mm-danger"]) {
      expect(css, t).toContain(`${t}:`);
    }
    expect(css).not.toContain(".sk-light");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps every text colour readable on every surface it sits on, in both themes (WCAG AA, 4.5:1)", () => {
    const blockAt = (head: string) => css.slice(css.indexOf(head), css.indexOf("\n}", css.indexOf(head)));
    const dark = blockAt(":root,\n.mm-keep-dark");
    const light = blockAt(':root[data-theme="light"] {');
    expect(light.length).toBeGreaterThan(100);
    // The light theme redefines some tokens; the rest (the accent itself) are shared.
    for (const theme of [dark, light]) {
      const token = (name: string) => (theme.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i")) ?? dark.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))!)[1];
      const surfaces = ["--mm-bg", "--mm-surface-1", "--mm-surface-2", "--mm-surface-raised"].map(token);
      for (const text of ["--mm-text", "--mm-text-muted", "--mm-text-faint", "--mm-accent-ink", "--mm-danger-ink", "--mm-success-ink", "--mm-teal-ink"]) {
        for (const bg of surfaces) expect(ratio(token(text), bg), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const button of ["--mm-accent", "--mm-accent-hover", "--mm-accent-press"]) {
        expect(ratio(token("--mm-on-accent"), token(button)), `white on ${button}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    function lum(hex: string) {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function ratio(a: string, b: string) {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }
  });

  it("uses no orange anywhere in the UI's stylesheets", () => {
    const orange = [...css.matchAll(/#([0-9a-f]{6})\b/gi)]
      .map((m) => m[1])
      .filter((h) => {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 0.25 || max !== r) return false; // grey, or not red-led
        const hue = (60 * ((g - b) / (max - min)) + 360) % 360;
        return hue >= 15 && hue <= 45;
      });
    expect(orange).toEqual([]);
    // rgba() washes too: no warm-orange tints left from the old light theme.
    expect(css).not.toMatch(/rgba\(\s*232,\s*134,\s*46/);
  });

  it("never animates forever except live states (recording, thinking, an overrunning break)", () => {
    const loops = [...css.matchAll(/([^{}]+)\{[^{}]*animation:[^;]*infinite/g)].map((m) => m[1].trim());
    for (const sel of loops) expect(sel, sel).toMatch(/cp-dots|cp-rec-dot\.live|mm-live-dot\.busy|mm-chat-status\.busy|overrun/);
  });
});
