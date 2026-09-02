// record-gameos-shell-trace.ts: records a live session against the
// esp32-s3-touch-amoled-18 gameos module's REAL, vendored shell (shell.c/
// apps.c/registry.c - see NOTICE.md) and writes it to apps/gameos/traces/
// gameos-demo-esp32.trace.json, REPLACING the trace this bundle used
// against its former, port-authored launcher.c (a three-card picker that
// never existed on the donor's own device - see this port's README and
// NOTICE.md's own history). The real shell's interaction shape is
// different enough (a five-tile grid instead of three cards, a pause
// overlay with a QUIT button instead of one swipe returning straight to
// the picker, a mandatory first-run calibration tap) that replaying the
// old trace's touch coordinates against this module would not land on the
// right target any more - a fresh recording, not a hand-patch.
//
// Prints the capture-point timestamps at the end, in the shape
// bundle.json's own "captureAt" array wants - copy them in by hand (this
// script does not edit bundle.json itself, so a human/agent reviews the
// numbers before they become a verification contract).
//
// PRECONDITION: wasm/dist/emu.wasm must be this port's module:
//   ZIG_EXE=<path> bun run pack:esp32:build -- --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c --wasm-memory-mb 8
//
// Run with: bun run scripts/record-gameos-shell-trace.ts
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53423;
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");
const OUT_FILE = join(ROOT, "apps", "gameos", "traces", "gameos-demo-esp32.trace.json");

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no local Chrome found. Set CHROME_PATH, or install Chrome.");
}
const CHROME = process.env.CHROME_PATH || findChrome();

// Thrown, not process.exit()'d: a bare process.exit() inside main()'s try
// below skips its finally entirely, which is what used to leave Chrome and
// the dev server running after a failed run. See main()'s own invocation at
// the bottom for where the exit code actually gets set, after that finally
// has run.
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
  fail(`${WASM_FILE} does not exist. Build the gameos esp32 module (with the real shell) first - see this file's header comment.`);
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
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}

async function main(): Promise<void> {
  const server = Bun.spawn(["bun", "run", "server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdout: "pipe", stderr: "pipe" });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900, isMobile: false, hasTouch: false });
    page.on("pageerror", (e) => console.error("page error:", e));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      return !!c && c.width > 1;
    }, { timeout: 15000 });
    await sleep(400);

    const device = await page.evaluate(() => (window as unknown as { __debug: { getDevice: () => unknown } }).__debug.getDevice());
    console.log("device loaded:", JSON.stringify((device as { sensors?: unknown[] })?.sensors ?? []));

    const panelRect = await page.$eval("#panel", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // fx/fy are fractions of the RENDER 184x224 space (GOS_SCREEN_W/H),
    // matching what the panel canvas actually displays 1:1.
    const RW = 184, RH = 224;
    const toClient = (rx: number, ry: number) => [panelRect.x + (rx / RW) * panelRect.w, panelRect.y + (ry / RH) * panelRect.h] as const;

    async function tap(rx: number, ry: number, holdMs = 100): Promise<void> {
      const [x, y] = toClient(rx, ry);
      await page.mouse.move(x, y);
      await sleep(60);
      await page.mouse.down();
      await sleep(holdMs);
      await page.mouse.up();
    }
    async function dragRelease(rx0: number, ry0: number, rx1: number, ry1: number, steps = 6, stepMs = 25): Promise<void> {
      const [x0, y0] = toClient(rx0, ry0);
      await page.mouse.move(x0, y0);
      await sleep(50);
      await page.mouse.down();
      await sleep(70);
      for (let i = 1; i <= steps; i++) {
        const [x, y] = toClient(rx0 + ((rx1 - rx0) * i) / steps, ry0 + ((ry1 - ry0) * i) / steps);
        await page.mouse.move(x, y);
        await sleep(stepMs);
      }
      await sleep(30);
      await page.mouse.up();
    }
    // shell.c's own swipe-to-pause threshold (real, unmodified): press
    // t_press.y<30, release/drag past t_press.y+30 - generously exceeded
    // here (press near the very top edge, drag well past the bottom of
    // the card area), same margin this bundle's prior swipe-exit helper
    // used against the port's own former (smaller) thresholds.
    async function swipeToPause(): Promise<void> {
      await dragRelease(92, 6, 92, 200, 10, 20);
    }
    // QUIT row in the real pause overlay (shell.c's overlay_frame): row
    // index 3 of RESUME/RESTART/CALIBRATE/QUIT, y = 34 + 3*40 = 154, hit
    // zone (0, y-4, GOS_SCREEN_W, 44) = x:0-184, y:150-194 - tap_in() fires
    // on the PRESS edge already, no release needed. shell.c's own pt_in()
    // subtracts a 12px TOUCH_Y_BIAS before testing, and adjacent overlay
    // rows' zones overlap by 4px (40px pitch, 44px zones) - "zones overlap
    // downward; top-down first-match resolves low presses to the button
    // the user was aiming at" (overlay_frame's own comment), which means a
    // tap too close to QUIT's own top edge (render y=165: minus the 12px
    // bias lands at 153, inside CALIBRATE's zone 110-154, checked FIRST in
    // the loop) fires CALIBRATE instead - reproduced empirically (the
    // first recording attempt landed back on the calibration wizard, not
    // the grid). render y=185 (bias-adjusted 173) sits safely inside
    // QUIT's zone only (154..194), well clear of the 150-154 overlap.
    async function tapQuit(): Promise<void> {
      await tap(92, 185, 120);
    }
    async function markTick(label: string): Promise<{ t: number; frame: number[] }> {
      await sleep(60);
      const t = await page.evaluate(() => performance.now());
      const frame = await readFrame(page);
      console.log(`  capture "${label}" @ t=${t.toFixed(0)}ms`);
      return { t, frame };
    }

    const captures: { label: string; t: number }[] = [];
    function capture(label: string, t: number) {
      captures.push({ label, t });
    }

    // ---- first-run calibration wizard: shell_init() lands here every
    // session (this port's nvs.h always fails open - see NOTICE.md's "no
    // NVS persistence" shim), one tap anywhere dismisses it and lands on
    // the grid. Not itself a captured invariant point (not part of this
    // bundle's own checked claims), but mandatory before anything else. ----
    await sleep(200);
    await tap(92, 150, 100);
    await sleep(300);

    // ---- grid boot: three captures, same shape this bundle's prior
    // launcherBoot sequence used ----
    await sleep(16);
    capture("grid16", (await markTick("grid16")).t);
    await sleep(32);
    capture("grid48", (await markTick("grid48")).t);
    await sleep(32);
    capture("grid80", (await markTick("grid80")).t);

    // ---- GUNSHIP: grid slot 0 (col0/row0 - registry.c order gunship,
    // golf, slots, aimtest, diag), render cx=4,cy=10,w=84,h=58 ----
    await tap(46, 39, 120);
    capture("briefing", (await markTick("briefing")).t);
    await tap(92, 170, 250); // briefing: a touch in the lower two-thirds starts the mission
    capture("missionStart", (await markTick("missionStart")).t);
    await sleep(300);
    capture("firing", (await markTick("firing")).t);
    await sleep(600);
    capture("wave", (await markTick("wave")).t);
    await swipeToPause();
    await sleep(150);
    capture("pauseOverlay", (await markTick("pauseOverlay")).t);
    await tapQuit();
    await sleep(200);
    capture("backToGrid", (await markTick("backToGrid")).t);

    // ---- LUCKY 7 (slots.c): grid slot 2, col0/row1, cx=4,cy=74 ----
    await tap(46, 103, 120);
    capture("idle", (await markTick("idle")).t);
    await dragRelease(92, 100, 92, 200, 8, 25); // drag down on the reel unit to pull the lever
    capture("midSpin", (await markTick("midSpin")).t);
    await sleep(900);
    capture("landed", (await markTick("landed")).t);
    await sleep(2200);
    capture("win", (await markTick("win")).t);
    await swipeToPause();
    await sleep(150);
    await tapQuit();
    await sleep(200);
    capture("backToGridFromLucky7", (await markTick("backToGridFromLucky7")).t);

    // ---- GOLF: grid slot 1, col1/row0, cx=96,cy=10 ----
    await tap(138, 39, 120);
    console.log("GOLF launched, tapping the '1 PLAYER' zone repeatedly through GST_LOADING/GST_TITLE (see this bundle's own prior recording script for why this is fixed-attempts, not diff-gated).");
    for (let i = 0; i < 18; i++) {
      await tap(46, 160, 100);
      await sleep(1200);
    }
    await sleep(7000); // GST_INTRO auto-advances on its own after INTRO_HOLD+intro_pan ticks

    function titleCreamFraction(frame: number[]): number {
      const width = 368;
      let cream = 0, total = 0;
      for (let y = 295; y < 345; y++) {
        for (let x = 20; x < 340; x++) {
          const i = (y * width + x) * 4;
          const r = frame[i]!, g = frame[i + 1]!, b = frame[i + 2]!;
          total++;
          if (r > 200 && g > 190 && b > 170) cream++;
        }
      }
      return cream / total;
    }
    const preSwingFrame = await readFrame(page);
    const preSwingCream = titleCreamFraction(preSwingFrame);
    console.log(`  [sanity] cream-pixel fraction in the SOLO/PARTY button band before the swing: ${(preSwingCream * 100).toFixed(1)}%`);
    if (preSwingCream > 0.1) console.warn(`  WARNING: still looks like GOLF's own title screen - the swing sequence below is unlikely to do anything real`);

    await dragRelease(92, 120, 100, 90, 4, 20); // GST_READY -> arm the swing
    await sleep(300);
    const golfReady = await markTick("golfReady");
    capture("golfReady", golfReady.t);
    await sleep(80);

    const streamIndex = ((device as { sensors?: { kind: string }[] })?.sensors ?? []).findIndex((s) => s.kind === "stream");
    if (streamIndex < 0) fail(`device declares no "kind":"stream" sensor - got ${JSON.stringify((device as { sensors?: unknown[] })?.sensors)}`);

    async function accel(ax: number, ay: number, az: number): Promise<void> {
      await page.evaluate(
        (args: { i: number; ax: number; ay: number; az: number }) => {
          const dbg = (window as unknown as { __debug: { getEmu: () => { emu_accel_sample?: (i: number, t: number, ax: number, ay: number, az: number) => void }; getDevice: () => unknown; getRecorder: () => { record: (e: unknown) => void } } }).__debug;
          const emu = dbg.getEmu();
          const t = performance.now();
          emu.emu_accel_sample?.(args.i, t, args.ax, args.ay, args.az);
          dbg.getRecorder().record({ t, k: "accel", i: args.i, ax: args.ax, ay: args.ay, az: args.az });
        },
        { i: streamIndex, ax, ay, az }
      );
    }

    for (let i = 0; i < 14; i++) {
      await accel(0, 0, 1.0);
      await sleep(40);
    }
    await accel(0.35, 0, 1.0);
    await sleep(20);
    for (let i = 0; i < 25; i++) {
      await accel(-0.6, 0, 1.0);
      await sleep(15);
    }
    for (let i = 0; i < 10; i++) {
      await accel(0, 0, 1.0);
      await sleep(15);
    }
    await sleep(300);

    const golfSwingImpact = await markTick("golfSwingImpact");
    capture("golfSwingImpact", golfSwingImpact.t);
    const swingImpactDiff = diffPixelCount(golfReady.frame, golfSwingImpact.frame);
    console.log(`  golfReady -> golfSwingImpact: ${swingImpactDiff}px differ`);
    const postSwingCream = titleCreamFraction(golfSwingImpact.frame);
    console.log(`  [sanity] cream-pixel fraction after the swing: ${(postSwingCream * 100).toFixed(1)}%`);
    if (postSwingCream > 0.1) console.warn(`  WARNING: golfSwingImpact still looks like GOLF's own title screen`);
    if (swingImpactDiff < 500) console.warn(`  WARNING: only ${swingImpactDiff}px differ - the swing may not have armed/fired as intended.`);

    await sleep(400);
    await swipeToPause();
    await sleep(150);
    await tapQuit();
    await sleep(200);
    capture("backToGridFromGolf", (await markTick("backToGridFromGolf")).t);

    // ---- AIM TEST: grid slot 3, col1/row1, cx=96,cy=74 ----
    await tap(138, 103, 120);
    capture("aimTestOpen", (await markTick("aimTestOpen")).t);
    await swipeToPause();
    await sleep(150);
    await tapQuit();
    await sleep(200);
    capture("backToGridFromAimTest", (await markTick("backToGridFromAimTest")).t);

    // ---- DIAG: grid slot 4, col0/row2, cx=4,cy=138 ----
    await tap(46, 167, 120);
    capture("diagOpen", (await markTick("diagOpen")).t);
    await swipeToPause();
    await sleep(150);
    await tapQuit();
    await sleep(200);
    capture("backToGridFromDiag", (await markTick("backToGridFromDiag")).t);

    // ---- export ----
    const trace = await page.evaluate(() => {
      const dbg = (window as unknown as { __debug: { getRecorder: () => { toTrace: (d: unknown) => unknown }; getDevice: () => unknown } }).__debug;
      return dbg.getRecorder().toTrace(dbg.getDevice());
    });
    mkdirSync(join(ROOT, "apps", "gameos", "traces"), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(trace, null, 2));
    console.log(`\nwrote ${OUT_FILE}`);
    console.log("\ncaptureAt (ms, in this order):");
    console.log(JSON.stringify(captures.map((c) => Math.round(c.t))));
    console.log("\nlabels, for the record:");
    for (const c of captures) console.log(`  ${Math.round(c.t)} -> ${c.label}`);
  } finally {
    if (browser) await closeBrowser(browser);
    if (process.platform === "win32" && server.pid) {
      Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
    } else {
      server.kill();
    }
  }
}

main().catch((err) => {
  if (!(err instanceof VerifyFailure)) console.error(err);
  process.exitCode = 1;
});
