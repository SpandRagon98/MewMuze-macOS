//! A chat with the cat: the conversation, streaming, language mirroring, the
//! Persona Router, memory of safe preferences, gentle follow-ups, and the
//! cat's reaction.
//!
//! Typed and spoken messages enter through the same send(): by the time text
//! reaches here nobody knows - or cares - how it was produced.
//!
//! The conversation itself lives in memory only, for this session. What
//! persists (only with "Remember useful things" on, encrypted) is the short
//! preference list, the learned style averages and pending check-ins.

import { buildMessages, careLine, guardReply, replyEmoji, safetyLine, systemPrompt, tidyReply, type ChatTurn } from "./chatPrompt";
import { buildTurn, rewriteMessages } from "./contextBuilder";
import type { DiarySession } from "./diary";
import { detectLanguage, replyLanguage } from "./language";
import type { GenStats, Msg, ReplyOptions } from "./localAI";
import { EMPTY_MEMORY, extractPreferences, forgetConversation, remember, view, type ChatMemory } from "./memory";
import { NEUTRAL, type Mood } from "./mood";
import { factsNote } from "./persona/currentInfo";
import { glossaryNote } from "./persona/glossary";
import {
  addFollowUp, answerToOffer, askLine, detectFollowUp, due, forgetConversationFollowUps, makeFollowUp, markAsked, offerLine, prune, resolve,
  type FollowUp, type FollowUpKind,
} from "./persona/followUps";
import { persona, type ModeLabel } from "./persona/personas";
import { SAVAGE_VOICE, shapeOf } from "./persona/promptLibrary";
import {
  CLASSIFY_NOTE, CLASSIFY_SCHEMA, PersonaState, decide, fromModel, shouldAskModel, signals, type CurrentKind, type PersonaSnapshot, type Routing,
} from "./persona/router";
import { EMPTY_STYLE, learn, traits, type StyleProfile } from "./persona/style";
import { resolveLang, type Lang } from "./phrases";
import type { CompanionSettings } from "./profile";
import { ProviderError, compactForProvider, type ProviderId } from "./providers";
import { review } from "./replyCheck";

export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}

export type ChatStatus = "closed" | "waking" | "ready" | "thinking" | "error";

/** Technical facts about the last message's routing - never content. */
export interface RouteInfo {
  primary: string;
  secondary: string | null;
  mode: ModeLabel;
  source: Routing["source"];
  confidence: number;
  mood: Mood["mood"];
  language: Lang;
  /** Wall time spent deciding the persona, model call included. */
  routeMs: number;
  /** Did the router ask the model? (Confident rules never do.) */
  usedModel: boolean;
  needsCurrentInformation: boolean;
  hadFacts: boolean;
  temperature: number;
  maxTokens: number;
  /** The one constrained rewrite was used. */
  rewritten: boolean;
  /** What the reply check repaired ("stock opener", "more than one question"). */
  fixes: string[];
}

export interface ChatState {
  status: ChatStatus;
  lines: ChatLine[];
  error: string | null;
  lang: Lang;
  lastStats: GenStats | null;
  route: RouteInfo | null;
  /** Who is answering, set as soon as it is decided - before the reply streams. */
  persona: { primary: string; secondary: string | null } | null;
  /** The brain the chat is using. */
  provider: ProviderId;
  /**
   * The setting now names an external provider this conversation did not
   * start with: nothing is sent until the user starts a new chat with it, so a
   * private local conversation never leaves because a setting changed.
   */
  switchTo: ProviderId | null;
  /** Behind "Technical details" (status code, provider error code) - never the key. */
  errorDetail: string | null;
  /** An external provider failed and Local Chat is installed: offer it (never switch silently). */
  offerLocal: boolean;
}

export const INITIAL_CHAT: ChatState = {
  status: "closed", lines: [], error: null, lang: "en", lastStats: null, route: null, persona: null, provider: "local", switchTo: null, errorDetail: null, offerLocal: false,
};

export interface ChatAI {
  openChat(): Promise<void>;
  closeChat(): void;
  reply(requestId: string, messages: Msg[], onToken: (t: string) => void, maxTokens?: number, temperature?: number, opts?: ReplyOptions): Promise<GenStats>;
  warm(messages: Msg[]): void;
  /** Structured JSON under a grammar: the router's classifier. */
  json(requestId: string, messages: Msg[], schema: unknown): Promise<string>;
  cancelReply(requestId: string): Promise<void>;
}

export interface ChatDeps {
  settings(): CompanionSettings;
  userName(): string;
  osLanguage(): string;
  loadMemory(): Promise<ChatMemory>;
  saveMemory(m: ChatMemory): Promise<void>;
  loadStyle?(): Promise<StyleProfile>;
  saveStyle?(p: StyleProfile): Promise<void>;
  loadFollowUps?(): Promise<FollowUp[]>;
  saveFollowUps?(list: FollowUp[]): Promise<void>;
  /** The mood, and who is answering: drives the physical cat. */
  onMood(m: Mood, p?: PersonaSnapshot): void;
  /** Live facts for a question that needs them (weather, time, rates, news). */
  currentInfo?(kind: CurrentKind, text: string): Promise<string | null>;
  now(): number;
  /** The selected brain. Absent: MewMuze Local (the constructor's `ai`). */
  provider?(): { id: ProviderId; ai: ChatAI };
  /** Is Local Chat installed? (Offered when an external provider fails.) */
  localAvailable?(): boolean;
  /** One line about the hour the user is in, learned locally (companion/habits.ts). */
  rhythm?(): string | null;
  /** This conversation so far, for the Diary: on close, new chat, forget and a long pause. */
  saveDiary?(s: DiarySession): void;
}

/** A pause this long starts a new Diary entry, even with the same lines on screen. */
export const DIARY_SESSION_GAP_MS = 2 * 60 * 60_000;

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The model classifier may not hold the reply up for longer than this. */
const CLASSIFY_TIMEOUT_MS = 6000;
const FACTS_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolveP(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export class ChatController {
  private s: ChatState = INITIAL_CHAT;
  private memory: ChatMemory = EMPTY_MEMORY;
  private style: StyleProfile = EMPTY_STYLE;
  private followUps: FollowUp[] = [];
  private conversation = newId("conv");
  private inFlight: string | null = null;
  readonly persona = new PersonaState();
  /** A check-in MewMuze asked about in this conversation, waiting for the answer. */
  private askedFollowUp: string | null = null;
  /** "Want me to check in tomorrow?" was offered; the next message answers it. */
  private offer: { kind: FollowUpKind; text: string } | null = null;
  /** Kinds already offered or created this session: never nag twice. */
  private readonly offered = new Set<FollowUpKind>();
  /** The brain this conversation's messages have gone to (null: nothing sent yet). */
  private conversationProvider: ProviderId | null = null;
  /** The brain opened for this window, released on close. */
  private opened: ChatAI | null = null;
  /** Where the current Diary entry starts in `lines`, and its times. */
  private diary = { id: newId("diary"), from: 0, startedAt: 0, lastAt: 0 };

  constructor(
    private readonly ai: ChatAI,
    private readonly deps: ChatDeps,
    private readonly onChange: (s: ChatState) => void,
  ) {}

  state(): ChatState {
    return this.s;
  }

  rememberedItems() {
    return this.memory.items;
  }

  learnedStyle(): StyleProfile {
    return this.style;
  }

  pendingFollowUps(): FollowUp[] {
    return prune(this.followUps, this.deps.now());
  }

  private set(patch: Partial<ChatState>): void {
    this.s = { ...this.s, ...patch };
    this.onChange(this.s);
  }

  private remembering(): boolean {
    return this.deps.settings().chat.rememberUseful;
  }

  /** Load what may persist. Nothing is loaded while memory is off. */
  private async loadPersisted(): Promise<void> {
    if (!this.remembering()) {
      this.memory = EMPTY_MEMORY;
      this.style = EMPTY_STYLE;
      this.followUps = [];
      return;
    }
    this.memory = await this.deps.loadMemory();
    this.style = (await this.deps.loadStyle?.()) ?? EMPTY_STYLE;
    this.followUps = prune((await this.deps.loadFollowUps?.()) ?? [], this.deps.now());
  }

  /**
   * The check-in to ask about now, if one is due - for the cat's notice at
   * launch and the first line of a chat. Asking counts: each is asked at most
   * twice in all, and only once per app session.
   */
  async dueFollowUpLine(): Promise<string | null> {
    const c = this.deps.settings().chat;
    if (!c.rememberUseful || !c.followUps) return null;
    if (this.s.status === "closed") await this.loadPersisted();
    const f = due(this.followUps, this.deps.now());
    if (!f) return null;
    if (this.askedFollowUp !== f.id) {
      this.askedFollowUp = f.id;
      this.followUps = markAsked(this.followUps, f.id);
      void this.deps.saveFollowUps?.(this.followUps);
    }
    const lang = view(this.memory).language ?? resolveLang(this.deps.settings().language, this.deps.osLanguage());
    return askLine(f, lang, view(this.memory).name || this.deps.userName());
  }

  /** The selected brain: MewMuze Local unless Settings name another. */
  private current(): { id: ProviderId; ai: ChatAI } {
    return this.deps.provider?.() ?? { id: "local", ai: this.ai };
  }

  /** Hold `ai` for this window; the previous brain (if the setting changed) is let go. */
  private async use(ai: ChatAI): Promise<void> {
    if (this.opened === ai) return;
    this.opened?.closeChat();
    this.opened = ai;
    await ai.openChat();
  }

  /** A failure in words the user can act on; provider codes go behind "Technical details". */
  private fail(e: unknown, provider: ProviderId, patch: Partial<ChatState> = {}): void {
    const f = e instanceof ProviderError ? e : null;
    this.set({
      ...patch,
      status: "error",
      error: f ? f.message : String(e instanceof Error ? e.message : e),
      errorDetail: f?.technical || null,
      offerLocal: provider !== "local" && !!this.deps.localAvailable?.(),
    });
  }

  /** The chat window opened: wake the model (it stays loaded while open). */
  async open(): Promise<void> {
    if (this.s.status !== "closed" && this.s.status !== "error") return;
    const { id, ai } = this.current();
    const profileLang = resolveLang(this.deps.settings().language, this.deps.osLanguage());
    this.set({ status: "waking", error: null, errorDetail: null, offerLocal: false, provider: id, lang: this.s.lines.length ? this.s.lang : profileLang });
    await this.loadPersisted();
    // A due check-in opens a fresh chat: "Feeling any better today, Sandy?"
    if (this.s.lines.length === 0) {
      const ask = await this.dueFollowUpLine();
      if (ask) this.set({ lines: [{ id: newId("a"), role: "assistant", text: ask }] });
    }
    try {
      await this.use(ai);
      this.set({ status: "ready" });
      // Read the system prompt (and any earlier lines) into the model's cache
      // while the user types: cold, its ~330 tokens take 3-5 s before the
      // first word of a reply; warm, only the new message is left to read.
      // (External providers have nothing to warm, and nothing is sent.)
      const mem = view(this.memory);
      ai.warm(buildMessages(this.system(mem.language ?? this.s.lang, mem, id), this.s.lines.map((l) => ({ role: l.role, content: l.text }))));
    } catch (e) {
      this.fail(e, id);
    }
  }

  close(): void {
    if (this.inFlight) void this.opened?.cancelReply(this.inFlight);
    if (this.s.status !== "closed") this.opened?.closeChat();
    this.opened = null;
    this.saveDiary();
    this.set({ status: "closed" });
  }

  /** This Diary entry's conversation so far, or null if nothing was said. */
  diarySession(): DiarySession | null {
    const lines = this.s.lines
      .slice(this.diary.from)
      .filter((l) => !l.pending && l.text)
      .map((l) => ({ role: l.role, text: l.text }));
    if (!lines.some((l) => l.role === "user")) return null;
    return { id: this.diary.id, startedAt: this.diary.startedAt, endedAt: this.diary.lastAt, lines, lang: this.s.lang, provider: this.conversationProvider ?? "local" };
  }

  /** Hand the conversation to the Diary. The same entry is updated if it carries on. */
  saveDiary(): void {
    const s = this.diarySession();
    if (s) this.deps.saveDiary?.(s);
  }

  /** Close this Diary entry; the next message starts another. */
  private nextDiaryEntry(): void {
    this.saveDiary();
    this.diary = { id: newId("diary"), from: this.s.lines.length, startedAt: 0, lastAt: 0 };
  }

  /**
   * Start again: the Diary keeps the old conversation, memory keeps what it
   * learned (unlike Forget chat), and the next message may go to whichever
   * brain is selected now.
   */
  newChat(): void {
    this.cancel();
    this.nextDiaryEntry();
    this.conversation = newId("conv");
    this.conversationProvider = null;
    this.persona.reset();
    this.offer = null;
    this.askedFollowUp = null;
    this.diary.from = 0;
    const wasOpen = this.s.status !== "closed";
    this.opened?.closeChat();
    this.opened = null;
    this.set({ status: "closed", lines: [], lastStats: null, route: null, persona: null, switchTo: null, error: null, errorDetail: null, offerLocal: false });
    this.deps.onMood(NEUTRAL);
    if (wasOpen) void this.open();
  }

  /** "Try again": the last message if it went unanswered, otherwise wake the chat again. */
  async retry(): Promise<void> {
    const last = this.s.lines[this.s.lines.length - 1];
    if (this.s.status === "error" && last?.role === "user") {
      this.set({ lines: this.s.lines.slice(0, -1), status: "ready", error: null, errorDetail: null, offerLocal: false });
      return this.send(last.text);
    }
    return this.open();
  }

  /** One message, typed or spoken - the same path either way. */
  async send(text: string): Promise<void> {
    const msg = text.trim().slice(0, 2000);
    if (!msg || this.s.status === "thinking" || this.s.status === "waking") return;
    const settings = this.deps.settings();
    const now = this.deps.now();
    const remembering = settings.chat.rememberUseful;

    // ---- which brain; never send a conversation somewhere it wasn't started ----
    const { id: providerId, ai } = this.current();
    const started = this.s.lines.some((l) => l.role === "user");
    // Moving TO Local is always safe (nothing leaves the PC); moving to an
    // external provider with earlier lines would send them there.
    if (started && this.conversationProvider && providerId !== this.conversationProvider && providerId !== "local") {
      this.set({ switchTo: providerId });
      return;
    }
    try {
      await this.use(ai);
    } catch (e) {
      this.fail(e, providerId);
      return;
    }
    this.conversationProvider = providerId;
    // A long pause starts a new Diary entry; the lines stay on screen.
    if (this.diary.lastAt && now - this.diary.lastAt > DIARY_SESSION_GAP_MS) this.nextDiaryEntry();
    if (!this.diary.startedAt) this.diary.startedAt = now;
    this.diary.lastAt = now;
    const external = providerId !== "local";

    // ---- what may be learned from this message (memory on only) ----
    const detected = detectLanguage(msg);
    if (remembering) {
      const found = extractPreferences(msg);
      if (found.length) {
        this.memory = remember(this.memory, found, this.conversation, now);
        void this.deps.saveMemory(this.memory);
      }
      // The text is read and dropped: only running averages are kept.
      this.style = learn(this.style, msg, detected);
      void this.deps.saveStyle?.(this.style);
    }
    const mem = view(this.memory);
    const learned = traits(remembering ? this.style : EMPTY_STYLE);
    const profileLang = resolveLang(settings.language, this.deps.osLanguage());
    // An explicit "reply in Hindi" wins; otherwise mirror how the user writes.
    const lang = mem.language ?? replyLanguage(msg, this.s.lines.length ? this.s.lang : null, learned.language ?? profileLang);

    const user: ChatLine = { id: newId("u"), role: "user", text: msg };
    const reply: ChatLine = { id: newId("a"), role: "assistant", text: "", pending: true };
    const firstMessage = !this.s.lines.some((l) => l.role === "user");
    this.set({ status: "thinking", lines: [...this.s.lines, user, reply], lang, error: null, errorDetail: null, offerLocal: false, switchTo: null, provider: providerId });

    const history: ChatTurn[] = this.s.lines.filter((l) => !l.pending).map((l) => ({ role: l.role, content: l.text }));
    const system = this.system(lang, mem, providerId);
    const extra: string[] = [];
    // "Call me Sandy and keep it short" is an instruction, not a new turn of
    // the vent: in the live test it was answered with more about the manager.
    const told = extractPreferences(msg).length > 0;
    if (told) extra.push("They just told you how to talk to them: acknowledge it in a few words and do it. Not the earlier topic.");

    // ---- follow-ups: an answer to a check-in, or to an offer of one ----
    if (this.askedFollowUp) {
      this.followUps = resolve(this.followUps, this.askedFollowUp);
      void this.deps.saveFollowUps?.(this.followUps);
      this.askedFollowUp = null;
      extra.push("They are answering your check-in: respond to how they are now, briefly and warmly.");
    }
    if (this.offer) {
      const yes = answerToOffer(msg);
      if (yes === true) {
        this.followUps = addFollowUp(this.followUps, makeFollowUp(this.offer.kind, now, this.conversation, this.offer.text));
        void this.deps.saveFollowUps?.(this.followUps);
        extra.push("They said yes to a check-in tomorrow: confirm it in a few warm words.");
      } else if (yes === false) {
        extra.push("They said no to a check-in; that is fine - do not bring it up again.");
      }
      this.offer = null;
    }

    // ---- the Persona Router: rules first, the model only when unsure ----
    const t0 = now;
    const sig = signals(msg);
    const ctx = { lang, hour: new Date(now).getHours(), firstMessage };
    let routing = decide(sig, ctx);
    let usedModel = false;
    // External providers route on the rules alone: no paid call to classify.
    if (!external && shouldAskModel(routing, sig, this.persona.snapshot().primary)) {
      // Asked as a follow-up turn of the same conversation, so the model's
      // prompt cache (system + history + this message) is reused.
      const id = newId("r");
      this.inFlight = id;
      try {
        const raw = await withTimeout(ai.json(id, [...buildMessages(system, history), { role: "user", content: CLASSIFY_NOTE }], CLASSIFY_SCHEMA), CLASSIFY_TIMEOUT_MS);
        routing = fromModel(raw, sig, ctx) ?? routing;
        usedModel = true;
      } catch {
        // Timed out, cancelled or the model failed: the rules' answer stands.
        void ai.cancelReply(id);
      } finally {
        this.inFlight = null;
      }
    }
    const style = settings.chat.style === "auto" ? "auto" : settings.chat.style;
    const who = this.persona.update(routing, now, style);
    // The Savage personality, said where a 1.7B model still hears it: in the
    // turn. Only in conversation - with it, a raise question came back with
    // advice to insult the manager - and never over sadness, stress or danger.
    const voice = (mem.personality ?? settings.personality) === "savage" && routing.risk === "none" && routing.mood !== "sad" && routing.mood !== "stressed" ? SAVAGE_VOICE[shapeOf(who.primary)] : undefined;
    if (voice) extra.push(voice);
    // What the cat has noticed about this hour of their day - background only:
    // it colours the reply's length and tone, it is never a thing to announce.
    const rhythm = this.deps.rhythm?.();
    if (rhythm) extra.push(rhythm);
    const routeMs = this.deps.now() - t0;
    this.set({ persona: { primary: who.primary, secondary: who.secondary } });

    // ---- facts are fetched separately from the persona ----
    let facts: string | undefined;
    let hadFacts = false;
    if (routing.needsCurrentInformation && this.deps.currentInfo) {
      const got = await withTimeout(this.deps.currentInfo(routing.currentKind ?? "other", msg), FACTS_TIMEOUT_MS).catch(() => null);
      hadFacts = !!got;
      facts = factsNote(got);
    }

    // ---- a check-in worth offering (or, with Gentle follow-ups, creating) ----
    let offerKind: FollowUpKind | null = null;
    if (remembering && settings.chat.followUps && routing.risk !== "high") {
      const kind = detectFollowUp(msg);
      const pending = this.followUps.some((f) => f.kind === kind);
      if (kind && !pending && !this.offered.has(kind)) {
        this.offered.add(kind);
        if (settings.chat.gentleFollowUps) {
          this.followUps = addFollowUp(this.followUps, makeFollowUp(kind, now, this.conversation, msg));
          void this.deps.saveFollowUps?.(this.followUps);
        } else {
          offerKind = kind;
        }
      }
    }

    // ---- the reply: one context, one generation, a cheap check, at most one rewrite ----
    // Listening, not solving: an emotional persona answering a vent (a question
    // like "any tips?" is asking for the solving).
    const venting = !told && (persona(who.primary).emotional || who.primary === "savage_bestie") && routing.intent !== "question" && routing.intent !== "request";
    const turn = buildTurn({
      system, history, who, groupGeneralization: routing.groupGeneralization, venting, lang, learned,
      preferredLength: mem.length === "short" || mem.length === "detailed" ? mem.length : undefined, extra,
      // Live facts, plus plain definitions of terms small models invent (glossary.ts).
      facts: [facts, glossaryNote(msg)].filter(Boolean).join(" ") || undefined,
      mood: { mood: routing.mood, intensity: routing.intensity },
    });
    const requestId = reply.id;
    this.inFlight = requestId;
    let streamed = "";
    let final = "";
    let rewritten = false;
    try {
      const stats = await ai.reply(
        requestId,
        // Paid tokens: only recent context goes to an external provider.
        external ? compactForProvider(turn.messages) : turn.messages,
        (piece) => {
          streamed += piece;
          this.updateLine(requestId, tidyReply(streamed, msg), true);
        },
        turn.maxTokens,
        turn.temperature,
        turn.options,
      );
      let checked = review(guardReply(tidyReply(stats.text || streamed, msg)), turn.check);
      // The rewrite is only for what trimming sentences cannot fix (the wrong
      // language, nothing said), and it happens once: the second draft is used
      // only if it passes, otherwise the first stands.
      // Never a second paid generation: external replies get the trims only.
      if (checked.rewrite && !stats.cancelled && !external) {
        const rw = `${requestId}-rw`;
        this.inFlight = rw;
        const again = await ai.reply(rw, rewriteMessages(turn, checked.text, checked.rewrite), () => undefined, turn.maxTokens, 0.3, turn.options);
        const second = review(guardReply(tidyReply(again.text, msg)), turn.check);
        rewritten = true;
        if (!again.cancelled && !second.rewrite && second.text) checked = { ...second, issues: [...checked.issues, ...second.issues] };
      }
      final = checked.text || "…";
      // One emoji that fits the moment, texting-style (none in danger or on health, code, facts).
      const emoji = checked.text
        ? replyEmoji({ primary: who.primary, mood: routing.mood, risk: routing.risk, personality: mem.personality ?? settings.personality, raw: stats.text || streamed, previous: turn.check.previous })
        : "";
      if (emoji) final = `${final} ${emoji}`;
      // Danger gets a fixed line whatever the model wrote (see safetyLine); a
      // health answer that never said when to see a doctor gets that line.
      const safety = safetyLine(routing.risk, lang) || careLine(who.primary, final, lang);
      if (safety) final = `${final} ${safety}`;
      if (offerKind) {
        final = `${final} ${offerLine(lang)}`;
        this.offer = { kind: offerKind, text: msg };
      }
      this.updateLine(requestId, final, false);
      this.set({
        status: "ready",
        lastStats: stats,
        route: {
          primary: who.primary, secondary: who.secondary, mode: persona(who.primary).mode, source: routing.source, confidence: routing.confidence,
          mood: routing.mood, language: lang, routeMs, usedModel, needsCurrentInformation: routing.needsCurrentInformation, hadFacts,
          temperature: turn.temperature, maxTokens: turn.maxTokens, rewritten, fixes: checked.issues,
        },
      });
    } catch (e) {
      this.updateLine(requestId, "", false);
      this.fail(e, providerId, { lines: this.s.lines.filter((l) => l.id !== requestId) });
      return;
    } finally {
      this.inFlight = null;
    }
    this.diary.lastAt = this.deps.now();
    this.deps.onMood(routing.mood === "neutral" ? NEUTRAL : { mood: routing.mood, intensity: routing.intensity }, who);
  }

  private system(lang: Lang, mem: ReturnType<typeof view>, provider: ProviderId): string {
    return systemPrompt({ name: this.deps.userName(), lang, personality: this.deps.settings().personality, memory: mem, local: provider === "local" });
  }

  cancel(): void {
    if (this.inFlight) void this.opened?.cancelReply(this.inFlight);
  }

  /**
   * Clear this conversation and anything remembered from it. The Diary is the
   * user's own record and is NOT part of that: its entry for this conversation
   * is kept (written now if it wasn't yet) - only Diary's own Delete removes it.
   */
  forgetConversation(): void {
    this.cancel();
    this.nextDiaryEntry();
    this.diary.from = 0;
    this.conversationProvider = null;
    this.memory = forgetConversation(this.memory, this.conversation);
    this.followUps = forgetConversationFollowUps(this.followUps, this.conversation);
    void this.deps.saveMemory(this.memory);
    void this.deps.saveFollowUps?.(this.followUps);
    this.conversation = newId("conv");
    this.persona.reset();
    this.offer = null;
    this.askedFollowUp = null;
    this.set({ lines: [], lastStats: null, route: null, persona: null, switchTo: null });
    this.deps.onMood(NEUTRAL);
  }

  /** Clear companion memory: preferences, learned style and every check-in. */
  async clearAll(): Promise<void> {
    this.memory = EMPTY_MEMORY;
    this.style = EMPTY_STYLE;
    this.followUps = [];
    this.offer = null;
    this.askedFollowUp = null;
    await this.deps.saveMemory(EMPTY_MEMORY);
    await this.deps.saveStyle?.(EMPTY_STYLE);
    await this.deps.saveFollowUps?.([]);
  }

  async setMemory(m: ChatMemory): Promise<void> {
    this.memory = m;
    await this.deps.saveMemory(m);
  }

  async forgetFollowUp(id: string): Promise<void> {
    // From Settings the chat may never have opened: edit the stored list, not an empty one.
    if (this.s.status === "closed") this.followUps = (await this.deps.loadFollowUps?.()) ?? [];
    this.followUps = resolve(this.followUps, id);
    await this.deps.saveFollowUps?.(this.followUps);
  }

  async forgetStyle(): Promise<void> {
    this.style = EMPTY_STYLE;
    await this.deps.saveStyle?.(EMPTY_STYLE);
  }

  private updateLine(id: string, text: string, pending: boolean): void {
    this.set({ lines: this.s.lines.map((l) => (l.id === id ? { ...l, text, pending } : l)) });
  }
}
