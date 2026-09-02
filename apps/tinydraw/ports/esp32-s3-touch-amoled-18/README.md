# tinydraw on esp32-s3-touch-amoled-18

Verdict: **degraded** (mode: adaptation), same interaction surface and the
same reasoning as the other two ports
([`rp2350-touch-amoled-18`](../rp2350-touch-amoled-18/README.md),
[`web`](../web/README.md)): ink+zoom+undo, not the donor's continuous camera
or ten-slot undo. This port's own `tinydraw.c` is a fresh implementation,
not a copy of theirs - see its own header comment for why.

## Why go on device.json, degraded on the port

`device.json`'s panel (368x448), buttons (BOOT + PWR with `longPressMs`) and
touch (single point) match descriptor.md's Demands cleanly: a fine enough
panel for antialiased variable-width ink, continuous touch position with a
timebase, and two distinct low-accident controls for zoom and undo. Nothing
here would justify a `refuse`.

What costs a real, stated price is this pack's memory model:

- **No framebuffer, full stop.** The panel is painted 28 rows at a time
  through `draw_band()`, called once per band, every frame, for all 16
  bands (`packs/esp32-s3-touch-amoled-18/AGENTS.md`, "THE MEMORY MODEL").
  The other two ports' incremental `gfx_push()` after each stroke segment
  has no equivalent here: this port instead replays the ENTIRE stroke
  history from stored geometry into every band, every frame. Correctness
  carries over unchanged (undo/zoom still redraw from world-space points and
  radii, never from a pixel copy); the cost is CPU, not capability, spent
  redoing full-scene rasterization sixteen times a frame that would be free
  on the sibling packs.
- **A much smaller stroke history.** `APP_ARENA_BYTES` is 8192 on this
  pack, against 65536 on the other two - this board's entire app arena is
  smaller than the sibling ports' single point array. `TD_MAX_POINTS`/
  `TD_MAX_STROKES` here (600 / 48) are correspondingly smaller than theirs
  (900 / 64), a tighter cap on the same already-bounded, already-degraded
  stroke history their own READMEs document as a cost. Both are still large
  next to what the bundled demo trace uses (13 touch samples across two
  strokes), and the cap fails the same way theirs does when hit: the
  current stroke silently stops recording, live drawing unaffected.
- **No `<math.h>`.** This pack's own comments state plainly that
  wasm32-freestanding is built with none of it available (see
  `wasm/emu_shim.c`'s "this pack's C uses no math functions at all"). The
  other two ports' `sqrtf`/`sinf`/`floorf`/`ceilf` calls are replaced here
  with small self-contained equivalents (`rt_sqrtf`'s bit-hack-seeded
  Newton-Raphson, `ifloorf`/`iceilf`, and an ease-out-QUADRATIC pressure
  curve in place of ease-out-sine, chosen because it needs neither trig nor
  a square root). None of this changes what is drawn in a way the
  invariants below could not already tolerate - see `tinydraw.c`'s own
  comment on each substitution.
- **Same drops as the other two ports, for the same reason**: no colour,
  pen size, eraser or toolbar (out of scope per descriptor.md's Demands);
  no curve fitting between touch samples; no end taper.

## What was verified

`bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts --app
apps/tinydraw/ports/esp32-s3-touch-amoled-18/tinydraw.c` compiles (the
documented intermittent `zig cc` linker crash retried twice, not a code
issue - the pack's own `AGENTS.md` and `build.ts` gotcha). `bun run
pack:esp32:gate` passes all four checks, including "no full-panel pixel
buffer exists in the firmware" - this port only ever touches one 28-row
band buffer at a time, never a whole-panel array.

Verified against `apps/tinydraw/invariants.ts`, the SAME checker and the
SAME trace (`apps/tinydraw/traces/tinydraw-demo.trace.json`) the other two
ports use - the five checks (ink drawn at all, variable width, 2x zoom
scaling, a second stroke adding ink, undo reproducing the pre-second-stroke
panel bit-for-bit) are geometric/pixel-count properties of the same drawing
algorithm and the same trace, not tied to any one pack's memory model, so no
new checker was needed. `bun run verify-bundle apps/tinydraw` passes all
three ports, including this one.
