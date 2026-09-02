# AGENTS.md - LILYGO T-Display-S3, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board

LILYGO's T-Display-S3: a stick of a board with a 1.9 inch 170x320 colour
TFT (ST7789V driven over an 8-bit parallel bus rather than SPI), an
ESP32-S3R8 (dual core to 240MHz, 16MB flash, 8MB OPI PSRAM), a battery
connector, and two tactile buttons plus a reset.

Four things about the descriptor are decisions rather than transcription,
and each is stated in `device.json`'s own `provenance.note` as well:

- **There is no touch on this board.** `touch.points` is 0. LILYGO sells a
  separate T-Display-S3-Touch with a capacitive digitizer; that is a
  different board and would be a different silhouette. Every app whose
  input is a finger on the glass is refused here, which is the point.
- **There is no IMU.** `sensors` is empty rather than optimistic, so
  fluidbox is refused on this board and told why.
- **BOOT is a `click`, GPIO14 is the `key`.** Both are ordinary buttons,
  but BOOT is sampled by the ROM as a boot strap at power-on, so an app
  timing a long press on it is asking the board for something it was not
  wired to promise. GPIO14 has nothing else attached to it, so it carries
  the press/release/verdict role. Its 800 ms threshold is this file's own
  choice; no board fact sets it.
- **PSRAM is not in the RAM budget.** 8MB exists, it is off-chip and
  slower, and nothing here has measured what an app can do through it.

## Running a cell

The browser is the device that actually runs an app here (`packs/web`),
compiled against THIS descriptor rather than its own:

```
bun run pack:web:silhouette lilygo-t-display-s3 --app apps/chrono/ports/web/chrono.c --landscape
```

writes `packs/web/dist/silhouettes/lilygo-t-display-s3/chrono/`, a
standalone page whose panel is 170x320 and whose ghost buttons are BOOT and
IO14, because the module's own `emu_device()` says so. `bun run ledger`
builds every app against every silhouette this way and writes the proof
under `proof/`.

`bun run verdict <app> lilygo-t-display-s3` is the mechanical read of
whether an app fits here at all, before any of that.

## What this does NOT prove

Everything a chip decides. There is no driver, no parallel bus timing, no
ST7789V init sequence, no measured frame rate and no memory pressure. A
silhouette proves the app's own logic runs at this size, with these
controls, inside a budget somebody wrote down from a datasheet. Nothing
here has ever met the board.
