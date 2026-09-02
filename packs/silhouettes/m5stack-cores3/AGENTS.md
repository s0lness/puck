# AGENTS.md - M5Stack CoreS3, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board

M5Stack's CoreS3: a 2.0 inch 320x240 colour IPS TFT (ILI9342C) with a
capacitive touch digitizer (FT6336U, two simultaneous points), a BMI270
6-axis IMU plus a BMM150 magnetometer, an ESP32-S3 (dual core to 240MHz,
16MB flash, 8MB Quad PSRAM), an AXP2101 power management IC, an AW9523B IO
expander, a camera, a speaker and dual microphones. This is the first
silhouette in this set with a real digitizer, which is the whole reason it
exists: every app whose only input is touch has had nothing to bind to on
any of the other five (`docs/convention/device-pack.md`'s own roster).

## The button roster is not a transcription, and it took the most care

- **PWR is `role: "key"`, not `role: "power"`.** Every other power-path
  button in this set (`packs/silhouettes/m5stickc-plus2`) is declared
  `power` because its vendor page never states that software may read it.
  CoreS3 is different: M5Stack's own Arduino tutorial for this exact board
  (`docs.m5stack.com/en/arduino/m5cores3/button`) states that
  `M5.BtnPWR.wasClicked()` and `M5.BtnPWR.wasHold()` both work, which is a
  positive claim of software readability rather than silence. `longPressMs`
  is 500, M5Unified's own `Button_Class` default hold threshold, not a
  number CoreS3's hardware page states.
- **A, B and C are declared, and NONE OF THEM IS A SEPARATE SWITCH.**
  M5Stack's own hardware page for this board never mentions three bezel
  buttons. What actually exists is a software convention some M5Unified
  builds layer onto the SAME FT6336U digitizer this file already declares
  under `touch`: a touch reported in the bottom ~20 pixels of the LCD's own
  active area is treated as a press on zone A, B or C, depending on x
  position. This is NOT the M5Stack Core2's design (a printed pad below the
  glass, on the same digitizer but outside the visible screen); CoreS3's
  touch sensing does not extend past the visible LCD, so a person has to
  touch the display itself. The community's own troubleshooting threads
  (`community.m5stack.com/topic/5809`, `/topic/5565`) say only zone A
  reliably resolves in current M5Unified. So A is declared `role: "click"`
  and B and C are declared with **no role at all** - the same treatment a
  reserved power or reset line gets elsewhere in this convention: named for
  honesty, never offered to an app, because nothing published says code can
  rely on them.
- **A shares its digitizer with `touch.points`.** This is the one thing
  about this board a real port would have to solve that no other silhouette
  here poses: a stroke that ends near the bottom of the panel and a tap on
  zone A are the same physical event on the same sensor, told apart only by
  where a host draws the line, and this schema has no field for "a button
  that lives inside the touch panel" (buttons live on an edge, outside the
  panel, per the convention). The web host draws A's ghost button below the
  canvas anyway, because that is the only place this format can put it -
  that placement is a convenience, not a claim about where CoreS3 actually
  senses it.
- **RESET is undeclared**, the same call every silhouette here makes: a
  press resets the MCU through a hardware delay circuit rather than
  producing an event any firmware could read.

## Running a cell

```
bun run pack:web:silhouette m5stack-cores3 --app apps/tinydraw/ports/web/tinydraw.c
```

writes `packs/web/dist/silhouettes/m5stack-cores3/tinydraw/`, a standalone
page whose panel is 320x240, whose touch surface is live, and whose ghost
buttons are PWR (key: cycles tinydraw's zoom) and A (click: tinydraw's
undo), because the module's own `emu_device()` says so.

`proof/<app>.png` is written by `bun run ledger` for every app against every
silhouette (`scripts/silhouetteProof.ts`). `bun run verify-silhouette
--silhouette m5stack-cores3 --app apps/tinydraw/ports/web/tinydraw.c --stroke`
is the deeper proof for this board: it draws a synthetic stroke across the
panel and asserts ink actually appeared, the touch-app equivalent of
`fluidbox-tilt.png`'s gravity assertion.

`bun run verdict tinydraw m5stack-cores3` is the mechanical read of whether
tinydraw fits here at all, before any of that.

## What this does NOT prove

Everything a chip decides: no driver, no I2C, no FT6336U init sequence, no
BMI270 axis convention, no measured frame rate, no memory pressure, and
nothing about whether a real firmware can actually tell a stroke on the
panel from a tap on zone A. A silhouette proves the app's own logic runs at
this size, with these controls, inside a budget somebody wrote down from a
datasheet. Nothing here has ever met the board.
