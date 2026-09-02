// Headless verification: does the page actually work. Two things, in
// order:
//
//   1. The missing-module path: if wasm/dist/emu.wasm doesn't exist yet,
//      confirm the page says so clearly (per main.ts's showWasmError) and
//      is NOT a blank screen. This is the state a fresh clone is in before
//      anyone has built anything.
//   2. The real path: if the module exists (e.g. after `bun run
//      example:build`), confirm the device actually comes up, AND drive
//      real synthetic input at it, then read the canvas pixels back and
//      confirm they changed. This is the concrete proof this repo's own
//      README promises: not just "the page didn't crash", but "a firmware,
//      compiled fresh, drew something in response to real input, through
//      the real ABI, in a real browser".
//
//      Input means a touch stroke first, and then, only if the panel did
//      not move, each button the firmware DECLARED, pressed in turn. Touch
//      alone is not a safe proxy for "is this thing alive": a firmware is
//      perfectly entitled to ignore a finger in whatever it happens to be
//      showing (a stopwatch face has nothing to draw for one), and this
//      script is not allowed to know which app that is or which button
//      would wake it. Trying every declared input is the device-agnostic
//      way to ask the same question, and it is a stronger check than the
//      touch stroke was on its own, not a weaker one: the failure below
//      now means nothing this device declares can make it draw.
//
// Uses puppeteer-core against a local Chrome install (no bundled Chromium
// download), the same pattern documented in AGENTS.md.
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53409;
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
  throw new Error(
    `no local Chrome found in the usual locations. Set CHROME_PATH to your Chrome/Chromium executable, ` +
      `or install Chrome. puppeteer-core deliberately does not bundle its own Chromium download.`
  );
}
const CHROME = process.env.CHROME_PATH || findChrome();

// A verification failure the caller already explained on stderr (the
// `FAIL: ...` line below). Thrown, not process.exit()'d, so it unwinds
// through the try/finally at the bottom that kills Chrome and the dev
// server: a bare process.exit() inside that try skips finally entirely on
// both Bun and Node, which is exactly what left Chrome and the server
// running after a failed run.
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

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (e) => console.error("page error:", e));

  // NOT networkidle0: the page opens a live-reload websocket on boot
  // (main.ts, connectLiveReload) that stays open and reconnects on close by
  // design, so the network never goes idle and that waitUntil would hang
  // forever.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  // The boot sequence is async (fetch -> instantiate -> emu_init); give it
  // a moment to settle either way.
  await new Promise((r) => setTimeout(r, 1000));

  const bodyHasContent = await page.evaluate(() => document.body.textContent!.trim().length > 0);
  if (!bodyHasContent) fail("page body is empty (blank screen) after boot attempt");
  console.log("page rendered non-empty content");

  const wasmBuilt = existsSync(WASM_FILE);

  if (!wasmBuilt) {
    console.log(`${WASM_FILE} does not exist -- checking the graceful-failure path`);
    const errorShown = await page.evaluate(() => {
      const el = document.querySelector("#wasmError");
      return el && !el.classList.contains("hidden") && (el.textContent || "").length > 0;
    });
    if (!errorShown) fail("wasm module is missing but #wasmError is not showing a message: this would look like a silent blank/broken page");
    const errorText = await page.$eval("#wasmError", (el) => el.textContent || "");
    console.log(`#wasmError shows: ${errorText.slice(0, 200)}`);
    if (!/wasm/i.test(errorText)) fail("#wasmError message does not even mention wasm; not clear enough to act on");
    console.log("PASS: missing-module failure is surfaced clearly on the page, not a blank screen");
    console.log(`\nRun "bun run example:build" then re-run this script to check the full interactive path.`);
  } else {
    console.log(`${WASM_FILE} exists -- checking the device actually came up`);
    const deviceName = await page.$eval("#deviceName", (el) => el.textContent || "");
    const errorHidden = await page.evaluate(() => document.querySelector("#wasmError")?.classList.contains("hidden") ?? true);
    if (!errorHidden) {
      const errorText = await page.$eval("#wasmError", (el) => el.textContent || "");
      fail(`wasm module exists but the page still shows an error: ${errorText}`);
    }
    console.log(`device came up: "${deviceName}"`);

    // The interactive proof: read the panel canvas before and after
    // driving a real synthetic mouse stroke across it, and confirm the
    // pixels actually changed. This is the difference between "the page
    // didn't crash" and "the firmware drew something in response to real
    // input" - the thing a newcomer actually needs to see to trust this
    // tool at all.
    const panelBox = await page.$eval("#panel", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const before = await page.evaluate(() => {
      const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
      return Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
    });

    const cx = panelBox.x + panelBox.width * 0.3;
    const cy = panelBox.y + panelBox.height * 0.3;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(cx + i * 8, cy + i * 4);
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 300)); // let a few more ticks run

    const readPanel = () =>
      page.evaluate(() => {
        const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
        return Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
      });
    const countDiff = (a: number[], b: number[]) => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };

    let changed = countDiff(before, await readPanel());
    let via = "a real synthetic touch stroke";

    if (changed === 0) {
      // The chrome's buttons are built one per emu_device() entry (main.ts),
      // so this presses exactly what this firmware said it has, in the
      // order it declared them, and stops at the first one that draws.
      const buttons = await page.$$("#bezel .dev-btn");
      console.log(`touch alone moved nothing; trying the ${buttons.length} button(s) this device declared`);
      for (let i = 0; i < buttons.length; i++) {
        await buttons[i]!.click();
        await new Promise((r) => setTimeout(r, 400));
        changed = countDiff(before, await readPanel());
        if (changed > 0) {
          via = `a real synthetic press of declared button ${i}`;
          break;
        }
      }
    }

    console.log(`panel pixels changed after ${via}: ${changed} byte(s) different out of ${before.length}`);
    if (changed === 0)
      fail(
        "drove a real touch stroke across the panel AND pressed every button this firmware declared, and NOT ONE PIXEL changed; nothing this device declares as an input is reaching it"
      );
    console.log("PASS: the panel rendered fresh pixels in response to real input, through the real ABI, in a real browser");
  }
} finally {
  if (browser) await closeBrowser(browser);
  // Plain server.kill() (SIGTERM) was observed to leave the Bun dev server
  // (development.hmr spawns a watcher) still listening on Windows even
  // after the parent process object reports killed. Force the whole tree.
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  server.kill();
}
}

// Only after main()'s finally has actually run (Chrome and the dev server
// are down either way) does this decide the exit code. A VerifyFailure
// already printed its own `FAIL: ...` line; anything else is unexpected and
// gets logged here so it is not lost.
main().catch((err) => {
  if (!(err instanceof VerifyFailure)) console.error(err);
  process.exitCode = 1;
});
