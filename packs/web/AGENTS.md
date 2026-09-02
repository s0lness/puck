# AGENTS.md - the browser as a target device

This pack's whole premise: **a smartphone and a desktop are target devices
exactly like the ESP32 or the RP2350**, and porting an app to one follows
the same convention as porting it to a chip. Not "also runs in a browser
for convenience": a browser is a device with a panel, a digitizer, two
buttons and an accelerometer, and this folder is that device's pack.

If that reads as a metaphor, the test is mechanical and already run:
`apps/chrono/ports/web/chrono.c` diffs **pixel-exact at tolerance 0**
against the RP2350 module on both of chrono's recorded traces, and
`apps/fluidbox/ports/web/fluid.c` **compiles here unedited** against the
RP2350 port's own source (it landed as a byte-for-byte copy of it, and
still differs from it only in the one block that derives the particle
count from `gfx.h`'s `PANEL_W`/`PANEL_H`, which evaluates to that file's
own 130 on either pack: see that port's README). Neither of those is
possible against a metaphor.

```
device.json         the emu_device() descriptor plus convention/memory metadata
gate/               device-agrees.ts: the three places this pack states its
                    own shape, checked against each other
runtime/            the app-facing contract: app.h and gfx.h VENDORED from
                    the RP2350 pack, gfx.c reimplemented for wasm,
                    runtime_core.c (the frame loop), sensors.h, digits.c/.h
apps/demo.c         this pack's own reference app: a bouncing square
wasm/
  build.ts          two modes, module and host - see "Building" below
  emu_shim.c        the emu_* ABI over the contract, plus the sensors.h
                    implementation and the libc pieces a freestanding wasm
                    build does not get
  shim/             stdio.h / stdlib.h / math.h stand-ins, vendored
host/               this pack's own browser host: canvas panel, ghost
                    buttons, devicemotion, PWA
gotchas.md          the web platform's earned traps
NOTICE.md           what is vendored, from where, and what is not
```

## The adopted contract

This pack does not define an app contract. It **adopts the RP2350 pack's**,
symbol for symbol: [`app.h`](runtime/app.h) (the arena, `enter`/`tick`/
`leave`, `app_frame_t`) and [`gfx.h`](runtime/gfx.h) (the framebuffer,
`gfx_fill_rect`, `gfx_push`, the landscape helpers) are the sibling's
files, vendored. An app written against
`packs/rp2350-touch-amoled-18/firmware/runtime/` compiles here with no
retargeting, and that is the point rather than a happy accident.

**Self-containment is a rule, not a preference.**
[`docs/convention/device-pack.md`](../../docs/convention/device-pack.md)
says a pack must stay usable when copied out of this repository with a
pinned puck checkout. So nothing here `#include`s or `import`s across into
`packs/rp2350-touch-amoled-18/`, and nothing in `host/` imports from
`src/`, the shared instrument - even where `src/motion.ts` and
`src/panel.ts` already solve the exact problem. Copy and attribute; see
[`NOTICE.md`](NOTICE.md) for the full list and for the two files where a
copy would have been dishonest and a rewrite was correct instead
(`gfx.c`, `sensors.h`).

`app.h`'s `app_frame_t.tilt` (`app_tilt_t`, vendored from the sibling field
for field) is the seam a tilt-reading port actually compiles against.
Neither pack has a real chip behind it here - the sibling's is a QMI8658
read through `firmware/runtime/tilt.c`'s filter, this pack's is a phone's
`devicemotion` (or a desktop drag stand-in), already low-pass filtered in
`src/motion.ts` before `wasm/emu_shim.c`'s `sensors_tilt()` ever sees it -
but both populate the exact same field, in the exact same units and axis
convention, which is what lets `apps/fluidbox/ports/web/fluid.c` compile
against this pack unedited, the rp2350 sibling's own port file save for one
panel-derived particle count that means the same thing on both.

## What is different here, stated plainly

| | RP2350 pack | this pack |
|---|---|---|
| framebuffer | 330KB `malloc` inside 520KB SRAM | a static array; no budget |
| push | QSPI DMA to an SH8601 | a recorded rectangle the host blits |
| touch | FT3168 over i2c1 | pointer events on a canvas |
| buttons | a PMIC register and a flash chip-select borrow | two on-screen ghost buttons |
| tilt/shake | a QMI8658 (tilt not wired into `app_frame_t` on hardware) | a real accelerometer, live |
| menu chord | BOOT+PWR opens an app menu | none: one app per build, the URL is the menu |
| power-off | PWR held 5s, brightness ramp, PMIC rail cut | none: a tab has no rails |
| a landscape app | held sideways, in the hand | presented quarter-turned by the host; the page rotates with the phone, so turning it would achieve nothing |

The last two are the only places this pack's `runtime_core.c` deliberately
diverges from the sibling's, and both are explained at length in
[`runtime/runtime_core.h`](runtime/runtime_core.h). Everything an app can
actually observe through `app_frame_t` is carried over line for line: the
arena and its zero-on-handout rule, the 250ms dt clamp, the first-tick dt
of 0, the touch drain and its pressed/released edges, the single
read-and-clear `sensors_key_take()` per frame, the BOOT click on the
release edge, and the shake sequence diff gated on `wantsShake`.

The 8-pixel push-width rule is kept too, even though no browser needs it.
See [`runtime/gfx.h`](runtime/gfx.h)'s vendoring note: a browser paying an
alignment it does not need costs nothing, and a browser that quietly
disagrees with the board about what a push covers costs the whole claim.

## Memory

`device.json` declares `"model": "full-framebuffer"` with the note *"a
browser has no SRAM budget; the rp2350 contract applies unchanged"*. That
is not a shrug. `APP_ARENA_BYTES` is still 64KB here and
`arena_overflow_trap()` still fires, so an app developed in a browser
cannot silently outgrow what the chip allows and discover it on silicon.
The pack that had the most room is the one that must keep the budget
honest.

## Building

```
bun run pack:web:build                       # module mode: the pack's own demo
bun run pack:web:build -- --app <file.c> [--landscape] [--shake]
bun run pack:web:host -- --app <file.c> --out <dir> [--title <name>]
bun run dev                                  # http://127.0.0.1:5340
bun run packs/web/gate/device-agrees.ts      # the pack's gate
```

**Module mode** (the default) writes the repository root's
`wasm/dist/emu.wasm`, the one module puck's own emulator loads: the same
contract every other pack's `build.ts` satisfies, which is what lets
`bun run verify-bundle`, `bun run portdiff` and the headless harness drive
a web-pack module with no special case anywhere in them.

**Host mode** (`--host`) writes a standalone, deployable directory:
`index.html`, `host.<hash>.js`, `emu.<hash>.wasm`, `sw.js`,
`manifest.webmanifest` and two icons. That directory *is* the app -
installable, and offline once installed. `site/build.ts` invokes exactly
this to produce `/web/chrono/` and `/web/fluidbox/` on the gallery.

`--app` takes the sibling pack's contract unchanged: the file defines
`void port_enter(void)` and `void port_tick(const app_frame_t *f)`, and the
build generates the `app_t` around them, with `--landscape` / `--shake`
setting the two fields that vary per port.

`zig` comes off `PATH` unless `ZIG_EXE` says otherwise. Its wasm link
segfaults intermittently under this many `-Wl,--export=` flags; `build.ts`
retries, and that is a known zig bug, not your change.

## Conventions

Same as the rest of this repository (root `AGENTS.md`): TypeScript only for
anything that is not firmware, no `.js`/`.mjs` authored by hand, no em
dashes anywhere. `zig` is a binary this pack's scripts invoke, never a
language anything here is written in.
