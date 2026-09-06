import { useEffect, useRef, useState } from "react";
import { formatTimer, type PomodoroSnapshot } from "../productivity/pomodoro";
import { sessionView, BREAK_MINUTES, type Session } from "../productivity/session";

/**
 * Lightweight pixel-styled overlay widgets: the right-click context menu, the
 * reminder/message bubble, the pinned note, the Pomodoro chip and the scroll
 * paper strip. All positions arrive in CSS pixels (App converts from the
 * overlay's physical coordinate space).
 */

// ---- context menu --------------------------------------------------------
export interface MenuState {
  x: number;
  y: number;
}

export type MenuCommand =
  | "cat-off"
  | "pause"
  | "resume"
  | "pet"
  | "call"
  | "sleep"
  | "toggle-chase"
  | "toggle-sound"
  | "activity-calm"
  | "activity-balanced"
  | "activity-playful"
  | "size-small"
  | "size-medium"
  | "size-large"
  | "toggle-peek"
  | "pomodoro-toggle"
  | "work-mode"
  | "clipboard-assistant"
  | "set-reminder"
  | "add-note"
  | "focus-mode"
  | "break"
  | "tasks"
  | "calc-time"
  | "photo-mode"
  | "explain"
  | "settings"
  | "quit";

export function CatContextMenu({
  state,
  workMode,
  session,
  clipboardEnabled,
  onCommand,
  onClose,
}: {
  state: MenuState;
  /** Work mode is currently on, so the item offers to leave it. */
  workMode: boolean;
  /** Active focus/break session, so those items offer to end it. */
  session: Session | null;
  clipboardEnabled: boolean;
  onCommand: (cmd: MenuCommand) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    // Keep the menu on-screen.
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - r.width - 8),
      y: Math.min(state.y, window.innerHeight - r.height - 8),
    });
  }, [state]);

  const item = (
    label: string,
    cmd: MenuCommand,
    opts?: { check?: boolean; danger?: boolean; soon?: boolean },
  ) => (
    <div
      className={`cat-menu-item${opts?.danger ? " danger" : ""}${opts?.soon ? " soon" : ""}`}
      onClick={() => {
        if (opts?.soon) return; // "coming soon" items are inert
        onCommand(cmd);
        onClose();
      }}
    >
      <span>{label}</span>
      {opts?.soon && <span className="cat-menu-soon">Coming soon</span>}
      {opts?.check !== undefined && <span className="cat-menu-check">{opts.check ? "✓" : ""}</span>}
    </div>
  );

  const focusOn = session?.kind === "focus";
  const breakOn = session?.kind === "break";

  // A clean launcher: modes up top, productivity tools, then app controls.
  return (
    <div ref={ref} className="cat-menu" style={{ left: pos.x, top: pos.y }}>
      {item(workMode ? "Exit work mode" : "⚡ Work mode", "work-mode", { check: workMode })}
      {item(focusOn ? "Stop focus mode" : "🎯 Focus mode", "focus-mode", { check: focusOn })}
      {item(breakOn ? "End break" : "☕ Break…", "break", { check: breakOn })}
      <div className="cat-menu-sep" />
      {item("⏰ Set Reminder…", "set-reminder")}
      {item("📝 Add note…", "add-note")}
      {clipboardEnabled && item("▤ Clipboard Assistant", "clipboard-assistant")}
      {item("✓ Tasks", "tasks", { soon: true })}
      {item("🧮 Calc & Time", "calc-time")}
      {item("📷 Photo Mode", "photo-mode")}
      <div className="cat-menu-sep" />
      {item("Settings…", "settings")}
      {item("Close app", "quit", { danger: true })}
    </div>
  );
}

// ---- retro notice --------------------------------------------------------
export interface BubbleState {
  id: string;
  message: string;
  /** Show snooze in addition to dismiss (reminders). */
  snoozable: boolean;
  /** Colour cue: plain white, light-green early warning, light-red due-now. */
  variant?: "plain" | "warn" | "due";
  /** Offer a "Done" action too (scheduled reminders). */
  completable?: boolean;
}

/**
 * The universal notification: a small white rectangle with a thin black
 * outline and black pixel-style text — retro game dialogue, not a modern
 * toast. It ALWAYS sits above the cat's head with a small consistent gap,
 * never in front of the cat, and is kept inside the monitor by sliding left
 * or right (and, when a message is genuinely wider than the screen, by
 * stepping the font down). The text never wraps: one line, always.
 */
export function RetroNotice({
  bubble,
  catCx,
  catTop,
  areaLeft,
  areaRight,
  onDismiss,
  onSnooze,
  onComplete,
}: {
  bubble: BubbleState;
  /** Cat centre x and top y, CSS px. */
  catCx: number;
  catTop: number;
  /** Monitor work-area horizontal range, CSS px (keeps the label on-screen). */
  areaLeft: number;
  areaRight: number;
  onDismiss: () => void;
  onSnooze: () => void;
  onComplete?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Small constant space between the label block and the cat's head: close
  // enough to read as "the cat is saying this", never touching the sprite.
  const GAP = 5;
  const MARGIN = 6;
  const [layout, setLayout] = useState<{ x: number; y: number; font: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure, shrink the font until the single line fits the monitor, then
    // centre on the cat and slide sideways only as far as needed to stay in.
    const avail = Math.max(80, areaRight - areaLeft - MARGIN * 2);
    let font = 11;
    el.style.fontSize = `${font}px`;
    let r = el.getBoundingClientRect();
    while (r.width > avail && font > 8) {
      font -= 1;
      el.style.fontSize = `${font}px`;
      r = el.getBoundingClientRect();
    }
    const x = Math.min(Math.max(catCx - r.width / 2, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(MARGIN, catTop - GAP - r.height);
    setLayout({ x, y, font });
  }, [bubble.message, bubble.snoozable, bubble.completable, catCx, catTop, areaLeft, areaRight]);

  return (
    <div
      ref={ref}
      // `notice-single` marks the one notice anchored directly to the cat, so
      // the mail stack can measure it and start above it instead of on top of
      // it. Purely a layout hook — it carries no styling of its own.
      className={`retro-notice notice-single ${bubble.variant ?? "plain"}`}
      style={
        layout
          ? { left: layout.x, top: layout.y, fontSize: layout.font }
          : { left: -9999, top: -9999 }
      }
    >
      <span className="retro-msg">{bubble.message}</span>
      <span className="retro-actions">
        {bubble.completable && onComplete && (
          <button className="retro-btn done" onClick={onComplete}>
            Done
          </button>
        )}
        {bubble.snoozable && (
          <button className="retro-btn" onClick={onSnooze}>
            Snooze
          </button>
        )}
        <button className="retro-btn" onClick={onDismiss}>
          OK
        </button>
      </span>
    </div>
  );
}

// ---- stacked email notifications -----------------------------------------
/**
 * Email arrives in bursts, and a single notice can only ever show the newest
 * one — so the rest used to be dropped on the floor. This stacks up to five of
 * them above the cat, newest nearest its head, and holds the remainder back
 * with a "+N more" count; dismissing a card lets the next one take its slot.
 *
 * It is deliberately one positioned container of flow-laid-out cards rather
 * than N absolutely-placed elements: the browser does the stacking, so there is
 * exactly one rect to measure and clamp into the monitor's work area.
 *
 * When a plain notice (a reminder, a calendar alert) is already anchored to the
 * cat, the stack starts above THAT instead of the cat's head, so the two never
 * land on the same pixels.
 */
export function MailStack({
  items,
  limit,
  queued,
  catCx,
  catTop,
  areaLeft,
  areaRight,
  areaTop,
  noticeKey,
  onOpen,
  onDismiss,
}: {
  /** Visible cards, newest first. */
  items: { uid: number; line: string }[];
  /** How many cards the user allows on screen (1–5). */
  limit: number;
  /** Messages held back behind the visible ones. */
  queued: number;
  catCx: number;
  catTop: number;
  areaLeft: number;
  areaRight: number;
  /** Top of the monitor work area, CSS px — the stack never grows past it. */
  areaTop: number;
  /**
   * Identity of the notice currently anchored to the cat ("" for none). The
   * stack sits above that notice, so it has to re-place itself when one
   * appears, changes or goes away — none of which it can see otherwise.
   */
  noticeKey: string;
  onOpen: (uid: number) => void;
  onDismiss: (uid: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const GAP = 5;
  const MARGIN = 6;
  const [layout, setLayout] = useState<{ x: number; y: number; font: number } | null>(null);
  /** How many cards actually fit above the cat; the rest stay queued. */
  const [fit, setFit] = useState(limit);
  /** Bumped whenever the stack's own box changes size, forcing a re-placement. */
  const [sizeTick, setSizeTick] = useState(0);

  // Placement is only as good as the measurement it was taken from, and the
  // box can change size for reasons that are not in the deps below — a
  // stylesheet applying a frame late, a webfont swapping in. Measured once and
  // trusted, that lands the whole stack in the wrong place until the cat next
  // moves. Re-place whenever the box actually resizes.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (key === last) return; // placement moves the box; it never resizes it
      last = key;
      setSizeTick((n) => n + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = items.slice(0, Math.max(1, Math.min(fit, limit)));
  const hidden = queued + Math.max(0, items.length - shown.length);
  /** Identity of the visible set, so the effect re-runs on content, not on every render. */
  const uidKey = items.map((m) => m.uid).join(",");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Sit above whatever notice is anchored to the cat, so a reminder and the
    // mail stack never occupy the same strip.
    //
    // Only that notice's HEIGHT is read, never its position. It is a sibling
    // that positions ITSELF in its own effect, and sibling effects all run
    // before any of their state reaches the DOM — so its `top` is a frame stale
    // (or still the off-screen -9999 it parks at before its first measurement),
    // while its height is correct from the very first layout. Deriving the same
    // way it does — one gap under the cat, then its own height — makes this
    // independent of which effect ran first.
    const anchoredH = document.querySelector<HTMLElement>(".notice-single")?.getBoundingClientRect().height ?? 0;
    const baseBottom = anchoredH > 0 ? catTop - GAP - anchoredH - GAP : catTop - GAP;
    const available = baseBottom - (areaTop + MARGIN);

    // How many cards fit above the cat. Derived from ONE card's height rather
    // than by summing the rendered ones: every card is a single nowrap line so
    // they are uniform, and measuring the rendered set would make the count a
    // function of itself — once trimmed, the stack could never grow back when
    // the cat moved somewhere roomier.
    const cardH = (el.children[0] as HTMLElement | undefined)?.getBoundingClientRect().height ?? 0;
    // Always at least one: a cat parked at the very top of the screen gets a
    // clamped card rather than silence — the same trade-off the single notice
    // already makes. A zero height means no layout engine (jsdom), in which
    // case take the requested limit at face value.
    const nextFit =
      cardH > 0 ? Math.max(1, Math.min(limit, Math.floor((available + GAP) / (cardH + GAP)))) : limit;
    if (nextFit !== fit) {
      setFit(nextFit); // re-measure once the stack is the right size
      return;
    }

    // Step the type down until the widest card fits the monitor, exactly the
    // 11px→8px ladder the single notice uses. Cards never wrap, so a long
    // subject would otherwise push the whole stack past the screen edge.
    const avail = Math.max(80, areaRight - areaLeft - MARGIN * 2);
    let font = 11;
    el.style.fontSize = `${font}px`;
    let r = el.getBoundingClientRect();
    while (r.width > avail && font > 8) {
      font -= 1;
      el.style.fontSize = `${font}px`;
      r = el.getBoundingClientRect();
    }

    const x = Math.min(Math.max(catCx - r.width / 2, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(areaTop + MARGIN, baseBottom - r.height);
    setLayout((prev) =>
      prev && prev.x === x && prev.y === y && prev.font === font ? prev : { x, y, font },
    );
  }, [uidKey, limit, queued, fit, sizeTick, noticeKey, catCx, catTop, areaLeft, areaRight, areaTop]);

  return (
    <div
      ref={ref}
      className="mail-stack"
      style={
        layout
          ? { left: layout.x, top: layout.y, fontSize: layout.font }
          : { left: -9999, top: -9999 }
      }
    >
      {shown.map((item, i) => (
        <div key={item.uid} className="retro-notice mail-card">
          <span className="retro-msg">
            📧 {item.line}
            {/* The overflow count rides on the topmost card so it needs no
                measuring pass of its own. */}
            {i === shown.length - 1 && hidden > 0 && <span className="mail-more">+{hidden} more</span>}
          </span>
          <span className="retro-actions">
            <button className="retro-btn open" onClick={() => onOpen(item.uid)}>
              Open
            </button>
            <button className="retro-btn" onClick={() => onDismiss(item.uid)}>
              OK
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- focus / break session timer ----------------------------------------
/**
 * The Focus-mode / Break timer chip. Same retro-dialogue shape as RetroNotice
 * (rectangle, thin outline, pixel font) but colour-coded: a calm green for
 * focus with white text, and a green→amber→red ramp for a break, with a
 * progress bar filling along the bottom edge as the break runs down. It sits
 * above the cat's head and self-ticks every 250 ms so the countdown stays live
 * without re-rendering the whole app each frame.
 */
export function SessionTimer({
  session,
  catCx,
  catTop,
  areaLeft,
  areaRight,
  onEnd,
}: {
  session: Session;
  catCx: number;
  catTop: number;
  areaLeft: number;
  areaRight: number;
  onEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const GAP = 5;
  const MARGIN = 6;
  const [now, setNow] = useState(Date.now());
  const [layout, setLayout] = useState<{ x: number; y: number } | null>(null);

  // Live countdown/count-up tick, independent of the animation loop.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const view = sessionView(session, now);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(catCx - r.width / 2, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(MARGIN, catTop - GAP - r.height);
    setLayout({ x, y });
  }, [view.label, catCx, catTop, areaLeft, areaRight]);

  const title = view.kind === "focus" ? "FOCUS" : view.overrun ? "BREAK'S OVER!" : "BREAK";

  return (
    <div
      ref={ref}
      className={`session-timer${view.kind === "break" ? " has-bar" : ""}${view.overrun ? " overrun" : ""}`}
      style={{
        ...(layout ? { left: layout.x, top: layout.y } : { left: -9999, top: -9999 }),
        background: view.color,
        color: view.text,
      }}
    >
      <span className="session-label">{title}</span>
      <span className="session-time">{view.label}</span>
      <button className="session-end" onClick={onEnd} title="End">
        ✕
      </button>
      {view.kind === "break" && (
        <span className="session-bar" style={{ width: `${Math.round(view.fraction * 100)}%` }} />
      )}
    </div>
  );
}

// ---- break duration picker -----------------------------------------------
/** Small pill row for choosing how long a break should last. */
export function BreakPicker({
  catCx,
  catTop,
  areaLeft,
  areaRight,
  onPick,
  onClose,
}: {
  catCx: number;
  catTop: number;
  areaLeft: number;
  areaRight: number;
  onPick: (minutes: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const GAP = 5;
  const MARGIN = 6;
  const [layout, setLayout] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(catCx - r.width / 2, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(MARGIN, catTop - GAP - r.height);
    setLayout({ x, y });
  }, [catCx, catTop, areaLeft, areaRight]);

  return (
    <div
      ref={ref}
      className="break-picker"
      style={layout ? { left: layout.x, top: layout.y } : { left: -9999, top: -9999 }}
    >
      <span className="break-picker-label">Break for</span>
      {BREAK_MINUTES.map((m) => (
        <button key={m} className="break-pill" onClick={() => onPick(m)}>
          {m}m
        </button>
      ))}
      <button className="break-pill cancel" onClick={onClose} title="Cancel">
        ✕
      </button>
    </div>
  );
}

// ---- pinned note ---------------------------------------------------------
/**
 * The pinned note rides above the cat like a little chat balloon (small tail
 * triangle at the bottom-left). It measures itself and slides horizontally so
 * the whole note stays readable even when the cat is parked hard against the
 * left or right edge of the monitor.
 */
export function CatNote({
  text,
  catCx,
  catTop,
  areaLeft,
  areaRight,
}: {
  text: string;
  catCx: number;
  catTop: number;
  areaLeft: number;
  areaRight: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const GAP = 6;
  const MARGIN = 6;
  const [layout, setLayout] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(catCx - r.width * 0.35, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(MARGIN, catTop - GAP - r.height);
    setLayout({ x, y });
  }, [text, catCx, catTop, areaLeft, areaRight]);

  return (
    <div
      ref={ref}
      className="cat-note pixel-ui"
      style={layout ? { left: layout.x, top: layout.y } : { left: -9999, top: -9999 }}
    >
      <span className="cat-note-text">{text}</span>
    </div>
  );
}

// ---- pomodoro chip -------------------------------------------------------
const PHASE_COLORS: Record<string, string> = {
  focus: "#e06e59",
  shortBreak: "#5fae62",
  longBreak: "#5a8fd6",
  paused: "#b8a34e",
};

export function PomodoroChip({ snapshot, x, y }: { snapshot: PomodoroSnapshot; x: number; y: number }) {
  if (snapshot.phase === "idle") return null;
  const label =
    snapshot.phase === "focus"
      ? "Focus"
      : snapshot.phase === "shortBreak"
        ? "Break"
        : snapshot.phase === "longBreak"
          ? "Long break"
          : "Paused";
  return (
    <div className="pomo-chip pixel-ui" style={{ left: x, top: y }}>
      <span className="phase-dot" style={{ background: PHASE_COLORS[snapshot.phase] ?? "#888" }} />
      <span>{label}</span>
      <span>{formatTimer(snapshot.remaining)}</span>
    </div>
  );
}

// ---- scroll paper strip --------------------------------------------------
export function ScrollPaper({ x, y, length }: { x: number; y: number; length: number }) {
  const h = Math.max(18, Math.min(90, length));
  const lines = Math.floor(h / 8);
  return (
    <div className="scroll-paper" style={{ left: x, top: y - h, height: h }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="line" />
      ))}
    </div>
  );
}
