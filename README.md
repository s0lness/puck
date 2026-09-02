# puck

Apps that travel between tiny computers.

An app here is not tied to one implementation: it is a descriptor (what
appears on screen, every interaction, its demands) plus recorded input
traces, checkable independently of whichever C happens to run it. A device
pack is a self-contained folder for one hardware target: real firmware,
real drivers, a `device.json` an emulator can read at runtime, with
nothing in the shared instrument naming a specific device. Porting an app
to a pack starts with a verdict against that pack's own descriptor
(`go`, `degraded`, or `refuse`, stated plainly), then an idiomatic
implementation, then proof from the shared differential harness: a
faithful port replays its traces and diffs frames pixel for pixel, an
adaptation states behavioral invariants instead and gets checked against
those.

Two ports carry the convention. [`apps/chrono/`](apps/chrono/) is proven in
both directions: a faithful, pixel-exact stopwatch on its native
[RP2350 pack](packs/rp2350-touch-amoled-18/) and, unmodified in behavior, on
an unrelated [ESP32-S3 pack](packs/esp32-s3-touch-amoled-18/).
[`apps/fluidbox/`](apps/fluidbox/) goes the other way: ported down from a
900-particle, dual-core donor to 130 particles on a single core, degraded
by its own port notes, and verified by invariants rather than pixel
identity.

The gallery at [puck.sylve.org](https://puck.sylve.org) runs every proven
combination live: the real firmware, compiled to WebAssembly, in the
browser, no install and no mockup. From the same pages, real boards flash
too: the RP2350 over WebUSB and the ESP32-S3 over Web Serial, both
bench-proven, no separate tool, no serial driver to install.

This repository has three connected surfaces.

| | |
|---|---|
| the instrument | The device-agnostic emulator and differential verifier in `src/`, `harness/` and `wasm/`. |
| the packs | Three self-contained device folders: **[`packs/rp2350-touch-amoled-18/`](packs/rp2350-touch-amoled-18/)** (the reference pack, real C for the Waveshare RP2350-Touch-AMOLED-1.8), **[`packs/esp32-s3-touch-amoled-18/`](packs/esp32-s3-touch-amoled-18/)** (the same panel, no framebuffer, 16 bands of 28 rows), and **[`packs/web/`](packs/web/)** (the browser itself, panel, buttons and accelerometer, installable per app). |
| the apps | Four portable app bundles: **[`apps/chrono/`](apps/chrono/)** (the reference bundle, a stopwatch), **[`apps/fluidbox/`](apps/fluidbox/)** (a tilt-driven particle liquid), **[`apps/tinydraw/`](apps/tinydraw/)** (a finger-drawing canvas, from an external author's own repository), and **[`apps/gameos/`](apps/gameos/)** (a handheld game-console shell). Each defines its behavior independently of one implementation. |

The concrete formats are in [`docs/convention/`](docs/convention/), and
[`registry.json`](registry.json) lists every local or externally hosted
pack and app; an agent that wants to consume a pack or app straight from
this repo (clone it, read the convention docs, no browser needed) can
start at [puck.sylve.org/llms.txt](https://puck.sylve.org/llms.txt).

![Playing with the puck: picking the sketchpad from the menu, drawing a
face, opening the colour palette and picking red, drawing again in red,
holding both side buttons to get back to the menu, running the stopwatch,
winding the timer's dial](packs/rp2350-touch-amoled-18/preview/demo.gif)

The puck is a plastic disc the size of a large coin with a 368x448 AMOLED in
it: a stopwatch, a sketchpad and a countdown timer, for a child who cannot
read yet. You pick between them by touching one of three pictures.

That recording is not a mockup and not a screen capture of a design tool. It
is this repository's firmware, compiled to WebAssembly, running in this
repository's emulator, driven by a script that presses one mouse and two
keys ([`packs/rp2350-touch-amoled-18/tools/demo.ts`](packs/rp2350-touch-amoled-18/tools/demo.ts) regenerates it). The
finger and its trail are the emulator's own touch-contact overlay; the two
side buttons are its chrome, filling as a hold approaches its threshold.
Everything else on the panel was drawn by the firmware.

**Just want it on your board?** Either open the chrono run page on
[puck.sylve.org](https://puck.sylve.org) and click "Flash over USB" (Chrome
or Edge, WebUSB, nothing to install), or download the `.uf2` from
[Releases](../../releases), hold the upper side button, plug in the USB
cable, and drag the file onto the drive that appears.
[`packs/rp2350-touch-amoled-18/README.md`](packs/rp2350-touch-amoled-18/README.md) has the four manual steps in full,
and what to do if the board ever stops responding.

**Then make the board answer for itself.** Under the flash button, "Prove it
runs" replays that port's own recorded trace on the board you just flashed,
over the same devlink link the command-line harness uses, and compares every
captured frame against the same recorded frames `bun run verify-bundle`
compares against, pixel for pixel. It shows MATCH or DIVERGE per capture
point, and you can post the result: the cards count confirmed runs instead
of a date somebody typed. Nothing about you is sent, which is also why the
count says "confirmations" and never "boards" (see
[`docs/decisions/0011`](docs/decisions/0011-attestation-is-a-run-not-a-claim.md)).

**Want to try it without buying anything?** `bun install && bun run
pack:build && bun run dev` gives you the puck in a browser page. Same
apps, same rasteriser, same app-switching logic, because it is the same C.
The one thing it can never answer is whether the real thing feels fast.

## The three apps

A stopwatch, a sketchpad and a countdown timer, chosen from a menu of three
pictures. Hold BOOT and PWR together to open it.

What each one does, how it is played and why it behaves the way it does:
**[`packs/rp2350-touch-amoled-18/firmware/apps/README.md`](packs/rp2350-touch-amoled-18/firmware/apps/README.md)**, next to
the source, one file per app.

## Packs and apps

A device pack is a self-contained hardware target an LLM can read and build
without importing emulator internals. An app bundle describes portable
behavior through `Essence`, `Interactions`, `Demands`, and replayable traces.
Porting starts with a verdict against the target pack's `device.json`, then an
idiomatic implementation, then shared-harness verification. The reference
entries are the [RP2350 AMOLED pack](packs/rp2350-touch-amoled-18/) and the
[chrono bundle](apps/chrono/). The concrete formats are in
[`docs/convention/`](docs/convention/), and [`registry.json`](registry.json)
lists local or externally hosted entries.

Two worked examples prove the convention against a second pack: chrono ported
to the [ESP32-S3 AMOLED pack](apps/chrono/ports/esp32-s3-touch-amoled-18/)
(faithful, pixel-exact), and [FluidBox](apps/fluidbox/) ported to the RP2350
pack (an adaptation, verified by invariants, degraded per its own port
notes). Both run live, alongside the reference pair, at
[puck.sylve.org](https://puck.sylve.org).

**A browser is a target device too.** [`packs/web/`](packs/web/) is a device
pack like the other two: it declares the same 368x448 panel and the same two
buttons, it vendors the RP2350 pack's app contract rather than inventing one,
and its ports go through the same verifier. Chrono's web port diffs
pixel-exact at tolerance 0 against the RP2350 module on both traces, and
FluidBox's web port is a byte-for-byte copy of the RP2350 port's source that
compiles unedited. The pack's own host build emits a standalone, installable
page per app, which is what
[puck.sylve.org/web/chrono/](https://puck.sylve.org/web/chrono/) and
[/web/fluidbox/](https://puck.sylve.org/web/fluidbox/) are: not previews of
those apps, those apps, on the device in your hand.

## The emulator

It is not specific to this device. It is built entirely from what a
firmware's `emu_device()` declares at runtime, so it will run yours too;
everything below is about that, and `packs/rp2350-touch-amoled-18/` is the worked example that
proves it carries a real firmware rather than a toy one.

## Run it

```
bun install
bun run example:build
bun run dev
```

Open `http://127.0.0.1:5340`. You should see a small device panel with an
A and a B button. Touch the panel to draw; press A to cycle ink colour or
hold it to clear; press B to toggle a border; hold both together to invert
the colours. That's the example firmware running for real, through the
same ABI your own firmware will use.

Needs [Bun](https://bun.sh) and [zig](https://ziglang.org/download/) (or
another C-to-`wasm32-freestanding` compiler; `example/build.ts` uses `zig
cc` and documents why). Set `ZIG_EXE` if it isn't at `zig` on your `PATH`.

To run the puck's own firmware instead of the example, `bun run
pack:build` (which also needs zig) and reload. That is the same command
`packs/rp2350-touch-amoled-18/README.md` gives, and it writes to the same `wasm/dist/emu.wasm`,
so there is no wiring step between the two.

To point this at your own firmware, write a build script that compiles
your C to `wasm/dist/emu.wasm` (copy `example/build.ts`, which is a real,
working reference, not a stub) and implement the ABI it needs
(`wasm/emu_abi.h`, or the readable version at `docs/abi.md`). Live reload
picks up a rebuilt module automatically, no manual browser refresh.

## What this actually guarantees, read before you trust it

**It runs your firmware's own C, compiled again, not a reimplementation.**
Application logic, layout, and redraw decisions cannot silently drift from
your real firmware, because there is one source feeding both builds.

**It does NOT run the same object code your device runs.** Your wasm build
and your real build are the same C, compiled by two different compilers,
to two different targets. A bug that depends on code generation, integer
width, float precision, or undefined-behaviour resolution differing
between the two compilers is out of reach here. See
[`docs/decisions/0002-two-compilers-not-one.md`](docs/decisions/0002-two-compilers-not-one.md)
for exactly why this distinction is real and worth stating plainly rather
than letting a reader assume more.

**Timing is never modeled, anywhere, on purpose.** The browser's clock
drives the tick loop. Nothing here reproduces bus latency, real interrupt
timing, or a second CPU core. Any question of the shape "is this
responsive" or "does this feel laggy" is a question only real hardware can
answer, always. See [`docs/requirements.md`](docs/requirements.md)'s "What
this emulator does not model."

**The emulator must never deliver an input your hardware cannot produce.**
Where the two disagree, the emulator's model changes to match the
hardware, never the reverse - see `wasm/emu_abi.h`'s header comment for the
rule and a worked example of it mattering in both directions.

## The headline feature: a differential test harness

The real question a working emulator raises is "how do I know it follows
my firmware." This repo answers it the way [Ragger](https://github.com/LedgerHQ/ragger)
(Ledger's own testing framework) does: record an input trace once, replay
it through the emulator, replay the SAME trace against real hardware over
your own transport, and diff the resulting frames.

```
bun run harness:selftest                     # proves the mechanism works, no hardware needed
bun run harness:hardware                     # the real thing, against the puck on USB
bun run harness/diff.ts trace.json --link ./myBoardLink.ts
```

Your hardware side is a small interface (`harness/types.ts`'s
`HardwareLink`: connect, disconnect, send an event, take a screenshot) you
implement against whatever transport you actually have. Nothing in
`harness/` is hardwired to one device; `harness/links/devlinkLink.ts` is
this repo's own implementation of it, over the USB-serial link in
`packs/rp2350-touch-amoled-18/`.

**It has been run against the real board, and the results are in the
docs.** The idle stopwatch screen matches pixel for pixel with zero
tolerance. A drawn stroke does not: the same trace, replayed three times,
lost half the stroke once, broke it into three pieces once, and got the
edges wrong the third time. The full account, the screenshot pacing that
was measured rather than guessed, and an honest list of what this catches
and what it cannot (it does not eliminate the two-compilers problem above,
it cannot see colour, it cannot prove any real button or fingertip reaches
the firmware, and it will not catch timing or CPU-level bugs) is in
[`docs/harness.md`](docs/harness.md).

## Layout

```
src/            the page itself: wasm loader, panel blitter, push-window
                overlay, touch-contact overlay, input recorder/replay,
                freeze bundle, console pane, puck chrome, audio bridge.
                Device-agnostic: built entirely from whatever emu_device()
                declares at runtime.
wasm/           wasm/emu_abi.h, the ABI contract every firmware in this
                ecosystem implements.
example/        a tiny, real, working example firmware (see below) and
                its build script.
harness/        the differential test harness. links/ holds the real
                HardwareLink for the puck (over the reference pack's USB
                devlink),
                inputs/ the traces it replays, fixtures/ the no-hardware
                fake the self-test uses.
docs/           docs/abi.md (the ABI as a page), docs/requirements.md,
                docs/agent-loop.md (the optional freeze/annotate layer for
                a coding agent working alongside you), docs/harness.md,
                and docs/decisions/ (the why behind the choices above).
scripts/        headless verification (puppeteer-core against a local
                Chrome install).
server.ts       the local dev server. Binds 127.0.0.1 explicitly. Also
                backs the hardware-free regression check's persistence
                (baselineStore.ts).
packs/          self-contained device packs. rp2350-touch-amoled-18/ is the
                reference, with board C, drivers, checks, USB tooling and a
                build that writes wasm/dist/emu.wasm. esp32-s3-touch-amoled-18/
                is the same panel with no framebuffer, painted in 16 bands
                of 28 rows against its ESP-IDF half. web/ is the same
                convention for the browser: a panel, two drawn buttons, a
                real accelerometer, and a build that also emits an
                installable page per app.
apps/           portable app bundles. chrono/ is the reference descriptor,
                trace set and source snapshot (a stopwatch). fluidbox/ is
                a tilt-driven particle liquid. tinydraw/ is a
                finger-drawing canvas from an external author's own
                repository. gameos/ is a handheld game-console shell that
                vendors a donor's real engine, and on its esp32 port the
                donor's real shell too.
registry.json   local paths and external URLs for packs and apps.
```

## The example firmware

`example/firmware/main.c` is one small, self-contained file: no `malloc`,
no libc, no dependency on anything outside `wasm/emu_abi.h`. It implements
enough of the ABI to be worth looking at (touch, two buttons with a
long-press verdict and a two-button chord gesture, one sensor event) and
deliberately skips the optional parts (apps, sound) to stay readable in one
sitting. Read it before writing your own; `docs/abi.md` walks through every
function it implements and links back to where.

## Debugging and iteration

- **Pause / step** a frame at a time (bottom bar).
- **Push-window overlay** (the "pushes" switch): every rectangle your
  firmware's push path actually sent gets drawn as a fading outline. A
  partial-refresh bug is a bug about window geometry, and it is invisible
  until this exists.
- **Touch-contact overlay** (the "contact" switch): shows the actual
  fingertip-sized contact disc against your layout, not a one-pixel mouse
  click, plus a fading trail. Its own switch, not the one above: one
  answers "where is the finger", the other "what geometry went out", and
  they share nothing but a canvas.
- **Simulated touch-controller defects** (report rate, dropped contact,
  stray reports), off by default, for exercising the robustness code a
  real touch controller's imperfections force your firmware to carry.
- **Record and replay**: every input call is recorded; save a trace, load
  it back, and it replays bit-for-bit deterministically, because
  `emu_tick(nowMs)` is your firmware's only clock.
- **Freeze**: a screenshot plus everything around it (device descriptor,
  recent pushes, recent input, recent console output), written to a
  predictable path a coding agent can read directly. See
  [`docs/agent-loop.md`](docs/agent-loop.md).
- **Regression check, no hardware required**: "baseline" saves your current
  input trace and the frames it produces; "check" replays that same trace
  against whatever module is loaded now (a fresh rebuild, usually) and
  shows you exactly which capture point, if any, drew something different.
  Survives a live reload (the baseline lives on disk, not in the page). It
  compares the emulator against itself, so it catches a firmware
  regression and proves nothing about real hardware or timing - see
  [`docs/harness.md`](docs/harness.md#a-regression-check-with-no-hardware).
- **Console pane**: your firmware's own `js_log`/printf-equivalent output.

## Conventions

TypeScript only for everything this repo owns; C only for the ABI header
and firmware (yours, or the example); a build toolchain like `zig` is
invoked as a binary, never authored as a language here. See
[`AGENTS.md`](AGENTS.md) for the full set of conventions and the gotchas
that bite.
