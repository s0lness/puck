# devlink

A USB-serial link so an agent can see the screen and drive the touchscreen
without a human. Two halves:

- `firmware/devlink.c` / `firmware/devlink.h`: a small command interpreter
  that reads lines from the same USB CDC port the runtime already prints
  debug output to, and answers them.
- `tools/dev.ts`: a `bun` CLI that talks to it.

**Status: `tools/dev.ts` has now been run against real hardware, and the
claim below that used to stand here (that the host "only ever looks for the
specific reply shape it is waiting for" and therefore tolerates the shared
port) was false at the time it was written.** It was written while the
board's serial port was in use by another process and could not be opened,
and it showed: the very first real run (`bun tools/dev.ts shot out.png`)
failed immediately with `unexpected reply to SHOT: prof app=chrono
switch=15287us | loops=217088/s | touch reads=0 ...`, because every read
in `tools/dev.ts` actually just took the next line off the wire and assumed
it was the answer. On a board that also prints a profiler line once a
second on the same port (see "Framing and non-blocking behaviour" below),
that assumption breaks on first contact.

This has since been fixed: every read loop in `tools/dev.ts` (`expectLine()`)
now keeps discarding lines until one actually matches the reply shape it is
waiting for, within an overall timeout, rather than trusting the first line
back. The multi-line `SHOT` body gets the same treatment at the line level:
a real payload line is a run of complete base64 groups (checked with
`isBase64Line()`), so a profiler tick landing between two payload lines is
recognised as not-base64-shaped and skipped without corrupting the RLE
stream. This was verified for real, repeatedly, against the running board
on `COM4`: `ping`, `app`, `switch`, `tap`, `erase` and `shot` all work, and
several back-to-back `shot` captures all decoded to the same correct
368x448, non-blank image (the board was running the stopwatch, reading
`00:00:00`; see "Bring-up notes" below for what that screenshot actually
shows and why it looks sideways).

A second, unrelated bug turned up in the same bring-up session: `Bridge.close()`
killed the PowerShell child but returned before it had actually exited, so
two `bun tools/dev.ts` invocations run back to back (as `a && b`, or by any
script driving several commands) could race for the exclusive `COM4` handle
and the second one would fail to open the port. `close()` now awaits the
child's exit (bounded, in case it is ever wedged) before returning, and
every call site awaits `close()` in its `finally` block.

Treat this as a working tool now, not a bring-up session, though see
"Bring-up notes" for the one open question (a re-enumeration hiccup during
this session that turned out to be an unrelated board reflash, not a
`tools/dev.ts` bug).

## Wire protocol

One command per line, ASCII, case-insensitive, terminated by `\n` or `\r`
(the firmware accepts either and treats a run of them as one terminator).
Replies are `\r\n`-terminated, matching the rest of the runtime's output on
this port. Because devlink shares the port with the runtime's existing debug
prints (`prof ...`, `switch ...`, `stroke start ...`, etc.), a reader has to be prepared to
see those lines interleaved with devlink replies at any time; they are not
part of this protocol and should be treated as ignorable noise by anything
parsing devlink's own replies. `tools/dev.ts` does this by construction, not
by accident: every read loop matches the reply shape it is waiting for
(`expectLine()` in `dev.ts`) and discards anything else, rather than
trusting whatever line comes back first. See "Why this is a host-side fix,
not a firmware one" below for why the noise is left alone at the source.

The one thing this asks of a reader: match the *expected shape*, not "not
a known noise prefix". This firmware already carries more than one source of
unrelated `printf`: the profiler (`runtime.c`), the sketchpad's stroke
tracing (`apps/sketch.c`), and a `BOOT ...` self-test poll (`bootbtn.c`,
`bootbtn_selftest_poll()`) that is not wired into the main loop today but
exists in the tree and could be re-enabled without anyone thinking of it as
a devlink change. A matcher built out of a blacklist of today's noise
prefixes breaks the moment any of that changes; a matcher built out of "is
this what a `PING` reply / a `SHOT` header / a base64 payload line looks
like" does not.

### Why this is a host-side fix, not a firmware one

Two firmware-side options were considered instead: suppressing the profiler
while a devlink exchange is in progress, or prefixing every devlink reply
line with a marker byte noise can never produce. Neither was implemented,
for reasons specific to how this firmware is put together:

- Every `printf` in this firmware, including the profiler tick, `devlink.c`'s
  own replies, and the sketchpad's stroke-debug lines, runs on core0, inside
  the single-threaded main loop (core1 never touches stdio at all; see
  `sensors.c`'s ownership-rule banner). A `SHOT` reply is emitted by one
  blocking call to `devlink_send_shot()` from inside a single call to
  `devlink_poll()`, itself one step of that same loop, so nothing else in
  this firmware can print *into the middle of* an in-flight `SHOT` reply.
  The failure this task actually reproduced (`unexpected reply to SHOT: prof
  app=chrono ...`) was a profiler tick landing where the reply was expected
  to *start*, in the gap between sending the command and the board getting
  around to answering it, not a tick splicing itself into an already-started
  reply. Suppressing the profiler "during an exchange" would not close that
  gap, since the gap exists before the firmware even knows an exchange has
  started.
- A reader that trusts the first line back is broken by *any* unrelated
  print sharing the port, not just the profiler: `BOOT ...` (a physical
  button poll) and `stroke ...`/`erase (shake)` (the sketchpad) are exactly
  as capable of landing in that same gap. Silencing the profiler specifically
  would still leave the same class of bug for every other print, and for
  whatever gets added after this. The fix needs to be general regardless of
  what firmware changes; once it is general, it is also sufficient by
  itself.
- The shared port carries real value as a human-readable console: someone
  driving the board by hand while `tools/dev.ts` (or another future client)
  drives it programmatically still wants to see `prof`/`stroke`/`BOOT` lines
  live, per this file's own design going back to `devlink_poll()`'s "never
  blocks" contract. Suppressing or marking every line changes what a human
  watching the console sees, for the benefit of a problem the host side can
  solve without touching the wire format at all.
- Practically: a firmware change made in this session cannot be verified
  against the running board (it is explicitly not to be reflashed while
  another change is in flight elsewhere in the tree), where the host-side
  fix was verified directly, repeatedly, against the real board on `COM4`.

The host-side fix (`expectLine()` plus `isBase64Line()`) fully covers both
failure shapes seen in practice (noise where a reply should start, and by
construction, noise that would land inside a multi-line body) without
changing the wire format `tools/dev.ts` already documents below, and without
giving up the shared console's usefulness to a human.

### Commands

| Command | Reply |
|---|---|
| `PING` | `OK devlink <version> <w> <h>` |
| `SHOT` | see below |
| `DOWN <x> <y>` | `OK` (or `ERR args` if x/y do not parse) |
| `MOVE <x> <y>` | `OK` (or `ERR args`) |
| `UP` | `OK` |
| `TAP <x> <y>` | `OK` (internally: DOWN then UP) |
| `ERASE` | `OK` |
| `KEY PRESS` / `KEY LONG` / `KEY SHORT` / `KEY RELEASE` | `OK` (or `ERR args` if the name is not one of the four) |
| `BOOT DOWN` / `BOOT UP` / `BOOT CLICK` | `OK` (or `ERR args`) |
| `CHORD` | `OK` |
| `APP` | `APP <index> <name>` |
| `SWITCH <index>` | `OK`, `ERR args` (index does not parse), or `ERR range` |
| `PUSHSTATS` | `PUSHSTATS <pushes> <pixels>`, or `ERR unknown PUSHSTATS` on a build that never wires it |
| `TUNE` | one `TUNE <name> <value> <min> <max> <default>` line per declared tunable, then `END` |
| `TUNE GET <name>` | `TUNE <name> <value>`, or `ERR unknown <name>` |
| `TUNE SET <name> <value>` | `TUNE <name> <applied>` (applied = value clamped to `[min, max]`), or `ERR args` / `ERR unknown <name>` |
| `TUNE RESET <name>` | `TUNE <name> <applied> <previous>` (applied = the declared default; previous = the value just replaced), or `ERR unknown <name>` |
| `TUNE RESET` | one `TUNE <name> <applied> <previous>` line per declared tunable, then `END` |
| `TUNE FREEZE` | one `#define <NAME>_DEFAULT <value>f` line per tunable, then `END` |
| anything else | `ERR unknown <cmd>` |

`TUNE` (and its subcommands) answer `ERR no tunables` instead of the shapes
above on a device built without `-DSKETCH_LIVE_TUNE=1` (off by default) -
see "TUNE" below.

`<version>` is the devlink protocol version (currently `1`), independent of
firmware version. `<w>` and `<h>` are the framebuffer dimensions in pixels
(368x448 on this board).

Coordinates are panel pixel coordinates, `x` in `[0, w)`, `y` in `[0, h)`.
Whoever wires up the hooks in `runtime.c` is responsible for clamping (see
the integration notes below); devlink itself does not.

### APP and SWITCH

An agent that can only screenshot whichever app happens to be running can
only ever verify one screen. These two commands exist so it can also see
and change which app that is.

`APP` reports the running app: `<index>` is its position in the runtime's
`g_apps[]` table (what `SWITCH` takes), and `<name>` is the same short name
shown in the on-device menu and printed to the console on every switch (e.g.
`draw`, `chrono`, `timer`). If the menu overlay itself is open rather than
any app, `<index>` is a negative sentinel (the runtime's internal
`APP_INDEX_MENU`) and `<name>` is `menu`; devlink does not otherwise
interpret this value, it just reports whatever `app_current()` returns.

`SWITCH <index>` requests a switch to `g_apps[index]`, applied at the end of
the current frame, same as a real menu tap (see `app_switch_to()` in
`app.h`). `index` must be a valid `g_apps[]` position; `ERR range` covers
both an out-of-range number and the menu's own sentinel index, since the
menu is the shell a child uses to pick an app, not one of the apps devlink
is meant to drive to. There is no separate "open the menu" command.

### TUNE

Reads and writes the firmware's live-tunable constants with no reflash -
today, `firmware/apps/sketch.c`'s six dropout-tolerance knobs (the lift
debounce, the stroke-start confirmation window, the pending-candidate
dropout grace, and the three jump allowances; see that file's
`SKETCH_LIVE_TUNE` comment). The point is turnaround: a reflash costs a
minute and breaks the drawer's concentration, so in practice only two or
three candidate values ever get tried by hand. `TUNE SET` costs a second and
takes effect on the very next tick, so a value can be felt out while
actually drawing, not guessed at from a description.

`<name>` is the tunable's short protocol name (`lift`, `confirm`,
`pendgrace`, `minjump`, `maxjump`, `maxspeed` today - `TUNE` with no
arguments lists whatever the running firmware actually declares, which is
the source of truth, not this list). `TUNE SET` clamps to the declared
`[min, max]` on the device and echoes back what was actually applied, which
may differ from what was asked for.

`TUNE RESET` is how a candidate value gets abandoned without a reboot.
Tuning by feel means wandering: `lift`, then `pendgrace`, then `confirm`,
losing track of which change is responsible for what the last few strokes
felt like. `TUNE RESET <name>` restores one tunable to its declared
default; bare `TUNE RESET` restores all of them. Both print what the value
is now AND what it was a moment before, on the reasoning that a reset
someone reads while still holding a finger on the panel is worth more if it
says what changed, not just that something did. `TUNE` (the bare list)
marks any row whose current value differs from its default, so "which of
these am I still overriding" reads at a glance instead of by comparing the
`value` and `default` columns by eye.

`TUNE FREEZE` is the end state: once a value is settled by feel, it prints
every current value as a `#define <NAME>_DEFAULT <value>f` line, ready to
paste straight over the corresponding constant in `sketch.c`. The knobs
(and `SKETCH_LIVE_TUNE` itself) are then meant to come back out - this is a
development affordance, not a permanent runtime control surface, and a
shipped build carries none of it (see `firmware/CMakeLists.txt`'s
`SKETCH_LIVE_TUNE` flag, off by default, and `sketch.c`'s own comment on why
that is enough to guarantee no knob can ship in a bad position).

**The emulator has the same knobs, for fast iteration, but it is not
where a value gets decided.** `TouchSim`'s dropout model is measurably
kinder than the real FT3168 - the pre-fix stroke-start rule scored 63-83
percent in the emulator against 3.5 percent on real hardware (see
`packs/rp2350-touch-amoled-18/wasm/tests/repro-touch-dropout-stroke-start.ts`) - so a value that
feels right in the browser is a hypothesis about the real controller, not a
result. Only `TUNE` against the real device, under a real finger, can
promote it to one.

### PUSHSTATS

Reports panel-push load since the last `SHOT`: how many `gfx_push()`/
`gfx_push_all()` calls actually reached the panel, and how many pixels they
touched, since that screenshot was taken (`devlink_send_shot()` resets both
counters before it does anything else - see `firmware/runtime/gfx.h`'s
`gfx_push_stats_reset()`/`gfx_push_stats_get()`). A build that never wires
`devlink_hooks_t.push_stats_get` answers `ERR unknown PUSHSTATS`, the same
policy an unwired `TUNE` build answers `ERR no tunables`.

This exists for one consumer: `apps/fluidbox/invariants.ts`'s panel-push
invariant bounds the worst tick's push load, and the emulator can answer
that from a replayed trace (`emu_push_count()`/`emu_push_w()`/`emu_push_h()`
in `wasm/emu_abi.h`) where a board has no trace to replay against, only its
own running counters. A harness asks `PUSHSTATS` right before it asks for
the next `SHOT`, so the reply describes exactly the window between the two
screenshots; see `harness/hardwareSide.ts`'s `replayHardware()` for how
those windows are folded into the same `{tickCount, maxPushesPerTick,
maxPushPixelsPerTick, meanPushPixelsPerTick}` shape the emulator side
already reports, and `harness/invariantTypes.ts`'s `InvariantMeta.pushStats`
for why a checker that needs this and does not get it must report
"unevaluable" rather than pass silently.

### SHOT

Requests a screenshot. The panel is neutral grey throughout (white paper,
black ink), so an 8-bit greyscale image loses nothing that matters, and
compresses very well with plain run-length encoding.

Reply shape:

```
SHOT <w> <h> <rle_byte_count>
<base64, wrapped at 76 chars per line>
...
END
```

`<rle_byte_count>` is the exact length in bytes of the RLE stream *before*
base64 (i.e. `2 * number_of_runs`). It is known up front because the
firmware walks the framebuffer twice: once just to count, once to stream
the actual bytes; it never buffers the whole RLE stream in RAM (there is
already a 330KB framebuffer sitting in 520KB of SRAM, so headroom is
tight).

**Getting an 8-bit grey level from a stored pixel.** The framebuffer is
`uint16_t` RGB565, but stored byte-swapped relative to how the CPU holds a
`uint16_t`, because the panel wants the opposite byte order and the buffer
is DMA'd out raw (see `runtime/gfx.h`'s `px_swap` for the full story: this only
started mattering once anti-aliasing introduced non-palindromic pixel
values). To recover the grey level:

```c
uint16_t v = (px >> 8) | (px << 8);       // undo the storage byte-swap
uint8_t  g = (uint8_t)(((v >> 5) & 0x3F) << 2); // 6-bit green -> 8-bit grey
```

**RLE.** The framebuffer is walked in row-major order (index `y*w+x`, i.e.
exactly the flat layout of the `fb` pointer). Each run is emitted as two
bytes: `(value, count)`, `count` in `1..255`. A run of 256+ identical
pixels is split into multiple `(value, 255)` pairs. There is no
end-of-stream marker inside the RLE bytes themselves; the byte count in the
`SHOT` header is what tells a decoder when to stop. A blank white screen
(368*448 = 164864 pixels, all the same value) encodes as a handful of
`(255, 255)` pairs, i.e. well under 100 bytes before base64: "tiny payload"
in the spec is not an exaggeration.

**Base64.** Standard alphabet (`A-Za-z0-9+/`, `=` padding), applied to the
raw RLE byte stream, wrapped at 76 characters per output line. The last
line may be shorter. `END` on its own line closes the block. A decoder
should: concatenate every base64 line between the `SHOT ...` header and
`END`, base64-decode the result, then RLE-decode using the byte count from
the header as a sanity check (it should exactly match the decoded byte
length; `tools/dev.ts` warns if it does not, since that means the transfer
was corrupted or truncated).

**A `SHOT` reply can end short of its own header on purpose.** Measured on
real hardware: a client that sent `SHOT` and then stopped draining the port
(closed its reader, crashed, or a bare terminal that opened the port and
never read) used to reboot the board, because the body is written one
character at a time (`putchar()` per output char) and pico-sdk's own
per-write timeout bounds each of those individually, not their sum -
runtime.c's 4-second watchdog was what actually ended the stall. `devlink.c`
now caps the whole reply at `DEVLINK_SHOT_BUDGET_US` (750ms) of wall-clock
time; past it, the remaining base64 body is silently dropped and the reply
still closes with `END`, so a decoder sees exactly the "transfer was
corrupted or truncated" case the paragraph above already tells it to check
for - nothing new to implement host-side. `runtime.c`'s profiler line
carries a cumulative `shot drops=N` counter (via `devlink_dropped_shots()`)
so a truncated `SHOT` is never confused with a dead board even by someone
just watching the console, not running `tools/dev.ts` at all.

### KEY, BOOT and CHORD

These exist so an agent can drive the two physical buttons neither `devlink`
nor an app can otherwise reach: PWR only ever reaches firmware through the
AXP2101 PMIC (there is no GPIO for it), and BOOT is read by borrowing the
flash chip select (`firmware/bootbtn.c`), not sampled from a normal pin.
Without these, the app-switch chord (BOOT held with PWR long-pressed), the
stopwatch's `KEY_SHORT` start/stop and the timer's `KEY_SHORT` pause could
only ever be tested by a human physically pressing a contact.

**`KEY <name>`** injects a PMIC key bit: `PRESS`, `LONG`, `SHORT` or
`RELEASE`, matching `sensors.h`'s `KEY_PRESS`/`KEY_LONG`/`KEY_SHORT`/
`KEY_RELEASE`. Named forms only, no raw hex mask, on purpose: `KEY 0x04` at
an interactive prompt or in a hastily copy-pasted script is one
fat-fingered digit away from injecting the wrong gesture with no complaint
from anything, where `KEY LONG` either does what it says or fails to
parse.

`RELEASE` is the newest of the four, added alongside the PWR-held-5s
power-off gesture (`runtime_core.c`): without it, `KEY PRESS` starts a hold
that has no way to be completed or cancelled from devlink, which is exactly
what made that gesture hard to test by injection before this existed - see
`sensors.h`'s PWR key section for the fuller story of why `KEY_RELEASE` was
removed from this firmware once and reinstated later. Before this, the
three bits `PRESS`/`LONG`/`SHORT` were "exactly the ones an app can ever see
in `app_frame_t.key`"; that is no longer true, and this table is the
correction.

**`BOOT DOWN`** / **`BOOT UP`** set the BOOT button's injected level, for
gestures that need it *held* (the chord). **`BOOT CLICK`** injects a
completed press-and-release in one shot, for apps that only ever look at
`app_frame_t.bootClicked` (a level toggle without a dedicated click command
would not reliably produce one, since the two are tracked separately, see
`sensors.h`).

**`CHORD`** is the BOOT+PWR app-menu gesture, composed from the two
primitives above and nothing else: it holds BOOT, delivers PWR's long-press
verdict (`KEY LONG`), then releases BOOT one tick later, automatically. That
is deliberately *all* it does, matching `runtime_core.c`'s own chord
handling exactly: "both buttons held, PWR long-pressed" is the entire
condition that code checks, so `CHORD` reproduces exactly that state and no
more. It works both ways: sent while a normal app is running it opens the
menu; sent again while the menu is open it closes back to whatever was
running before. Firmware-side, `CHORD` cannot release BOOT before returning
its `OK` (the tick that has to observe BOOT still held has not run yet, and
`devlink_poll()` must not block waiting for it to), so the release is
deferred to the very next `devlink_poll()` call instead; see `devlink.h` and
`devlink.c` for the mechanism. In practice this settles within microseconds,
long before a host-side command round-trip could notice.

### What injection cannot test

**None of `KEY`, `BOOT` or `CHORD` exercise the actual button hardware.**
Both signals reach firmware through code injection routes plainly, not
through the chips or pads a physical press goes through:

- A real PWR press latches bits in the AXP2101's register 0x49.
  `pmic_poll_core1()` (`firmware/runtime/sensors.c`) is what actually issues
  the i2c1 read, masks the result (`s1 & 0x0E`), and write-1-to-clears the
  chip's latch so the next event is distinguishable from this one. `KEY`
  skips all of that and hands `sensors_key_take()` the bits directly, as if
  that transaction had already happened and come out clean.
- A real BOOT press borrows the flash chip select, waits for the line to
  settle, and reads back a specific bit in the QSPI high-bank input register
  (`firmware/bootbtn.c`'s `read_cs_low()`). `BOOT` skips all of that too.

This is not a small gap. The one real bug this project has already shipped
in this exact area, several PMIC bits landing in one read and silently
breaking the old double-press menu gesture (see `runtime_core.c`'s chord
comment), lived in precisely the code injection bypasses: the register read
and the read-and-clear timing. **A `CHORD` run through devlink that opens
the menu proves the runtime and the menu app handle a `KEY_LONG` bit
correctly. It proves nothing about whether the AXP2101 will ever actually
hand the runtime that bit on real silicon**, and a future run that sees the
menu open after an injected chord must not be read as "the button path
works": it is evidence for half of that claim, the half downstream of the
chip. The other half, whether a real thumb on a real button still reaches
this code path, can only be checked by a human physically pressing it.

This is the mirror image of `wasm/emu_abi.h`'s rule for the
emulator ("must never deliver an input the hardware cannot produce"). That
rule polices a *simulated* board pretending to be real hardware; `KEY`,
`BOOT` and `CHORD` are a test tool driving *real* firmware on *real*
hardware, with no simulated chip standing in for anything. So this is not a
violation of that rule, it is the other side of it, and the two should not
be confused: the emulator's rule exists to stop a stand-in board from lying
about what silicon can do, and injection has no stand-in board to lie
through. What it has instead is the real, documented gap above.

### Framing and non-blocking behaviour

`devlink_poll()` (called once per main-loop iteration) never blocks reading
input: it drains `getchar_timeout_us(0)` in a loop until that returns
`PICO_ERROR_TIMEOUT`, dispatching each complete line as it is found. The
only place it spends non-trivial time is finishing a `SHOT` reply, since
that involves two full passes over the framebuffer and printing
potentially tens of KB of base64; there is no way to make emitting a
screenshot instantaneous, but it never waits on anything external (no
retries, no polling a peripheral), so it cannot stall the main loop
indefinitely the way e.g. a blocked I2C transaction could.

Lines longer than 95 characters are dropped and the parser resyncs on the
next line terminator, rather than acting on a truncated command. No real
command comes close to that length.

## Firmware integration

`devlink_init()` takes a `devlink_hooks_t` (see `firmware/devlink.h`): the
framebuffer pointer + dimensions (read-only, for `SHOT`), four function
pointers that turn `DOWN`/`MOVE`/`UP`/`ERASE` into actual input, three more
for `APP`/`SWITCH`, and five more for `TUNE` (`tune_count`/`tune_describe`/
`tune_define_name`/`tune_get`/`tune_set`). All twelve are owned by
`firmware/runtime/runtime.c` (see its "devlink wiring" section), the only
file that wires devlink to the rest of the runtime; `devlink.c` itself does
not know what an app, a touch queue, or a tunable even is - the `TUNE` hooks
are a generic name/value shape, wired straight to `sketch.c`'s
`sketch_tune_*` functions (`sensors.h`) rather than adapted through a
runtime.c-owned function, since their signatures already match exactly.
`devlink_init()` is called once, right after `gfx_init()` succeeds;
`devlink_poll()` is called once per main-loop iteration.

**Touch injection is a synthetic producer on the real touch queue, not a
separate drawing path.** Before the single-binary runtime, `DOWN`/`MOVE`/`UP`
called straight into the sketchpad's own `stroke_begin`/`stroke_sample`/
`stroke_end`, so only the sketchpad ever saw an injected touch. Touch now
arrives everywhere through `sensors_touch_next()`, fed by a queue core1 owns
exclusively (see `runtime/sensors.h`'s ownership rule), so the hooks instead
call `sensors_inject_touch()`, which every app reads exactly like a real
finger. Making core0 push straight into that queue would make it a second
producer of a ring whose only safety argument is "core1 is the sole
writer", so injected samples go into their own core0-owned ring instead,
merged into the real stream by timestamp inside `sensors_touch_next()` (see
`sensors.c` for the full argument). Practically, this means devlink now
drives every app, not just the sketchpad, and driving a real finger and
devlink at the same time no longer corrupts anything, though the two
streams interleaving is still confusing to watch and there is no reason to
do it.

**`ERASE` triggers a synthetic shake, not a direct wipe.** The old hook
called the sketchpad's `wipe_erase()` directly; there is no cross-app
equivalent of "erase" now, and inventing a global erase verb would
contradict `sensors.h`'s own reasoning for why shake is opt-in per app (see
that file). `ERASE` now bumps the same counter a real shake does
(`sensors_inject_erase()` / `sensors_erase_seq()`), so it only reaches an
app that opted in with `wantsShake` (today: the sketchpad). On any other
app it is a no-op, same as physically shaking the device would be.

## Host CLI (`tools/dev.ts`)

```
bun tools/dev.ts ping
bun tools/dev.ts shot out.png
bun tools/dev.ts app
bun tools/dev.ts switch 0
bun tools/dev.ts tap 184 224
bun tools/dev.ts draw 20,20 60,40 100,30 140,60
bun tools/dev.ts erase
bun tools/dev.ts key short
bun tools/dev.ts boot click
bun tools/dev.ts chord
bun tools/dev.ts tune
bun tools/dev.ts tune get lift
bun tools/dev.ts tune set lift 180
bun tools/dev.ts tune reset lift
bun tools/dev.ts tune reset
bun tools/dev.ts tune freeze
bun tools/dev.ts log 15
```

`app` and `switch` exist in the wire protocol (see "APP and SWITCH" above)
but were not wired up as CLI subcommands until this task; they are now.

Port and baud are overridable: `DEVLINK_PORT` (default `COM4`),
`DEVLINK_BAUD` (default `115200`).

### Routing through the emulator's dev server

The COM port is exclusive: only one process can hold it. The emulator's dev
server (a devlink-to-emulator bridge, in the private repo this came from) is the single
owner when it is running - it detects the board itself (polling for USB VID
`2E8A`) and opens the bridge before this CLI ever gets a chance to race it
for the handle.

Every command above still works exactly as documented: `openBridge()`
(`tools/dev.ts`) tries the emulator server first (`GET
http://127.0.0.1:5330/api/devlink/status`, then a WebSocket at
`/api/devlink` if it reports a board connected) and falls back to opening
the port directly - the behaviour described everywhere else in this file -
whenever the server is not running or is not currently holding a bridge.
`DEVLINK_SERVER_URL` overrides the server address (default
`http://127.0.0.1:5330`).

Routing through the server has one visible side effect, and it is the
point of it: whatever this CLI sends also shows up in the emulator page's
own console, tagged as coming from the device (so a script and a person
watching the page never wonder whether they saw the same thing). It is
otherwise invisible - a `PING`, a `TUNE` fetch, a `shot` behave identically
either way, they are just no longer capable of fighting the emulator's dev
server for the port.

### Bring-up notes (first real run against hardware)

All seven subcommands (`ping`, `shot`, `app`, `switch`, `tap`, `erase`,
`draw`) were run against the board on `COM4` running the stopwatch app,
repeatedly, including several `shot` captures back to back and a chain of
`app` / `switch 0` / `app` / `tap` / `erase` run one after another. All of
it works.

**`PING` looked broken and was not.** The bug report that started this
bring-up said a `PING` sent right after opening the port got no visible
reply within 3 seconds, then `APP` worked right after. Investigated by
running `ping` repeatedly, fresh port open each time (exactly the scenario
described): with the fixed `expectLine()`-based reader, it came back
`OK devlink 1 368 448` on every attempt. The most likely explanation is the
same bug class as the `SHOT` failure that opened this investigation: the old
reader took the first line back as the reply, and if a `prof ...` tick (or
any other debug line) happened to arrive in that window instead, the old
code either printed that line (which does not start with `OK`, so it would
have looked like failure) or, if nothing at all had arrived within the
hard-coded 3000ms `readLineWithTimeout`, threw an unhandled promise
rejection, which is consistent with "no visible reply" if the failure
scrolled past or the process exited before the error was noticed. `PING`
itself is not broken; nothing about it needs a longer settle time or a
retry beyond what `expectLine()` already does for every command.

**The `SHOT` screenshot looks sideways, and that is correct.** The board
reports the framebuffer as 368 wide by 448 tall (`w`, `h` in the `SHOT`
header, matching `PING`'s report), which is a portrait-shaped buffer, while
the stopwatch app draws its landscape UI into that same native buffer. A raw
`SHOT` dump is not rotated to match how the physically-mounted panel is
viewed, so the decoded PNG shows the same content a human sees, just turned
90 degrees. Six 0-height rectangle outlines in two groups of two, separated
by two small square pairs, is what "00:00:00" looks like turned on its
side, which is what the captured screenshot shows.

**A `COM4` re-enumeration during this session was a reflash, not a bug.**
Partway through bring-up, `ping` and `shot` started failing with "the port
does not exist" and then "access to the port is denied". This was a real
board reflash landing mid-session from unrelated work in flight elsewhere in
the tree, not a `tools/dev.ts` defect: the port came back and every command
worked again once the new firmware had finished booting. Anyone hitting
this: retry after a few seconds before assuming the tool or the board is
broken.

### Why a spawned PowerShell process

Bun has no built-in serial port API on Windows, and this repo carries no
native serial dependency (deliberately: this machine is Windows on ARM64,
where prebuilt native npm serial bindings are a frequent source of pain,
see `AGENTS.md`'s toolchain notes for the same problem in a different
guise). `System.IO.Ports.SerialPort` via PowerShell is already the
pattern this repo's own gotcha list points at (`AGENTS.md`: "Serial needs
DTR"), so `dev.ts` spawns a small PowerShell script
(`rp2350-devlink-bridge.ps1`, written to a temp file at run time from a
string constant in `dev.ts`, not committed separately) that:

1. Opens the port with `DtrEnable = $true` set **before** `Open()`. Getting
   this order wrong is the single most likely reason a first real run
   would fail silently (the port opens, but the device never responds,
   and it looks exactly like a dead board).
2. Relays serial bytes to its own stdout on a background PowerShell
   runspace (so reading the port never blocks writing to it).
3. Reads lines from its own stdin on the main thread and writes each as a
   line to the port.

`dev.ts` talks to that child process exactly like it would talk to the
device directly: write a command line to the child's stdin, read reply
lines from the child's stdout. All of the protocol logic (line framing,
RLE/base64 decoding, PNG encoding) was originally verified against a fake
stand-in process, and the three bullet points above (real `SerialPort`
behaviour) have since been verified against the real board too (see
"Bring-up notes" above).

One thing this bring-up found that was not about `SerialPort` behaviour at
all: `Bridge.close()` called `proc.kill()` and returned without waiting for
the child to actually exit. `COM4` is exclusive, so two `bun tools/dev.ts`
invocations run back to back could race for it: the first one's PowerShell
child could still be in the process of dying (and still holding the port
handle) when the second one tried to open it. This is the likely explanation
for one bring-up failure (`switch` timing out mid-chain, right after `app`,
in `bun tools/dev.ts app && bun tools/dev.ts switch 0 && ...`; retried alone
it worked immediately), though it was not cleanly isolated from other noise
in the same session (see the next paragraph). `close()` now awaits
`proc.exited` (bounded to 2s, in case the child is ever wedged) before
returning, and every call site awaits `close()` in its `finally` block; the
same chained sequence was reliable across several repeats after this fix.
This is a real, fixed bug regardless of whether it was the exact cause of
that one timeout: the old `close()` provided no guarantee the port was free
when it returned, which is worth fixing on its own given `COM4`'s exclusive
access.

### PNG encoding

No image library. `encodeGreyPNG()` in `dev.ts` builds a minimal 8-bit
greyscale PNG by hand: one `IDAT` chunk, filter type `None` on every
scanline, compressed with `Bun.deflateSync`. One wrinkle: `Bun.deflateSync`
produces raw DEFLATE (RFC 1951), but PNG's `IDAT` requires a zlib-wrapped
stream (RFC 1950: a 2-byte header plus a 4-byte Adler-32 trailer), so those
are added by hand around the compressed bytes. This was verified during
development by decoding the resulting PNG independently through Node's
`zlib.inflateSync` (a decoder this repo did not write) and comparing every
recovered pixel back to the source image; it is not a claim taken on
faith.

### Known limitations

- All six subcommands (`ping`, `shot`, `app`, `switch`, `tap`, `erase`,
  `draw`) have been run against real hardware (see "Bring-up notes" above).
  `draw` was only checked for a clean `DOWN`/`MOVE`/`MOVE`/`UP` round trip
  against the running stopwatch app, which does not react to touch visually;
  it was not checked against the sketchpad, so a real stroke's visual result
  (as opposed to the reply sequence) is still unverified.
- `draw` paces `MOVE` commands 20ms apart; real touch reports arrive at
  roughly 58Hz (~17ms) per the runtime's profiling notes, so this is in the
  right ballpark but not tuned against a real stroke.
- Injected samples are merged into the real touch stream by timestamp, with
  ties broken toward the injected one; see `sensors.c`'s injection-ring
  comment. Driving `devlink` and a real finger at once no longer corrupts
  anything, but the interleaved result is still confusing to watch and there
  is no reason to do it.
- `log` has no way to distinguish "device idle" from "bridge died"; both
  show up as a read timeout. If output stops unexpectedly, check that the
  PowerShell child is still alive (Task Manager, or rerun with
  `DEVLINK_PORT` pointed at a definitely-wrong port name and confirm you
  get an immediate "failed to open" instead of a silent hang, as a smoke
  test of the error path).
- `KEY`, `BOOT` and `CHORD` have been run against real hardware: `chord`
  opened the menu (`dev.ts app` went from `APP 0 chrono` to `APP -1 menu`
  with no human touching a button), confirmed by both a `shot` framebuffer
  dump and a photograph of the physical panel, and `chord` sent a
  second time closed it back to `chrono` again, proving the gesture is
  symmetric the same way the real button chord is (see `runtime_core.c`).
  Remember what this does and does not prove: see "What injection cannot
  test" above. `key`/`boot`'s individual subcommands (as opposed to the
  `chord` composite) have been exercised by `devlink_dispatch()`'s own
  parsing logic and by `chord` internally, but not yet driven standalone
  against an app that reads `KEY_SHORT`/`bootClicked` directly (the
  stopwatch's start/stop, the timer's pause) - that is the next thing to
  check by hand if either of those stops responding to `dev.ts key short` or
  `dev.ts boot click`.
