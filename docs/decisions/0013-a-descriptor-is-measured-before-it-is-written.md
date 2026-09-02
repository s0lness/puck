# 0013: a descriptor is measured before it is written

## The step nobody could recompute

`docs/convention/app-bundle.md` says a descriptor has three sections, and it
is honest about only one of them being prose about intent. `Essence` is what
the app IS. `Interactions` is "every input and its result". `Demands` is what
the app requires of a device at all, and half of it is now a machine-readable
block `bun run verdict` reads for forty cells of a matrix.

Two of those three are claims about observable behaviour, and all three have
been written the same way: somebody ran the app, watched it, and typed what
they remembered. That is the shape of hand-written step every workstream in
`docs/roadmap.md` exists to remove. Its cost is not that it is wrong. Look at
chrono's descriptor: "each digit is 48 by 120 pixels, the gaps are 12 pixels,
the row begins 14 pixels from the left at y 124". Every one of those numbers
is true. The cost is that nothing recomputes them when the port changes,
nothing can be argued with, and a `json demands` block that drifts from the
code drifts silently, taking the whole matrix with it.

## The decision

**`bun run describe` measures a descriptor before a person writes one.**

`tools/describe.ts` replays a recorded session against a module, measures
what happened, and writes a `descriptor.draft.md` next to the trace plus a
`descriptor.draft.json` carrying every measurement behind every line. It
never writes `descriptor.md`. The draft is evidence somebody edits; the
`Essence` paragraph is left as an explicitly marked scaffold of observed
facts, because no replay can see what an app is FOR.

## What makes a result attributable to an input

This is the only idea in the tool, and it is the reason it is worth a
decision record rather than a paragraph in AGENTS.md.

"The panel changed after I pressed the button" is not a measurement. A
stopwatch's panel changes on every tick whether anything was pressed or not,
so a diff against the previous frame says nothing at all about the press.
Chrono is the case that makes this obvious, and every app with a clock, an
animation or a fluid in it has the same problem.

So every affordance is measured **differentially, against its own
counterfactual**: the same trace with that one press (or stroke, or sensor
event) removed, replayed against the same module, diffed frame by frame at
the same tick timestamps. What survives is the part of the panel that changed
BECAUSE of that input. It is `harness/portdiff.ts`'s method turned sideways:
that file holds the trace fixed and varies the module, this one holds the
module fixed and varies the trace.

Everything else follows from having a control:

- **Latency** is the first tick whose frames differ, counted from the end of
  the input rather than its start, so a long hold is not reported as a slow
  app.
- **Where** is the bounding box of the differing pixels, which is why
  `src/compare.ts`'s `FrameDiff` grew a `diffBox`: scanning the existing
  `diffImage` for red would have been wrong on any app that paints in red.
- **Persistence** is a second probe later on, capped at the last tick before
  the NEXT input. Uncapped, chrono's own BOOT reset makes a session that
  started the clock and a session that never did agree again at `00:00:00`,
  and the draft would have called a press that worked a press that reverted:
  a false sentence backed by a real diff.
- **A button's role** is `key` when the device answered the press with a
  short/long verdict and `click` when it did not, which is exactly the
  distinction `docs/convention/device-pack.md` draws. It comes out of the
  trace, never out of the pack's `device.json`, and `test/describe/run.ts`
  proves that by inventing one verdict event and watching the answer change.

## What it cannot see, said out loud rather than guessed

A drafted line that overstates its own reach is worse than no line, because
it is a hand-written claim wearing a measurement's clothes. Four limits are
printed in the draft itself:

- **Anything the session never did.** Every input the device declares and the
  session never used is listed under its own heading. A trace with no touch
  proves nothing about touch, and the drafted `"touch": {"points": 0}` is
  only as good as the session behind it.
- **What an affordance is FOR.** Every Interactions line carries the
  convention's `(intent: ...)` parenthetical as an unfilled TODO. The intent
  is what a porter needs precisely when the target has no such control, and
  inventing one would be worse than leaving it blank.
- **The size at which the app is still itself.** The drafted
  `panel.minW`/`minH` is the extent the app ACTUALLY PAINTED. The
  convention's `minW`/`minH` is a judgement about identity. Chrono paints a
  120x420 column and asks for 200x200, and neither number contains the
  other. There is no drafted `scalesTo` at all: one session at one panel size
  cannot find it.
- **Device time.** `tick.needsMs` is emulator time per tick on the machine
  that drafted it, measured by subtracting a tick-free replay from a full one
  rather than dividing a total by a tick count (a whole replay is mostly
  module instantiation). It is not a frame's cost on the board and says so
  everywhere it appears.

## What the two fixtures actually showed

Both drafts are committed, beside their own traces, with their JSON.

**Chrono agrees with the human where a replay can see the answer.** Same
`panel.color`, same `panel.orientation`, same touch points, same button
roles, and `bun run verdict` reaches the same verdict AND the same status on
every dimension from the draft as from the hand-written descriptor, on all
three packs. It disagrees on two numbers and is right about both: the arena
actually held 36 bytes where the descriptor says 96, and the digits actually
occupy 120x420 where the descriptor asks for 200x200. The first is a
person's safe round number; the second is a different question.

**Fluidbox shows the limit, and the limit is the session.** Its one trace
tilts nothing and presses nothing: it settles, shakes once, and settles
again. So the draft says the app needs an `event` sensor, where the
descriptor says it needs a continuous `vector` with an `event` fallback and
names what falling back costs. On the ESP32-S3 pack, which has no vector
sensor, that is the difference between `go` and `degraded`. **The human is
right and the draft is honest**, and the fix is not a cleverer derivation, it
is a trace that tilts. That is the finding worth keeping: a descriptor
drafted from a session is bounded by what the session exercised, so this tool
makes the coverage of a bundle's traces visible for the first time.

## What this costs

**A draft is per module, per session, per panel.** Every number in it was
observed on one board's shape. Describing the same app against a silhouette
would produce a different painted extent and a different tick cost, and
nothing here merges them.

**It measures what the app did, not what it is for.** Half of what makes
chrono's own descriptor useful to a porter (the intent parentheticals, the
reason the two controls are separate, the stark object-like look) is
unreachable from pixels and is left blank on purpose. The draft is the floor
under a descriptor, never the descriptor.
