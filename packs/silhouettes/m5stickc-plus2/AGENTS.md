# AGENTS.md - M5StickC PLUS2, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board

M5Stack's M5StickC PLUS2: a thumb-sized stick with a 1.14 inch 135x240
colour TFT (ST7789V2), an MPU6886 IMU, an ESP32-PICO-V3-02 (dual core to
240MHz, 8MB flash, 2MB quad PSRAM), a 200mAh battery, and three buttons:
A on the face (G37), B on the side (G39), and the power button (G35).

Three things about the descriptor are decisions rather than transcription,
and each is stated in `device.json`'s own `provenance.note` as well:

- **The power button is `role: "power"`, not a third usable control.** The
  vendor documentation names G35 as the power button and does not say an
  app may read it as an ordinary input. A silhouette does not get to guess
  a control into existence, so it is declared for honesty about the board
  and never offered to an app. If somebody with the board proves G35 reads
  as a plain input, that is a change to this file and to the verdicts that
  fall out of it.
- **There is no digitizer.** `touch.points` is 0. Every app whose only
  input is touch simply has nothing to bind to here, and the verdict says
  so rather than pretending a button will do.
- **PSRAM is not in the RAM budget.** 2MB exists, it is quad SPI rather
  than on-chip, and nothing here has measured what an app can actually do
  through it. The budget is the on-chip SRAM, minus the framebuffer, minus
  a stated reserve.

## Running a cell

The browser is the device that actually runs an app here (`packs/web`),
compiled against THIS descriptor rather than its own:

```
bun run pack:web:silhouette m5stickc-plus2 --app apps/fluidbox/ports/web/fluid.c --shake
```

writes `packs/web/dist/silhouettes/m5stickc-plus2/fluid/`, a standalone
page whose panel is 135x240 and whose ghost buttons are A, B and PWR,
because the module's own `emu_device()` says so. `bun run
verify-silhouette` drives that page headlessly, tilts it, and writes
`proof/fluidbox.png`.

`bun run verdict <app> m5stickc-plus2` is the mechanical read of whether an
app fits here at all, before any of that.

## What this does NOT prove

Everything a chip decides. There is no driver, no I2C, no DMA, no ST7789
init sequence, no MPU6886 axis convention, no measured frame rate and no
memory pressure. A silhouette proves the app's own logic runs at this
size, with these controls, inside a budget somebody wrote down from a
datasheet. Nothing here has ever met the board.
