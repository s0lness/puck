# `site/` - the public gallery at puck.sylve.org

`site/build.ts` writes `site/dist/`, which is **committed**: Cloudflare Pages
serves it as-is, with no Pages-side build step. `bun run site:build` is the
only build, and a change to anything under `site/` is not shipped until
`site/dist/` is rebuilt and committed alongside it.

The tracked sources are `site/build.ts` (the generator), `site/styles.css`,
`site/flasher/` (the WebUSB and Web Serial flashers), `site/attest/` (the
"prove it runs" step), `site/attest-client.ts` (the counter every page
shares), `site/functions/` (the Pages Functions), `site/flash-artifacts/` and
`site/demo-media/`. Third-party code that ends up inside `site/dist/` is
attributed in [`NOTICE.md`](NOTICE.md).

Headless checks: `bun run site:verify-flash-ui`, `bun run site:verify-attest-ui`,
`bun run site:verify-embeds`, `bun run site:verify-web`. All four drive the
built `site/dist/` through a real Chrome with no board and no Cloudflare
account anywhere. `bun run site:test-api` runs the Pages Functions' own unit
tests against a fake KV namespace, which is where the endpoint's validation,
rate limit and summary bookkeeping are proven (the headless check stubs
`/api/attest` on purpose: its job is the page, not the function).

## Attestations: `/api/attest`

A flash page can do more than write firmware to a board: it can then run that
app's own recorded trace on the board it just flashed, diff the captured
frames against the same recorded frames `bun run verify-bundle` compares
against, and offer to post the verdict. `site/attest/` is that step, and
`/api/attest` is where the verdict goes.

This replaces a hand-typed date. Before it, a port's `bundle.json` carried a
`silicon` block with an `attestedAt` string somebody typed after a bench run,
and nothing kept it honest or current. Now a card can say how many confirmed
runs a port has and when the most recent one was, because each one is a real
run somebody's own board actually performed.

**What is stored, in full:** app name, pack name, the sha256 of the firmware
artifact the browser fetched (computed in the page, from the bytes), the
verdict, the per-capture-point pixel counts, the board family, the server's
own UTC date, and the browser's own date beside it. No user agent, no cookie,
no session, no fingerprint. That is why the counter reads "confirmations" and
never "boards": nothing here identifies a board, so there is no honest way to
tell two runs on one board from two runs on two.

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
s:<app>:<pack>                          the summary: {count, diverged, lastConfirmedAt}
rl:<hashed ip>:<app>:<pack>:<port sha>  rate limit, 60 second TTL
```

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
refuses a verdict that disagrees with the points it claims to summarise.

`GET /api/attest` returns `{ counts: { "<app>:<pack>": { app, pack,
confirmations, diverged, lastConfirmedAt } } }` for every pair, which is what
[`attest-client.ts`](attest-client.ts)'s `fetchAttestations()` reads and what
every card's counter is rendered from. `GET /api/attest?app=&pack=` returns
the same envelope holding just that one pair, so a caller reads one shape
whichever way it asked.
