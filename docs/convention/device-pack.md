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

## Silhouette packs

A silhouette is a pack with **no firmware**: one `device.json` and one `AGENTS.md`, nothing else. It exists so an app can be compiled and run against a device whose firmware nobody has written yet, and so `puck verdict` can answer "would this app fit here" before a line of C exists.

```
packs/silhouettes/<name>/
  device.json     the descriptor, the budget and the provenance
  AGENTS.md       what the board is, what is unverified, how to run a cell
  proof/          screenshots a headless run produced (optional, generated)
```

A silhouette runs, it does not draw. `packs/web`'s host compiles an app's own C against the silhouette's panel size, buttons and sensors (`packs/web/wasm/build.ts --device <path>`) and the page builds its chrome from that same descriptor at runtime, exactly the way it does for a real pack. So a silhouette cell in the gallery is the app's real logic at that device's real size, and nothing about it is a mockup. What a silhouette does NOT prove is anything a chip decides: no driver, no timing, no memory pressure, no silicon. That is the whole reason the format carries a `provenance` block and states it in the negative.

### Required fields

`device.json` is the `emu_device()` JSON a firmware would return (`docs/abi.md`), plus two blocks a firmware could not know about itself.

- `convention`, `name`: the schema version and the device's own name.
- `panel`: `w`, `h`, `format`. The format decides whether the panel is a colour one: anything starting with `rgb` or `bgr` is colour, anything else is not.
- `buttons`: `id`, `label`, `edge`, `at` (0..1 along that edge), and **`role`**, one of:
  - `click`: a plain momentary button. The runtime calls a click on the release edge, and that is all an app sees.
  - `key`: a button reported with press and release edges plus a short/long verdict. A `key` MUST declare `longPressMs`, because the verdict is what makes it a key: a host with no threshold to time against emits no verdict at all, and an app waiting for a short press waits forever.
  - `power`: wired to the power path. Declared so the board is described honestly, never offered to an app.
  - `reset`: resets the MCU and cannot be read. Usually left undeclared rather than declared, since there is nothing for a host to draw a button for.

  `click` and `key` are the two roles an app may demand. Real packs carry roles too (`packs/web`, `packs/rp2350-touch-amoled-18` and `packs/esp32-s3-touch-amoled-18` all declare `boot` as `click` and `pwr` as `key`); a silhouette is only where the field became required.
- `touch`: `{ "points": n }`, `0` for a board with no digitizer.
- `sensors`: the same array a firmware declares. `kind` is `event` for a discrete signal (`shake`), `vector` or `gravity` for a continuous gravity direction, `stream` for a raw sample stream.
- `budget`: what the silicon would afford, which is the part `emu_device()` has no way to state.
  - `ram`: `{ "bytes": n, "basis": "<how that number was arrived at>" }`. The bytes an app's own state may use, after the framebuffer and whatever the platform reserves. The basis is mandatory prose: an undefended number here is a number a verdict would quote as if it had been measured.
  - `framebuffer`: `full` (the whole panel fits in RAM at once) or `banded` (it does not, and the runtime renders in bands, the way `packs/esp32-s3-touch-amoled-18` does).
  - `tickBudgetMs`: how long one tick may take before the device misses its own frame rate.
  - `tickBudgetBasis`: optional prose, and expected wherever that number is derived rather than obvious. A 16 on a 60 Hz colour panel needs no defence; the 300 on [`watchy`](../../packs/silhouettes/watchy/) is Good Display's own partial-refresh time for that e-paper, and an undefended 300 would be exactly the number `ram.basis` already refuses to let `ram.bytes` be. Note what this dimension does NOT model: it says how long a tick may take, never how often a frame appears, so an app whose tick fits inside 300 ms still gets three frames a second on that board.
- `provenance`: where the numbers came from.
  - `datasheet`: a URL a reader can check.
  - `verified`: `false` until somebody has run this silhouette's own numbers against the physical board. The string `"unverified against silicon"` belongs in `note` while that is the case, and the gallery says so wherever the silhouette appears.
  - `note`: anything derived rather than read, named as derived.

A silhouette that is not a real board at all declares `"hypothetical": true` in `provenance` and says what it stands for. Nothing else about the format changes: a hypothetical device still has to be a device an app could genuinely be compiled against.

### Registration

`registry.json` carries silhouettes in their own array, separate from `packs`, because a silhouette is not a pack: it satisfies none of the required contents above (no firmware, no build script, no gate) and a tool that walked `packs` expecting a `wasm/build.ts` would be right to fail on one.

```
"silhouettes": [
  { "name": "m5stickc-plus2", "path": "packs/silhouettes/m5stickc-plus2" }
]
```

There are five, and each one earns its place by a refusal the others cannot make. A silhouette that only ever says yes is a silhouette that proves nothing.

- [`m5stickc-plus2`](../../packs/silhouettes/m5stickc-plus2/): three buttons and an IMU. The one that says yes, and where the first cell was proven.
- [`feather-esp32s2-tft`](../../packs/silhouettes/feather-esp32s2-tft/): one usable button, no IMU. `bun run verdict chrono feather-esp32s2-tft` says no, and says why.
- [`lilygo-t-display-s3`](../../packs/silhouettes/lilygo-t-display-s3/): no digitizer and no IMU, so tinydraw is refused for touch and fluidbox for gravity, each in one line.
- [`pico-display-pack-2`](../../packs/silhouettes/pico-display-pack-2/): the only non-ESP32 target here, four buttons, and the cell that comes out a clean `go`.
- [`watchy`](../../packs/silhouettes/watchy/): 200x200 e-paper, `mono1`, four buttons and none of them a `key`. The first target that is not a colour screen: it refuses every app whose colour carries information, degrades the ones that ask for a key, and its panel rather than its CPU sets its tick budget.

## Running a silhouette cell, and what writes the proof

`bun run ledger` ([`tools/ledger.ts`](../../tools/ledger.ts)) compiles every app in `registry.json` against every silhouette in it, opens the resulting page headlessly, asserts the canvas is that board's declared panel, and writes `packs/silhouettes/<name>/proof/<app>.png`. That picture is the whole mechanism's honesty check, and it is where a port that hardcoded another board's panel size gets caught: it compiles, it instantiates, and what comes out is empty, or clipped, or a module trapping on a memory access out of bounds. None of those is skipped; each one is a cell on the gallery with its reason on it. `bun run verify-silhouette` is a second, deeper proof of one hand-picked pair and writes its own `proof/fluidbox-tilt.png`.
