# 🐈‍⬛ MewMuze

A cute pixel-art black cat with big green eyes that lives on top of your
Windows desktop. It walks around, sits on the top edges of your windows, chases
and pounces on your cursor, can be picked up (it stretches!), petted, and does
its own little things while you work — without ever getting in your way.

Built with **Tauri v2 + React + TypeScript + Rust** (no Electron). Lightweight,
fully local, and privacy-preserving.

## Highlights

- **Five distinct breeds** — Classic, Chonk (round and stubby), Fluffy
  (long-haired with ear tufts, a neck ruff and a plume tail), Siamese (slender,
  tall-eared, with pale colour-point markings) and Kitten (tiny body, oversized
  head and eyes). These aren't recolours: each rescales the head, torso, legs,
  ears, eyes and tail, so the silhouettes read differently even in pure black.
- **Seasonal costumes** — the cat dresses itself through the year: a witch hat
  all October, a santa hat in December, a party hat for New Year, a cosy scarf
  in deep winter and a flower crown in spring. Toggleable, and every costume is
  also selectable manually alongside the sunglasses, glasses, headphones,
  bandana, watch, hat and cap.

- **Chibi redesign** — a big rounded head, huge glossy green eyes with double
  highlights, tiny smiling muzzle, and a long curved tail, rendered at 96 px
  native for a smooth, polished look at every size (Small/Medium/Large).
- **Context-aware companion** (foreground app *name* + media playback state
  only — never window titles or contents): it writes in a tiny notebook while
  you're in Word/Notepad, hammers a tiny keyboard while you type, puts on
  glasses in your code editor, reads a little book while you scroll slowly,
  and wears headphones + dances with floating notes while music plays.
- **⚡ Work mode** — right-click the cat and pick Work mode: lightning strikes
  it and it comes out of the flash in sunglasses with a tiny laptop open,
  parked and no longer wandering, while a retro panel opens *beside* it (never
  on top of it) with file conversions — images → PDF, several images → one PDF,
  and PDF → PNG/JPG at 96/150/300 DPI. Also in the tray menu. See
  [docs/QUICK_TOOLS.md](docs/QUICK_TOOLS.md).
- **Mochi dragging** — the head stays at your cursor while the soft body
  stretches, shears, and wobbles back with spring physics on release.
- **Retro notebook messages** — reminders and encouragement appear on a ruled
  notebook page with a typewriter reveal, never as system pop-ups.
- **Work-rest reminders** track *active* use (paused while you're away or in
  full-screen) and ask you to stretch along with the cat.
- **Motivation mode** — after sustained focused work the cat occasionally puts
  on its glasses, nods, and leaves you a note ("You are a rock star! ⭐").
- **Calm by default** — the cat mostly sits, watches, grooms and dozes with
  long relaxed periods (slow blinks, paw-licks, tail-wraps, the occasional
  affectionate nod, and a sheepish blush if it fumbles a landing); it only
  roams or chases when it's lively and the cursor tempts it.
- **Adaptive rendering** — the display's full rate while the cat is up and
  about, 30 FPS when it has settled or is asleep, 20 while peeking, and
  near-zero when it is hidden in the tray or behind a full-screen app.

- **Expressive eyes** that smoothly follow your cursor (movable pupils, many
  eyelid states), plus coordinated ear/tail/mouth expressions.
- **Right-click the cat** for a menu: Cat On/Off, pause, call, sleep, activity,
  size, Pomodoro, settings, quit. **Cat Off** waves goodbye, fades out, and
  parks the app in the tray (restore with tray → Cat On).
- **Elastic dragging** — the cat stretches softly in the drag direction and
  wobbles back into shape when released; drop it on a title bar to stand, just
  below one to hang by two paws, or beside an edge to cling and climb.
- **Keyboard kneading** — when you type, the cat "makes biscuits" along with
  you (only an aggregate key count is read — never which keys). Sustained fast
  typing overheats it (steam!).
- **Scroll reactions** — a little pixel paper strip unrolls as you scroll.
- **Productivity**: stretch & water reminders (with snooze), a full Pomodoro
  timer with focus/break cat behaviour, custom reminders, a pinned note, and an
  optional name it greets you with.
- **Peek mode** — during full-screen apps/presentations the cat tucks itself
  into a corner and stays quiet (auto-detected, or toggle manually).
- **Appearance options** — fur colour, eye colour, and solid/tuxedo/tabby/socks
  patterns (default: black cat, green eyes).
- **Optional AI-agent reactions** — point it at a local JSON status file and it
  thinks/types/celebrates with your coding agent. Disabled by default.

---

## Free vs. licensed

The download is the complete app with a **14-day trial of everything**. After
that the cat herself stays free forever — all her movement, window climbing,
dragging, petting and cursor play. A licence unlocks:

- all five breeds
- every costume and the seasonal outfits
- fur / eye / pattern customisation
- Pomodoro, reminders and work-rest nudges
- app-aware reactions

Licence keys are **verified offline** against a public key compiled into the
app — no account, no sign-in, no activation server, and the app still makes no
network request to check them. Paste a key into **Settings → Unlock**.

Selling, signing and releasing are documented in [`docs/RELEASING.md`](docs/RELEASING.md).

## Landing page

A deployable marketing site lives in `site/`, whose hero cat is animated by the
*actual* in-app sprite renderer (so it can never go stale like a screenshot):

```bash
npm run site:dev      # preview
npm run site:build    # → site-dist/, deploy anywhere static
```

## Quick start

> **Before the first Rust build**, fetch the PDF renderer used by Quick Tools:
>
> ```bash
> npm run fetch:pdfium
> ```
>
> `src-tauri/lib/pdfium.dll` is a declared bundle resource, so `cargo build`
> and `npm run app:build` **fail without it**. See
> [docs/QUICK_TOOLS.md](docs/QUICK_TOOLS.md).

### Prerequisites

- **Windows 10 or 11**
- **Node.js 18+**
- **Rust** (stable) — install via <https://rustup.rs>
- **Microsoft C++ Build Tools** (the "Desktop development with C++" workload) —
  required to compile the Rust/WebView2 shell.
- **WebView2 Runtime** — preinstalled on Windows 11 and current Windows 10.

### Install & run (development)

```bash
npm install
npm run app:dev      # = tauri dev  (starts Vite + compiles Rust + opens the overlay)
```

The first `tauri dev` compiles the Rust dependencies and may take a few minutes.
Subsequent runs are fast.

### Build a release installer

```bash
npm run app:build    # = tauri build  (produces an NSIS + MSI installer)
```

Installers are written to `src-tauri/target/release/bundle/`.

### Frontend-only checks (no Rust toolchain needed)

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest — behaviour, physics, interaction unit tests
npm run lint         # eslint
npm run build        # type-check + production web bundle
```

> The behaviour/physics/animation/interaction systems are pure TypeScript and
> are covered by unit tests that run without any Tauri runtime.

---

## How it works

### Overlay

A single transparent, borderless, always-on-top window covers the entire virtual
desktop (all monitors). It has no title bar, no frame, and no taskbar entry.
Everything except the cat is transparent.

**Dynamic click-through:** the window is click-through everywhere by default, so
mouse input passes straight to the apps behind it. The frontend polls the global
cursor position (~30 Hz) and, the instant the cursor is over the cat (or a drag
is in progress), it disables click-through so the cat can be grabbed/petted. As
soon as the pointer leaves the cat, click-through resumes. You can always click
buttons, tabs, and text fields in the apps underneath.

### Behaviour

The cat is driven by a small state machine that blends:

- physical state (grounded / airborne / dragging),
- cursor distance, speed, and direction,
- nearby window edges,
- time since you last interacted with it,
- **energy** (drains while running/pouncing, recovers while resting),
- **mood** (`calm` · `curious` · `playful` · `sleepy` · `annoyed`),
- **curiosity**, plus a little weighted randomness.

Cooldowns and minimum animation durations keep it from twitching between states,
so it feels natural rather than robotic.

### Windows as platforms

The Rust layer enumerates visible, non-minimised windows and reports **only their
rectangles**. The cat treats the top edge of each eligible window as a ledge it
can walk along, sit on, and hop between. Platform data refreshes about once per
second (not every frame). When a window moves, resizes, minimises, or closes, the
cat falls naturally or relocates to a safe spot.

### Project layout

```
src/                     # React + TypeScript (behaviour, rendering, interaction)
  animation/             # sprite generation, animation definitions, controller
  behaviour/             # state machine, behaviour weights, mood & energy
  physics/               # physics engine, collision, platform resolver
  interaction/           # cursor tracking, drag vs click, petting detection
  native/                # typed wrappers around the Rust commands
  settings/              # persisted settings + defaults
  components/            # Overlay + CatRenderer (the transparent canvas)
  engine/                # CatEngine — ties everything together each tick
  audio/                 # optional synthesized sounds (off by default)
  types/                 # shared domain types
  __tests__/             # unit tests
src-tauri/               # Rust
  src/overlay.rs         # transparent/always-on-top/click-through control
  src/window_detection.rs# EnumWindows + monitor + DPI geometry
  src/cursor.rs          # GetCursorPos
  src/tray.rs            # system-tray icon + menu
  src/settings.rs        # local JSON persistence
  src/main.rs            # app wiring
```

---

## System-tray menu

Right-click (or left-click) the tray icon:

- Cat Off / Cat On
- Pause / Resume cat
- Pet cat · Call cat to cursor · Put cat to sleep
- ⚡ Work mode (sunglasses, laptop, file conversions)
- Chase cursor (toggle) · Sounds (toggle)
- Activity level → Calm · Balanced · Playful
- Cat size → Tiny · Small · Medium
- Start with Windows (toggle)
- Reset cat position
- About · Quit

Settings persist to a small JSON file in your app-config directory.

---

## Privacy & safety

This app is designed to be trustworthy background software:

- **Works entirely locally** — it makes **no network requests** and has **no
  analytics**.
- **No screen capture** — it never reads, records, or analyses the contents of
  your screen or any window.
- **No keylogging.** The typing reaction reads only the **number of keys
  currently held down** (an aggregate count via `GetAsyncKeyState` high bits).
  Key identities never leave that function; no text or key values are ever
  stored, logged, or transmitted.
- **Scroll reactions** read only the signed mouse-wheel delta (a low-level
  mouse hook accumulates one integer). No cursor path, window, or page content
  is touched.
- **No cursor history.** The cursor position is sampled to make the cat react,
  and immediately discarded.
- **Peek mode** compares the foreground window's rectangle to its monitor —
  geometry only (plus the window class name, to exclude the desktop shell).
- **Window titles are used only to filter** which windows count as platforms
  (e.g. skipping tool windows and its own overlay). Titles are never stored,
  logged, or transmitted — only window positions and sizes are used.
- **AI-agent integration is off by default** and only ever reads the single
  small `.json` file whose path you explicitly enter in settings.
- Persisted settings contain only your preferences (including your optional
  display name, stored locally) and the cat's last safe position — never
  anything about which apps you open.

### Native permissions & Windows APIs used

All are read-only geometry/input queries:

| Purpose | Windows API |
| --- | --- |
| Overlay click-through / always-on-top | `SetWindowLong` via Tauri `set_ignore_cursor_events`; window flags (layered, transparent, no-activate, tool-window, skip-taskbar) |
| Overlay sizing across monitors | `GetSystemMetrics(SM_*VIRTUALSCREEN)` |
| Cursor tracking | `GetCursorPos` |
| Windows as platforms | `EnumWindows`, `IsWindowVisible`, `IsIconic`, `GetWindowLongW`, `GetWindowTextW` (filter only), `DwmGetWindowAttribute` (cloaked + extended frame bounds), `GetWindowRect` |
| Monitors & DPI | `EnumDisplayMonitors`, `GetMonitorInfoW`, `GetDpiForMonitor`, `SetProcessDpiAwarenessContext` |
| Typing activity (count only) | `GetAsyncKeyState` (aggregate pressed-key count; identities discarded in place) |
| App-context reactions (name only) | `GetForegroundWindow`, `GetWindowThreadProcessId`, `QueryFullProcessImageNameW` (exe basename only; path discarded) |
| Music reactions (state only) | `GlobalSystemMediaTransportControlsSessionManager` (boolean playback status; no track metadata read) |
| Scroll reactions (delta only) | `SetWindowsHookExW(WH_MOUSE_LL)` accumulating wheel deltas into one atomic integer |
| Peek-mode full-screen detection | `GetForegroundWindow`, `GetWindowRect`, `GetClassNameW` (shell exclusion), `MonitorFromWindow`, `GetMonitorInfoW` |
| Single instance / autostart | `tauri-plugin-single-instance`, `tauri-plugin-autostart` |

---

## Performance

- Animation/physics run at ~30 FPS (60 FPS only while dragging, ~14 FPS while
  the cat sleeps).
- Window/monitor scanning runs at ~1 Hz, far below the render rate.
- Sprites are cached per unique frame; nothing is re-rasterised each tick.
- Release binaries are size-optimised (`opt-level="s"`, LTO, stripped).

---

## Known limitations (Windows-first, documented honestly)

- **Rectangular hit-testing.** Interaction is enabled over the cat's bounding box
  (driven by the global cursor), not per-pixel. This is the reliable approach on
  Windows and avoids fighting the compositor.
- **Title-bar height is approximated** by the window's top edge (per spec §10);
  the cat walks along the very top of each window rather than a precisely
  measured caption bar.
- **Exclusive full-screen apps** (some games/video players) bypass all overlays
  at the OS level — the cat will not appear over them. It reappears when you
  leave exclusive full-screen.
- **Session lock:** rendering naturally idles while locked; a dedicated
  lock/unlock hook is a future refinement.

---

## Troubleshooting

- **`tauri dev` fails to compile Rust** → ensure Rust (rustup) and the MSVC C++
  Build Tools are installed; restart the terminal after installing.
- **A blank/white overlay or nothing appears** → confirm the WebView2 Runtime is
  installed; check the dev console for errors.
- **The cat blocks clicks** → this should never persist; if it does, the global
  cursor poll may be failing. Check that `get_cursor_position` is registered and
  that no error is logged, then use tray → *Reset cat position*.
- **Cat off-screen after unplugging a monitor** → it auto-recovers to the primary
  monitor within a few seconds, or use tray → *Reset cat position*.
- **"Start with Windows" doesn't stick** → some machines restrict startup entries
  via policy; toggle it again after launching once normally.

---

## Pixel-art system

The cat is drawn procedurally in `src/animation/spriteLoader.ts` using crisp
integer pixels and nearest-neighbour scaling. Side, front, back, and
three-quarter views have independent silhouettes; mirroring is used only for
left/right side profiles. The pose gallery at `preview.html` shows the gait,
interaction, hanging, climbing, grooming, sleeping, and directional frames.

---

## Manual testing checklist

See [`docs/MANUAL_TESTING.md`](docs/MANUAL_TESTING.md).
