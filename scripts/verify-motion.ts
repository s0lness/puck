// Headless proof for the phone-motion path on an embed run page:
// a real tap enables the dynamically-created chip, synthetic browser
// devicemotion samples reach the real vector ABI path, fluid pixels migrate
// toward the predicted panel edge, and a high-pass burst reaches the real
// shake event path. A second real tap stops ownership and later samples do
// not produce more recorded vector or shake events.
//
// PRECONDITION: wasm/dist/emu.wasm must be the fluidbox module with shake:
//   ZIG_EXE=<path> bun run pack:build -- --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { composePhoneVector, deviceMotionToAbiGravity } from "../src/motion";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53413;
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");
const G = 9.80665;

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("no local Chrome found. Set CHROME_PATH, or install Chrome.");
}
const CHROME = process.env.CHROME_PATH || findChrome();

// Thrown, not process.exit()'d: a bare process.exit() inside the try below
// skips its finally entirely, which is what used to leave Chrome and the
// dev server running after a failed run. See main()'s own catch at the
// bottom for where the exit code actually gets set, after that finally has
// run.
class VerifyFailure extends Error {}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  throw new VerifyFailure(message);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

async function readCentroid(page: import("puppeteer-core").Page): Promise<{ cx: number; cy: number; n: number; w: number; h: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement;
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let background = 0, backgroundCount = -1;
    for (const [key, count] of counts) {
      if (count > backgroundCount) {
        background = key;
        backgroundCount = count;
      }
    }
    let sumX = 0, sumY = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      if (key === background) continue;
      sumX += (i / 4) % w;
      sumY += Math.floor(i / 4 / w);
      n++;
    }
    return { cx: n > 0 ? sumX / n : w / 2, cy: n > 0 ? sumY / n : h / 2, n, w, h };
  });
}

async function dispatchMotion(page: import("puppeteer-core").Page, x: number, y: number, z: number): Promise<void> {
  await page.evaluate(
    ({ ax, ay, az }) => {
      const event = new Event("devicemotion");
      Object.defineProperty(event, "accelerationIncludingGravity", {
        configurable: true,
        value: { x: ax, y: ay, z: az },
      });
      window.dispatchEvent(event);
    },
    { ax: x, ay: y, az: z }
  );
}

if (!existsSync(WASM_FILE)) {
  fail(`${WASM_FILE} does not exist. Build the fluidbox module first, see this file's header comment.`);
}

async function main(): Promise<void> {
const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
  console.log("server up");

  console.log(`launching Chrome: ${CHROME}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  console.log(`Chrome launched (pid ${browser.process()?.pid ?? "detached"})`);
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 760, isMobile: true, hasTouch: true });
  page.on("pageerror", (error) => console.error("page error:", error));

  // Headless desktop Chrome may omit these mobile-only constructors even
  // under mobile viewport emulation. Install only their feature-detection
  // surface before application code runs; samples are still dispatched as
  // real window events below.
  await page.evaluateOnNewDocument(() => {
    if (window.DeviceMotionEvent === undefined) {
      Object.defineProperty(window, "DeviceMotionEvent", { configurable: true, value: class DeviceMotionEvent extends Event {} });
    }
    if (window.DeviceOrientationEvent === undefined) {
      Object.defineProperty(window, "DeviceOrientationEvent", { configurable: true, value: class DeviceOrientationEvent extends Event {} });
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const device = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getDevice: () => { name: string; sensors?: { id: string; kind: string }[] } | null } }).__debug;
    return debug.getDevice();
  });
  if (!device) fail("no device descriptor loaded");
  const hasVector = (device.sensors || []).some((sensor) => sensor.kind === "vector");
  const hasShake = (device.sensors || []).some((sensor) => sensor.kind === "event" && sensor.id.toLowerCase() === "shake");
  if (!hasVector || !hasShake) fail(`loaded module must declare vector and shake sensors, got ${JSON.stringify(device.sensors || [])}`);
  console.log(`device: "${device.name}", vector and shake sensors declared`);

  // Probe the native CDP orientation override explicitly. It can provide
  // alpha/beta/gamma, but this command has no accelerationIncludingGravity
  // field, so the load-bearing acceleration and shake proof uses direct
  // DeviceMotionEvent dispatch below.
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("DeviceOrientation.setDeviceOrientationOverride", { alpha: 0, beta: 0, gamma: 0 });
    await cdp.send("DeviceOrientation.clearDeviceOrientationOverride");
    console.log("CDP DeviceOrientation override is available, but it exposes orientation only, not devicemotion acceleration");
  } catch (error) {
    console.log(`CDP DeviceOrientation override unavailable (${error instanceof Error ? error.message : String(error)}), using synthetic devicemotion dispatch`);
  }

  const idle = await page.$eval("#motionChip", (element) => ({
    state: (element as HTMLElement).dataset.state,
    text: element.textContent || "",
  }));
  if (idle.state !== "idle" || !/tilt with your phone/i.test(idle.text)) fail(`motion chip was not idle: ${JSON.stringify(idle)}`);
  console.log(`motion chip present and idle: "${idle.text}"`);

  await page.tap("#motionChip");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const active = await page.$eval("#motionChip", (element) => ({
    state: (element as HTMLElement).dataset.state,
    text: element.textContent || "",
  }));
  if (active.state !== "active") fail(`real tap did not activate motion chip: ${JSON.stringify(active)}`);
  console.log(`real tap activated motion: "${active.text}"`);

  console.log("waiting for fluid to settle under the initial rotation gravity...");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const before = await readCentroid(page);
  if (before.n === 0) fail("no non-background fluid pixels found before phone tilt");
  console.log(`initial centroid: (${before.cx.toFixed(1)}, ${before.cy.toFixed(1)}) over ${before.n}px`);

  const screenDeg = await page.evaluate(() => screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0);
  const predicted = composePhoneVector(deviceMotionToAbiGravity(-G, 0, 0), screenDeg, 0);
  if (Math.abs(predicted.x) < 0.5) fail(`sideways signal has no useful panel x component after composition: ${JSON.stringify(predicted)}`);
  console.log(`predicted panel gravity: (${predicted.x.toFixed(2)}, ${predicted.y.toFixed(2)}, ${predicted.z.toFixed(2)})`);

  console.log("streaming sustained sideways acceleration for four seconds...");
  for (let i = 0; i < 80; i++) {
    await dispatchMotion(page, -G, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = await readCentroid(page);
  const towardHighX = predicted.x > 0;
  const targetX = towardHighX ? after.w : 0;
  const shift = towardHighX ? after.cx - before.cx : before.cx - after.cx;
  console.log(`tilted centroid: (${after.cx.toFixed(1)}, ${after.cy.toFixed(1)}), ${shift.toFixed(1)}px toward panel x=${targetX}`);
  if (shift < 15) fail(`fluid centroid moved only ${shift.toFixed(1)}px toward predicted edge x=${targetX}, need at least 15px`);
  if (towardHighX ? after.cx <= after.w / 2 : after.cx >= after.w / 2) {
    fail(`fluid centroid x=${after.cx.toFixed(1)} is on the wrong panel half for predicted gravity x=${predicted.x.toFixed(2)}`);
  }

  console.log("dispatching a multi-sample high-pass shake burst...");
  for (let i = 0; i < 6; i++) {
    await dispatchMotion(page, (i % 2 === 0 ? 5 : -5) * G, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const phoneShakeLines = await page.$$eval("#consolePane .console-line", (lines) =>
    lines.map((line) => line.textContent || "").filter((text) => text.includes("shake: phone shake accepted"))
  );
  if (phoneShakeLines.length === 0) fail('shake burst did not log "shake: phone shake accepted"');
  console.log(`phone shake reached the shared event path: "${phoneShakeLines.at(-1)}"`);

  await page.tap("#motionChip");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = await page.$eval("#motionChip", (element) => ({
    state: (element as HTMLElement).dataset.state,
    text: element.textContent || "",
  }));
  if (stopped.state !== "idle") fail(`second real tap did not stop motion: ${JSON.stringify(stopped)}`);

  const countsAfterStop = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getRecorder: () => { events: { k: string }[] } } }).__debug;
    return {
      vectors: debug.getRecorder().events.filter((event) => event.k === "vector").length,
      phoneShakes: Array.from(document.querySelectorAll("#consolePane .console-line")).filter((line) =>
        (line.textContent || "").includes("shake: phone shake accepted")
      ).length,
    };
  });
  for (let i = 0; i < 6; i++) await dispatchMotion(page, (i % 2 === 0 ? 5 : -5) * G, 0, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const countsLater = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getRecorder: () => { events: { k: string }[] } } }).__debug;
    return {
      vectors: debug.getRecorder().events.filter((event) => event.k === "vector").length,
      phoneShakes: Array.from(document.querySelectorAll("#consolePane .console-line")).filter((line) =>
        (line.textContent || "").includes("shake: phone shake accepted")
      ).length,
    };
  });
  if (countsLater.vectors !== countsAfterStop.vectors || countsLater.phoneShakes !== countsAfterStop.phoneShakes) {
    fail(`motion calls continued after stop: immediately=${JSON.stringify(countsAfterStop)}, later=${JSON.stringify(countsLater)}`);
  }
  console.log(`second real tap stopped motion; counts stayed fixed at ${countsLater.vectors} vectors and ${countsLater.phoneShakes} phone shake(s)`);

  console.log("\nPASS: phone motion drove real vector ABI calls, moved fluid toward the predicted edge, fired phone shake, and stopped cleanly");
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
