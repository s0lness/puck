## Essence

TinyDraw is a full-panel finger-drawing canvas: a blank white field that fills the
whole screen, with no title, toolbar, or status chrome drawn over it in this
descriptor's scope (see Demands for the donor's own colour/tool toolbar, which is
out of scope here). Ink is black, antialiased, and variable in width along a single
stroke: the line breathes thin where the finger moved fast and thick where it moved
slow, tapering smoothly rather than stepping between fixed sizes. A drawn stroke
persists exactly as drawn; nothing fades or redraws itself without a deliberate
action. The canvas can be viewed at more than one magnification: zoomed in, the same
ink reads larger and coarser, always expanding from the panel's own center rather
than sliding the view around. The look is spare and object-like, the same way
chrono's is: the canvas owns the whole screen and nothing else competes with the
ink for the eye.

## Interactions

- Dragging a finger across the panel draws ink: the stroke starts wherever the
  finger first touches, follows it continuously, and ends wherever it lifts.
  Width along the stroke responds to how fast the finger is moving at each point,
  not to a fixed pen size. (intent: the felt-tip pen quality is the whole product;
  a uniform-width line would not be TinyDraw, it would be a generic line tool.)
- A short PWR press cycles the view's zoom level and immediately reprojects
  everything already drawn at the new magnification, centered on the panel.
  (intent: a quick way to inspect ink at a different scale without leaving the
  drawing or hunting through a menu; the donor's own camera treats zoom as a
  property of the VIEW, not of the ink itself, so already-drawn strokes must look
  right at any zoom, not just the one they were drawn at.)
- A BOOT click removes the single most recently drawn stroke and redraws the
  canvas from what remains. (intent: the one destructive action, deliberately on
  a different control from the zoom toggle so a child cycling zoom cannot erase
  work by accident; a way back from the last mistake that costs one tap.)
- Shake input does nothing. (intent: unlike fluidbox, nothing about a drawing
  surface should be perturbable by carrying the device; an accidental shake must
  never cost a stroke, which is also why undo is a deliberate button, not a
  gesture.)

## Demands

Requires:

- A panel able to show antialiased ink at a resolution fine enough that variable
  stroke width is visible; a 1-bit or very low-resolution panel would flatten the
  donor's whole reason for existing.
- Touch input with continuous position while a finger is down, sampled often
  enough that a moving finger's SPEED can be estimated between samples. The donor
  itself has no real pressure sensor on its own reference hardware (the FT3168
  controller reports zero for both weight and area, always) and derives width from
  speed instead - this is not a fallback invented for a port, it is how the donor
  itself works today, so a target needs no pressure hardware, only continuous
  position and a timebase.
- Two distinct, low-accident-rate controls for zoom and undo, since the two must
  never be confusable in the moment a child is mid-drawing (see Interactions'
  intent notes above).
- Enough working memory to keep every point of every visible stroke, not just the
  current framebuffer pixels: undo and zoom both require redrawing from the
  ORIGINAL stroke data (positions and widths), not from a copy of pixels already
  painted, because reprojecting at a new zoom or dropping the last stroke both need
  the underlying geometry, not a raster snapshot of one particular view of it.

Prefers:

- A world larger than the panel, with panning, so zoom has somewhere to go rather
  than only enlarging about a fixed center - the donor's own bounded 1472x1792
  world at up to 400% is what this descriptor's own two-level, fixed-center zoom is
  a reduction of.
- Continuous zoom and a deep, multi-step undo history (the donor ships ten slots)
  rather than one level of each.
- Colour and multiple pen sizes, selectable through a toolbar, and an eraser tool -
  the donor's own Raster V1 ships twelve colours and four sizes; this descriptor
  scopes them out as a toolbar/UI concern layered on TOP of the ink+zoom+undo
  surface described above, not part of it.

Out of scope for this descriptor, each a device or platform concern rather than a
drawing-surface one:

- USB mass-storage PNG/SVG export: needs a USB device stack presenting a drive,
  which is a property of what the host OS sees the board as, not of the canvas.
- WiFi/NTP clock sync: needs a radio and a network stack; nothing about drawing
  ink depends on knowing the wall-clock time.
- A flash journal partition for autosave/persistence across power loss: needs
  writable non-volatile storage sized for the document, a board-specific budget
  question (the donor's own ESP32 product reserves 4 MiB of its 16 MiB flash for
  exactly this), separate from whether the drawing surface itself works.

The requirements above, in the form `bun run verdict` checks (see
[`docs/convention/app-bundle.md`](../../docs/convention/app-bundle.md)'s "Demands
are also machine-readable"). A digitizer is the demand nothing here can work
around: this app IS the finger on the glass, and a board with buttons and no
touch is refused rather than adapted. The memory figure is the stroke store, not
the framebuffer, for the reason the prose gives: undo and zoom both redraw from
the original geometry, so the points have to still be there.

```json demands
{
  "convention": "0.1",
  "panel": {
    "minW": 200,
    "minH": 200,
    "scalesTo": { "minW": 128, "minH": 128 },
    "orientation": "either",
    "color": false
  },
  "buttons": [
    { "role": "key", "why": "cycle the zoom level" },
    { "role": "click", "why": "undo the last stroke, on a different control so cycling zoom cannot erase work" }
  ],
  "touch": { "points": 1 },
  "sensors": [],
  "memory": { "baseBytes": 16384 },
  "tick": { "needsMs": 8, "refuseUnderMs": 2 }
}
```
