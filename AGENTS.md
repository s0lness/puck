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
and `wasm/`: a device-agnostic emulator and verifier. `packs/` contains
self-contained device folders an LLM can target, with
`packs/rp2350-touch-amoled-18/` as the reference pack. `apps/` contains
portable app bundles, with `apps/chrono/` as the reference bundle. Read
[`docs/convention/`](docs/convention/) before changing either format.

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

`bun run pack:build` swaps the example for the puck's real firmware,
writing the same `wasm/dist/emu.wasm`. It needs `zig`, and its wasm link
segfaults on roughly one run in three; that is a known zig bug, not your
change, so run it again. `bun run pack:screens` regenerates
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
touch stroke and confirms the panel actually changed.

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
runs at that board's panel size with that board's buttons.
`bun run verify-silhouette` drives the first such cell headlessly (fluidbox
on the M5StickC PLUS2) and writes
`packs/silhouettes/m5stickc-plus2/proof/fluidbox.png`.

`bun run harness:selftest` proves the differential test harness's own
mechanism works, with no real hardware required (see `harness/fixtures/loopbackLink.ts`'s
header comment for exactly what that does and does not prove).

`bun run harness:hardware` is the same harness against the actual board on
USB (`harness/links/devlinkLink.ts`), and `bun run harness:hardware:pacing`
measures what screenshot rate that board tolerates. Both need hardware and
both say so and exit `2` within about a second when there is none. Read
[`docs/harness.md`](docs/harness.md)'s "Against the real board" before
running either: a hardware run SWITCHES APPS, which zeroes the app arena,
so it destroys whatever the owner had on screen (a drawing, a running
timer). It never reflashes and never leaves the port held.

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

`bun run test:external` proves `tools/externalBuild.ts`, the one
clone-pin-run implementation behind a bundle port that is built by
someone else's repository, against the in-repo fixture (no network). The
end-to-end version of the same thing is `bun run verify-bundle
test/fixtures/external-bundle`. Read
`docs/decisions/0005-external-ports-are-reproduced.md` first, including
its trust model: verifying such a bundle means running that repository's
build command on this machine.

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
- **No em dashes**, anywhere, including code comments and docs. Use
  commas, colons, parentheses, or periods.
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
harness/        the differential test harness: replay a trace through the
                emulator (emulatorSide.ts, a thin node:fs wrapper over
                src/replayCore.ts) and through a pluggable HardwareLink
                (hardwareSide.ts, types.ts), diff the results (src/compare.ts,
                diff.ts). fixtures/loopbackLink.ts is a FAKE link for
                testing the harness itself, not real hardware - see
                docs/harness.md.
test/regression/ builds two tiny fixture firmwares (one draw call
                different between them) and proves the hardware-free
                regression check actually catches the difference - see
                docs/harness.md and run.ts's own header comment.
test/wasi/      two fixture firmwares that import wasi_snapshot_preview1
                deliberately (one supported, one not), and the proof that
                the WASI-lite shims are deterministic and that anything
                outside the supported four is refused by name.
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
tools/          verify-bundle.ts (the listing verifier),
                verdict.ts (go/degraded/refuse from a descriptor's demands
                against a device.json),
                externalBuild.ts (clone a repo at a pinned commit, run
                its own build command, take the artifact - used by the
                verifier and by anything else that later needs an
                external module) and ci-verify-registry.ts.
docs/           abi.md (the ABI as a page), requirements.md, agent-loop.md
                (the optional freeze/annotate layer, plus the failed-
                regression-check export), harness.md (also covers the
                hardware-free regression check), convention/ (pack and app
                formats), and decisions/ (the why).
scripts/        scripts/verify.ts: headless proof the page works and, once
                a wasm module exists, that it actually renders in response
                to real input.
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
packs/          self-contained device folders. The reference pack is
                rp2350-touch-amoled-18, which owns its board firmware,
                drivers, build, checks, descriptor, gotchas and decisions.
                `bun run pack:build` writes wasm/dist/emu.wasm.
apps/           portable app bundles defined by descriptors and traces.
                chrono is the reference bundle and includes a source
                snapshot from the reference pack.
registry.json   local pack and app paths, plus the registration point for
                external bundles by URL.
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
