# Third-party code shipped in `site/dist/`

The repository's own licence is MIT (see [`../LICENSE`](../LICENSE)). It does not
cover the code listed here, which comes from elsewhere and keeps its own terms.
This file exists because `site/dist/` is not a build input, it is a **deploy**:
the bundles under `site/dist/flash/` are served to anyone who opens
puck.sylve.org, so whatever is inside them is being redistributed, and the
attribution has to travel with it.

## `flash/esp32-flash.js` - esptool-js, Espressif Systems

`site/flasher/esp32.ts` imports [esptool-js](https://github.com/espressif/esptool-js),
Espressif's own JavaScript implementation of the ESP serial bootloader
protocol, and `site/build.ts` bundles it (with its `pako` deflate dependency)
into `site/dist/flash/esp32-flash.js`. It is what actually talks to the chip:
the ROM loader handshake, the RAM stub upload, SLIP framing, compressed flash
writes and the MD5 read-back. Pinned to an exact version in `package.json`
(`"esptool-js": "0.6.1"`, no caret) rather than a range, because a protocol
implementation that silently changes under a device flasher is not a
convenience.

**Licence: Apache-2.0.** The full text ships in the package
(`node_modules/esptool-js/LICENSE`) and at
https://www.apache.org/licenses/LICENSE-2.0. Copyright Espressif Systems
(Shanghai) Co. Ltd. The licence's conditions on redistribution are met by this
file: the source is named, unmodified, and carries no NOTICE file of its own
that would have to be reproduced.

`pako` (MIT, Vitaly Puzrin and Andrei Tuputcyn) comes in as esptool-js's own
dependency and is bundled with it.

## `modules/aliceisjustplaying-tinydraw-*.wasm` - TinyDraw, alice

The front page's card for `aliceisjustplaying/tinydraw` runs that app's own
module, and none of it was compiled here: `bun run site:external-modules`
clones [aliceisjustplaying/tinydraw](https://github.com/aliceisjustplaying/tinydraw)
at the commit its own `bundle.json` pins and runs that repository's own
`./scripts/build-puck-wasm`. The result is committed under
`site/external-modules/` (with `index.json` recording the repo, the commit,
the command, the artifact path and the module's sha256) and copied into
`site/dist/modules/` by `site/build.ts`, so it is redistributed by this
deploy exactly like the bundles above.

**Licence: MIT.** Copyright (c) 2026 alice; the full text is in that
repository's own `LICENSE` at the pinned commit. `site/demo-media/` also
carries a recorded loop of that module running, captured here through the
same emulator every other clip is.

## `flash/flash.js` - none

The RP2350 flasher is this repository's own code end to end
(`site/flasher/flash.ts`, `picoboot.ts`, `uf2.ts`): the PICOBOOT protocol and
the UF2 format are implemented here against their published specifications, so
that bundle carries nothing but MIT-licensed code from this repository.
