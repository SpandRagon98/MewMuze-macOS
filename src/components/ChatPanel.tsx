import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import type { ChatState } from "../companion/chatController";
import { dateLabel, entryMarkdown, timeLabel, type Diary, type DiaryEntry } from "../companion/diary";
import { DEFAULT_PERSONA, PERSONA_EMOJI, persona } from "../companion/persona/personas";
import { PROVIDERS } from "../companion/providers";
import type { VoiceState } from "../companion/voiceController";
import { CatPreview } from "./CatPreview";
import { confirmAction } from "./ConfirmDialog";
import { Icon } from "./icons";

/**
 * Talking to the cat, beside the real cat - who does the reacting. MewMuze
 * stays present in the header (a small live cat and a status line), and the
 * conversation is written like a script: "Sandy:" / "MewMuze:". Deliberately
 * not a chat-app layout: no bubbles, no sidebar. Beside it, the Diary.
 */

/**
 * A comfortable conversation window for the screen it is on: about a third
 * of the width and three quarters of the height, within sensible bounds, and
 * never larger than the work area. CSS pixels already account for DPI.
 */
export function chatPanelSize(area: Area): { width: number; height: number } {
  const w = area.right - area.left;
  const h = area.bottom - area.top;
  return {
    width: Math.round(Math.max(300, Math.min(Math.max(420, w * 0.3), 560, w - 24))),
    height: Math.round(Math.max(360, Math.min(Math.max(520, h * 0.72), 760, h - 24))),
  };
}

export function ChatPanel({
  cat,
  area,
  name,
  chat,
  voice,
  voiceAvailable,
  onSend,
  onCancel,
  onForget,
  onMicStart,
  onMicStop,
  onRetry,
  onClose,
  onNewChat,
  onUseLocal,
  diary,
  diaryOn = true,
  diaryRev = 0,
  showMode = false,
  debugRouting = false,
}: {
  cat: Box;
  area: Area;
  name: string;
  chat: ChatState;
  voice: VoiceState;
  voiceAvailable: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  onForget: () => void;
  onMicStart: () => void;
  onMicStop: () => void;
  onRetry: () => void;
  onClose: () => void;
  onNewChat?: () => void;
  /** An external provider failed: switch to MewMuze Local (the user's choice) and resend. */
  onUseLocal?: () => void;
  diary?: Diary;
  diaryOn?: boolean;
  /** Bumped when the Diary changes, so the list reloads. */
  diaryRev?: number;
  /** "MewMuze · 🩺 Health Guide": who MewMuze is being right now. */
  showMode?: boolean;
  /** Developer only: the internal routing, one line. */
  debugRouting?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chat" | "diary">("chat");
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const size = chatPanelSize(area);
  const [placement, setPlacement] = useState(() => placePanel({ cat, panel: size, area }));

  // Re-placed whenever its real size changes - placing it once at open let
  // the input row slide off the bottom of the screen in the real app.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        const next = placePanel({ cat, panel: { width: r.width, height: r.height }, area });
        setPlacement((p) => (p.x === next.x && p.y === next.y ? p : next));
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cat, area]);

  // Keep the newest line in view as the reply streams in.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.lines, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".mm-confirm") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = () => {
    if (!draft.trim() || chat.status === "thinking" || chat.status === "waking") return;
    onSend(draft);
    setDraft("");
  };
  const forget = async () => {
    const ok = await confirmAction({
      title: "Forget this conversation?",
      message: diaryOn
        ? "MewMuze will clear it from chat memory. Your Diary entry will stay unless you delete it from Diary."
        : "MewMuze will clear it from chat memory. (Diary is off, so nothing from it is kept there.)",
      confirmLabel: "Forget",
      danger: true,
    });
    if (ok) onForget();
  };
  const local = chat.provider === "local";
  const brain = PROVIDERS[chat.provider].name;
  const listening = voice.mode === "chat" && voice.phase === "recording";
  const transcribing = voice.mode === "chat" && voice.phase === "transcribing";
  const who = name.trim() || "You";
  const primary = chat.persona?.primary ?? chat.route?.primary;
  const active = primary && primary !== DEFAULT_PERSONA ? { id: primary, name: persona(primary).name, emoji: PERSONA_EMOJI[primary] ?? "" } : null;
  const [status, statusKind] =
    chat.status === "waking"
      ? ["Waking up…", "busy"]
      : chat.status === "thinking"
        ? ["Thinking…", "busy"]
        : listening
          ? ["Listening…", "busy"]
          : transcribing
            ? ["Writing down what you said…", "busy"]
            : chat.status === "error"
              ? ["Couldn't answer just now", "off"]
              : [local ? "Here with you · on this computer" : `Here with you · via ${brain}`, ""];

  return (
    <div
      ref={boxRef}
      className="quick-tools companion-panel chat-panel"
      style={{ left: placement.x, top: placement.y, width: size.width, height: size.height }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="mm-chat-head">
        <span className="mm-chat-cat">
          <CatPreview bare sizePx={44} />
        </span>
        <span className="mm-chat-who">
          <span className="mm-chat-name">
            MewMuze
            {showMode && active && tab === "chat" && (
              // Keyed by persona: a new mode mounts a new chip, which plays the
              // entrance once (fade, slide, a brief glow). Plain MewMuze shows none.
              <span key={active.id} className="mm-persona-chip" role="status" aria-label={`Mode: ${active.name}`}>
                <span aria-hidden="true">{active.emoji}</span> {active.name}
              </span>
            )}
          </span>
          <span className={`mm-chat-status${statusKind ? ` ${statusKind}` : ""}`} role="status">
            {status}
          </span>
        </span>
        {diary && (
          <span className="cp-tabs" role="tablist" aria-label="Chat or Diary">
            {(["chat", "diary"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`cp-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
                {t === "chat" ? "Chat" : "Diary"}
              </button>
            ))}
          </span>
        )}
        <button className="qt-x" onClick={onClose} title="Close" aria-label="Close chat">
          <Icon name="close" size={16} />
        </button>
      </div>

      {tab === "diary" && diary ? (
        <DiaryView diary={diary} on={diaryOn} rev={diaryRev} />
      ) : (
        <>
          {debugRouting && chat.route && (
            <div className="mm-chat-debug" aria-hidden="true">
              {chat.route.primary}
              {chat.route.secondary ? ` + ${chat.route.secondary}` : ""} · {chat.route.source} {chat.route.confidence.toFixed(2)} · {chat.route.mood} · {chat.route.language} · route {chat.route.routeMs} ms{chat.route.usedModel ? " (model)" : ""} · t {chat.route.temperature}
              {chat.route.needsCurrentInformation ? ` · live ${chat.route.hadFacts ? "yes" : "none"}` : ""}
              {chat.route.rewritten ? " · rewritten" : ""}
              {chat.route.fixes?.length ? ` · fixed: ${chat.route.fixes.join(", ")}` : ""}
            </div>
          )}

          <div className="cp-list" ref={listRef} aria-live="polite">
            {chat.lines.length === 0 && chat.status !== "waking" && (
              <div className="cp-hello">
                What&rsquo;s on your mind{name.trim() ? `, ${name.trim()}` : ""}?
                <small>{local ? "Anything at all. It stays on this computer." : `Anything at all. Replies come from ${brain}.`}</small>
              </div>
            )}
            {chat.status === "waking" && <div className="cp-note">Getting ready… {local ? "the first reply takes a few seconds." : ""}</div>}
            {chat.lines.map((l) => (
              <div key={l.id} className={`cp-line ${l.role}`}>
                <span className="cp-who">{l.role === "user" ? `${who}:` : "MewMuze:"}</span>
                <span className="cp-text">
                  {l.text}
                  {l.pending && <span className="cp-dots" aria-label="thinking" />}
                </span>
              </div>
            ))}
            {chat.switchTo && (
              <div className="cp-switch" role="status">
                This chat is with {brain}. It won&rsquo;t be sent to {PROVIDERS[chat.switchTo].name} unless you start over.{" "}
                <button className="mm-btn primary small" onClick={onNewChat}>
                  Start new chat with {PROVIDERS[chat.switchTo].name}
                </button>
              </div>
            )}
            {chat.status === "error" && chat.error && (
              <div className="cp-error">
                {chat.error}{" "}
                <button className="cp-link" onClick={onRetry}>
                  Try again
                </button>
                {chat.offerLocal && onUseLocal && (
                  <>
                    {" · "}
                    <button className="cp-link" onClick={onUseLocal}>
                      Use MewMuze Local
                    </button>
                  </>
                )}
                {chat.errorDetail && (
                  <details className="cp-tech">
                    <summary>Technical details</summary>
                    {chat.errorDetail}
                  </details>
                )}
              </div>
            )}
          </div>

          {(listening || transcribing) && (
            <div className="cp-mic-state">
              <span className="cp-rec-dot" />
              {listening ? `Listening… ${Math.floor(voice.seconds)}s` : "Writing down what you said…"}
              {listening && <span className="cp-level" style={{ width: `${Math.min(100, voice.level * 400)}%` }} />}
            </div>
          )}
          {voice.mode === "chat" && voice.phase === "error" && voice.error && <div className="cp-error">{voice.error}</div>}

          <div className="cp-input-row">
            <textarea
              className="cp-input"
              rows={2}
              maxLength={2000}
              placeholder="Tell MewMuze something…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Message"
            />
            {voiceAvailable && (
              <button
                className={`cp-mic${listening ? " on" : ""}`}
                title={listening ? "Stop and send" : "Speak (push to talk)"}
                aria-label={listening ? "Stop recording" : "Start recording"}
                disabled={transcribing || chat.status === "thinking"}
                onClick={listening ? onMicStop : onMicStart}
              >
                <Icon name={listening ? "stop" : "mic"} size={16} />
              </button>
            )}
            {chat.status === "thinking" ? (
              <button className="mm-btn cp-send" onClick={onCancel} title="Stop" aria-label="Stop">
                <Icon name="stop" size={15} />
              </button>
            ) : (
              <button className="mm-btn primary cp-send" disabled={!draft.trim() || chat.status === "waking"} onClick={send} title="Send" aria-label="Send">
                <Icon name="send" size={15} />
              </button>
            )}
          </div>
          <div className="cp-foot">
            <span>{local ? "Private · runs on this computer" : `${PROVIDERS[chat.provider].privacy} Your Diary stays on this computer.`}</span>
            <span className="cp-foot-actions">
              {onNewChat && (
                <button className="cp-link" onClick={onNewChat} disabled={chat.lines.length === 0}>
                  New chat
                </button>
              )}
              <button className="cp-link" onClick={() => void forget()} disabled={chat.lines.length === 0}>
                Forget chat
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** "Today", "Yesterday", or "12 Sep". */
function dayHeading(at: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return "Today";
  if (day(at) === day(now - 86_400_000)) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);
}

/** The Diary: a short list, one entry open at a time. Delete, Copy, Show file. */
export function DiaryView({ diary, on, rev }: { diary: Diary; on: boolean; rev: number }) {
  const [entries, setEntries] = useState<DiaryEntry[] | null>(null);
  const [open, setOpen] = useState<DiaryEntry | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    void diary
      .list()
      .then((l) => live && setEntries(l))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [diary, rev]);

  if (open) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(entryMarkdown(open));
        setNote("Copied ✓");
      } catch {
        setNote("Couldn't copy.");
      }
    };
    const show = async () => {
      try {
        const dir = await diary.dir();
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("photo_reveal", { path: `${dir}${dir.includes("\\") ? "\\" : "/"}${open.file}` });
      } catch {
        setNote("Couldn't open the folder.");
      }
    };
    const remove = async () => {
      const ok = await confirmAction({ title: "Delete this Diary entry?", message: "It will be removed from this computer. Chat memory is not affected.", confirmLabel: "Delete entry", danger: true });
      if (!ok) return;
      await diary.remove(open.id);
      setOpen(null);
    };
    return (
      <div className="dy-entry">
        <button className="cp-link dy-back" onClick={() => (setOpen(null), setNote(""))}>
          ← All entries
        </button>
        <div className="dy-date">
          {dateLabel(open.startedAt)} · {timeLabel(open.startedAt)}
        </div>
        <h3 className="dy-title">&ldquo;{open.title}&rdquo;</h3>
        <div className="dy-text">{open.summary}</div>
        <div className="dy-actions">
          <button className="mm-btn" onClick={() => void copy()}>
            Copy
          </button>
          <button className="mm-btn" onClick={() => void show()}>
            Show file
          </button>
          <button className="mm-btn danger" onClick={() => void remove()}>
            Delete entry
          </button>
          {note && <span className="sk-hint">{note}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="cp-list dy-list">
      {entries?.length === 0 && (
        <div className="cp-hello">
          {on ? "No entries yet." : "Diary is off."}
          <small>
            {on
              ? "After a proper chat, MewMuze writes it up here as a short entry — privately, on this computer."
              : "Turn it on in Settings → Chat to keep a private record of your chats."}
          </small>
        </div>
      )}
      {entries?.map((e, i) => {
        const heading = dayHeading(e.startedAt);
        return (
          <div key={e.id}>
            {(i === 0 || dayHeading(entries[i - 1].startedAt) !== heading) && <div className="dy-day">{heading}</div>}
            <button className="dy-row" onClick={() => setOpen(e)}>
              <span className="dy-row-title">&ldquo;{e.title}&rdquo;</span>
              <span className="dy-row-time">{timeLabel(e.startedAt)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
