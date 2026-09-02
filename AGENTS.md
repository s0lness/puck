# AGENTS.md

## What this is

`puck` is a local development tool for people writing firmware for small
screen-and-buttons devices. The firmware compiles to WebAssembly; this
repo gives it a panel, input devices and a clock, in a browser page served
by a local CLI, so the app logic can be iterated on and debugged without a
flash cycle.

**It runs the firmware's own C, compiled again.** Same source, a different
compiler, a different target than what ships. NOT the same object code as
the shipped binary - see `docs/decisions/0002-two-compilers-not-one.md`
before assuming more than that. This distinction is load-bearing; do not
describe this tool as running "the exact binary" anywhere.

**The repository has three surfaces.** The instrument is `src/`, `harness/`
and `wasm/`: a device-agnostic emulator and verifier, hardened by
`test/hostile/` (firmware built on purpose to break the loader and tick
path, proving the failure is loud rather than silent). `packs/` contains
self-contained device folders an LLM can target: `packs/rp2350-touch-amoled-18/`
(the reference pack, real firmware for the Waveshare RP2350-Touch-AMOLED-1.8),
`packs/esp32-s3-touch-amoled-18/` (the same panel on the lower-memory
ESP32-S3, with no room for a full framebuffer, so its ESP-IDF half paints
in 16 bands of 28 rows instead), and `packs/web/` (the browser itself as a
device pack: same panel and buttons, a real accelerometer, a build that
also emits an installable PWA page per app - see
`docs/decisions/0006-the-browser-is-a-device-pack.md`). `apps/` contains
portable app bundles: `apps/chrono/` (the reference bundle, a stopwatch),
`apps/fluidbox/` (a tilt-driven particle-fluid scene, degraded and
invariant-verified on its adapted port), `apps/tinydraw/` (a
finger-drawing canvas, an external author's own app registered by URL and
also carried as a local bundle), and `apps/gameos/` (a handheld
game-console shell that vendors a donor's real engine, and on its esp32
port the donor's real shell too - see
`docs/decisions/0007-gameos-vendors-the-donor-shell.md`). Any app or pack
that carries someone else's source keeps it under its own `reference/`
folder with a `NOTICE.md` stating exactly what came from where and under
what licence; read that file before touching any of it.

Read [`docs/convention/`](docs/convention/) before changing any of these
formats. Porting or publishing an app follows
[`skills/puck-publish/SKILL.md`](skills/puck-publish/SKILL.md) step by
step; every proven pack+app combination is published live at
[`site/`](site/), whose `dist/` output is **committed** and served as-is
by Cloudflare Pages (no Pages-side build step - a site change is not live
until `bun run site:build` has actually run and its output has actually
been committed).

The reference pack is real firmware for the Waveshare
RP2350-Touch-AMOLED-1.8. Its `AGENTS.md` is the first thing to read before
touching any C, CMake, or board-specific material. It connects to the
instrument through one artifact: its `wasm/build.ts` writes this repository's
`wasm/dist/emu.wasm`.

## How to run it

```
bun install
bun run example:build   # compiles example/firmware/main.c -> wasm/dist/emu.wasm
bun run dev             # http://127.0.0.1:5340
```

`bun run pack:build` swaps the example for the RP2350 reference pack's
real firmware, writing the same `wasm/dist/emu.wasm`. It needs `zig`, and
on this Windows-on-ARM development machine `zig cc` intermittently exits
non-zero (exit 5, no diagnostic text on stderr) - sometimes after writing
a complete, correct module, sometimes writing nothing at all, and worse
under concurrent build load (several builds running at once, on this
machine or a shared one). Measured while chasing what used to be
documented here as "wasm link segfaults roughly one run in three, a known
zig bug": that framing was folklore, not a finding, and mostly not even
zig's own bug - a build script that spawned zig with inherited stdio,
while its own parent process's stdout was itself a drained pipe (piped
through `bun run`, a test harness capturing output, a second build script
one level up...), could see its child die at exit 5 having written
NOTHING, every attempt, while the exact same command typed by hand
succeeded immediately. Every build script in this repo now goes through
`tools/zigSpawn.ts`, which pipes the child's own stdio (so it no longer
depends on an ancestor's) and checks the artifact on disk rather than the
exit code, retrying only a genuinely silent failure. It still needs to
retry sometimes - that part was real - just not blindly, and not for a
reason that turned out to be mostly this repo's own doing. `bun run
pack:esp32:build` does the
same for `packs/esp32-s3-touch-amoled-18/`, and `bun run pack:web:build`
for `packs/web/`; `bun run pack:web:host` builds that pack's second mode
instead, a standalone installable page per app rather than the shared
emulator's module. `bun run pack:screens` regenerates
`packs/rp2350-touch-amoled-18/README.md`'s screenshots from that module, and `bun run pack:demo`
regenerates both READMEs' animated GIF by driving the real page in a real
browser and encoding the frames with `ffmpeg` (a binary this repo invokes,
like `zig`; set `FFMPEG_EXE` if it is not on `PATH`).

To point it at your own firmware instead: write a `build.ts` that compiles
your C to `wasm/dist/emu.wasm` (copy `example/build.ts`'s shape, see
`docs/abi.md`'s "Building your firmware to wasm"), run it, then `bun run
dev`. Live reload picks up a rebuilt module automatically.

`bun run typecheck` must pass before any change is considered done.
`bun run verify` drives the page headlessly with `puppeteer-core` against a
local Chrome install (no bundled download - set `CHROME_PATH` if it can't
find yours) and, if `wasm/dist/emu.wasm` exists, drives a real synthetic
touch stroke and confirms the panel actually changed. `bun run
verify:embed`, `verify:tilt`, `verify:motion`, `verify:drag` and
`verify:gameos-accel` are the same headless-Chrome method, each narrowed to
one feature: the bare `?embed=1` page a public run page iframes, the
rotation-driven tilt sensor steering fluidbox's gravity, live phone
`devicemotion` and desktop drag-as-accelerometer, and the esp32 gameos
port's raw accelerometer stream, in that order. Each script's own header
comment names the exact bug it was written to catch; read it before
assuming what it covers.

### Pack-specific gates

A device pack's own fast, hardware-free checks live beside the pack and
are not part of `bun run verify`, which only exercises the shared
instrument. `bun run pack:esp32:gate` (`packs/esp32-s3-touch-amoled-18/gate/run.ts`)
and `bun run pack:web:gate` (`packs/web/gate/device-agrees.ts`) are each
that pack's own answer to `docs/convention/device-pack.md`'s "`gate/`, or
an equivalent set of fast checks for device-specific invariants": neither
needs a board, a toolchain, or a build, and each catches exactly the class
of bug that pack has actually shipped once - read each script's own header
comment for which. `packs/rp2350-touch-amoled-18` has no `gate/`; its
`AGENTS.md` names `tools/invariants/`, run as the native build's own final
step rather than as a standalone command, as its equivalent (see that
pack's "Gate" section).

`bun run pack:lint` (`tools/pack-lint.ts`) checks every LOCAL pack in
`registry.json` against `docs/convention/device-pack.md`'s required
contents, mechanically: `AGENTS.md` present, `device.json` parses and
carries every field `emu_device()` requires, a non-empty `gotchas.md`, a
`wasm/build.ts` that exists and bounds every zig attempt with a
per-attempt timeout, and either a real `gate/` or an `AGENTS.md` section
literally named `## Gate` stating the pack's own equivalent explicitly.
One violation per line on stderr, exit 1; a clean tree exits 0. Green on
all three packs today: every `wasm/build.ts` imports `tools/zigSpawn.ts`
(whose `runZigCc()` always bounds each attempt with a timeout), which is
what `checkBuildTimeout()` accepts in place of finding the
`timeout:`-bearing `Bun.spawnSync` call it used to look for directly - see
`docs/decisions/0008-the-pack-is-canonical-tiny-computers-consumes-it.md`
for the RP2350 pack's own timeout gap this check was originally written
to catch, since closed.

### The differential harness

`bun run verdict <app> <pack-or-silhouette>` answers, mechanically, whether
an app fits a device: `go`, `degraded` or `refuse`, with a reason per
dimension, from the app descriptor's `json demands` block against the
target's `device.json` (`tools/verdict.ts`, and
`docs/convention/app-bundle.md`). It reads two documents and never touches
a compiler, so it is a comparison, never a prediction that the port runs.
`bun run test:verdict` is its proof, against the real descriptors.

`bun run pack:web:silhouette <name> --app <port.c>` compiles an app against
a **silhouette pack**, a device folder with no firmware in it at all
(`packs/silhouettes/`, see `docs/convention/device-pack.md`). The web pack's
host builds the page from whatever `device.json` says, so the app really
runs at that board's panel size with that board's buttons. There are five
silhouettes: the M5StickC PLUS2, the Feather ESP32-S2 TFT, the LILYGO
T-Display-S3, a Pimoroni Pico Display Pack 2.0 on a Pico 2, and a Watchy,
which is the first target here that is not a colour screen and refuses
every app whose colour carries information.

TWO PROOFS, TWO PICTURES, deliberately not one. `bun run ledger` drives
every app against every silhouette through `scripts/silhouetteProof.ts` and
writes `packs/silhouettes/<name>/proof/<app>.png`: the wide, mechanical
answer to whether that app runs at that size, and the only place a port
that hardcodes another board's panel is caught (its picture comes out
empty, or clipped, or the module traps). `bun run verify-silhouette` is
the deep answer for one hand-picked pair, fluidbox on the M5StickC PLUS2:
it tilts the page with synthetic devicemotion, asserts the fluid poured the
way gravity pointed, and writes `proof/fluidbox-tilt.png`.

`bun run harness:selftest` proves the differential test harness's own
mechanism works, with no real hardware required (see `harness/fixtures/loopbackLink.ts`'s
header comment for exactly what that does and does not prove).

`bun run harness:hardware` is the same harness against the actual RP2350
board on USB (`harness/links/devlinkLink.ts`), and `bun run
harness:hardware:pacing` measures what screenshot rate that board
tolerates; `harness:hardware:esp32` and `harness:hardware:esp32:chrono`
run the identical link against the esp32-s3 board's own traces. All four
need hardware and all say so and exit `2` within about a second when there
is none. Read [`docs/harness.md`](docs/harness.md)'s "Against the real
board" before running any of them: a hardware run SWITCHES APPS, which
zeroes the app arena, so it destroys whatever the owner had on screen (a
drawing, a running timer). It never reflashes and never leaves the port
held.

`bun run portdiff` (`harness/portdiff.ts`) is the PORT differential
harness: given two wasm modules and one trace, it replays the same trace
against both, headless, and diffs the captured frames pixel-exact. This is
what a `faithful` port's actual proof is
(`docs/convention/app-bundle.md`), and `bun run verify-bundle` calls this
same implementation rather than reimplementing the comparison.

`bun run invariants` (`harness/invariantRun.ts`) is the device-agnostic
runner half of "verified by invariants" (an `adaptation` port's proof): it
replays a trace against one module, captures the framebuffer at the
bundle's own stated moments, and hands the frames to whatever checker
module the bundle supplies. The bundle owns the checks; this file only
owns replay-and-capture, so a new invariant-verified app costs zero
changes here.

The checker contract itself lives in `harness/invariantTypes.ts`, not in
that runner, because a checker now runs in two places: under bun, loaded by
path, and inside a browser page checking the frames a real board drew
(`site/attest/`). `invariantRun.ts` opens files, so a checker importing its
types from there would put `node:fs` in a page bundle's import graph.
**A bundle's `invariants.ts` must therefore be a pure function of
`{frames, meta}`** - no `node:*`, no `Bun.*`, no DOM - and must return a
per-invariant outcome for each check it makes, not only a list of failures.
Two of the four statuses carry a distinction worth keeping: `skip` means
the invariant was never about this device, `unevaluable` means it is about
this device and the run could not answer it (no board reports `pushStats`).
Neither fails `verify-bundle`; only the second stops a result being posted.

### Proving a firmware regression, and the instrument's own hostile inputs

`bun run test:devlink` proves the devlink protocol core
(`harness/links/devlinkProtocol.ts`) and its browser transport
(`harness/links/webSerialLink.ts`) against a scripted board, with no
hardware: the reply shapes, the line framing across arbitrary byte chunks,
the trace-event mapping, a whole replay matching its reference at tolerance
zero, a different screen reading as a divergence rather than an error, and
the three ways a board actually fails (going silent, answering `ERR`, and
the port vanishing mid-`SHOT` body). Every failure case ends by asserting
the port was released: a leaked serial port looks like "worked fine" until
the next person tries to open the board.

`bun run test:regression` proves the in-page, hardware-free regression
check (`src/regression.ts`, the "baseline"/"check" buttons - see
`docs/harness.md`) actually catches a firmware regression: it builds two
tiny fixture firmwares that differ by one draw call, and confirms a check
fails and names the exact capture point that changed.

`bun run test:wasi` proves the WASI-lite shims (`src/wasiLite.ts`): a
module may import four `wasi_snapshot_preview1` symbols and no more, they
are answered deterministically from the trace, and anything else is
refused by name. See
`docs/decisions/0004-wasi-lite-not-wasi.md`.

`bun run test:hostile` (`test/hostile/`) proves the emulator fails LOUDLY,
not silently, against firmware built on purpose to break it: every hostile
fixture under `test/hostile/firmware/*.c` is driven through a real dev
server in a real headless Chrome, and each one must land as a clean
`#wasmError` banner, a distinct `#engineDead` banner, or a skipped, logged
"firmware bug:" finding - never an uncaught page error, never a silently
frozen tick loop. See `docs/findings-first-adversarial-pass.md` for the
audit this suite grew out of.

### Publishing: the gate that actually matters

`bun run verify-bundle <bundle>` is **the publishing gate**: the one
command that decides whether a claimed port is real. It rebuilds the
module from the bundle's own declared source (a local pack's own
`wasm/build.ts --app`, or, for an external port, `tools/externalBuild.ts`
cloning and running another repository's own build command at a pinned
commit) and replays its declared traces itself, through the same
`portdiff`/`invariants` code path every other consumer of this repository
uses, never a second implementation. Nothing about a port is ever taken on
prose (`docs/convention/publishing.md`'s "listing is a reproduction, not a
submission"); this is what that sentence means mechanically. `bun run
test:external` proves `tools/externalBuild.ts` itself (the clone-pin-run
step) against an in-repo fixture with no network; see
`docs/decisions/0005-external-ports-are-reproduced.md` for the trust model
behind running someone else's build command on your own machine.
[`skills/puck-publish/SKILL.md`](skills/puck-publish/SKILL.md) is this
same flow written step by step for an agent to follow.

### The site

`bun run ledger` (`tools/ledger.ts`) is what the gallery is built FROM.
It takes every app in `registry.json` (local, and an external one through
the same pinned fetch `verify-bundle` uses) against every target in it
(the three packs, every silhouette, and any pack an app's own bundle names
that this repository does not carry) and writes `ledger.json` at the
repository root: per pair, the mechanical verdict, the emulator mark
(`verify-bundle`), the host mark (`hostdiff`), the key `/api/attest`
counts silicon runs on, the blind mark (read out of `blind-ports.json`),
the silhouette mark and its proof PNG, the shas of its own inputs and the
day it was computed. It is incremental by those
shas (`--force` recomputes; `--app` and `--target` narrow a run), it
prints a table, and it never reimplements a build or a comparison: it
calls `computeVerdict()` in process and runs the two CLIs. See
`docs/decisions/0012-the-gallery-is-built-from-a-ledger.md`, whose "what
this costs" section names the gap in that incremental rule.

`bun run site:build` (`site/build.ts`) builds the public gallery,
`site/dist/`, **from `ledger.json`**: the landing page is the apps-by-
devices matrix, one cell per pair, and every cell is either something that
runs (with a link and a mark per proof), a verdict with its reason, or an
empty state saying what is missing. It also writes every proven
combination's module and run page, a run page for every silhouette cell
that runs, and `/puck-publish/`. Run the ledger first or the build stops
and says so. `site/dist/` is committed and served as-is by Cloudflare
Pages, so a change here is not live until this has actually run and the
result has actually been committed. `site/demo-media/` holds the recorded,
encoded demo loops (GIF, MP4, poster) the matrix cells link to; `bun run
site:record-demos` (`site/record-demos.ts`) regenerates them the same way
`pack:demo` regenerates one pack's own README GIF, by driving the real
page in a real browser.

`bun run site:verify-matrix`, `site:verify-flash-ui`,
`site:verify-attest-ui`, `site:verify-embeds` and `site:verify-web` are
the built gallery's own headless proofs, run against `site/dist/` itself
rather than the dev server: that the landing page is the ledger's own grid
with no blank in it and every silhouette cell that claims to run opens at
that board's declared panel size, that the "Flash to the real device"
section renders and fails cleanly on an unsupported browser, that the
attestation section renders and its counter falls back honestly with no
endpoint and walks a scripted board all the way to a posted result for
both kinds of check (including an invariant that fails by name, and one a
board cannot answer at all, which is shown and not posted), that every card's recorded-loop assets actually exist and the
landing/run-page split behaves, and that `packs/web`'s own installable
`/web/<app>/` pages actually instantiate their module, paint pixels,
respond to a real tap or drag, and register their service worker.

## Conventions

- **TypeScript only, for everything this repo owns.** The page, the wasm
  loader, the server, the build scripts, the tests, the harness, the CLI:
  every one of them is `.ts`. No `.js`, no `.mjs`, no shell scripts, no
  Python. If a runner can't execute TypeScript directly, it goes through
  `bun`, never a JS fallback. This is a hard rule, including for anything
  that looks like "just a build script" or "not really code."
- **Zig (or whatever C-to-wasm32-freestanding toolchain you use) is a
  binary this repo's build scripts invoke, exactly like `git` or `cmake`.
  It is never a language anything in this repo is authored in.**
- **C belongs to firmware, not to this repo's own tooling.** The instrument
  carries `wasm/emu_abi.h` and the worked firmware under `example/`. Device
  packs carry their own firmware, and app bundles may carry reference source
  snapshots. Everything under those firmware and reference boundaries is
  written as firmware, not as repository tooling.
- **Nothing names one device.** No hardcoded panel size, no hardcoded
  button name, anywhere in `src/`, `server.ts`, or `harness/`. A device
  declares its own shape through `emu_device()` (see `docs/abi.md`), and
  everything else is built from that JSON at runtime. If you're about to
  write `368` or `"PWR"` as a literal anywhere outside `example/` or
  `packs/` or `apps/`, stop. That number or name belongs in a pack's own
  `emu_device()` or an app descriptor, not in the instrument. A pack may name
  its own board because it is one board's firmware. The device-specific
  `harness/links/devlinkLink.ts` adapter may import the pack's public USB
  tooling, but shared emulator and harness logic must not.
- **Every executable path a build script needs is env-first.** `ZIG_EXE`,
  `CHROME_PATH`, `FFMPEG_EXE`, `PICO_SDK_PATH` and `PICO_TOOLCHAIN_PATH`
  all follow one shape: read the environment variable first, and only
  then fall back, either to a plain command name assumed on `PATH`
  (`zig`), or, in a few call sites that run only on this project's own
  development machine (`tools/verify-bundle.ts`, `test/external/run.ts`),
  to a personal path baked in as a last resort
  (`C:\Users\sylve\tools\zig\zig.exe` on Windows). That personal fallback
  is a convenience for one machine, never a portability guarantee; it is
  exactly why the environment variable always wins when set, and why
  anyone running this elsewhere sets it rather than relying on the
  fallback resolving to anything sensible.
- **No em dashes**, anywhere, including code comments and docs, with one
  exception: **vendored reference material is exempt.** A `NOTICE.md`,
  licence text, or any source or doc copied byte-for-byte from a donor
  repository (`apps/*/reference/`, a pack's own vendored third-party
  files, `third_party/`) keeps whatever punctuation its original author
  used. This rule governs prose this repository writes, not prose it is
  honestly reproducing from elsewhere.
- **No ASCII art, no badges** in any markdown file.
- **`docs/decisions/`** carries the WHY. This file (AGENTS.md) says HOW.
  The README says WHAT. Keep new architectural choices in a decision
  record, not buried in a comment nobody will find later.

## Layout

```
src/            the page: wasm loader (wasm.ts), panel blitter (panel.ts),
                push-window overlay (overlay.ts), touch-contact overlay
                (touchoverlay.ts), touch defect simulation (touchsim.ts),
                input recorder/replay (recorder.ts/replay.ts), freeze
                bundle (freeze.ts/journal.ts), the hardware-free regression
                check (regression.ts, built on replayCore.ts and
                compare.ts - see docs/harness.md), console pane
                (consolelog.ts), puck chrome (device.ts), audio bridge
                (audio.ts), and main.ts which wires all of it together.
                Deliberately device-agnostic: nothing here should ever
                reference a specific device's panel size or button names.
                replayCore.ts, compare.ts and frame.ts also get imported
                from harness/ (never the other direction: harness/ depends
                on src/, src/ never depends on harness/), so the page and
                the differential test harness share one replay/compare
                mechanism instead of two that would drift apart.
wasm/           wasm/emu_abi.h: the ABI contract, the one file every
                firmware in this ecosystem depends on. wasm/dist/ is
                build output (gitignored).
example/        a tiny, self-contained example firmware (firmware/main.c)
                and its build script (build.ts). Read
                docs/decisions/0001-example-is-minimal-not-a-shim.md for
                why it's minimal rather than a full-featured demo.
harness/        the differential test harness. diff.ts (replay one trace
                against the emulator and a real HardwareLink, then diff),
                emulatorSide.ts (thin node:fs wrapper over
                src/replayCore.ts), hardwareSide.ts/types.ts (the
                pluggable HardwareLink interface), links/devlinkLink.ts
                (this repo's own USB-serial link, shared by both boards),
                fixtures/loopbackLink.ts (a FAKE link for testing the
                harness itself, not real hardware - see docs/harness.md),
                inputs/ (the trace files harness:hardware replays),
                hardwarePacing.ts (measures tolerated screenshot rate),
                png.ts (raw DEFLATE -> zlib-wrapped PNG IDAT, see
                Gotchas), selftest.ts (harness:selftest), portdiff.ts (the
                PORT differential harness: two modules, one trace, diffed
                pixel-exact - a faithful port's proof), and
                invariantRun.ts (the device-agnostic replay-and-capture
                runner behind an adaptation port's stated invariants) with
                invariantTypes.ts beside it (the checker contract alone,
                importing nothing but types, so a bundle's own checker can
                also be bundled into a browser page).
                links/ is the one place the "nothing names one device" rule
                above leaves a seam for a device-specific adapter.
                devlinkProtocol.ts is the wire protocol with no transport
                under it (pure TypeScript: no node:*, no Bun.*, no DOM, no
                pack import, because site/build.ts bundles it into a browser
                page); devlinkLink.ts is that protocol over the pack's
                PowerShell serial bridge; webSerialLink.ts is the same
                protocol over navigator.serial, from a page. One protocol,
                two transports - proven by test/devlink/.
test/devlink/   a scripted devlink board and a fake Web Serial port,
                proving both transports of that one protocol with no
                hardware - including that every exit path gives the port
                back.
test/regression/ builds two tiny fixture firmwares (one draw call
                different between them) and proves the hardware-free
                regression check actually catches the difference - see
                docs/harness.md and run.ts's own header comment.
test/wasi/      two fixture firmwares that import wasi_snapshot_preview1
                deliberately (one supported, one not), and the proof that
                the WASI-lite shims are deterministic and that anything
                outside the supported four is refused by name.
test/hostile/   firmware/*.c: fixtures built on purpose to break the
                loader and tick path. run.ts drives each one through a
                real dev server in a real headless Chrome and asserts it
                is reported loudly (a banner or a named finding), never
                silently. Grew out of docs/findings-first-adversarial-pass.md.
test/external/  proves tools/externalBuild.ts (the clone-pin-run step
                behind an external port's declared build) against
                test/fixtures/external-bundle/, with no network.
test/fixtures/  material that stands in for something outside this
                repository: external-app/ is a whole app in one C file
                (an external repo), external-bundle/ is the bundle that
                points at it by local path. Never listed in
                registry.json: a fixture is test material, not something
                a gallery advertises. test/external/run.ts drives them.
packs/silhouettes/ device folders with NO firmware: a device.json and an
                AGENTS.md, nothing else, so an app can be compiled and run
                against a board nobody has written firmware for yet. See
                docs/convention/device-pack.md's "Silhouette packs".
test/verdict/   proves tools/verdict.ts against the real descriptors and
                the real device.json files, never fixtures: the claim worth
                protecting is that chrono is refused on a one-button board.
tools/          verify-bundle.ts (the listing verifier and actual
                publishing gate), verdict.ts (go/degraded/refuse from a
                descriptor's demands against a device.json, as a CLI and
                as computeVerdict() for callers), ledger.ts (bun run
                ledger: every app against every target, written to
                ledger.json, which is what site/build.ts renders - see
                docs/decisions/0012), externalBuild.ts (clone a repo at a
                pinned commit, run its own build command, take the
                artifact - used by the verifier and by test/external/),
                ci-verify-registry.ts, and pack-lint.ts (bun run
                pack:lint: every local pack in registry.json checked
                against docs/convention/device-pack.md's required
                contents, mechanically).
docs/           abi.md (the ABI as a page), requirements.md, agent-loop.md
                (the optional freeze/annotate layer, plus the failed-
                regression-check export), harness.md (also covers the
                hardware-free regression check), findings-first-adversarial-pass.md
                (the audit test/hostile/ proves stays fixed),
                convention/ (pack and app formats, and publishing), and
                decisions/ (the why).
scripts/        headless proofs and small shared utilities, all puppeteer-core
                against a local Chrome (CHROME_PATH to override):
                verify.ts (the baseline page-works-and-renders check),
                verify-embed.ts (the bare ?embed=1 page a run page
                iframes), verify-tilt.ts (rotation steering the vector
                tilt sensor), verify-motion.ts (live phone devicemotion
                and shake), verify-drag.ts (desktop drag-as-accelerometer),
                verify-gameos-accel.ts (the esp32 gameos port's live raw
                accelerometer stream), verify-flash-ui.ts (the built
                gallery's "Flash to the real device" section, including
                the unsupported-browser path), verify-site-embeds.ts (the
                built gallery's landing/run-page split and recorded-loop
                assets), verify-web-apps.ts (packs/web's own installable
                /web/<app>/ pages: instantiate, paint, tap, drag,
                register the service worker), verify-matrix.ts (the built
                landing page held to ledger.json: the grid is complete,
                every cell is exactly one of runs/verdict/empty state,
                every silhouette cell claiming to run opens at that
                board's own panel size, the external row carries its
                provenance, and a phone scrolls the table rather than the
                page), silhouetteProof.ts (the wide, every-app silhouette
                run tools/ledger.ts drives: build against a device.json,
                open it, assert the panel, write the proof PNG - where
                verify-silhouette.ts is the deep, sensor-specific proof of
                one hand-picked pair), staticSite.ts (the small
                static file server verify-flash-ui.ts,
                verify-site-embeds.ts and verify-matrix.ts share for
                serving site/dist/),
                browserClose.ts (works around Bun-on-Windows missing
                Chrome's final child-process close notification),
                capture-gameos-esp32-shell-frame.ts and
                compare-gameos-esp32-shell-vs-donor.ts (this bundle's
                donor-reference comparison: a captured emulator frame
                against the donor's own vendored screenshot), and
                record-gameos-shell-trace.ts /
                record-gameos-golf-trace.ts (record fresh traces against
                the esp32 gameos port's real vendored shell and its GOLF
                card, replacing traces recorded against an earlier,
                port-authored layout).
server.ts       the local dev server (127.0.0.1 only, see below). Also
                serves the hardware-free regression check's own routes
                (/api/baseline, /api/regression-result), backed by
                baselineStore.ts.
baselineStore.ts disk persistence for the regression check: where a saved
                baseline lives (baselines/latest/) and where a check's
                result gets exported for an agent (regressions/latest/,
                see docs/agent-loop.md). Kept out of server.ts itself so
                test/regression/run.ts can call it directly with no HTTP
                server and no browser.
build.ts        static dist/ build, for serving this page from something
                other than the dev server.
packs/          self-contained device folders, one per target:
                rp2350-touch-amoled-18/ (the reference pack: real board
                firmware, drivers, checks, USB tooling,
                tools/build-native.ts for the native board build and
                wasm/build.ts for the emulator module, both writing to
                the pinned puck checkout, plus tools/invariants/ - its
                Gate section's named equivalent to a gate/ folder),
                esp32-s3-touch-amoled-18/ (the lower-memory sibling: no
                framebuffer, 16 bands of 28 rows over its ESP-IDF half,
                its own gate/), and web/ (the browser as a device: same
                panel and buttons vendored from the RP2350 pack's app
                contract, a real accelerometer, its own gate/, and a
                wasm/build.ts host mode that emits an installable PWA
                page per app).
apps/           portable app bundles, one per app: chrono/ (the reference
                bundle and descriptor, a stopwatch), fluidbox/ (a
                tilt-driven particle-fluid scene, adapted and
                invariant-verified where ported), tinydraw/ (a
                finger-drawing canvas, an external author's own app),
                gameos/ (a handheld game-console shell vendoring a
                donor's real engine and, on its esp32 port, the donor's
                real shell too - see that port's NOTICE.md). Each carries
                descriptor.md, bundle.json, ports/, traces/, frames/ or
                invariants.ts, and, where source is vendored rather than
                original, reference/<donor>/ plus a NOTICE.md.
site/           the public gallery. build.ts writes dist/ (committed,
                served as-is by Cloudflare Pages: modules, one run page
                per pack+app combination and per runnable silhouette
                cell, the landing page as the apps-by-devices matrix read
                out of ledger.json, and /puck-publish/), flasher/
                (WebUSB/Web Serial flashing, bundled into dist/flash/ -
                see NOTICE.md for the vendored esptool-js it ships),
                demo-media/ (recorded, encoded demo loops every gallery
                card links to), record-demos.ts (regenerates them),
                styles.css. attest/ makes a freshly flashed board replay
                the port's own trace and then puts the result through the
                same check verify-bundle uses for that port: a pixel diff
                against the bundle's recorded frames, or that bundle's own
                invariants.ts, bundled into the page by attest/checkers.ts
                (docs/decisions/0011 and its addendum). functions/ is the
                Pages Function, over the ATTEST KV namespace, that counts
                the results, both kinds under one number and tellable apart
                beneath it. Read site/README.md before touching
                any of it, especially where the functions directory has
                to live for Pages to deploy it at all.
skills/         skills/puck-publish/SKILL.md: the step-by-step publishing
                procedure for an agent porting or listing an app -
                docs/convention/app-bundle.md and publishing.md are the
                contract this skill walks through.
registry.json   local pack, silhouette and app paths, plus the
                registration point for external packs and apps by URL
                (an external app entry carries a "commit" pin next to its
                "url": nothing here verifies an unpinned clone).
ledger.json     computed, committed, and what the gallery renders: one
                row per app per target, written by bun run ledger. Never
                edited by hand - a value typed into it is exactly the
                hand-written claim docs/decisions/0012 exists to remove.
blind-ports.json the one thing in this pair that IS typed by hand, and
                says so in its own note: one entry per blind port somebody
                actually ran (an agent with no session context, given a
                pack folder and an app bundle and told to port), which
                tools/ledger.ts reads into each cell's blind mark and
                refills on every run rather than caching, because it is a
                lookup and not a build. Roadmap workstream 4.
```

## Gotchas that bite

- **`server.ts` binds `127.0.0.1` explicitly.** `Bun.serve({ port })` with
  no `hostname` listens on every interface, which puts a local dev tool on
  the WiFi. Never remove the explicit `hostname`.
- **The dev server's live-reload debounces on file STABILITY, not just a
  filesystem event.** A build tool writes a `.wasm` file over time; an fs
  event fires the instant the OS creates or truncates it, long before the
  bytes are actually written. Broadcasting "reload" at that instant serves
  a half-written module, which looks exactly like a hung page. See
  `server.ts`'s `waitForStableFile`.
- **`wasm.ts`'s `instantiate()` validates before ever touching a module
  that's already running.** Magic bytes, then `WebAssembly.instantiate`,
  then (in `main.ts`) `emu_init()` and the device descriptor. A failure at
  any step must never tear down a session that was already working - see
  `main.ts`'s `bringUp`/`failReload`.
- **The freestanding wasm32 target has no `malloc`, `printf`, or
  `math.h`, but DOES have `stdint.h`/`stdbool.h`/`stddef.h`/`stdarg.h`**
  (the C standard's required freestanding headers). See `docs/abi.md`'s
  "No malloc, no libc" before adding a shim header for something that
  might already be available.
- **`--export-dynamic` is unreliable for `zig cc`'s `wasm32-freestanding`
  target** (verified by actually building, not assumed from docs): it can
  silently fail to export what you expect. Export each ABI symbol
  explicitly with `-Wl,--export=<name>` instead - see `example/build.ts`'s
  header comment.
- **`Bun.deflateSync` produces raw DEFLATE, not a zlib stream.** PNG's
  `IDAT` chunk needs the zlib wrapper (2-byte header, 4-byte Adler-32
  trailer) added by hand around it - see `harness/png.ts`.
- **`harness/hardwareSide.ts` never sends `"tick"` trace events to a
  `HardwareLink`.** Real hardware has no ABI-level concept of a
  host-driven synthetic clock tick; it runs its own loop, on its own
  clock, regardless. Tick events are only used as pacing/capture-point
  anchors. If you're writing a `HardwareLink` and touch state seems to
  vanish before your board ever sees it, check that your board (or your
  fake link, see `harness/fixtures/loopbackLink.ts`'s background-tick
  fix) is actually polling continuously rather than only reacting
  synchronously to `send()` calls.
- **On Windows, killing a spawned dev-server child needs the whole
  process tree, not just `kill()`.** `Bun.serve`'s `development.hmr`
  spawns a watcher that can outlive a plain `SIGTERM`. See
  `scripts/verify.ts`'s `finally` block (`taskkill /t /f`) for the
  pattern; it can make the script's own exit take longer than the actual
  test does, which is expected, not a hang.
