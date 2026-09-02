// Device emulator: local dev server. Serves the page, the compiled wasm
// module (built separately, see wasm/emu_abi.h and each firmware's own
// build script), and a handful of small write routes: /api/quit, /api/freeze
// and /api/trace (write debugging artifacts to a predictable path an agent
// can read directly, see docs/agent-loop.md), /api/baseline and
// /api/regression-result (the hardware-free regression check's own
// persistence, see baselineStore.ts and src/regression.ts - a baseline has
// to survive a live reload, which is exactly the moment it gets asked for),
// and /api/livereload (a websocket the page listens on so editing firmware
// and rebuilding shows up on screen without a manual refresh: fast
// iteration is the whole point of this being a local tool).
//
// Launched by hand (`bun run server.ts` / `bun dev`); no console to Ctrl+C
// once backgrounded, so the quit button in the page is not optional.
import { watch, existsSync, mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import index from "./src/index.html";
import { saveBaseline, loadBaseline, saveRegressionResult, type BaselineOnDisk, type RegressionResultOnDisk } from "./baselineStore";

const PORT = Number(process.env.PORT) || 5340;

const ROOT = import.meta.dir;
const WASM_DIST_DIR = join(ROOT, "wasm", "dist");
const FREEZES_DIR = join(ROOT, "freezes");
const TRACES_DIR = join(ROOT, "traces");

function guard(req: Request): boolean {
  // A simple cross-origin POST cannot set a custom header without a
  // preflight we never answer, so this closes the localhost-CSRF hole.
  return req.headers.get("x-puck-emulator") === "1";
}

function quit(req: Request): Response {
  if (!guard(req)) return new Response("nope", { status: 403 });
  setTimeout(() => process.exit(0), 150);
  return Response.json({ ok: true, stopping: true });
}

// Serves the wasm module (and anything else the wasm build writes next to
// it) straight off disk. Not part of the HTML bundler's asset graph,
// because the page fetches it at runtime by a plain string URL, not a
// static import (see wasm.ts: the URL is a parameter on purpose, so a
// firmware author can point this at a different build), so it needs an
// explicit route rather than relying on Bun's HTML-import bundler to
// notice it.
async function serveWasmFile(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = basename(decodeURIComponent(url.pathname.slice("/wasm/".length)));
  const path = join(WASM_DIST_DIR, name);
  const f = Bun.file(path);
  if (!(await f.exists())) {
    return new Response(
      `wasm module not built yet (looked for ${name} in wasm/dist/). ` +
        `That half of this project builds separately per your firmware's own build script; see wasm/emu_abi.h.`,
      { status: 404 }
    );
  }
  const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return new Response(f, { headers: { "content-type": type, "cache-control": "no-store" } });
}

// Freeze bundle: a screenshot exactly as displayed plus a JSON of
// everything around it (device descriptor, current app, recent pushes,
// recent input, recent console lines, and any annotation journal), written
// to a predictable path rather than a browser download, because the
// intended reader is a coding agent working in this repo, not a human
// digging through a Downloads folder. Two writes: a timestamped archive
// (freezes/<id>/) and an always-fresh freezes/latest/ mirror, per
// docs/agent-loop.md.
//
// A second POST with the same id (the annotation modal saving after the
// plain freeze already landed) overwrites that same directory rather than
// creating a new one.
async function saveFreeze(req: Request): Promise<Response> {
  if (!guard(req)) return new Response("nope", { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { panelPngBase64, id: rawId, ...rest } = body;
  if (typeof panelPngBase64 !== "string") return new Response("missing panelPngBase64", { status: 400 });
  const id = typeof rawId === "string" && /^[0-9A-Za-z_-]+$/.test(rawId) ? rawId : new Date().toISOString().replace(/[:.]/g, "-");

  const pngBuf = Buffer.from(panelPngBase64, "base64");
  const bundleText = JSON.stringify({ ...rest, panelPngPath: "panel.png" }, null, 2);

  for (const dir of [join(FREEZES_DIR, id), join(FREEZES_DIR, "latest")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "panel.png"), pngBuf);
    writeFileSync(join(dir, "bundle.json"), bundleText);
  }
  console.log(`freeze -> freezes/${id}/`);
  return Response.json({ id, path: `freezes/${id}/` });
}

// Full input trace: a bug becomes a FILE that replays exactly (see
// src/recorder.ts / src/replay.ts, and the differential harness under
// harness/, which replays the same trace shape against real hardware).
// Timestamped archive plus a latest.json mirror.
async function saveTrace(req: Request): Promise<Response> {
  if (!guard(req)) return new Response("nope", { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  mkdirSync(TRACES_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const text = JSON.stringify(body, null, 2);
  writeFileSync(join(TRACES_DIR, `${stamp}.json`), text);
  writeFileSync(join(TRACES_DIR, "latest.json"), text);
  console.log(`trace -> traces/${stamp}.json`);
  return Response.json({ path: `traces/${stamp}.json` });
}

// ---- the hardware-free regression check's own persistence ---------------
//
// A baseline (src/regression.ts's BaselineBundle: the input trace plus a
// frame at each chosen capture point) has to survive the page reloading,
// because the page reloading is exactly the moment "did I just break
// something" gets asked - see src/regression.ts's header comment. An
// in-memory baseline would be gone by then, and the frames are too large
// (a few hundred KB each) to comfortably keep several of in localStorage.
// Disk, through this same dev server that already persists freezes/ and
// traces/, is the obvious answer: it survives a reload trivially (it isn't
// tied to the browser session at all), and it's the same pattern this file
// already uses twice above.
async function postBaseline(req: Request): Promise<Response> {
  if (!guard(req)) return new Response("nope", { status: 403 });
  let body: BaselineOnDisk;
  try {
    body = (await req.json()) as BaselineOnDisk;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { path } = saveBaseline(body);
  console.log(`baseline -> ${path}`);
  return Response.json({ ok: true, path });
}

function getBaseline(): Response {
  const baseline = loadBaseline();
  if (!baseline) return new Response("no baseline saved yet", { status: 404 });
  return Response.json(baseline);
}

// Written on every check, pass or fail: see docs/agent-loop.md's "A failed
// regression check, for an agent" section for why this mirrors a freeze
// bundle's own shape (the input that provoked it, the frame that used to
// be right, the frame that is wrong now).
async function postRegressionResult(req: Request): Promise<Response> {
  if (!guard(req)) return new Response("nope", { status: 403 });
  let body: RegressionResultOnDisk;
  try {
    body = (await req.json()) as RegressionResultOnDisk;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { path } = saveRegressionResult(body);
  console.log(`regression check (${body.pass ? "pass" : "FAIL"}) -> ${path}`);
  return Response.json({ ok: true, path });
}

// ---- live reload: watch the wasm build output, tell connected pages -----
//
// A dev server that reloads on any filesystem event is a trap the moment
// the file is being written by something else (a build tool) rather than
// atomically renamed into place: an event fires the instant the OS creates
// or truncates the file, long before the build has finished writing bytes
// into it. Broadcasting "reload" at that instant tells the page to fetch a
// half-written module, which fails in a way that looks exactly like a
// frozen page. This is not a one-off; it is a standing property of
// watch-and-reload, so it is fixed here rather than papered over on the
// client.
//
// Two independent guards before a client ever hears about a change:
//   1. the file's size and mtime must be STABLE across two consecutive
//      polls (not just "no fs event for N ms" - a build tool can pause
//      between writes for longer than any fixed debounce);
//   2. it must actually start with the wasm magic bytes once stable.
// Neither is a substitute for the client's own validate-then-swap
// (wasm.ts's instantiate(), main.ts's bringUp()): a file can be
// byte-stable and start with \0asm and still fail to compile or
// instantiate, and that failure belongs to the client, which is the only
// side that can actually attempt it against the real import object.
const wsClients = new Set<import("bun").ServerWebSocket<unknown>>();
const WASM_FILE = join(WASM_DIST_DIR, "emu.wasm");

let watchGen = 0;

function looksLikeWasm(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const magic = Buffer.alloc(4);
    const n = readSync(fd, magic, 0, 4, 0);
    return n === 4 && magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// Polls until two consecutive reads see the same size and mtime, or gives
// up after ~24s (a build that slow will fire another fs event on its own
// completion, which starts a fresh wait); null either way means "do not
// broadcast yet".
async function waitForStableFile(path: string, myGen: number): Promise<{ size: number; mtimeMs: number } | null> {
  const POLL_MS = 120;
  let lastSize = -1;
  let lastMtime = -1;
  let stableCount = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (myGen !== watchGen) return null; // a newer change superseded this wait
    let st;
    try {
      st = statSync(path);
    } catch {
      stableCount = 0;
      lastSize = -1;
      continue; // mid-write / mid-rename: briefly missing is normal
    }
    if (st.size === lastSize && st.mtimeMs === lastMtime) {
      if (++stableCount >= 2) return { size: st.size, mtimeMs: st.mtimeMs };
    } else {
      stableCount = 0;
      lastSize = st.size;
      lastMtime = st.mtimeMs;
    }
  }
  return null;
}

function onWasmDirChange(): void {
  const myGen = ++watchGen;
  void (async () => {
    const stat = await waitForStableFile(WASM_FILE, myGen);
    if (!stat || myGen !== watchGen) return; // gave up, or a newer change is already being waited on
    if (!looksLikeWasm(WASM_FILE)) {
      console.warn(`${WASM_FILE} settled at ${stat.size} bytes but does not start with the wasm magic bytes; not telling clients to reload`);
      return;
    }
    if (wsClients.size === 0) return;
    console.log(`wasm stable at ${stat.size} bytes, telling ${wsClients.size} connected page(s) to reload`);
    for (const ws of wsClients) ws.send("reload");
  })();
}

function startWasmWatcher(): void {
  try {
    watch(WASM_DIST_DIR, () => onWasmDirChange());
    console.log(`watching ${WASM_DIST_DIR} for changes`);
  } catch {
    // Doesn't exist yet (the wasm build hasn't run once). Poll for it
    // rather than giving up: this dev server is very likely started
    // before the first build finishes.
    const timer = setInterval(() => {
      if (existsSync(WASM_DIST_DIR)) {
        clearInterval(timer);
        startWasmWatcher();
      }
    }, 2000);
  }
}
startWasmWatcher();

const server = Bun.serve({
  port: PORT,
  // Local-only tool: without an explicit hostname Bun listens on every
  // interface (:::5340), reachable by anyone on the same network.
  hostname: "127.0.0.1",
  development: { hmr: true, console: true },
  websocket: {
    open(ws) {
      wsClients.add(ws);
    },
    close(ws) {
      wsClients.delete(ws);
    },
    message() {
      // The page never sends anything on this socket; it only listens.
    },
  },
  routes: {
    "/api/quit": { POST: quit },
    "/api/freeze": { POST: saveFreeze },
    "/api/trace": { POST: saveTrace },
    "/api/baseline": { GET: getBaseline, POST: postBaseline },
    "/api/regression-result": { POST: postRegressionResult },
    "/api/livereload": {
      GET(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      },
    },
    "/wasm/*": serveWasmFile,
    "/*": index,
  },
});

console.log(`device emulator -> http://127.0.0.1:${server.port}`);
