## Essence

FluidBox is a full-panel scene of a particle liquid trapped inside a boxed volume shaped like the
device's own enclosure. Hundreds of small glowing particles rest, slosh, and settle under gravity
against the box's rounded walls. Nothing else is drawn: no visible box outline, no wireframe, no
HUD, no digits, no title. The background is solid black; the fluid is the entire picture. Particle
colour runs a fixed ramp from deep blue (still) through brighter blue (moving) to white (thrown
hard, as by a shake), so colour reads as speed at a glance. In the reference's three-dimensional
box, particles further from the glass are drawn smaller and dimmer, which is what sells the depth
on a flat panel; the box itself is never drawn, only inferred from how the fluid piles against it.
The look is alive and continuous: the fluid never stops moving entirely (a faint settled shimmer is
normal), and its surface visibly flattens into a resting pool rather than freezing into a static
image.

## Interactions

- Tilting or orienting the device changes which way gravity pulls the fluid, continuously: the
  low-pass-filtered accelerometer vector is "down" for the simulation, so turning the device pours
  the liquid toward whichever face is now the bottom. (intent: holding the device IS the control;
  the liquid answers the hand continuously, with no button in between.)
- Shaking the device injects a burst of extra motion on top of gravity: particles spray outward and
  the fastest ones flash toward white, then the fluid settles back to its resting pool. (intent: the
  one violent input, and the only way to make the fluid look fast rather than merely present.)
- A short PWR press resets the fluid: it re-seeds as a settled block at the bottom of the box,
  discarding all current position and velocity. (intent: a way back to a known state that costs one
  tap and needs no explanation.)
- Touch does nothing in the reference implementation. The donor hardware has a touch controller,
  but this app never reads it. (intent: none, and this is an absence rather than a decision; a port
  onto a device with a usable digitizer may add stirring, which is a widened interaction surface
  and therefore an adaptation.)
- Holding PWR long enough to power the device off is handled by hardware (an IO-expander pin wired
  directly to the power chip), not by this app. (intent: the app never owns the power state; a
  target without a power rail simply has nothing to implement here.)

## Demands

Requires:

- Continuous per-frame compute for a particle solver (Clavet double density relaxation, position
  based rather than force based, so it stays stable under a hard shake). The reference runs
  **900 particles** at **240MHz dual-core** (Xtensa LX7, hardware single-precision FPU), measured
  at 33-41 simulation steps/s once tuned (`config.h`'s `PARTICLE_COUNT`; `fluidbox/README.md`'s
  "Why it runs at this speed" table).
- A full-screen (or full-box) redraw every frame. The fluid can move anywhere inside the box
  between two frames, so no region of the previous frame can be assumed still valid the way a
  mostly-static UI's could.
- A colour panel. Particle colour (deep blue through to white) is how the render communicates
  speed, and depth-darkening is how it communicates the third dimension; monochrome output would
  erase both cues and leave indistinguishable grey blobs.
- Motion input. A continuous gravity vector is preferred, so the device can be tilted and the fluid
  pours accordingly; a discrete shake event is the minimum below which the fluid cannot feel
  alive rather than merely present (see Prefers below for what a shake-only surface costs).

Prefers:

- 60fps and the reference's three-dimensional box, so the fluid reads as a body of liquid with real
  depth rather than a flat pane of dots.
- The 368x448 colour panel this donor app was itself sized for: `BOX_W`/`BOX_H` in `config.h` are
  literally the panel's own resolution, and every physical constant (`PX_PER_METER`,
  `BOX_CORNER_MM`, `REST_SPACING`) is derived from this exact panel's pixel density.
  A different panel size or density changes what "physically accurate" scale even means and would
  need its own recalibration.
- IMU-driven gravity, read continuously every step, not reconstructed from a one-shot event: a
  continuous vector is what makes tilting responsive rather than just occasionally agitating.

The same requirements, in the form `bun run verdict` checks (see
[`docs/convention/app-bundle.md`](../../docs/convention/app-bundle.md)'s "Demands are also
machine-readable"). The `degrades` block is the honest part: every constant in this solver is in
PIXELS (`REST_SPACING`, `SMOOTH_RADIUS`, the box corner radius), so a fluid is a DENSITY and never
a count. One particle got 1268 px of panel on the 368x448 reference at this bundle's own
`FLUID_N` of 130, and that ratio is what a smaller panel is held to, floored at 16 because below
that a "fluid" stops reading as one and capped at 130 because that is what the port's O(n^2)
neighbour search was budgeted for. `apps/fluidbox/ports/web/fluid.c` computes `FLUID_N` from
exactly this expression, so the number a verdict prints is the number that runs.

```json demands
{
  "convention": "0.1",
  "panel": {
    "minW": 96,
    "minH": 96,
    "scalesTo": { "minW": 64, "minH": 64 },
    "orientation": "either",
    "color": true
  },
  "buttons": [
    { "role": "key", "why": "reset the fluid to a settled block, one tap, no explanation" }
  ],
  "touch": { "points": 0 },
  "sensors": [
    {
      "kind": "vector",
      "why": "gravity direction, read every step, so tilting the device pours the liquid",
      "fallback": {
        "kind": "event",
        "cost": "a discrete shake only: the fluid agitates but never pours, so holding the device stops being the control"
      }
    }
  ],
  "memory": { "baseBytes": 96, "perUnitBytes": 48, "unit": "particles" },
  "tick": { "needsMs": 16, "refuseUnderMs": 4 },
  "degrades": {
    "particles": {
      "what": "how many particles the fluid is made of",
      "basis": "panel-area",
      "pixelsPerUnit": 1268,
      "reference": 130,
      "min": 16,
      "max": 130
    }
  }
}
```
