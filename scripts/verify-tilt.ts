// Headless, functional proof that rotating the emulator's view actually
// steers gravity through the new "kind": "vector" tilt sensor (wasm/emu_abi.h's
// emu_sensor_vector, src/rotate.ts's gravityForQuickDeg, src/main.ts's
// sendGravityForRotation), end to end: real DOM click on the real rotation
// control -> a real ABI call into a real wasm module -> the fluid port's
// own physics (apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c) actually
// moving particles toward a different panel edge.
//
// PRECONDITION: wasm/dist/emu.wasm must be the fluidbox module (declares
// the "tilt" vector sensor). Build it first:
//   ZIG_EXE=<path> bun run pack:build -- --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake
// (or, without the "--" separator quirk some shells need:
//   ZIG_EXE=<path> bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake)
//
// Method: load the emulator (embed page, same as a real run page would),
// let the fluid settle at the default 0deg rotation (gravity straight down
// the panel - see fluid.c's own fallback direction), record where its
// pixel mass is concentrated (a centroid over every non-background pixel,
// same idea apps/fluidbox/invariants.ts's countNonBackground uses, "background"
// found dynamically as the frame's single most common colour rather than a
// hardcoded FLUID_BG - this script does not assume which module it is
// pointed at beyond "it is fluidbox"), click the "90deg" quick-rotate
// button (the real control, the same click a person would make), wait for
// several seconds of real ticks, and assert the centroid has moved toward
// the panel edge rotate.ts's gravityForQuickDeg(90) predicts - which, by
// that function's own derivation, is exactly the edge that reads as
// "screen bottom" once the 90deg CSS rotation is applied on screen.
//
// Run with: bun run verify:tilt
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { gravityForQuickDeg } from "../src/rotate";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53412;
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
// skips its finally entirely, which is what used to leave Chrome and the
// dev server running after a failed run. See main()'s own catch at the
// bottom for where the exit code actually gets set, after that finally has
// run.
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
  fail(`${WASM_FILE} does not exist. Build the fluidbox module first - see this file's header comment.`);
}

async function main(): Promise<void> {
const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

// Reads the panel canvas, finds the single most common RGBA colour
// (background - works for any module, not just this one's known FLUID_BG),
// and returns the centroid of every OTHER pixel plus how many there were.
async function readCentroid(page: import("puppeteer-core").Page): Promise<{ cx: number; cy: number; n: number; w: number; h: number }> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
    const w = c.width, h = c.height;
    const data = c.getContext("2d")!.getImageData(0, 0, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bg = 0, bgCount = -1;
    for (const [key, count] of counts) if (count > bgCount) { bg = key; bgCount = count; }
    let sumX = 0, sumY = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      if (key === bg) continue;
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      sumX += px;
      sumY += py;
      n++;
    }
    return { cx: n > 0 ? sumX / n : w / 2, cy: n > 0 ? sumY / n : h / 2, n, w, h };
  });
}

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
  console.log("server up");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  page.on("pageerror", (e) => console.error("page error:", e));

  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));

  const deviceName = await page.$eval("#deviceName", (el) => el.textContent || "");
  console.log(`device: "${deviceName}"`);

  const sensorBtns = await page.$$eval(".sensor-controls .sensor-btn", (els) => els.length);
  console.log(`declared event-sensor button(s) in the embed strip: ${sensorBtns}`);

  // Let the fluid settle at the default 0deg rotation first (fluid.c's
  // fallback gravity, straight down the panel - matches the pre-tilt
  // behaviour exactly, per that port's own README).
  console.log("waiting for the fluid to settle at 0deg...");
  await new Promise((r) => setTimeout(r, 4000));
  const before = await readCentroid(page);
  console.log(`0deg centroid: (${before.cx.toFixed(1)}, ${before.cy.toFixed(1)}) over ${before.n}px, panel ${before.w}x${before.h}`);
  if (before.n === 0) fail("no fluid pixels found at all before rotating - nothing to measure");

  // The real control, the real click.
  const rotated = await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('#rotQuick button[data-deg="90"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!rotated) fail('could not find #rotQuick button[data-deg="90"] to click');
  console.log("clicked the 90deg quick-rotate button");

  console.log("waiting for several seconds of ticks with gravity now pointing sideways...");
  await new Promise((r) => setTimeout(r, 4000));
  const after = await readCentroid(page);
  console.log(`90deg centroid: (${after.cx.toFixed(1)}, ${after.cy.toFixed(1)}) over ${after.n}px`);

  // The prediction, from the SAME function main.ts actually calls (not a
  // reimplementation): rotate.ts's gravityForQuickDeg(90).
  const g = gravityForQuickDeg(90);
  console.log(`gravityForQuickDeg(90) = (${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)})`);
  if (Math.abs(g.x) < 0.5) fail(`gravityForQuickDeg(90) has no meaningful x component (${g.x}) - cannot form a directional prediction`);

  const w = after.w;
  const expectHigh = g.x > 0; // gravity toward +x -> mass should concentrate toward x = w
  const target = expectHigh ? w : 0;
  const deltaTowardTarget = expectHigh ? after.cx - before.cx : before.cx - after.cx;

  console.log(`expected direction: mass shifts toward panel x=${target} (screen-bottom once the 90deg CSS rotation is applied)`);
  console.log(`centroid x moved from ${before.cx.toFixed(1)} to ${after.cx.toFixed(1)} (${deltaTowardTarget >= 0 ? "+" : ""}${deltaTowardTarget.toFixed(1)} toward the predicted edge)`);

  const MIN_SHIFT_PX = 15; // real settle, not noise - fluid.c's particles are drawn as 7x7px squares
  if (deltaTowardTarget < MIN_SHIFT_PX) {
    fail(
      `fluid mass did not migrate toward the predicted edge after rotating 90deg: only ${deltaTowardTarget.toFixed(1)}px of ` +
        `movement toward x=${target}, need at least ${MIN_SHIFT_PX}px. Tilt is not steering gravity.`
    );
  }

  // And a plain sanity floor/ceiling: after settling, most of the mass
  // should now sit on the predicted half of the panel, not just have
  // drifted a little.
  const halfway = w / 2;
  const onPredictedSide = expectHigh ? after.cx > halfway : after.cx < halfway;
  if (!onPredictedSide) {
    fail(`after rotating, the centroid (x=${after.cx.toFixed(1)}) is still on the WRONG half of the panel (halfway=${halfway}) for gravity=(${g.x.toFixed(2)},${g.y.toFixed(2)})`);
  }

  console.log("\nPASS: rotating the view steered the tilt sensor, and the fluid's pixel mass migrated to the correct screen edge");
} finally {
  if (browser) await closeBrowser(browser);
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  server.kill();
}
}

main().catch((err) => {
  if (!(err instanceof VerifyFailure)) console.error(err);
  process.exitCode = 1;
});
