// verify-gameos-accel.ts: proves the live wiring for the esp32 gameos
// port's raw accelerometer stream (packs/esp32-s3-touch-amoled-18's
// device.json "kind":"stream" "accel" sensor, decision 0003).
//
// THE BUG THIS PROVES FIXED: emu_accel_sample was only ever called from
// trace replay (src/replayCore.ts / replay.ts). No LIVE source fed it -
// neither src/motion.ts's PhoneMotion (real devicemotion) nor its
// DragMotion (desktop drag-as-accelerometer) ever called it, only
// emu_sensor_vector. GUNSHIP's tilt aim on THIS pack is fused from the raw
// stream inside this port's own gos_hal_shim.c's hal_imu_get()
// (app_accel_read(), fed only by emu_accel_sample) - NOT from
// emu_sensor_vector at all, unlike the rp2350 sibling. So before the fix,
// dragging the bezel moved fluidbox's fluid (that reads emu_sensor_vector)
// but left GUNSHIP's reticle dead: s_haveAccel in gos_hal_shim.c never
// becomes true, hal_imu_get() always reports ok=false, aim never moves.
//
// METHOD: same drive, run twice against the SAME wasm module - once with
// src/motion.ts + src/main.ts stashed back to the pre-fix commit (RED),
// once with the fix in place (GREEN) - by restarting the dev server (no
// wasm rebuild needed, this bug is TS-only). Within each run: launch
// GUNSHIP, start the mission, then drag the bezel for a fixed span and
// count how many "accel" events src/recorder.ts's own Recorder captured
// during that drag (window.__debug.getRecorder().events, k === "accel").
//
// THIS is the direct signal, not a pixel diff: the bug is specifically
// "does DragMotion ever call emu_accel_sample at all", and the recorder is
// the exact place every such call already gets logged (main.ts's
// sendAccel: `recorder.record({ t, k: "accel", ... })` right next to the
// `emu_accel_sample` call itself) - checking it answers the question
// directly, with no confounding. A pixel-diff version of this proof was
// tried first (before-vs-held frame diff while dragging) and abandoned:
// GUNSHIP's own orbiting camera and zombies/survivors produce 90-110Kpx of
// change in under a second on their own (measured), regardless of whether
// the reticle itself is moving, so RED and GREEN read as statistically the
// same by that measure even though the underlying fix is real - a noisy
// scene defeats a whole-frame diff as a discriminating signal here. The
// accel-event count has no such noise: RED cannot produce any (the code
// path that would does not exist), GREEN produces one per pointermove.
//
// The panel is still screenshotted before/after and the diff logged for
// human context (does the reticle look like it moved), but the pass/fail
// gate is the event count, the thing actually being proven.
//
// PRECONDITION: wasm/dist/emu.wasm must be this port's module:
//   ZIG_EXE=<path> bun run pack:esp32:build -- --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c
//
// Run with: bun run verify:gameos-accel
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53418;
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no local Chrome found. Set CHROME_PATH, or install Chrome.");
}
const CHROME = process.env.CHROME_PATH || findChrome();

// Thrown, not process.exit()'d: a bare process.exit() inside the try below
// skips its finally entirely, which is what used to leave Chrome (and, for
// the --single path, the still-open browser) running after a failed run.
// See main()'s own catch at the bottom for where the exit code actually
// gets set, after that finally has run.
class VerifyFailure extends Error {}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  throw new VerifyFailure(msg);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

if (!existsSync(WASM_FILE)) {
  fail(`${WASM_FILE} does not exist. Build the gameos esp32 module first - see this file's header comment.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readFrame(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  });
}

function diffPixelCount(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

interface ExperimentResult {
  accelEventCount: number;
  frameDiffPx: number;
}

// One full run: boot the page, launch GUNSHIP, start the mission, drag the
// bezel for a fixed span, return how many "accel" trace events the
// recorder captured during that drag (the pass/fail signal) plus a
// before/held frame diff (context only, not gated on).
async function runExperiment(browser: Browser): Promise<ExperimentResult> {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900, isMobile: false, hasTouch: false });
  page.on("pageerror", (e) => console.error("page error:", e));
  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    return !!c && c.width > 1 && (window as unknown as { __debug?: unknown }).__debug !== undefined;
  }, { timeout: 30000 });
  await sleep(400);

  const device = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getDevice: () => { sensors?: { id: string; kind: string }[] } | null } }).__debug;
    return debug.getDevice();
  });
  const hasStream = (device?.sensors || []).some((s) => s.kind === "stream");
  if (!hasStream) fail(`loaded module must declare a "kind":"stream" sensor, got ${JSON.stringify(device?.sensors || [])}`);

  // Tap the GUNSHIP card - launcher.c's CARD_GUN_Y0..Y1 (36..80) / CARD_X..
  // CARD_X+CARD_W (10..174), as a fraction of the 184x224 gos render
  // layout: fy = ((36+80)/2)/224, matching site/record-demos.ts's own
  // "gameos-esp32" choreography tap for this exact card (both were updated
  // together when this port's launcher.c grew a third GOLF card and moved
  // GUNSHIP/LUCKY 7's own card positions - see that file's header comment).
  const panelRect = await page.$eval("#panel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const tap = async (fx: number, fy: number, holdMs: number) => {
    const x = panelRect.x + fx * panelRect.w;
    const y = panelRect.y + fy * panelRect.h;
    await page.mouse.move(x, y);
    await sleep(90);
    await page.mouse.down();
    await sleep(holdMs);
    await page.mouse.up();
  };
  await tap(0.5, 58 / 224, 120); // GUNSHIP card
  await sleep(500); // briefing screen settles
  // Briefing screen: a touch anywhere in the lower two-thirds starts the
  // mission (descriptor.md's own Interactions section).
  await tap(0.5, 0.75, 300);
  await sleep(600); // mission underway, HUD/actors on screen

  const bezelBox = await page.$eval("#bezel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // BARE bezel plastic, never the panel: motion.ts's DragMotion excludes
  // ".panel, .embed-controls, .dev-btn" from its own pointerdown handler
  // (a drag starting on the panel is game input, not a tilt gesture), and
  // the panel sits CENTERED inside the bezel - starting a drag from the
  // bezel's own geometric center (an earlier version of this script did)
  // lands ON the panel, gets excluded, and the whole gesture is silently
  // swallowed as an ordinary touch instead. Same left-edge point
  // scripts/verify-drag.ts's own proven approach uses. Subsequent
  // pointermove/up are captured regardless of where they travel
  // (setPointerCapture in onPointerDown), so only the START point matters
  // here - the sweep can still cross over the panel visually.
  const cx = bezelBox.x + 8;
  const cy = bezelBox.y + bezelBox.height / 2;
  const target = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el ? el.id || el.className || el.tagName : null;
  }, { x: cx, y: cy });
  if (target !== "bezel") fail(`chosen drag start point (${cx},${cy}) does not resolve to #bezel (got "${target}") - geometry assumption is wrong, DragMotion would exclude this as panel/game input`);
  const tiltRadiusPx = Math.min(bezelBox.width, bezelBox.height) * 0.35;
  const SWEEP_PX = Math.round(tiltRadiusPx * 0.95);

  const before = await readFrame(page);

  // Reset the recorder right before the drag so this run's own count is
  // not polluted by whatever the launcher tap / mission-start touches
  // already recorded (those are "touch"/"tick" events, never "accel", but
  // clearing keeps the count unambiguous regardless).
  await page.evaluate(() => {
    (window as unknown as { __debug: { getRecorder: () => { clear: () => void } } }).__debug.getRecorder().clear();
  });

  // Sweep RIGHTWARD (into the stage), not further left off the bezel/stage
  // edge - the start point is already pinned to the bezel's own left edge.
  await page.mouse.move(cx, cy);
  await sleep(60);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + (SWEEP_PX * i) / 10, cy);
    await sleep(30);
  }
  await sleep(900); // gunship.c's slew-limited reticle (retvx/retvy) converging, not instant
  const held = await readFrame(page);
  await page.mouse.up();
  await sleep(60); // let DragMotion's own release-time sendVector/sendAccel land

  const accelEventCount = await page.evaluate(() => {
    const events = (window as unknown as { __debug: { getRecorder: () => { events: { k: string }[] } } }).__debug.getRecorder().events;
    return events.filter((e) => e.k === "accel").length;
  });

  await page.close();
  return { accelEventCount, frameDiffPx: diffPixelCount(before, held) };
}

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  const server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
    return await fn();
  } finally {
    // server.kill() alone reliably leaked an orphaned, still-LISTENing
    // server on this port between runs (`bun run server.ts` re-execs a
    // nested bun process; killing the wrapper's own PID does not reach
    // it) - the same Windows child-process gotcha browserClose.ts already
    // documents for Chrome, hit here for a plain Bun.spawn too. Killing
    // the whole tree by PID, not just the top process, is what actually
    // frees the port before the next run tries to bind it.
    if (process.platform === "win32" && server.pid) {
      Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
    } else {
      server.kill();
    }
    await sleep(300);
  }
}

async function main(): Promise<void> {
let browser: Browser | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

  const mode = process.argv.includes("--single") ? (process.argv.includes("--red") ? "red" : "green") : "both";

  if (mode !== "both") {
    // Single-mode: caller (this script itself, or a human) has already
    // arranged the src/ tree to be RED or GREEN before invoking this.
    // `return`, not process.exit(0): this is still inside the try below,
    // and exiting here directly used to skip its finally, leaving this
    // very browser (and, on Windows, the dev server's process tree) open.
    const result = await withServer(() => runExperiment(browser!));
    console.log(`${mode.toUpperCase()} run: ${result.accelEventCount} accel event(s) recorded, before-vs-held frame diff = ${result.frameDiffPx}px`);
    return;
  }

  console.log("GREEN run (current tree, fix in place)...");
  const green = await withServer(() => runExperiment(browser!));
  console.log(`GREEN: ${green.accelEventCount} accel event(s) recorded, before-vs-held frame diff = ${green.frameDiffPx}px`);

  console.log("stashing src/motion.ts + src/main.ts back to the pre-fix commit for the RED control run...");
  const stash = Bun.spawnSync(["git", "stash", "push", "--", "src/motion.ts", "src/main.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const stashed = stash.stdout.toString().includes("Saved") || stash.stdout.toString().includes("saved");
  if (!stashed) {
    console.log(`git stash: ${stash.stdout.toString().trim() || stash.stderr.toString().trim()}`);
    fail("could not stash src/motion.ts + src/main.ts - are they already committed with no diff against HEAD? Run with --single --red/--green against a manually checked-out tree instead.");
  }

  let red: ExperimentResult;
  try {
    console.log("RED run (pre-fix src/, same wasm module)...");
    red = await withServer(() => runExperiment(browser!));
    console.log(`RED: ${red.accelEventCount} accel event(s) recorded, before-vs-held frame diff = ${red.frameDiffPx}px`);
  } finally {
    console.log("restoring the fix (git stash pop)...");
    Bun.spawnSync(["git", "stash", "pop"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  }

  console.log(`\nRED (pre-fix)  accel events: ${red.accelEventCount}, frame diff: ${red.frameDiffPx}px`);
  console.log(`GREEN (fixed)  accel events: ${green.accelEventCount}, frame diff: ${green.frameDiffPx}px`);

  if (red.accelEventCount !== 0) {
    fail(`RED recorded ${red.accelEventCount} accel event(s) - expected 0 with the fix reverted (the pre-fix tree should have no code path that calls emu_accel_sample at all from a live drag)`);
  }
  if (green.accelEventCount < 10) {
    fail(`GREEN only recorded ${green.accelEventCount} accel event(s) over a 10-step drag - expected roughly one per pointermove, well over 10`);
  }
  console.log(`PASS: RED recorded 0 accel events during the drag, GREEN recorded ${green.accelEventCount} - the live drag-as-accelerometer path now reaches emu_accel_sample, and did not before. (context: before-vs-held panel diff was ${red.frameDiffPx}px pre-fix vs ${green.frameDiffPx}px fixed - GUNSHIP's own scene animates enough on its own that this number alone is not a reliable signal, see this file's header comment.)`);
} finally {
  if (browser) await closeBrowser(browser);
}
}

main().catch((err) => {
  if (!(err instanceof VerifyFailure)) console.error(err);
  process.exitCode = 1;
});
