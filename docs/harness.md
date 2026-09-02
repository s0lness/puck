# The differential test harness

This answers the question a working emulator raises immediately: how do
you know the emulator actually follows your firmware, rather than quietly
drifting from it? The pattern is [Ragger's](https://github.com/LedgerHQ/ragger)
- Ledger's pytest framework for their hardware wallet apps, which runs
the same navigation script against their Speculos emulator and two real
hardware transports, diffing a screenshot at each step against a checked-in
golden image. Adapted here to a general ABI instead of one company's SDK:

1. **record an input trace once** - the live page's "save" button writes
   the same `Trace` shape `src/recorder.ts` produces, or build one by hand
   (see `harness/selftest.ts` for a worked minimal example)
2. **replay it through the emulator**, capturing the framebuffer at
   defined points (`harness/emulatorSide.ts`)
3. **replay the SAME trace against real hardware**, over YOUR OWN
   transport, capturing its screen at the same points
   (`harness/hardwareSide.ts`)
4. **diff them**, and report where and when they diverge
   (`harness/diff.ts`, `harness/compare.ts`)

## The three marks

Every proof this document describes lands on one of three marks, and it
matters which, because each catches a different class of bug and none of
them subsumes another:

| mark | runs the firmware as | catches | never catches |
| --- | --- | --- | --- |
| **emulator** | wasm32-freestanding, in the browser or headless (`harness/emulatorSide.ts`) | application-logic bugs: wrong pixels, wrong state transitions, wrong layout | timing, bus load, real input-device defects, anything wasm's memory-safe-by-construction sandbox hides (see "host", below) |
| **host** | a native executable on THIS machine, with `-fsanitize=undefined` (and `address` where it links) - `harness/hostSide.ts` | the COMPILER CLASS of defect wasm hides entirely: an out-of-bounds write, a signed overflow, an unaligned access - anything that corrupts memory on real hardware but is unreachable inside wasm's own sandboxed linear memory | timing, bus load, real input-device defects, floating-point rounding differences between this machine's own libm/FPU codegen and either wasm's or the real target's (a `DIVERGE` on a float-heavy app like `apps/fluidbox` may be exactly this, not a real bug - report the pixel counts honestly, per `bun run hostdiff`'s own output, rather than raising `--tolerance` to make it disappear), and - like the emulator mark - whether the wasm/host builds agree with the SHIPPED cross-compiled binary in every codegen and integer-width detail (`docs/decisions/0002-two-compilers-not-one.md`, extended by one more compiler) |
| **silicon** | the real board, over your own transport (`harness/hardwareSide.ts`, `harness/diff.ts`) | everything the other two cannot: real timing, real bus load, whatever the real input-device chip actually delivers, real codegen for the real target | this is the only mark with no "never catches" column - it IS the real thing, at the cost of needing real hardware, being unrepeatable byte-for-byte run to run (see "Against the real board" below), and never running on CI |

**Why a third mark, when two already exist.** The emulator mark answers "does
my application logic work". The silicon mark answers "does the real board
agree", at the cost of needing a board on a desk. Neither answers "would
this C corrupt memory on real hardware" without deploying to that hardware
and hoping a fuzzer or a user finds it - wasm32's linear memory is
sandboxed by construction, so an out-of-bounds write that would smash a
neighboring stack variable or heap block on ARM/Xtensa simply writes inside
the wasm module's own memory (or traps cleanly) and the emulator mark never
sees it. The host mark closes exactly that gap, on every commit, with no
board required: the same real C, a DIFFERENT compiler and target (the
machine this harness runs on) than either the wasm module or the shipped
firmware, instrumented to abort loudly the instant it does something C
declares undefined.

### Building and running the host mark

`harness/hostSide.ts` builds `harness/host/driver.c` (a tiny, generic
native replay driver - it knows nothing about any one device, the same
rule `src/` and the rest of `harness/` already follow) plus a pack's own
real firmware sources (the SAME sources that pack's `wasm/build.ts`
compiles - see e.g. `packs/rp2350-touch-amoled-18/wasm/host.ts`) into one
sanitized executable, then feeds it a trace over a small line protocol on
stdin and reads captured frames (raw RGB, same shape as every other mark)
back on stdout - see `harness/host/driver.c`'s own header comment for the
protocol and for the pointer-width problem a native 64-bit host raises
that wasm32 never does (`emu_fb()`/`emu_device()` truncate a pointer to
`int` for wasm's sake; a native process's own data commonly sits above
4GB, so every host-buildable pack's `emu_shim.c` carries two small,
additive, `EMU_HOST_NATIVE`-guarded accessors at full pointer width just
for this driver).

```
bun run hostdiff <app> <pack>
```

replays that app bundle's own traces through BOTH the wasm build and the
host build and diffs the frames, printing one of three outcomes per
capture point:

- **MATCH** - both builds drew the same pixels (within `--tolerance`,
  default 0)
- **DIVERGE** - they drew different pixels; reported the same way
  `harness/portdiff.ts` reports one, with the exact pixel count
- **SANITIZER** - the host build's own run aborted (non-zero exit, a
  sanitizer report on stderr) - `-fno-sanitize-recover=undefined` means
  this is always exactly ONE finding, naming one file and line, never a
  second unrelated report stomping the first. This is never treated as a
  frame diff: a divergence means both sides ran and disagreed, SANITIZER
  means the host side did not finish running at all.

A build failure (the native compile or link itself did not produce an
executable) is a fourth, distinct outcome - `hostdiff` exits `2` and
prints `BUILD_FAILED` with the compiler's own error text, never silently
skipped and never confused with a divergence or a sanitizer report.

`bun run test:host` is this mark's own negative control, the same "red
before green" this repository asks of every check
(`feedback_test_negative_control` - a fixture the host driver's own
compiler flags must catch, not just one it happens to pass): three tiny,
self-contained firmwares under `test/host/fixtures/`, none belonging to
any pack. `clean.c` must MATCH between a wasm build and a host build.
`oob.c` (a real out-of-bounds array write) and `overflow.c` (a real signed
integer overflow) must each report SANITIZER, naming their own file and
line - and, unmodified, both compile and run perfectly clean when built to
wasm, which is the entire argument for this mark existing at all.

### A real environment finding, not a hypothetical caveat

This task's own brief anticipated needing to test whether AddressSanitizer
links on Windows ARM64 via zig and fall back to UBSan alone if not. What
was actually found, on the machine this was written on (Windows 11 ARM64,
zig 0.16.0), is a real bug one level below that, in the LINK step
specifically (not the wasm32-freestanding compile path this repository's
`AGENTS.md` already documents at "roughly one run in three"): a native
COFF/PE link (`zig cc`'s own driver, or `zig build-exe`, pure Zig, no C
frontend involved; every target triple tried -
`aarch64-windows-gnu`/`-msvc`, `x86_64-windows-gnu`) crashes with an access
violation and no diagnostic text FAR more often than the documented
one-in-three - reproduced back to back with a one-line
`int main(void){return 0;}`, 12+ failures in a row at times, on a machine
that was, at the same moment, running roughly three dozen other Claude
Code processes (`Get-Process | Where claude`) - this repository's own
`AGENTS.md` states plainly that the flake rate "is far worse under
concurrent build load," and this is that statement at its worst measured
extreme, not a new failure mode. **It is not, however, permanently
broken**: retried enough times (`harness/hostSide.ts`'s own
`MAX_ATTEMPTS`, 8, matching every pack's `wasm/build.ts`, was insufficient
during the heaviest contention observed here; a one-off diagnostic run at
40 attempts got through every time it was tried), a link on this exact
machine DOES succeed - see the real proof below, run on this machine, not
assumed. This matches, and slightly corrects, an independent finding
already in this repository from unrelated work
(`apps/gameos/reference/esp32-gameos/donor-shell-comparison/hostsim/README.md`),
written on what appears to be the same class of machine and under the same
"nothing links" impression before a wider retry budget was tried there.

**`harness/hostSide.ts` ships with `MAX_ATTEMPTS = 8`**, matching every
other build script in this repository rather than over-fitting to one
session's extreme contention; a machine under similarly heavy concurrent
load may need to set a higher local retry budget (there is no env var for
this today - a real gap, not a design choice, left for whoever hits it
next). Whatever the budget, exhausting it is reported as `BUILD_FAILED`
with the compiler's own error text, never a hang, never a false MATCH,
never an unexplained crash - this is the behaviour that was actually
exercised most, across many runs, while writing this.

**The proof that actually matters ran clean on this machine**, with the
higher one-off budget: `bun run test:host` - PASS. `clean.c` built to both
wasm and a native ASan+UBSan executable and MATCHed pixel-for-pixel (64/64
identical). `oob.c`'s deliberate out-of-bounds write reported SANITIZER,
naming `test/host/fixtures/oob.c:48` exactly (zig bundles its OWN UBSan
runtime rather than LLVM's compiler-rt, found by reading a real report
instead of assumed: `thread N panic: index 69 out of bounds for type
'uint16_t[64]'`, not compiler-rt's familiar `runtime error: ...` wording -
same information, different phrasing). `overflow.c`'s deliberate signed
overflow reported SANITIZER naming `test/host/fixtures/overflow.c:44`:
`signed integer overflow: 2147483647 + 1 cannot be represented in type
'int'`. Both negative controls were caught; the positive control matched.

Against real pack firmware, also run on this machine (again with the
higher one-off budget - see above):

- `bun run hostdiff chrono rp2350-touch-amoled-18`: **PASS, 4/4 points
  matched.** `chrono-idle` at t=1008ms and `chrono-startstop` at
  t=1808/1888/2080ms all MATCH pixel-for-pixel between the wasm build and
  the native, ASan+UBSan-instrumented host build - the same real
  `chrono.c`, `digits.c`, `runtime_core.c` and `gfx.c` this pack ships,
  compiled twice by two different compilers to two different targets,
  agreeing exactly on every pixel this bundle checks.
- `bun run hostdiff fluidbox rp2350-touch-amoled-18`: **FAIL, 0/3 points
  matched** - `t=4000ms` 7,696/164,864px (4.67%), `t=4016ms`
  8,345/164,864px (5.06%), `t=9024ms` 8,142/164,864px (4.94%), max channel
  delta 255 at all three. Reported exactly, at tolerance 0, per this
  task's own instruction not to loosen it silently: `apps/fluidbox`'s port
  for this pack is a fluid simulation carrying float state across hundreds
  of ticks (566 events replayed here), and a 255-delta max says this is
  not sub-pixel rounding noise but a real divergence in the simulation's
  own trajectory - plausible and, for a chaotic iterative system, close to
  expected: wasm32's float32 codegen (V8/JSC) and this host's own (zig's
  native float32 codegen) can each be individually IEEE-754-correct at
  every single operation and still accumulate a different rounding choice
  somewhere in 566 ticks' worth of multiply-accumulates, which a fluid sim
  amplifies exactly the way chaotic systems do. This is precisely the
  bounded, honestly-reported case `docs/harness.md`'s "host" mark row
  above describes, not a bug in this harness - and not a case for raising
  `--tolerance` until it disappears.

**One real, load-bearing bug found and fixed while producing the chrono
proof above, worth keeping as its own gotcha**: `harness/host/driver.c`'s
own frame-header write originally used bare `printf()`, and
`apps/chrono/`'s real `chrono.c` also calls `printf()` directly for its
own debug logging (`"chrono: entered, stopped at 00:00:00\r\n"`). Every
pack's `emu_shim.c` defines its OWN global `int printf(const char *fmt,
...)` (a tiny format-subset logger ending in `rt_log()`/`js_log()` - see
e.g. `packs/rp2350-touch-amoled-18/wasm/emu_shim.c`'s own "printf"
section), so linking a pack's firmware together with this driver puts TWO
external definitions of the symbol `printf` into one program. Empirically
(inspected by redirecting the built executable's stdout and stderr
separately and reading both, not guessed at) the driver's OWN `printf()`
call bound to the pack's custom one (silently rerouting the FRAME header
to stderr), while `chrono.c`'s `printf()` call bound to the real host
libc (writing to real stdout) - two call sites of the identically-named
function, resolved to two different definitions by this toolchain's
linker, for reasons not fully root-caused (a COFF/PE duplicate-symbol
resolution quirk, most likely, given a hard "multiple definition" error
would have been the C-standard-compliant response and did not happen).
Switching the driver's own header write to `fprintf(stdout, ...)` (never
redefined by any pack) fixed HALF the problem; the other half -
`harness/hostSide.ts`'s `parseFrames()` treating any non-`FRAME` line as a
hard error - was the wrong fix to reach for, because firmware calling
`printf()` directly is real, legitimate behaviour this driver must run
unmodified, not something to suppress. The actual fix: `parseFrames()` now
SKIPS a stdout line that isn't a `FRAME` header instead of erroring on it,
which cannot misread a frame's own binary payload (fixed-length, consumed
in one piece the instant its header is found) as a stray text line. Kept
here rather than only in a commit message because the next person adding
a device-agnostic instrument file that shares a process with real
firmware C will hit some version of this the moment that firmware logs
anything.

## Run it

```
bun run harness/diff.ts <trace.json> --link <path-to-your-link.ts> [options]
```

Full option list is documented at the top of `harness/diff.ts`. The
`--link` module must export a factory function returning a `HardwareLink`
(see `harness/types.ts`).

**This repo now ships a real one.** `harness/links/devlinkLink.ts` drives
the RP2350 board `packs/rp2350-touch-amoled-18/` is the firmware for, over devlink
(`packs/rp2350-touch-amoled-18/tools/README-devlink.md`), and `bun run harness:hardware` is a
complete run against it:

```
bun run pack:build          # the board's firmware, compiled to wasm
bun run harness:hardware      # replay one trace both ways and diff
```

It needs a board. With none attached it fails in about a second with a
message naming the port it tried and why it gave up, and exits `2` (the
comparison never happened), never `1` (the comparison ran and diverged).
See "Against the real board" below for what it actually found.

With no hardware, start with the harness's own self-test instead:

```
bun run harness:selftest
```

This proves the harness MECHANISM works (pacing, capture points, pixel
comparison, PNG output) using a fake link
(`harness/fixtures/loopbackLink.ts`) that is just a second instance of the
same wasm module. **Read that file's header comment. It is not a
substitute for real hardware and must never be read as evidence about
one** - a clean self-test proves this repo's own code isn't broken, nothing
more.

## The pluggable side: `HardwareLink`

```ts
export interface HardwareLink {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reset?(): Promise<void>;
  send(event: TraceEvent): Promise<void>;
  screenshot(): Promise<CapturedFrame>;
}
```

This is deliberately the entire surface. Nothing in `harness/` knows or
cares whether your transport is a USB-serial link, a debug probe, a raw
SPI tap, or a camera pointed at the panel with autocrop. Implement these
five methods against whatever you have, and the rest of the harness (trace
replay, pacing, comparison, reporting) works unchanged.

`send()` gets called once per non-tick trace event (`touch`, `button`,
`verdict`, `sensor`), in order, paced in real wall-clock time at the same
relative spacing the trace was originally recorded at - see
`harness/hardwareSide.ts`'s header comment for exactly why "tick" events
are never sent (there is no ABI equivalent of a synthetic clock tick on
real hardware; it runs on its own).

`screenshot()` must return `{ width, height, rgb }` with `rgb` as plain
RGB, 3 bytes per pixel, row-major, top-left origin - already decoded from
whatever your transport's wire format is. The harness makes no assumption
about that wire format; decoding it is entirely your adapter's job.

## Against the real board

Everything below this line was measured, on 2026-08-14, against the
RP2350-Touch-AMOLED-1.8 on `COM4`, through
`harness/links/devlinkLink.ts`. Until that day this document described a
`HardwareLink` nobody had written and a comparison nobody had run; the
paragraphs that said so have been replaced by what happened.

### What was run

| Trace | Capture points | Result |
| --- | --- | --- |
| `harness/inputs/chrono-idle.trace.json` (64 events, ticks only) | 1, at t=1008 | **MATCH**, byte-identical at tolerance 0, repeatedly |
| `harness/inputs/draw-stroke.trace.json` (193 events: the menu chord, a tap on the "draw" icon, an 11-sample stroke) | 2, at t=1600 and t=2800 | **DIVERGE** at the stroke, every time, by a different amount every time |
| `harness/inputs/menu-chord.trace.json` (160 events: the chord alone) | 1, at t=2000 | **never compared**: the board physically cannot send that screenshot, see "the payload ceiling" |

**The idle screen matches exactly.** The stopwatch at `00:00:00`, freshly
entered, is the same 164,864 pixels on both sides, with zero tolerance.
That is a real result and a bigger one than it looks: it means the wasm
build and the ARM build agree pixel for pixel on `digits.c`'s seven-bar
numerals, `gfx.c`'s rotation and the whole RGB565 pipeline, and it means
this harness's own pixel path (the emulator's framebuffer reader, devlink's
RLE stream, the greyscale reconstruction in `devlinkLink.ts`) is exact
rather than approximately right.

**The stroke does not match, and does not fail the same way twice.** Three
runs of the identical trace, on the same board, minutes apart:

1. the board drew the stroke as **three disconnected fragments**, plus one
   mark in a corner no trace event asked for (2,300 px, 1.40%)
2. the board drew **only the second half** of the stroke, starting at
   sample 5 of 11, ending exactly where the emulator's did (928 px, 0.56%)
3. the board drew **the whole stroke**, and what was left was the
   anti-aliased edge along one side of it and the end cap (670 px, 0.41%)

The emulator drew the same clean line all three times. So the best case is
still a divergence: two builds of one `sketch.c`, fed one trace, agree on
where a stroke goes and disagree on its coverage. The worst case loses half
the stroke.

**This is decision 0008 arriving on schedule**
([`packs/rp2350-touch-amoled-18/docs/decisions/0008-the-emulator-seam-is-in-the-wrong-place.md`](../packs/rp2350-touch-amoled-18/docs/decisions/0008-the-emulator-seam-is-in-the-wrong-place.md)).
Both sides run the same `sketch.c` - it is above the seam - so identical
input has to produce identical pixels, and these pixels differ. Therefore
the input differed. `emu_shim.c` pushes an `emu_touch()` straight into a
queue drained once per 16ms tick; the board's injected sample goes into a
core0 ring merged by timestamp into the real stream and drained by a loop
running about 217,000 times a second, so one injected report is re-observed
at the same coordinates thousands of times before the next one arrives -
which is the shape of the real controller's behaviour decision 0008
measured ("about sixty repeated reports per new position"), reproduced here
by accident. `sketch.c`'s stroke-start confirmation and dropout tolerances
read that cadence, and the two cadences are not the same cadence.

The instability across runs is the other half of the finding and the more
uncomfortable one: **a single clean run of this harness against this app
would have meant nothing.** Run 3 alone looks like a rounding difference.

### The screenshot pacing, measured

A screenshot is the expensive thing here and it is the one that has
rebooted this board before, so `harness/hardwarePacing.ts` measures it
rather than assuming:

```
bun run harness:hardware:pacing          # ladder of gaps: 1000, 500, 250, 100, 0 ms
bun run harness:hardware:pacing 0 250    # explicit gaps
```

Six shots at each gap, on two different screens (60 shots), watching for a
truncated payload and for the board changing app underneath the run:

| screen | RLE payload | shot cost, median | worst | truncated | reboots |
| --- | --- | --- | --- | --- | --- |
| chrono, idle | 2,162 B | 281-295 ms | 530 ms | 0/30 | 0 |
| timer | 3,854 B | 482-535 ms | 596 ms | 0/30 | 0 |

**Nothing failed, at any gap, down to zero.** Back-to-back screenshots with
no pause at all did not truncate, did not change the app, and left the
profiler's `shot drops` counter at 0. That is not what the folklore around
this board said, and the reason is in the firmware: `devlink.c` caps one
reply at `DEVLINK_SHOT_BUDGET_US` (750 ms) and closes it with `END`
regardless, so a shot can no longer hold the main loop long enough to
starve the 4 s watchdog. The reboots that motivated that cap happened
before it existed. `DEFAULT_SHOT_MIN_MS` still ships at 250 ms, as margin
on somebody else's board, not because zero was observed to fail.

The cost fits `20 ms + 0.12 ms per RLE byte`, which is 11.2 KB/s of base64
- the byte rate of 115200 8N1, to two digits. Screenshot cost is serial
transmit time and nothing else.

### The payload ceiling, which is the real limit

The 750 ms budget converts directly into **a screen complexity limit of
about 6.3 KB of RLE**, and past it the screenshot is not slow, it is
impossible. The menu trace found it immediately:

```
SHOT truncated: header promised 7784 RLE bytes, 6327 arrived
```

The app menu does not compress small enough to leave the board inside its
own budget, so **this harness cannot compare the menu screen at all** at
115200. The link reports that as a truncation naming the budget, not as a
corrupt image and not as a divergence, and the run exits `2`. Whether a
higher `DEVLINK_BAUD` moves the ceiling was not tested: the emulator dev
server owned the port at 115200 throughout, and evicting it to find out was
not worth the risk to a board somebody else was using.

Practical consequence: point this harness at screens that are mostly one
colour. That is most of this device's apps, and it is not a coincidence -
the same run-length structure that makes a screenshot cheap is what makes
the panel pushes cheap.

### How a reset is detected

A board that reboots mid-run comes back in app 0 with a zeroed arena, and
diffing frames across that is exactly the instrument that lies
([`packs/rp2350-touch-amoled-18/docs/decisions/0004`](../packs/rp2350-touch-amoled-18/docs/decisions/0004-the-day-the-instruments-lied.md)).
Two readings, both over devlink, both free:

1. **Which app is running.** Every capture is followed by `APP`. `reset()`
   deliberately parks the board in a known app first, so "not that app any
   more" is a signal rather than a shrug. This is the strong one, and it is
   why the shipped smoke-test trace does not switch apps.
2. **The profiler's cumulative counters going backwards.** This firmware's
   `prof` line has no absolute uptime field (`loops=` and `core1=` are
   per-second rates), but `core1restarts=` and `shot drops=` count from
   boot, so either one decreasing is a reboot. The link reads them off the
   shared port for free, on its way past the noise to every reply, and a
   `shot drops` that goes UP is reported too - that is the board telling
   you it truncated something.

A trace that drives its own app switch has to relax the first one
(`PUCK_HW_APP_TRACKING=follow`), which genuinely weakens reset detection to
the counters alone. What backs it up there is the comparison itself: a
board that reset would be showing app 0 while the emulator side shows
whatever the trace navigated to, and that is not a subtle diff.

### Two things this run found that were not the firmware

**The board and the emulator were not built from the same source, and the
harness could not have told you.** The board answers `SWITCH 3` with `OK`
and reports `APP 3 four`; `packs/rp2350-touch-amoled-18/firmware`'s `g_apps[]` has three entries.
Nothing in devlink carries a build identity - `PING` returns a protocol
version and the panel size - so a differential run cannot verify that the
two sides are the same program, which is a strictly larger hole than the
two-compilers problem below. It surfaced only because the menu's touch
columns are `LAND_W / g_appCount` wide, so one tap coordinate selected
`draw` on a three-app build and `timer` on the four-app one, and the run
diverged by 28% of the panel. If you get a divergence that large, check
this first.

**`harness/diff.ts` was writing zero-byte PNGs.** `writePng` did not await
`Bun.write`, and `main()` ends in `process.exit()`, so all three images the
tool announced on a divergence lost the race - at exactly the moment the
images are the only thing that can say which side is wrong. Fixed here,
found by the first real divergence.

## A worked reference: how the shipped link maps onto devlink

This repo's `HardwareLink` implementation is
`harness/links/devlinkLink.ts`, over the protocol
`packs/rp2350-touch-amoled-18/tools/README-devlink.md` documents: a small line-based command
protocol over the same USB-serial port the runtime already prints debug
output to:

- `PING` - liveness and protocol version
- `SHOT` - a screenshot: the framebuffer, walked once to count runs and
  once to stream them, RLE-encoded then base64, because a full raw
  framebuffer dump would be too slow over a serial link and a mostly-flat
  panel compresses to almost nothing
- `DOWN <x> <y>` / `MOVE <x> <y>` / `UP` / `TAP <x> <y>` - touch injection
- `KEY <name>` / `BOOT <name>` - button injection, named forms only (not a
  raw bitmask), so a typo fails to parse instead of silently injecting the
  wrong gesture
- `APP` / `SWITCH <index>` - read and change which app is running, for a
  firmware with the optional `apps` concept

A `HardwareLink` adapter over a protocol like this is almost entirely
mechanical: `send()` maps a `TraceEvent` to the matching command line(s)
(`touch` down → `DOWN x y`, `button` → `KEY`/`BOOT`, `sensor` → whatever
your device injects for that sensor id), and `screenshot()` sends `SHOT`,
decodes the RLE+base64 reply, and returns the decoded pixels as RGB.

**One line of that is a trap, and it cost the first exact match here.** A
greyscale panel does NOT convert to RGB as `r = g = b = grey`. This board
stores RGB565 and `SHOT` sends `px_to_gray()`, the 6-bit green channel
shifted up by two, while the emulator side reads the same framebuffer word
and expands each field with bit replication (`src/panel.ts`). Expanding the
byte naively gives 252 where the emulator gives 255 for white, so every
pixel of a perfectly correct frame is off by three and no run ever matches
at tolerance 0. Reversing the panel's own packing instead - green is
`byte >> 2`, red and blue are `byte >> 3` for a neutral pixel - reconstructs
the emulator's exact triple, which is why the idle screen above matches with
zero tolerance rather than needing a fudge factor. Do the algebra for your
own panel; do not reach for `--tolerance`.

**The one thing worth calling out explicitly, because it is not obvious
from the protocol alone**: button/key injection like this proves your
runtime and app logic handle an input correctly. It does NOT prove the
real chip that produces that input (a PMIC's register read, a flash
chip-select borrow, whatever your board's own button path involves)
actually works, because injection skips that chip entirely and hands your
firmware the bits as if the real transaction had already happened cleanly.
This is the same shape of caveat `wasm/emu_abi.h` documents for the
emulator side ("the emulator must never deliver an input the hardware
cannot produce") but the other direction: injection through a real link
drives REAL firmware on REAL hardware, with no simulated chip to blame, so
the gap it leaves is a gap in what the TEST proves, not a dishonesty in a
stand-in board. Keep this in mind when a differential run comes back clean
- see the next section.

## What this catches, and what it cannot

**Catches**: behavioural divergence between your emulator build and your
real build, at the framebuffer, for a given input sequence, at whatever
capture points you chose. If your wasm build draws a different pixel than
your board does for the exact same trace, this finds it and shows you
both images plus a diff heatmap.

**Does not see bus-load artifacts.** Every frame this harness compares - on
both the emulator side and the real-hardware side - is read straight out of
a framebuffer (`emu_fb()`'s memory, or a real `SHOT`), never off the wire the
panel push actually travels. A firmware bug that corrupts what lands in the
framebuffer shows up here; a firmware pattern that corrupts nothing but
drives the QSPI bus harder than any pattern this pack has shipped before -
many small pushes a tick, or one push that is unusually large or unusually
frequent - does not, because the emulator has no bus to model in the first
place (decision 0003: the emulator is a pure function of the ABI calls it
receives, with no notion of a wire, a clock line, or how long a transfer
takes). Found exactly this way on `apps/fluidbox`'s rp2350 port: the
emulator ran the fix and the pre-fix code identically, pixel for pixel, at
every capture point, while only a human looking at the real panel could see
the shimmer the pre-fix code caused (`packs/rp2350-touch-amoled-18/
gotchas.md`'s "many small pushes" entry has the measured numbers). This is
why a silicon attestation - eyes on the physical panel, not another harness
run - stays a required step for this class of change, not a formality this
tooling could someday absorb.

**Does not check that the two sides are the same program.** Nothing in
devlink carries a build identity, so the harness will happily diff a wasm
module built from your working tree against whatever firmware happens to be
flashed. That happened on the first real run here (three apps against four)
and it produced a 28%-of-the-panel divergence that looked like a rendering
bug. Before believing any large divergence, confirm the board is running
the commit you built. This is a bigger hole than the two-compilers problem
below, and unlike that one it is entirely avoidable by reflashing.

**Does not see colour.** `SHOT`'s wire format is one greyscale byte per
pixel, because this panel is used as monochrome. The sketchpad's palette,
`sketch.c`'s `tint_to_px`, and `runtime.c`'s red core1-dead screen all
arrive as a green channel and come back out as grey. A coloured screen
diffed this way reports a divergence that is in the WIRE FORMAT, not in the
firmware. Do not point this at a coloured screen and believe the number.

**Does not prove the input path.** Every input this link delivers is
injected downstream of the silicon that produces it: `KEY` skips the
AXP2101's register read and its write-1-to-clear, `BOOT` skips the flash
chip-select borrow, and `DOWN`/`MOVE`/`UP` skip the FT3168 entirely. See
`packs/rp2350-touch-amoled-18/tools/README-devlink.md`'s "What injection cannot test" and
[`packs/rp2350-touch-amoled-18/docs/decisions/0004`](../packs/rp2350-touch-amoled-18/docs/decisions/0004-the-day-the-instruments-lied.md),
where a whole day was lost to a rig that injected downstream of the layer
that had failed: every hardware verification run passed while the device
was unusable by hand. **A green run of this harness is not evidence that a
real finger or a real thumb reaches the firmware.** Concretely, on this
device it cannot see: the touch threshold register `FT3168_Init()` never
writes, the PMIC's read-and-clear timing, the BOOT pad's chip-select
borrow, or anything core1 does - and the first of those is half of the
worst bug this project has shipped.

**Does not eliminate the two-compilers problem.** See
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md):
the wasm module and your real firmware are the same C, compiled by two
different compilers, to two different targets. A clean differential run is
strong evidence your application logic hasn't drifted between the two
builds; it is not proof the two compilers agree on every code-generation
detail, integer-width edge case, or float-precision corner your firmware
might be sensitive to. Most application logic doesn't care. Some does.

**Does not catch timing or CPU-level bugs**, ever, by construction. The
emulator's clock is whatever the host hands `emu_tick()`; nothing about
this harness makes that timing real, and a divergence caused purely by
real-world timing (a race, an interrupt landing at the wrong moment, a bus
contention issue) has no reason to show up in a framebuffer diff even
though it is a completely real bug on the actual board.

**The known bound, stated plainly rather than left as an abstract
caveat**: the hardest bug in the history of the project this repo was
extracted from was a flash chip-select borrow on one CPU core racing the
second core's own instruction fetch - a timing race at the memory
controller, between two cores, with no software-visible signal at the
point of failure (see that project's own decision record, referenced in
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md)).
**This differential harness would not have caught it. Neither would any
emulator surveyed while researching this project's own architecture**
(see that same decision record for what was actually surveyed). Catching
that class of bug needs a cycle-accurate model of the real chip's own bus
arbitration, at a fidelity nothing reviewed for this project claims to
have, for any two-core microcontroller. The fix for that bug was a hazard
analysis and a documentation discipline (a decision record durable enough
to survive a refactor), not more testing infrastructure - and no amount of
investment in this harness changes that. A tool that oversells what it
catches costs more than one that plainly says what it doesn't.

## Exit codes

`harness/diff.ts` exits with one of three distinct codes, because CI reads
the exit code, not the console text: `0` means the comparison ran and every
frame matched, `1` means the comparison ran and at least one frame
diverged, and `2` means the comparison never happened at all (bad
arguments, a malformed or out-of-order trace, an uncaught exception from
either replay side, a `HardwareLink` that failed to connect). A `2` is
never a failed comparison and must not be read as one; it means the tool
itself couldn't finish.

Trace timestamps (`TraceEvent.t`) must be non-decreasing across the whole
`events` array (ties are fine - a touch and the tick it's latched by
commonly share one `t`). This matters most for a hand-built trace (see
`harness/selftest.ts` for a worked example): both replay sides pace and
choose capture points off this ordering, and an out-of-order trace used to
produce a silently wrong or skipped capture point rather than an error.
`harness/diff.ts` now checks this up front and exits `2` with the exact
index and timestamps involved if it finds a violation.

## A regression check with no hardware

Everything above needs a `HardwareLink`. Most people, most of the time -
and the entire early life of any device that doesn't have a board yet -
don't have one, and the question they actually keep asking isn't "does the
emulator match my hardware", it's "did I just break something that used to
work". `src/regression.ts` answers that, from inside the page, using
nothing this repo didn't already build for the section above:

1. **baseline**: replays your current input trace against a fresh instance
   of the current module (`src/replayCore.ts`'s `replayFromBytes`, the same
   function `replayEmulator` above is now a thin wrapper around) and saves
   the trace plus a frame at each of a handful of capture points
   (`src/regression.ts`'s `pickCapturePoints`), persisted to
   `baselines/latest/` (see `server.ts` / `baselineStore.ts`) so it survives
   a live reload - the page reloading is exactly the moment this question
   gets asked, and an in-memory baseline would already be gone.
2. **check**: replays the SAME saved trace against the CURRENT module
   (which may be a fresh rebuild) and diffs the result against the saved
   frames with this same file's `compareFrames` (moved to `src/compare.ts`
   specifically so the page can call it with no dependency on anything
   under `harness/`).

In the page: two buttons ("baseline", "check") and, on a failure, a small
modal showing the baseline frame, the current frame and a diff heatmap for
every capture point that diverged - the same visual a `--out` divergence
from `harness/diff.ts` writes to disk, just shown in place. A failed check
is also written to `regressions/latest/` in the same shape a freeze bundle
uses, so an agent can pick it up - see
[`docs/agent-loop.md`](agent-loop.md#a-failed-regression-check-for-an-agent).

**Read this bound before trusting a clean check more than it has earned:
this compares the emulator against ITSELF, at two points in time.** There
is no hardware anywhere in this path, not even the loopback fake above. A
clean check is evidence the emulator draws the same thing for the same
input as when the baseline was saved - nothing more. It catches a firmware
regression in your application logic. It says nothing about whether the
emulator still agrees with real hardware (that's what the rest of this
document is for), and nothing about timing, for exactly the same reason
stated in "What this catches, and what it cannot" below: the emulator's
clock is whatever the host hands `emu_tick()`, on both sides of this
comparison, always.

## Capture points

The harness never captures every tick - that would be far too slow for
most real hardware transports (a single screenshot over a slow serial link
can easily cost hundreds of milliseconds). You choose when to look:

- `--at 500,1200,4000` - explicit trace-relative millisecond timestamps
- `--every 1000` - a fixed interval across the trace's span
- neither - captures once, at the trace's final tick (the default: "does
  the end state match")

Pick capture points around whatever you're actually trying to verify: the
moment right after a gesture completes, a few points across an animation,
or just the final frame for a quick regression check.
