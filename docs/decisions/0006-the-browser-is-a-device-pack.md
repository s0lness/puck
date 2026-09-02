# 0006: The browser is a device pack, not a mock target

Date: 2026-09-02
Status: accepted

## The question

Every pack before this one was a chip: real firmware, a real board, a real
flash cycle waiting at the end of it. A browser has none of that, so the
obvious shape for it was a convenience layer, a way to preview an app
without hardware, kept outside the pack convention because it is not
really a device. `packs/web` was built to the opposite answer.

## The decision

[`docs/convention/device-pack.md`](../convention/device-pack.md) states it
plainly: "nothing above says hardware." A pack describes a panel, some
inputs, some sensors and a memory model, and a browser has all four -
`packs/web/device.json` declares the same 368x448 panel and the same two
buttons the RP2350 and ESP32-S3 packs do, backed by a real digitizer and a
real accelerometer (`devicemotion`), not a synthetic stand-in for either.
So `packs/web` is a device pack under this repository's one convention,
not an exception carved out beside it: same `AGENTS.md`, same
`gotchas.md`, same `wasm/build.ts` writing the same `wasm/dist/emu.wasm`,
same `gate/device-agrees.ts`, same `bun run verify-bundle` deciding
whether its ports are real.

Self-containment cuts both ways here, and it is the interesting part.
`packs/web` does not invent its own app contract; it **vendors** the
RP2350 pack's `app.h` and `gfx.h`, with attribution
(`packs/web/NOTICE.md`), rather than importing across into that pack's
folder, which the convention forbids a pack from doing to a sibling. The
payoff is mechanical, not aspirational: `apps/chrono/ports/web/chrono.c`
diffs pixel-exact at tolerance 0 against the RP2350 module on both of
chrono's traces, and `apps/fluidbox/ports/web/fluid.c` is a byte-for-byte
copy of the RP2350 port's source that compiles here unedited. A port
written for one pack compiling against the other, unedited, is the actual
test of "is this the same kind of thing," and a metaphor does not pass it.

A pack may also emit more than a module. `packs/web/wasm/build.ts` has a
second mode that writes a standalone, installable page (a PWA) around the
module - this pack's equivalent of the RP2350 pack's `.uf2`: the artifact
you actually put on the target device, which for this device is "add to
home screen," not a flash tool.

## Consequences

- A future pack does not need a chip to qualify. The bar is the four
  things `device.json` declares, not a bill of materials.
- A pack that adopts a sibling's contract must vendor it with attribution,
  never reach across the repository boundary; `packs/web/NOTICE.md` is the
  worked example other adopting packs should follow.
- The gallery and the verifier treat `packs/web` exactly like the other
  two: no special-cased "preview only" path anywhere in `tools/verify-bundle.ts`
  or `site/build.ts`.
