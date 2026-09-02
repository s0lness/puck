# App bundles

An app is defined by its descriptor and traces, not by its source code. The descriptor records intent. The traces and expected frames make observable behavior checkable.

**Listing is a reproduction, not a submission.** Nothing about a port (a pixel-exact match, an invariant holding, a run on real silicon) is taken on prose. `bun run verify-bundle <bundle>` rebuilds the module and replays the recorded traces itself; a claim only counts once that command exits 0. A README can explain a port in prose for a human reader, but everything the verifier needs to do its own job must live in `bundle.json`, never only in a README.

## Descriptor

Every descriptor has exactly three sections:

- `Essence`: what appears on screen, including layout and visual character.
- `Interactions`: every input and its result.
- `Demands`: separate checkable requirements from preferences.

[`apps/chrono/descriptor.md`](../../apps/chrono/descriptor.md) is the reference descriptor.

### Affordances carry their intent

`Interactions` stays bound and concrete: it names the actual input and the actual result, and a porter must be able to implement it without inventing anything. What it gains is one parenthetical per affordance, stating what that affordance is FOR.

```
- A short PWR press toggles between running and stopped. (intent: the primary one-tap toggle, and it must feel instant.)
```

The reason is what happens at the edge of a port. A target device has no PWR button, or no button at all, and the porter has to decide what replaces it. Without the intent, the two available moves are both wrong: reproduce the letter (a control labelled PWR, wherever it lands, however awkward) or reproduce nothing. With it, the porter knows the thing to preserve is a one-tap toggle that feels instant, and can put it wherever that is true on their device. `packs/web`'s chrono port is the worked example: its PWR is a drawn button rather than a felt one, which is a change to the letter and none at all to the intent.

This is not a second `Demands` section and it must not become one. `Demands` is the platonic layer: what the app requires of a device at all, separated from what it prefers, checkable against a `device.json` before any code exists. An intent parenthetical is narrower and answers a different question: given that this affordance is being ported, what would a reimplementation have to keep to still be this app? Nothing checks intents mechanically, and nothing should; they are for the person or agent writing the port, and they are what a verdict of `faithful` versus `adaptation` gets argued from.

No schema change: this is prose inside `Interactions`, which `bundle.json` never reads.

## Bundle schema (0.2)

`bundle.json` sits next to `descriptor.md`. Its `convention` field states the schema version it was written against. Version 0.2 replaces the earlier loose `provenPacks` field with a `ports` array, one entry per pack the app has been ported to and proven on:

```
{
  "convention": "0.2",
  "name": "<app name>",
  "ports": [
    {
      "pack": "<pack name, as it appears in registry.json>",
      "mode": "faithful" | "adaptation" | "native",
      "verification":
          { "kind": "pixel-exact", "traces": ["<path to a .trace.json>", ...], "frames": "<path to the frames directory>" }
        | { "kind": "invariants", "checker": "<path to an invariants.ts>", "trace": "<path to a .trace.json>", "captureAt": [<ms>, ...] },
      "source": "<path to the port's source file>",
      "silicon": { "attestedAt": "YYYY-MM-DD", "how": "<one line>" }
    }
  ]
}
```

Every path is relative to the repository root the bundle lives in (this repository's own root for an in-repo `apps/` bundle, the author's own repository root for an external one).

- **`mode`** is `native` when the pack's own default firmware build already contains the app (no `--app` override), `faithful` when a port keeps the same interaction surface and is verified pixel-exact, `adaptation` when the interaction surface changed and verification falls back to stated invariants.
- **`verification.kind: "pixel-exact"`** lists every trace this port replays and the directory holding the recorded expected frames for them. The verifier derives which moments to check directly from the frame filenames already in that directory (`<trace-stem>.t<ms>.png`, `harness/portdiff.ts`'s own naming), so no separate list of capture points needs restating in `bundle.json`.
- **`verification.kind: "invariants"`** names the checker module (the bundle's own file, implementing the interface `harness/invariantRun.ts` documents), the one trace it runs against, and the exact millisecond capture points the checker expects, in order. Unlike `pixel-exact`, these capture points cannot be inferred from a directory listing, since there is no recorded frame per point, so `captureAt` is required.
- **`source`** is the file the pack was actually built from for this port: the port's own `.c` file for `faithful`/`adaptation`, or the pack's own firmware source for `native`.
- **`buildArgs`** (optional, `string[]`) carries extra flags a pack's `wasm/build.ts --app` build needs beyond `--app <source>` itself, for example `apps/fluidbox/bundle.json`'s `["--shake"]` (the pack build script's `--shake` flag, which this port needs to receive shake sensor events at all). This is a 0.2 addition beyond the minimal shape above, added because a real port (fluidbox) needed it and the alternative, a build flag known only to a README, is exactly the bug this schema exists to close.
- **`verdict`** (optional, `"go" | "degraded"`, default `go`) carries the porting flow's own verdict (see "Porting flow" below) through to the published bundle: a `degraded` port fits the pack but at a real, stated cost (fluidbox's rp2350 port, fixed gravity instead of tilt, a much smaller particle count). A refused port is never published, so `refuse` never appears here. Another 0.2 addition beyond the minimal shape above, carrying forward what 0.1's per-pack `degraded` boolean used to.
- **`silicon`** is optional and only present once a port has been run against real hardware, not only the emulator. It is an attestation, not an automatic guarantee: a dated claim that a named run happened, citable back to a commit. See [`publishing.md`](publishing.md) for the responsibility model behind it.
- **`build`** (optional) declares that this port's module is not built by a local pack's `wasm/build.ts` but by another repository's own build. See "External ports" below. When it is present, `source` may be omitted (the source lives in that repository, identified by `repo` + `commit`), and the port's `pack` is not looked up in `registry.json` at all, since no local pack is being built: the pack name still says which device the recorded frames belong to.

## External ports

An app may live entirely outside this repository, with its own source, its own toolchain and its own history. Such a port declares how to build itself:

```
"build": {
  "repo": "<git URL, or a path to a directory on this machine>",
  "commit": "<commit sha, 7 to 40 hex characters>",
  "command": "<shell command, run at the root of the checkout>",
  "artifact": "<the built .wasm, relative to the checkout root>"
}
```

`bun run verify-bundle` then clones that repository at that commit into a temporary directory (or copies it, for a local path, which is what `test/fixtures/external-bundle/` uses), runs the command there through `bash -c`, takes the artifact, and verifies it **exactly like any other module**: the same traces, the same recorded frames, the same tolerance. The trace and frame requirements do not soften for an external port. `tools/externalBuild.ts` is the single implementation of that clone-pin-run step.

Four rules the verifier enforces, each for one reason:

- **A local path is resolved against the bundle's own repository root**, the same rule every other path in `bundle.json` follows.
- **`commit` must be a sha, not a branch or a tag.** A moving target is not a reproduction. The one exception is the literal `"working-tree"`, allowed only for a local directory that is not a git repository at all (a fixture, a scratch checkout); it is reported as unpinned wherever provenance is shown, never as if it were a pin. A local directory that DOES have git history is refused if it asks for `"working-tree"`.
- **`artifact` must stay inside the checkout**, and it is deleted before the command runs, so "the artifact exists" can only mean "this command produced it". A `.wasm` committed into a repository does not count as a build output.
- **Nothing about verification changes.** A port that cannot produce the recorded frames fails, wherever its module came from.

**Listing a bundle with a `build` command means running that repository's build on your own machine.** That is a deliberate choice, not an oversight; the reasoning, and what the pinned commit does and does not buy, is in [`../decisions/0005-external-ports-are-reproduced.md`](../decisions/0005-external-ports-are-reproduced.md).

This schema fixes a specific bug in 0.1: the exact pixel-exact capture points and the invariants capture-at times used to live only in a port's own `README.md`, prose a verifier cannot read. `bundle.json` now carries everything `verify-bundle` needs on its own.

apps/chrono/bundle.json and apps/fluidbox/bundle.json are the reference 0.2 bundles: chrono ports `native` (the reference pack) and `faithful` (a second pack), both pixel-exact; fluidbox ports `adaptation`, verified by invariants.

## Verification material

Traces record portable input. Expected frames (pixel-exact) or a checker module plus capture points (invariants) record the proven output for a target pack. Together they let the shared harness replay behavior and compare results, driven end to end by `bun run verify-bundle`.

App bundles may live under this repository's `apps/` directory or in an author's own repository. Local apps use a `{"name","path"}` entry in `registry.json`, with a bare name (`"chrono"`). An app or pack published in an author's own repository uses a `{"name","url"}` entry, and its name is author-namespaced, `"author/app"` (the same shape as a GitHub `owner/repo`), so two different authors' `foo` cannot collide in one registry. `registry.json` itself carries no prose explaining this: it is the convention documented here.

A `{"name","url"}` entry may also carry an optional `"commit"`: a full 40-character commit sha pinning exactly which commit of that repository gets verified. When it is present, `verify-bundle` fetches and checks out that exact commit (rather than a plain clone of whatever the repository's `HEAD` currently is) and refuses to proceed if what actually got checked out does not match it - the same clone-pin-verify discipline `build.commit` already applies to a port's own external build (see "External ports" above and [`../decisions/0005-external-ports-are-reproduced.md`](../decisions/0005-external-ports-are-reproduced.md)), applied here to the bundle repository itself, since that repository can also move out from under a listing between one verification and the next. An entry with no `"commit"` still verifies (against `HEAD`, unpinned) but `verify-bundle` warns loudly on stderr when it does: an external app the registry never pinned is a real gap, not a quiet default.

## Porting flow

1. Read the app descriptor and the target pack.
2. Compare `Demands` with `device.json` and give a verdict before writing code: `go`, `degraded`, or `refuse`, with the mismatch or fit stated plainly.
3. Write an idiomatic implementation for the target pack. The bundled reference source is evidence, not the definition of the app.
4. Replay the traces and verify the resulting frames or invariants.
5. Assemble or update the port's `bundle.json` entry, then run `bun run verify-bundle <bundle>` until it exits 0. See [`publishing.md`](publishing.md) and [`skills/puck-publish/SKILL.md`](../../skills/puck-publish/SKILL.md) for the full agent-facing procedure.

## Port modes

`native` is the pack's own default build: the app already ships as part of that pack's reference firmware, with no `--app` override, so there is nothing to port. Verification is still pixel-exact, against the same recorded frames every other pixel-exact port on this bundle is checked against.

`faithful` keeps the same interaction surface. Its traces replay verbatim, and verification uses pixel-exact frame diffs.

`adaptation` changes the interaction surface. Its traces must be translated, and verification uses stated behavioral invariants instead of pixel identity. An invariant that cannot be made to fail by deliberately breaking the build is not a real check and is not published; see `publishing.md`'s red-before-green step.

Regenerated code can drift from the original and from later ports. The harness is the mitigation, not a guarantee. See [the harness documentation](../harness.md) and [the two-compilers decision](../decisions/0002-two-compilers-not-one.md).
