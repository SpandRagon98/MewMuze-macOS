//! Which brain answers: MewMuze Local (the default), or the user's own OpenAI
//! or Claude key. Everything above this file - the Persona Router, the Context
//! Builder, memory, follow-ups, the cat's reactions, Voice, the Diary - is the
//! same whichever it is. A provider only turns the assembled messages into a
//! reply, so a new one is one more entry in ADAPTERS.
//!
//! The key never enters this file: Rust holds it in the OS credential vault
//! and adds it to the request itself (src-tauri/src/chat_providers.rs).

import type { ChatAI } from "./chatController";
import type { GenStats, Msg } from "./localAI";

export type ProviderId = "local" | "openai" | "anthropic";
export type ExternalId = Exclude<ProviderId, "local">;

interface ModelChoice {
  id: string;
  label: string;
}

export interface ProviderInfo {
  name: string;
  /** Settings' one-line description. */
  blurb: string;
  /** What happens to messages - shown in Settings and under the chat. */
  privacy: string;
  models: readonly ModelChoice[];
  keyHint: string;
  keyUrl: string;
}

// Verified against the providers' own model lists and pricing pages, September
// 2026. Each list starts with the default: the cheapest that still chats well.
// Any other id can be typed in Settings, so a retired model is a setting, not a release.
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  local: {
    name: "MewMuze Local",
    blurb: "Private and works offline. Recommended for everyday chats.",
    privacy: "Runs on your computer.",
    models: [],
    keyHint: "",
    keyUrl: "",
  },
  openai: {
    name: "OpenAI",
    blurb: "Use your own OpenAI API key. Internet required.",
    privacy: "Messages are sent to OpenAI to generate replies.",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna — economical (recommended)" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra — stronger, costs more" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol — strongest, costs most" },
    ],
    keyHint: "Starts with sk-",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "Claude",
    blurb: "Use your own Anthropic API key. Internet required.",
    privacy: "Messages are sent to Anthropic (Claude) to generate replies.",
    models: [
      // Haiku 4.5 is cheaper per token but may retire from 15 October 2026.
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 — economical (recommended)" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest, retiring soon" },
      { id: "claude-opus-5", label: "Claude Opus 5 — strongest, costs more" },
    ],
    keyHint: "Starts with sk-ant-",
    keyUrl: "https://platform.claude.com/",
  },
};

export const DEFAULT_MODEL: Record<ExternalId, string> = { openai: PROVIDERS.openai.models[0].id, anthropic: PROVIDERS.anthropic.models[0].id };

// ---- the Rust door ------------------------------------------------------------------

export interface ProviderBridge {
  request(provider: ExternalId, path: string, body?: string): Promise<{ status: number; body: string }>;
  keySet(provider: ExternalId, key: string): Promise<void>;
  keyStatus(provider: ExternalId): Promise<boolean>;
  keyRemove(provider: ExternalId): Promise<void>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = async (cmd, args) => (await import("@tauri-apps/api/core")).invoke(cmd, args);

export const tauriProviders: ProviderBridge = {
  request: (providerId, path, body) => invoke("provider_request", { providerId, path, body: body ?? null }),
  keySet: (providerId, key) => invoke("provider_key_set", { providerId, key }),
  keyStatus: (providerId) => invoke("provider_key_status", { providerId }),
  keyRemove: (providerId) => invoke("provider_key_remove", { providerId }),
};

// ---- failures, in plain words ---------------------------------------------------------

export type FailureKind = "no-key" | "bad-key" | "credit" | "rate" | "outage" | "offline" | "model" | "refused" | "bad-response";

/** A provider failure: `message` for everyone, `technical` behind "Technical details". */
export class ProviderError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly technical = "",
  ) {
    super(message);
  }
}

/** Turn a status + error body (or a transport failure) into one of a few plain messages. */
export function providerFailure(provider: ExternalId, status: number, body: string): ProviderError {
  const who = PROVIDERS[provider].name;
  let code = "";
  let detail = "";
  try {
    const e = (JSON.parse(body) as { error?: { type?: string; code?: string; message?: string } }).error;
    code = `${e?.code ?? ""} ${e?.type ?? ""}`.trim();
    detail = e?.message ?? "";
  } catch {
    detail = body.slice(0, 200);
  }
  const technical = `HTTP ${status}${code ? ` · ${code}` : ""}${detail ? ` · ${detail.slice(0, 300)}` : ""}`;
  const say = (kind: FailureKind, msg: string) => new ProviderError(kind, msg, technical);
  const text = `${code} ${detail}`.toLowerCase();
  if (status === 401) return say("bad-key", `${who} didn't accept your API key. It may be mistyped, expired or revoked — change it in Settings → Chat.`);
  if (status === 402 || /insufficient_quota|billing|credit balance|quota/.test(text)) return say("credit", `Your ${who} account is out of credit or over its limit. Top it up on their site, or use MewMuze Local.`);
  if (status === 429) return say("rate", `${who} is rate-limiting your key right now. Wait a moment and try again.`);
  if (status === 404 || /model_not_found|not_found_error|does not exist|deprecated/.test(text)) {
    return say("model", `${who} doesn't offer that model to your key (it may have been retired). Pick another model in Settings → Chat.`);
  }
  if (status === 403) return say("refused", `${who} refused this request for your key. Check the key's permissions on their site.`);
  if (status >= 500) return say("outage", `${who} is having trouble right now. Try again in a little while.`);
  if (status === 400) return say("refused", `${who} rejected the request. If it keeps happening, try another model in Settings → Chat.`);
  return say("bad-response", `${who} sent an answer MewMuze couldn't read.`);
}

function transportFailure(provider: ExternalId, e: unknown): ProviderError {
  const raw = e instanceof Error ? e.message : String(e);
  const who = PROVIDERS[provider].name;
  if (raw === "no-key") return new ProviderError("no-key", `Add your ${who} API key in Settings → Chat to chat with ${who}.`);
  return new ProviderError("offline", `${who} isn't reachable right now.`, raw);
}

// ---- adapters -------------------------------------------------------------------------

interface Adapter {
  path: string;
  body(model: string, messages: Msg[], maxTokens: number, temperature: number): unknown;
  /** The reply text, or null if the answer is unreadable. */
  text(json: unknown): string | null;
  usage(json: unknown): { input: number; output: number };
}

const systemOf = (messages: Msg[]) => messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
const turnsOf = (messages: Msg[]) => messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export const ADAPTERS: Record<ExternalId, Adapter> = {
  // The Responses API (OpenAI's current one). `store: false`: nothing is kept
  // on OpenAI's side for later retrieval. GPT-5.6 models can skip reasoning
  // ("none"), which is right for chat: every reasoning token is billed.
  openai: {
    path: "/v1/responses",
    body: (model, messages, maxTokens) => {
      const noReasoning = /^gpt-5\.6/.test(model);
      return {
        model,
        instructions: systemOf(messages),
        input: turnsOf(messages),
        max_output_tokens: maxTokens + (noReasoning ? 0 : 1024),
        reasoning: { effort: noReasoning ? "none" : "low" },
        store: false,
      };
    },
    text: (json) => {
      const out = rec(json).output;
      if (!Array.isArray(out)) return null;
      const parts: string[] = [];
      for (const item of out) for (const c of (rec(item).content as unknown[]) ?? []) if (rec(c).type === "output_text") parts.push(String(rec(c).text ?? ""));
      return parts.length ? parts.join("") : null;
    },
    usage: (json) => ({ input: Number(rec(rec(json).usage).input_tokens) || 0, output: Number(rec(rec(json).usage).output_tokens) || 0 }),
  },
  // The Messages API. Thinking is off: a chat line needs no hidden reasoning,
  // and it would be billed and eat the small reply budget (Claude Fable
  // models always think, so the switch is left out for them). Sampling
  // settings are only sent where the model still takes them.
  anthropic: {
    path: "/v1/messages",
    body: (model, messages, maxTokens, temperature) => ({
      model,
      max_tokens: maxTokens,
      system: systemOf(messages),
      messages: turnsOf(messages),
      ...(/fable|mythos/.test(model) ? {} : { thinking: { type: "disabled" } }),
      ...(/haiku/.test(model) ? { temperature } : {}),
    }),
    text: (json) => {
      const content = rec(json).content;
      if (!Array.isArray(content)) return null;
      const parts = content.filter((b) => rec(b).type === "text").map((b) => String(rec(b).text ?? ""));
      return parts.length ? parts.join("") : null;
    },
    usage: (json) => ({ input: Number(rec(rec(json).usage).input_tokens) || 0, output: Number(rec(rec(json).usage).output_tokens) || 0 }),
  },
};

/**
 * Paid tokens: only recent context goes out. The system prompt, then the
 * newest turns within a budget - the Context Builder's hidden note rides on the
 * last user message, so it always survives. (Local keeps its larger window.)
 */
export function compactForProvider(messages: Msg[], maxTurns = 10, maxChars = 4000): Msg[] {
  const system = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");
  const kept: Msg[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < maxTurns; i--) {
    if (kept.length > 0 && used + turns[i].content.length > maxChars) break;
    used += turns[i].content.length;
    kept.unshift(turns[i]);
  }
  while (kept.length > 1 && kept[0].role === "assistant") kept.shift();
  return [...system, ...kept];
}

/**
 * A ChatAI backed by the user's own key. No classifier (the rules route alone),
 * no warm-up, no model to load: nothing is sent until the user sends something.
 */
export function externalAI(provider: ExternalId, model: () => string, bridge: ProviderBridge = tauriProviders, now: () => number = Date.now): ChatAI {
  const cancelled = new Set<string>();
  const a = ADAPTERS[provider];
  return {
    openChat: async () => {
      if (!(await bridge.keyStatus(provider).catch(() => false))) throw transportFailure(provider, new Error("no-key"));
    },
    closeChat: () => undefined,
    warm: () => undefined,
    json: async () => {
      throw new Error("Classification runs on the rules for external providers.");
    },
    cancelReply: async (id) => void cancelled.add(id),
    async reply(requestId, messages, onToken, maxTokens = 240, temperature = 0.7): Promise<GenStats> {
      const t0 = now();
      let res: { status: number; body: string };
      try {
        res = await bridge.request(provider, a.path, JSON.stringify(a.body(model(), messages, maxTokens, temperature)));
      } catch (e) {
        throw transportFailure(provider, e);
      }
      // A reply the user stopped is dropped, not shown - the request itself
      // cannot be recalled once it left.
      if (cancelled.delete(requestId)) return { text: "", firstTokenMs: 0, totalMs: now() - t0, tokens: 0, tokensPerSecond: 0, promptTokens: 0, promptMs: 0, finishReason: "cancelled", cancelled: true };
      if (res.status < 200 || res.status >= 300) throw providerFailure(provider, res.status, res.body);
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new ProviderError("bad-response", `${PROVIDERS[provider].name} sent an answer MewMuze couldn't read.`, res.body.slice(0, 200));
      }
      const text = a.text(json);
      if (text === null) throw new ProviderError("bad-response", `${PROVIDERS[provider].name} sent an answer MewMuze couldn't read.`, res.body.slice(0, 200));
      onToken(text);
      const u = a.usage(json);
      const ms = now() - t0;
      return { text, firstTokenMs: ms, totalMs: ms, tokens: u.output, tokensPerSecond: ms ? (u.output * 1000) / ms : 0, promptTokens: u.input, promptMs: 0, finishReason: "stop", cancelled: false };
    },
  };
}

/** Settings' "Test connection": lists models, which costs no tokens. */
export async function testConnection(provider: ExternalId, bridge: ProviderBridge = tauriProviders): Promise<{ ok: true } | { ok: false; message: string; technical: string }> {
  try {
    const res = await bridge.request(provider, "/v1/models");
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const f = providerFailure(provider, res.status, res.body);
    return { ok: false, message: f.message, technical: f.technical };
  } catch (e) {
    const f = transportFailure(provider, e);
    return { ok: false, message: f.message, technical: f.technical };
  }
}
