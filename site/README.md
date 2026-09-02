# `site/` - the public gallery at puck.sylve.org

`site/build.ts` writes `site/dist/`, which is **committed**: Cloudflare Pages
serves it as-is, with no Pages-side build step. `bun run site:build` is the
only build, and a change to anything under `site/` is not shipped until
`site/dist/` is rebuilt and committed alongside it.

**It builds from `ledger.json`, not from the bundles.** `bun run ledger`
(`tools/ledger.ts`) computes every app in `registry.json` against every
target in it and writes that file at the repository root; `site/build.ts`
reads it and renders the landing page as the matrix, one cell per app per
device. Run the ledger first, or the build stops and says so. The one thing
still read out of a `bundle.json` is an attestable port's own inputs - its
trace files and either its recorded-frame directory or its checker path and
capture points - which are what a flash page hands a board rather than
results about a port. `bundle.json`'s `silicon` block is read nowhere
under `site/` any more: the silicon mark is a count from `/api/attest`. See
[`docs/decisions/0012`](../docs/decisions/0012-the-gallery-is-built-from-a-ledger.md).

The tracked sources are `site/build.ts` (the generator), `site/styles.css`,
`site/flasher/` (the WebUSB and Web Serial flashers), `site/attest/` (the
"prove it runs" step, including `attest/checkers.ts`, the table of every
bundle checker this gallery can run in a page), `site/attest-client.ts` (the
counter every page shares), `site/functions/` (the Pages Functions),
`site/flash-artifacts/` and `site/demo-media/`. Third-party code that ends up inside `site/dist/` is
attributed in [`NOTICE.md`](NOTICE.md).

Headless checks: `bun run site:verify-matrix`, `bun run site:verify-flash-ui`,
`bun run site:verify-attest-ui`, `bun run site:verify-embeds`,
`bun run site:verify-web`. All five drive the built `site/dist/` through a
real Chrome with no board and no Cloudflare account anywhere.
`site:verify-matrix` is the one that holds the landing page to the ledger:
the grid is complete, every cell is exactly one of runs / verdict / empty
state, every silhouette cell that claims to run opens at that board's own
panel size, the external row carries its provenance, and the page never
scrolls sideways on a phone while the table does. `bun run site:test-api`
runs the Pages Functions' own unit tests against a fake KV namespace, which
is where the endpoint's validation, rate limit and summary bookkeeping are
proven (the headless check stubs `/api/attest` on purpose: its job is the
page, not the function).

## The matrix

Rows are apps, columns are targets, in three groups that read left to right:
the device packs this repository carries, then any pack an app's own bundle
names that this repository does not carry, then the silhouettes. Each cell
declares what it is on itself as `data-cell`:

- `runs`: a link that opens something that runs, plus one line of marks
  (the port's mode, emulator, host, blind, silicon, or the silhouette
  mark).
- `verdict`: the mechanical verdict and the marks it earned, and no link
  claiming it runs.
- `empty`: the verdict word and a link to `/puck-publish/`, which serves
  `skills/puck-publish/SKILL.md` whole.

**A cell shows a picture and a row of chips and nothing else.** Every
sentence this page has folds behind its own mark: a `<details>` whose
`<summary>` IS the chip, with the reason in a `<p>` that stays in the DOM
and out of the visible flow until somebody opens it, plus the same sentence
in a `title` for a pointer. A disclosure rather than a tooltip alone
because a tooltip reaches neither a keyboard nor a thumb; a disclosure
rather than script because `site/dist/` gets served from a plain file
server and off disk. It flows below the chip rather than floating over it,
since `.matrix-scroll` clips its own overflow and a popover would be cut
off at the column edge on exactly the narrow screen it exists to serve.
`site:verify-matrix` asserts all of that: the reasons are present, none is
laid out until a mark is opened, a mark takes keyboard focus, opening it
really shows the sentence, and no row stands more than twice as tall as its
own thumbnail.

A silhouette cell that runs gets its own run page under `run/<app>-<silhouette>.html`,
written by the same generator every other run page goes through, around a
module built by `packs/web/wasm/build.ts --silhouette`. A silhouette whose
declared panel format the emulator has no reader for (Watchy's `mono1`) gets
no page and says why on the cell: `packs/web`'s framebuffer is RGB565
whatever a `device.json` calls its glass, so presenting it would mean
pretending otherwise.

The table is the one thing on the page wider than the prose column, and it
scrolls inside `.matrix-scroll`. The page itself must never scroll sideways;
`site:verify-matrix` checks that at 390px.

## Attestations: `/api/attest`

A flash page can do more than write firmware to a board: it can then run that
app's own trace on the board it just flashed, put the result through the same
check `bun run verify-bundle` puts that port through, and offer to post the
verdict. `site/attest/` is that step, and `/api/attest` is where the verdict
goes.

This replaces a hand-typed date. Before it, a port's `bundle.json` carried a
`silicon` block with an `attestedAt` string somebody typed after a bench run,
and nothing kept it honest or current. Now a card can say how many confirmed
runs a port has and when the most recent one was, because each one is a real
run somebody's own board actually performed.

### Two kinds of check, one counter

A port is verified one of two ways, and a board can be put through either:

- **`pixel-exact`** - the port has recorded frames, so every captured frame
  is diffed against the recorded one at tolerance zero, with the same
  `compareFrames`.
- **`invariants`** - the port has a checker instead (an `adaptation` port
  changed the interaction surface, so there is no second module to be
  identical to). The captured frames go to that bundle's own
  `invariants.ts`, the same function, bundled into the page by
  [`attest/checkers.ts`](attest/checkers.ts). That table is keyed by the
  path the bundle itself names, and `site/build.ts` refuses to emit a plan
  whose checker is not in it, so a page never carries a button with nothing
  behind it.

The two are **counted together** (both are runs a board performed) and
**named apart** (they are not the same claim). A card's chip names the kind
only when one port holds runs of both, which is the only time the total
could mislead.

An invariant that applies to this board and cannot be answered from what a
board reports - fluidbox's panel-push bound needs the emulator's push
instrumentation, and a board answers `SHOT` with its framebuffer - comes
back `unevaluable`. The section shows it, says the run is incomplete, and
offers no post button; the endpoint refuses such a record a second time,
by name. See [`docs/decisions/0011`](../docs/decisions/0011-attestation-is-a-run-not-a-claim.md)
and its addendum.

**What is stored, in full:** app name, pack name, the sha256 of the firmware
artifact the browser fetched (computed in the page, from the bytes), the kind
of check, the verdict, that check's own evidence (per-capture-point pixel
counts, or each invariant's id, name, status and its own message), the board
family, the server's own UTC date, and the browser's own date beside it. No
user agent, no cookie, no session, no fingerprint. That is why the counter
reads "confirmations" and never "boards": nothing here identifies a board, so
there is no honest way to tell two runs on one board from two runs on two.

The one thing that touches a client at all is the rate-limit key, and its
shape is the promise: the connecting IP is SHA-256'd and truncated to 16 hex
characters, the key lives under its own `rl:` prefix with a 60 second TTL, it
is never read by the `GET` side, and it is never joined to an attestation
record (which carries no field it could be joined on).

### The storage: a KV namespace, already created and bound

The namespace **`puck-attest`** (`7eddb277a6644e7ba78699b315a183dd`) exists
and is bound as **`ATTEST`** on the **production** environment of the `puck`
Pages project. Nothing about a deploy touches that binding.

**Preview has no binding, on purpose.** A preview deployment therefore
answers `503` from both methods and the counters fall back to their empty
state ("no board has confirmed this yet"). That is the same path a static
clone of `site/dist/` takes, served from anywhere with no functions behind
it, and both have to keep working.

**No `wrangler.toml`, and none may be added.** The bindings above were made
through the API, and a `wrangler.toml` in the repository would override them
on the next build. There is no `wrangler` step in this project at all any
more.

### The key shapes

```
a:<app>:<pack>:<YYYY-MM-DD>:<random>   one attestation, JSON
s:<app>:<pack>                          the summary: {count, diverged, lastConfirmedAt, kinds}
rl:<hashed ip>:<app>:<pack>:<port sha>  rate limit, 60 second TTL
```

`kinds` is `{"pixel-exact": {count, diverged}, "invariants": {count,
diverged}}`, and `count` above is their sum. A summary written before that
field existed simply has none, which reads as zeroes rather than as
corruption: the total was true then and stays true.

A summary is derived data: it is also written into the key's **metadata**, so
rendering every card's counter is one `list({prefix: "s:"})` with no per-key
read behind it. Updating it on each `POST` is a read-modify-write with no
compare-and-set, so two posts for the same app and pack inside one
consistency window can lose an increment. The individual `a:` records are
each on their own key and are never affected, so a summary can be rebuilt
from that prefix at any time. `site/functions/api/attest.ts` says the same at
the write itself.

### The limits

A body over **4 KB** is refused (a real one is a few hundred bytes), and a
second `POST` for the same app, pack and artifact sha from the same client
inside **60 seconds** answers `429`.

### Where the functions directory has to live

Cloudflare Pages looks for `functions/` at the **root directory of the
project**, next to the build output directory. So the `puck` Pages project
must be configured with:

- **Root directory:** `site`
- **Build command:** *(none)* - `site/dist/` is committed
- **Build output directory:** `dist`

With those, `site/functions/api/attest.ts` is served at `/api/attest` and
`site/dist/` is served at `/`. If the project's root directory is instead the
repository root (with output `site/dist`), Pages looks for a top-level
`functions/` directory, does not find one, and deploys the site with **no
functions and no error** - the counters simply stay on their empty state
forever. That silence is the failure mode worth knowing about.

### The API this repository's own pages speak

`POST /api/attest` takes exactly the body in
[`attest/plan.ts`](attest/plan.ts)'s `AttestPost`, validates every field, and
refuses a verdict that disagrees with the evidence it claims to summarise -
in either kind's own vocabulary. It also refuses, by name, any posted
invariant whose status is `unevaluable`, and a run whose every invariant was
skipped (it confirms nothing).

`GET /api/attest` returns `{ counts: { "<app>:<pack>": { app, pack,
confirmations, diverged, lastConfirmedAt, kinds } } }` for every pair, which is what
[`attest-client.ts`](attest-client.ts)'s `fetchAttestations()` reads and what
every card's counter is rendered from. `GET /api/attest?app=&pack=` returns
the same envelope holding just that one pair, so a caller reads one shape
whichever way it asked.
