import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  installed: [] as unknown[],
  openLookPreview: vi.fn(async (_id: string) => undefined),
  openMewMuzeStore: vi.fn(async () => undefined),
  chooseAndInstallCostume: vi.fn(async () => ({ message: "Installed and checked." })),
  setCostumeEnabled: vi.fn(async () => undefined),
  uninstallCostume: vi.fn(async () => undefined),
  emitTo: vi.fn(async (..._a: unknown[]) => undefined),
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
}));

vi.mock("../costumes/costumeApi", () => ({
  listInstalledCostumes: vi.fn(async () => api.installed),
  openLookPreview: api.openLookPreview,
  openMewMuzeStore: api.openMewMuzeStore,
  chooseAndInstallCostume: api.chooseAndInstallCostume,
  setCostumeEnabled: api.setCostumeEnabled,
  uninstallCostume: api.uninstallCostume,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emitTo: api.emitTo }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn(async () => undefined) }) }));

import { ANIMATIONS } from "../animation/animationDefinitions";
import { CostumeManager } from "../costumes/CostumeManager";
import { BATCAT_ID } from "../costumes/batCat";
import { CORPORATE_CAT_ID } from "../costumes/corporateCat";
import { CYBERPUNK_CAT_ID } from "../costumes/cyberpunkCat";
import { PLAYLIST } from "../preview/LookPreviewApp";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll(".mm-confirm-backdrop").forEach((n) => n.parentElement?.remove());
});

const costume = (costumeId: string, name: string, enabled = true) => ({ costumeId, name, enabled, supportedBodies: ["classic"], version: "1.0.0", creator: "MewMuze Studio", signatureStatus: "verified", thumbnailDataUrl: null });
const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string, scope: ParentNode = host) => buttons(scope).find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label);
const poster = (name: string) => [...host.querySelectorAll<HTMLElement>(".mm-look")].find((p) => p.querySelector(".mm-look-name")?.textContent === name)!;

async function mount(settings = DEFAULT_SETTINGS) {
  const onChange = vi.fn();
  await act(async () => root.render(<CostumeManager settings={settings} onChange={onChange} />));
  await act(async () => undefined);
  return onChange;
}

describe("Cat & Looks: one place for every outfit", () => {
  it("has Featured Looks, Your Looks, Browse Store and Install Outfit - and no separate costumes panel", async () => {
    api.installed = [costume(BATCAT_ID, "BatCat"), costume("studio.flower-cat", "Flower Cat")];
    await mount();
    expect(host.querySelector(".mm-section-title")?.textContent).toBe("Featured Looks");
    expect(host.textContent).toContain("Your Looks");
    expect(button("Browse Store")).toBeTruthy();
    expect(button("Install Outfit")).toBeTruthy();
    expect(host.textContent).not.toMatch(/Your costumes|Take off costume|Install from a file/);
    // Destructive actions are never a big primary button.
    expect(buttons().some((b) => /^Delete/.test(b.textContent ?? ""))).toBe(false);
  });

  it("shows each look's honest state: Get it, Wear, Wearing", async () => {
    api.installed = [costume(BATCAT_ID, "BatCat"), costume(CYBERPUNK_CAT_ID, "Cyberpunk")];
    const onChange = await mount({ ...DEFAULT_SETTINGS, selectedCostumeId: CYBERPUNK_CAT_ID });
    expect(poster("Corporate").textContent).toMatch(/In the Store.*Preview.*Get it/);
    expect(poster("BatCat").textContent).toMatch(/Owned.*Preview.*Wear/);
    expect(button("Wearing", poster("Cyberpunk"))?.disabled).toBe(true);
    act(() => button("Wear", poster("BatCat"))!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selectedCostumeId: BATCAT_ID }));
  });

  it("Preview opens the preview window and never changes what the cat wears", async () => {
    api.installed = [costume(BATCAT_ID, "BatCat")];
    const onChange = await mount({ ...DEFAULT_SETTINGS, selectedCostumeId: "" });
    await act(async () => button("Preview", poster("Corporate"))!.click());
    await act(async () => button("Preview", poster("BatCat"))!.click());
    expect(api.openLookPreview.mock.calls.map((c) => c[0])).toEqual([CORPORATE_CAT_ID, BATCAT_ID]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps Disable, Check for updates and Delete in the ⋯ menu - and Delete asks first", async () => {
    api.installed = [costume(BATCAT_ID, "BatCat")];
    await mount();
    act(() => button("More for BatCat")!.click());
    const menu = host.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Disable", "Check for updates", "Delete…"]);
    await act(async () => button("Delete…", menu)!.click());
    expect(api.uninstallCostume).not.toHaveBeenCalled();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>(".mm-confirm button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    expect(api.uninstallCostume).not.toHaveBeenCalled();

    act(() => button("More for BatCat")!.click());
    await act(async () => button("Delete…", host.querySelector('[role="menu"]')!)!.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".mm-confirm button")].find((b) => b.textContent === "Delete")!;
    await act(async () => confirm.click());
    expect(api.uninstallCostume).toHaveBeenCalledWith(BATCAT_ID);
  });

  it("installs through the same checked .mewcostume path", async () => {
    api.installed = [];
    await mount();
    await act(async () => button("Install Outfit")!.click());
    expect(api.chooseAndInstallCostume).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".costume-status")?.textContent).toBe("Installed and checked.");
  });

  it("lets Classic take the outfit off", async () => {
    api.installed = [costume(BATCAT_ID, "BatCat")];
    const onChange = await mount({ ...DEFAULT_SETTINGS, selectedCostumeId: BATCAT_ID });
    act(() => button("Take off outfit")!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selectedCostumeId: "" }));
  });
});

describe("Look Preview window", () => {
  it("only plays animations that really exist, in the real renderer", () => {
    expect(PLAYLIST.length).toBeGreaterThanOrEqual(10);
    for (const p of PLAYLIST) expect(ANIMATIONS[p.anim], p.anim).toBeTruthy();
  });

  it("asks the main window to wear a look and never saves settings itself; pausing and hiding stop rendering", async () => {
    vi.useFakeTimers();
    try {
      api.installed = [costume(BATCAT_ID, "BatCat")];
      api.invoke.mockImplementation(async (cmd: unknown) => (cmd === "load_settings" ? { ...DEFAULT_SETTINGS } : undefined));
      history.replaceState(null, "", `/?view=preview&look=${BATCAT_ID}`);
      const { LookPreviewApp } = await import("../preview/LookPreviewApp");
      await act(async () => root.render(<LookPreviewApp />));
      await act(async () => vi.advanceTimersByTimeAsync(10));
      expect(host.querySelector(".mm-preview-title strong")?.textContent).toBe("BatCat");

      // Playing: a render timer is running. Paused: none.
      const setInt = vi.spyOn(window, "setInterval");
      const clearInt = vi.spyOn(window, "clearInterval");
      act(() => button("Pause")!.click());
      expect(clearInt).toHaveBeenCalled();
      const afterPause = setInt.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(setInt.mock.calls.length).toBe(afterPause);
      expect(host.querySelector(".mm-preview-chip.on")?.textContent).toBe("Idle"); // no auto-advance while paused

      act(() => button("Play")!.click());
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      const hiddenCalls = setInt.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(setInt.mock.calls.length).toBe(hiddenCalls);
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });

      await act(async () => button("Wear")!.click());
      expect(api.emitTo).toHaveBeenCalledWith("main", "look-preview-action", { action: "wear", id: BATCAT_ID });
      expect(api.invoke.mock.calls.some((c) => c[0] === "save_settings")).toBe(false);
    } finally {
      vi.useRealTimers();
      history.replaceState(null, "", "/");
    }
  });
});
