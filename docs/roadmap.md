# Roadmap: puck becomes self-proving

Written 2026-09-02 from a full review of the repository against its own
stated goal. AGENTS.md says how, README says what, `docs/decisions/` says
why; this file says what comes next and in which order. It is a plan, so
it goes stale by design: strike items as they land, move the date.

## The gap, in one paragraph

The vision holds and is proven: four apps, three packs, both chip families
flashed from the browser, one bundle published by a third party. What has
not held is everything a human did once and wrote down by hand. Silicon
attestations exist for chrono only, although fluidbox ran on both boards.
The only external bundle has been red in CI for a week and the verifier
does not print why. The docs describe the tree of August 18. The reference
pack is the least conformant of the three. Nobody has tested whether an
agent with no session context can port from a pack folder alone. Every
workstream below removes one of those hand-written steps by making the
proof a side effect of something that runs.

## Principles that decide the plan

- **Once, per input.** A proof of pinned inputs does not decay. Nothing
  runs on a schedule except one monthly canary for the runner itself.
  Reproduction runs on push, on PR, and when a pin is bumped.
- **A visitor asks "does it run", not "was it reproduced".** The site
  shows live counts of real boards that ran a port, not dates typed by
  hand.
- **No mockups.** A cell in the gallery either runs the app's own C or
  says plainly that nothing exists. Silhouettes run, they do not draw.
- **Three marks per port, each honest about its reach**: emulator (wasm,
  source-level logic), sanitized host build (compiler-class defects),
  silicon (everything else). A fourth, instruction-level emulation, earns
  its place by a spike, not by assumption.
- **Cheapest proof first.** Show a working cell before locking a format.

## Workstreams, in order

### 0. Red gates and hygiene (half a day, one batched worker)

Everything here was verified by reading the code or by running the gate.

- `packs/rp2350-touch-amoled-18/wasm/build.ts`: add the 120 s zig attempt
  timeout the esp32 and web packs already have. Without it
  `verify-bundle apps/chrono` hung past ten minutes on the dev machine.
- `tools/verify-bundle.ts`: print the failing build's stderr. CI has
  reported `exit 1` for the external tinydraw bundle seven nights out of
  eight with no reason attached.
- `server.ts`: apply the `x-puck-emulator` guard to `/api/freeze` and
  `/api/trace`, the two write routes that lack it.
- `src/main.ts`: wrap `emu_init()` in `bringUp` like its neighbours; route
  `startReplay` through `reloadInFlight`.
- `scripts/verify*.ts`: `fail()` throws instead of `process.exit`, so the
  `finally` that kills Chrome and the dev server actually runs on failure.
- `harness/selftest.ts`: assert the module on disk is the example firmware
  (device name), and add a negative control that corrupts one frame and
  expects a divergence.
- `packs/rp2350-touch-amoled-18/tools/build-native.ts`: `CMAKE_BIN_DIR`
  and `NINJA_BIN_DIR` read the environment first, like the two lines above
  them.
- `.github/workflows/verify-bundles.yml`: verify zig's sha256; delete the
  `schedule:` block.
- `registry.json`: external entries carry `url` plus `commit`; the
  verifier fetches the pin, never a depth-one clone of HEAD.
  `tools/externalBuild.ts` requires a full 40-hex sha and checks
  `git rev-parse HEAD` against it after checkout.
- AGENTS.md and README: name packs/web, the esp32 pack, fluidbox,
  tinydraw, gameos, skills/, site/, test/hostile and the scripts. Decision
  records for the gameos donor shell vendoring, the browser as a device,
  and the tiny-computers convergence.
- Prune the eight merged agent worktrees; decide the one unmerged commit
  on `audit/2026-08-21`.

### 1. "Does it run": the flash page attests (two to three days)

The flash page already holds the board over WebUSB or Web Serial. After a
flash it runs the port's trace on the real board through the devlink
protocol, diffs the frames, and shows the verdict to the person who
flashed. One click posts the verdict (board family, firmware sha, verdict,
date, nothing personal) to a small Worker with one table. Cards read:

    runs on RP2350: 14 boards, last confirmed 2 days ago

- `harness/links/`: a Web Serial and WebUSB transport for the devlink
  protocol, replacing the PowerShell bridge in the browser.
- A Worker with two routes, one D1 table, no login.
- The counter on every card, with the honest empty state.
- Seed: flash all four apps on both boards from the site. Eight entries
  on day one, and the hand-typed `attestedAt` fields become derived.

### 2. The ledger drives the gallery (DONE, 2026-09-02)

`bun run ledger` writes `ledger.json`: per app per target, the mechanical
verdict, the emulator mark, the sanitized-host mark, the key the silicon
count comes back on, the silhouette mark, and the shas that produced them.
`site/build.ts` builds from it. Alice's card was the acceptance test and it
passes: the external bundle has a row, states "reproduced from
aliceisjustplaying/tinydraw@sha on date", and shows red with the failing
build's own sentence rather than vanishing. See
`docs/decisions/0012-the-gallery-is-built-from-a-ledger.md`.

Still open from this workstream: nothing runs it but a person. It is not
wired into CI, and the blind-port result from workstream 4 has no column
yet.

### 3. The matrix and silhouette packs (DONE, 2026-09-02)

The gallery is apps down, devices across, and every cell either runs the
app's own C or says plainly what is missing.

- Five silhouettes, each carrying a refusal the others cannot make:
  `m5stickc-plus2`, `feather-esp32s2-tft`, `lilygo-t-display-s3`,
  `pico-display-pack-2` (the only non-ESP32 one, and the clean `go`), and
  `watchy` (200x200 e-paper, mono, no `key` button, its panel rather than
  its CPU setting the tick budget).
- `bun run verdict <app> <target>` is mechanical and its answer is on
  every cell. `bun run site:verify-matrix` holds the page to the ledger.
- An empty cell says "no port yet", carries the verdict's own reason, and
  links to `/puck-publish/`.

Two things the grid exposed, both visible on the page rather than fixed by
dropping a cell, and both worth a workstream of their own:

- **gameos's ports assume the reference panel.** On a smaller silhouette
  its shell draws outside the panel, and on two of them the module traps.
  `chrono` and `fluidbox` read `PANEL_W`/`PANEL_H` and are correct on all
  five. Nothing yet stops a port hardcoding a panel except this picture.
- **`packs/web` wires one `click` and one `key` and no more**, so a board
  declaring four clicks and no key (Watchy) silently loses that control,
  while `verdict` reports the friendlier "a click stands in for it". The
  two disagree, and closing that is a change to the pack.

### 4. The blind port (one day to wire, then it runs on its own)

The real test of "an LLM targets a pack from the folder alone". A fresh
agent, no session context, receives one pack folder and one app bundle and
is told to port. `verify-bundle` judges. The result goes to the ledger
keyed by (pack docs sha, app sha, model), so it reruns when the docs
change, which is exactly what it measures. First pair: chrono to
packs/web. Codex runs it; its plan is already paid for.

### 5. The robustness ladder (three days plus a one-week spike)

- Third harness side: every port built natively on the host with
  `-fsanitize=address,undefined`, replaying the same traces. The gameos
  hostsim already has this shape; generalize it.
- `-fstack-usage` from the real cross toolchain, compared against each
  pack's declared stack, in CI.
- The ledger records the class of every bug found on silicon (peripheral
  or compiler). That number decides whether instruction-level emulation
  is worth a board model.
- One-week spike: chrono on ESP32-S3 under Espressif's QEMU with the pack's
  HAL linked to a bridge that talks to puck's own panel, touch and tilt.
  Real core, real compiler, real SDK, fake glass. Frames diffed against
  wasm and silicon. Three agree: QEMU becomes the fourth mark and a
  decision record. Fork too partial: a week lost, written down.
  RP2350 afterwards on Renode, same recipe.

### 6. Native builds leave the laptop (one week)

Native firmware builds move to CI using the pico-sdk and espressif/idf
containers. The `.uf2` and `.bin` on the flash pages become release
artifacts built at a tagged commit, with checksums. The hardcoded
toolchain paths die because nothing native runs on a personal machine any
more. A `pack:lint` job checks every pack against the convention's
required contents, so the reference pack is held to its own standard.

### 7. Describe (research, unscheduled)

`puck describe <firmware>` drives the emulator through a recorded session
and drafts the descriptor's interactions and demands from traces and
frames, leaving the essence paragraph to a person or a model. Fluidbox is
the fixture. Last, because it is research and the rest is plumbing.

## What the site says at the end

Today: "these ports were proven". After: "this port was reproduced from
these shas, ported blind by an agent on this date, and ran on this many
real boards, the last one two days ago". Every word backed by a job
someone can rerun.

## Working rules for this plan

- One worker per workstream, a written spec, the diff read before merge.
  Repo-local and specifiable work goes to Codex first.
- Show a working cell before locking its format: no full suite on a
  change nobody has looked at yet.
- Silicon overrules derivation. The harness settles model disputes.
