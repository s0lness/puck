# AGENTS.md - Adafruit ESP32-S2 TFT Feather, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board, and why this one

Adafruit product 5300: an ESP32-S2 (single core, 240MHz, 4MB flash, 2MB
PSRAM) with a 1.14 inch 240x135 colour IPS TFT (ST7789) soldered on, and
exactly two tactile buttons, RESET and BOOT0/D0. No IMU, no digitizer.

This silhouette exists for the button count. An app either fits a device
with **one** readable control or it does not, and that is the cheapest
real question a matrix of apps and devices can ask. `bun run verdict chrono
feather-esp32s2-tft` refuses, and names the reason: chrono needs a toggle
and a separate reset, on two different controls, precisely so the
destructive one cannot be hit by accident (its own descriptor says so), and
this board has one control to give.

A refusal shown honestly is worth as much as a port. The alternative, an
app squeezed onto a board it does not fit by quietly collapsing two
controls into one, is how a device ends up erasing somebody's work on a
misfire.

Two decisions rather than transcription:

- **RESET is not declared.** It resets the MCU; no app can read it. A
  declared button that a host would draw and that could never deliver an
  event is a lie with a rectangle around it.
- **No IMU means an empty `sensors` array**, not an optimistic one. Every
  tilt-driven app refuses here, which is the correct answer.

Not to be confused with the ESP32-S2 **Reverse** TFT Feather (product
5345), which carries three user buttons. That is a different board and
would answer a different question; if it is wanted, it gets its own
silhouette.

## Running a cell

```
bun run pack:web:silhouette feather-esp32s2-tft --app <a port's .c>
```

writes `packs/web/dist/silhouettes/feather-esp32s2-tft/<app>/`, a
standalone page whose panel is 240x135 with a single ghost button, because
the module's own `emu_device()` says so.

## What this does NOT prove

Everything a chip decides: no driver, no SPI, no ST7789 init, no measured
frame rate, no memory pressure. The numbers in `device.json` come from a
product page and from Espressif's own SRAM figure for the part. Nothing
here has ever met the board.
