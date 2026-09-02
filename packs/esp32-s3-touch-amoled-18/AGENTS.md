# AGENTS.md - the device firmware

Firmware for the **Waveshare ESP32-S3-Touch-AMOLED-1.8**, the same 368x448
AMOLED panel and the same enclosure family as this repository's reference
pack, [`packs/rp2350-touch-amoled-18`](../rp2350-touch-amoled-18/). Different
MCU, different memory story: read this file before assuming anything here
works the way the sibling pack does.

`emu_device()` in [`wasm/emu_shim.c`](wasm/emu_shim.c) is the source of
truth for the emulator descriptor. [`device.json`](device.json) is the
comment-free documentation copy, with convention and memory metadata added,
and must match the ABI-relevant fields (`name`, `panel`, `buttons`, `touch`,
`sensors`) whenever `emu_device()` changes. `device.json` also carries
`"convention"` and `"memory"`, which are pack metadata rather than part of
the wire ABI, so they do not appear in `emu_device()`'s own JSON - the same
split the sibling pack's `device.json`/`emu_shim.c` pair uses.

## THE MEMORY MODEL: no framebuffer, and this is the whole point of the pack

The sibling RP2350 pack keeps one full 330KB framebuffer in its 520KB of
SRAM and pushes dirty rectangles out of it. This board's ESP32-S3 has 512KB
of internal SRAM and a 368x448 RGB565 frame is 322KB - it does not fit
twice, and PSRAM is not an answer either: the CPU writing pixels and the
DMA engine reading them would fight over the same external bus (see
`esp32-fluidbox/fluidbox/README.md`, section 2, "No framebuffer", in the
separate `s0lness/esp32-fluidbox` repository this pack's `main/` is adapted
from - this pack's board is the exact board that README is written
against).

So there is no framebuffer anywhere in this pack, board or emulator. The
panel is painted in **16 horizontal bands of 28 rows**, each a 20KB RGB565
buffer, double-buffered against DMA: `main/display.c` keeps two band
buffers and a counting semaphore initialised to 2, released by the panel's
transfer-done interrupt, so the CPU can be drawing band N+1 while band N is
still going out over QSPI. `firmware/runtime/app.h`'s `draw_band()` callback
is the entire contract this pack's apps write against - see that file's
header comment for exactly what a band buffer's undefined prior content
means for what `draw_band()` must do. `device.json`'s `"memory"` block
(`"model": "band"`, 16 bands of 28 rows, 20KB each, double-buffered) is
this pack's declared identity; nothing here should ever grow a persistent
framebuffer without renegotiating that block first.

## Building the wasm half

```
bun run pack:esp32:build   # from the repository root; needs zig
bun run dev                  # http://127.0.0.1:5340
```

Compiles `firmware/runtime/runtime_core.c`, `firmware/runtime/gfx_band.c`,
`firmware/apps/demo.c` and `wasm/emu_shim.c` to `wasm32-freestanding` and
writes the repository root's `wasm/dist/emu.wasm` - the one module the
emulator loads, so `pack:esp32:build && dev` shows this firmware with no
wiring step in between. `zig` comes off `PATH` unless `ZIG_EXE` says
otherwise. `wasm/build.ts`'s header explains why this pack needs no
`shim/` directory at all (unlike the sibling pack): its portable sources
include nothing beyond `app.h`, `gfx_band.h`, `runtime_core.h` and
`emu_abi.h` - no vendor display headers, no libc.

`zig cc` intermittently exits non-zero (exit 5, no diagnostic text) for
the same reason the sibling pack's does - not, per the measurement behind
`tools/zigSpawn.ts` (see AGENTS.md's own toolchain note and its header
comment), a linker bug under many `-Wl,--export=` flags, but this
project's own build scripts spawning it with inherited stdio while a
parent process's stdout was itself a drained pipe: the artifact on disk
is often complete and correct even when the exit code says otherwise.
`build.ts` retries through that shared helper automatically; this is not
your change.

## `main/` has been built, flashed and run

Everything under `firmware/main/` targets ESP-IDF **v6.0.2** and was first
built, flashed and run on the physical board on 2026-08-19. Read
[`docs/decisions/0001-what-the-first-flash-found.md`](docs/decisions/0001-what-the-first-flash-found.md)
before touching any of it: the careful inheritance this half shipped with did
not link, and the three defects that first flash found say more about what an
unflashed firmware half is worth than any summary here can.

What is proven on silicon: the panel comes up, the band DMA pipeline runs at
50 full-panel frames per second paced by its own semaphore, the IMU reports
sane numbers, devlink answers on the board's USB Serial/JTAG port, and both
this pack's reference app and the chrono port match the emulator
pixel-for-pixel at tolerance zero through the differential harness. What is
**not** proven: a real finger on the glass (devlink injection enters the
runtime where `touch_poll()`'s result would, so it exercises everything
downstream of the controller and nothing upstream of it), a real PWR or BOOT
press, and the shake threshold. `README.md`'s first table is the honest version
of that list.

File by file, and what changed on first contact:

- `display.c` was adapted nearly verbatim from
  `esp32-fluidbox/fluidbox/main/display.c` (separate repository,
  `s0lness/esp32-fluidbox`, same board): the init command sequence, the QSPI
  pin map, the counting-semaphore band pipeline and the board-revision probe
  are all fluidbox's. Bringing it up added the TCA9554 panel power-cycle it
  was missing, dropped the requested QSPI clock from 80MHz to the ~40MHz the
  wire actually carries, re-issued TEON after `disp_on`, and added devlink's
  greyscale capture at flush time. See its header comment and `gotchas.md`.
- `button.c` is adapted from `esp32-fluidbox/fluidbox/main/button.c` -
  same TCA9554 IO expander, same EXIO4 pin, same "leave every other pin's
  config alone" caution. Extended with the long-press verdict timing
  fluidbox's plain short-press reset never needed, since `device.json`
  declares `longPressMs` for `pwr`. Unchanged by the first flash.
- `imu.c`'s bring-up (address probe, reset, range/ODR configuration) is
  adapted from `esp32-fluidbox/fluidbox/main/imu.c` - same QMI8658, same
  board, and it came up first time. The shake DETECTOR on top of it is new to
  this pack and **cannot be tuned by anything automated**: `imu_poll()` now
  reports the peak gravity-removed magnitude of each second to the console so
  a human holding the board can read the number the threshold should be set
  against. See `gotchas.md`.
- `touch.c`'s CST820 branch was **replaced**, not fixed: it now drives the
  controller through Espressif's `esp_lcd_touch_cst816s` component, the way
  tinydraw's `esp32/main/physical_touch.cpp` does on this exact enclosure,
  rather than through the commonly-published register map this pack shipped
  with and nothing had ever confirmed. The FT3168 branch (original-revision
  boards) is untouched and still inherited from the RP2350 sibling pack.
- `main.c` is a single-task main loop: resolve touch (injected or physical),
  poll PWR, BOOT and the IMU, `rtcore_tick()`, then `devlink_poll()`. That
  order is part of devlink's contract, not a style choice - see `devlink.h`.
  It also owns `runtime_core.h`'s `rt_log`/`rt_halt`, which nothing
  implemented for the board until the first link failed.
- `devlink.c`/`devlink.h` (one level up, in `firmware/`) are new: the
  agent-facing command protocol, the same one the RP2350 sibling speaks.

## Layout

```
device.json          the emu_device() descriptor plus convention/memory metadata
firmware/
  runtime/            app.h (the band contract), runtime_core.h/.c (portable
                       frame loop: arena, the one app slot, input
                       latching, the per-band dispatch, rtcore_reset() -
                       compiles for both the board and wasm32-freestanding),
                       gfx_band.h/.c (fill/fill-rect helpers that clip
                       full-screen coordinates into one band)
  apps/demo.c         the reference app: a bouncing square, proving
                       tick()/draw_band(), PWR short press, BOOT click and
                       touch drag
  devlink.c/.h        the agent-facing command protocol over USB Serial/JTAG
  main/               the ESP-IDF half - see "built, flashed and run" above
  sdkconfig.defaults  the only configuration input the board build takes
tools/build-native.ts  the ESP-IDF build plus the merged image and manifest
                       the website flashes (see the section above)
gate/run.ts          fast, hardware-free, device-specific checks
docs/decisions/      why (0001: what the first flash found; 0002: devlink)
wasm/
  build.ts            compiles the portable firmware + emu_shim.c to
                       wasm/dist/emu.wasm
  emu_shim.c           the browser side: emu_abi.h, the platform seam
                       (rt_log/rt_halt/plat_acquire_band/plat_flush_band),
                       and a shadow framebuffer that DOES NOT EXIST ON THE
                       REAL CHIP - see that file's header comment for why
                       the emulator host still needs one
gotchas.md            hardware traps, most inherited from fluidbox
```

## Building the board half, and the artifact the website flashes

`tools/build-native.ts` is the ESP-IDF side of `wasm/build.ts`: same `--app`
idea (this pack has one app SLOT, so an app build is `-DPUCK_APP_SOURCE=`
and nothing else), run through `idf.py` with the environment ESP-IDF's own
`idf_tools.py export` reports rather than a hardcoded tools path.

```
bun run packs/esp32-s3-touch-amoled-18/tools/build-native.ts \
  --id esp32-demo --out site/flash-artifacts/esp32/esp32-demo.bin \
  --manifest site/flash-artifacts/esp32/manifest.json
bun run packs/esp32-s3-touch-amoled-18/tools/build-native.ts \
  --app apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c \
  --id chrono-esp32 --out site/flash-artifacts/esp32/chrono-esp32.bin \
  --manifest site/flash-artifacts/esp32/manifest.json
```

It emits ONE merged image per app (bootloader, partition table and app in a
single file at offset 0, via `esptool merge-bin`) plus a `manifest.json` with
the chip, the flash parameters out of the build's own `flasher_args.json`, and
each image's MD5. Read that script's header for why the browser gets one
merged file rather than the three parts and their offsets. `--id` is the
website's combo id, which is how `site/build.ts` decides whether a run page
gets a flash button at all: no entry in the manifest, no button.

## What this pack does not have yet

No screenshots or animated GIF in the README (the sibling's come from
`tools/screens.ts`/`tools/demo.ts`, which this pack has no equivalent of), and
no `"apps"` array in `device.json` and therefore no menu.

Browser flashing now exists (`site/flasher/esp32.ts`, esptool-js over Web
Serial, wired into every run page whose combo has an image in the manifest),
but **nobody has run it against this board yet**: the artifacts, the manifest
parsing, the write plan and the page's own failure states are all checked, and
the serial round trip is not. Until a human clicks that button with the board
plugged in, `README.md`'s `esptool` command line is the flashing path with a
receipt behind it.

It DOES now have `docs/decisions/`, a `gate/`, and a README: a real flash is
what made all three earn their keep.

## Conventions

Same as the rest of this repository (root `AGENTS.md`): TypeScript only for
anything that is not firmware, no `.js`/`.mjs`, no em dashes anywhere,
`zig`/`cmake`/`idf.py` are binaries this pack's scripts invoke, never a
language anything here is authored in.

## Web Serial flash: bench-proven

2026-08-20: the gallery's Flash over USB on the esp32 run pages completed
against the real board on the first attempt, and the board rebooted into
the flashed demo. The esptool.py-style RTS pulse expressed in esptool-js's
reset mini-language, previously documented as reasoned but not measured,
is now measured.
