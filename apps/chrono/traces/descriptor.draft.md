# chrono: a descriptor drafted from a recorded session

**Draft. Measured, not written.** `bun run describe` produced this by replaying the sessions named below against the module named below and measuring what changed, then diffing every input against the same session with that input removed. It is not a descriptor: `descriptor.md` is written by a person or a model, out of this. Nothing here overwrites one.

- module: `site/dist/modules/chrono-rp2350.wasm` (given already built)
- pack: `rp2350-touch-amoled-18`, whose `packs/rp2350-touch-amoled-18/device.json` is what the memory and tick numbers are held against
- session: `apps/chrono/traces/chrono-startstop.trace.json`, recorded 2026-08-18T00:00:00.000Z, 125 events, 116 ticks, 2096ms, 3 counterfactual replays
- session: `apps/chrono/traces/chrono-idle.trace.json`, recorded 2026-08-14T20:20:48.964Z, 64 events, 64 ticks, 1008ms, 0 counterfactual replays
- drafted: 2026-09-02
- every number below, with the frames and diffs behind it: `descriptor.draft.json`

## Essence

**DRAFT, WRITE THE PROSE.** A replay can measure what is on the panel and cannot say what the app IS. What follows is the scaffold of observed facts a paragraph would be built from, and it is deliberately not a paragraph.

- Panel: 368 by 448, format rgb565be, as the module's own emu_device() declares it.
- Background: rgb(255, 255, 255), the most common colour in the first captured frame.
- Everything ever drawn on top of that background fits in 120 by 420 pixels at x 124, y 14, 30.6% of the panel.
- The part that ever changed after the first frame is 120 by 204 pixels at x 124, y 230, 14.8% of the panel: everything outside it was painted once and left alone.
- No frame in any of these sessions held a single pixel whose r, g and b differed: the app painted in greys only.
- Panel pushes: at most 3 per tick, at most 17280 pixels in one tick, 6302 on average, over 117 ticks.
- The firmware said this on its own console, unprompted: "chrono: entered, stopped at 00:00:00"
- The firmware said this on its own console, unprompted: "switch: chrono (0 us)"
- The firmware said this on its own console, unprompted: "chrono: BOOT click, reset to 00:00:00"

## Interactions

Each line names the input and the measured result. The result is the difference between this session and the same session with that one input removed, so it is what the input caused rather than what the app was doing anyway. Every `(intent: ...)` is a TODO on purpose: the intent is what a porter needs when the target has no such control (see `docs/convention/app-bundle.md`, "Affordances carry their intent"), and a replay cannot see it.

- A short PWR press redraws 120 by 108 pixels at x 124, y 326, 7.9% of the panel, first visible 1 tick(s) later (16ms), and the change is still there at the later probe (probed 1696ms on rather than 2000ms, because the next input arrived). Measured over 2 occurrence(s), peak 5184 pixels different from the same session with this input removed. (intent: TODO, say what this affordance is FOR, not what it does.)
- A BOOT click redraws 120 by 186 pixels at x 124, y 230, 13.5% of the panel, first visible in the same tick that receives it, and the change is still there at the later probe (probed 16ms on rather than 2000ms, because the session ended). Measured over 1 occurrence(s), peak 6696 pixels different from the same session with this input removed. (intent: TODO, say what this affordance is FOR, not what it does.)

What these sessions never exercised, so nothing above covers it:

- shake (event): declared by the device and never delivered in any of these sessions
- tilt (vector): declared by the device and never delivered in any of these sessions
- touch: the device declares 1 point(s) and no session contains a touch event

## Demands

Measured, with the reach of each number stated. A person has to read all four of these before this block is published:

- **Panel.** `minW`/`minH` is the extent the app ACTUALLY PAINTED, 120 by 420 pixels at x 124, y 14 of a 368 by 448 panel. The convention's `minW`/`minH` is the size at which the app is still ITSELF, which is a judgement, not an observation, and is usually smaller than this. There is no `scalesTo` here for the same reason: one session at one size cannot find it.
- **Colour.** `color` is true when any captured frame held a pixel whose r, g and b differed. Here: no frame did. This is the question that refuses an app on a monochrome panel, and it is answerable from pixels.
- **Buttons and sensors.** One entry per control that was used AND measurably changed the panel. A control the session never touched is not here, and neither is one that changed nothing: both are listed under Interactions above rather than guessed at. Each `why` is a TODO.
- **Memory and tick.** `memory.baseBytes` came from the module's own emu_arena_used() after the session (36 of 65536 bytes). `tick.needsMs` is EMULATOR time per tick on the machine that drafted this (0.019, 0.009ms, by subtracting a tick-free replay from a full one, best of 5), NOT a frame's cost on the board. Replace it with a device measurement before publishing. There is no `refuseUnderMs`: the floor below which the app stops being itself is a judgement.

```json demands
{
  "convention": "0.1",
  "panel": {
    "minW": 120,
    "minH": 420,
    "orientation": "either",
    "color": false
  },
  "buttons": [
    {
      "role": "key",
      "why": "A short PWR press redraws 120 by 108 pixels at x 124, y 326. TODO, say why this control has to exist"
    },
    {
      "role": "click",
      "why": "A BOOT click redraws 120 by 186 pixels at x 124, y 230. TODO, say why this control has to exist"
    }
  ],
  "touch": {
    "points": 0
  },
  "sensors": [],
  "memory": {
    "baseBytes": 36
  },
  "tick": {
    "needsMs": 1
  }
}
```
