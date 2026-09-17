import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, chatPanelSize } from "../components/ChatPanel";
import { ChatWith } from "../components/CompanionSettings";
import { INITIAL_CHAT, type ChatState } from "../companion/chatController";
import { Diary, type DiaryBridge } from "../companion/diary";
import { DEFAULT_COMPANION, type CompanionSettings } from "../companion/profile";
import type { ProviderBridge } from "../companion/providers";
import { IDLE as VOICE_IDLE } from "../companion/voiceController";

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
  document.querySelectorAll(".mm-confirm-backdrop").forEach((n) => n.parentElement?.remove());
});

const cat = { x: 600, y: 700, width: 88, height: 88 };
const chat = (over: Partial<ChatState> = {}): ChatState => ({ ...INITIAL_CHAT, status: "ready", ...over });
const handlers = () => ({ onSend: vi.fn(), onCancel: vi.fn(), onForget: vi.fn(), onMicStart: vi.fn(), onMicStop: vi.fn(), onRetry: vi.fn(), onClose: vi.fn(), onNewChat: vi.fn(), onUseLocal: vi.fn() });
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("the bigger chat window", () => {
  it("is a comfortable size for the screen, never tiny and never larger than the work area", () => {
    const hd = chatPanelSize({ left: 0, top: 0, right: 1920, bottom: 1040 });
    expect(hd.width).toBeGreaterThanOrEqual(420);
    expect(hd.width).toBeLessThanOrEqual(560);
    expect(hd.height).toBeGreaterThanOrEqual(520);
    expect(hd.height).toBeLessThanOrEqual(760);
    // A 4K work area does not make a giant popup; a small laptop still fits.
    expect(chatPanelSize({ left: 0, top: 0, right: 3840, bottom: 2100 })).toEqual({ width: 560, height: 760 });
    const small = chatPanelSize({ left: 0, top: 0, right: 1280, bottom: 680 });
    expect(small.width).toBeLessThanOrEqual(1280 - 24);
    expect(small.height).toBeLessThanOrEqual(680 - 24);
    // Much bigger than the old 360 x 470 popup on an ordinary screen.
    expect(hd.width * hd.height).toBeGreaterThan(360 * 470 * 1.6);
  });

  it("renders at that size", () => {
    act(() => root.render(<ChatPanel cat={cat} area={{ left: 0, top: 0, right: 1920, bottom: 1040 }} name="Sandy" chat={chat()} voice={VOICE_IDLE} voiceAvailable={false} {...handlers()} />));
    const panel = host.querySelector<HTMLDivElement>(".chat-panel")!;
    const size = chatPanelSize({ left: 0, top: 0, right: 1920, bottom: 1040 });
    expect(panel.style.width).toBe(`${size.width}px`);
    expect(panel.style.height).toBe(`${size.height}px`);
  });

  it("says where messages go: on this computer, or the chosen provider", () => {
    const area = { left: 0, top: 0, right: 1600, bottom: 900 };
    act(() => root.render(<ChatPanel cat={cat} area={area} name="Sandy" chat={chat()} voice={VOICE_IDLE} voiceAvailable={false} {...handlers()} />));
    expect(host.textContent).toContain("Private · runs on this computer");
    act(() => root.render(<ChatPanel cat={cat} area={area} name="Sandy" chat={chat({ provider: "anthropic" })} voice={VOICE_IDLE} voiceAvailable {...handlers()} />));
    expect(host.textContent).toContain("Messages are sent to Anthropic (Claude) to generate replies.");
    expect(host.textContent).toContain("Your Diary stays on this computer.");
    expect(host.textContent).not.toContain("It stays on this computer.");
    // Voice stays available with an external provider.
    expect(host.querySelector(".cp-mic")).not.toBeNull();
  });

  it("asks before starting over with another provider, and explains failures with details tucked away", () => {
    const h = handlers();
    const area = { left: 0, top: 0, right: 1600, bottom: 900 };
    act(() =>
      root.render(
        <ChatPanel cat={cat} area={area} name="Sandy" chat={chat({ provider: "local", switchTo: "openai", lines: [{ id: "1", role: "user", text: "private" }] })} voice={VOICE_IDLE} voiceAvailable={false} {...h} />,
      ),
    );
    expect(host.textContent).toContain("won’t be sent to OpenAI unless you start over");
    act(() => byText("Start new chat with OpenAI").click());
    expect(h.onNewChat).toHaveBeenCalled();
    act(() =>
      root.render(
        <ChatPanel
          cat={cat}
          area={area}
          name="Sandy"
          chat={chat({ status: "error", provider: "anthropic", error: "Claude isn't reachable right now.", errorDetail: "network: Dns", offerLocal: true })}
          voice={VOICE_IDLE}
          voiceAvailable={false}
          {...h}
        />,
      ),
    );
    expect(host.textContent).toContain("Claude isn't reachable right now.");
    expect(host.querySelector("details.cp-tech")?.textContent).toContain("network: Dns");
    act(() => byText("Use MewMuze Local").click());
    expect(h.onUseLocal).toHaveBeenCalled();
  });

  it("Forget chat asks first, and says the Diary entry stays", async () => {
    const h = handlers();
    act(() => root.render(<ChatPanel cat={cat} area={{ left: 0, top: 0, right: 1600, bottom: 900 }} name="Sandy" chat={chat({ lines: [{ id: "1", role: "user", text: "x" }] })} voice={VOICE_IDLE} voiceAvailable={false} {...h} />));
    act(() => byText("Forget chat").click());
    await flush();
    expect(document.querySelector(".mm-confirm")?.textContent).toContain("Your Diary entry will stay unless you delete it from Diary.");
    expect(h.onForget).not.toHaveBeenCalled();
    act(() => byText("Forget").click());
    await flush();
    expect(h.onForget).toHaveBeenCalled();
  });
});

describe("the Diary tab", () => {
  const T = new Date(2026, 8, 14, 21, 35).getTime();
  function diary() {
    const files = new Map<string, string>([
      ["index.json", JSON.stringify([{ id: "a", file: "2026-09-14_21-35_a.md", startedAt: T, endedAt: T, title: "Work was chaos again", summary: "Today I vented about work.", lines: 4, by: "local" }])],
      ["2026-09-14_21-35_a.md", "# x"],
    ]);
    const b: DiaryBridge = {
      dir: async () => "C:\\diary",
      read: async (n) => files.get(n) ?? null,
      write: async (n, t) => void files.set(n, t),
      remove: async (n) => void files.delete(n),
      clear: async () => files.clear(),
      loadPending: async () => null,
      savePending: async () => undefined,
    };
    return { d: new Diary(b, async () => null, { name: () => "Sandy", enabled: () => true }), files };
  }

  it("lists entries under Today, opens one, and deletes it only after confirming", async () => {
    const { d, files } = diary();
    act(() => root.render(<ChatPanel cat={cat} area={{ left: 0, top: 0, right: 1600, bottom: 900 }} name="Sandy" chat={chat()} voice={VOICE_IDLE} voiceAvailable={false} diary={d} {...handlers()} />));
    act(() => byText("Diary").click());
    await flush();
    expect(host.querySelector(".dy-day")?.textContent).toBe(new Date().toDateString() === new Date(T).toDateString() ? "Today" : "14 Sept");
    expect(host.querySelector(".dy-row")?.textContent).toContain("Work was chaos again");
    act(() => host.querySelector<HTMLButtonElement>(".dy-row")!.click());
    expect(host.querySelector(".dy-text")?.textContent).toBe("Today I vented about work.");
    act(() => byText("Delete entry").click());
    await flush();
    expect(document.querySelector(".mm-confirm")?.textContent).toContain("Chat memory is not affected");
    act(() => [...document.querySelectorAll(".mm-confirm button")].find((b) => b.textContent === "Delete entry")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await flush();
    expect(files.has("2026-09-14_21-35_a.md")).toBe(false);
  });
});

describe("Settings → Chat → Chat with", () => {
  function keys(connected = false): ProviderBridge & { set: string[] } {
    const set: string[] = [];
    let has = connected;
    return {
      set,
      request: async () => ({ status: 200, body: "{}" }),
      keySet: async (_p, k) => void (set.push(k), (has = true)),
      keyStatus: async () => has,
      keyRemove: async () => void (has = false),
    };
  }

  it("Local by default; OpenAI and Claude explain themselves in plain words", async () => {
    let value: CompanionSettings = DEFAULT_COMPANION;
    const render = () => act(() => root.render(<ChatWith value={value} onChange={(v) => ((value = v), render())} localInstalled keys={keys()} />));
    render();
    await flush();
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("MewMuze Local");
    expect(host.textContent).toContain("Private and works offline.");
    expect(host.textContent).toContain("Runs on your computer.");
    expect(host.textContent).not.toMatch(/endpoint|bearer|adapter/i);
    act(() => [...host.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes("Claude"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(value.chat.provider).toBe("anthropic");
    expect(host.textContent).toContain("Messages are sent to Anthropic (Claude) to generate replies.");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe("claude-sonnet-5");
  });

  it("saves a key to the vault, then shows Connected ✓ - never the key", async () => {
    let value: CompanionSettings = { ...DEFAULT_COMPANION, chat: { ...DEFAULT_COMPANION.chat, provider: "openai" } };
    const k = keys();
    const render = () => act(() => root.render(<ChatWith value={value} onChange={(v) => ((value = v), render())} localInstalled keys={k} />));
    render();
    await flush();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "sk-proj-abcdefghijklmnopqrstuvwxyz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => byText("Save key").click());
    await flush();
    expect(k.set).toEqual(["sk-proj-abcdefghijklmnopqrstuvwxyz"]);
    expect(host.textContent).toContain("Connected ✓");
    expect(host.textContent).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(value)).not.toContain("sk-proj");
    expect(byText("Change key")).toBeTruthy();
    expect(byText("Remove key")).toBeTruthy();
    act(() => byText("Test connection").click());
    await flush();
    expect(host.textContent).toContain("Connected ✓ The key works.");
  });
});
