import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatTimer, type PomodoroSnapshot } from "../productivity/pomodoro";
import { sessionView, BREAK_MINUTES, type Session } from "../productivity/session";
import { Icon, type IconName } from "./icons";

/**
 * Overlay widgets around the cat: the right-click menu, notices, the pinned
 * note, the focus/break chips and the scroll paper strip. All positions
 * arrive in CSS pixels (App converts from the overlay's physical space).
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
  | "butterfly"
  | "gesture-hi"
  | "gesture-high-five"
  | "tease"
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
  | "my-day"
  | "chat"
  | "recorder"
  | "explain"
  | "settings"
  | "settings:looks"
  | "quit";

type PaneId = "root" | "focus" | "reminders" | "tools" | "play" | "look";

interface MenuItem {
  label: string;
  icon: IconName;
  cmd?: MenuCommand;
  /** Opens a submenu instead of running a command. */
  sub?: PaneId;
  /** A toggle or choice that is currently on: shows a check. */
  on?: boolean;
  danger?: boolean;
  /** Present but not built yet: inert, with a "Soon" tag. */
  soon?: boolean;
}

const PANE_TITLE: Record<Exclude<PaneId, "root">, string> = {
  focus: "Focus",
  reminders: "Reminders",
  tools: "Quick Tools",
  play: "Play",
  look: "Appearance",
};

/**
 * The right-click menu: a compact control centre. The root holds the few
 * things people reach for; everything else lives one level down, in a pane
 * that slides in over the root (Left or Esc goes back). Full keyboard
 * control: arrows, Home/End, Enter/Space, Right to open, Left/Esc to leave.
 */
export function CatContextMenu({
  state,
  workMode,
  session,
  clipboardEnabled,
  voiceAvailable = false,
  catSize,
  activityLevel,
  onCommand,
  onClose,
}: {
  state: MenuState;
  /** Work mode is currently on, so the item offers to leave it. */
  workMode: boolean;
  /** Active focus/break session, so those items offer to end it. */
  session: Session | null;
  clipboardEnabled: boolean;
  /** Paper: Local Chat installed. Chat is offered either way - without the
   *  module it opens Settings → Chat, where it can be added. */
  chatAvailable?: boolean;
  /** Paper: Local Voice installed - the recorder appears only then. */
  voiceAvailable?: boolean;
  catSize?: string;
  activityLevel?: string;
  onCommand: (cmd: MenuCommand) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const [pane, setPane] = useState<PaneId>("root");
  const [entered, setEntered] = useState<"sub" | "root" | null>(null);
  const [active, setActive] = useState(0);
  const [height, setHeight] = useState<number | null>(null);

  const focusOn = session?.kind === "focus";
  const breakOn = session?.kind === "break";

  const panes: Record<PaneId, MenuItem[][]> = {
    root: [
      [
        // Without Local Chat this opens Settings → Chat, where it can be added.
        { label: "Chat with MewMuze", icon: "chat", cmd: "chat" },
        { label: "My Day", icon: "sun", cmd: "my-day" },
      ],
      [
        { label: "Focus", icon: "target", sub: "focus", on: focusOn || breakOn },
        { label: "Reminders", icon: "clock", sub: "reminders" },
      ],
      [
        { label: workMode ? "Leave Work Mode" : "Work Mode", icon: "bolt", cmd: "work-mode", on: workMode },
        { label: "Quick Tools", icon: "grid", sub: "tools" },
      ],
      [
        { label: "Play", icon: "play", sub: "play" },
        { label: "Photo Mode", icon: "camera", cmd: "photo-mode" },
      ],
      [{ label: "Appearance", icon: "palette", sub: "look" }],
      [
        { label: "Settings", icon: "gear", cmd: "settings" },
        { label: "Quit MewMuze", icon: "power", cmd: "quit", danger: true },
      ],
    ],
    focus: [
      [
        { label: focusOn ? "Stop focus" : "Start focusing", icon: "target", cmd: "focus-mode", on: focusOn },
        { label: breakOn ? "End break" : "Take a break…", icon: "moon", cmd: "break", on: breakOn },
        { label: "Pomodoro timer", icon: "clock", cmd: "pomodoro-toggle" },
      ],
    ],
    reminders: [
      [
        { label: "Set a reminder…", icon: "bell", cmd: "set-reminder" },
        { label: "Add a note…", icon: "note", cmd: "add-note" },
      ],
    ],
    tools: [
      [
        { label: "Calculator & time", icon: "calc", cmd: "calc-time" },
        ...(clipboardEnabled ? [{ label: "Clipboard Assistant", icon: "clipboard" as const, cmd: "clipboard-assistant" as const }] : []),
        ...(voiceAvailable ? [{ label: "Voice recorder", icon: "mic" as const, cmd: "recorder" as const }] : []),
        { label: "Tasks", icon: "check", cmd: "tasks" },
      ],
    ],
    play: [
      [
        { label: "Pet MewMuze", icon: "heart", cmd: "pet" },
        { label: "Take a nap", icon: "moon", cmd: "sleep" },
      ],
      [
        { label: "Say hi", icon: "wave", cmd: "gesture-hi" },
        { label: "High five", icon: "paw", cmd: "gesture-high-five" },
        { label: "Tease MewMuze", icon: "bolt", cmd: "tease" },
      ],
      [{ label: "Send a butterfly", icon: "sparkle", cmd: "butterfly" }],
    ],
    look: [
      [
        { label: "Small", icon: "cat", cmd: "size-small", on: catSize === "small" },
        { label: "Medium", icon: "cat", cmd: "size-medium", on: catSize === "medium" },
        { label: "Large", icon: "cat", cmd: "size-large", on: catSize === "large" },
      ],
      [
        { label: "Calm", icon: "moon", cmd: "activity-calm", on: activityLevel === "calm" },
        { label: "Balanced", icon: "paw", cmd: "activity-balanced", on: activityLevel === "balanced" },
        { label: "Playful", icon: "sparkle", cmd: "activity-playful", on: activityLevel === "playful" },
      ],
      [{ label: "Cat & Looks…", icon: "palette", cmd: "settings:looks" }],
    ],
  };
  const groups = panes[pane];
  const flat = groups.flat();

  // Keep the menu on-screen: measured once on open. offsetWidth/Height, not
  // getBoundingClientRect: the open animation has the menu scaled down, and
  // the scaled box let the real menu hang 2 px off the edge of the screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      x: Math.max(8, Math.min(state.x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - el.offsetHeight - 8)),
    });
    ref.current?.focus();
  }, [state]);

  // The viewport follows the current pane's height, so a submenu slides in
  // without the frame jumping. Measured before paint.
  useLayoutEffect(() => {
    const h = paneRef.current?.offsetHeight ?? 0;
    if (h) setHeight(h);
  }, [pane, flat.length]);

  const openPane = (next: PaneId) => {
    setEntered(next === "root" ? "root" : "sub");
    setPane(next);
    setActive(0);
  };
  const run = (item: MenuItem) => {
    if (item.soon) return;
    if (item.sub) return openPane(item.sub);
    if (item.cmd) {
      onCommand(item.cmd);
      onClose();
    }
  };

  const onKeyDown = (e: KeyboardEvent | ReactKeyboardEvent) => {
    const n = flat.length;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % n);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + n) % n);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Enter" || e.key === " ") run(flat[active]);
    else if (e.key === "ArrowRight" && flat[active]?.sub) openPane(flat[active].sub!);
    else if ((e.key === "ArrowLeft" || e.key === "Backspace") && pane !== "root") openPane("root");
    else if (e.key === "Escape") {
      if (pane !== "root") openPane("root");
      else onClose();
    } else return;
    e.preventDefault();
  };
  // Escape and arrows also work when focus sits outside the menu (it opens
  // on a right-click in a click-through window, which may not take focus).
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!ref.current?.contains(document.activeElement)) keyRef.current(e);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  let index = -1;
  return (
    <div
      ref={ref}
      className="mm-menu cat-menu"
      role="menu"
      aria-label={pane === "root" ? "MewMuze" : PANE_TITLE[pane]}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      <div className="mm-menu-viewport" style={height ? { height } : undefined}>
        <div ref={paneRef} key={pane} className={`mm-menu-pane${entered ? ` enter-${entered}` : ""}`}>
          {pane !== "root" && (
            <div className="mm-menu-head">
              <button className="mm-icon-btn" aria-label="Back" onClick={() => openPane("root")}>
                <Icon name="chevronLeft" size={16} />
              </button>
              {PANE_TITLE[pane]}
            </div>
          )}
          {groups.map((group, g) => (
            <div key={g} role="group">
              {g > 0 && <div className="mm-menu-sep" role="separator" />}
              {group.map((item) => {
                const i = ++index;
                return (
                  <button
                    key={item.label}
                    role="menuitem"
                    tabIndex={-1}
                    data-submenu={item.sub ? "" : undefined}
                    aria-haspopup={item.sub ? "menu" : undefined}
                    aria-disabled={item.soon || undefined}
                    className={`mm-menu-item cat-menu-item${i === active ? " active" : ""}${item.on ? " on" : ""}${item.danger ? " danger" : ""}${item.soon ? " soon" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(item)}
                  >
                    <span className="mm-menu-icon">
                      <Icon name={item.icon} size={17} />
                    </span>
                    <span className="mm-menu-label">{item.label}</span>
                    {item.soon ? (
                      <span className="mm-menu-soon cat-menu-soon">Soon</span>
                    ) : item.sub ? (
                      <span className="mm-menu-hint">
                        <Icon name="chevronRight" size={14} />
                      </span>
                    ) : item.on ? (
                      <span className="mm-menu-hint">
                        <Icon name="check" size={15} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- notices ---------------------------------------------------------------
/** Notice type size, and the smallest it may step down to so a long line
 *  still fits the monitor - never below 11 px. */
const NOTICE_FONT = 13;
const NOTICE_FONT_MIN = 11;

export interface BubbleState {
  id: string;
  message: string;
  /** Show snooze in addition to dismiss (reminders). */
  snoozable: boolean;
  /** Colour cue: plain white, light-green early warning, light-red due-now. */
  variant?: "plain" | "warn" | "due";
  /** Offer a "Done" action too (scheduled reminders). */
  completable?: boolean;
  /** Paper companion card: lines under the headline, one per row. */
  lines?: string[];
  /** Paper companion card: extra buttons (Open Meeting, Open Calendar...). */
  actions?: { id: string; label: string; href?: string }[];
}

/**
 * The universal notification: the cat speaking. It ALWAYS sits above the
 * cat's head with a small consistent gap, never in front of it, and is kept
 * inside the monitor by sliding left or right (and, when a message is
 * genuinely wider than the screen, by stepping the font down to 11 px). One
 * line, always.
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
  onAction,
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
  onAction?: (action: { id: string; label: string; href?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const card = Boolean(bubble.lines?.length);
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
    let font = NOTICE_FONT;
    el.style.fontSize = `${font}px`;
    let r = el.getBoundingClientRect();
    while (r.width > avail && font > NOTICE_FONT_MIN) {
      font -= 1;
      el.style.fontSize = `${font}px`;
      r = el.getBoundingClientRect();
    }
    const x = Math.min(Math.max(catCx - r.width / 2, areaLeft + MARGIN), areaRight - MARGIN - r.width);
    const y = Math.max(MARGIN, catTop - GAP - r.height);
    setLayout({ x, y, font });
  }, [bubble.message, bubble.lines, bubble.snoozable, bubble.completable, catCx, catTop, areaLeft, areaRight]);

  return (
    <div
      ref={ref}
      // `notice-single` marks the one notice anchored directly to the cat, so
      // the mail stack can measure it and start above it instead of on top of
      // it. Purely a layout hook — it carries no styling of its own.
      className={`retro-notice notice-single ${bubble.variant ?? "plain"}${card ? " notice-card" : ""}`}
      style={
        layout
          ? { left: layout.x, top: layout.y, fontSize: layout.font }
          : { left: -9999, top: -9999 }
      }
    >
      {card ? (
        <>
          <span className="retro-msg retro-line heading">{bubble.message}</span>
          {bubble.lines!.map((line, i) => (
            <span key={i} className={`retro-msg retro-line${line.endsWith(":") ? " heading" : ""}`}>
              {line}
            </span>
          ))}
        </>
      ) : (
        <span className="retro-msg">{bubble.message}</span>
      )}
      <span className="retro-actions">
        {onAction &&
          bubble.actions?.map((a) => (
            <button key={a.id} className={`retro-btn${a.href ? " open" : ""}`} onClick={() => onAction(a)}>
              {a.label}
            </button>
          ))}
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

    // Step the type down until the widest card fits the monitor, the same
    // ladder the single notice uses. Cards never wrap, so a long
    // subject would otherwise push the whole stack past the screen edge.
    const avail = Math.max(80, areaRight - areaLeft - MARGIN * 2);
    let font = NOTICE_FONT;
    el.style.fontSize = `${font}px`;
    let r = el.getBoundingClientRect();
    while (r.width > avail && font > NOTICE_FONT_MIN) {
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
            <Icon name="mail" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {item.line}
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
 * The Focus-mode / Break timer chip. The session colour (teal for focus, a
 * green→amber-yellow→red ramp for a break) marks its dot and the progress
 * edge that fills as a break runs down. It sits above the cat's head and
 * self-ticks every 250 ms so the countdown stays live without re-rendering
 * the whole app each frame.
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
        ["--mm-session" as string]: view.color,
      }}
    >
      <span className="session-label">{title}</span>
      <span className="session-time">{view.label}</span>
      <button className="session-end" onClick={onEnd} title="End">
        <Icon name="close" size={12} />
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

  // Escape cancels, like every other surface by the cat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        <Icon name="close" size={12} />
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
/** Pomodoro phase dots, from the design system: raspberry, green, teal, grey. */
const PHASE_COLORS: Record<string, string> = {
  focus: "#c73866",
  shortBreak: "#4cc38a",
  longBreak: "#5fd3e3",
  paused: "#767c8d",
};

export function PomodoroChip({
  snapshot,
  x,
  y,
  onClose,
}: {
  snapshot: PomodoroSnapshot;
  x: number;
  y: number;
  /** Stop the timer and put the chip away. */
  onClose: () => void;
}) {
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
    <div className="pomo-chip pixel-ui" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <span className="phase-dot" style={{ background: PHASE_COLORS[snapshot.phase] ?? "#767c8d" }} />
      <span>{label}</span>
      <span>{formatTimer(snapshot.remaining)}</span>
      <button className="pomo-x" onClick={onClose} title="Stop the timer" aria-label="Stop the timer">
        <Icon name="close" size={11} />
      </button>
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
