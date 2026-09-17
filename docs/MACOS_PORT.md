# MewMuze Paper for Mac — macOS port

This tree is an independent duplicate of the Windows Pro source, taken at
Windows commit `118c1612` (version 0.1.9) and verified byte-identical at the
moment of copying. The Windows tree at `D:\MewMuze\MewMuze-Pro` is the
production source and is never modified from here.

Everything below describes **this** tree only.

---

## 0. MewMuze Paper for Mac (2026-09-17)

This tree now carries **MewMuze Paper** - the full feature set of
`D:\MewMuze\MewMuze-Pro-Paper` - on top of the macOS port below. Paper's source
was copied in as-is; only the ten macOS-port files were merged (three-way,
base = Pro). Identity is Paper's, so it installs beside MewMuze Pro:

| | MewMuze Paper for Mac |
| --- | --- |
| Bundle | `MewMuze Paper.app`, id `com.spandan.pixelcat.paper`, executable `MewMuzePaper` |
| Keychain / licence namespace | `com.spandan.pixelcat.paper` |
| Update feed | `https://mewmuze.com/updates/paper/macos/latest.json` (`tauri.macos.conf.json`) |
| Update signing key | MewMuze Paper's `.keys/updater.key` (in the Paper repo, never here) |

### What Paper needed on macOS

| Paper feature | Windows | macOS (this tree) |
| --- | --- | --- |
| Local Chat runtime | llama.cpp b10894 CPU zip | llama.cpp b10894 macOS tar.gz per architecture, pinned + SHA-256; `.dylib` version links rebuilt on unpack; all layers on Metal on Apple Silicon |
| Local Voice runtime | whisper.cpp b4938 zip, downloaded | whisper.cpp publishes no macOS CLI, so CI builds b4938 (commit `371b5a7`) as one universal static binary with embedded Metal shaders (`scripts/build-whisper-macos.sh`) and ships it as an `externalBin`; only the model downloads |
| Model processes never outlive the app | Job Object | PID + executable path recorded; the next launch stops a leftover (same executable only) |
| Model priority | below normal | nice 10 |
| Memory guard / usage monitor | GlobalMemoryStatusEx, process counters | Mach VM statistics, `hw.memsize`, `kern.memorystatus_vm_pressure_level`, `proc_pid_rusage` |
| Encrypted chat memory and Diary queue | DPAPI | AES-256-GCM, random key in the login Keychain |
| Dictation "insert" | SendInput Ctrl+V | CGEvent Cmd+V; asks for Accessibility (macOS prompts once) |
| Battery / saver | GetSystemPowerStatus | IOKit power sources + Low Power Mode |
| Free disk space | GetDiskFreeSpaceEx | `statvfs` |
| Microphone | privacy consent | `NSMicrophoneUsageDescription` + `com.apple.security.device.audio-input` |
| Dictation shortcut default | Ctrl+Alt+Space | Cmd+Shift+Space (Ctrl+Option+Space is macOS's input-source switch) |
| Approximate device location | Windows Geolocation | **not yet** - the button is hidden; the city search works |

Local AI needs a newer macOS than the app: Voice needs macOS 11 (this build's
deployment target) and Chat needs macOS 13.3 (llama.cpp's own macOS build,
read from the arm64 binary). The app says so instead of failing; everything
else still runs on 10.15.

### Checking the macOS half from Windows

`cargo check --target aarch64-apple-darwin` works with three local-only aids
(none of them in the repo): `DOCS_RS=1` (skips objc2's C helper), Zig as the C
compiler for `ring` (`CC_aarch64_apple_darwin`), and a `--config` patch that
swaps cpal's CoreAudio backend for its null host (coreaudio-sys needs Apple's
SDK headers). It type-checks everything else; CI is still the only real build.

### Paper update channel (releasing a Mac update)

1. Bump the version (package.json, tauri.conf.json, Cargo.toml) and push; wait
   for the macOS workflow.
2. Download the `MewMuze-Paper-macOS-update-universal` artifact
   (`MewMuze Paper.app.tar.gz`) and the universal DMG.
3. Sign the archive with Paper's key, on the Windows machine that holds it:
   `npx tauri signer sign -f D:\MewMuze\MewMuze-Pro-Paper\.keys\updater.key -p '""' "MewMuze Paper.app.tar.gz"`
4. `node scripts/make-macos-manifest.mjs "MewMuze Paper.app.tar.gz" https://mewmuze.com/downloads/paper/macos/ "What changed"`
5. Upload the archive and DMG to that folder, and `latest.json` to
   `/updates/paper/macos/latest.json`.

The DMG is still unsigned and un-notarised (section 7): until a Developer ID
exists, macOS asks users to open it with right-click → Open.

---

## 1. Compatibility audit

Every platform-touching module, classified. "Already shared" means the code was
already written against a cross-platform API and needed nothing.

### Platform-independent (no work needed)

The whole of `src/` — the React frontend, the animation system, the behaviour
FSM, physics, mochi mesh, appearance, costume composition, Work Mode, Quick
Tools, Photo Mode, reminders, Pomodoro, Gmail/Calendar parsing, the Clipboard
Assistant's logic, the calculator/converters, settings sanitising, licensing
policy — is plain TypeScript with no platform knowledge. It is not touched by
this port and the same 481 tests cover it on both platforms.

On the Rust side, `calendar.rs`, `convert.rs` (except the library filename),
`costume.rs`, `dodo_license.rs`, `gmail.rs`, `license.rs`, `pdf_write.rs`,
`settings.rs`, `sheets.rs`, `tray.rs` and `trial.rs` carry no platform
conditionals at all.

### Windows-only, with a macOS equivalent already present before this port

| Concern | Windows | macOS |
| --- | --- | --- |
| Cursor position | `GetCursorPos` | `CGEvent::location` (top-left origin, no Accessibility permission) |
| User idle | `GetLastInputInfo` | `CGEventSourceSecondsSinceLastEventType(kCGAnyInputEventType)` |
| Keyboard activity | held-key scan | `CGEventSourceCounterForEventType(KeyDown)` — a rate, not keystrokes |
| Scroll | raw input | Quartz scroll counter (magnitude only, no direction) |
| Active window | `GetForegroundWindow` | `CGWindowListCopyWindowInfo`, front layer-0 window |
| Window enumeration | `EnumWindows` | `CGWindowListCopyWindowInfo`, own PID skipped by pid not title |
| Full-screen detection | class + monitor-rect match | frontmost layer-0 window covering a whole display |
| Microphone in use | consent-store registry keys | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` — device state, never audio |
| Clipboard | `WM_CLIPBOARDUPDATE` listener | `NSPasteboard.changeCount` poll (700 ms) |
| Open a link | `ShellExecuteW` | `open(1)` |
| Credential storage | Credential Manager | Keychain (`keyring` crate, `apple-native` feature) |
| Overlay geometry | virtual-screen metrics | union of Tauri's monitor rects |
| Spaces / always on top | `WS_EX_TOPMOST` | `set_visible_on_all_workspaces` + `set_always_on_top` |
| DPI | per-monitor-aware v2 | AppKit backing scale, nothing to call |
| Dock icon suppression | `skipTaskbar` | `LSUIElement` in `Info.plist` |
| Tray | Tauri tray | Tauri tray, appears in the menu bar |
| Launch at login | registry Run | `tauri-plugin-autostart` LaunchAgent |
| `mewmuze://` | deep-link plugin | deep-link plugin, `CFBundleURLTypes` |
| `.mewcostume` | `fileAssociations` | `fileAssociations`, `CFBundleDocumentTypes` |
| App data location | `%APPDATA%\com.spandan.pixelcat` | `~/Library/Application Support/com.spandan.pixelcat` |

### Gaps this port closed

| # | Gap | Fix |
| --- | --- | --- |
| 1 | `get_monitors` reported the work area as the **full display bounds**, so the cat walked under the menu bar and behind the Dock | Derive the visible frame from the window server's own chrome windows |
| 2 | `pdfium_path` looked for `libpdfium.so` on macOS | `.dylib` on macOS, `.so` only on Linux |
| 3 | `fetch-pdfium.mjs` downloaded `pdfium-mac-x64` and saved it as `.so` | `pdfium-mac-univ` saved as `libpdfium.dylib` |
| 4 | `bundle.resources` declared `lib/pdfium.dll` for every platform, which fails a macOS build outright | Moved into `tauri.windows.conf.json` / `tauri.macos.conf.json` |
| 5 | No `icon.icns` | Generated and added to the icon list |
| 6 | The updater pointed macOS at the **Windows** manifest | `tauri.macos.conf.json` → `/updates/macos/latest.json` |
| 7 | Photo Mode's `photo_capture_screen` was Windows-only | Quartz capture, all displays composited, Retina backing pixels |
| 8 | Three error strings said "available on Windows" inside a macOS build | Reworded |
| 9 | No macOS CI; the macOS half of the codebase was never compiled anywhere | `.github/workflows/macos.yml`, both architectures |

---

## 2. How the work area is derived (gap 1, the interesting one)

The canonical source is `NSScreen.visibleFrame`, which needs AppKit. Reaching
AppKit from here means either a new `objc2` dependency or hand-declared
`objc_msgSend` externs — and `NSRect` comes back through `objc_msgSend_stret`
on x86_64 but in registers on arm64. A hand-rolled bridge is precisely the kind
of code that works on Apple Silicon and corrupts the stack on Intel, which is
the one class of bug this project cannot test for locally.

The window server already publishes the menu bar and the Dock as ordinary
windows above layer 0, and `window_detection.rs` was reading that list anyway.
`shell_furniture()` picks out windows owned by `Dock` and `Window Server`;
`visible_frame()` subtracts each one from the edge it actually occupies, and
only when it spans at least half that edge and is thin relative to the display.

Consequences worth knowing:

- An auto-hidden Dock is a few pixels or parked off-screen, so it takes
  essentially nothing off the work area — which is the correct behaviour.
- A Dock on the left or right shortens the walkable width, not the height.
- Anything unrecognised leaves the area untouched, so the failure mode is the
  old behaviour rather than a shrinking box the cat gets trapped in.
- Reading `kCGWindowOwnerName` and bounds needs **no** Screen Recording
  permission. Only window *titles* do, and none are read.

This wants confirming on a real Mac (see the QA checklist): a Dock on each of
the three edges, auto-hide on and off, and a second display.

---

## 3. Licensing

Unchanged in architecture, deliberately. `dodo_license.rs` and `trial.rs` store
the activation record and the trial anchor through the `keyring` crate, whose
`apple-native` feature is already enabled in `Cargo.toml`. On macOS that is the
login Keychain; no licence secret is ever written to `settings.json`, on either
platform.

The bundle identifier stays `com.spandan.pixelcat` so the product identity, the
Keychain service name and the entitlement all match the Windows build. A macOS
customer activates once, exactly as on Windows.

No provider API key ships in the binary; activation goes through the same
server-side flow.

---

## 4. Update channel

Windows and macOS are kept apart on purpose:

```
Windows  https://mewmuze.com/updates/latest.json         (base config)
macOS    https://mewmuze.com/updates/macos/latest.json   (tauri.macos.conf.json)
```

The macOS manifest does not exist yet — it must be published before the macOS
updater is switched on, or macOS clients will poll a 404 forever. The signing
key pair is shared (the `pubkey` in the base config), so `.keys/updater.key`
signs both; that private key is **not** in this tree and never should be.

---

## 4a. What macOS CI has actually proved

Repository: `SpandRagon98/MewMuze-macOS` (private). Workflow:
`.github/workflows/macos.yml`. First green run: **34032514890**.

| Job | Runner | Result |
| --- | --- | --- |
| Frontend (typecheck, lint, tests, build) | macos-14 | 481 tests / 56 files pass |
| Apple Silicon (arm64) | macos-14 | clippy, 56 Rust tests, .app + .dmg |
| Intel (x86_64) | macos-15-intel | clippy, 56 Rust tests, .app + .dmg |
| Universal | macos-14 | both slices asserted, .app + .dmg |

Verified in the bundle, not assumed:

- `Contents/MacOS/MewMuze` is a 2-slice fat binary (x86_64 + arm64) in the
  universal build, and thin/correct in each single-architecture build.
- `Contents/Resources/libpdfium.dylib` carries **both** slices in every build.
  A universal app with a single-architecture PDFium would install fine and then
  fail PDF tools on half the machines.
- `Contents/Resources/icon.icns` is present.
- `Info.plist`: `LSUIElement = true`, `CFBundleIdentifier = com.spandan.pixelcat`,
  `mewmuze://` URL scheme, `.mewcostume` document type, min system 10.15.
- `codesign` reports "code object is not signed at all" — expected, see §7.

### Failures fixed to get there

Three rounds. Every one was a real defect that no Windows check could reach.

1. **`window_list_info` takes `Option<CGWindowID>`** in core-graphics 0.24, not
   a bare id. Three call sites.
2. **`CFType::downcast::<CFDictionary<CFString, CFType>>()` is not permitted.**
   core-foundation implements `ConcreteCFType` only for the untyped
   `CFDictionary<*const c_void, *const c_void>`. Added `sub_dict`, which checks
   the type id and re-wraps — the same operation without the bound, still
   rejecting anything that is not a dictionary.
3. **`CGEventSource::counter_for_event_type` and
   `seconds_since_last_event_type` do not exist.** The crate wraps
   `CGEventSource` for creating sources but binds neither counter query. Both
   are now declared against the CoreGraphics framework directly, as `mic.rs`
   already does for CoreAudio. Plain C scalars, so no arm64/x86_64
   struct-return ABI difference.
4. **Idle detection** now asks `kCGAnyInputEventType`, Quartz's own any-input
   bucket, rather than taking a minimum over five hand-picked event kinds that
   omitted drags, modifier changes and trackpad gestures.
5. **`MEDIA_WATCHER` and `OVERLAY_TITLE` were dead code on macOS** and are now
   gated on `windows`. macOS reads playback from CoreAudio and skips its own
   windows by PID rather than by title.
6. **Packaging exited non-zero after succeeding.** With a `pubkey` in the
   config and no private key, Tauri signs the updater artifact and fails —
   after writing a perfectly good `.app` and `.dmg`. CI passes
   `--config '{"bundle":{"createUpdaterArtifacts":false}}'` so a development
   build stops demanding a key that deliberately is not in this repository.

### Still only compile-verified

Green CI means the macOS code compiles, links, packages and its unit tests
pass. It says **nothing** about behaviour: no runner ever launched the app.
Every runtime claim still belongs to the checklist in §6 — in particular the
work-area derivation in §2, which is the part most likely to be wrong in a way
only a real Dock can reveal.

## 4b. Defects found by real-Mac QA

CI proved the code compiles and packages. The first install on an actual Mac
found three things it could never have caught.

### The overlay was an opaque white sheet over every app

`transparent: true` alone does nothing on macOS. Without `app.macOSPrivateApi`
the `NSWindow` keeps an opaque backing and WKWebView paints its own, so a
full-screen overlay renders as a white rectangle covering everything, with the
cat drawn on it. The page CSS was already transparent; the window was not.

Two things must agree or `tauri-build` refuses the build **in either
direction**:

- `app.macOSPrivateApi: true` in `tauri.conf.json`
- the `macos-private-api` feature on the `tauri` dependency

Both live in the SHARED config and the SHARED `[dependencies]` table, not in
the macOS-only files. A target-specific `tauri` entry does not work: the check
reads only `[dependencies]`. Both are inert on Windows, so agreeing everywhere
is simpler than being clever.

> **This uses private AppKit API.** Fine for direct download and for
> notarisation, which does not scan for it. It does rule out the Mac App Store
> for the macOS build.

### The cat was drawn behind the Dock

`set_always_on_top` maps to `NSFloatingWindowLevel` (3); the Dock is at 20.
`raise_above_dock` in `overlay.rs` now sets level 21 — above the Dock, below
the menu bar at 24, which a desktop pet must never cover. It must be called
after `set_always_on_top`, which sets the level itself.

This is the port's only Objective-C message. `setLevel:` takes an integer and
returns nothing, so it has none of the struct-return ABI difference that keeps
`NSScreen.visibleFrame` out of this codebase (see §2).

### The Dock was never detected at all

The real fault behind the symptom above. `visible_frame` required a strip to
cover **half the display edge** before counting as chrome. The menu bar does.
The Dock does not — it is centred and only as wide as its icons, so a six-icon
Dock on a 1440pt display is under a third of the width. The Dock was therefore
never recognised, the work area stayed the full display, and the cat's floor
sat underneath the Dock.

The threshold is now a tenth of the edge for the Dock and half for the menu
bar. `window_detection.rs` carries 14 unit tests for this, run on both macOS
runners: the narrow Dock that caused it, wide Dock, left and right Dock,
auto-hide, off-screen parking, a second display with its own Dock, floating
panels that must NOT count, and the collapse guards.

### Still unverified

The fixes above are compile-verified only. Whether the overlay is actually
transparent, and whether the cat actually stands on the Dock rather than
behind or under it, needs another pass on real hardware — §6.

---

## 5. What cannot be verified from Windows

This machine has no Apple hardware, no Apple SDK and no macOS toolchain. The
following are therefore **unverified** here and are the reason the CI workflow
exists:

- Everything behind `#[cfg(target_os = "macos")]`. A Windows `cargo check`
  compiles none of it, and `rustfmt` only proves it parses. This is now covered
  by macOS CI instead (§4a) — which is exactly how the six defects listed there
  were found.
- The `core-graphics` API surface used by the new code (`CGDisplay::image`,
  `CGImage::bytes_per_row/data`, `kCGWindowOwnerName`).
- Bundling, `.app` layout, `.dmg` creation, `lipo`, code signing.
- Any runtime behaviour at all.

Do not treat a green Windows check as evidence about macOS.

---

## 6. Real-Mac QA checklist

Required before this can be called production-ready. Run on **both** an Apple
Silicon and an Intel Mac, and on macOS 12 and the current release.

### Overlay and rendering
- [ ] Overlay is fully transparent; no window frame, shadow or title bar.
- [ ] No Dock icon and no app-switcher entry (`LSUIElement`).
- [ ] Cat is crisp on a Retina display — pixel art, no bilinear smear.
- [ ] Cat is crisp on a non-Retina external display attached to a Retina Mac.
- [ ] Dragging a window under the cat does not leave trails or tearing.

### Movement and boundaries
- [ ] Cat walks along the bottom of the **visible frame**, not under the Dock.
- [ ] Cat never walks under the menu bar.
- [ ] Dock on the left, then the right: walkable area narrows correctly.
- [ ] Dock auto-hide on: cat uses the full height, and does not jitter as the
      Dock shows and hides.
- [ ] Two displays with different scale factors: cat crosses between them and
      stays the right size on each.
- [ ] Display unplugged while the cat is on it: the cat returns to a valid spot.

### Interaction
- [ ] Eye and head tracking follow the pointer.
- [ ] Petting works and purring triggers.
- [ ] Mochi drag/stretch: grab, stretch, release, land.
- [ ] Cat climbs and sits on real application windows.
- [ ] Click-through: clicking anywhere except the cat reaches the app beneath.
- [ ] Right-click menu opens and every entry works.

### Spaces and full screen
- [ ] Cat follows the user across Spaces.
- [ ] A true full-screen app (a full-screen video, Keynote presenting) makes the
      cat retreat and the overlay hide completely.
- [ ] Leaving full screen returns the cat to its previous position naturally.
- [ ] Mission Control does not leave the overlay stuck visible.

### Features
- [ ] Settings panel opens, every control applies, and settings survive a quit.
- [ ] Appearance Studio: species, coat, pattern, colours, stroke, accessories.
- [ ] Costume install from a `.mewcostume` file; double-clicking one opens MewMuze.
- [ ] `mewmuze://` link opens the app.
- [ ] Clipboard Assistant: copy text, badge appears, panel actions work.
- [ ] Work Mode: strike, panel, PDF tools, spreadsheet tools.
- [ ] Calc & Time: calculator, unit converter, time zones.
- [ ] Photo Mode: preview, all nine poses, Cat Only PNG has clean alpha edges.
- [ ] Photo Mode desktop capture prompts for **Screen Recording** the first
      time, and produces a real screenshot after the permission is granted.
- [ ] Photo Mode "Copy Image" pastes into Preview/Messages.
- [ ] Photo Mode "Open folder" reveals the file in Finder.
- [ ] Reminders, Focus mode and Pomodoro fire on time.
- [ ] Gmail connector fetches with an app password.
- [ ] Calendar connector reads a private `.ics` URL.
- [ ] Music reaction: cat dances while audio plays.
- [ ] Microphone reaction: cat reacts when another app opens the mic, and macOS
      does **not** show the purple mic indicator for MewMuze itself.
- [ ] Menu-bar (tray) icon: menu opens, Settings and Quit work.
- [ ] Launch at login: enable, reboot, cat returns.

### Lifecycle and resources
- [ ] Idle CPU with the cat visible and no interaction (target: comparable to
      Windows, low single-digit %).
- [ ] Memory after an hour idle — no growth.
- [ ] Battery: no measurable drain difference when the cat is off.
- [ ] Machine sleep and wake: cat resumes without teleporting or freezing.
- [ ] Screen lock: overlay hides and returns.

### Licensing
- [ ] Fresh install: trial starts, 14-day countdown correct.
- [ ] Activate a Pro key: succeeds and the record lands in the Keychain.
- [ ] Quit and relaunch: still activated, no prompt.
- [ ] Reboot: still activated.
- [ ] Install a newer build over the top: still activated, settings intact.
- [ ] Deactivate: releases the seat.
- [ ] Uninstall (drag to Trash): no login item, no daemon left running.

---

## 7. Signing and notarisation — not done, and why

The builds this repository produces are **unsigned**. Gatekeeper will refuse
them on another Mac until the user right-clicks → Open.

To ship commercially, the following are required and none of them exist here:

| Needed | What it is |
| --- | --- |
| Apple Developer Program membership | $99/year, individual or organisation |
| `Developer ID Application` certificate | Issued from the developer portal; installed in the build machine's Keychain |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarisation |
| `APPLE_PASSWORD` | An **app-specific** password, never the account password |
| `APPLE_TEAM_ID` | The 10-character team identifier |

Hardened Runtime is already configured (`entitlements.plist`, with `allow-jit`
for WKWebView, and network-client for the connectors and the updater). Once the
credentials exist, `SIGN=1 NOTARIZE=1 ./scripts/build-macos.sh` signs, notarises
and staples; in CI they belong in repository **secrets**, never in the tree.

Nothing in this repository contains a certificate, private key, password or
App Store Connect credential, and nothing should ever be added.

---

## 8. Known macOS limitations

- **Scroll direction** is not available permission-free on macOS; the scroll
  reaction uses magnitude only, so the cat reacts to scrolling but does not look
  up versus down.
- **Held keys** are not readable without Accessibility; the typing reaction is
  driven by a keystroke *rate* instead, which drives the same detector.
- **Music detection** is "is any audio playing", not "is music playing" — a
  video call counts. macOS exposes no permission-free per-session playback API.
- **Session-lock detection** returns false; the Windows path uses a desktop
  handle test with no macOS analogue in use.
- **Clipboard** is polled at 700 ms rather than event-driven; `NSPasteboard`
  offers only `changeCount`.
- **Screen Recording** permission is required for Photo Mode's desktop capture
  (and only for that). Until granted, macOS returns the desktop picture with no
  windows in it.
