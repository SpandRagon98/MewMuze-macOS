import { describe, expect, it, vi } from "vitest";
// @ts-expect-error no @types/node in the app tsconfig; other guards read sources this way too.
import { readFileSync } from "node:fs";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));

import { ChatController, type ChatAI, type ChatState } from "../companion/chatController";
import { EMPTY_MEMORY } from "../companion/memory";
import { DEFAULT_COMPANION, sanitizeCompanion } from "../companion/profile";
import {
  ADAPTERS, DEFAULT_MODEL, PROVIDERS, ProviderError, compactForProvider, externalAI, providerFailure, tauriProviders, testConnection, type ProviderBridge,
} from "../companion/providers";

const KEY = "sk-proj-THIS-IS-A-SECRET-TEST-KEY-000";
const msgs = [
  { role: "system", content: "You are MewMuze." },
  { role: "user", content: "hi" },
  { role: "assistant", content: "Hey!" },
  { role: "user", content: "My boss took credit for my idea." },
];

/** A fake Rust door: records what would be sent; never sees a key. */
function bridge(respond: (path: string, body: unknown) => { status: number; body: string } | Error): ProviderBridge & { calls: { provider: string; path: string; body: unknown }[] } {
  const calls: { provider: string; path: string; body: unknown }[] = [];
  return {
    calls,
    request: async (provider, path, body) => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ provider, path, body: parsed });
      const r = respond(path, parsed);
      if (r instanceof Error) throw r;
      return r;
    },
    keySet: async () => undefined,
    keyStatus: async () => true,
    keyRemove: async () => undefined,
  };
}
const okOpenAI = (text: string) => ({ status: 200, body: JSON.stringify({ output: [{ type: "reasoning", content: [] }, { type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 90, output_tokens: 12 } }) });
const okClaude = (text: string) => ({ status: 200, body: JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 90, output_tokens: 12 } }) });

describe("provider adapters", () => {
  it("OpenAI: the Responses API, no stored conversation, no reasoning tokens on GPT-5.6", () => {
    const body = ADAPTERS.openai.body("gpt-5.6-luna", msgs, 240, 0.7) as Record<string, unknown>;
    expect(ADAPTERS.openai.path).toBe("/v1/responses");
    expect(body).toMatchObject({ model: "gpt-5.6-luna", instructions: "You are MewMuze.", max_output_tokens: 240, reasoning: { effort: "none" }, store: false });
    expect(body.input).toEqual(msgs.slice(1));
    // An older reasoning model gets a small reasoning allowance on top of the reply budget.
    expect(ADAPTERS.openai.body("gpt-5.4-mini", msgs, 240, 0.7)).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 1264 });
    expect(ADAPTERS.openai.text(JSON.parse(okOpenAI("Bold move by your boss.").body))).toBe("Bold move by your boss.");
    expect(ADAPTERS.openai.text({ nope: true })).toBeNull();
  });

  it("Claude: the Messages API with thinking off, sampling only where the model takes it", () => {
    const body = ADAPTERS.anthropic.body("claude-sonnet-5", msgs, 240, 0.7) as Record<string, unknown>;
    expect(ADAPTERS.anthropic.path).toBe("/v1/messages");
    expect(body).toMatchObject({ model: "claude-sonnet-5", max_tokens: 240, system: "You are MewMuze.", thinking: { type: "disabled" } });
    expect(body.messages).toEqual(msgs.slice(1));
    expect(body).not.toHaveProperty("temperature");
    expect(ADAPTERS.anthropic.body("claude-haiku-4-5", msgs, 240, 0.7)).toMatchObject({ temperature: 0.7 });
    expect(ADAPTERS.anthropic.body("claude-fable-5-1", msgs, 240, 0.7)).not.toHaveProperty("thinking");
    expect(ADAPTERS.anthropic.text(JSON.parse(okClaude("On your side, always.").body))).toBe("On your side, always.");
  });

  it("defaults to the economical current models, and every listed model is a real id", () => {
    expect(DEFAULT_MODEL).toEqual({ openai: "gpt-5.6-luna", anthropic: "claude-sonnet-5" });
    expect(DEFAULT_COMPANION.chat).toMatchObject({ provider: "local", openaiModel: DEFAULT_MODEL.openai, anthropicModel: DEFAULT_MODEL.anthropic });
    for (const p of [PROVIDERS.openai, PROVIDERS.anthropic]) for (const m of p.models) expect(m.id).toMatch(/^[a-z0-9][a-z0-9.-]+$/);
  });

  it("sends only recent context to a paid provider, and the hidden note always survives", () => {
    const long = [{ role: "system", content: "S" }, ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"x".repeat(300)}` })), { role: "user", content: "now (Note for MewMuze ...)" }];
    const out = compactForProvider(long);
    expect(out[0]).toEqual({ role: "system", content: "S" });
    expect(out[out.length - 1].content).toContain("Note for MewMuze");
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out[1].role).toBe("user");
  });
});

describe("provider failures, in plain words", () => {
  const cases: [number, string, string][] = [
    [401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}', "bad-key"],
    [429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', "rate"],
    [402, '{"error":{"type":"billing_error","message":"payment"}}', "credit"],
    [429, '{"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"You exceeded your current quota"}}', "credit"],
    [400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', "credit"],
    [404, '{"error":{"type":"not_found_error","message":"model: claude-old"}}', "model"],
    [400, '{"error":{"code":"model_not_found","message":"The model `gpt-4` does not exist"}}', "model"],
    [529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}', "outage"],
    [500, "<html>oops</html>", "outage"],
    [403, '{"error":{"type":"permission_error","message":"no"}}', "refused"],
  ];
  it.each(cases)("HTTP %i is explained without raw JSON (%s)", (status, body, kind) => {
    const f = providerFailure("anthropic", status, body);
    expect(f.kind).toBe(kind);
    expect(f.message).not.toMatch(/[{}]|error_type|_error/);
    expect(f.technical).toContain(`HTTP ${status}`);
  });

  it("offline, timeout, no key and an unreadable answer never crash the chat", async () => {
    const offline = externalAI("anthropic", () => "claude-sonnet-5", bridge(() => new Error("network: Dns")));
    await expect(offline.reply("r1", msgs, () => undefined)).rejects.toMatchObject({ kind: "offline", message: "Claude isn't reachable right now." });
    const nokey = externalAI("openai", () => "gpt-5.6-luna", bridge(() => new Error("no-key")));
    await expect(nokey.reply("r2", msgs, () => undefined)).rejects.toMatchObject({ kind: "no-key" });
    const garbled = externalAI("openai", () => "gpt-5.6-luna", bridge(() => ({ status: 200, body: "not json" })));
    await expect(garbled.reply("r3", msgs, () => undefined)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("Test connection lists models - it costs no tokens", async () => {
    const b = bridge((path) => (path === "/v1/models" ? { status: 200, body: "{}" } : new Error("wrong path")));
    expect(await testConnection("openai", b)).toEqual({ ok: true });
    expect(b.calls).toEqual([{ provider: "openai", path: "/v1/models", body: undefined }]);
    const bad = await testConnection("anthropic", bridge(() => ({ status: 401, body: '{"error":{"type":"authentication_error"}}' })));
    expect(bad).toMatchObject({ ok: false });
  });
});

describe("API keys", () => {
  it("go to the OS vault through Rust - never settings, never the request body", async () => {
    invoke.mockClear();
    await tauriProviders.keySet("openai", KEY);
    await tauriProviders.keyStatus("anthropic");
    await tauriProviders.keyRemove("openai");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["provider_key_set", "provider_key_status", "provider_key_remove"]);
    // Settings cannot carry a key even if one is smuggled into the file.
    const s = sanitizeCompanion({ ...DEFAULT_COMPANION, chat: { ...DEFAULT_COMPANION.chat, openaiKey: KEY, apiKey: KEY } as never });
    expect(JSON.stringify(s)).not.toContain("SECRET");
    // The request the frontend builds has no key in it: Rust adds the header.
    const b = bridge(() => okOpenAI("ok"));
    await externalAI("openai", () => "gpt-5.6-luna", b).reply("r", msgs, () => undefined);
    expect(JSON.stringify(b.calls)).not.toMatch(/sk-|Authorization|x-api-key/i);
  });

  it("Rust owns the hosts, the paths and the vault", () => {
    const rs: string = readFileSync("src-tauri/src/chat_providers.rs", "utf8");
    expect(rs).toContain('"https://api.openai.com"');
    expect(rs).toContain('"https://api.anthropic.com"');
    expect(rs).toContain("keyring::");
    expect(rs).toContain(".redirects(0)");
    expect(rs).not.toMatch(/println!|eprintln!|log::/);
  });
});

// ---- the chat itself, with each brain ---------------------------------------------------

function harness(opts: { provider?: () => "local" | "openai" | "anthropic"; external?: ChatAI; localAvailable?: boolean } = {}) {
  const local = {
    openChat: vi.fn(async () => undefined),
    closeChat: vi.fn(),
    warm: vi.fn(),
    json: vi.fn(async () => '{"topic":"chat","second":"none","mood":"neutral","intensity":0}'),
    cancelReply: vi.fn(async () => undefined),
    reply: vi.fn(async (_id: string, _m: { role: string; content: string }[], onToken: (t: string) => void) => {
      onToken("Local here.");
      return { text: "Local here.", firstTokenMs: 1, totalMs: 1, tokens: 2, tokensPerSecond: 1, promptTokens: 1, promptMs: 1, finishReason: "stop", cancelled: false };
    }),
  };
  const sessions: unknown[] = [];
  const states: ChatState[] = [];
  const settings = { ...DEFAULT_COMPANION, chat: { ...DEFAULT_COMPANION.chat, rememberUseful: false } };
  const c = new ChatController(
    local,
    {
      settings: () => settings,
      userName: () => "Sandy",
      osLanguage: () => "en-US",
      loadMemory: async () => EMPTY_MEMORY,
      saveMemory: async () => undefined,
      onMood: () => undefined,
      now: () => Date.UTC(2026, 8, 14, 15),
      provider: () => {
        const p = opts.provider?.() ?? "local";
        return p === "local" ? { id: "local", ai: local } : { id: p, ai: opts.external! };
      },
      localAvailable: () => opts.localAvailable ?? true,
      saveDiary: (s) => sessions.push(s),
    },
    (s) => states.push(s),
  );
  return { c, local, sessions, states };
}

describe("ChatController with each provider", () => {
  it("routes the same persona whichever brain answers, and asks no paid classifier", async () => {
    const b = bridge(() => okClaude("Taking credit for your idea? The audacity. I'm on your side."));
    const ext = externalAI("anthropic", () => "claude-sonnet-5", b);
    const onClaude = harness({ provider: () => "anthropic", external: ext });
    const onLocal = harness();
    await onClaude.c.open();
    await onLocal.c.open();
    await onClaude.c.send("My coworker took credit for my idea in the meeting today.");
    await onLocal.c.send("My coworker took credit for my idea in the meeting today.");
    expect(onClaude.c.state().persona).toEqual(onLocal.c.state().persona);
    expect(onClaude.c.state().persona?.primary).toBe("savage_bestie");
    // One request, no classifier call, the persona brief in the hidden note, and no false "on this computer" claim.
    expect(b.calls).toHaveLength(1);
    const sent = b.calls[0].body as { system: string; messages: { content: string }[] };
    expect(sent.system).not.toContain("entirely on this computer");
    expect(sent.system).not.toContain("/no_think");
    expect(sent.messages[sent.messages.length - 1].content).toContain("Note for MewMuze");
    expect(onClaude.local.reply).not.toHaveBeenCalled();
    expect(onClaude.c.state().lines[onClaude.c.state().lines.length - 1]?.text).toMatch(/^Taking credit for your idea\? The audacity/);
    expect(onClaude.c.state().provider).toBe("anthropic");
  });

  it("a spoken message takes the same path to the selected provider (voice never forces Local)", async () => {
    const app: string = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("onChatText: (text) => void chat.send(text)");
    const b = bridge(() => okOpenAI("Heard you."));
    const h = harness({ provider: () => "openai", external: externalAI("openai", () => "gpt-5.6-luna", b) });
    await h.c.open();
    await h.c.send("this came from the microphone");
    expect(b.calls).toHaveLength(1);
    expect(h.local.reply).not.toHaveBeenCalled();
  });

  it("never sends a local conversation to an external provider because the setting changed", async () => {
    let provider: "local" | "openai" = "local";
    const b = bridge(() => okOpenAI("Fresh start."));
    const h = harness({ provider: () => provider, external: externalAI("openai", () => "gpt-5.6-luna", b) });
    await h.c.open();
    await h.c.send("Something private about my family.");
    provider = "openai";
    await h.c.send("And another thing.");
    expect(b.calls).toHaveLength(0);
    expect(h.c.state().switchTo).toBe("openai");
    // Starting over with the new provider: the old conversation goes to the Diary, nothing old is sent.
    h.c.newChat();
    await vi.waitFor(() => expect(h.c.state().status).toBe("ready"));
    await h.c.send("Hi OpenAI.");
    expect(b.calls).toHaveLength(1);
    expect(JSON.stringify(b.calls[0].body)).not.toContain("private about my family");
    expect(h.sessions.length).toBeGreaterThan(0);
  });

  it("moving back to Local is always allowed", async () => {
    let provider: "local" | "openai" = "openai";
    const h = harness({ provider: () => provider, external: externalAI("openai", () => "gpt-5.6-luna", bridge(() => okOpenAI("ok"))) });
    await h.c.open();
    await h.c.send("First message to OpenAI.");
    provider = "local";
    await h.c.send("Now locally.");
    expect(h.c.state().switchTo).toBeNull();
    expect(h.local.reply).toHaveBeenCalledTimes(1);
  });

  it("offline: says so, keeps the message, offers Local, and does not switch by itself", async () => {
    let provider: "local" | "anthropic" = "anthropic";
    const h = harness({ provider: () => provider, external: externalAI("anthropic", () => "claude-sonnet-5", bridge(() => new Error("network: Io"))), localAvailable: true });
    await h.c.open();
    await h.c.send("Are you there?");
    const st = h.c.state();
    expect(st.status).toBe("error");
    expect(st.error).toBe("Claude isn't reachable right now.");
    expect(st.errorDetail).toContain("network");
    expect(st.offerLocal).toBe(true);
    expect(h.local.reply).not.toHaveBeenCalled();
    expect(st.lines.map((l) => l.text)).toEqual(["Are you there?"]);
    // The user's click: use Local, and the unanswered message is sent there.
    provider = "local";
    await h.c.retry();
    expect(h.local.reply).toHaveBeenCalledTimes(1);
    expect(h.c.state().lines.map((l) => l.role)).toEqual(["user", "assistant"]);
  });

  it("does not offer Local when it isn't installed", async () => {
    const h = harness({ provider: () => "openai", external: externalAI("openai", () => "gpt-5.6-luna", bridge(() => ({ status: 401, body: "{}" }))), localAvailable: false });
    await h.c.open();
    await h.c.send("hello there friend");
    expect(h.c.state().offerLocal).toBe(false);
    expect(h.c.state().error).toContain("didn't accept your API key");
  });

  it("an external failure is a ProviderError the UI can explain", () => {
    expect(providerFailure("openai", 429, "{}")).toBeInstanceOf(ProviderError);
  });
});
