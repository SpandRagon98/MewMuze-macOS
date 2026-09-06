# Manual testing checklist

Automated unit tests cover the state machine, mood/energy, petting detection,
drag thresholds, platform selection, collision/landing, off-screen recovery, and
settings persistence (`npm test`). The following require a real Windows desktop.

## Displays & scaling
- [ ] Single monitor at 100% scaling.
- [ ] Single monitor at 125%, 150%, and 200% scaling (cat size looks correct,
      motion feels consistent, no blur).
- [ ] Dual monitors with **different** DPI scaling; drag the cat across the seam.
- [ ] Monitors arranged non-left-to-right (e.g. stacked vertically).
- [ ] Unplug/replug a monitor while running → cat recovers to a valid position.

## Overlay & click-through
- [ ] Clicking buttons, tabs, links, and text fields in apps behind the overlay
      works everywhere except directly on the cat.
- [ ] Hovering the cat does **not** block the app behind until you actually grab.
- [ ] Overlay has no taskbar entry and never steals focus.
- [ ] Taskbar remains usable; the cat doesn't sit on top of it unprompted.

## Windows as platforms
- [ ] Cat walks along the top edge of the active window.
- [ ] Cat sits near a title-bar corner.
- [ ] Cat jumps between two nearby windows.
- [ ] Release the cat just below a title bar; it hangs with two paws, swings,
      briefly slips to one paw, then pulls itself up or loses grip.
- [ ] Release the cat beside a window edge; it clings and climbs toward the top.
- [ ] Move a window while the cat is standing, hanging, or climbing; the cat
      keeps its relative attachment without teleporting.
- [ ] Move a window the cat is standing on → it rides/falls sensibly.
- [ ] Resize a window → platform updates; cat doesn't float.
- [ ] Minimise / close the supporting window → cat falls or relocates safely.
- [ ] Verify with **Chrome, File Explorer, VS Code, and Microsoft Office**.
- [ ] Maximised vs restored windows both behave.

## Cursor interaction
- [ ] Cursor far away → cat wanders / rests, occasionally glances over.
- [ ] Cursor nearby → cat turns toward it, approaches, raises a paw.
- [ ] Fast cursor motion → cat chases and pounces, then tires after a while.
- [ ] Cat never actually moves or captures the real cursor.

## Petting & drag
- [ ] Gentle back-and-forth over the cat → sits, eyes close, subtle purr/hearts.
- [ ] A plain hover only makes it look at the cursor (no full petting).
- [ ] Press-hold-drag picks the cat up; it dangles and follows the cursor.
- [ ] Releasing mid-air drops it with a fall + landing.
- [ ] A quick click is treated as a poke, not a drag.
- [ ] Repeated grabbing makes it briefly annoyed.

## Independent behaviour
- [ ] With no interaction, the cat grooms, stretches, looks around, wanders.
- [ ] After prolonged inactivity it sleeps; it wakes when the cursor passes near.

## Art & directional animation
- [ ] Horizontal movement always uses a side profile; front/back art is never
      mirrored to fake sideways movement.
- [ ] Walk, stalk, run, and sprint show changing paw placement with no sliding.
- [ ] Front, back, side, and three-quarter silhouettes all read clearly as a cat
      at Tiny, Small, and Medium sizes.

## Tray controls
- [ ] Every menu item works: pause/resume, pet, call, sleep, chase toggle, sound
      toggle, activity level, cat size, start-with-Windows, reset, about, quit.
- [ ] Check-marks reflect current settings after changing them.
- [ ] Settings persist across a restart.

## Full-screen, lock & resume
- [ ] Full-screen video (windowed full-screen) → cat still visible.
- [ ] Exclusive full-screen game → cat hidden by OS (expected); returns after.
- [ ] Lock the workstation and resume → app is stable, cat doesn't teleport wildly.
- [ ] Put the PC to sleep and wake → app still running and responsive.

## Stability & resources
- [ ] Leave running for several hours → memory stays flat (no leak), CPU low.
- [ ] Taskbar positioned on the left / top / right edges → no misbehaviour.
