# 0012: the gallery is built from a ledger, and every cell is a run or a stated absence

## What the gallery could not say

`site/build.ts` used to walk each `bundle.json`, collect the ports listed
there, and render a card and a matrix row for each one. Everything it showed
was true. The problem was everything it could not show.

A list of proven ports has exactly one representation for all of these:

- an app nobody has ported to a board yet,
- a board nobody has written firmware for,
- an app that was ported and whose build has been failing for a week,
- an app that could never work on a board, and the reason why.

That representation is absence. The fourth case is the one that stings: `bun
run verdict` has been able to say "chrono is refused on a one-button device,
and here is the sentence" since the day it was written, and none of those
sentences reached anybody. And the third is worse than absence, because a
red external bundle looked exactly like a bundle nobody had submitted.

The old matrix's own empty cell said `not ported`, in grey, and that was the
most honest thing on the page and still nearly nothing.

## The decision

**`ledger.json` is computed, and the gallery renders it.**

`bun run ledger` (`tools/ledger.ts`) takes every app in `registry.json`
against every target in it and writes one row per pair:

| what | who answers it | how far it reaches |
|---|---|---|
| verdict | `tools/verdict.ts`, in process | two documents compared, never a prediction that the port runs |
| emulator | `bun run verify-bundle` | the module rebuilt from the port's own source, its own traces replayed |
| host | `bun run hostdiff` | the same C built natively under ASan and UBSan, diffed against the wasm build frame by frame |
| silicon | `GET /api/attest` at page load | how many real boards ran that trace and confirmed the frames ([0011](0011-attestation-is-a-run-not-a-claim.md)) |
| silhouette | `scripts/silhouetteProof.ts` | the app's own C really running at a board's declared size, with a PNG |

`site/build.ts` reads that file instead of the bundles. Every cell on the
landing page carries one of exactly three things, declared on the cell
itself as `data-cell` so a check can hold the page to it:

- **`runs`**: a link to something that opens and runs, and a mark for every
  kind of proof it has earned.
- **`verdict`**: the mechanical go / degraded / refuse, with the reason
  behind it printed rather than only tooltipped.
- **`empty`**: what is missing, and a link to the procedure for fixing it.

`scripts/verify-matrix.ts` counts the grid against the ledger, holds every
cell to that three-way rule, opens every silhouette cell that claims to run
and measures the canvas it paints against that board's own `device.json`,
and fails if the external bundle's row or its provenance is not there.

## What this makes possible, and what it costs

The acceptance test was Alice's card, and it works: the external
`aliceisjustplaying/tinydraw` bundle has a row, it states
`reproduced from aliceisjustplaying/tinydraw@<sha> on <date>`, and the cell
for the pack it targets carries a red `emulator ERROR` with the build's own
sentence on the page rather than in a log nobody reads.

Two things this costs, both stated rather than hidden.

**The ledger is incremental by input sha, and those shas do not cover
everything.** A cell is reused when the app bundle's tree hash, the pack's
tree hash and `tools/verdict.ts`'s hash are unchanged, which follows
[0009](0009-proofs-run-once-per-input-not-on-a-schedule.md): a proof of
pinned inputs does not decay. What those three do not cover is the shared
instrument, `src/` and `harness/`. Hashing the whole repository would
invalidate every cell on every commit and nobody would run this, so `--force`
is the answer and the file's own header is the warning.

**A silhouette cell is a weaker claim than a pack cell, and the page has to
keep saying so.** It proves the app's logic runs at that panel size with
those buttons. It proves nothing a chip decides: no driver, no timing, no
memory pressure, no silicon. Every silhouette carries a `provenance` block
whose numbers came off a datasheet, and the column header says
`datasheet only` under the board's name.

## Two things the matrix exposed that prose had hidden

Building the grid found two disagreements that a list of successes had no
way to show, and both are now visible on the page rather than fixed by
quietly dropping a cell.

**gameos's ports assume the reference panel.** Compiled against a 135x240
or a 240x135 silhouette, its shell draws its launcher grid at coordinates
outside the panel: the proof PNG is a flat backdrop on one board and a
clipped title on another, and on two more the module traps with a memory
access out of bounds. The cell says so, with the picture. `chrono` and
`fluidbox`'s web ports read `PANEL_W`/`PANEL_H` and render correctly on all
five.

**The web pack wires one click and one key, and a board may have neither.**
`packs/web/wasm/build.ts`'s generated device header takes the first `click`
button and the first `key` button and nothing else, so Watchy, which
declares four clicks and no key, compiles with `BTN_PWR` at -1 and loses
that control entirely, while `tools/verdict.ts` reports the friendlier
answer that a click stands in for the key. Both are honest about their own
question and they do not agree. The gap is written down in that silhouette's
own `AGENTS.md`; closing it is a change to the pack, not to the ledger.

## The field this replaces

`bundle.json`'s `silicon` block stays where it is, as the record of what was
done on a bench, and **nothing under `site/` reads it any more**. The
gallery's silicon mark is the key the ledger stores and the count the
attestation endpoint returns, which is what [0011](0011-attestation-is-a-run-not-a-claim.md)
decided and what this change finishes.
