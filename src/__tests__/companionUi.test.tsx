import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPage, CompanionPage, PrivacyBatteryPage, VoicePage, type CompanionPanelApi, type CompanionStatus } from "../components/CompanionSettings";
import { CatContextMenu, RetroNotice } from "../components/OverlayUI";
import { DEFAULT_COMPANION, type CompanionSettings } from "../companion/profile";
import { notInstalled, type ModuleId, type ModuleStatus } from "../companion/modules";
type Remembered = { id: string; label: string };
import { ChatPanel } from "../components/ChatPanel";
import { DictationChip, VoicePanel } from "../components/VoicePanel";
import { IDLE as VOICE_IDLE } from "../companion/voiceController";
import { INITIAL_CHAT, type ChatState } from "../companion/chatController";
import { UNKNOWN_POWER } from "../companion/power";
import { allMenuLabels, openSubmenu } from "./menuHelpers";

// Tell React this is a test renderer, so async state updates are expected.
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
  vi.restoreAllMocks();
});

const STATUS: CompanionStatus = {
  timeZone: "Asia/Kolkata",
  history: [{ at: Date.now(), kind: "greeting", text: "Good morning, Sandy." }],
  watches: {},
  routine: { typicalStart: 570, typicalFinish: 1080, daysLearned: 6 },
  scheduler: { wakeups: 3, runs: 5, networkRuns: 1, failures: 0, jobs: [] },
  net: { requests: 2, bytes: 4096, refusedWhilePaused: 0 },
  power: UNKNOWN_POWER,
  effectiveMode: "balanced",
  weatherUpdated: null,
};

type PageName = "companion" | "voice" | "chat" | "privacy";

/** Render one Settings page with a fake companion API. */
function mount(page: PageName, value: CompanionSettings = DEFAULT_COMPANION, modules: Partial<Record<ModuleId, ModuleStatus>> = {}, memory: Remembered[] = []) {
  const changes: CompanionSettings[] = [];
  let mem = memory;
  const api: CompanionPanelApi = {
    status: vi.fn(async () => STATUS),
    clearData: vi.fn(),
    deleteHistory: vi.fn(),
    resetRoutine: vi.fn(),
    showMyDay: vi.fn(),
    briefing: vi.fn(),
    checkWatches: vi.fn(),
    modules: {
      status: vi.fn(async (id: ModuleId) => modules[id] ?? notInstalled(id)),
      download: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      remove: vi.fn(async () => 1_300_000_000),
      subscribe: vi.fn(async () => () => undefined),
    },
    memory: {
      list: vi.fn(async () => mem),
      forget: vi.fn(async (id: string) => void (mem = mem.filter((i) => i.id !== id))),
      clear: vi.fn(async () => {
        mem = [];
      }),
    },
  };
  const render = (v: CompanionSettings) => {
    const onChange = (next: CompanionSettings) => {
      changes.push(next);
      render(next);
    };
    const props = { value: v, onChange, api };
    act(() =>
      root.render(
        page === "companion" ? (
          <CompanionPage {...props} gmailConnected={false} calendarConnected />
        ) : page === "voice" ? (
          <VoicePage {...props} />
        ) : page === "chat" ? (
          <ChatPage {...props} />
        ) : (
          <PrivacyBatteryPage {...props} gmailConnected={false} calendarConnected />
        ),
      ),
    );
  };
  render(value);
  return { api, changes };
}

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
const button = (text: string) => {
  const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`No button "${text}"`);
  return el;
};
const settle = () => act(async () => undefined);
const switchFor = (label: string) => host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
/** Answer the in-app confirmation dialog (it mounts itself on document.body). */
const answer = async (label: string) => {
  const b = [...document.body.querySelectorAll<HTMLButtonElement>(".mm-confirm button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no confirmation button "${label}"`);
  await act(async () => b.click());
};

describe("Voice and Chat modules", () => {
  it("shows each optional module with its exact size, and downloads only after a confirmed press", async () => {
    const { api } = mount("voice");
    await settle();
    let text = host.textContent ?? "";
    expect(text).toContain("Local Voice");
    expect(text).toContain("Talk instead of typing.");
    expect(text).toContain("Download 86.0 MB");
    expect(text).toContain("Not installed");
    expect(api.modules.download).not.toHaveBeenCalled();
    await act(async () => button("Download").click());
    await answer("Cancel");
    expect(api.modules.download).not.toHaveBeenCalled();
    await act(async () => button("Download").click());
    await answer("Download");
    expect(api.modules.download).toHaveBeenCalledWith("voice");

    act(() => root.unmount());
    root = createRoot(host);
    mount("chat");
    await settle();
    text = host.textContent ?? "";
    expect(text).toContain("Private conversations with MewMuze.");
    expect(text).toContain("Download 1.21 GB");
    // Engine and model names live under "Technical details", not in the pitch.
    expect(host.querySelector(".mm-tech")?.textContent).toContain("Qwen3-1.7B (Q4_K_M)");
    expect(host.querySelector(".mm-module-text")?.textContent).not.toContain("Qwen");
    expect(text).toContain("Needs both");
  });

  it("shows progress with pause/cancel while downloading, and each module independently", async () => {
    const modules = {
      voice: { ...notInstalled("voice"), state: "downloading" as const, progress: 0.4, bytesDone: 36_000_000, bytesTotal: 90_130_425 },
      chat: { ...notInstalled("chat"), state: "installed" as const, version: "llama.cpp b10894 · Qwen3-1.7B-Q4_K_M", storageBytes: 1_327_000_000, progress: 1 },
    };
    mount("voice", DEFAULT_COMPANION, modules);
    await settle();
    expect(host.textContent).toContain("Downloading · 34.3 MB of 86.0 MB (40%)");
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Pause", "Cancel"]));
    act(() => root.unmount());
    root = createRoot(host);
    mount("chat", DEFAULT_COMPANION, modules);
    await settle();
    expect(host.textContent).toContain("llama.cpp b10894 · Qwen3-1.7B-Q4_K_M");
    expect(host.textContent).toContain("Uses 1.24 GB of storage");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toContain("Remove");
  });

  it("removes a module after confirming and reports the space freed", async () => {
    const { api } = mount("chat", DEFAULT_COMPANION, { chat: { ...notInstalled("chat"), state: "installed", progress: 1 } });
    await settle();
    await act(async () => button("Remove").click());
    await answer("Remove");
    expect(api.modules.remove).toHaveBeenCalledWith("chat");
    expect(host.textContent).toContain("Local Chat removed — 1.21 GB freed.");
  });

  it("offers voice chat when both are installed", async () => {
    const installed = (id: ModuleId) => ({ ...notInstalled(id), state: "installed" as const, progress: 1 });
    mount("chat", DEFAULT_COMPANION, { voice: installed("voice"), chat: installed("chat") });
    await settle();
    expect(host.textContent).toContain("Available");
  });
});

describe("Voice and Chat settings", () => {
  it("edits the dictation shortcut only when valid", async () => {
    const { changes } = mount("voice");
    const input = host.querySelector<HTMLInputElement>("input[aria-invalid]")!;
    const setValue = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    setValue("Ctrl+Nope");
    expect(button("Set").disabled).toBe(true);
    setValue("Ctrl+Shift+D");
    act(() => button("Set").click());
    expect(last(changes)?.voice.shortcut).toBe("Ctrl+Shift+D");
  });

  it("lists everything remembered - preferences, learned style, check-ins - forgets one, and clears all after confirming", async () => {
    const { api } = mount("chat", DEFAULT_COMPANION, {}, [
      { id: "pref:name", label: "Call you Sandy" },
      { id: "style:0", label: "Learned: you like short replies" },
      { id: "fu:fu-1-unwell", label: "Check in about how you're feeling · Saturday" },
    ]);
    await settle();
    expect(host.textContent).toContain("Call you Sandy");
    expect(host.textContent).toContain("Learned: you like short replies");
    expect(host.textContent).toContain("Check in about how you're feeling");
    await act(async () => button("Forget").click());
    expect(api.memory.forget).toHaveBeenCalledWith("pref:name");
    expect(host.textContent).not.toContain("Call you Sandy");
    await act(async () => button("Clear").click());
    await answer("Clear");
    expect(api.memory.clear).toHaveBeenCalled();
    expect(host.textContent).toContain("Nothing yet.");
  });

  it("offers the conversation settings from the brief, and never the internal persona list", async () => {
    const { changes } = mount("chat");
    await settle();
    const style = host.querySelector<HTMLSelectElement>('[data-setting="conversation-style"] select')!;
    expect([...style.options].map((o) => o.textContent)).toEqual(["Automatic", "MewMuze", "Listener", "Coach", "Playful", "Direct"]);
    expect(host.textContent).not.toMatch(/Savage Bestie|Breakup Buddy|Rant Buddy/);
    for (const label of ["Show active mode", "Remember useful things", "Follow up on things I tell you", "Gentle follow-ups"]) {
      expect(host.querySelector(`[aria-label="${label}"]`), label).toBeTruthy();
    }
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Gentle follow-ups"]')!.click());
    expect(last(changes)?.chat.gentleFollowUps).toBe(true);
  });
});

describe("Privacy & Battery", () => {
  it("labels every data source honestly and never claims 'no network connections'", async () => {
    mount("privacy");
    await settle();
    const rows = [...host.querySelectorAll(".sk-row")].map((r) => r.textContent ?? "");
    const badge = (what: string) => rows.find((r) => r.startsWith(what));
    expect(badge("Time and time zone")).toMatch(/On this computer$/);
    expect(badge("Learn my routine")).toMatch(/On this computer$/);
    expect(badge("Weather")).toMatch(/Internet$/);
    expect(badge("Calendar")).toMatch(/Your account$/);
    expect(badge("Email")).toMatch(/Your account$/);
    expect(badge("Local Voice")).toMatch(/On this computer$/);
    expect(badge("Local Chat")).toMatch(/On this computer$/);
    expect(host.textContent).not.toMatch(/no network connections/i);
    expect(host.textContent).toContain("2 internet requests");
  });

  it("wires Pause internet, routine learning, Delete history and Clear data - the last only after confirming", async () => {
    const { api, changes } = mount("privacy");
    await settle();
    act(() => switchFor("Pause internet features").click());
    expect(last(changes)?.internetPaused).toBe(true);
    act(() => switchFor("Learn my routine").click());
    expect(last(changes)?.features.routineLearning).toBe(false);
    act(() => button("Delete").click());
    expect(api.deleteHistory).toHaveBeenCalledTimes(1);
    act(() => button("Reset").click());
    expect(api.resetRoutine).toHaveBeenCalledTimes(1);
    await act(async () => button("Clear…").click());
    await answer("Cancel");
    expect(api.clearData).not.toHaveBeenCalled();
    await act(async () => button("Clear…").click());
    await answer("Clear");
    expect(api.clearData).toHaveBeenCalledTimes(1);
  });

  it("switches power use, and says in plain words what is running", async () => {
    const { changes } = mount("privacy");
    await settle();
    const saver = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.textContent?.startsWith("Battery Saver"))!;
    act(() => saver.click());
    expect(last(changes)?.powerMode).toBe("saver");
    expect(host.querySelector(".mm-live")?.textContent).toContain("Nothing extra is running.");
  });
});

describe("Personal Companion page", () => {
  it("edits the profile in place", () => {
    const { changes } = mount("companion");
    act(() => button("Playful").click());
    expect(last(changes)?.personality).toBe("playful");
    act(() => switchFor("Work hours").click());
    expect(last(changes)?.workHours.enabled).toBe(true);
  });

  it("marks email updates as needing a connection when Gmail is not connected", () => {
    mount("companion");
    const row = [...host.querySelectorAll(".sk-row")].find((r) => r.textContent?.startsWith("Email"))!;
    expect(row.textContent).toContain("Connect Gmail in Connections first.");
  });

  it("creates, pauses and deletes a watch", () => {
    const { changes } = mount("companion");
    act(() => button("Create").click());
    expect(last(changes)?.watches[0]).toMatchObject({ kind: "fx", base: "USD", quote: "INR", threshold: 90, direction: "above" });
    act(() => button("Pause").click());
    expect(last(changes)?.watches[0].paused).toBe(true);
    act(() => button("Delete").click());
    expect(last(changes)?.watches).toEqual([]);
  });
});

describe("companion card and menu", () => {
  it("renders a multi-line card in the retro notice, with its actions", () => {
    const onAction = vi.fn();
    act(() =>
      root.render(
        <RetroNotice
          bubble={{ id: "cmp:x", message: "Welcome back, Sandy.", lines: ["While you were away:", "2 important emails"], actions: [{ id: "open-calendar", label: "Open Calendar", href: "https://calendar.google.com/calendar/r/day" }], snoozable: false }}
          catCx={500}
          catTop={500}
          areaLeft={0}
          areaRight={1200}
          onDismiss={() => undefined}
          onSnooze={() => undefined}
          onAction={onAction}
        />,
      ),
    );
    const card = host.querySelector(".retro-notice")!;
    expect(card.classList.contains("notice-card")).toBe(true);
    expect([...card.querySelectorAll(".retro-line")].map((l) => l.textContent)).toEqual(["Welcome back, Sandy.", "While you were away:", "2 important emails"]);
    act(() => button("Open Calendar").click());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "open-calendar" }));
  });

  it("keeps an ordinary one-line notice exactly as before", () => {
    act(() =>
      root.render(<RetroNotice bubble={{ id: "r", message: "Stretch!", snoozable: true }} catCx={0} catTop={0} areaLeft={0} areaRight={800} onDismiss={() => undefined} onSnooze={() => undefined} />),
    );
    const n = host.querySelector(".retro-notice")!;
    expect(n.classList.contains("notice-card")).toBe(false);
    expect([...n.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Snooze", "OK"]);
  });

  it("offers My Day in the cat's menu", () => {
    const seen: string[] = [];
    act(() => root.render(<CatContextMenu state={{ x: 10, y: 10 }} workMode={false} session={null} clipboardEnabled onCommand={(c) => seen.push(c)} onClose={() => undefined} />));
    const item = [...host.querySelectorAll<HTMLElement>(".cat-menu-item")].find((n) => n.textContent?.includes("My Day"))!;
    act(() => item.click());
    expect(seen).toEqual(["my-day"]);
  });
});

describe("Phase 2 panels", () => {
  const cat = { x: 600, y: 700, width: 88, height: 88 };
  const area = { left: 0, top: 0, right: 1600, bottom: 900 };
  const chat = (over: Partial<ChatState> = {}): ChatState => ({ ...INITIAL_CHAT, status: "ready", ...over });
  const handlers = () => ({
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onForget: vi.fn(),
    onMicStart: vi.fn(),
    onMicStop: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
  });

  it("chat reads like a script, works by keyboard alone, and hides the mic without Local Voice", () => {
    const h = handlers();
    act(() =>
      root.render(
        <ChatPanel
          cat={cat}
          area={area}
          name="Sandy"
          chat={chat({ lines: [{ id: "1", role: "user", text: "Today was horrible." }, { id: "2", role: "assistant", text: "That sounds rough. What happened?" }] })}
          voice={VOICE_IDLE}
          voiceAvailable={false}
          {...h}
        />,
      ),
    );
    expect([...host.querySelectorAll(".cp-who")].map((n) => n.textContent)).toEqual(["Sandy:", "MewMuze:"]);
    expect(host.querySelector(".cp-mic")).toBeNull();
    const ta = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "hello");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(h.onSend).toHaveBeenCalledWith("hello");
    expect(host.textContent).toContain("Private · runs on this computer");
  });

  it("shows the active mode as a chip that changes with the persona, and none for plain MewMuze", () => {
    const h = handlers();
    const render = (primary: string | null, showMode = true) =>
      act(() => root.render(<ChatPanel cat={cat} area={area} name="Sandy" chat={chat({ persona: primary ? { primary, secondary: null } : null })} voice={VOICE_IDLE} voiceAvailable={false} showMode={showMode} {...h} />));
    render("health_guide");
    const chip = host.querySelector(".mm-persona-chip")!;
    expect(chip.textContent).toBe("🩺 Health Guide");
    expect(chip.getAttribute("aria-label")).toBe("Mode: Health Guide");
    render("love_guru");
    // A new persona is a new chip element, so its entrance animation plays again.
    expect(host.querySelector(".mm-persona-chip")).not.toBe(chip);
    expect(host.querySelector(".mm-persona-chip")!.textContent).toBe("💗 Love Guru");
    render("mewmuze");
    expect(host.querySelector(".mm-persona-chip")).toBeNull();
    render("savage_bestie", false);
    expect(host.querySelector(".mm-persona-chip")).toBeNull();
  });

  it("offers push-to-talk when Local Voice exists, and shows listening state", () => {
    const h = handlers();
    act(() =>
      root.render(
        <ChatPanel cat={cat} area={area} name="Sandy" chat={chat()} voice={{ ...VOICE_IDLE, mode: "chat", phase: "recording", seconds: 3, level: 0.1 }} voiceAvailable {...h} />,
      ),
    );
    expect(host.textContent).toContain("What’s on your mind, Sandy?");
    expect(host.textContent).toContain("Listening… 3s");
    act(() => host.querySelector<HTMLButtonElement>(".cp-mic")!.click());
    expect(h.onMicStop).toHaveBeenCalled();
  });

  it("recorder shows CLEAN and RAW, and never drops the raw transcript", () => {
    const done = { ...VOICE_IDLE, mode: "recorder" as const, phase: "done" as const, raw: "um so Thursday, sorry, Friday at 3", clean: "So Friday at 3.", language: "en", recordingPath: "rec-1.wav", transcript: { text: "", language: "en", audioSeconds: 6.3, elapsedMs: 2100, realTimeFactor: 0.33, threads: 8 } };
    const onCopy = vi.fn();
    act(() => root.render(<VoicePanel cat={cat} area={area} voice={done} onStart={vi.fn()} onStop={vi.fn()} onCancel={vi.fn()} onCopy={onCopy} onSaveRecording={vi.fn()} onNew={vi.fn()} onClose={vi.fn()} />));
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("So Friday at 3.");
    act(() => button("RAW").click());
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("um so Thursday, sorry, Friday at 3");
    act(() => button("Copy all").click());
    expect(onCopy).toHaveBeenCalledWith("um so Thursday, sorry, Friday at 3");
    expect(host.textContent).toContain("Copied ✓");
    expect(host.textContent).toContain("Save recording…");
  });

  it("shows a microphone indicator only while dictating", () => {
    act(() => root.render(<DictationChip voice={{ ...VOICE_IDLE, mode: "dictation", phase: "recording", seconds: 4, level: 0.2 }} catCx={500} catTop={600} />));
    expect(host.textContent).toContain("Listening… 0:04");
    act(() => root.render(<DictationChip voice={VOICE_IDLE} catCx={500} catTop={600} />));
    expect(host.querySelector(".dictation-chip")).toBeNull();
  });

  it("always offers Chat (it opens Settings when Local Chat is missing), the recorder only with Local Voice", () => {
    const seen: string[] = [];
    const render = (voiceAvailable: boolean) =>
      act(() => root.render(<CatContextMenu state={{ x: 10, y: 10 }} workMode={false} session={null} clipboardEnabled chatAvailable={false} voiceAvailable={voiceAvailable} onCommand={(c) => seen.push(c)} onClose={() => undefined} />));
    render(false);
    expect(host.textContent).toContain("Chat with MewMuze");
    expect(allMenuLabels(host).join("|")).not.toContain("Voice recorder");
    render(true);
    openSubmenu(host, "Quick Tools");
    expect(host.textContent).toContain("Voice recorder");
  });
});
