# Device packs

A device pack is a self-contained folder for one hardware target. The folder, not this repository, is the unit of portability. Copying it elsewhere must leave it usable with a pinned puck checkout.

## Required contents

- `AGENTS.md`, the entry point for a person or LLM working on the device.
- `device.json`, the `emu_device()` descriptor plus a convention version and memory model. The implementation is the source of truth, and the file must match it.
- Vendored drivers, including local patches and documentation explaining every patch that must survive an upstream refresh.
- `gotchas.md`, the hardware traps earned through measurement and debugging.
- `gate/`, or an equivalent set of fast checks for device-specific invariants.
- A reference firmware implementing the app contract: `enter`, `tick`, and `leave` callbacks driven by a per-frame input struct.
- A build script that compiles the reference firmware and writes the pinned puck checkout's `wasm/dist/emu.wasm`, so `bun run dev` displays the device.

Nothing inside a pack imports emulator internals. The pack implements the public ABI and writes the agreed artifact. The dependency does not run in the other direction.

Packs may live under this repository's `packs/` directory or in an author's own repository. Local packs use a `{"name","path"}` entry in `registry.json`. External packs use a `{"name","url"}` entry.

The reference pack is [`packs/rp2350-touch-amoled-18`](../../packs/rp2350-touch-amoled-18/).

`bun run pack:lint` ([`tools/pack-lint.ts`](../../tools/pack-lint.ts))
checks every local pack in `registry.json` against this list mechanically:
`AGENTS.md` exists, `device.json` parses and carries the fields above plus
`emu_device()`'s own required fields, `gotchas.md` is present and
non-empty, `wasm/build.ts` exists and bounds every zig attempt with a
per-attempt timeout, and either `gate/` exists or the pack's own
`AGENTS.md` names its equivalent under a `## Gate` heading. External
(`url`-only) packs are not checked, since nothing about them exists on
this machine to lint. One line per violation, exit 1; clean is exit 0.

## A target device is not necessarily a chip

Nothing above says "hardware". A pack describes a panel, some inputs, some sensors and a memory model, and a browser has all four, so [`packs/web`](../../packs/web/) is a device pack under this same convention rather than an exception to it: same `device.json`, same `AGENTS.md`, same `gotchas.md`, same `wasm/build.ts` writing the same `wasm/dist/emu.wasm`, same `bun run verify-bundle` deciding whether its ports are real.

Two consequences worth stating, because both are visible in that pack:

- **Self-containment cuts both ways.** A pack may not import the emulator's internals, and it may not import a sibling pack's either. `packs/web` adopts the RP2350 pack's app contract by VENDORING `app.h` and `gfx.h` with attribution (see its `NOTICE.md`), never by reaching across into that folder. The payoff is concrete: a port file written for one compiles against the other unchanged.
- **A pack may emit more than a module.** `packs/web/wasm/build.ts` has a second mode that writes a standalone, installable page around the module. That is this pack's equivalent of the RP2350 pack's `.uf2`: the artifact you actually put on the target device.
