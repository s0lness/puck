# AGENTS.md - Pico Display Pack 2.0 on a Pico 2, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board, which is two boards

Pimoroni's Pico Display Pack 2.0 (2.0 inch IPS, 320x240, ST7789, 65K
colours, four tactile buttons and an RGB LED) soldered onto a Raspberry Pi
Pico 2 (RP2350, dual Cortex-M33 or dual Hazard3 to 150MHz, 520KB of SRAM in
ten banks, 4MB of QSPI flash, no PSRAM populated). Both halves are named in
`device.json`'s provenance, because a number read off one of them is not a
fact about the other.

This is the only silhouette here that is not an ESP32, which is most of why
it is worth carrying: it is the RP2350 the reference pack already targets,
behind a panel half the size and four buttons instead of two.

Four things about the descriptor are decisions rather than transcription,
and each is stated in `device.json`'s own `provenance.note` as well:

- **The roles are a split this file chose.** All four buttons are ordinary
  GPIOs pulled up, so any of them could be timed. A is declared the `key`
  with an 800 ms threshold and B, X and Y stay plain `click`s. Nothing on
  the board says that; it is what makes a two-control app like chrono land
  as a `go` rather than as a substitution, and it is a claim this file is
  making, not one it read.
- **A/B/X/Y are firmware names.** They are what Pimoroni's own driver
  header calls them. The product page text does not spell the silkscreen
  out, so a reader with the board in hand is the one who can settle it.
- **The RGB LED is real and is not declared.** `emu_device()` has no output
  a host could draw for it, and inventing one would be describing this file
  rather than the board.
- **No touch, no IMU.** `touch.points` is 0 and `sensors` is empty. tinydraw
  and fluidbox are both refused here, each for its own stated reason.

## Running a cell

The browser is the device that actually runs an app here (`packs/web`),
compiled against THIS descriptor rather than its own:

```
bun run pack:web:silhouette pico-display-pack-2 --app apps/chrono/ports/web/chrono.c --landscape
```

writes `packs/web/dist/silhouettes/pico-display-pack-2/chrono/`, a
standalone page whose panel is 320x240 and whose ghost buttons are A, B, X
and Y, because the module's own `emu_device()` says so. `bun run ledger`
builds every app against every silhouette this way and writes the proof
under `proof/`.

`bun run verdict <app> pico-display-pack-2` is the mechanical read of
whether an app fits here at all, before any of that.

## What this does NOT prove

Everything a chip decides. There is no driver, no SPI timing, no ST7789
init sequence, no PIO, no measured frame rate and no memory pressure. A
silhouette proves the app's own logic runs at this size, with these
controls, inside a budget somebody wrote down from a datasheet. Nothing
here has ever met the board, and in particular nothing here has ever put
the Display Pack on a Pico 2 and looked at it.
