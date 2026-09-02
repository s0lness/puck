// record-gameos-golf-trace.ts: records a live session against the
// esp32-s3-touch-amoled-18 gameos module (launcher + GUNSHIP + LUCKY 7 +
// GOLF) and writes it to apps/gameos/traces/gameos-demo-esp32.trace.json -
// a SEPARATE trace file from the shared apps/gameos/traces/
// gameos-demo.trace.json (still used, untouched, by the rp2350 port's own
// bundle.json entry). A separate file is deliberate, not an oversight: this
// port's launcher.c now lays out THREE cards instead of two (see that
// file's own header comment), which moved the GUNSHIP/LUCKY 7 card
// coordinates - replaying the OLD shared trace's touch events against the
// NEW layout would not reliably land on the right card any more, so this
// records a fresh session against the new layout rather than hand-patching
// stale coordinates.
//
// Prints the capture-point timestamps it used at the end, in the shape
// bundle.json's own "captureAt" array wants - copy them in by hand (this
// script does not edit bundle.json itself, so a human/agent reviews the
// numbers before they become a verification contract).
//
// PRECONDITION: wasm/dist/emu.wasm must be this port's module, WITH golf:
//   ZIG_EXE=<path> bun run pack:esp32:build -- --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c
//
// Run with: bun run scripts/record-gameos-golf-trace.ts
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53419;
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
  fail(`${WASM_FILE} does not exist. Build the gameos esp32 module (with golf) first - see this file's header comment.`);
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
      // A real settle AT the press position before any movement starts -
      // matters for swipe_exit()'s y<14 arm check (gameos_port.c): without
      // it, Chrome can coalesce the down() and the first move() into one
      // input-round-trip, so the FIRST touch position the game's own
      // gos_input_update() ever samples is already partway through the
      // drag, past y<14, and the swipe never arms at all - reproduced
      // empirically (the very first recorded touch-down sample landed at
      // render y~25, not this call's own y0~6).
      await sleep(70);
      for (let i = 1; i <= steps; i++) {
        const [x, y] = toClient(rx0 + ((rx1 - rx0) * i) / steps, ry0 + ((ry1 - ry0) * i) / steps);
        await page.mouse.move(x, y);
        await sleep(stepMs);
      }
      await sleep(30);
      await page.mouse.up();
    }
    async function swipeExit(): Promise<void> {
      // docs/input-and-ux.md: press y<14 (render space), drag down past 40.
      // swipe_exit() (gameos_port.c) fires exitNow the INSTANT the drag
      // crosses the +40 threshold, mid-touch, not on release - the very
      // next tick already has s_screen==SCREEN_LAUNCHER while the mouse is
      // still physically down. launcher_update()'s own tap-vs-drag test
      // (iabs(dx)<12 && iabs(dy)<12) is what has to save this: if that next
      // tick's launcher_update() happens to observe this same ongoing
      // touch (capturing whatever position it is at as ITS OWN drag start,
      // s_launcher.was having just been reset false by enter_launcher()'s
      // launcher_reset()), the drag must keep moving comfortably PAST 12
      // more render px before releasing, or the tail end of an exit swipe
      // reads as a tap on whichever of the three (now full-width) cards
      // happens to sit under wherever the swipe was still travelling -
      // reproduced empirically: a swipe ending at render y=60 (just past
      // the threshold) landed inside CARD_GUN_Y0..Y1 (36..80) and silently
      // re-launched GUNSHIP instead of returning to the launcher. Ending
      // well past render y=192 (below every card, into the hint-text
      // strip) leaves >100px of margin past the threshold regardless of
      // where a same-tick capture might land.
      await dragRelease(92, 6, 92, 200, 10, 20);
    }
    async function markTick(label: string): Promise<{ t: number; frame: number[] }> {
      await sleep(60); // let one more real tick land so the label's own gesture is reflected
      const t = await page.evaluate(() => performance.now());
      const frame = await readFrame(page);
      console.log(`  capture "${label}" @ t=${t.toFixed(0)}ms`);
      return { t, frame };
    }

    const captures: { label: string; t: number }[] = [];
    function capture(label: string, t: number) {
      captures.push({ label, t });
    }

    // ---- launcher boot: three captures, same shape gameos-demo.trace.json's
    // own launcherBoot/briefing/... sequence uses ----
    await sleep(16);
    capture("launcher16", (await markTick("launcher16")).t);
    await sleep(32);
    capture("launcher48", (await markTick("launcher48")).t);
    await sleep(32);
    capture("launcher80", (await markTick("launcher80")).t);

    // ---- GUNSHIP: tap card (launcher.c CARD_GUN_Y0..Y1=36..80, CARD_X..+W=10..174) ----
    await tap(92, 58, 120);
    capture("briefing", (await markTick("briefing")).t);
    // briefing: a touch in the lower two-thirds starts the mission
    await tap(92, 170, 250);
    capture("missionStart", (await markTick("missionStart")).t);
    await sleep(300);
    capture("firing", (await markTick("firing")).t);
    await sleep(600);
    capture("wave", (await markTick("wave")).t);
    await swipeExit();
    await sleep(200);
    capture("backToLauncher", (await markTick("backToLauncher")).t);

    // ---- LUCKY 7: tap card (CARD_SLOTS_Y0..Y1=92..136) ----
    await tap(92, 114, 120);
    capture("idle", (await markTick("idle")).t);
    // drag down on the reel unit to pull the lever
    await dragRelease(92, 100, 92, 200, 8, 25);
    capture("midSpin", (await markTick("midSpin")).t);
    await sleep(900);
    capture("landed", (await markTick("landed")).t);
    await sleep(2200);
    capture("win", (await markTick("win")).t);
    await swipeExit();
    await sleep(200);
    capture("backToLauncher2", (await markTick("backToLauncher2")).t);

    // ---- GOLF: tap card (CARD_GOLF_Y0..Y1=148..192) ----
    await tap(92, 170, 120);
    console.log("GOLF launched, waiting for the course background pipeline (BG_ROUGH..BG_DONE) - golf_render()'s own GST_LOADING case never redraws (\"canvas holds\"), so a frame-diff can't tell 'still loading' from 'landed on a screen with no visible change yet' apart. Repeatedly tapping the '1 PLAYER' zone instead: a no-op while still loading (golf_update()'s own switch has no GST_LOADING case), selects 1 PLAYER once GST_TITLE is reached (starts the intro pan), and remains harmless if it lands again during GST_INTRO (golf.c: 'if (tap) intro_t = ...' - ANY tap there just forces the pan to finish, position irrelevant).");
    // "1 PLAYER" zone: full-res tx<184,ty>=280 -> render tx<92, ty>=140.
    // Fixed attempts/spacing, NOT diff-gated: a frame-diff-based retry loop
    // was tried first and produced false positives here - GST_LOADING
    // finishing on its own (autonomous, no tap needed) and GST_TITLE's own
    // idle attract animation (raindrops, a phase-driven shimmer) each
    // produce large enough diffs on their own to look like "the tap
    // landed" when it did not, discovered by inspecting the actual
    // captured PNGs (still the title screen) after the diff-gated version
    // reported success.
    for (let i = 0; i < 18; i++) {
      await tap(46, 160, 100);
      await sleep(1200);
    }
    // GST_INTRO auto-advances on its own after INTRO_HOLD+intro_pan ticks
    // (golf_int.h: 8 + up to 95 ticks, TICK_S=0.06s -> <=6.2s) even with no
    // further tap at all - the repeated taps above already likely forced it
    // early, but this covers the case where the very LAST of those taps is
    // what selected 1 PLAYER, leaving no further tap to force the skip.
    await sleep(7000);

    // Sanity check, not a gate: GST_TITLE's own SOLO/PARTY pill buttons are
    // COL_CREAM (golf_cards.c, 0xF3ECD8) against a course-view background
    // (all green/sand/water hues) - a real course view (GST_READY/ARMED/
    // MOVING) has no large cream-coloured region in this band. Logged, not
    // retried further: the golfSwingImpact diff check right after this
    // still has to catch a genuinely stuck sequence either way.
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
    if (preSwingCream > 0.1) console.warn(`  WARNING: still looks like GOLF's own title screen (SOLO/PARTY buttons still visible) - the swing sequence below is unlikely to do anything real`);

    // GST_READY -> drag + release with imu_ok+swing_mode both true (the
    // port's own default) arms the swing (arm_swing(), golf.c) rather than
    // firing directly - a drag over 20 full-res px (10 render px) in any
    // direction sets G->aim_dx/dy and switches to GST_ARMED, swing_listen=true.
    await dragRelease(92, 120, 100, 90, 4, 20);
    await sleep(300);
    const golfReady = await markTick("golfReady");
    capture("golfReady", golfReady.t);
    await sleep(80); // let arm_swing()'s accel-ring drain land before the real swing starts

    // ---- the swing itself: synthetic raw-accel samples, injected directly
    // against emu_accel_sample (the ABI replayCore.ts's "accel" trace event
    // replays) and recorded into the SAME session trace via the exposed
    // recorder - this is deliberately NOT routed through src/motion.ts's
    // PhoneMotion/DragMotion (that live-wiring path is proven separately by
    // scripts/verify-gameos-accel.ts); here the goal is a precise, reproduced
    // gesture against golf.c's own documented swing_step() thresholds
    // (golf_int.h: SWING_BACK_TH=0.22, SWING_FWD_TH=0.25, SWING_V_MIN=0.04,
    // SWING_V_MAX=0.28, SWING_END_TH=0.12, SWING_END_QUIET_US=60000).
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

    // settle: baseline gravity (0,0,1)g for well over SWING_SETTLE_US
    // (150ms) - the first swing attempt used 6 samples at 30ms spacing
    // (~150ms total, the theoretical minimum) and measured 0px difference
    // between golfReady and golfSwingImpact: real page.evaluate() round-
    // trip overhead ate the margin, SWING_SETTLE never crossed into
    // SWING_WAIT, and the whole backswing+stroke below was absorbed as
    // more "settle" data instead of a swing. 14 samples at 40ms (~560ms
    // total) leaves real headroom.
    for (let i = 0; i < 14; i++) {
      await accel(0, 0, 1.0);
      await sleep(40);
    }
    // backswing: a sharp departure exceeding SWING_BACK_TH (0.22)
    await accel(0.35, 0, 1.0);
    await sleep(20);
    // forward stroke: sustained, exceeding SWING_FWD_TH (0.25) on entry,
    // well past SWING_V_MIN (0.04)
    for (let i = 0; i < 25; i++) {
      await accel(-0.6, 0, 1.0);
      await sleep(15);
    }
    // quiet tail: back near baseline for > SWING_END_QUIET_US (60ms) ends
    // the stroke - or, failing that, SWING_MAX_STROKE_US (500ms measured
    // from the backswing trigger) ends it anyway, an equally valid swing.
    for (let i = 0; i < 10; i++) {
      await accel(0, 0, 1.0);
      await sleep(15);
    }
    await sleep(300); // let ARMED -> fire_shot -> GST_MOVING land and render at least once

    const golfSwingImpact = await markTick("golfSwingImpact");
    capture("golfSwingImpact", golfSwingImpact.t);
    const swingImpactDiff = diffPixelCount(golfReady.frame, golfSwingImpact.frame);
    console.log(`  golfReady -> golfSwingImpact: ${swingImpactDiff}px differ`);
    const postSwingCream = titleCreamFraction(golfSwingImpact.frame);
    console.log(`  [sanity] cream-pixel fraction in the SOLO/PARTY button band after the swing: ${(postSwingCream * 100).toFixed(1)}%`);
    if (postSwingCream > 0.1) console.warn(`  WARNING: golfSwingImpact still looks like GOLF's own title screen - the arm/swing sequence did not reach GST_READY`);
    if (swingImpactDiff < 500) {
      console.warn(`  WARNING: only ${swingImpactDiff}px differ - the swing may not have armed/fired as intended. Check manually before trusting the new invariant threshold.`);
    }

    await sleep(400); // let the ball travel a bit further before exiting, more visible motion
    await swipeExit();
    await sleep(200);
    capture("backToLauncherFromGolf", (await markTick("backToLauncherFromGolf")).t);

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
    // server.kill() alone reliably leaked an orphaned, still-LISTENing
    // server process on this port (`bun run server.ts` re-execs a nested
    // bun process; killing the wrapper's own PID does not reach it) - the
    // same Windows child-process gotcha browserClose.ts already documents
    // for Chrome. Kill the whole tree by PID so the port is actually free
    // for the next run.
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
