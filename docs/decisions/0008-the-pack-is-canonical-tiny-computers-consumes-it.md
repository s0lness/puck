# 0008: The pack is canonical; tiny-computers consumes it

Date: 2026-09-02
Status: accepted

## What had drifted

This repository's RP2350 pack was extracted from a private monorepo,
`tiny-computers`, and the extraction was a snapshot: day-one firmware,
frozen in place, while the real device kept living in the source it was
cut from. Tilt sensing, flash-backed storage, an RTC, a second sound
change, a DMA shift-out fix, a QSPI clock halving, a retuned power-off
threshold - none of it made it back here. The pack was, at that point,
the least conformant of the packs to its own device: real, working
firmware that no longer matched what actually shipped.

## The decision

The modern runtime now lives HERE, in `packs/rp2350-touch-amoled-18/firmware/`,
not in `tiny-computers`. `tiny-computers` consumes it, via its own
`sync-pack.ts`, carrying `PACK_PROVENANCE` back to the commit it synced
from - the reverse of the direction the extraction had quietly assumed.
This repository does not host or describe `sync-pack.ts` (it belongs to
that private repository), but the shape of the dependency is the whole
point of the decision: the pack is upstream, the product downstream, and
a change to the device's real firmware lands here first.

Two structural leaks were cut to make that direction actually work for a
firmware that also has to build as a single-app port:

- `firmware/apps/app_roster.inc` replaced hardcoded per-app symbol names
  (`g_chronoApp`, `g_sketchApp`, `g_timerApp`) inside `runtime_core.c`.
  The roster is now the one file every consumer writes for itself; a
  single-app build (`wasm/build.ts --app`,
  `packs/rp2350-touch-amoled-18/tools/build-native.ts --app`) generates
  one into its own out-of-tree build directory rather than forking the
  runtime that includes it.
- `app_t.wantsRawTouch` replaced a `&g_sketchApp` identity comparison
  inside the runtime. A "which app is this" test in shared runtime code
  was a bug, not a shortcut: the fix is a flag on the app itself, not a
  name the runtime has to know.

`build-native.ts`'s own header comment now points a reader at
`tiny-computers`' `devices/rp2350-amoled-1.8/AGENTS.md` for the toolchain
paths this pack's own copy documents only as environment-variable names,
consistent with the direction above: this repository is the source of the
firmware, not the source of one developer's local machine setup.

## Consequences

- A firmware change made only in `tiny-computers` and never synced back is
  now the anomaly to look for, not the default state. Read this pack's
  `AGENTS.md` and `docs/decisions/` here first; `tiny-computers` is the
  consumer's own history of adopting them, not a second source of truth.
- A per-attempt zig timeout, added to the esp32 and web packs' builds
  after an observed 13-minute silent hang on this machine, is not yet on
  this pack's own `wasm/build.ts`: it retries zig up to eight times with
  no bound on any single attempt. `docs/convention/device-pack.md`'s
  `pack:lint` (`tools/pack-lint.ts`) checks every pack's `wasm/build.ts`
  for this mechanically and is red on this pack today for exactly that
  gap, tracked for a follow-up rather than fixed by this record.
- The app-roster and `wantsRawTouch` seams are load-bearing for any future
  consumer that forks the roster: neither is optional scaffolding to
  simplify away, per `packs/rp2350-touch-amoled-18/AGENTS.md`'s "The app
  roster is the consumer's, and it is the only thing that is."
