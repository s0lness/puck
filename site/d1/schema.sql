-- Attestations: one row per confirmed run of a port's own trace on a real
-- board, posted from the gallery's flash page (site/attest/attest-ui.ts).
--
-- Applied with:
--   npx wrangler d1 execute puck-attest --remote --file=site/d1/schema.sql
--
-- That is the one place this repository uses wrangler, and it is for schema
-- only. Nothing about deploying the site goes through it: site/dist/ is
-- committed and Cloudflare Pages serves it from git. See site/README.md.
--
-- WHAT IS DELIBERATELY NOT HERE. No identifier of any kind: no IP, no user
-- agent, no cookie, no fingerprint, no session, no salted hash of any of
-- those. A row says "somebody ran this port's trace on this board family and
-- got this result on this day", and that is the entire claim it can support.
-- It is also why the read side counts CONFIRMATIONS and never "boards":
-- there is no honest way to tell two runs on one board from two runs on two.

CREATE TABLE IF NOT EXISTS attestations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The app bundle and device pack, exactly as registry.json names them.
  app           TEXT NOT NULL,
  pack          TEXT NOT NULL,

  -- sha256 (hex, 64 chars) of the firmware artifact the page fetched and
  -- flashed, computed in the browser from the bytes themselves. This is what
  -- makes a stale attestation visible: a rebuilt artifact is a different sha,
  -- so a count can be read per-artifact rather than as one running total that
  -- silently carries forward proof about firmware nobody ships any more.
  port_sha      TEXT NOT NULL,

  -- 'match' when every capture point matched the bundle's recorded frame,
  -- 'diverge' otherwise. A divergence is a result worth keeping, not a
  -- failure to discard: it is evidence about this port on this silicon.
  verdict       TEXT NOT NULL CHECK (verdict IN ('match', 'diverge')),

  -- The per-capture-point results, as posted, JSON:
  -- [{"trace","atMs","match","diffPixels","totalPixels"}, ...]
  points        TEXT NOT NULL,

  -- 'rp2350' or 'esp32': which browser flashing path put the firmware there.
  board_family  TEXT NOT NULL,

  -- The day the run is counted on, stamped SERVER-side (date('now'), UTC).
  -- The browser's own date is kept beside it in client_date and is never
  -- what anything counts by: a client date is a number the client chose.
  confirmed_at  TEXT NOT NULL,
  client_date   TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The read side is always "counts and latest date, grouped by app and pack".
CREATE INDEX IF NOT EXISTS attestations_app_pack ON attestations (app, pack, verdict, confirmed_at);
CREATE INDEX IF NOT EXISTS attestations_port_sha ON attestations (port_sha);
