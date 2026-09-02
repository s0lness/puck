# AGENTS.md - Waveshare ESP32-S3-Touch-LCD-2.8, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board

Waveshare's ESP32-S3-Touch-LCD-2.8: a 2.8 inch 240x320 colour IPS TFT
(ST7789) with a capacitive touch digitizer (CST328 on the V1 board, CST3530
on V2, both I2C, both stated as 5-point), a QMI8658 6-axis IMU
(accelerometer plus gyroscope, no magnetometer), an ESP32-S3R8 (dual core to
240MHz, 16MB flash, 8MB PSRAM), and an SW6106 battery charge/discharge IC.
Alongside `packs/silhouettes/m5stack-cores3`, this is the second silhouette
in this set with a real digitizer, and the second board an app whose only
input is touch can finally run against.

## The button roster

Waveshare's own page lists three onboard controls, and each earns a
different role:

- **BOOT is `role: "click"`, not `key`.** GPIO0 on an ESP32-S3 is sampled
  by the ROM as a boot strap at power-on, the same fact
  `packs/silhouettes/lilygo-t-display-s3` states about its own BOOT: timing
  a long press on it during normal operation asks the board for something
  it was not wired to promise.
- **PWR is `role: "key"`.** Waveshare's page calls it the "Battery Power
  Control Button" and adds "relevant driver program is required" - a claim
  that firmware reads this line through the SW6106 rather than it being a
  pure hardware latch, the same distinction `packs/silhouettes/m5stack-
  cores3` draws between its own software-readable PWR and its
  hardware-only RESET. `longPressMs` is 1200: Waveshare states no
  threshold, so this is this descriptor's own choice, the same kind of
  undefended number `lilygo-t-display-s3`'s own 800ms is.
- **RESET is undeclared**, the same call every silhouette here makes: it is
  wired to EN and a press resets the MCU rather than producing a readable
  event.

Unlike `packs/silhouettes/m5stack-cores3`, both of this board's usable
buttons are genuinely separate physical switches, on their own GPIOs, off
the touch panel entirely - there is no shared-digitizer caveat to state
here, which is itself worth naming since the sibling silhouette needs one.

## Running a cell

```
bun run pack:web:silhouette waveshare-esp32-s3-touch-lcd-2.8 --app apps/tinydraw/ports/web/tinydraw.c
```

writes `packs/web/dist/silhouettes/waveshare-esp32-s3-touch-lcd-2.8/tinydraw/`,
a standalone page whose panel is 240x320, whose touch surface is live, and
whose ghost buttons are BOOT (click: tinydraw's undo) and PWR (key: cycles
tinydraw's zoom), because the module's own `emu_device()` says so.

`proof/<app>.png` is written by `bun run ledger` for every app against every
silhouette (`scripts/silhouetteProof.ts`). `bun run verify-silhouette
--silhouette waveshare-esp32-s3-touch-lcd-2.8 --app apps/tinydraw/ports/web/tinydraw.c --stroke`
is the deeper proof for this board: it draws a synthetic stroke across the
panel and asserts ink actually appeared.

`bun run verdict tinydraw waveshare-esp32-s3-touch-lcd-2.8` is the
mechanical read of whether tinydraw fits here at all, before any of that.

## What this does NOT prove

Everything a chip decides: no driver, no I2C, no CST328/CST3530 init
sequence, no QMI8658 axis convention, no measured frame rate, no memory
pressure. A silhouette proves the app's own logic runs at this size, with
these controls, inside a budget somebody wrote down from a datasheet.
Nothing here has ever met the board.
