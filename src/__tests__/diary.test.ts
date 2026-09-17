import { describe, expect, it, vi } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; other guards read sources this way too.
import { readFileSync } from "node:fs";
import { ChatController, DIARY_SESSION_GAP_MS, type ChatAI } from "../companion/chatController";
import { Diary, entryMarkdown, fileName, makeSummarizer, meaningful, parseSummary, summaryMessages, type DiaryBridge, type DiarySession } from "../companion/diary";
import { EMPTY_MEMORY } from "../companion/memory";
import { DEFAULT_COMPANION } from "../companion/profile";

const T0 = Date.UTC(2026, 8, 14, 16, 5); // 9:35 PM in India
const session = (over: Partial<DiarySession> = {}): DiarySession => ({
  id: "diary-abc",
  startedAt: T0,
  endedAt: T0 + 27 * 60_000,
  lang: "en",
  provider: "local",
  lines: [
    { role: "user", text: "Work was frustrating today, my manager changed the plan again at the last minute." },
    { role: "assistant", text: "Again? Last-minute changes are the worst." },
    { role: "user", text: "And I have a presentation tomorrow, I'm worried about finishing the deck." },
    { role: "assistant", text: "Deck first, the small stuff after." },
  ],
  ...over,
});
const SUMMARY = 'Title: "Rough day at work"\n\nToday I talked about how frustrating work had been after my manager changed the plan again.\n\nI also mentioned tomorrow\'s presentation, and MewMuze helped me decide to finish the deck first.';

function fakeBridge() {
  const files = new Map<string, string>();
  let pending: string | null = null;
  const b: DiaryBridge & { files: Map<string, string>; pending: () => string | null } = {
    files,
    pending: () => pending,
    dir: async () => "C:\\Users\\me\\AppData\\Local\\com.spandan.pixelcat.paper\\diary",
    read: async (n) => files.get(n) ?? null,
    write: async (n, t) => void files.set(n, t),
    remove: async (n) => void files.delete(n),
    clear: async () => files.clear(),
    loadPending: async () => pending,
    savePending: async (j) => void (pending = j),
  };
  return b;
}
const summarizeWith = (text: string | null) => vi.fn(async () => (text === null ? null : { text, by: "local" as const }));
const opts = (enabled = true) => ({ name: () => "Sandy", enabled: () => enabled });

describe("when a conversation is worth a Diary entry", () => {
  it("never for small talk, one accidental line or an unanswered message", () => {
    expect(meaningful([{ role: "user", text: "hi" }, { role: "assistant", text: "Hey!" }, { role: "user", text: "hello" }, { role: "assistant", text: "Hi again" }])).toBe(false);
    expect(meaningful([{ role: "user", text: "asdf" }, { role: "assistant", text: "Hmm?" }])).toBe(false);
    expect(meaningful([{ role: "user", text: "My day was long and tiring and I miss home a lot" }, { role: "user", text: "and nobody called" }])).toBe(false);
    expect(meaningful(session().lines)).toBe(true);
    const long = "I finally told my sister how I felt about the way she spoke to me at dinner, and it went better than I expected, though I still feel a bit shaky about the whole thing and I am not sure it is over yet";
    expect(meaningful([{ role: "user", text: long }, { role: "assistant", text: "That took courage." }])).toBe(true);
  });
});

describe("Diary formatting", () => {
  it("date, time and title, readable as plain Markdown", () => {
    const md = entryMarkdown({ startedAt: T0, endedAt: T0 + 27 * 60_000, title: "Rough day at work", summary: "Today I talked about work." }, "Asia/Kolkata");
    expect(md).toBe('# 14 September 2026\n9:35 PM – 10:02 PM\n\n"Rough day at work"\n\nToday I talked about work.\n');
    expect(entryMarkdown({ startedAt: T0, endedAt: T0, title: "x", summary: "y" }, "Asia/Kolkata")).toContain("\n9:35 PM\n");
  });

  it("files are YYYY-MM-DD_HH-mm_<session-id>.md in local time", () => {
    expect(fileName({ id: "diary-abc", startedAt: T0 })).toMatch(/^2026-09-1[45]_\d\d-\d\d_diary-abc\.md$/);
    expect(fileName({ id: "../../evil", startedAt: T0 })).not.toContain("/");
  });

  it("reads the model's title and entry, and rejects an empty answer", () => {
    expect(parseSummary(SUMMARY)).toEqual({ title: "Rough day at work", summary: expect.stringMatching(/^Today I talked about/) });
    expect(parseSummary("<think></think>**Title:** Interview nerves\n\nI told MewMuze I was nervous about the interview tomorrow.")?.title).toBe("Interview nerves");
    expect(parseSummary("I talked to MewMuze about my weekend plans and felt better.")?.title).toBe("I talked to MewMuze about");
    expect(parseSummary("Title: x\n\nok")).toBeNull();
    expect(parseSummary("Title: Priorities\n\nI finished the deck tonight and felt a bit better. 😼")?.summary).toBe("I finished the deck tonight and felt a bit better.");
  });

  it("asks for the user's own voice, faithfully, in their language - and never invents", () => {
    const [sys, user] = summaryMessages(session({ lang: "hinglish" }), "Sandy");
    expect(sys.content).toContain('first person ("I")');
    expect(sys.content).toContain("never invent");
    expect(sys.content).toContain("not meeting minutes");
    expect(sys.content).toContain("Hinglish");
    expect(user.content).toContain("Sandy: Work was frustrating");
    expect(user.content).toContain("MewMuze: Deck first");
    const huge = session({ lines: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `line ${i} ${"z".repeat(80)}` })) });
    expect(summaryMessages(huge, "Sandy")[1].content.length).toBeLessThanOrEqual(6001);
  });
});

describe("the Diary store", () => {
  it("creates one entry per conversation, and updates the same one when it carries on", async () => {
    const b = fakeBridge();
    const summarize = summarizeWith(SUMMARY);
    const d = new Diary(b, summarize, opts());
    await d.remember(session());
    let list = await d.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "diary-abc", title: "Rough day at work", lines: 4, by: "local" });
    const file = list[0].file;
    expect(b.files.get(file)).toContain('"Rough day at work"');
    // Unchanged: not summarised again.
    await d.remember(session());
    expect(summarize).toHaveBeenCalledTimes(1);
    // Carries on: the same entry and file, updated.
    await d.remember(session({ endedAt: T0 + 40 * 60_000, lines: [...session().lines, { role: "user", text: "Deck is done, thanks" }, { role: "assistant", text: "Proud of you." }] }));
    list = await d.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ file, lines: 6 });
    expect([...b.files.keys()].filter((k) => k.endsWith(".md"))).toEqual([file]);
  });

  it("keeps the conversation pending (encrypted store) when no summariser is available, and writes it later", async () => {
    const b = fakeBridge();
    const d = new Diary(b, summarizeWith(null), opts());
    await d.remember(session());
    expect(await d.list()).toHaveLength(0);
    expect(b.pending()).toContain("diary-abc");
    // Next launch, Local Chat is installed: a fresh Diary on the same storage writes it.
    const later = new Diary(b, summarizeWith(SUMMARY), opts());
    await later.process();
    expect(await later.list()).toHaveLength(1);
    expect(b.pending()).toBeNull();
  });

  it("app close only holds the conversation - no model at quit - and it is summarised at the next start", async () => {
    const b = fakeBridge();
    const summarize = summarizeWith(SUMMARY);
    const d = new Diary(b, summarize, opts());
    expect(await d.hold(session())).toBe(true);
    expect(summarize).not.toHaveBeenCalled();
    expect(b.pending()).toContain("Work was frustrating");
    await new Diary(b, summarizeWith(SUMMARY), opts()).process();
    expect([...b.files.keys()].some((k) => k.endsWith("diary-abc.md"))).toBe(true);
    const app: string = readFileSync("src/App.tsx", "utf8");
    expect(app).toMatch(/Promise\.allSettled\(\[taskStore\.flush\(\), diary\.hold\(chat\.diarySession\(\)\)\]\)/);
    expect(app).toContain("void diary.hold(chat.diarySession());");
  });

  it("a failed summary (model error) keeps the conversation; nothing is lost", async () => {
    const b = fakeBridge();
    const d = new Diary(b, vi.fn(async () => Promise.reject(new Error("Local Chat stopped unexpectedly"))), opts());
    await d.remember(session());
    expect(await d.pendingCount()).toBe(1);
  });

  it("Delete entry and Clear Diary remove only Diary data", async () => {
    const b = fakeBridge();
    const d = new Diary(b, summarizeWith(SUMMARY), opts());
    await d.remember(session());
    await d.remember(session({ id: "diary-two", startedAt: T0 + 86_400_000, endedAt: T0 + 86_400_000 }));
    expect(await d.list()).toHaveLength(2);
    await d.remove("diary-abc");
    expect((await d.list()).map((e) => e.id)).toEqual(["diary-two"]);
    expect([...b.files.keys()].some((k) => k.includes("diary-abc"))).toBe(false);
    await d.clear();
    expect(await d.list()).toEqual([]);
    expect(b.files.size).toBe(0);
  });

  it("with the Diary off, nothing is written or held", async () => {
    const b = fakeBridge();
    const d = new Diary(b, summarizeWith(SUMMARY), opts(false));
    await d.remember(session());
    expect(b.files.size).toBe(0);
    expect(b.pending()).toBeNull();
  });
});

describe("who writes the summary", () => {
  const ai = (text: string): ChatAI & { reply: ReturnType<typeof vi.fn> } => ({
    openChat: vi.fn(async () => undefined),
    closeChat: vi.fn(),
    warm: vi.fn(),
    json: vi.fn(),
    cancelReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => ({ text, firstTokenMs: 0, totalMs: 0, tokens: 0, tokensPerSecond: 0, promptTokens: 0, promptMs: 0, finishReason: "stop", cancelled: false })),
  });

  it("the local model whenever it is installed - even while chatting through Claude", async () => {
    const local = ai(SUMMARY);
    const claude = ai("from claude");
    const s = makeSummarizer({ localInstalled: () => true, local, external: () => ({ id: "anthropic", ai: claude }) });
    expect(await s(summaryMessages(session(), "Sandy"))).toEqual({ text: SUMMARY, by: "local" });
    expect(local.openChat).toHaveBeenCalled();
    expect(local.closeChat).toHaveBeenCalled();
    expect(claude.reply).not.toHaveBeenCalled();
  });

  it("otherwise ONE compact request to the chosen provider, if Settings allow it", async () => {
    const openai = ai(SUMMARY);
    const s = makeSummarizer({ localInstalled: () => false, local: ai("x"), external: () => ({ id: "openai", ai: openai }) });
    expect(await s(summaryMessages(session(), "Sandy"))).toEqual({ text: SUMMARY, by: "openai" });
    expect(openai.reply).toHaveBeenCalledTimes(1);
    const none = makeSummarizer({ localInstalled: () => false, local: ai("x"), external: () => null });
    expect(await none([])).toBeNull();
  });

  it("Settings disclose the external fallback, and it is on only with the Diary", () => {
    const ui: string = readFileSync("src/components/CompanionSettings.tsx", "utf8");
    expect(ui).toContain("the finished conversation is sent once more to");
    expect(ui).toContain("disabled={!c.chat.diary}");
  });
});

// ---- the chat's side: sessions, Forget chat --------------------------------------------------

function chat(now: () => number) {
  const local: ChatAI = {
    openChat: vi.fn(async () => undefined),
    closeChat: vi.fn(),
    warm: vi.fn(),
    json: vi.fn(async () => '{"topic":"chat","second":"none","mood":"neutral","intensity":0}'),
    cancelReply: vi.fn(async () => undefined),
    reply: vi.fn(async (_i, _m, onToken) => {
      onToken("I hear you.");
      return { text: "I hear you.", firstTokenMs: 0, totalMs: 0, tokens: 0, tokensPerSecond: 0, promptTokens: 0, promptMs: 0, finishReason: "stop", cancelled: false };
    }),
  };
  const saved: DiarySession[] = [];
  const memory = { current: EMPTY_MEMORY };
  const c = new ChatController(
    local,
    {
      settings: () => DEFAULT_COMPANION,
      userName: () => "Sandy",
      osLanguage: () => "en-US",
      loadMemory: async () => memory.current,
      saveMemory: async (m) => void (memory.current = m),
      onMood: () => undefined,
      now,
      saveDiary: (s) => saved.push(s),
    },
    () => undefined,
  );
  return { c, saved, memory };
}

describe("Diary sessions in the chat", () => {
  it("closing and reopening soon continues the same entry; a long pause starts a new one", async () => {
    let t = T0;
    const h = chat(() => t);
    await h.c.open();
    await h.c.send("Work was frustrating today, my manager changed the plan again.");
    await h.c.send("I have a presentation tomorrow too.");
    h.c.close();
    expect(h.saved[h.saved.length - 1]).toMatchObject({ lines: expect.any(Array), startedAt: T0 });
    const first = h.saved[h.saved.length - 1].id;
    t += 10 * 60_000;
    await h.c.open();
    await h.c.send("Deck is finished now.");
    h.c.close();
    expect(h.saved[h.saved.length - 1].id).toBe(first);
    expect(h.saved[h.saved.length - 1].lines).toHaveLength(6);
    t += DIARY_SESSION_GAP_MS + 60_000;
    await h.c.open();
    await h.c.send("A new day, a new mood.");
    expect(h.saved[h.saved.length - 1].id).toBe(first); // the old entry was closed out first...
    h.c.close();
    expect(h.saved[h.saved.length - 1].id).not.toBe(first); // ...and the new message is a new entry
    expect(h.saved[h.saved.length - 1].lines).toHaveLength(2);
  });

  it("Forget chat clears chat memory but hands the conversation to the Diary first - which keeps it", async () => {
    const b = fakeBridge();
    const diary = new Diary(b, summarizeWith(SUMMARY), opts());
    const h = chat(() => T0);
    await h.c.open();
    await h.c.send("Call me Sandy. Work was frustrating, my manager changed the plan again.");
    await h.c.send("And tomorrow's presentation worries me.");
    expect(h.memory.current.items.some((i) => i.key === "name")).toBe(true);
    h.c.forgetConversation();
    expect(h.c.state().lines).toEqual([]);
    expect(h.memory.current.items).toEqual([]); // memory from this conversation is gone
    await diary.remember(h.saved[h.saved.length - 1]);
    const entries = await diary.list();
    expect(entries).toHaveLength(1); // the Diary entry stays
    expect(entries[0].title).toBe("Rough day at work");
  });

  it("the Forget confirmation is honest about the Diary", () => {
    const panel: string = readFileSync("src/components/ChatPanel.tsx", "utf8");
    expect(panel).toContain("Forget this conversation?");
    expect(panel).toContain("MewMuze will clear it from chat memory. Your Diary entry will stay unless you delete it from Diary.");
  });
});
