---
name: puck-publish
description: Guides an agent through porting or publishing an app on puck (device-agnostic emulator + device packs + app bundles), from a target pack and a vibe-coded implementation through to a harness-verified bundle.json and a registry PR. Use when asked to port an app to a puck device pack, add a new apps/ bundle, publish an app to the puck registry, or when a port's bundle.json needs bringing up to schema v0.2.
---

# Publishing an app on puck

Listing is a reproduction, not a submission. Nothing here gets listed on a claim in this conversation or in a README: it gets listed once `bun run verify-bundle` rebuilds the module and replays the traces itself and exits 0. Read `docs/convention/app-bundle.md` and `docs/convention/publishing.md` before starting; this skill is the procedure, those documents are the contract.

## a. Identify the target pack

Read the target pack's `AGENTS.md` first, in full, before writing any code. It is the entry point for a reason: board gotchas, memory limits, and build quirks live there, not in this skill. Also read `device.json` (panel size, buttons, sensors, memory model) and `gotchas.md`.

Compare the app's `Demands` (see step b) against `device.json` and state a verdict before writing any implementation: `go`, `degraded`, or `refuse`. Say the mismatch plainly if there is one. Do not skip straight to code because the pack "looks close enough."

## b. Extract the descriptor

A descriptor has exactly three sections, in this order: `Essence` (what appears on screen, layout, visual character), `Interactions` (every input and its result), `Demands` (requirements separated from preferences). Read `apps/chrono/descriptor.md` as the reference shape before writing one.

Extract the descriptor from the app's own source and behavior, not from what the source code happens to look like internally: the descriptor records intent, the source is evidence. Show the extracted descriptor to the author and iterate on it before treating it as final. A vague or incomplete `Demands` section produces a false `go` verdict later, so push on it here.

**If the donor ships reference media or a host frame-dump harness, check it before listing.** A donor repository sometimes carries its own reference screenshot, a recorded demo video, or a documented host-side simulator pattern - evidence of what the real thing actually looks like, independent of anything this repository's own harness produces. When it exists, at least one emulator frame must be compared against that donor-produced reference BEFORE the port is listed, and the comparison committed with the bundle (structural + pixel diff, a README explaining what matched and what differs and why). A port that only ever checks itself against its own prior captures can drift from the real device for a long time without anyone noticing - this is the check that catches it. If the donor's own reference material is stale or the host harness will not run here, say so plainly in the comparison README rather than skipping the step silently.

## c. Record traces and confirm determinism

Traces are recorded live, in the emulator page (`bun run dev`): every input call the page makes is recorded in order, saved as a trace, and can be loaded back and replayed bit-for-bit. Record the interactions the descriptor names, covering both the "requires" and the "prefers" paths where they differ in behavior.

Replay the same trace twice against the same build and confirm it produces the same result both times before trusting it as verification material. A trace that is not deterministic is not a proof, it is a coin flip; find and fix the source of the nondeterminism (usually an input path the trace does not fully pin down) before moving on.

## d. Prove the port

**`faithful` claim** (same interaction surface): build the target pack's module, then run

```
bun run portdiff <referenceModule.wasm> <portModule.wasm> <trace.json> --write-frames <bundle>/frames
```

`--write-frames` writes the reference module's own captured frames as PNGs into the bundle's `frames/` directory, one per capture point, once every point already matches. Do this only after the plain (non-`--write-frames`) run shows every capture point at tolerance zero; writing frames from a diverging run just checks in the wrong answer.

**`adaptation` claim** (interaction surface changed): propose invariants from the descriptor, not from the implementation. Ask what a healthy run must be true of at specific, named moments (a settled state, a moment right after an event), the same way `apps/fluidbox/invariants.ts` reads.

Then **red before green**, for every invariant, no exceptions: deliberately break the build or behavior the invariant is supposed to catch, rerun `bun run invariants <wasm> <trace.json> <checker.ts> --at <ms,...>`, and confirm it fails, naming the actual invariant that caught it. Restore the break, rerun, and confirm it passes. An invariant that cannot be made to fail this way is not a real check: reject it, do not publish it. This is not optional scaffolding; it is the only evidence that the checker checks anything at all.

## e. Assemble bundle.json (schema v0.2)

One entry per pack under `ports`, each with `pack`, `mode` (`faithful` | `adaptation` | `native`), `verification` (`{kind:"pixel-exact", traces, frames}` or `{kind:"invariants", checker, trace, captureAt}`), and `source`. Add `verdict: "degraded"` if step a's verdict was degraded. Add `silicon` only once the port has actually run against real hardware, dated and citing how, never in anticipation of a future run. Every path is relative to the bundle's own repository root.

Nothing verify-bundle needs may live only in a README: the pixel-exact capture points come from the `frames/` directory's own filenames, and the invariants `captureAt` list must be exact and complete in `bundle.json` itself. See `docs/convention/app-bundle.md`'s schema section for the full shape and both 0.2 additions (`buildArgs`, `verdict`) beyond it.

## f. Verify

```
bun run verify-bundle <path-to-bundle>
```

Read every line of a failure, not just the exit code: a `FAIL` names the diverging frame or the failed invariant, an `ERROR` names a build or configuration problem (unknown pack, external pack, a build that would not compile). Fix the actual cause and rerun. Do not touch the checker's thresholds or the traces just to make the run pass; if the check is wrong, say so and fix the check, don't launder a real regression through a loosened threshold.

Iterate until every port bundle.json claims exits 0. This is the actual publishing gate; nothing before this step is a proof of anything.

## g. Publish

Two shapes, matching `docs/convention/app-bundle.md`'s registry convention:

- **In-repo bundle**: a PR adding or updating `apps/<name>/` (descriptor, bundle.json, traces, frames or checker), plus a `{"name": "<name>", "path": "apps/<name>"}` entry in `registry.json` if new.
- **External bundle**: the app lives in the author's own repository. Publish there, then open a one-line PR here adding `{"name": "<author>/<app>", "url": "<repo url>"}` to `registry.json`. The name is author-namespaced so two authors' apps of the same name never collide.

Either way, the PR is the bundle plus the registry line, nothing else: no separate prose claim of what works, because `bun run verify-bundle` (run again in CI on every PR, push, and nightly) is what actually says so.
