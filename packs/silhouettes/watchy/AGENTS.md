# AGENTS.md - Watchy, as a silhouette

A silhouette pack: one `device.json`, this file, and nothing else. No
firmware, no drivers, no build script. See
[`docs/convention/device-pack.md`](../../../docs/convention/device-pack.md)'s
"Silhouette packs" section for what that is and what it costs.

## The board

SQFMI's Watchy: an open-source e-paper watch. A 1.54 inch 200x200 e-paper
panel (Good Display GDEY0154D67 on current boards, GDEH0154D67 on earlier
ones, SSD1681 controller), a Bosch BMA423 accelerometer, a PCF8563 real
time clock, four corner buttons, and an ESP32-PICO-D4 through v2 hardware
(an ESP32-S3FN8 on v3). This file describes v2, because that is the
revision whose numbers are stated in both SQFMI's documentation and
Espressif's.

It earns its place here by being the first target in this repository that
is not a colour screen, and the first whose panel, not its CPU, decides how
fast anything can happen.

## Why this silhouette refuses things

- **`mono1`, so every app whose colour carries information is refused.**
  `tools/verdict.ts` reads any format not starting with `rgb` or `bgr` as
  monochrome and refuses a `panel.color: true` demand outright. fluidbox
  and gameos are both refused here, in one line each, and that refusal is
  the most useful thing this board has to say.
- **No `key`, so a two-control app degrades.** All four buttons are
  ordinary GPIOs, but what SQFMI documents is a momentary press and a
  level-triggered wake from deep sleep, not a short-versus-long verdict. So
  all four are declared `click` and none is a `key`. chrono asks for a key
  and gets told, in the verdict's own words, that a click is standing in
  for it.
- **300 ms per tick, and that number is the glass.** Good Display specifies
  0.3 s for a partial refresh on this panel, 1.5 s for a fast full one and
  2 s for a full one. So the fastest a new frame can appear at all is one
  every 300 ms, and `budget.tickBudgetMs` says so. Read it as a ceiling on
  compute rather than as a promise about motion: this convention has a
  dimension for how long a tick may take and none for how often a frame
  appears, so an app whose tick fits still gets three frames a second here.

## The seam this board exposes

`packs/web`'s device header wires exactly one `click` index and one `key`
index (`BTN_BOOT` and `BTN_PWR`, see that pack's `wasm/build.ts`). A device
that declares no `key` at all therefore compiles with `BTN_PWR` at -1 and
loses that control entirely on the page, while `tools/verdict.ts` reports
the friendlier answer that a click stands in for it. Both are honest about
their own question and they do not agree, and Watchy is the first target
where that gap is visible. Fixing it means the web pack picking a
substitute itself, which is a change to that pack, not to this file.

## Running a cell

The browser is the device that actually runs an app here (`packs/web`),
compiled against THIS descriptor rather than its own:

```
bun run pack:web:silhouette watchy --app apps/chrono/ports/web/chrono.c --landscape
```

writes `packs/web/dist/silhouettes/watchy/chrono/`, a standalone page whose
panel is 200x200 and whose ghost buttons are UP, DOWN, MENU and BACK,
because the module's own `emu_device()` says so. `bun run ledger` builds
every app against every silhouette this way and writes the proof under
`proof/`. The page paints in colour, because the web pack's own framebuffer
is RGB565 and nothing here converts: the panel SIZE and the CONTROLS are
what a silhouette run proves, never the panel's own gamut.

`bun run verdict <app> watchy` is the mechanical read of whether an app fits
here at all, before any of that.

## What this does NOT prove

Everything a chip decides, and on this board rather more than usual. There
is no SSD1681 waveform, no BUSY polling, no ghosting, no partial-refresh
artefact, no deep-sleep budget, no RTC, and no measured refresh at any
temperature. A silhouette proves the app's own logic runs at this size,
with these controls, inside a budget somebody wrote down from a datasheet.
Nothing here has ever met the board.
