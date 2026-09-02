# Port verdict: web (Web-Touch)

## Verdict: go, mode adaptation, NOT degraded

The RP2350 port of this app is `degraded`, and states why: no tilt on real
hardware (fixed straight-down gravity), 130 particles instead of the
donor's 900, and a 2D box instead of the donor's 3D one. This port is
**go**, because the first of those three - the one the descriptor actually
calls a requirement - is met here for the first time since the donor.

Comparing `apps/fluidbox/descriptor.md`'s `Demands` against
[`packs/web/device.json`](../../../../packs/web/device.json):

| Demand | device.json | Fit |
|---|---|---|
| Continuous per-frame compute for a particle solver | wasm, on whatever the phone or laptop is | met with room to spare; measured below |
| A full-screen redraw every frame | `memory.model: full-framebuffer` | met: the app owns a real framebuffer and pushes the whole panel every tick |
| A colour panel | `panel.format: rgb565be`, 368x448 | met, and it is the exact panel the donor's physical constants were derived from |
| **Motion input.** A continuous gravity vector preferred; a discrete shake event the minimum | `sensors: [{shake, event}, {tilt, vector}]`, both live | **met at the preferred level**, which is the thing that makes this verdict `go` |

The descriptor's Demands say a continuous gravity vector is preferred and a
discrete shake is the floor. On the RP2350 the vector exists in the
emulator only, and the port's own README says so at length: on silicon it
falls back to fixed gravity because wiring a QMI8658 read through
`app_frame_t` was out of that task's scope. Here the vector is real on the
real target - a phone's accelerometer, low-passed, delivered every frame -
so the app's central interaction (turn the device, the liquid pours) works
on the actual device this port ships to, not only on a simulation of it.

`mode` is still **adaptation**, not faithful, and that is not a
contradiction with `go`. Mode describes whether the interaction surface
changed; verdict describes whether the fit costs anything. The interaction
surface did change:

- **there is no physical shake button, and no physical device to shake
  except the phone itself.** Shake is detected from the accelerometer
  (high-pass over the low-passed gravity, three samples over 2.5g, 800ms
  cooldown), which is a real behavioural difference from a discrete IMU
  event on a board: the threshold was not derived from the same
  measurement, and a phone in a hand shakes differently from a puck in a
  fist. `packs/web/gotchas.md` says this rather than hiding it.
- **touch is a finger on the same glass the fluid is drawn on**, so the
  stir gesture and the panel are physically the same surface, which they
  are not on a puck held in one hand and poked with the other.

Verification is therefore invariants, against the same checker and the same
three capture points the RP2350 port uses.

## Zero-diff: achieved, then spent once, deliberately

`apps/fluidbox/ports/web/fluid.c` landed **byte-for-byte identical** to
`apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c`. Not "essentially
identical", not "identical except the includes": `cmp` reported no
difference, and it compiled and ran here with no edit at all. That result
is the milestone this port exists for, and it stands: the file still
compiles unedited on either pack, because the only thing that changed is
expressed in terms both packs define.

**One block now differs**, the particle count:

```
-#define FLUID_N 130
+#define FLUID_N_FIT ((PANEL_W * PANEL_H) / FLUID_PX_PER_PARTICLE)
+#define FLUID_N     (clamped between 16 and 130, see the file)
```

`PANEL_W`/`PANEL_H` are `gfx.h`'s, which both packs declare, so this is
not a retarget: dropped into the RP2350 port unchanged it evaluates to
`164864 / 1268 = 130`, the number that file already writes down, and the
same is true here. Nothing about either 368x448 build moves, and both
bundles still verify.

What it buys is the reason it was spent: this port can now be compiled
against a device that is not 368x448 at all (`packs/web/wasm/build.ts
--device`, `docs/convention/device-pack.md`'s silhouette packs), and the
fluid arrives at a density rather than at a count. On the M5StickC PLUS2
silhouette's 135x240 panel it is 25 particles, which is what `bun run
verdict fluidbox m5stickc-plus2` prints, from this app's own descriptor,
evaluating this same expression. A count written down in a file could not
have done that, and a fluid that filled a small box wall to wall would not
have been this app made small.

Re-verified 2026-08-20, after `fluid.c` stopped reading a private, non-ABI accessor
(`emu_shim_tilt_get()`) and started reading `app_frame_t.tilt` directly - the same
`cmp` command above still reports no difference. The rp2350 pack's tilt is now real on
silicon (`firmware/runtime/tilt.c`); this pack has no chip to be real on, so it feeds the
identical field from an already browser-filtered phone/desktop reading instead (see point 3
below) - different sources, same field, so the file that reads it never had to change.

That was the test of the convention, and it is why the file's own comments
still point at `apps/fluidbox/ports/rp2350-touch-amoled-18/README.md` and
still discuss the RP2350's single core. Rewriting those comments to say
"web" would have been tidier and would have destroyed the only interesting
property this file has. It is the same file.

Three things had to hold for that to work, and all three are the web pack
adopting rather than improving:

1. `app.h` and `gfx.h` are **vendored**, so `PANEL_W`, `PX_BLACK`,
   `px_swap`, `APP_STATE`, `gfx_fill_rect` and `gfx_push` all mean the same
   thing under the same names. `app.h`'s vendored copy now carries
   `app_tilt_t`/`app_frame_t.tilt` too (field for field, same units, same
   meaning as the sibling's) - see this pack's `NOTICE.md`.
2. The `--app` contract (`port_enter` / `port_tick`, `--shake` for
   `wantsShake`) is the sibling's, unchanged.
3. `app_frame_t.tilt` reads the same on both packs. Neither has anything
   to do with the other's real chip (the sibling's QMI8658, filtered by its
   own `tilt.c`) or lack of one (this pack's browser `devicemotion`,
   already low-pass filtered upstream in `src/motion.ts`) - each pack's own
   `wasm/emu_shim.c` populates the field its own way (`sensors_tilt()`
   here, `tilt_submit_device_g()` there), but `fluid.c` only ever reads the
   field itself, never how it got there. That is what makes this port
   read-compatible without a private, pack-specific accessor at all: an
   earlier version of this file (and this section) named one,
   `emu_shim_tilt_get()`, which both shims implemented under an identical
   name and signature for exactly the same reason a one-line rename would
   have broken - the field replaces the accessor, not the other way round.

## Particle count: 130, and what that costs

The port ships `FLUID_N = 130`, the RP2350 port's number, because changing
it is the one edit that would have cost the byte-identical result above.

The browser is emphatically not the constraint. Measured on this machine
(Snapdragon X Elite, Bun's wasm engine), solver plus draw, per `emu_tick`,
averaged over 300 ticks after a 120-tick warmup:

| FLUID_N | ms per tick | share of a 16.67ms frame at 60fps |
|---|---|---|
| 130 (shipped) | 0.186 | 1.1% |
| 300 | 0.512 | 3.1% |
| 600 | 1.413 | 8.5% |
| **900** (the donor's own count) | **2.653** | **15.9%** |

For scale: the donor, an ESP32-S3 at 240MHz with a second core to hide the
solver behind, measured 33-41 simulation steps per second at 900 particles
in 3D, which is 24-30ms per step. The same solver at the same particle
count in 2D costs 2.65ms here, roughly a tenth of that, and still leaves
84% of a 60fps frame for everything else. The O(n^2) neighbour search the
RP2350 port chose over a uniform grid is what makes those numbers grow the
way they do, and even that is affordable at 900.

So "a browser outruns the donor" is not a claim, it is a measurement. What
this port does with that headroom is nothing, on purpose:

- raising `FLUID_N` forfeits the zero-diff result, which is this
  milestone's actual subject;
- `apps/fluidbox/invariants.ts`'s thresholds are documented as calibrated
  against "this port's own FLUID_N=130 build", with the measured good and
  broken values written into that file. A build at 900 happens to pass them
  (checked: it does), but passing a threshold calibrated for a different
  build is not the same as being checked, and
  `docs/convention/publishing.md` is explicit that a check you cannot make
  fail is not a check.

Raising it later is one constant and a recalibration pass over
`invariants.ts`, and the table above is the evidence that the recalibration
is the only real work.

## Proof

```
bun run packs/web/wasm/build.ts --app apps/fluidbox/ports/web/fluid.c --shake
bun run invariants <module>.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json \
  apps/fluidbox/invariants.ts --at 4000,4016,9024
```

2026-08-19:

```
replaying 566 events, capturing at 3 point(s): 4000, 4016, 9024
Web-Touch 368x448, 3 frame(s) captured

-- invariants (apps/fluidbox/invariants.ts) --
PASS: all invariants held over 3 captured frame(s)
```

**The invariants are frame-based and pack-agnostic, and this run is what
proves it.** `apps/fluidbox/invariants.ts` was written against the RP2350
port and never touched for this one: it counts non-background pixels,
measures the settled surface's bucket-median flatness, diffs the frame
before and after the shake, and checks the panel's border ring. Every one
of those is a statement about pixels in a captured frame, so the same file
checks a second pack with no parameter, no branch and no edit. A checker
that had reached for a device fact would have needed one.

The trace replays unchanged too, and reads the same on both packs for a
specific reason: it contains no `vector` events at all (it predates that
ABI addition), so `app_frame_t.tilt` reads its own zero-magnitude default
here as well, `fluid.c`'s own `TILT_MIN_G` fallback fires every tick, and
gravity is fixed straight down for the whole replay. Live tilt is real on
a phone and absent from the recorded proof; that split is deliberate and is
exactly the same one the RP2350 port documents.

## What is untested

The accelerometer path itself. The invariant run above never touches it,
`scripts/verify-site-embeds.ts`'s browser check drives touch and buttons
but cannot synthesise a real `devicemotion` event with real signs, and the
iOS sign convention this depends on
(`packs/web/gotchas.md`, "the iOS accelerometer sign convention is MIXED")
was validated on a physical iPhone on 2026-08-19 for `src/motion.ts` and
copied here. Copied correctly is not the same as re-verified: pouring the
liquid by tilting a real phone at `/web/fluidbox/` is the check that closes
this, and it has not been run.
