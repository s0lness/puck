# fluidbox: a descriptor drafted from a recorded session

**Draft. Measured, not written.** `bun run describe` produced this by replaying the sessions named below against the module named below and measuring what changed, then diffing every input against the same session with that input removed. It is not a descriptor: `descriptor.md` is written by a person or a model, out of this. Nothing here overwrites one.

- module: `site/dist/modules/fluidbox-rp2350.wasm` (given already built)
- pack: `rp2350-touch-amoled-18`, whose `packs/rp2350-touch-amoled-18/device.json` is what the memory and tick numbers are held against
- session: `apps/fluidbox/traces/fluid-settle-shake.trace.json`, recorded 2026-08-18T14:39:09.124Z, 566 events, 565 ticks, 9024ms, 1 counterfactual replays
- drafted: 2026-09-02
- every number below, with the frames and diffs behind it: `descriptor.draft.json`

## Essence

**DRAFT, WRITE THE PROSE.** A replay can measure what is on the panel and cannot say what the app IS. What follows is the scaffold of observed facts a paragraph would be built from, and it is deliberately not a paragraph.

- Panel: 368 by 448, format rgb565be, as the module's own emu_device() declares it.
- Background: rgb(0, 0, 0), the most common colour in the first captured frame.
- Everything ever drawn on top of that background fits in 365 by 119 pixels at x 2, y 328, 26.3% of the panel.
- The part that ever changed after the first frame is 365 by 119 pixels at x 2, y 328, 26.3% of the panel: everything outside it was painted once and left alone.
- Colour is used: up to 6370 pixels in one frame had unequal r, g and b.
- Panel pushes: at most 1 per tick, at most 40832 pixels in one tick, 25495 on average, over 565 ticks.
- The firmware said this on its own console, unprompted: "switch: fluid (0 us)"

## Interactions

Each line names the input and the measured result. The result is the difference between this session and the same session with that one input removed, so it is what the input caused rather than what the app was doing anyway. Every `(intent: ...)` is a TODO on purpose: the intent is what a porter needs when the target has no such control (see `docs/convention/app-bundle.md`, "Affordances carry their intent"), and a replay cannot see it.

- A shake event redraws 365 by 71 pixels at x 2, y 376, 15.7% of the panel, first visible in the same tick that receives it, and the change is still there at the later probe. Measured over 1 occurrence(s), peak 7098 pixels different from the same session with this input removed. (intent: TODO, say what this affordance is FOR, not what it does.)

What these sessions never exercised, so nothing above covers it:

- BOOT: declared by the device and never pressed in any of these sessions
- PWR: declared by the device and never pressed in any of these sessions
- tilt (vector): declared by the device and never delivered in any of these sessions
- touch: the device declares 1 point(s) and no session contains a touch event

## Demands

Measured, with the reach of each number stated. A person has to read all four of these before this block is published:

- **Panel.** `minW`/`minH` is the extent the app ACTUALLY PAINTED, 365 by 119 pixels at x 2, y 328 of a 368 by 448 panel. The convention's `minW`/`minH` is the size at which the app is still ITSELF, which is a judgement, not an observation, and is usually smaller than this. There is no `scalesTo` here for the same reason: one session at one size cannot find it.
- **Colour.** `color` is true when any captured frame held a pixel whose r, g and b differed. Here: it did. This is the question that refuses an app on a monochrome panel, and it is answerable from pixels.
- **Buttons and sensors.** One entry per control that was used AND measurably changed the panel. A control the session never touched is not here, and neither is one that changed nothing: both are listed under Interactions above rather than guessed at. Each `why` is a TODO.
- **Memory and tick.** `memory.baseBytes` came from the module's own emu_arena_used() after the session (6284 of 65536 bytes). `tick.needsMs` is EMULATOR time per tick on the machine that drafted this (0.079ms, by subtracting a tick-free replay from a full one, best of 5), NOT a frame's cost on the board. Replace it with a device measurement before publishing. There is no `refuseUnderMs`: the floor below which the app stops being itself is a judgement.

```json demands
{
  "convention": "0.1",
  "panel": {
    "minW": 365,
    "minH": 119,
    "orientation": "either",
    "color": true
  },
  "buttons": [],
  "touch": {
    "points": 0
  },
  "sensors": [
    {
      "kind": "event",
      "why": "A shake event redraws 365 by 71 pixels at x 2, y 376. TODO, say why this signal has to exist"
    }
  ],
  "memory": {
    "baseBytes": 6284
  },
  "tick": {
    "needsMs": 1
  }
}
```
