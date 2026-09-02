// POST /api/attest  - record one confirmed run of a port's trace on a real board
// GET  /api/attest   - counts and latest date per app x pack
//
// A Cloudflare Pages Function, backed by the D1 database bound as ATTEST.
// See site/README.md for exactly which dashboard/API steps create that
// database and that binding; this file assumes both exist and says so
// plainly when they do not, rather than failing as a null dereference.
//
// WHAT THIS ENDPOINT KNOWS ABOUT THE PERSON USING IT: nothing. It reads no
// cookie, sets no cookie, stores no IP, no user agent, no session, no
// fingerprint, and no hash of any of those. The body it accepts carries an
// app name, a pack name, an artifact hash, a verdict, per-point pixel
// counts, and a board family (site/attest/plan.ts's AttestPost). That is
// the whole record, and the schema comment says the same thing from the
// other side.
//
// THE DATE IS STAMPED HERE, NOT ACCEPTED. The body carries the browser's own
// date because a person reading their own posted record should see what
// their machine thought the day was, but `confirmed_at` - the column every
// count and every "last confirmed N days ago" is computed from - is the
// server's own UTC date. A client date is a number the client chose, and a
// public endpoint that ordered its own history by one would be trivially
// rewritable.
//
// TYPES ARE DECLARED, NOT DEPENDED ON. This repository's only dependencies
// are puppeteer-core, esptool-js and typescript (package.json), and pulling
// @cloudflare/workers-types in for two interfaces would be a worse trade
// than the fifteen lines below - the same call site/flasher/webserial.d.ts
// already made for Web Serial.

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface Env {
  ATTEST?: D1Database;
}

interface FunctionContext {
  request: Request;
  env: Env;
}

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

type Verdict = "match" | "diverge";
type BoardFamily = "rp2350" | "esp32";

interface PointResult {
  trace: string;
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
}

interface AttestBody {
  app: string;
  pack: string;
  portSha: string;
  verdict: Verdict;
  points: PointResult[];
  boardFamily: BoardFamily;
  date: string;
}

// Caps, not policy: this is a public, unauthenticated endpoint, and the only
// honest defence a static-site function has against a bored visitor is
// refusing anything that is not the shape it asked for. A name is a
// registry.json identifier, a sha is a sha, and a run has capture points in
// the single digits, not thousands.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POINTS = 64;
const MAX_TRACE_NAME = 128;

function badRequest(why: string): Response {
  return json({ error: why }, 400);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The counter is read by the gallery's own pages and is a small,
      // public number; a short cache keeps a burst of card renders off D1
      // without making a fresh attestation take minutes to appear.
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });
}

function noDatabase(): Response {
  return json(
    {
      error:
        "this deployment has no ATTEST database bound, so attestations cannot be read or recorded. See site/README.md " +
        "for the two steps that create the D1 database and bind it to the Pages project.",
    },
    503
  );
}

function parseBody(raw: unknown): AttestBody | string {
  if (!raw || typeof raw !== "object") return "the body must be a JSON object";
  const b = raw as Record<string, unknown>;

  if (typeof b.app !== "string" || !NAME_RE.test(b.app)) return "app must be a registry.json app name";
  if (typeof b.pack !== "string" || !NAME_RE.test(b.pack)) return "pack must be a registry.json pack name";
  if (typeof b.portSha !== "string" || !SHA_RE.test(b.portSha)) return "portSha must be the artifact's sha256 as 64 hex characters";
  if (b.verdict !== "match" && b.verdict !== "diverge") return 'verdict must be "match" or "diverge"';
  if (b.boardFamily !== "rp2350" && b.boardFamily !== "esp32") return 'boardFamily must be "rp2350" or "esp32"';
  if (typeof b.date !== "string" || !DATE_RE.test(b.date)) return "date must be YYYY-MM-DD";
  if (!Array.isArray(b.points) || b.points.length === 0) return "points must be a non-empty array of capture-point results";
  if (b.points.length > MAX_POINTS) return `points must hold at most ${MAX_POINTS} entries`;

  const points: PointResult[] = [];
  for (const entry of b.points) {
    if (!entry || typeof entry !== "object") return "every point must be an object";
    const p = entry as Record<string, unknown>;
    if (typeof p.trace !== "string" || p.trace.length === 0 || p.trace.length > MAX_TRACE_NAME) return "every point needs a trace name";
    if (typeof p.atMs !== "number" || !Number.isFinite(p.atMs) || p.atMs < 0) return "every point needs a non-negative atMs";
    if (typeof p.match !== "boolean") return "every point needs a boolean match";
    if (typeof p.diffPixels !== "number" || !Number.isFinite(p.diffPixels)) return "every point needs a numeric diffPixels";
    if (typeof p.totalPixels !== "number" || !Number.isFinite(p.totalPixels) || p.totalPixels <= 0) return "every point needs a positive totalPixels";
    points.push({
      trace: p.trace,
      atMs: Math.round(p.atMs),
      match: p.match,
      diffPixels: Math.round(p.diffPixels),
      totalPixels: Math.round(p.totalPixels),
    });
  }

  // The verdict has to agree with the points it claims to summarise, or the
  // stored row would assert something its own evidence contradicts.
  const everyPointMatched = points.every((p) => p.match);
  if ((b.verdict === "match") !== everyPointMatched) {
    return 'verdict "match" requires every point to have matched, and "diverge" requires at least one that did not';
  }

  return {
    app: b.app,
    pack: b.pack,
    portSha: b.portSha,
    verdict: b.verdict,
    points,
    boardFamily: b.boardFamily,
    date: b.date,
  };
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

export async function onRequestPost(context: FunctionContext): Promise<Response> {
  const db = context.env.ATTEST;
  if (!db) return noDatabase();

  let raw: unknown;
  try {
    raw = await context.request.json();
  } catch {
    return badRequest("the body is not valid JSON");
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") return badRequest(parsed);

  await db
    .prepare(
      `INSERT INTO attestations (app, pack, port_sha, verdict, points, board_family, confirmed_at, client_date)
       VALUES (?, ?, ?, ?, ?, ?, date('now'), ?)`
    )
    .bind(parsed.app, parsed.pack, parsed.portSha, parsed.verdict, JSON.stringify(parsed.points), parsed.boardFamily, parsed.date)
    .run();

  return json({ recorded: true, app: parsed.app, pack: parsed.pack, verdict: parsed.verdict }, 201);
}

interface CountRow {
  app: string;
  pack: string;
  confirmations: number;
  diverged: number;
  last_confirmed_at: string | null;
}

export async function onRequestGet(context: FunctionContext): Promise<Response> {
  const db = context.env.ATTEST;
  if (!db) return noDatabase();

  // One query for the whole index: a gallery page shows a counter per card,
  // and a request per card would be a request per app for a handful of
  // integers.
  const rows = await db
    .prepare(
      `SELECT app,
              pack,
              SUM(CASE WHEN verdict = 'match' THEN 1 ELSE 0 END)   AS confirmations,
              SUM(CASE WHEN verdict = 'diverge' THEN 1 ELSE 0 END) AS diverged,
              MAX(CASE WHEN verdict = 'match' THEN confirmed_at END) AS last_confirmed_at
         FROM attestations
        GROUP BY app, pack`
    )
    .all<CountRow>();

  const counts: Record<string, unknown> = {};
  for (const row of rows.results ?? []) {
    counts[`${row.app}:${row.pack}`] = {
      app: row.app,
      pack: row.pack,
      confirmations: Number(row.confirmations ?? 0),
      diverged: Number(row.diverged ?? 0),
      lastConfirmedAt: row.last_confirmed_at ?? null,
    };
  }
  return json({ counts });
}

// Anything else is a wrong method, answered as one rather than as a 404 that
// would read like "this endpoint does not exist".
export async function onRequest(context: FunctionContext): Promise<Response> {
  const method = context.request.method.toUpperCase();
  if (method === "GET") return onRequestGet(context);
  if (method === "POST") return onRequestPost(context);
  return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}
