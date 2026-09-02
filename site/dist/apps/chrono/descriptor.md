## Essence

Chrono is a full-screen stopwatch with no title, status chrome, controls, or decoration. In landscape orientation it shows only `MM:SS:CC`, with minutes, seconds, and centiseconds as three two-digit groups separated by permanent colons. The six black seven-segment digits sit on a white field, centered vertically and spread evenly across the width with matching outer margins. On the 448 by 368 reference layout, each digit is 48 by 120 pixels, each separator occupies 24 by 120 pixels, the gaps are 12 pixels, and the row begins 14 pixels from the left at y 124. Digits change in place while the colons remain fixed. The display starts at `00:00:00`, advances every centisecond while running, and wraps the minutes after 99. The look is stark, quiet, and object-like: the stopwatch owns the entire screen and refers to no surrounding system.

## Interactions

- A short PWR press toggles between running and stopped. A stop freezes the displayed value in the same update that receives the press. (intent: the primary one-tap toggle, and it must feel instant.)
- A BOOT click stops the stopwatch and resets it to `00:00:00` from any state. (intent: the one destructive action, deliberately on a different control from the toggle so it cannot be hit by accident.)
- There are no touch zones. Touch input does nothing in the reference implementation. (intent: the whole face is a readout, never a control surface.)
- Shake input does nothing, so carrying the stopwatch cannot erase its value accidentally. (intent: carrying the device must never destroy the measurement.)

## Demands

Requires:

- A panel of at least about 200 by 200 pixels. Monochrome output is acceptable.
- Touch input or at least two buttons, with distinct start or stop and reset actions.
- A millisecond timebase used as the sole elapsed-time source.

Prefers:

- A 368 by 448 color panel presented in landscape orientation.
- Black seven-segment digits on white with the reference spacing and proportions.
- Negligible compute beyond elapsed-time arithmetic and redrawing changed digits.

The same requirements, in the form `bun run verdict` checks (see [`docs/convention/app-bundle.md`](../../docs/convention/app-bundle.md)'s "Demands are also machine-readable"). Two buttons is the hard one: the toggle and the reset are on separate controls on purpose, so the destructive one cannot be hit by accident, and collapsing them onto one control is not a smaller chrono, it is a different app.

```json demands
{
  "convention": "0.1",
  "panel": {
    "minW": 200,
    "minH": 200,
    "scalesTo": { "minW": 128, "minH": 96 },
    "orientation": "either",
    "color": false
  },
  "buttons": [
    { "role": "key", "why": "start and stop, and it must feel instant" },
    { "role": "click", "why": "reset to 00:00:00, on a different control so it cannot be hit by accident" }
  ],
  "touch": { "points": 0 },
  "sensors": [],
  "memory": { "baseBytes": 96 },
  "tick": { "needsMs": 2, "refuseUnderMs": 0.5 }
}
```
