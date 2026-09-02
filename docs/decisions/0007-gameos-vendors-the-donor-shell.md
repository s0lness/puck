# 0007: GameOS vendors the donor's real shell, not a rewritten launcher

Date: 2026-09-02
Status: accepted

## What shipped first

`apps/gameos`'s ESP32-S3 port originally shipped its own picker,
`launcher.c`: three flat cards on a dark navy field, "TAP A CARD TO
LAUNCH". It compiled, it passed its own invariants, and it looked nothing
like the donor's real device, a fact this bundle's own history already
stated plainly - `launcher.c` was known, on the record, to be this port's
invention rather than a reproduction of anything.

## What changed the answer

Sylve flashed the donor firmware
([`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos))
on his own physical board. The real shell is
`components/gos_shell/{registry.c,apps.c,shell.c}`: a Wii-menu-style tile
grid, a settings screen, a pause overlay, a first-run tilt-calibration
wizard - exactly what the donor's own `media/launcher.png` shows, now
vendored byte-for-byte at
`apps/gameos/reference/esp32-gameos/media/launcher.png`. A port that only
ever checks itself against its own prior captures can drift from the real
device for a long time before anyone notices; a reference screenshot from
the actual donor, taken off actual silicon, is what closes that gap.

## The decision

`launcher.c` is deleted. `registry.c`, `apps.c` and `shell.c` are vendored
unmodified, `#include`d bare into this port's forced single-file build,
next to the engine and font files the port already vendored (see
[`apps/gameos/ports/esp32-s3-touch-amoled-18/NOTICE.md`](../../apps/gameos/ports/esp32-s3-touch-amoled-18/NOTICE.md)
for the full byte-for-byte table and every rename forced by folding
independently-built translation units into one unity build). This port's
own code shrinks to what genuinely has no portable donor equivalent: the
HAL shim (`gos_hal_shim.c`), a handful of compat headers, and
`gameos_port.c`'s three thin forwarding calls into the vendored shell's
own `shell_init()`/`shell_frame()`. The prior ~120-line hand-rolled
`SCREEN_LAUNCHER/GUNSHIP/SLOTS/GOLF` dispatcher is gone entirely, because
the real shell already owns that dispatch.

Verification is re-anchored the same way: `scripts/capture-gameos-esp32-shell-frame.ts`
and `scripts/compare-gameos-esp32-shell-vs-donor.ts` diff this port's
captured shell frame against the donor's own vendored screenshot, not only
against this port's own earlier captures. `skills/puck-publish/SKILL.md`
now requires this class of comparison before listing, whenever a donor
ships its own reference media or a documented host frame-dump harness: see
its step b, "If the donor ships reference media... check it before
listing."

## Consequences

- A donor-authored screen is reproduced from the donor's own source, never
  redrawn from a description of it. `apps/gameos`'s rp2350 port keeps its
  own from-scratch two-card picker deliberately, because that port has no
  equivalent real donor shell to vendor instead - stated plainly in that
  port's own README, not silently inconsistent with this one.
- A future port of a donor-shipped app checks for the donor's own
  reference material first, per the publish skill's new step, rather than
  trusting its own captures to be enough on their own.
