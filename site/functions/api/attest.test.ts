// site/functions/api/attest.test.ts: the endpoint itself, against a fake KV
// namespace. `bun test site/functions` runs it, the same way the flasher's
// own unit tests next door are run.
//
// The headless check (scripts/verify-attest-ui.ts) stubs /api/attest with a
// puppeteer route, deliberately: its job is proving the PAGE posts the right
// thing to the right place, and a route does that without pretending to be
// Cloudflare. That leaves the function's own logic unproven, and the parts
// most worth proving are exactly the ones nobody exercises by hand: a body
// that lies about its own verdict, a body a megabyte long, a second post in
// the same minute, and whether a divergence still lands.
//
// The fake KV is a Map with the three methods the function calls, including
// list metadata, because the listing path reads metadata rather than doing a
// get per key and a fake that ignored metadata would let that path pass
// while returning zeroes in production.
import { describe, expect, test } from "bun:test";
import { onRequestGet, onRequestPost } from "./attest";

interface Stored {
  value: string;
  metadata?: unknown;
  expiresAt?: number;
}

class FakeKV {
  readonly store = new Map<string, Stored>();
  now = Date.now();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    this.store.set(key, {
      value,
      metadata: options?.metadata,
      expiresAt: options?.expirationTtl === undefined ? undefined : this.now + options.expirationTtl * 1000,
    });
  }

  async list<M>(options?: { prefix?: string }): Promise<{ keys: { name: string; metadata?: M }[]; list_complete: boolean }> {
    const prefix = options?.prefix ?? "";
    const keys: { name: string; metadata?: M }[] = [];
    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) continue;
      keys.push({ name, metadata: entry.metadata as M });
    }
    return { keys, list_complete: true };
  }
}

// The function's own FunctionContext, minus the fields it never reads.
type Ctx = Parameters<typeof onRequestPost>[0];

const IP = "203.0.113.7";

function post(body: unknown, kv: FakeKV | null, ip: string | null = IP): Ctx {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("CF-Connecting-IP", ip);
  return {
    request: new Request("https://puck.sylve.org/api/attest", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env: { ATTEST: kv as unknown as NonNullable<Ctx["env"]["ATTEST"]> | undefined },
  } as Ctx;
}

function get(kv: FakeKV | null, query = ""): Ctx {
  return {
    request: new Request(`https://puck.sylve.org/api/attest${query}`),
    env: { ATTEST: kv as unknown as NonNullable<Ctx["env"]["ATTEST"]> | undefined },
  } as Ctx;
}

const MATCHING = {
  app: "chrono",
  pack: "rp2350-touch-amoled-18",
  portSha: "a".repeat(64),
  kind: "pixel-exact",
  verdict: "match",
  points: [{ trace: "chrono-idle", atMs: 1008, match: true, diffPixels: 0, totalPixels: 164864 }],
  boardFamily: "rp2350",
  date: "2026-09-02",
};

const DIVERGING = {
  ...MATCHING,
  verdict: "diverge",
  points: [{ trace: "chrono-idle", atMs: 1008, match: false, diffPixels: 1, totalPixels: 164864 }],
};

// The other kind, and the other app: fluidbox is verified by its own
// invariants.ts, not by recorded frames, and its rp2350 port's panel-push
// bound is the one that cannot be answered by a board at all.
const INVARIANTS_MATCHING = {
  app: "fluidbox",
  pack: "esp32-s3-touch-amoled-18",
  portSha: "d".repeat(64),
  kind: "invariants",
  verdict: "match",
  invariants: [
    { id: "mass", name: "the same fluid is still there after the shake", status: "pass", message: "mass proxy: 6352px, then 6350px, a 0.03% drift" },
    { id: "push", name: "one tick never pushes the whole panel", status: "skip", message: "panel push: not checked on this device" },
  ],
  boardFamily: "esp32",
  date: "2026-09-02",
};

const INVARIANTS_DIVERGING = {
  ...INVARIANTS_MATCHING,
  verdict: "diverge",
  invariants: [
    { id: "mass", name: "the same fluid is still there after the shake", status: "pass", message: "mass proxy: 6352px, then 6350px, a 0.03% drift" },
    { id: "shake", name: "a shake visibly agitates the fluid", status: "fail", message: "shake agitation: only 0px differ, min required 1500px" },
  ],
};

describe("POST /api/attest", () => {
  test("records a matching run and moves the summary", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post(MATCHING, kv));
    expect(resp.status).toBe(201);

    const records = [...kv.store.keys()].filter((k) => k.startsWith("a:"));
    expect(records).toHaveLength(1);
    expect(records[0]).toStartWith("a:chrono:rp2350-touch-amoled-18:");

    const summary = JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!);
    expect(summary.count).toBe(1);
    expect(summary.diverged).toBe(0);
    expect(summary.lastConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("the stored date is the server's own, not the body's", async () => {
    const kv = new FakeKV();
    // A body claiming a date in the far future is exactly the rewrite a
    // client-trusted timestamp would allow.
    await onRequestPost(post({ ...MATCHING, date: "2099-12-31" }, kv));
    const summary = JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!);
    expect(summary.lastConfirmedAt).not.toBe("2099-12-31");
    const recordKey = [...kv.store.keys()].find((k) => k.startsWith("a:"))!;
    const record = JSON.parse((await kv.get(recordKey))!);
    expect(record.clientDate).toBe("2099-12-31");
    expect(record.confirmedAt).not.toBe("2099-12-31");
  });

  test("a divergence is recorded, and counted apart from confirmations", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post(DIVERGING, kv));
    expect(resp.status).toBe(201);
    const summary = JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!);
    expect(summary.count).toBe(0);
    expect(summary.diverged).toBe(1);
    expect(summary.lastConfirmedAt).toBeNull();
  });

  test("an invariants run is recorded under the same key prefix, counted apart by kind", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post(INVARIANTS_MATCHING, kv));
    expect(resp.status).toBe(201);
    const summary = JSON.parse((await kv.get("s:fluidbox:esp32-s3-touch-amoled-18"))!);
    expect(summary.count).toBe(1);
    expect(summary.kinds.invariants).toEqual({ count: 1, diverged: 0 });
    expect(summary.kinds["pixel-exact"]).toEqual({ count: 0, diverged: 0 });

    const recordKey = [...kv.store.keys()].find((k) => k.startsWith("a:"))!;
    const record = JSON.parse((await kv.get(recordKey))!);
    expect(record.kind).toBe("invariants");
    expect(record.points).toBeUndefined();
    expect(record.invariants).toHaveLength(2);
  });

  test("both kinds land on one counter, and stay tellable apart under it", async () => {
    const kv = new FakeKV();
    await onRequestPost(post({ ...INVARIANTS_MATCHING, app: "chrono", pack: "rp2350-touch-amoled-18" }, kv));
    await onRequestPost(post(MATCHING, kv, "198.51.100.9"));
    const summary = JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!);
    expect(summary.count).toBe(2);
    expect(summary.kinds).toEqual({ "pixel-exact": { count: 1, diverged: 0 }, invariants: { count: 1, diverged: 0 } });
  });

  test("an invariants verdict that contradicts its own outcomes is refused", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post({ ...INVARIANTS_MATCHING, invariants: INVARIANTS_DIVERGING.invariants }, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("every invariant to have held");
    expect(kv.store.size).toBe(0);
  });

  test("a run holding an unanswered invariant is refused, by name", async () => {
    const kv = new FakeKV();
    const body = {
      ...INVARIANTS_MATCHING,
      invariants: [
        INVARIANTS_MATCHING.invariants[0],
        { id: "push", name: "one tick never pushes the whole panel", status: "unevaluable", message: "a board reports no push stats" },
      ],
    };
    const resp = await onRequestPost(post(body, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("push");
    expect(await onRequestPost(post(body, kv)).then((r) => r.status)).toBe(400);
    expect(kv.store.size).toBe(0);
  });

  test("a run where every invariant was skipped confirms nothing and is refused", async () => {
    const kv = new FakeKV();
    const body = { ...INVARIANTS_MATCHING, invariants: [INVARIANTS_MATCHING.invariants[1]] };
    const resp = await onRequestPost(post(body, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("confirms nothing");
    expect(kv.store.size).toBe(0);
  });

  test("neither kind may carry the other's evidence", async () => {
    const kv = new FakeKV();
    const asPixel = await onRequestPost(post({ ...MATCHING, invariants: INVARIANTS_MATCHING.invariants }, kv));
    expect(asPixel.status).toBe(400);
    expect(await asPixel.text()).toContain("carries points, not invariants");
    const asInvariants = await onRequestPost(post({ ...INVARIANTS_MATCHING, points: MATCHING.points }, kv));
    expect(asInvariants.status).toBe(400);
    expect(await asInvariants.text()).toContain("carries invariants, not points");
    expect(kv.store.size).toBe(0);
  });

  test("a body with no kind is refused: a verdict has to say what produced it", async () => {
    const kv = new FakeKV();
    const { kind: _kind, ...noKind } = MATCHING;
    const resp = await onRequestPost(post(noKind, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("kind must be");
    expect(kv.store.size).toBe(0);
  });

  test("a verdict that contradicts its own points is refused", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post({ ...MATCHING, verdict: "match", points: DIVERGING.points }, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("every point to have matched");
    expect(kv.store.size).toBe(0);
  });

  test("a body over 4 KB is refused without being parsed", async () => {
    const kv = new FakeKV();
    const huge = { ...MATCHING, points: Array.from({ length: 60 }, () => ({ ...MATCHING.points[0], trace: "x".repeat(120) })) };
    const resp = await onRequestPost(post(huge, kv));
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain("at most 4096 bytes");
    expect(kv.store.size).toBe(0);
  });

  test("a second post for the same artifact within the minute is refused, and a later one is not", async () => {
    const kv = new FakeKV();
    expect((await onRequestPost(post(MATCHING, kv))).status).toBe(201);
    const again = await onRequestPost(post(MATCHING, kv));
    expect(again.status).toBe(429);
    // Still one confirmation, so the limit actually protects the number and
    // not just the request.
    expect(JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!).count).toBe(1);

    kv.now += 61_000; // the rate-limit key's own TTL, elapsed
    expect((await onRequestPost(post(MATCHING, kv))).status).toBe(201);
    expect(JSON.parse((await kv.get("s:chrono:rp2350-touch-amoled-18"))!).count).toBe(2);
  });

  test("the limit is per artifact, so a rebuilt firmware is postable straight away", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(MATCHING, kv));
    const other = await onRequestPost(post({ ...MATCHING, portSha: "b".repeat(64) }, kv));
    expect(other.status).toBe(201);
  });

  test("the rate-limit key holds no readable address, and expires", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(MATCHING, kv));
    const rateKeys = [...kv.store.keys()].filter((k) => k.startsWith("rl:"));
    expect(rateKeys).toHaveLength(1);
    expect(rateKeys[0]).not.toContain(IP);
    expect(kv.store.get(rateKeys[0]!)!.expiresAt).toBeDefined();
    // And nothing about the client reached the attestation record itself.
    const recordKey = [...kv.store.keys()].find((k) => k.startsWith("a:"))!;
    const record = JSON.parse((await kv.get(recordKey))!);
    expect(Object.keys(record).sort()).toEqual(
      ["app", "boardFamily", "clientDate", "confirmedAt", "kind", "pack", "points", "portSha", "verdict"]
    );
  });

  test("with no connecting-IP header the post still lands rather than being blocked", async () => {
    const kv = new FakeKV();
    const resp = await onRequestPost(post(MATCHING, kv, null));
    expect(resp.status).toBe(201);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:"))).toHaveLength(0);
  });

  test("with no namespace bound it answers 503, not a crash", async () => {
    const resp = await onRequestPost(post(MATCHING, null));
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain("ATTEST");
  });
});

describe("GET /api/attest", () => {
  test("lists every summary from key metadata alone", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(MATCHING, kv));
    await onRequestPost(post({ ...MATCHING, app: "fluidbox", portSha: "c".repeat(64) }, kv, "198.51.100.4"));
    // The listing must not fall back to reading values: blanking them proves
    // the metadata path is the one being used.
    for (const [name, entry] of kv.store) {
      if (name.startsWith("s:")) entry.value = "";
    }
    const body = (await (await onRequestGet(get(kv))).json()) as { counts: Record<string, { confirmations: number }> };
    expect(Object.keys(body.counts).sort()).toEqual(["chrono:rp2350-touch-amoled-18", "fluidbox:rp2350-touch-amoled-18"]);
    expect(body.counts["chrono:rp2350-touch-amoled-18"]!.confirmations).toBe(1);
  });

  test("a single app and pack comes back in the same envelope", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(MATCHING, kv));
    const resp = await onRequestGet(get(kv, "?app=chrono&pack=rp2350-touch-amoled-18"));
    const body = (await resp.json()) as { counts: Record<string, { confirmations: number }> };
    expect(Object.keys(body.counts)).toEqual(["chrono:rp2350-touch-amoled-18"]);
    expect(body.counts["chrono:rp2350-touch-amoled-18"]!.confirmations).toBe(1);
  });

  test("an app+pack nobody has confirmed reads as zero, not as an error", async () => {
    const kv = new FakeKV();
    const resp = await onRequestGet(get(kv, "?app=gameos&pack=esp32-s3-touch-amoled-18"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { counts: Record<string, unknown> };
    expect(body.counts["gameos:esp32-s3-touch-amoled-18"]).toEqual({
      app: "gameos",
      pack: "esp32-s3-touch-amoled-18",
      confirmations: 0,
      diverged: 0,
      lastConfirmedAt: null,
      kinds: { "pixel-exact": { confirmations: 0, diverged: 0 }, invariants: { confirmations: 0, diverged: 0 } },
    });
  });

  test("the per-kind breakdown survives the metadata-only listing path", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(INVARIANTS_MATCHING, kv));
    for (const [name, entry] of kv.store) {
      if (name.startsWith("s:")) entry.value = "";
    }
    const body = (await (await onRequestGet(get(kv))).json()) as {
      counts: Record<string, { confirmations: number; kinds: Record<string, { confirmations: number }> }>;
    };
    const entry = body.counts["fluidbox:esp32-s3-touch-amoled-18"]!;
    expect(entry.confirmations).toBe(1);
    expect(entry.kinds.invariants!.confirmations).toBe(1);
    expect(entry.kinds["pixel-exact"]!.confirmations).toBe(0);
  });

  test("a summary written before the split reads as a total with no breakdown, not as corruption", async () => {
    const kv = new FakeKV();
    const old = { count: 4, diverged: 1, lastConfirmedAt: "2026-08-14" };
    await kv.put("s:chrono:rp2350-touch-amoled-18", JSON.stringify(old), { metadata: old });
    const body = (await (await onRequestGet(get(kv, "?app=chrono&pack=rp2350-touch-amoled-18"))).json()) as {
      counts: Record<string, { confirmations: number; kinds: Record<string, { confirmations: number }> }>;
    };
    const entry = body.counts["chrono:rp2350-touch-amoled-18"]!;
    expect(entry.confirmations).toBe(4);
    expect(entry.kinds["pixel-exact"]!.confirmations).toBe(0);
    expect(entry.kinds.invariants!.confirmations).toBe(0);
  });

  test("the rate-limit keys are invisible to the read side", async () => {
    const kv = new FakeKV();
    await onRequestPost(post(MATCHING, kv));
    const body = (await (await onRequestGet(get(kv))).json()) as { counts: Record<string, unknown> };
    expect(Object.keys(body.counts)).toHaveLength(1);
  });

  test("with no namespace bound it answers 503, which is what a preview deployment does", async () => {
    const resp = await onRequestGet(get(null));
    expect(resp.status).toBe(503);
    // The client turns any non-ok answer into its empty state, so this is the
    // path a preview and a static clone both take.
    expect(resp.ok).toBe(false);
  });
});
