# AGENTS.md - the device firmware

Firmware for the **Waveshare RP2350-Touch-AMOLED-1.8**, a 368x448 AMOLED in a
small plastic puck. [`README.md`](README.md) says what it is and how to flash
it. This says how it is built and what will bite you.
[`docs/decisions/`](docs/decisions/) says why.

`emu_device()` in [`wasm/emu_shim.c`](wasm/emu_shim.c) is the source of
truth for the emulator descriptor. [`device.json`](device.json) is the
comment-free documentation copy, with convention and memory metadata added,
and must match the JSON returned by `emu_device()` whenever that changes.

**One binary, three apps, a menu.** A single-binary runtime
(`firmware/runtime/`) holds an app table (`firmware/apps/`): a stopwatch
(`chrono.c`, index 0, what boots), a sketchpad (`sketch.c`) and a countdown
timer (`timer.c`). Switching apps is a function call, not a reboot: holding
BOOT and PWR together until PWR's long-press verdict fires opens a picture menu
(`menu.c`) to pick another app, and the same chord closes it again. See
[`docs/decisions/0002-runtime-architecture.md`](docs/decisions/0002-runtime-architecture.md)
for why this replaced an earlier two-flash-slot, reboot-to-switch design.

## The git history starts here, and some comments predate it

This firmware was extracted from a private monorepo, and the extraction is the
first commit. Source comments that point at a path which does not exist here
(`apps/chrono/main.c`, `firmware/main.c`, `gen-strokes.ts`, `store/`,
`vendor-baseline/`) are pointing into that monorepo, where those files were
real. They are kept because the provenance they record is true and still
useful: they say where a routine was lifted from and what it was proven
against. What they cannot do is send you to a commit, because there is no such
commit in this repository. Do not go looking, and do not "fix" the paths by
inventing files.

## The board (verify before assuming)

This is the **RP2350** variant, not the ESP32-S3 one. Waveshare sells both
under almost the same product name, in the same case, on the same page, so it
is easy to buy the wrong docs. The board this was written against reports
`RP2350 revision A2, QFN60, 16MB flash` to `picotool info`.

| Part | Chip |
|---|---|
| MCU | RP2350A, dual Cortex-M33 + dual Hazard3 RISC-V, 150 MHz, 520KB SRAM |
| Display | 1.8" AMOLED 368x448, SH8601 over QSPI |
| Touch | FT3168 over I2C |
| IMU | QMI8658 |
| PMIC | AXP2101 |
| RTC | PCF85063 |
| Audio | ES8311 codec, speaker + mic |

Pins, taken from the published schematic
(`files.waveshare.com/wiki/RP2350-Touch-AMOLED-1.8/RP2350-Touch-AMOLED-1.8.pdf`),
not inferred from the demo code, and confirmed working:

| Signal | GPIO |
|---|---|
| QSPI CS / SCLK | 9 / 10 |
| QSPI DIO0..3 | 11, 12, 13, 14 |
| Panel RST / PWR_EN | 15 / 17 |
| Panel TE (tearing effect) | 16 |
| I2C SDA / SCL | 6 / 7 |
| Touch RST / INT | 5 / 4 |
| IMU INT1 | 8 |
| AXP2101 interrupt | 2 |
| PWROK from PMIC (`SYS_OUT`) | 18 |
| Audio I2S DOUT / DIN / MCLK / LRCK / BCLK | 20 / 21 / 22 / 23 / 24 |
| Speaker amp enable | 19 |
| microSD CS / MOSI / SCK / MISO | 25 / 26 / 27 / 28 |

**LRCK (GPIO23) was missing from this table until the audio bring-up.** I2S
cannot function without a word-select line, so it has to exist somewhere; it
does, contiguous with the other four (20-24), and was found by tracing the
schematic's "Codec" block net-label to net-label
(`firmware/runtime/sound.c`'s header comment has the exact coordinates) after
the vendor sources gave no clean answer for this board. If a pin table is ever
hand-copied from a schematic again, check that every signal a chip's own
datasheet says it needs is actually accounted for, not just the ones a first
pass happened to label.

A full framebuffer is 368*448*2 = 330KB and **fits** in the 520KB SRAM, so the
firmware keeps one and pushes dirty rectangles. The ESP32-S3 sibling cannot do
this and has to render in bands; do not copy that design here.

## The buttons, which the vendor header describes wrongly

**`SYS_OUT` (GPIO18) is not a button.** The schematic shows it carrying
`PWROK` from the PMIC through a BSS138 level shifter: it is a power-good
indicator. The vendor demo's `DEV_IRQ_SET(SYS_OUT, GPIO_IRQ_LEVEL_HIGH, ...)`
handler calling `watchdog_reboot` is a power-loss path, not a key handler.
Pressing either button moves this pin not at all, which was verified across
several sessions of deliberate pressing before the schematic confirmed why.

The two side buttons, **screen facing you, buttons on the right**:

| Button | Position | Wiring | Readable at runtime |
|---|---|---|---|
| PWR | **lower** | to the AXP2101 `PWRON` pin | yes, via the PMIC |
| BOOT | upper | bootloader select | no |

So the power key belongs to the PMIC, and firmware only ever sees it second
hand: a press pulls **GPIO2** (`AXP_IRQ`) low and latches a bit in AXP2101
register `0x49`. Bits, from the datasheet and confirmed on hardware: `0x01`
release, `0x02` press, `0x04` long press, `0x08` short press. Enable them in
register `0x41` first; the two edge interrupts are disabled by default.

**Long-press gestures are safe, and that took a register write to make true.**
Register `0x27` holds three fields (AXP2101 datasheet, X-Powers Rev 0.1,
2019-04-28): `IRQLEVEL` (bits 5:4, the long-press interrupt threshold),
`OFFLEVEL` (bits 3:2, the hard power-off hold) and `ONLEVEL` (bits 1:0, how
long POK must be held to power the board on from off, unrelated to the runtime
gesture). `IRQLEVEL` stays at its 1.5s default, measured on this board at
1480ms after the press.

`OFFLEVEL` shipped at its 6s default, so a 1.5s menu gesture had only 4.5s of
margin before the rails dropped with no warning. Since that gesture is this
device's primary navigation, and the person using it is a small child who
holds buttons too long, `sensors_init()` now raises `OFFLEVEL` to its maximum,
`11b` = 10s, on every boot (`pmic_raise_poweroff_threshold()` in
`firmware/runtime/sensors.c`), reading it back and printing it once at startup
to confirm the write took. That gives the gesture 8.5s of margin instead of
4.5s.

## A finger is about 100 pixels wide, and that decides most layouts

368x448 over a 1.8 inch diagonal is a diagonal of about 580 pixels, so roughly
**322 pixels per inch, or 12.7 pixels per millimetre**.

| | across | on this panel |
|---|---|---|
| adult fingertip contact | ~8 mm | **~100 px** |
| child fingertip contact | ~6 mm | **~75 px** |

A finger therefore covers **more than a quarter of the panel's width**. This
device is a toy for a young child, so the child figure is the one that governs.

- The panel fits about **4 finger-widths across and 6 down**. That is the real
  resolution of anything that has to be touched, not 368x448.
- Three menu tiles across the 448px landscape width give each tile about
  149px, which is only about two child fingers. That is usable, and much
  closer to the limit than the pixel count suggests.
- Anything a finger must land on precisely (a small handle, a thin control) is
  being asked for a precision the hardware cannot give. Prefer targets
  forgiving in one dimension: an angle around a large ring is forgiving, a
  20px handle is not.
- Ink is the exception, not the rule: the sketchpad draws a 5px pen from a
  contact patch 15 times wider, because the controller reports a centroid. It
  reports one for a child's finger too, so drawing works; tapping a small
  target is what does not.

## Layout

```
firmware/runtime/    runtime.c (board entry point, startup, watchdog, devlink
                     wiring, profiler), runtime_core.c (portable: arena, app
                     table, switching, frame dispatch - compiles for both the
                     board and wasm32-freestanding, see decision 0003), gfx.c
                     (framebuffer + panel push, the one place the 8-pixel row
                     rule lives), sensors.c (core1 owns i2c1: touch, IMU,
                     PMIC), tilt.c (the one orientation signal, filtered and
                     mapped once for every app - portable, compiles into
                     emu.wasm too), sound.c (ES8311 + I2S over PIO/DMA,
                     brought up on core0 before core1 launches),
                     sound_synth.c (the sounds themselves, pure math,
                     compiles into both main.uf2 and emu.wasm unmodified),
                     storage.c (the last flash sector as a key/value store,
                     board-only: the emulator stands it in from RAM)
firmware/apps/       one file per app plus shared helpers: chrono.c, sketch.c,
                     timer.c, menu.c (the picker), digits.c (seven-segment
                     numerals), shapes.c (round silhouettes built from
                     rectangles, used by menu.c's icons). None owns hardware.
firmware/apps/app_roster.inc
                     THE ONE FILE A CONSUMER OF THIS PACK REPLACES. See
                     "The app roster is the consumer's" below.
firmware/lib/        Waveshare's drivers, patched. See lib/NOTICE.md and
                     "Gotchas that bite" before re-copying any of them.
firmware/bootbtn.c   reads BOOT by borrowing the flash chip select
firmware/devlink.c   the USB command link tools/dev.ts talks to
firmware/CMakeLists.txt  what actually builds; also documents what does NOT
                     any more, and why
wasm/                builds the same firmware to WebAssembly for the emulator
                     at the repository root, plus the regression tests
tools/dev.ts         drives the board over USB: screenshot, tap, drag,
                     buttons, the menu chord, app switching
tools/invariants/    static checks over the linked image, run by the build
tools/screens.ts     regenerates the README's screenshots from the real
                     firmware
tools/demo.ts        regenerates the README's animated GIF by playing with
                     the real emulator page in a real browser (puppeteer),
                     then encoding the frames with ffmpeg
tools/*lucide*.ts    turn the Lucide SVGs into the point arrays menu.c carries
docs/decisions/      why things are the way they are
preview/             the README's images, and the palette test's screenshots
third_party/lucide/  five icons, ISC. See NOTICE.md.
```

## The app roster is the consumer's, and it is the only thing that is

`firmware/runtime/runtime_core.c` used to hardcode this pack's three apps by
exact symbol name, and `runtime_core.c` used to compare the running app
against `&g_sketchApp` to decide who drains raw touch. Both meant that a
firmware built on this board with a different set of apps could not take the
runtime as it stands: it had to fork it. One did, and the fork drifted for
weeks in both directions before anyone diffed them.

So the app layer is now declared in exactly one file, which every consumer
writes for itself:

```
firmware/apps/app_roster.inc
```

`runtime_core.c` includes it, and it supplies `g_apps[]`/`g_appCount`, the
picker's own `g_menuAppIndex[]`/`g_menuAppCount` roster, `g_menuApp`,
`menu_set_return_app()` and one extern per app object. Nothing else in
`firmware/runtime/` names an app.

Included rather than compiled on purpose: a single-app build (`wasm/build.ts
--app`, `tools/build-native.ts --app`) generates one into its own build
directory and puts that directory first on the include path. No extra
translation unit, no link-order question, and `runtime_core.c` is never
touched.

**A "which app is this" test in the runtime is a bug, not a shortcut.** The
`&g_sketchApp` comparison is gone, replaced by `app_t.wantsRawTouch`
(`app.h`) alongside the `wantsShake` flag that already existed for the same
reason. If a future runtime behaviour needs to apply to some apps and not
others, it gets a flag in `app_t`. The symptom that the old shape was wrong
was not aesthetic: the runtime failed to COMPILE against a valid roster.

## Building it

Two targets, and they share no build system.

**The board.** Needs the Pico SDK 2.x, the Arm GNU Toolchain (`arm-none-eabi`),
CMake and Ninja. Nothing is assumed to be on `PATH`:

```
export PICO_SDK_PATH=/path/to/pico-sdk
export PICO_TOOLCHAIN_PATH=/path/to/arm-none-eabi

cmake -S packs/rp2350-touch-amoled-18/firmware -B packs/rp2350-touch-amoled-18/firmware/build -G Ninja
cmake --build packs/rp2350-touch-amoled-18/firmware/build
```

Writes `packs/rp2350-touch-amoled-18/firmware/build/main.uf2`. If `bun` is on `PATH`, the build's
final step runs `tools/invariants/` over the linked image and **fails the
build** on a violation (decision 0006). It is not optional in spirit: a green
build with the checker skipped proves less than it looks like it does.

Flash without touching a button, since `picotool` can reboot the board itself:

```
picotool load packs/rp2350-touch-amoled-18/firmware/build/main.uf2 -f -x
```

**WebAssembly, for the emulator at the repository root.** Compiles
`runtime_core.c`, `gfx.c`, `sound_synth.c` and every file under
`firmware/apps/` (not `runtime.c`, `sensors.c`, `bootbtn.c` or `devlink.c`,
which are the board's own entry point and hardware) plus `wasm/emu_shim.c`:

```
bun run pack:build     # from the repository root; needs zig
bun run dev              # http://127.0.0.1:5340
```

Writes the repository root's `wasm/dist/emu.wasm`, which is the single module
the emulator loads, so `pack:build && dev` shows this firmware with no
wiring step in between. `zig` comes off `PATH` unless `ZIG_EXE` says
otherwise; `wasm/build.ts`'s header explains why zig rather than emscripten or
wasi-sdk, and which of its linker flags are load-bearing.

## Reflashing without touching a button

A board running this firmware is **not** a BOOTSEL device and speaks no
PICOBOOT. It enumerates as `2E8A:0009` (`USBD_VID`/`USBD_PID` in pico-sdk's
`pico_stdio_usb/stdio_usb_descriptors.c`: `0x0009` for a non-RP2040 part,
which this firmware does not override), with three USB interfaces:

| # | Class / subclass / protocol | What it is |
|---|---|---|
| 0 | `0x02` / `0x02` / `0x00` | CDC control: the serial port `devlink` and the runtime's prints ride |
| 1 | `0x0A` / `0x00` / `0x00` | CDC data, one bulk pair |
| 2 | `0xFF` / `0x00` / `0x01` | **the USB reset interface**, no endpoints, control transfers only |

Interface 2 is pico-sdk's standard reset interface
(`pico/usb_reset_interface.h`: `RESET_INTERFACE_SUBCLASS 0x00`,
`RESET_INTERFACE_PROTOCOL 0x01`). A `RESET_REQUEST_BOOTSEL` (`0x01`)
control request to it calls `rom_reset_usb_boot_extra()` and never returns,
so the board comes back as `2E8A:000F`, an RP2350 BOOTSEL device, with both
the mass storage volume and PICOBOOT live. `wValue` is read as the bootrom's
`disable_interface_mask` in its low two bits plus an optional activity-LED
GPIO above; **zero is a valid, supported argument** and is what a host that
just wants a plain BOOTSEL sends. That is the request `picotool load -f`
makes over libusb, and since **2026-08-19** it is also what the web flasher
at puck.sylve.org makes from the browser (`site/flasher/flash.ts`, which
claims the interface, sends the setup packet `21 01 00 00 02 00 00 00`, then
waits for the BOOTSEL device to appear).

`firmware/CMakeLists.txt` **pins** this on rather than adding it: SDK 2.3.0
already defaults every relevant `PICO_ENABLE_USB_RESET_*` /
`PICO_USB_RESET_*` knob to on for an application that does not drive TinyUSB
itself, so setting them changed literally one byte of the built image (the
build date). A default is not a contract, and the way this would break is
not a build failure but a web page that silently stops being able to flash,
on somebody else's machine. Both the SDK 2.3.0 spellings and the pre-2.3.0
`PICO_STDIO_USB_*` ones are set, since which pair a checkout reads depends
on its SDK version.

**The web flasher depends on this, so firmware older than 2026-08-19 needs
the button ritual once.** An image without interface 2 cannot be rebooted
from a browser at all, and the flasher says exactly that rather than
failing as a generic USB error. The ritual below is the recovery path now,
not the entry path.

The Microsoft OS 2.0 descriptor (`PICO_USB_RESET_SUPPORT_MS_OS_20_DESCRIPTOR`,
naming interface 2, and the `bcdUSB 0x0210` it forces) is load-bearing on
Windows and only on Windows: without it the interface is driverless and
therefore invisible to WebUSB there, while Linux and macOS would not
notice. Do not drop it as "descriptor bloat".

## Gate

This pack has no `gate/` directory. Its equivalent, per
[`docs/convention/device-pack.md`](../../docs/convention/device-pack.md)'s
"or an equivalent set of fast checks," is [`tools/invariants/`](tools/invariants/):
a static reachability and register-write checker over the linked native
image (decision 0006), wired into the board build itself rather than run
as a separate step. `cmake --build` runs it as the build's final action
and **fails the build** on a violation whenever `bun` is on `PATH`; it is
not optional in spirit, the same way `gate/` is not optional for the esp32
and web packs. See "Building it" above for exactly where it runs, and
`tools/invariants/README.md` for what each rule checks and why.

**This is not yet a `bun run pack:esp32:gate`-style standalone command**,
so `tools/pack-lint.ts` cannot invoke it directly the way it could a real
`gate/`; naming it here is what lets `pack:lint` accept it as the
convention's named equivalent rather than reporting a false gap. A
follow-up that gives it its own `bun run` entry point, independent of a
full native build, would let it satisfy the letter of `gate/` as well as
its spirit.

## Gotchas that bite

- **`zig cc` intermittently exits non-zero with no diagnostic text.**
  `wasm32-freestanding` links here exit 5 with empty stderr under this many
  `-Wl,--export=` flags, worse under concurrent build load. Measured (see
  AGENTS.md's own toolchain note and `tools/zigSpawn.ts`'s header comment):
  it is mostly not zig's own linker crashing but this repository's own
  build scripts previously spawning it with inherited stdio while a
  parent process's stdout was itself a drained pipe, which can make a
  child that never got to run at all look identical to a real compiler
  crash. `wasm/build.ts` now goes through that shared helper, which pipes
  the child's stdio and trusts the artifact on disk over the exit code -
  it is still not your change and there is nothing to debug, `bun run
  pack:build` just retries automatically now. `wasm/build.ts`'s header
  records the same flakiness for `-Wl,--export-dynamic`, which is why it
  is not used.
- **The firmware carries a patch to `AMOLED_1IN8_DisplayWindows`.** Upstream's
  DMA loop is `for (i = Ystart; i < Yend - 1; i++)`, which sends one row fewer
  than the window `SetWindows` just declared to the panel (it programs `Yend-1`
  as the inclusive last row), so the bottom row of every partial refresh
  silently never updated. The same file's `Display()`/`Clear()` use the correct
  bound, which is what makes it a bug rather than a convention. It is fixed
  here to `i < Yend`. **Re-copying the driver from the Waveshare zip loses
  this**, and partial updates start dropping their last row again.
- **Boot delays are patched down from 775ms to 182ms, against the SH8601
  datasheet**, which matters because the panel init sits on the startup path.
  Upstream waits 50ms for a reset pulse specified at 10 MICROseconds (tRW), and
  300ms for a reset completion specified at 5ms (tSRT), plus two unexplained
  100ms waits in `DEV_Module_Init`. **In the other direction it was UNDER
  spec**: the datasheet requires 150ms after Sleep Out (`11h`) and upstream
  waited 120ms, which is raised here. Do not "optimise" that 150ms away; it is
  the one delay the panel actually demands, and being short shows up as an
  unreliable wake rather than as an obvious failure.
- **Every pushed window's row length must be a multiple of 8 pixels (16
  bytes)**, or `AMOLED_1IN8_DisplayWindows` corrupts the transfer. This lives
  in one place, `gfx_push()` in `firmware/runtime/gfx.c`
  (`PUSH_GRAN_W`/`PUSH_MIN_W`, both 8): it rounds every window's row length up
  to a multiple of 8 and, when that would run the window off the right edge,
  slides it left rather than clipping the width, because a shortened row is
  exactly what corrupts. The window's *start* is aligned only to 2. An earlier
  fix forced a 64-pixel minimum width; that was superseded once the real rule
  was isolated. If you ever see a 64-pixel-minimum version of this function
  again, it has regressed. The full bisect is decision 0001.
- **Judge display bugs by window shape, not by what the drawing code did.**
  The above was mistaken twice for a touch problem, and two real but unrelated
  bugs were fixed chasing it. What broke it open was that the artefact tracked
  stroke *direction*: the horizontal bottom of a U was clean while both
  vertical sides were shredded, in the same stroke, from the same code. Touch
  sampling has no reason to care about direction. Window aspect ratio does.
- **Always confirm an artefact offline before flashing it.** `picotool info -a
  <file>` should report an image def and family `rp2350-arm-s`. Flashing an
  unverified artefact cost three physical power-cycle recoveries in one
  evening, because a board that will not boot cannot be reflashed over USB.
- **Recovering a board that will not boot.** Replugging USB does NOT reset this
  board: the PMIC holds the rails up, so a hung app keeps running, and holding
  BOOT at plug-in does nothing because BOOT is only sampled at reset. Unplug,
  hold PWR for at least **12 seconds** until the screen goes black, then hold
  BOOT while plugging the cable back in. Related: while an app is hung,
  `picotool` cannot reboot it into the bootloader either, since that request is
  serviced by the running app's USB interface. Loads appear to succeed and
  silently do nothing. Read flash back and check which build is actually there
  before concluding a fix did not work. **The web flasher's reboot-to-BOOTSEL
  is the same request through the same interface** (see "Reflashing without
  touching a button"), so it has the same blind spot: a hung board ignores it
  too, and this ritual is what is left.
- **`picotool partition create <json> <out.uf2> <bootloader.elf>` does not
  write a UF2.** Given a bootloader argument it writes a raw ELF, whatever you
  called the output file and regardless of `-t uf2`, silently. The resulting
  file starts with the ELF magic, so `picotool info` reads those bytes as a UF2
  family ID and reports something absurd. Let the build embed the table
  instead: `pico_embed_pt_in_binary()` plus `pico_set_uf2_family()`, both
  **before** `pico_add_extra_outputs()`.
- **Serial needs DTR.** Opening the CDC port without asserting DTR reads as a
  dead device, and you will conclude the firmware crashed when it is running
  fine.
- **A host without its own C compiler cannot build the SDK's tools.** On
  Windows-on-ARM64 in particular, pico-sdk cannot build `pioasm` and
  `picotool`. Use the prebuilt ones from `raspberrypi/pico-sdk-tools` and point
  cmake at them with `-Dpicotool_DIR` / `-Dpioasm_DIR`.
- **AMOLED burn-in is real.** Anything always-on needs the image to move or the
  panel to sleep. None of the three apps sit static: the stopwatch and timer
  redraw continuously while running, and the sketchpad wipes and redraws on
  erase. Power management (dim on idle, sleep on long idle) is still open, see
  decision 0002 section 10, so this has not been re-examined for the menu
  screen or an app left idle and unattended.

## Touch, IMU and PMIC: all three live on core1

Touch and the IMU were originally polled from a single main loop, deliberately
never on an interrupt: the vendor demo drives touch from a GPIO IRQ and guards
the shared `i2c1` bus with a plain `uint8_t i2c_lock` using
`while(lock); lock=1;`, which is non-atomic check-then-act on a non-`volatile`
flag, so an edge arriving in the gap lets the ISR start an I2C transaction on
top of an in-flight one. **Do not move any of this onto an interrupt.**

Polling has since moved off core0 entirely. `firmware/runtime/sensors.c`
launches core1 to own `i2c1` exclusively (touch, IMU, PMIC), because the touch
read alone measured at about 695us, roughly 98 percent of frame time, on the
old single-core loop; see decision 0002 section 3. **Once `sensors_start()`
has run, core0 must never touch `i2c1` again** - not the touch controller, not
the IMU, not the PMIC, not a debug read (see `sensors.h`'s ownership-rule
banner, enforced by convention, not the compiler). Apps and the runtime read
published signals (`sensors_touch_next()`, `sensors_key_take()`,
`sensors_erase_seq()`, `sensors_boot_down()`/`sensors_boot_clicked()`) instead
of touching chips directly; touch samples cross from core1 to core0 through a
lock-free single-producer/single-consumer ring, never a lock, since a lock held
across an I2C transaction is exactly the vendor bug above.

The controller does not tell you whether a finger is down from a stale read:
with the finger count at zero, the coordinate registers still hold the last
real touch. `sensors.c` reads the finger-count register separately from the X/Y
burst and treats the count as the authority for stroke start and end, not the
vendor driver's own `FT3168_Get_Point()` (which has this exact trap).
Coordinates are clamped downstream, both in `runtime_core.c`'s touch resolution
and again in `sketch.c`'s stroke code: they come straight from 12-bit touch
registers and the driver never validates them.

## Sound

The ES8311 codec (0x18 on `i2c1`, CE pulled to AGND on the schematic) and its
I2S link are brought up ONCE, on core0, in `sound_init()` (`runtime.c`), right
after `sensors_init()` and before `sensors_start()` hands `i2c1` to core1: the
same "everything i2c1 happens before core1 exists" shape `sensors_init()`
already uses. After that one call the sound service never touches `i2c1` again.
The codec is left unmuted at a fixed volume forever, and `sound_play()` /
`sound_stop()` are purely a DATA-PLANE change (is the I2S stream carrying the
chime or silence), never a control-plane one, so there is no cross-core signal
to design for sound at all, unlike every real sensor.

I2S is driven by PIO (the RP2350 has no I2S peripheral), on `pio1`, claimed via
`pio_claim_unused_sm()` and **never `pio0`**: the display's own QSPI PIO program
(`firmware/lib/QSPI_PIO/qspi_pio.c`) uses `pio0` state machines 0 and 1 directly
without ever calling `pio_sm_claim()`, so the SDK's claim bookkeeping for `pio0`
cannot be trusted. No MCLK is generated; the ES8311 derives its internal clock
from the bit clock instead, a documented mode, so only LRCK, BCLK and DOUT are
driven. 32kHz / 16-bit stereo was chosen because it lands exactly on a supported
ES8311 clock-coefficient row AND gives a zero-remainder PIO clock divider on
this board's 150MHz system clock; `sound.c` carries both derivations.

The chime is synthesised sample by sample (`sound_synth.c`), never stored: a
phrase of PCM at any usable quality would cost tens of KB of SRAM this device
does not have spare. The same `sound_synth_alarm_sample()` compiles into the
emulator, so what a browser plays through WebAudio is genuinely this firmware's
own synthesis. That is useful for judging the tune and useless for judging the
timbre: a laptop speaker flatters what this device's tiny one actually does.

## The sketchpad

**No pressure signal.** This FT3168 reports 0 for both its per-touch weight
(0x07) and area (0x08) registers, always, finger held hard included. There is
no press force or contact area to read from this panel; `sketch.c` derives
pressure from stroke speed instead, and that is the only option here, not a
placeholder.

**Anti-aliasing without a second buffer.** Everything on screen is neutral
grey, so the 6-bit green channel of the RGB565 framebuffer doubles as an 8-bit
ink level: read it back widened, rebuild R/G/B symmetrically on write. A
separate coverage buffer would cost another 165KB and would not fit alongside
the 330KB framebuffer in 520KB of SRAM.

Each stroke segment is drawn as a round-capped capsule with linearly varying
radius, from the distance to the segment: `coverage = clamp(r + 0.5 - d, 0, 1)`.

**Composition is MIN (darkest wins), and this is not a detail.** Consecutive
segments overlap heavily along their shared edge. Alpha blending would
re-darken that overlap on every segment, compounding until the anti-aliased
edge turns solid, which is exactly the hard, pixelated line the AA was meant to
avoid. MIN unions the shapes instead.

Pen shape follows tldraw's draw tool, implemented in C from the algorithm (no
tldraw code is present, see [`NOTICE.md`](NOTICE.md)): streamline the incoming
points, derive a simulated pressure from speed (fast is light), rate-limit
pressure changes so width does not flicker on noisy samples, then
`radius = SIZE * easeOutSine(0.5 - THINNING * (0.5 - pressure))`. Tapered at
both ends. All the constants are `#define`s at the top of `sketch.c`.

Shake detection requires several jolts inside a rolling window rather than one
big reading, because a single spike is indistinguishable from a firm tap. It is
suppressed while a finger is down, and has a cooldown so one shake cannot erase
twice. Erase is an animated wipe in 16 bands, not an instant blank.

## Driving the board headlessly

`firmware/devlink.c` is a command interpreter riding the same USB CDC port the
runtime already prints to; `tools/dev.ts` is the host side, so an agent can see
the screen and drive touch and buttons without a human. Full wire protocol in
[`tools/README-devlink.md`](tools/README-devlink.md).

```
bun packs/rp2350-touch-amoled-18/tools/dev.ts ping
bun packs/rp2350-touch-amoled-18/tools/dev.ts shot out.png
bun packs/rp2350-touch-amoled-18/tools/dev.ts tap 184 224
bun packs/rp2350-touch-amoled-18/tools/dev.ts draw 20,20 60,40 100,30 140,60
bun packs/rp2350-touch-amoled-18/tools/dev.ts chord            # the BOOT+PWR app-menu gesture
```

Port and baud default to `COM4` / `115200`; override with `DEVLINK_PORT` /
`DEVLINK_BAUD`.

**The honest gap: injected buttons cannot test the PMIC decode path.**
`KEY`/`BOOT`/`CHORD` hand the runtime the bits a real press would have
produced, as if the AXP2101 register read and write-1-to-clear had already
happened and come out clean. They prove the runtime and the app underneath a
gesture handle that bit correctly. They prove nothing about whether the AXP2101
will actually latch and deliver that bit on silicon, and the one real bug this
project has shipped in this area (several PMIC bits landing in one read and
silently breaking the old menu gesture) lived precisely in the register read
and the read-and-clear timing that injection skips. Only a human pressing the
button checks that half.

## Regression tests

`wasm/tests/` runs assertions against the real compiled firmware
(`wasm/dist/emu.wasm` at the repository root), driven through `emu_tick()` with
a synthetic clock, exactly the way decision 0003 argues a reimplementation
never could.

```
bun run pack:build
bun run packs/rp2350-touch-amoled-18/wasm/tests/repro-arena-not-zeroed.ts
```

Each file reproduces a real bug found on hardware or in the emulator, turned
into a standing check rather than a one-off script. Read the header comment at
the top of each for what it reproduces and why the assertions are shaped the
way they are. They compare framebuffer hashes and `emu_app_current()`, never
internal pointers, so a failure is something a person at the device could also
have observed.

**What the emulator can never answer, per decision 0003, and this is not a
minor caveat:** timing. The browser's clock drives the tick loop; nothing
reproduces the measured 695us I2C touch read, the ~12ms full-panel push, or
core1 existing at all. Any question of the shape "is this responsive / does
this feel laggy" is a question for the board, always, no matter how convincing
the emulator's own timing looks.

## Conventions

- **TypeScript only for everything that is not firmware.** Every tool, test and
  build script here is `.ts`, run with `bun`. No `.js`, no `.mjs`, no shell
  scripts, no Python, including for anything that looks like "just a build
  script".
- **C belongs to the firmware.** `zig` and `cmake` are binaries these scripts
  invoke, exactly like `git`; neither is a language anything here is authored
  in.
- **`firmware/lib/` is Waveshare's, patched.** Read
  [`firmware/lib/NOTICE.md`](firmware/lib/NOTICE.md) before touching it, keep
  every vendor header intact, and never re-copy a file from a fresh upstream
  download without re-applying the patches listed above.
- **A decision that cost real debugging time gets a record** in
  `docs/decisions/`, not a comment. The README says what, this file says how,
  those say why.
