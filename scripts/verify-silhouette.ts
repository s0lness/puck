#!/usr/bin/env bun
// scripts/verify-silhouette.ts: headless proof that an app really runs on a
// device that has no firmware.
//
// This is the check the whole silhouette idea stands or falls on. A cell in
// an apps-by-devices matrix is worthless if it is a picture: the claim is
// that fluidbox's own C, compiled against packs/silhouettes/m5stickc-plus2/
// device.json and nothing else, runs at that board's 135x240 with that
// board's buttons, and answers gravity. So this builds it, opens it in a
// real browser, tilts it with synthetic devicemotion, and asserts that the
// fluid moved the way the tilt pointed.
//
//   bun run verify-silhouette [--silhouette <name>] [--app <path.c>]
//                             [--no-build] [--proof <path.png>] [--stroke]
//
// Defaults to fluidbox on m5stickc-plus2, which is the pair the roadmap's
// first cell names, and writes packs/silhouettes/m5stickc-plus2/proof/
// fluidbox-tilt.png: the panel itself, at 1:1, not a screenshot of a page.
//
// --STROKE IS THE SAME IDEA FOR A DIGITIZER INSTEAD OF AN IMU. tinydraw has
// nothing to tilt and nothing to shake; what it has is a finger on the
// glass, so this mode's own third assertion drags a synthetic pointer
// stroke across the panel and checks that ink actually appeared, rather
// than tilting the page and watching a fluid answer. With --stroke and no
// --app/--silhouette override, this defaults to tinydraw on m5stack-cores3,
// the first silhouette in this set with a real touch digitizer
// (docs/convention/device-pack.md's "Silhouette packs"), and writes
// packs/silhouettes/m5stack-cores3/proof/tinydraw-stroke.png.
//
// THE FILENAME ENDS IN -tilt OR -stroke FOR A REASON. tools/ledger.ts writes
// proof/<app>.png for every app against every silhouette, through
// scripts/silhouetteProof.ts, and that picture is a settled first frame:
// the wide, mechanical answer to whether this app runs at this size. This
// script is the narrow, deliberate answer to whether one particular app
// answers its own particular input the way it claims to (gravity for
// fluidbox, a finger for tinydraw), captured a beat after the input stops.
// Two different pictures of two different claims, and one filename for
// both would mean whichever ran last silently replaced the other.
//
// THREE ASSERTIONS IN EACH MODE, and each is about something a screenshot
// could fake:
//   1. the module's own emu_device() says the silhouette's own panel size,
//      so the app was compiled against the silhouette, not the web pack's
//      own panel
//   2. the canvas the browser actually paints is that panel's size in
//      device pixels, so the page is presenting that panel and not a
//      scaled stand-in
//   3. TILT MODE: the fluid's centre of mass moves toward the tilt, by
//      more than its own idle drift over the same window, so the app is
//      running and reading the sensor rather than holding a first frame.
//      STROKE MODE: a synthetic pointer drag crosses the panel, and
//      afterwards the panel differs visibly from what it was before the
//      drag - by pixel count, not by a fixed starting colour, since this
//      mode is not tinydraw-only (tools/ledger.ts also runs it for gameos,
//      whose own first frame is a coloured menu, not a blank canvas). An
//      app that ignores touch entirely produces no diff and this line says
//      so; an app that draws, highlights or navigates on a drag all count.
//
// Exit 0: all three passed. Exit 1: at least one did not, and it is named.
// Needs zig (unless --no-build) and a local Chrome, like every other
// headless check here; set ZIG_EXE and CHROME_PATH if they are not found.
// --json prints one machine-readable object as the last line of stdout
// (tools/ledger.ts's own tailJson convention, matching verify-bundle.ts and
// hostdiff.ts): {ok, mode, app, silhouette, panel, proof, checks}, where
// each check is {name, ok, detail}. The human pass()/fail() lines above it
// are unchanged; --json adds to the output, it does not replace it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";

const ROOT = resolve(import.meta.dir, "..");
const PORT = 53417;

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

// --stroke switches every default at once (silhouette, app, proof
// filename): a bare `bun run verify-silhouette --stroke` is meant to prove
// the pair this workstream added, the same way a bare `bun run
// verify-silhouette` proves fluidbox on m5stickc-plus2.
const STROKE = process.argv.includes("--stroke");
const JSON_OUT = process.argv.includes("--json");
const SILHOUETTE = argValue("--silhouette", STROKE ? "m5stack-cores3" : "m5stickc-plus2");
const APP_SOURCE = argValue("--app", STROKE ? "apps/tinydraw/ports/web/tinydraw.c" : "apps/fluidbox/ports/web/fluid.c");
const APP_NAME = APP_SOURCE.split("/").pop()!.replace(/\.c$/, "");
const BUILD = !process.argv.includes("--no-build");
// The default filename is named for the APP ("fluidbox", "tinydraw"), not
// derived from APP_SOURCE's own stem ("fluid.c" for fluidbox's port file):
// this is the one place that distinction matters, since AGENTS.md and this
// file's own header comment both promise "fluidbox-tilt.png" by name.
const DEFAULT_PROOF_NAME = STROKE ? "tinydraw-stroke.png" : "fluidbox-tilt.png";
const PROOF = resolve(ROOT, argValue("--proof", join("packs", "silhouettes", SILHOUETTE, "proof", DEFAULT_PROOF_NAME)));
const DIST = join(ROOT, "packs", "web", "dist", "silhouettes", SILHOUETTE, APP_NAME);

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

// Stroke mode's own floor, a fraction of the panel's own pixel count: how
// much of the panel has to visibly CHANGE between the before-drag and
// after-drag snapshot to count as "the app answered the touch" rather than
// PNG round-tripping noise. Deliberately not "the panel must start blank":
// tools/ledger.ts runs this same mode for gameos too, and gameos's own
// first frame is a coloured menu, not an empty canvas the way tinydraw's
// is - a floor on CHANGE reads right either way, where a floor on the
// starting colour would only ever be right for one of the two apps.
const DIFF_FLOOR = 0.005;
// A per-channel tolerance for "the same pixel": antialiasing a fluid or a
// static menu redraws pixels that are visually identical but not
// bit-identical frame to frame, and a tolerance this small only forgives
// that, never a real stroke.
const DIFF_CHANNEL_TOLERANCE = 24;

let failures = 0;
// Every pass()/fail() also names itself (docs/decisions convention here:
// tools/ledger.ts reads --json's checks by name, not by parsing English),
// so a caller that only wants "did the panel match" does not have to
// re-derive it from a sentence meant for a person.
const checks: { name: string; ok: boolean; detail: string }[] = [];
function fail(name: string, message: string): void {
  failures++;
  checks.push({ name, ok: false, detail: message });
  console.error(`FAIL: ${message}`);
}
function pass(name: string, message: string): void {
  checks.push({ name, ok: true, detail: message });
  console.log(`  ok: ${message}`);
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The panel's declared size, read from the silhouette's own device.json, so
// this script asserts against the file rather than against two numbers
// typed into it. Nothing here names a device.
const device = (await Bun.file(join(ROOT, "packs", "silhouettes", SILHOUETTE, "device.json")).json()) as {
  name?: string;
  panel: { w: number; h: number };
};
const PANEL_W = device.panel.w;
const PANEL_H = device.panel.h;

// ---- build ---------------------------------------------------------------

if (BUILD) {
  console.log(`building ${APP_NAME} against ${SILHOUETTE} (${PANEL_W}x${PANEL_H})`);
  // --shake only matters to an app that reads the shake sensor (tilt mode's
  // fluidbox does; tinydraw's own descriptor states shake does nothing), so
  // stroke mode drops it rather than declaring a want the app never reads.
  const buildArgs = ["run", "packs/web/wasm/build.ts", "--host", "--silhouette", SILHOUETTE, "--app", APP_SOURCE, ...(STROKE ? [] : ["--shake"])];
  const build = Bun.spawnSync(["bun", ...buildArgs], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
  if (build.exitCode !== 0) {
    console.error(`FAIL: the silhouette build exited ${build.exitCode}`);
    process.exit(1);
  }
}
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`FAIL: ${DIST} has no index.html. Drop --no-build, or build it first.`);
  process.exit(1);
}

// ---- the page ------------------------------------------------------------

// The panel's horizontal centre of mass, as a fraction of its width. A
// frame diff proves nothing on a fluid (a settled pool still redraws almost
// every particle every frame, sub-pixel jitter crossing a rounding
// boundary); WHERE the fluid is barely moves once settled, and gravity
// pointing right is precisely a request to move it right. Same measurement
// scripts/verify-web-apps.ts uses on the same app, for the same reason.
async function centroidX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 16 && data[i + 1]! < 16 && data[i + 2]! < 16) continue;
      sum += (i / 4) % canvas.width;
      n++;
    }
    return n === 0 ? -1 : sum / n / canvas.width;
  });
}

// WHICH SIGN CONVENTION THIS PAGE IS ABOUT TO USE, asked of the page
// rather than assumed, because the two real ones disagree on x and this
// script has to speak whichever one the host picked.
//
// host.ts's mapAccelerationToVector has two branches and chooses between
// them with isIOSMotion(), a feature probe for requestPermission() on the
// motion constructors. That probe was written when iOS Safari was the only
// browser exposing it. It is not any more: this Chrome answers "function"
// for both constructors, so a desktop Chrome now takes the iOS branch,
// where x is gravity-direct instead of negated. Worth knowing about the
// host (its platform detection is a heuristic that has aged), and NOT this
// script's business to correct: a rig that hard-coded one convention would
// either test the wrong branch or report a sign bug that only exists in
// the rig. So the branch is read here, and the sample is built to mean
// "gravity toward the panel's right" under whichever one is live.
async function gravityRightSampleX(page: Page): Promise<number> {
  const isIOS = await page.evaluate(() => {
    const motion = window.DeviceMotionEvent as unknown as { requestPermission?: unknown };
    const orientation = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown };
    return typeof motion?.requestPermission === "function" || typeof orientation?.requestPermission === "function";
  });
  console.log(`  (the host's motion branch here is ${isIOS ? "iOS (x gravity-direct)" : "spec (x negated)"})`);
  return isIOS ? 9.80665 : -9.80665;
}

// accelerationIncludingGravity, in the raw shape a phone reports.
async function dispatchMotion(page: Page, x: number, y: number, z: number): Promise<void> {
  await page.evaluate(
    ({ ax, ay, az }) => {
      const event = new Event("devicemotion");
      Object.defineProperty(event, "accelerationIncludingGravity", { configurable: true, value: { x: ax, y: ay, z: az } });
      window.dispatchEvent(event);
    },
    { ax: x, ay: y, az: z }
  );
}

// The host's low pass is a 200ms time constant over the event stream, so a
// tilt is a stream of samples, not one event. 40 of them over ~1.3s is well
// past the filter's settling time and is what a hand turning a phone
// actually delivers.
async function tiltRight(page: Page, samples: number, rawX: number): Promise<void> {
  for (let i = 0; i < samples; i++) {
    await dispatchMotion(page, rawX, 0, 0);
    await wait(32);
  }
}

// ---- stroke mode's own helpers --------------------------------------------

// Keeps the pre-drag frame INSIDE the page (a page-global ImageData),
// rather than serialising every pixel back to this process twice: the
// panel is small, but the round trip is not free and this runs once per
// app per silhouette under tools/ledger.ts, not once ever.
async function snapshotBefore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    (window as unknown as { __vsBefore?: ImageData }).__vsBefore = ctx && canvas ? ctx.getImageData(0, 0, canvas.width, canvas.height) : undefined;
  });
}

// Fraction of pixels whose R, G or B changed by more than `tolerance`
// since snapshotBefore(). Deliberately a CHANGE measurement, not an "is it
// ink" one: tinydraw's panel goes from blank to a line, gameos's goes from
// one menu frame to a slightly different one (or a whole new screen), and
// both are "the app answered the touch" even though only one of them ever
// passes through a state that could be called blank.
async function diffFractionSinceSnapshot(page: Page, tolerance: number): Promise<number> {
  return page.evaluate((tol) => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    const before = (window as unknown as { __vsBefore?: ImageData }).__vsBefore;
    if (!canvas || !ctx || !before) return -1;
    const after = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (after.data.length !== before.data.length) return -1;
    let changed = 0;
    let n = 0;
    for (let i = 0; i < after.data.length; i += 4) {
      n++;
      const dr = Math.abs(after.data[i]! - before.data[i]!);
      const dg = Math.abs(after.data[i + 1]! - before.data[i + 1]!);
      const db = Math.abs(after.data[i + 2]! - before.data[i + 2]!);
      if (dr > tol || dg > tol || db > tol) changed++;
    }
    return n === 0 ? -1 : changed / n;
  }, tolerance);
}

// A diagonal drag across most of the panel, dispatched as real pointer
// events through CDP (Puppeteer's page.mouse), which Chrome turns into the
// same pointerdown/pointermove/pointerup sequence a finger would - the
// exact events packs/web/host/host.ts's own "touch" section listens for
// (host.ts, panel.canvas.addEventListener("pointerdown"/"pointermove"/
// "pointerup", ...)). Real wall-clock waits between moves, not zero-delay
// jumps: tinydraw's own port_tick derives stroke width from screen speed
// between samples (apps/tinydraw/ports/web/tinydraw.c's radius_from_
// pressure), and each move here lands inside its own requestAnimationFrame
// tick the same way a real drag would.
async function drawSyntheticStroke(page: Page, canvasRect: { x: number; y: number; width: number; height: number }): Promise<void> {
  const steps = 24;
  const x0 = canvasRect.x + canvasRect.width * 0.15;
  const y0 = canvasRect.y + canvasRect.height * 0.2;
  const x1 = canvasRect.x + canvasRect.width * 0.85;
  const y1 = canvasRect.y + canvasRect.height * 0.8;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    await wait(24);
  }
  await page.mouse.up();
}

let proofWritten = false;
const server = serveDist(DIST, PORT);
let browser: Browser | null = null;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e: unknown) => fail("page-error", `page error: ${e instanceof Error ? e.message : String(e)}`));

  // Headless desktop Chrome does not always expose the mobile-only motion
  // constructors, and host.ts feature-detects them before it will even draw
  // its tilt control. Only the detection surface is installed; the samples
  // below are still dispatched as real window events.
  await page.evaluateOnNewDocument(() => {
    if (window.DeviceMotionEvent === undefined) {
      Object.defineProperty(window, "DeviceMotionEvent", { configurable: true, value: class DeviceMotionEvent extends Event {} });
    }
  });

  // Sized so the panel lands at exactly one device pixel per panel pixel:
  // the width is the panel plus the 8px the host reserves, the height
  // leaves room for the controls row, and dpr is 1. That is what makes
  // assertion 2 a literal 135x240 rather than "some multiple of it".
  await page.setViewport({ width: PANEL_W + 8, height: PANEL_H + 160, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await wait(1200);

  // ---- 1: the module says which device it was compiled against ----------
  const declared = await page.evaluate(() => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    const buttons = Array.from(document.querySelectorAll("button[data-button-id]")).map((b) => (b as HTMLElement).dataset.buttonId);
    return { canvasW: canvas?.width ?? 0, canvasH: canvas?.height ?? 0, buttons };
  });

  // The descriptor the MODULE returned, not the file this script read: read
  // back through the page so a build against the wrong device.json cannot
  // pass by agreeing with the file on disk.
  const modulePanel = await page.evaluate(async () => {
    const url = document.body.dataset.module;
    if (!url) return null;
    const bytes = await (await fetch(url)).arrayBuffer();
    const nine = { sinf: Math.sin, cosf: Math.cos, atan2f: Math.atan2, sqrtf: Math.sqrt, fabsf: Math.abs, floorf: Math.floor, fmodf: (a: number, b: number) => a % b, powf: Math.pow, expf: Math.exp, js_log: () => {} };
    const { instance } = await WebAssembly.instantiate(bytes, { env: nine });
    const exports = instance.exports as unknown as { memory: WebAssembly.Memory; emu_init(): number; emu_device(): number };
    exports.emu_init();
    const memory = new Uint8Array(exports.memory.buffer);
    let end = exports.emu_device();
    const start = end;
    while (memory[end] !== 0) end++;
    const json = JSON.parse(new TextDecoder().decode(memory.subarray(start, end))) as { name?: string; panel: { w: number; h: number }; buttons?: { id: string }[] };
    return { name: json.name, w: json.panel.w, h: json.panel.h, buttons: (json.buttons ?? []).map((b) => b.id) };
  });

  if (modulePanel && modulePanel.w === PANEL_W && modulePanel.h === PANEL_H) {
    pass("module-panel", `the module's own emu_device() declares ${modulePanel.name}: ${modulePanel.w}x${modulePanel.h}, buttons ${modulePanel.buttons.join(", ")}`);
  } else {
    fail("module-panel", `the module declares ${JSON.stringify(modulePanel)}, and the silhouette's device.json says ${PANEL_W}x${PANEL_H}`);
  }

  // ---- 2: the browser paints that panel, 1:1 ---------------------------
  if (declared.canvasW === PANEL_W && declared.canvasH === PANEL_H) {
    pass("canvas-panel", `the painted canvas is ${declared.canvasW}x${declared.canvasH} device pixels, one per panel pixel`);
  } else {
    fail("canvas-panel", `the painted canvas is ${declared.canvasW}x${declared.canvasH}, expected ${PANEL_W}x${PANEL_H} at this viewport`);
  }
  console.log(`  (ghost buttons on the page: ${declared.buttons.join(", ") || "none"})`);

  if (STROKE) {
    // ---- 3 (stroke mode): a finger changes something ---------------------
    // A beat to let whatever the first frame is finish settling (a menu's
    // own fade-in, say) before the "before" snapshot, so the diff below is
    // never just that settling caught mid-way.
    await wait(500);
    const rect = await page.evaluate(() => {
      const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (!rect) {
      fail("stroke-diff", "the page drew no canvas#panel to draw a stroke onto");
    } else {
      await snapshotBefore(page);
      await drawSyntheticStroke(page, rect);
      // A beat for the last pointerup's tick to land and the RAF loop to
      // paint it, the same settle-then-measure shape tilt mode uses.
      await wait(300);
      const diff = await diffFractionSinceSnapshot(page, DIFF_CHANNEL_TOLERANCE);
      if (diff > DIFF_FLOOR) {
        pass("stroke-diff", `a dragged stroke changed the panel: ${(diff * 100).toFixed(2)}% of pixels differ from before the drag, over the ${(DIFF_FLOOR * 100).toFixed(1)}% floor`);
      } else {
        fail("stroke-diff", `a dragged stroke changed nothing: ${(diff * 100).toFixed(2)}% of pixels differ from before the drag, under the ${(DIFF_FLOOR * 100).toFixed(1)}% floor this app's own touch handling should clear`);
      }
    }

    // ---- the proof ---------------------------------------------------
    // Captured after the pointerup, not mid-drag: the same "settle, then
    // shoot" shape tilt mode's own proof uses, so the picture is the
    // finished stroke rather than a frame caught mid-motion.
    const dataUrl = await page.evaluate(() => {
      const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      return canvas ? canvas.toDataURL("image/png") : null;
    });
    if (dataUrl) {
      mkdirSync(dirname(PROOF), { recursive: true });
      writeFileSync(PROOF, Buffer.from(dataUrl.split(",")[1]!, "base64"));
      console.log(`  wrote ${PROOF}`);
      proofWritten = true;
    } else {
      fail("proof", "no canvas to write a proof from");
    }
  } else {
    // ---- 3 (tilt mode): the fluid answers the tilt -----------------------
    // Settle first. The pool is still sloshing at 4.5s and quiet by 9s on
    // this app (measured in scripts/verify-web-apps.ts against its own
    // recorded trace), and there is less fluid here, so 7s is enough.
    await wait(7000);

    const TILT_SAMPLES = 40;
    const WINDOW_MS = TILT_SAMPLES * 32;

    const idleA = await centroidX(page);
    await wait(WINDOW_MS);
    const idleB = await centroidX(page);
    const idleDrift = Math.abs(idleB - idleA);

    // Turn the tilt control on: this pack's host only listens to
    // devicemotion once a person asks it to, which on iOS is a permission
    // gate and here is the same button doing the same thing.
    const tiltOn = await page.evaluate(() => {
      const chip = Array.from(document.querySelectorAll("button.ghost")).find((b) => (b.textContent ?? "").startsWith("tilt")) as HTMLElement | undefined;
      if (!chip) return false;
      chip.click();
      return true;
    });
    if (!tiltOn) fail("tilt-control", "the page drew no tilt control, so this device's vector sensor never reached the host");

    const rawX = await gravityRightSampleX(page);
    const before = await centroidX(page);
    await tiltRight(page, TILT_SAMPLES, rawX);
    const after = await centroidX(page);
    const shift = after - before;

    // Rightward, because gravity was pointed right: a magnitude-only check
    // would pass a mirrored mapping. The bar is twice the pool's own idle
    // drift over the identical window, and at least 2% of the panel width.
    if (shift > Math.max(0.02, idleDrift * 2)) {
      pass("tilt-shift", `a tilt to the right poured the fluid right: centre of mass moved ${(shift * 100).toFixed(2)}% of the panel width, against ${(idleDrift * 100).toFixed(2)}% of idle drift over the same ${WINDOW_MS}ms`);
    } else {
      fail("tilt-shift", `the fluid did not follow the tilt: centre of mass moved ${(shift * 100).toFixed(2)}%, idle drift ${(idleDrift * 100).toFixed(2)}%, over ${WINDOW_MS}ms`);
    }

    // ---- the proof ---------------------------------------------------
    // Captured a beat after the last sample, not during the pour: the
    // module keeps the last vector it was given, so the fluid settles into
    // a pool against the wall it was tilted toward. That is the same
    // picture a hand holding the stick sideways would see, and it reads as
    // a fluid at rest in a tilted box rather than as a frame caught
    // mid-flight.
    await wait(1500);
    const dataUrl = await page.evaluate(() => {
      const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      return canvas ? canvas.toDataURL("image/png") : null;
    });
    if (dataUrl) {
      mkdirSync(dirname(PROOF), { recursive: true });
      writeFileSync(PROOF, Buffer.from(dataUrl.split(",")[1]!, "base64"));
      console.log(`  wrote ${PROOF}`);
      proofWritten = true;
    } else {
      fail("proof", "no canvas to write a proof from");
    }
  }

  await page.close();
} finally {
  server.stop(true);
  if (browser) await closeBrowser(browser);
}

// Printed regardless of pass/fail, and nothing may print after it: tools/
// ledger.ts's tailJson scans stdout from the end for a line that is a
// lone "{", parses from there to the very end of the string, and a human
// sentence trailing the JSON would make that parse fail. So --json exits
// right here, the same shape tools/verify-bundle.ts's own --json branch
// uses (JSON only, nothing else, once the checks above have already
// printed their human lines for anyone watching this run directly).
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: failures === 0,
        mode: STROKE ? "stroke" : "tilt",
        app: APP_NAME,
        silhouette: SILHOUETTE,
        panel: { w: PANEL_W, h: PANEL_H },
        proof: proofWritten ? PROOF.slice(ROOT.length + 1).replace(/\\/g, "/") : null,
        checks,
      },
      null,
      2
    )
  );
  process.exit(failures > 0 ? 1 : 0);
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed - see above`);
  process.exit(1);
}
console.log(
  STROKE
    ? `\nPASS: ${APP_NAME} runs on the ${SILHOUETTE} silhouette at ${PANEL_W}x${PANEL_H}, and a dragged stroke leaves ink`
    : `\nPASS: ${APP_NAME} runs on the ${SILHOUETTE} silhouette at ${PANEL_W}x${PANEL_H}, and pours where it is tilted`
);
