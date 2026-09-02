// POST /api/attest              - record one confirmed run of a port's trace on a real board
// GET  /api/attest              - every app x pack summary
// GET  /api/attest?app=&pack=   - one app x pack summary
//
// A Cloudflare Pages Function over the KV namespace bound as ATTEST. See
// site/README.md for the key shapes and the binding; this file assumes the
// binding exists and says so plainly when it does not, rather than failing
// as a null dereference. The PREVIEW environment deliberately has no
// binding, so every preview deployment answers 503 here and the counters
// fall back to their empty state, which is the same path a static clone of
// site/dist/ takes.
//
// KV, NOT D1, and not because KV is the better fit: the account is at its
// ten-database D1 limit. What that costs is stated below rather than
// discovered, at "the race".
//
// WHAT THIS ENDPOINT KNOWS ABOUT THE PERSON USING IT: nothing that outlives
// a minute, and nothing that is ever stored next to an attestation. The
// record it writes carries an app name, a pack name, an artifact hash, a
// verdict, per-point pixel counts, and a board family (site/attest/plan.ts's
// AttestPost). It reads no cookie and sets no cookie. The one exception is
// the rate-limit key, and it is deliberately shaped so it cannot become
// anything else: see "the rate limit" below.
//
// THE DATE IS STAMPED HERE, NOT ACCEPTED. The body carries the browser's own
// date because a person reading their own posted record should see what
// their machine thought the day was, but the date every count and every
// "last confirmed N days ago" is computed from is this server's own UTC
// date. A client date is a number the client chose, and a public endpoint
// that ordered its own history by one would be trivially rewritable.
//
// TYPES ARE DECLARED, NOT DEPENDED ON. This repository's only dependencies
// are puppeteer-core, esptool-js and typescript (package.json), and pulling
// @cloudflare/workers-types in for three interfaces would be a worse trade
// than the twenty lines below - the same call site/flasher/webserial.d.ts
// already made for Web Serial.

interface KVListKey<M> {
  name: string;
  metadata?: M;
}

interface KVListResult<M> {
  keys: KVListKey<M>[];
  list_complete: boolean;
  cursor?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  list<M = unknown>(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult<M>>;
}

interface Env {
  ATTEST?: KVNamespace;
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

/** The value (and the list metadata) under a summary key. */
interface Summary {
  /** Matching runs. Confirmations, never boards: nothing here identifies a board. */
  count: number;
  /** Runs that came back diverged. Kept because a divergence is evidence, not a discarded failure. */
  diverged: number;
  /** Server-stamped UTC date of the most recent MATCHING run, or null. */
  lastConfirmedAt: string | null;
}

const EMPTY_SUMMARY: Summary = { count: 0, diverged: 0, lastConfirmedAt: null };

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
// A real body for the largest bundle in this repository is a couple of
// hundred bytes. 4 KB is generous by an order of magnitude and still bounds
// what one request can push into KV.
const MAX_BODY_BYTES = 4096;
// One post per (app, pack, artifact) per client per minute. Long enough to
// stop a loop, short enough that a person re-running a flaky board is never
// told to wait.
const RATE_LIMIT_SECONDS = 60;

function summaryKey(app: string, pack: string): string {
  return `s:${app}:${pack}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The counter is read by the gallery's own pages and is a small,
      // public number; a short cache keeps a burst of card renders off KV
      // without making a fresh attestation take minutes to appear.
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });
}

function badRequest(why: string): Response {
  return json({ error: why }, 400);
}

function noNamespace(): Response {
  return json(
    {
      error:
        "this deployment has no ATTEST namespace bound, so attestations cannot be read or recorded. Preview " +
        "deployments deliberately have none. See site/README.md for the binding.",
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
  // stored record would assert something its own evidence contradicts.
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

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// The rate limit
//
// One post per (app, pack, artifact sha) per client per minute, held in a KV
// key with a 60 second TTL. It needs SOMETHING per client, and the only
// thing a Pages Function has is the connecting IP, so the shape matters:
//
//   - the IP is SHA-256'd and only the first 16 hex characters are kept, so
//     the raw address is never written anywhere;
//   - the key expires in 60 seconds, so nothing accumulates;
//   - it lives under its own `rl:` prefix, is never read by the GET side,
//     and is never joined to an attestation record, which has no field it
//     could be joined on anyway.
//
// If the header is missing (it always exists in production, in front of
// Cloudflare) the per-client limit is skipped rather than collapsed into one
// global bucket: a shared bucket would let one caller lock everybody else
// out of posting, which is a worse failure than no limit.
// ---------------------------------------------------------------------

async function clientFingerprint(request: Request): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

export async function onRequestPost(context: FunctionContext): Promise<Response> {
  const kv = context.env.ATTEST;
  if (!kv) return noNamespace();

  // Read as text first: a 400 for an oversized body must not require parsing
  // the oversized body.
  const text = await context.request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return badRequest(`the body must be at most ${MAX_BODY_BYTES} bytes; a real attestation is a few hundred`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest("the body is not valid JSON");
  }
  const parsed = parseBody(raw);
  if (typeof parsed === "string") return badRequest(parsed);

  const who = await clientFingerprint(context.request);
  const rateKey = who ? `rl:${who}:${parsed.app}:${parsed.pack}:${parsed.portSha}` : null;
  if (rateKey && (await kv.get(rateKey)) !== null) {
    return json(
      {
        error:
          `this result was already posted for ${parsed.app} on ${parsed.pack} within the last ${RATE_LIMIT_SECONDS} seconds. ` +
          `Run the trace again if the board's answer changed.`,
      },
      429
    );
  }

  const confirmedAt = todayUTC();
  // A random suffix, not a counter: two posts landing in the same second
  // must not overwrite each other, and there is no sequence to read.
  const suffix = crypto.randomUUID().slice(0, 8);
  const record = {
    app: parsed.app,
    pack: parsed.pack,
    portSha: parsed.portSha,
    verdict: parsed.verdict,
    points: parsed.points,
    boardFamily: parsed.boardFamily,
    confirmedAt,
    clientDate: parsed.date,
  };
  await kv.put(`a:${parsed.app}:${parsed.pack}:${confirmedAt}:${suffix}`, JSON.stringify(record));

  // THE RACE, stated rather than discovered. This is a read-modify-write on
  // one key, and KV offers no compare-and-set, so two posts for the same
  // app+pack landing within the same eventual-consistency window can both
  // read the same summary and one can overwrite the other's increment. The
  // lost update costs one confirmation off a public counter, the individual
  // `a:` records are unaffected (each has its own key), and the summary can
  // be rebuilt from them at any time by listing that prefix. At this scale,
  // a handful of people posting after flashing a board they are holding,
  // that is the right trade against a lock or a durable object. If the
  // counter ever matters enough to be exact, rebuild it from `a:` rather
  // than making this write cleverer.
  const key = summaryKey(parsed.app, parsed.pack);
  let summary: Summary = { ...EMPTY_SUMMARY };
  const existing = await kv.get(key);
  if (existing) {
    try {
      const prev = JSON.parse(existing) as Partial<Summary>;
      summary = {
        count: typeof prev.count === "number" ? prev.count : 0,
        diverged: typeof prev.diverged === "number" ? prev.diverged : 0,
        lastConfirmedAt: typeof prev.lastConfirmedAt === "string" ? prev.lastConfirmedAt : null,
      };
    } catch {
      // A corrupt summary is recoverable (it is derived data); starting it
      // over is better than refusing the post that found it.
    }
  }
  if (parsed.verdict === "match") {
    summary.count++;
    if (!summary.lastConfirmedAt || confirmedAt > summary.lastConfirmedAt) summary.lastConfirmedAt = confirmedAt;
  } else {
    summary.diverged++;
  }
  // The metadata copy is what the listing below reads, so rendering every
  // card's counter is one list call rather than a get per app+pack.
  await kv.put(key, JSON.stringify(summary), { metadata: summary });

  if (rateKey) await kv.put(rateKey, "1", { expirationTtl: RATE_LIMIT_SECONDS });

  return json({ recorded: true, app: parsed.app, pack: parsed.pack, verdict: parsed.verdict }, 201);
}

function countEntry(app: string, pack: string, summary: Summary): Record<string, unknown> {
  return {
    app,
    pack,
    // The client's own field name: confirmations, never boards. Nothing here
    // identifies a board, so two runs on one board and two runs on two are
    // indistinguishable, and the wording has to say only what the data can
    // support.
    confirmations: summary.count,
    diverged: summary.diverged,
    lastConfirmedAt: summary.lastConfirmedAt,
  };
}

export async function onRequestGet(context: FunctionContext): Promise<Response> {
  const kv = context.env.ATTEST;
  if (!kv) return noNamespace();

  const url = new URL(context.request.url);
  const app = url.searchParams.get("app");
  const pack = url.searchParams.get("pack");

  if (app || pack) {
    if (!app || !pack) return badRequest("app and pack must be given together");
    if (!NAME_RE.test(app) || !NAME_RE.test(pack)) return badRequest("app and pack must be registry.json names");
    const raw = await kv.get(summaryKey(app, pack));
    let summary: Summary = { ...EMPTY_SUMMARY };
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<Summary>;
        summary = {
          count: typeof parsed.count === "number" ? parsed.count : 0,
          diverged: typeof parsed.diverged === "number" ? parsed.diverged : 0,
          lastConfirmedAt: typeof parsed.lastConfirmedAt === "string" ? parsed.lastConfirmedAt : null,
        };
      } catch {
        // fall through to the empty summary: an unreadable derived value is
        // "nothing confirmed yet", not an error for the reader to handle
      }
    }
    // The same envelope the listing returns, so a caller can read one shape
    // whichever way it asked.
    return json({ counts: { [`${app}:${pack}`]: countEntry(app, pack, summary) } });
  }

  // Every summary, in one listing: a gallery page shows a counter per card,
  // and a request per card would be a request per app for a handful of
  // integers. The summary rides in each key's metadata, so this is one call
  // with no per-key get behind it.
  const counts: Record<string, unknown> = {};
  let cursor: string | undefined;
  do {
    const page = await kv.list<Partial<Summary>>({ prefix: "s:", cursor });
    for (const entry of page.keys) {
      const rest = entry.name.slice(2);
      const split = rest.indexOf(":");
      if (split < 0) continue;
      const entryApp = rest.slice(0, split);
      const entryPack = rest.slice(split + 1);
      const m = entry.metadata;
      const summary: Summary = {
        count: typeof m?.count === "number" ? m.count : 0,
        diverged: typeof m?.diverged === "number" ? m.diverged : 0,
        lastConfirmedAt: typeof m?.lastConfirmedAt === "string" ? m.lastConfirmedAt : null,
      };
      counts[`${entryApp}:${entryPack}`] = countEntry(entryApp, entryPack, summary);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

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
