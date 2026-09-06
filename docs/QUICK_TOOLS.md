# Work mode (Quick Tools)

A small utility console the cat operates for you. Right-click the cat and pick
**⚡ Work mode**: lightning strikes it, and it comes out of the flash wearing
sunglasses with a laptop open, parked until you switch the mode off again.

Also in the tray menu ("Work mode"). The same menu entry toggles back out
("Exit work mode"), as does the panel's ✕.

> An earlier version put a ⚡ bolt beside the cat on hover. It was removed — it
> looked like a floating button stuck to the pet, and it had to sit outside the
> cat's hit box, which meant fiddly linger timing just so it could be clicked
> before it vanished.

## The strike transition

`ThunderStrike` (in `QuickToolsPanel.tsx`) is a pure-CSS bolt plus a radial
flash, scaled to the cat's on-screen size. Timings live in `App.tsx`:

| | |
|---|---|
| `STRIKE_TOTAL_MS` | 720 — the whole effect |
| `STRIKE_SWAP_MS` | 300 — when the cat swaps to its work pose |

The swap happens at the flash's peak so the transformation is hidden inside the
brightest frame rather than seen happening.

**Do not add a `startled` one-shot to the strike.** `startled` is in the
engine's `AIRBORNE_ANIMS`, so it launches the cat off the ground, and the
grounded work-pose override cannot take hold until it lands — measured as
several seconds of the cat sitting in sunglasses with no laptop.

The effect is `pointer-events: none` throughout, and honours
`prefers-reduced-motion` by dropping the strobe and keeping a plain fade.

## Behaviour while work mode is on

| | |
|---|---|
| Roaming | stopped — the cat is parked on its current ledge |
| Cursor chasing | suppressed, regardless of the setting |
| Animation | `quickTools` loop (front view, sunglasses + laptop), outranks every other loop |
| Placement | beside the cat, never on top of it |

The panel is positioned by `src/quicktools/panelPlacement.ts`, which tries
right, left, above, then below, taking the first side with room for the whole
panel inside the monitor's **work area** (not its full bounds — a panel under
the taskbar cannot be clicked). Placement is computed once when the panel opens
and then held, so it does not skitter about under the pointer.

If the cat is boxed into a corner with no room on any side, the panel is clamped
into the work area and `placement.clamped` is set; that is the only case where
overlap is possible.

## Conversions

### Supported

| Conversion | How |
|---|---|
| JPG/PNG → PDF | Pure Rust (`src-tauri/src/pdf_write.rs`) |
| Several images → one PDF | Same; one image per page, in the order picked |
| PDF → PNG/JPG | PDFium, at 96 / 150 / 300 DPI |

JPEGs are embedded in the PDF **byte for byte** using `/DCTDecode` — PDF speaks
JPEG natively, so there is no re-encode and no quality loss. PNGs (and any JPEG
we cannot pass through, e.g. CMYK) are decoded, composited onto white because
PDF image XObjects have no alpha, and stored `/FlateDecode`.

Pages are sized at 96 DPI, so a screenshot comes out life-size rather than
enlarged to a third of a metre across.

### Deliberately not supported

**DOC/DOCX ↔ PDF is shown as "coming soon" and is never attempted.** Doing it
properly needs either Word installed (COM automation) or a bundled office suite
of roughly 300 MB, and PDF → DOCX is poor quality however it is done. A
half-working converter is worse than an honest gap, so the panel says so.

## PDFium

`PDF → images` needs `pdfium.dll`. It is **not linked** — it is loaded at
runtime, so a missing library degrades to "PDF → images unavailable" with a
reason shown in the panel, and everything else keeps working.

Search order (`convert::pdfium_path`):

1. next to the executable — how the installed app is laid out
2. the Tauri resource directory (and its `lib/` subfolder)
3. `src-tauri/lib/` — how `tauri dev` runs

### Installing it for development and bundling

```bash
npm run fetch:pdfium
```

That downloads the prebuilt library from `bblanchon/pdfium-binaries` and puts it
at `src-tauri/lib/pdfium.dll` (about 7 MB on Windows x64). Re-run with `--force`
to update it.

> **This is a build prerequisite, not an optional extra.** `tauri.conf.json`
> declares `lib/pdfium.dll` as a bundle resource, and Tauri's build script
> validates declared resources *before* compiling — so **`cargo check`,
> `cargo build` and `npm run app:build` all fail** with
> `resource path lib\pdfium.dll doesn't exist` until the file is there.
>
> The library is not committed: it is a ~7 MB binary, and vendoring it would
> bloat the repository and pin a version that should track upstream.

`src-tauri/lib/` is gitignored for that reason.

## Adding another tool

The panel is plain React (`src/components/QuickToolsPanel.tsx`) talking to
`async` Tauri commands through `src/quicktools/convert.ts`.

Two rules worth keeping:

- **Conversions must not use App's `invokeSafe`.** Its 4 s watchdog exists to
  stop a wedged status poll from stalling the cat; a real conversion legitimately
  takes longer than that.
- **Commands must be `async`.** A synchronous `#[tauri::command]` runs on the
  main thread, which is an STA — blocking it is what deadlocked this app once
  before (see the note on `context::get_media_playing`). Do the work inside
  `tauri::async_runtime::spawn_blocking`.
