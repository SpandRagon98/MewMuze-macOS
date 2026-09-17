import { describe, expect, it, vi } from "vitest";
import { cleanTranscript } from "../companion/cleanup";
import { detectLanguage, languageInstruction, replyLanguage } from "../companion/language";
import { MOOD_SCHEMA, MoodInfluence, NEUTRAL, catReaction, validateMood } from "../companion/mood";
import { EMPTY_MEMORY, describeItem, extractPreferences, forgetConversation, forgetItem, parseMemory, remember, view } from "../companion/memory";
import { buildMessages, systemPrompt, tidyReply } from "../companion/chatPrompt";
import { LocalAIManager, type AIBridge, type GenStats, type RustModuleStatus, type Transcript } from "../companion/localAI";
import { AIUsageMonitor, COOLDOWN_MS } from "../companion/aiUsage";
import { VoiceController, type VoiceBridge, type VoiceState } from "../companion/voiceController";
import { ChatController, type ChatState } from "../companion/chatController";
import type { FollowUp } from "../companion/persona/followUps";
import { EMPTY_STYLE, type StyleProfile } from "../companion/persona/style";
import { CLASSIFY_NOTE } from "../companion/persona/router";
import { DEFAULT_COMPANION, sanitizeCompanion } from "../companion/profile";
import type { LifecycleEnv } from "../companion/lifecycle";

const MIN = 60_000;

// ---- cleanup ----------------------------------------------------------------------

describe("transcript cleanup (deterministic)", () => {
  it("handles the example correction exactly", () => {
    expect(cleanTranscript("Thursday, sorry, Friday at 3")).toBe("Friday at 3.");
    expect(cleanTranscript("meet me at 4 I mean 5 tomorrow")).toBe("Meet me at 5 tomorrow.");
  });

  it("never rewrites a correction between different kinds of words", () => {
    expect(cleanTranscript("the report, sorry, it's late")).toBe("The report, sorry, it's late.");
    expect(cleanTranscript("I'm sorry about Friday")).toBe("I'm sorry about Friday.");
  });

  it("drops fillers with their commas, and stutters, but keeps emphasis", () => {
    expect(cleanTranscript("um, I, uh, think the the plan is erm fine")).toBe("I think the plan is fine.");
    expect(cleanTranscript("it was very very good")).toBe("It was very very good.");
    expect(cleanTranscript("I I I need a break")).toBe("I need a break.");
  });

  it("turns spoken punctuation into punctuation, but keeps 'period' as a word mid-sentence", () => {
    expect(cleanTranscript("hello comma how are you question mark")).toBe("Hello, how are you?");
    expect(cleanTranscript("first line new line second line full stop")).toBe("First line\nSecond line.");
    expect(cleanTranscript("the trial period ends soon")).toBe("The trial period ends soon.");
    expect(cleanTranscript("see you soon period")).toBe("See you soon.");
    expect(cleanTranscript("say comma please", { spokenPunctuation: false })).toBe("Say comma please.");
  });

  it("fixes spacing, capitals and the pronoun I, without breaking times or URLs", () => {
    expect(cleanTranscript("  i think i'm late .  at 3:30 we meet ,ok  ")).toBe("I think I'm late. At 3:30 we meet, ok.");
    expect(cleanTranscript("open example.com please")).toBe("Open example.com please.");
  });

  it("removes Whisper's non-speech tags and keeps Hindi as Hindi", () => {
    expect(cleanTranscript("[BLANK_AUDIO] hello (music) there")).toBe("Hello there.");
    expect(cleanTranscript("आज का दिन अच्छा था")).toBe("आज का दिन अच्छा था।");
    expect(cleanTranscript("")).toBe("");
  });
});

// ---- language ------------------------------------------------------------------

describe("language mirroring", () => {
  it("detects English, Hindi and Hinglish", () => {
    expect(detectLanguage("I had a rough day at work")).toBe("en");
    expect(detectLanguage("आज का दिन बहुत थका देने वाला था।")).toBe("hi");
    expect(detectLanguage("Yaar aaj office mein bahut kaam tha")).toBe("hinglish");
    expect(detectLanguage("kya hua?")).toBe("hinglish");
    expect(detectLanguage("👍")).toBeNull();
  });

  it("falls back to the conversation, then the profile, when a message is unclear", () => {
    expect(replyLanguage("ok 👍", "hinglish", "en")).toBe("hinglish");
    expect(replyLanguage("👍", null, "hi")).toBe("hi");
    expect(languageInstruction("hinglish")).toMatch(/English letters/);
    expect(languageInstruction("hi")).toMatch(/Devanagari/);
  });
});

// ---- mood ----------------------------------------------------------------------

describe("mood metadata", () => {
  it("accepts only well-formed, in-range metadata", () => {
    expect(validateMood('{"mood":"sad","intensity":2}')).toEqual({
      mood: "sad",
      intensity: 2 / 3,
    });
    // What the model actually produced before the schema was fixed: rejected.
    expect(validateMood('{"mood":"frustrated","intensity":2.5}')).toBeNull();
    expect(validateMood('{"mood":"depressed","intensity":1}')).toBeNull();
    expect(validateMood('{"mood":"sad","intensity":4}')).toBeNull();
    expect(validateMood("not json")).toBeNull();
    expect(validateMood("[]")).toBeNull();
    expect(MOOD_SCHEMA.properties.intensity.enum).toEqual([0, 1, 2, 3]);
  });

  it("decays after the conversation and never sticks", () => {
    const m = new MoodInfluence();
    m.set({ mood: "sad", intensity: 1 }, 0);
    expect(m.get(0).mood).toBe("sad");
    expect(m.get(4 * MIN).intensity).toBeCloseTo(Math.exp(-1), 2);
    expect(m.get(10 * MIN)).toEqual(NEUTRAL);
  });

  it("maps moods to existing, gentle cat behaviour", () => {
    const mk = (mood: "sad" | "frustrated" | "happy" | "excited" | "tired", intensity = 1) => catReaction({ mood, intensity });
    expect(mk("sad")).toEqual({ once: "cuteNod", hold: "sit" });
    expect(mk("frustrated").hold).toBe("watch");
    expect(mk("happy").once).toBe("happy");
    expect(mk("excited").once).toBe("celebrate");
    expect(mk("tired").once).toBe("yawn");
    expect(mk("sad", 0.1)).toEqual({});
  });
});

// ---- memory ----------------------------------------------------------------------

describe("chat memory", () => {
  it("extracts only safe preferences - never feelings or events", () => {
    expect(extractPreferences("Please call me Sandy from now on")).toEqual([{ key: "name", value: "Sandy" }]);
    expect(extractPreferences("can you reply in Hinglish and keep it short")).toEqual([
      { key: "language", value: "hinglish" },
      { key: "length", value: "short" },
    ]);
    expect(extractPreferences("be more playful")).toEqual([{ key: "personality", value: "playful" }]);
    expect(extractPreferences("I feel terrible, my manager yelled at me and I cried")).toEqual([]);
    expect(extractPreferences("my name is being dragged through the mud")).toEqual([]);
  });

  it("keeps the latest value per key, and forgets by conversation or item", () => {
    let m = remember(EMPTY_MEMORY, [{ key: "name", value: "Sandy" }], "c1", 1);
    m = remember(m, [{ key: "name", value: "Sam" }, { key: "length", value: "short" }], "c2", 2);
    expect(view(m)).toEqual({ name: "Sam", language: undefined, length: "short", personality: undefined });
    expect(forgetConversation(m, "c2").items).toEqual([]);
    expect(forgetItem(m, "length").items.map((i) => i.key)).toEqual(["name"]);
    expect(describeItem(m.items[0])).toBe("Call you Sam");
  });

  it("drops anything unexpected in the stored blob", () => {
    expect(parseMemory(null)).toEqual(EMPTY_MEMORY);
    expect(parseMemory("garbage")).toEqual(EMPTY_MEMORY);
    const parsed = parseMemory(JSON.stringify({ items: [{ key: "name", value: "Sandy", conversation: "c", at: 1 }, { key: "diary", value: "secret" }, { key: "name", value: "x".repeat(99) }] }));
    expect(parsed.items.map((i) => i.value)).toEqual(["Sandy"]);
  });
});

// ---- prompt ------------------------------------------------------------------------

describe("chat prompt", () => {
  it("is a friend with a personality, not a therapist, and mirrors the language", () => {
    const p = systemPrompt({ name: "Sandy", lang: "hinglish", personality: "cozy", memory: {} });
    expect(p).toMatch(/not a therapist/);
    expect(p).toMatch(/best friend/i);
    expect(p).toMatch(/Hinglish/);
    expect(p).toMatch(/\/no_think/);
    expect(systemPrompt({ name: "Sandy", lang: "en", personality: "cozy", memory: { name: "Sam", length: "short" } })).toMatch(/Sam's desktop.*One or two short sentences/);
  });

  it("keeps recent history within budget and never starts with the cat", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i} ${"x".repeat(400)}` }));
    const msgs = buildMessages("SYS", history);
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1].role).toBe("user");
    expect(msgs.length).toBeLessThanOrEqual(17);
    expect(msgs[msgs.length - 1].content.startsWith("m39")).toBe(true);
  });

  it("removes what the 1.7B model was seen to do: echoes, repeats, think tags, stray Han characters", () => {
    const user = "Yaar aaj office mein bahut kaam tha, thak gaya hoon.";
    expect(tidyReply("Aaj office mein bahut kaam tha, thak gaya hoon. Kya ab kya karne wale hai?", user)).toBe("Kya ab kya karne wale hai?");
    expect(tidyReply("Yaar aaj office mein bahut kaam tha, thak gaya hoon, ab thoda rest karo?", user)).toBe("Ab thoda rest karo?");
    expect(tidyReply("Take a break. Take a break. How are you?", "I am tired")).toBe("Take a break. How are you?");
    expect(tidyReply("<think>\n\n</think>\n\nThat sounds hard.", "x")).toBe("That sounds hard.");
    expect(tidyReply("इस बारे中 बात करें?", "मुझे टेंशन है")).toBe("इस बारे बात करें?");
    expect(tidyReply("Congrats! 🎉 You did it 🐱‍🔥", "x")).toBe("Congrats! You did it");
    expect(tidyReply("Oh no, that's rough. Hmm, it's okay to feel that way. Let me know if you need anything!", "x")).toBe("Oh no, that's rough.");
    expect(tidyReply("You're not alone.", "x")).toBe("You're not alone.");
    expect(tidyReply("Yes, I'm here for you. You've got this, Sandy. Tea first, then the bug.", "x")).toBe("Tea first, then the bug.");
    // Never empties a reply entirely.
    expect(tidyReply("Thak gaya hoon.", "thak gaya hoon")).toBe("Thak gaya hoon.");
  });
});

// ---- LocalAIManager ------------------------------------------------------------------

function fakeBridge(opts: { voice?: boolean; chat?: boolean; failLoad?: boolean } = {}) {
  const calls: string[] = [];
  const status = (installed: boolean): RustModuleStatus => ({ id: "x", state: installed ? "installed" : "not-installed", progress: 0, bytesDone: 0, bytesTotal: 0, version: null, catalogVersion: "", downloadBytes: 0, storageBytes: 0, error: null });
  let release: (() => void) | null = null;
  const bridge: AIBridge = {
    moduleStatus: async (id) => status(id === "voice" ? opts.voice !== false : opts.chat !== false),
    chatLoad: async (threads) => {
      calls.push(`load:${threads}`);
      if (opts.failLoad) throw new Error("Local Chat stopped while loading (exit Some(-1073741819)).");
      return { loadMs: 4600, threads, alreadyLoaded: false };
    },
    chatUnload: async () => {
      calls.push("unload");
      return true;
    },
    chatGenerate: async (id, _m, _max, _t, onToken) => {
      calls.push(`gen:${id}`);
      onToken("Hello");
      onToken(" there");
      if (id === "slow") await new Promise<void>((r) => (release = r));
      return { text: "Hello there", firstTokenMs: 400, totalMs: 900, tokens: 3, tokensPerSecond: 13, promptTokens: 20, promptMs: 100, finishReason: "stop", cancelled: false } as GenStats;
    },
    chatCancel: async (id) => void calls.push(`cancel:${id}`),
    chatJson: async () => '{"mood":"sad","intensity":2}',
    transcribe: async (_p, lang, threads) => {
      calls.push(`transcribe:${lang}:${threads}`);
      return { text: "um hello there", language: "en", audioSeconds: 6, elapsedMs: 2100, realTimeFactor: 0.35, threads } as Transcript;
    },
    voiceCancel: async () => void calls.push("voice-cancel"),
    status: async () => ({ chatLoaded: false, chatThreads: 0, chatLoadedSeconds: 0, chatMemoryBytes: 0, voiceBusy: false, voiceMemoryBytes: 0, cpuSeconds: 0, chatCrashes: 0, availableMemoryBytes: 0 }),
  };
  return { bridge, calls, releaseSlow: () => release?.() };
}

function fakeEnv() {
  const timers = new Map<number, () => void>();
  let id = 0;
  const env: LifecycleEnv = { setTimer: (fn) => (timers.set(++id, fn), id), clearTimer: (h) => timers.delete(h as number), cpuThreads: 16 };
  return { env, pending: () => timers.size, fireAll: async () => {
    for (const [k, fn] of [...timers]) {
      timers.delete(k);
      fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  } };
}

describe("LocalAIManager", () => {
  it("loads nothing until a chat opens, and unloads after the grace period", async () => {
    const f = fakeBridge();
    const e = fakeEnv();
    const ai = new LocalAIManager(f.bridge, e.env);
    expect(f.calls).toEqual([]);
    expect(ai.chatState()).toBe("absent");
    await ai.openChat();
    expect(f.calls).toEqual(["load:8"]); // Balanced: half of 16 logical threads
    ai.closeChat();
    expect(e.pending()).toBe(1);
    await e.fireAll();
    expect(f.calls).toContain("unload");
    expect(ai.chatState()).toBe("unloaded");
  });

  it("never unloads mid-reply, and reuses the loaded model across replies", async () => {
    const f = fakeBridge();
    const e = fakeEnv();
    const ai = new LocalAIManager(f.bridge, e.env);
    await ai.openChat();
    ai.closeChat(); // grace timer armed
    const slow = ai.reply("slow", [], () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    await e.fireAll(); // the old timer was cancelled by the reply's hold
    expect(f.calls).not.toContain("unload");
    f.releaseSlow();
    await slow;
    expect(f.calls.filter((c) => c.startsWith("load")).length).toBe(1);
  });

  it("applies Battery Saver between replies: fewer threads, shorter grace", async () => {
    const f = fakeBridge();
    const ai = new LocalAIManager(f.bridge, fakeEnv().env);
    await ai.openChat();
    await ai.reply("r1", [], () => undefined);
    ai.setMode("saver");
    expect(ai.threads()).toBe(4);
    expect(ai.lifecycle.idleUnloadMs()).toBe(20_000);
    await ai.reply("r2", [], () => undefined);
    expect(f.calls).toEqual(["load:8", "gen:r1", "load:4", "gen:r2"]);
  });

  it("serialises AI work through one queue", async () => {
    const f = fakeBridge();
    const ai = new LocalAIManager(f.bridge, fakeEnv().env);
    const a = ai.reply("slow", [], () => undefined);
    const b = ai.transcribe("rec-1.wav", "auto");
    await new Promise((r) => setTimeout(r, 5));
    expect(f.calls.some((c) => c.startsWith("transcribe"))).toBe(false);
    expect(ai.busy()).toBe("generate");
    f.releaseSlow();
    await a;
    await b;
    expect(f.calls[f.calls.length - 1]).toBe("transcribe:auto:8");
  });

  it("works with either module alone, and isolates failures", async () => {
    const chatOnly = new LocalAIManager(fakeBridge({ voice: false }).bridge, fakeEnv().env);
    await expect(chatOnly.transcribe("rec-1.wav", "en")).rejects.toThrow("Local Voice is not installed");
    await expect(chatOnly.openChat()).resolves.toBeUndefined();

    const voiceOnly = new LocalAIManager(fakeBridge({ chat: false }).bridge, fakeEnv().env);
    await expect(voiceOnly.openChat()).rejects.toThrow("Local Chat is not installed");
    await expect(voiceOnly.transcribe("rec-1.wav", "en")).resolves.toMatchObject({ text: "um hello there" });

    const crashy = new LocalAIManager(fakeBridge({ failLoad: true }).bridge, fakeEnv().env);
    await expect(crashy.openChat()).rejects.toThrow("stopped while loading");
    expect(crashy.chatState()).toBe("failed");
    // A failed job does not block the queue.
    await expect(crashy.transcribe("rec-1.wav", "en")).resolves.toBeTruthy();
  });

  it("recovers from a crashed model process: reloads once and retries the reply", async () => {
    const f = fakeBridge();
    let crashes = 1;
    const gen = f.bridge.chatGenerate;
    f.bridge.chatGenerate = async (...args) => {
      if (crashes-- > 0) throw new Error("Local Chat stopped unexpectedly (exit Some(-1073741819)).");
      return gen(...args);
    };
    const e = fakeEnv();
    const ai = new LocalAIManager(f.bridge, e.env);
    await ai.openChat();
    await expect(ai.reply("r1", [], () => undefined)).resolves.toMatchObject({ text: "Hello there" });
    expect(f.calls.filter((c) => c.startsWith("load")).length).toBe(2);
    // The hold count is intact: closing still unloads after the grace period.
    ai.closeChat();
    await e.fireAll();
    expect(ai.chatState()).toBe("unloaded");
  });

  it("skips a classifier request cancelled while still queued, so the next reply is not held back", async () => {
    const f = fakeBridge();
    const json = vi.fn(f.bridge.chatJson);
    f.bridge.chatJson = json;
    const ai = new LocalAIManager(f.bridge, fakeEnv().env);
    await ai.openChat();
    const slow = ai.reply("slow", [], () => undefined);
    const mood = ai.json("m1", [], {});
    await ai.cancelReply("m1");
    await new Promise((r) => setTimeout(r, 0));
    f.releaseSlow();
    await slow;
    await expect(mood).rejects.toThrow(/cancelled/);
    expect(json).not.toHaveBeenCalled();
  });

  it("forgets a removed module and cancels through the bridge", async () => {
    const f = fakeBridge();
    const ai = new LocalAIManager(f.bridge, fakeEnv().env);
    await ai.openChat();
    await ai.cancelReply("r9");
    await ai.forget("chat");
    expect(f.calls).toEqual(["load:8", "cancel:r9", "unload"]);
    expect(ai.chatState()).toBe("absent");
  });
});

// ---- battery guard ------------------------------------------------------------------

describe("AIUsageMonitor", () => {
  const feed = (m: AIUsageMonitor, opts: { battery: boolean; busy: boolean; minutes: number; cores?: number }) => {
    let cpu = 0;
    for (let t = 0; t <= opts.minutes * 2; t++) {
      cpu += (opts.cores ?? 0) * 30;
      m.push({ at: t * 30_000, onBattery: opts.battery, busy: opts.busy, cpuSeconds: cpu });
    }
    return opts.minutes * MIN;
  };

  it("warns once for sustained AI work on battery", () => {
    const m = new AIUsageMonitor();
    const now = feed(m, { battery: true, busy: true, minutes: 6 });
    expect(m.evaluate(now, { recording: false, muted: false })).toBe("warn");
    m.quiet(now);
    expect(m.evaluate(now + MIN, { recording: false, muted: false })).toBe("none");
    // After the cooldown, a new sustained stretch may warn again.
    const later = now + COOLDOWN_MS;
    for (let t = 0; t <= 12; t++) m.push({ at: later + t * 30_000, onBattery: true, busy: true, cpuSeconds: 0 });
    expect(m.evaluate(later + 6 * MIN, { recording: false, muted: false })).toBe("warn");
  });

  it("also counts sustained CPU even between bursts", () => {
    const m = new AIUsageMonitor();
    const now = feed(m, { battery: true, busy: false, minutes: 6, cores: 1 });
    expect(m.evaluate(now, { recording: false, muted: false })).toBe("warn");
  });

  it("stays quiet on AC, for short use, when muted - and waits during a recording", () => {
    const ac = new AIUsageMonitor();
    expect(ac.evaluate(feed(ac, { battery: false, busy: true, minutes: 10 }), { recording: false, muted: false })).toBe("none");
    const short = new AIUsageMonitor();
    expect(short.evaluate(feed(short, { battery: true, busy: true, minutes: 3 }), { recording: false, muted: false })).toBe("none");
    const light = new AIUsageMonitor();
    expect(light.evaluate(feed(light, { battery: true, busy: false, minutes: 10, cores: 0.2 }), { recording: false, muted: false })).toBe("none");
    const muted = new AIUsageMonitor();
    expect(muted.evaluate(feed(muted, { battery: true, busy: true, minutes: 10 }), { recording: false, muted: true })).toBe("none");
    const rec = new AIUsageMonitor();
    expect(rec.evaluate(feed(rec, { battery: true, busy: true, minutes: 10 }), { recording: true, muted: false })).toBe("defer");
  });
});

// ---- voice controller ----------------------------------------------------------------

function fakeVoice(opts: { denied?: boolean } = {}) {
  const calls: string[] = [];
  const bridge: VoiceBridge = {
    start: async () => {
      calls.push("start");
      if (opts.denied) throw new Error("The microphone is blocked or busy. Check Windows Settings → Privacy → Microphone.");
      return { device: "Mic" };
    },
    level: async () => ({ recording: true, level: 0.1, seconds: 1, atLimit: false }),
    stop: async () => (calls.push("stop"), { path: "rec-1.wav", seconds: 6 }),
    cancel: async () => void calls.push("cancel"),
    discard: async (p) => void calls.push(`discard:${p}`),
    save: async (p, d) => void calls.push(`save:${p}->${d}`),
    copy: async (t) => void calls.push(`copy:${t}`),
    paste: async () => void calls.push("paste"),
  };
  const ai = {
    transcribe: vi.fn(async () => ({ text: "um so Thursday, sorry, Friday at 3", language: "en", audioSeconds: 6, elapsedMs: 2000, realTimeFactor: 0.33, threads: 8 })),
    cancelTranscription: vi.fn(async () => undefined),
  };
  return { bridge, ai, calls };
}

describe("VoiceController", () => {
  const opts = (over = {}) => ({ language: () => "auto" as const, spokenPunctuation: () => true, insertMode: () => "paste" as const, ...over });

  it("dictation: record, transcribe locally, clean, copy and insert - keeping the raw text", async () => {
    const f = fakeVoice();
    const states: VoiceState[] = [];
    const v = new VoiceController(f.bridge, f.ai, opts(), (s) => states.push(s));
    await v.start("dictation");
    expect(v.active()).toBe(true);
    await v.stop();
    const done = v.state();
    expect(done.phase).toBe("done");
    expect(done.raw).toBe("um so Thursday, sorry, Friday at 3");
    expect(done.clean).toBe("So Friday at 3.");
    expect(f.calls).toEqual(["start", "stop", "discard:rec-1.wav", "copy:So Friday at 3.", "paste"]);
    expect(states.map((s) => s.phase)).toEqual(expect.arrayContaining(["starting", "recording", "transcribing", "done"]));
  });

  it("copy-only mode never pastes; recorder keeps the recording until saved or reset", async () => {
    const f = fakeVoice();
    const v = new VoiceController(f.bridge, f.ai, opts({ insertMode: () => "copy" as const }), () => undefined);
    await v.start("dictation");
    await v.stop();
    expect(f.calls).not.toContain("paste");
    const g = fakeVoice();
    const r = new VoiceController(g.bridge, g.ai, opts(), () => undefined);
    await r.start("recorder");
    await r.stop();
    expect(r.state().recordingPath).toBe("rec-1.wav");
    expect(g.calls).not.toContain("copy:So Friday at 3.");
    await r.saveRecording("C:/x/take.wav");
    expect(g.calls).toContain("save:rec-1.wav->C:/x/take.wav");
    await r.start("recorder");
    await r.stop();
    await r.reset();
    expect(g.calls[g.calls.length - 1]).toBe("discard:rec-1.wav");
  });

  it("hands chat input to the chat, and reports a denied microphone", async () => {
    const f = fakeVoice();
    const said: string[] = [];
    const v = new VoiceController(f.bridge, f.ai, opts({ onChatText: (t: string) => said.push(t) }), () => undefined);
    await v.start("chat");
    await v.stop();
    expect(said).toEqual(["So Friday at 3."]);

    const d = fakeVoice({ denied: true });
    const dv = new VoiceController(d.bridge, d.ai, opts(), () => undefined);
    await dv.start("dictation");
    expect(dv.state()).toMatchObject({ phase: "error" });
    expect(dv.state().error).toMatch(/Privacy → Microphone/);
    expect(dv.active()).toBe(false);
  });

  it("cancel discards without transcribing", async () => {
    const f = fakeVoice();
    const v = new VoiceController(f.bridge, f.ai, opts(), () => undefined);
    await v.start("dictation");
    await v.cancel();
    expect(f.ai.transcribe).not.toHaveBeenCalled();
    expect(v.state().phase).toBe("idle");
  });
});

// ---- chat controller ------------------------------------------------------------------

/** A fake Local Chat plus fake encrypted storage that survives "sessions". */
function chatHarness(opts: { remember?: boolean; followUps?: boolean; gentle?: boolean; json?: string | (() => Promise<string>); fail?: boolean; store?: Store; now?: () => number } = {}) {
  const sent: { role: string; content: string }[][] = [];
  const replies: { maxTokens?: number; temperature?: number }[] = [];
  const moods: string[] = [];
  const personas: string[] = [];
  const store = opts.store ?? newStore();
  const settings = sanitizeCompanion({
    ...DEFAULT_COMPANION,
    chat: { rememberUseful: opts.remember ?? true, followUps: opts.followUps ?? true, gentleFollowUps: opts.gentle ?? false, style: "auto", showActiveMode: false, debugRouting: false },
  });
  const ai = {
    openChat: vi.fn(async () => undefined),
    closeChat: vi.fn(),
    reply: vi.fn(async (_id: string, messages: { role: string; content: string }[], onToken: (t: string) => void, maxTokens?: number, temperature?: number) => {
      sent.push(messages);
      replies.push({ maxTokens, temperature });
      if (opts.fail) throw new Error("Local Chat stopped unexpectedly (exit Some(1)).");
      onToken("Again? ");
      onToken("Changing everything twice in one week is a lot.");
      return { text: "Again? Changing everything twice in one week is a lot.", firstTokenMs: 500, totalMs: 1500, tokens: 8, tokensPerSecond: 13, promptTokens: 80, promptMs: 200, finishReason: "stop", cancelled: false };
    }),
    json: vi.fn(async () => (typeof opts.json === "function" ? opts.json() : (opts.json ?? '{"topic":"chat","second":"none","mood":"neutral","intensity":0,"current":false}'))),
    cancelReply: vi.fn(async () => undefined),
    warm: vi.fn(),
  };
  const states: ChatState[] = [];
  const c = new ChatController(
    ai,
    {
      settings: () => settings,
      userName: () => "Sandy",
      osLanguage: () => "en-IN",
      loadMemory: async () => store.memory,
      saveMemory: async (m) => void (store.memory = m),
      loadStyle: async () => store.style,
      saveStyle: async (p) => void (store.style = p),
      loadFollowUps: async () => store.followUps,
      saveFollowUps: async (l) => void (store.followUps = l),
      onMood: (m, p) => {
        moods.push(`${m.mood}:${m.intensity.toFixed(2)}`);
        if (p) personas.push(p.secondary ? `${p.primary}+${p.secondary}` : p.primary);
      },
      now: opts.now ?? (() => DAY1),
    },
    (s) => states.push(s),
  );
  return { c, ai, sent, replies, moods, personas, states, store, settings };
}

interface Store {
  memory: typeof EMPTY_MEMORY;
  style: StyleProfile;
  followUps: FollowUp[];
}
const newStore = (): Store => ({ memory: EMPTY_MEMORY, style: EMPTY_STYLE, followUps: [] });
const DAY1 = new Date(2026, 8, 11, 15, 0).getTime();
const DAY2 = new Date(2026, 8, 12, 15, 0).getTime();
const lastUser = (msgs: { role: string; content: string }[]) => msgs[msgs.length - 1].content;

describe("ChatController", () => {
  it("routes by rules, streams a reply, and hands the cat the mood and the persona", async () => {
    const h = chatHarness();
    await h.c.open();
    expect(h.c.state().status).toBe("ready");
    await h.c.send("My manager changed everything again.");
    expect(h.c.state().lines.map((l) => [l.role, l.text])).toEqual([
      ["user", "My manager changed everything again."],
      // Rant Buddy, frustrated: the reply ends with an emoji that takes their side.
      ["assistant", "Again? Changing everything twice in one week is a lot. 😤"],
    ]);
    expect(h.states.some((s) => s.lines.some((l) => l.pending && l.text === "Again?"))).toBe(true);
    // Confident rules: no model call spent on classification.
    expect(h.ai.json).not.toHaveBeenCalled();
    expect(h.moods).toEqual(["frustrated:0.34"]);
    expect(h.personas).toEqual(["rant_buddy+career_coach"]);
    expect(h.c.state().route).toMatchObject({ primary: "rant_buddy", source: "rules", usedModel: false, mode: "Listening" });
  });

  it("keeps the system prompt byte-identical across messages: the persona rides on the latest message", async () => {
    const h = chatHarness();
    await h.c.open();
    const warmed = (h.ai.warm.mock.calls[0] as unknown as [{ role: string; content: string }[]])[0];
    await h.c.send("My girlfriend broke up with me.");
    await h.c.send("What's a good beginner workout?");
    expect(h.sent[0][0]).toEqual(warmed[0]);
    expect(h.sent[1][0]).toEqual(warmed[0]);
    expect(lastUser(h.sent[0])).toMatch(/^My girlfriend broke up with me\.\n\n\(Note for MewMuze/);
    // The earlier message goes back into history WITHOUT its note, as the user wrote it.
    expect(h.sent[1].some((m) => m.content === "My girlfriend broke up with me.")).toBe(true);
    expect(h.states.every((s) => s.lines.every((l) => !l.text.includes("Note for MewMuze")))).toBe(true);
  });

  it("asks the model only when the rules are unsure - as a follow-up of the same conversation", async () => {
    const h = chatHarness({ json: '{"topic":"sad","second":"none","mood":"sad","intensity":2,"current":false}' });
    await h.c.open();
    await h.c.send("Something happened earlier today and I keep replaying it in my head");
    expect(h.ai.json).toHaveBeenCalledTimes(1);
    const asked = (h.ai.json.mock.calls[0] as unknown as [string, { role: string; content: string }[]])[1];
    expect(asked[asked.length - 1].content).toBe(CLASSIFY_NOTE);
    // Same system prompt and the same message first: the model's cache is reused.
    expect(asked[0]).toEqual(h.sent[0][0]);
    expect(asked[asked.length - 2].content).toBe("Something happened earlier today and I keep replaying it in my head");
    expect(h.c.state().route).toMatchObject({ primary: "comfort_companion", source: "model", usedModel: true });
    expect(h.moods).toEqual(["sad:0.67"]);
  });

  it("falls back to the rules' answer when the classifier's JSON is malformed or too slow", async () => {
    const bad = chatHarness({ json: '{"topic":"astrology","second":"none","mood":"sad","intensity":2,"current":false}' });
    await bad.c.open();
    await bad.c.send("Something happened earlier today and I keep replaying it in my head");
    expect(bad.c.state().route).toMatchObject({ primary: "mewmuze", source: "default" });

    vi.useFakeTimers();
    try {
      const slow = chatHarness({ json: () => new Promise<string>(() => undefined) });
      await slow.c.open();
      const sending = slow.c.send("Something happened earlier today and I keep replaying it in my head");
      await vi.advanceTimersByTimeAsync(6500);
      await sending;
      expect(slow.ai.cancelReply).toHaveBeenCalled();
      expect(slow.c.state().lines.slice(-1)[0]?.text).toMatch(/^Again\? Changing everything twice in one week is a lot\./);
    } finally {
      vi.useRealTimers();
    }
  });

  it("typed and spoken text are the same message: same persona, same prompt, same history", async () => {
    const typed = chatHarness();
    const spoken = chatHarness();
    await typed.c.open();
    await spoken.c.open();
    // Voice hands the chat its cleaned transcript through the very same send().
    await typed.c.send("I feel awful about my breakup.");
    const f = fakeVoice();
    f.ai.transcribe.mockResolvedValue({ text: "I feel awful about my breakup.", language: "en", audioSeconds: 3, elapsedMs: 900, realTimeFactor: 0.3, threads: 8 });
    const voice = new VoiceController(f.bridge, f.ai, { language: () => "auto", spokenPunctuation: () => false, insertMode: () => "copy", onChatText: (t) => void spoken.c.send(t) }, () => undefined);
    await voice.start("chat");
    await voice.stop();
    await vi.waitFor(() => expect(spoken.sent).toHaveLength(1));
    expect(spoken.personas).toEqual(typed.personas);
    expect(spoken.sent).toEqual(typed.sent);
    // Voice, typing, voice: one conversation, one persona state.
    await typed.c.send("I don't know what I did.");
    expect(typed.c.persona.snapshot().primary).toBe("breakup_buddy");
  });

  it("mirrors the user's language in the system prompt", async () => {
    const h = chatHarness();
    await h.c.open();
    await h.c.send("Yaar aaj bahut kaam tha, thak gaya hoon");
    expect(h.sent[0][0].content).toMatch(/Hinglish/);
    await h.c.send("आज बहुत थकान है");
    expect(h.sent[1][0].content).toMatch(/Devanagari/);
  });

  it("uses the persona's generation settings: careful for health, looser for banter", async () => {
    const h = chatHarness();
    await h.c.open();
    await h.c.send("I have a fever and a bad headache since morning.");
    await h.c.send("tell me a joke lol");
    expect(h.replies[0].temperature).toBeLessThanOrEqual(0.35);
    expect(h.replies[1].temperature).toBeGreaterThanOrEqual(0.8);
    expect(lastUser(h.sent[0])).toMatch(/never claim to be one, never diagnose/);
  });

  it("remembers only allowed preferences and style averages - and nothing when memory is off", async () => {
    const on = chatHarness();
    await on.c.open();
    await on.c.send("Call me Sandy and keep it short, I'm so sad today");
    expect(on.store.memory.items.map((i) => `${i.key}=${i.value}`)).toEqual(["name=Sandy", "length=short"]);
    expect(Object.keys(on.store.style).sort()).toEqual(["casual", "direct", "emoji", "en", "hi", "hinglish", "humour", "n", "questions", "words"]);
    expect(JSON.stringify(on.store.style)).not.toMatch(/sad|Sandy/);
    on.c.forgetConversation();
    expect(on.store.memory.items).toEqual([]);
    expect(on.c.state().lines).toEqual([]);

    const off = chatHarness({ remember: false });
    await off.c.open();
    await off.c.send("Call me Sandy");
    expect(off.store.memory.items).toEqual([]);
    expect(off.store.style.n).toBe(0);
  });

  it("adds a fixed safety line to a crisis or an emergency, whatever the model wrote", async () => {
    const h = chatHarness();
    await h.c.open();
    await h.c.send("I don't want to be alive anymore.");
    expect(h.c.state().lines.slice(-1)[0].text).toMatch(/^Again\? Changing everything twice in one week is a lot\. If you might act on these thoughts, please reach out right now to your local emergency number/);
    expect(h.c.state().route?.primary).toBe("grounding_listener");
    h.c.forgetConversation();
    await h.c.send("My chest pain is getting worse and my arm feels numb.");
    expect(h.c.state().lines.slice(-1)[0].text).toMatch(/call your local emergency number or get to a hospital now\.$/);
    h.c.forgetConversation();
    await h.c.send("Mujhe marna chahta hoon, jeena nahi chahta");
    expect(h.c.state().lines.slice(-1)[0].text).toMatch(/local emergency number ya kisi bharose wale insaan se baat karo\.$/);
  });

  it("survives a model crash", async () => {
    const crash = chatHarness({ fail: true });
    await crash.c.open();
    await crash.c.send("hello?");
    expect(crash.c.state().status).toBe("error");
    expect(crash.c.state().error).toMatch(/stopped unexpectedly/);
    expect(crash.c.state().lines.filter((l) => l.role === "assistant")).toEqual([]);
  });
});

describe("Gentle follow-ups (Phase 2O)", () => {
  it("I'm sick today -> tomorrow: 'Feeling any better today?' -> answered and resolved", async () => {
    const store = newStore();
    let now = DAY1;
    const day1 = chatHarness({ gentle: true, store, now: () => now });
    await day1.c.open();
    await day1.c.send("I'm sick today.");
    expect(store.followUps).toHaveLength(1);
    expect(store.followUps[0]).toMatchObject({ kind: "unwell", status: "pending" });
    // Only a kind and dates - no words from the conversation.
    expect(JSON.stringify(store.followUps)).not.toMatch(/sick today/);

    now = DAY2;
    const day2 = chatHarness({ gentle: true, store, now: () => now });
    await day2.c.open();
    expect(day2.c.state().lines[0]).toMatchObject({ role: "assistant", text: "You weren't feeling great yesterday. Feeling any better today, Sandy?" });
    await day2.c.send("Much better, thanks!");
    expect(store.followUps).toEqual([]);
    expect(lastUser(day2.sent[0])).toMatch(/answering your check-in/);
  });

  it("with Gentle follow-ups off, asks first - and only a yes creates one", async () => {
    const h = chatHarness({ gentle: false });
    await h.c.open();
    await h.c.send("I have my interview tomorrow and I'm nervous.");
    expect(h.store.followUps).toEqual([]);
    expect(h.c.state().lines.slice(-1)[0]?.text).toMatch(/Want me to check in on you tomorrow\?$/);
    await h.c.send("yes please");
    expect(h.store.followUps.map((f) => f.kind)).toEqual(["interview"]);
    // "Tomorrow" is the interview: the check-in waits for the day after.
    expect(h.store.followUps[0].dueAt).toBe(new Date(2026, 8, 13).getTime());

    const no = chatHarness({ gentle: false });
    await no.c.open();
    await no.c.send("I had such a rough day.");
    await no.c.send("no thanks");
    expect(no.store.followUps).toEqual([]);
  });

  it("memory off: no follow-ups at all, not even an offer", async () => {
    const h = chatHarness({ remember: false, gentle: true });
    await h.c.open();
    await h.c.send("I'm sick today.");
    expect(h.store.followUps).toEqual([]);
    expect(h.c.state().lines.slice(-1)[0]?.text).not.toMatch(/check in/);
  });

  it("expires, can be deleted, and Clear companion memory removes everything", async () => {
    const store = newStore();
    const make = (now: number) => chatHarness({ gentle: true, store, now: () => now });
    const day1 = make(DAY1);
    await day1.c.open();
    await day1.c.send("I'm sick today.");
    // Four days later it has expired: nothing is asked.
    const late = make(DAY1 + 4 * 86_400_000);
    await late.c.open();
    expect(late.c.state().lines).toEqual([]);

    const again = make(DAY1);
    await again.c.open();
    await again.c.send("I'm sick today.");
    const id = store.followUps[0].id;
    await again.c.forgetFollowUp(id);
    expect(store.followUps).toEqual([]);

    await again.c.send("Call me Sandy. I have a presentation tomorrow.");
    expect(store.followUps).toHaveLength(1);
    await again.c.clearAll();
    expect(store).toEqual(newStore());
  });
});

describe("profile: voice and chat settings", () => {
  it("sanitises the shortcut, insert mode and memory switch", () => {
    const c = sanitizeCompanion({ voice: { shortcut: "Ctrl+Alt+Delete", insertMode: "yell", language: "fr" }, chat: { rememberUseful: false } });
    expect(c.voice).toEqual({ shortcut: "Ctrl+Alt+Space", insertMode: "paste", language: "auto", spokenPunctuation: true });
    expect(c.chat.rememberUseful).toBe(false);
    expect(sanitizeCompanion({ voice: { shortcut: "Ctrl+Shift+D" } }).voice.shortcut).toBe("Ctrl+Shift+D");
  });
});
