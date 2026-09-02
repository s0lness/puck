# `site/` - the public gallery at puck.sylve.org

`site/build.ts` writes `site/dist/`, which is **committed**: Cloudflare Pages
serves it as-is, with no Pages-side build step. `bun run site:build` is the
only build, and a change to anything under `site/` is not shipped until
`site/dist/` is rebuilt and committed alongside it.

The tracked sources are `site/build.ts` (the generator), `site/styles.css`,
`site/flasher/` (the WebUSB and Web Serial flashers), `site/attest/` (the
"prove it runs" step), `site/attest-client.ts` (the counter every page
shares), `site/functions/` (the Pages Functions), `site/d1/` (their schema),
`site/flash-artifacts/` and `site/demo-media/`. Third-party code that ends up
inside `site/dist/` is attributed in [`NOTICE.md`](NOTICE.md).

Headless checks: `bun run site:verify-flash-ui`, `bun run site:verify-attest-ui`,
`bun run site:verify-embeds`, `bun run site:verify-web`. All four drive the
built `site/dist/` through a real Chrome with no board and no Cloudflare
account anywhere.

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
verdict, the per-capture-point pixel counts, the board family, and the
server's own UTC date. No IP, no user agent, no cookie, no session, no
fingerprint, no hash of any of those. `site/d1/schema.sql` says the same
thing from the database's side, and it is why the counter reads
"confirmations" and never "boards": nothing here identifies a board, so
there is no honest way to tell two runs on one board from two runs on two.

### The two steps that make this endpoint live

Neither is done by this repository, and neither is done by a deploy. Both are
one-time account operations, listed here so nobody has to reconstruct them.

**1. Create the D1 database.** Either in the dashboard (Workers & Pages ->
D1 -> Create database, named `puck-attest`), or over the API with an existing
token:

```
curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"puck-attest"}'
```

Then apply the schema. This is the **only** thing this repository uses
`wrangler` for, and it is schema, never deploys:

```
npx wrangler d1 execute puck-attest --remote --file=site/d1/schema.sql
```

**2. Bind it to the Pages project as `ATTEST`.** In the dashboard: the `puck`
Pages project -> Settings -> Bindings -> D1 database bindings -> Add, with
**variable name `ATTEST`** (exactly, uppercase: `site/functions/api/attest.ts`
reads `env.ATTEST`) and the `puck-attest` database, for both Production and
Preview. The binding takes effect on the next deployment, so redeploy after
adding it.

Until both steps are done, `GET /api/attest` and `POST /api/attest` answer
`503` with a message pointing back at this section, the counters fall back to
their empty state ("no board has confirmed this yet"), and every other part of
the site is unaffected. That is deliberate: a static clone of `site/dist/`
served from anywhere has no functions behind it at all, and it has to keep
working.

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
confirmations, diverged, lastConfirmedAt } } }`, which is what
[`attest-client.ts`](attest-client.ts)'s `fetchAttestations()` reads and what
every card's counter is rendered from.
