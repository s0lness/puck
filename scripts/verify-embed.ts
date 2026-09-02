// Headless verification of ?embed=1 (src/main.ts's EMBED, src/app.css's
// html.embed rules): the BARE device a public run page iframes (see
// site/build.ts) - no topbar, no sidebar, no bottom bar (no OLD rotation
// buttons, no OLD shake pill - that whole strip stays display:none, see the
// mustBeHidden list below), no backdrop, just the device floating on the
// page's own background, PLUS a minimal control cluster of its own (see
// main.ts's buildEmbedControls): "r doesn't rotate anything, just put
// buttons on the emulator" was the exact report this cluster answers, the R/S
// keyboard shortcuts being real but secondary now. Several things, in order,
// mirroring scripts/verify.ts's own shape:
//
//   1. Chrome that MUST be gone: the topbar, the sidebar, and the WHOLE OLD
//      bottom bar (not just its cosmetic pieces) - either absent from the
//      DOM's visible layout or actually hidden (display:none via
//      getComputedStyle, not just a CSS class this script trusts by name)
//      - plus #stage itself painting no background of its own.
//   2. The NEW embed control cluster: #embedControls exists with a visible
//      rotate button, and (this loaded module declares a "shake" event
//      sensor) a visible shake button too.
//   3. The device still works: the same real-input proof scripts/verify.ts
//      uses (a synthetic touch stroke, falling back to declared buttons),
//      confirming embed mode is presentation-only and never touches the
//      real input path.
//   4. Clicking the rotate button visibly rotates the device (the bezel's
//      own bounding rect swaps aspect - width/height invert).
//   5. "r" still rotates the device with the OLD strip hidden - the
//      keyboard path stays reachable once the iframe has focus, even
//      though the buttons above are the primary path now.
//   6. Clicking the shake button reaches the real sensor ABI call: a
//      console line proves it landed, and the panel's own pixels move (the
//      fluid module's visible reaction).
//   7. "s" still reaches the same declared shake sensor via keyboard too.
//   8. LAST (this mutates the loaded device's descriptor, so nothing above
//      may depend on shake staying declared afterward): via the page's own
//      __debug.rebuildChrome hook, simulate a device that declares NO
//      "shake" sensor and confirm the shake button disappears while the
//      rotate button and the old bottom bar's hidden state are unaffected.
//      Every device pack and the example firmware in this repo declare
//      "shake" unconditionally today (verified by reading each one's
//      emu_device()), so there is no real "no shake" module to load via
//      ?module= for this - the debug hook re-derives the chrome through
//      the exact same buildChrome() a real reload against such a module
//      would use, just without needing one to exist.
//
// Run with: bun run verify:embed (needs wasm/dist/emu.wasm built WITH a
// declared shake sensor for steps 2/6/7 to be meaningful - e.g. the
// fluidbox pack build with --shake, see this repo's gate sequence).
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53411;
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
  fail(`${WASM_FILE} does not exist. Run "bun run example:build" (or any pack build) first.`);
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
  await page.setViewport({ width: 900, height: 700 });
  page.on("pageerror", (e) => console.error("page error:", e));

  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));

  // 1. Chrome that must be gone: absent from the accessible/visible page
  // (either not in the DOM, or actually display:none per the computed
  // style - never trusting a class name alone, in case the CSS selector
  // itself is wrong).
  const isEffectivelyHidden = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return true; // absent counts as hidden
      const style = getComputedStyle(el);
      // getComputedStyle only reports the ELEMENT'S OWN display/visibility,
      // not whether an ancestor's display:none removed it from the render
      // tree - .side.controls being display:none does not change what
      // getComputedStyle(#consolePane) reports for #consolePane itself.
      // offsetParent is null for exactly that "not actually rendered"
      // case (and is otherwise non-null for anything in normal flow, none
      // of these elements are position:fixed), so check both.
      return style.display === "none" || style.visibility === "hidden" || el.offsetParent === null;
    }, sel);

  const mustBeHidden = [
    { sel: ".topbar", label: "top toolbar (freeze/save/load/baseline/check/quit)" },
    { sel: ".side.controls", label: "input/device/console sidebar" },
    { sel: "#consolePane", label: "console pane" },
    { sel: ".diag-strip", label: "diagnostics strip" },
    { sel: ".tilt-slider", label: "cosmetic tilt slider" },
    { sel: "#btnPause", label: "pause button" },
    { sel: "#btnStep", label: "step button" },
    // The bare-device pass: the WHOLE bottom bar is gone now, not just the
    // tilt/pause/step pieces - no rotation buttons, no shake pill, on
    // screen. See app.css's html.embed .bottom-bar rule.
    { sel: ".bottom-bar", label: "bottom bar (rotation buttons + any shake pill)" },
    { sel: "#rotQuick", label: "rotation buttons" },
    { sel: "#sensorControls", label: "sensor-event buttons (e.g. shake)" },
  ];
  for (const { sel, label } of mustBeHidden) {
    const hidden = await isEffectivelyHidden(sel);
    if (!hidden) fail(`embed mode: "${label}" (${sel}) is still visible`);
    console.log(`hidden as expected: ${label} (${sel})`);
  }

  // No backdrop either: .stage must not paint a background of its own -
  // this is the "device just floating" half of the bare-embed pass, not
  // just an absence of buttons.
  const stageBg = await page.evaluate(() => getComputedStyle(document.querySelector("#stage")!).backgroundColor);
  if (!/rgba\(0, ?0, ?0, ?0\)|transparent/.test(stageBg)) fail(`embed mode: #stage still paints a background (${stageBg}), expected transparent`);
  console.log(`transparent as expected: #stage background (${stageBg})`);

  // FIX 2's desktop-chip-hidden check: this script's own viewport never
  // sets hasTouch/isMobile (defaults to a plain desktop viewport), so
  // navigator.maxTouchPoints stays 0 and matchMedia("(pointer: coarse)")
  // stays false - exactly the context main.ts's motion chip must never
  // appear in, regardless of which module is loaded or whether it declares
  // a vector sensor at all.
  const chipPresent = await page.evaluate(() => document.querySelector("#motionChip") !== null);
  if (chipPresent) fail("embed mode on a desktop (non-touch) viewport: the tilt-with-your-phone chip is present");
  console.log("no tilt chip on a desktop viewport, as expected");

  // The device itself (bezel/panel) must still be visible.
  const deviceVisible = await page.evaluate(() => {
    const el = document.querySelector("#bezel");
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!deviceVisible) fail("embed mode: the device (#bezel) is not visible");
  console.log("visible as expected: the device itself (#bezel)");

  // 2. The NEW embed control cluster (main.ts's buildEmbedControls): a
  // rotate button always, a shake button only when this loaded module
  // actually declares a "shake" event sensor. Visible per getComputedStyle,
  // same rigor as the mustBeHidden helper above, not just "exists in the
  // DOM" (the shake button exists but stays `hidden` for a device with no
  // such sensor - see step 8 below).
  const isVisible = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
    }, sel);

  const rotateBtnVisible = await isVisible('#embedControls .embed-ctrl-btn[aria-label="rotate"]');
  if (!rotateBtnVisible) fail("embed mode: the rotate button (#embedControls) is not visible");
  console.log("visible as expected: the embed rotate button");

  const loadedDevice = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getDevice: () => { sensors?: { id: string; kind: string }[] } | null } }).__debug;
    return debug.getDevice();
  });
  const loadedHasShake = (loadedDevice?.sensors || []).some((s) => s.kind === "event" && s.id.toLowerCase() === "shake");
  if (!loadedHasShake) {
    fail(
      "embed mode: the loaded module declares no \"shake\" event sensor - build it with one first " +
        "(e.g. the fluidbox pack build with --shake) so steps 2/6/7 below are actually exercised"
    );
  }
  const shakeBtnVisible = await isVisible('#embedControls .embed-ctrl-btn[aria-label="shake"]');
  if (!shakeBtnVisible) fail("embed mode: the loaded module declares a shake sensor but the embed shake button is not visible");
  console.log("visible as expected: the embed shake button (loaded module declares a shake sensor)");

  // 3. The device still works: same real-input proof as scripts/verify.ts.
  const panelBox = await page.$eval("#panel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
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
  const before = await readPanel();

  const cx = panelBox.x + panelBox.width * 0.3;
  const cy = panelBox.y + panelBox.height * 0.3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx + i * 8, cy + i * 4);
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));

  let changed = countDiff(before, await readPanel());
  if (changed === 0) {
    const buttons = await page.$$("#bezel .dev-btn");
    for (let i = 0; i < buttons.length; i++) {
      await buttons[i]!.click();
      await new Promise((r) => setTimeout(r, 400));
      changed = countDiff(before, await readPanel());
      if (changed > 0) break;
    }
  }
  console.log(`panel pixels changed after real input: ${changed} byte(s) different out of ${before.length}`);
  if (changed === 0) fail("embed mode: touch/button input reached the panel and NOTHING changed - input path is broken in embed mode");

  // 4. Clicking the rotate button visibly rotates the device: the bezel's
  // own on-screen bounding rect (a real CSS transform: rotate(), not just
  // internal state) swaps aspect at a quarter turn. This pack's panel is
  // 368x448 (non-square), so a 90deg step always changes which dimension is
  // larger.
  // getBoundingClientRect()'s own properties live on its prototype, not as
  // own enumerable fields, so returning it straight from page.$eval loses
  // every field to serialization (an empty object comes back) - the same
  // gotcha panelBox above already works around by picking fields out
  // explicitly.
  const bezelRect = () =>
    page.$eval("#bezel", (el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
  const bezelBefore = await bezelRect();
  await page.click('#embedControls .embed-ctrl-btn[aria-label="rotate"]');
  await new Promise((r) => setTimeout(r, 300));
  const bezelAfterClick = await bezelRect();
  const wasPortrait = bezelBefore.height > bezelBefore.width;
  const isPortraitNow = bezelAfterClick.height > bezelAfterClick.width;
  if (wasPortrait === isPortraitNow) {
    fail(
      `embed mode: clicking rotate did not visibly rotate the device - before ${bezelBefore.width.toFixed(0)}x${bezelBefore.height.toFixed(0)}, ` +
        `after ${bezelAfterClick.width.toFixed(0)}x${bezelAfterClick.height.toFixed(0)} (orientation did not flip)`
    );
  }
  console.log(
    `clicking rotate visibly rotated the device: ${bezelBefore.width.toFixed(0)}x${bezelBefore.height.toFixed(0)} -> ` +
      `${bezelAfterClick.width.toFixed(0)}x${bezelAfterClick.height.toFixed(0)}`
  );

  // 5. "r" rotates even with the OLD strip hidden. #rotQuick's own buttons
  // (and their "active" markup) still exist in the DOM, just not painted -
  // this is what a run page's own hint (site/build.ts) tells a visitor to
  // press instead of a button they can no longer see.
  const activeDeg = () =>
    page.evaluate(() => {
      const b = document.querySelector("#rotQuick button.active") as HTMLButtonElement | null;
      return b ? b.dataset.deg : null;
    });
  const degBefore = await activeDeg();
  await page.keyboard.press("r");
  await new Promise((r) => setTimeout(r, 250));
  const degAfter = await activeDeg();
  if (degBefore === null || degAfter === null) fail(`embed mode: could not read #rotQuick's active button (before=${degBefore}, after=${degAfter})`);
  if (degBefore === degAfter) fail(`embed mode: pressing "r" did not change the rotation (stayed at ${degBefore}deg)`);
  console.log(`"r" rotates as expected: ${degBefore}deg -> ${degAfter}deg`);

  // 6. Clicking the shake button reaches the real sensor ABI call, exactly
  // the "produces a frame change" proof asked for: a console line proves
  // emu_sensor_event() actually landed, and (the fluidbox module's fluid
  // sim visibly reacts to a shake) the panel's own pixels move too. The
  // pixel diff alone would be weak evidence on its own (fluidbox keeps
  // animating every tick regardless), so the console line is the
  // load-bearing half of this proof and the pixel diff is corroboration.
  const shakeBefore = await readPanel();
  await page.click('#embedControls .embed-ctrl-btn[aria-label="shake"]');
  await new Promise((r) => setTimeout(r, 300));
  const shakeLastLine = await page.evaluate(() => {
    const lines = document.querySelectorAll("#consolePane .console-line");
    return lines.length ? lines[lines.length - 1]!.textContent : null;
  });
  if (!shakeLastLine || !/sensor|shake/i.test(shakeLastLine)) {
    fail(`embed mode: clicking the shake button did not log a sensor event (last console line: ${shakeLastLine})`);
  }
  const shakeChanged = countDiff(shakeBefore, await readPanel());
  if (shakeChanged === 0) fail("embed mode: clicking the shake button logged a sensor event but the panel did not change at all");
  console.log(`clicking shake reached the sensor (console: "${shakeLastLine}") and changed ${shakeChanged} panel byte(s)`);

  // 7. "s" reaches the same shake sensor via keyboard too. #consolePane
  // stays hidden but still receives every logged line (main.ts's
  // ConsoleLog does not check EMBED), so its last line is a real proof a
  // sensor fired, not a guess.
  await page.keyboard.press("s");
  await new Promise((r) => setTimeout(r, 250));
  const sLastLine = await page.evaluate(() => {
    const lines = document.querySelectorAll("#consolePane .console-line");
    return lines.length ? lines[lines.length - 1]!.textContent : null;
  });
  if (!sLastLine || !/sensor|shake/i.test(sLastLine)) fail(`embed mode: pressing "s" did not log a sensor event (last console line: ${sLastLine})`);
  console.log(`"s" reaches the sensor as expected (console: "${sLastLine}")`);

  const engineDead = await isEffectivelyHidden("#engineDead");
  if (!engineDead) fail('embed mode: rotate/shake (button and keyboard) left #engineDead visible - one of them crashed the module');
  console.log("engine still alive after every rotate/shake path: #engineDead stayed hidden");

  // 8. LAST: the negative case. Simulate a device with no declared "shake"
  // sensor (every real pack/example firmware in this repo declares one
  // unconditionally, so there is no module to load via ?module= for this -
  // see this file's header comment) by mutating the live device object and
  // re-deriving the whole chrome through the same buildChrome() a real
  // reload would use. The shake button must disappear; the rotate button
  // and the old bottom bar's hidden state must be completely unaffected.
  await page.evaluate(() => {
    const debug = (
      window as unknown as {
        __debug: { getDevice: () => { sensors?: { id: string; kind: string }[] } | null; rebuildChrome: () => void };
      }
    ).__debug;
    const d = debug.getDevice();
    if (d) d.sensors = (d.sensors || []).filter((s) => !(s.kind === "event" && s.id.toLowerCase() === "shake"));
    debug.rebuildChrome();
  });
  await new Promise((r) => setTimeout(r, 250));
  const shakeBtnVisibleAfter = await isVisible('#embedControls .embed-ctrl-btn[aria-label="shake"]');
  if (shakeBtnVisibleAfter) fail("embed mode: simulated a device with no shake sensor, but the embed shake button is still visible");
  console.log("shake button correctly absent for a device with no declared shake sensor");
  const rotateBtnStillVisible = await isVisible('#embedControls .embed-ctrl-btn[aria-label="rotate"]');
  if (!rotateBtnStillVisible) fail("embed mode: simulating a no-shake device also hid the rotate button - it must stay unconditional");
  console.log("rotate button still visible, as expected (unconditional)");
  const bottomBarStillHidden = await isEffectivelyHidden(".bottom-bar");
  if (!bottomBarStillHidden) fail("embed mode: the OLD .bottom-bar strip is visible again after rebuilding chrome - it must never come back");
  console.log("the OLD .bottom-bar strip is still absent after rebuilding chrome, as expected");

  console.log(
    "\nPASS: ?embed=1 is the bare device plus its own rotate/shake button cluster (no OLD control strip, no backdrop), " +
      "real input still reaches the panel, clicking rotate/shake reaches the real ABI paths, \"r\"/\"s\" still work too, " +
      "and the shake button correctly hides itself for a device with no declared shake sensor"
  );

  // 9. FIX 2: no bezel-drag response on a touch device. main.ts no longer
  // calls device.ts's makeDraggable at all in embed mode (see its
  // wireStaticUI comment) precisely so a touch drag can never miss-click
  // into a free reposition, and motion.ts's DragMotion already bails out
  // for any touch-capable pointer (its own isTouchCapable() check) before
  // it ever calls sendVector or moves the visual offset - so a touch drag
  // starting on the bare bezel plastic must leave the device exactly where
  // it was and must never reach the vector ABI path. A fresh page/context
  // is used, with a real mobile+touch viewport (isMobile+hasTouch both
  // true), rather than reusing the page above: that page's own viewport
  // never set hasTouch, so navigator.maxTouchPoints would still read 0
  // there and this whole check would silently prove nothing.
  const touchPage = await browser.newPage();
  await touchPage.setViewport({ width: 400, height: 800, isMobile: true, hasTouch: true });
  const touchPageErrors: string[] = [];
  touchPage.on("pageerror", (e) => touchPageErrors.push(String(e)));
  await touchPage.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));

  const touchCapable = await touchPage.evaluate(
    () => navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches
  );
  if (!touchCapable) fail("touch-emulation page: navigator.maxTouchPoints/matchMedia never went touch-capable - the emulation itself did not take, this check would prove nothing");
  console.log("touch-emulation page is touch-capable, as expected");

  const touchBezelBefore = await touchPage.$eval("#bezel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const touchDragX = touchBezelBefore.x + 8;
  const touchDragY = touchBezelBefore.y + touchBezelBefore.height / 2;
  const touchTarget = await touchPage.evaluate(
    (p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return el ? el.id || el.tagName : null;
    },
    { x: touchDragX, y: touchDragY }
  );
  if (touchTarget !== "bezel") fail(`touch-drag check: chosen point (${touchDragX},${touchDragY}) does not resolve to #bezel (got "${touchTarget}")`);

  // Clear the recorder so the only "vector" events that could show up are
  // ones this drag itself produces - not the initial-load/rotation-sync
  // gravity read every module gets on boot.
  await touchPage.evaluate(() => {
    const debug = (window as unknown as { __debug: { getRecorder: () => { clear: () => void } } }).__debug;
    debug.getRecorder().clear();
  });

  const touch = await touchPage.touchscreen.touchStart(touchDragX, touchDragY);
  const TOUCH_DRAG_PX = 35;
  const TOUCH_STEPS = 8;
  for (let i = 1; i <= TOUCH_STEPS; i++) {
    await touch.move(touchDragX + (TOUCH_DRAG_PX * i) / TOUCH_STEPS, touchDragY);
    await new Promise((r) => setTimeout(r, 30));
  }
  await touch.end();
  await new Promise((r) => setTimeout(r, 300));

  const touchBezelAfter = await touchPage.$eval("#bezel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (Math.abs(touchBezelAfter.x - touchBezelBefore.x) > 1 || Math.abs(touchBezelAfter.y - touchBezelBefore.y) > 1) {
    fail(
      `touch-drag on the bezel moved the device: was (${touchBezelBefore.x},${touchBezelBefore.y}), ` +
        `now (${touchBezelAfter.x},${touchBezelAfter.y}) - free repositioning must be completely disabled on touch in embed mode`
    );
  }
  console.log("touch-drag on the bezel left the device exactly where it was, as expected");

  const vectorEventsAfterTouchDrag = await touchPage.evaluate(() => {
    const debug = (
      window as unknown as { __debug: { getRecorder: () => { events: { k: string }[] } } }
    ).__debug;
    return debug.getRecorder().events.filter((e) => e.k === "vector").length;
  });
  if (vectorEventsAfterTouchDrag > 0) {
    fail(`touch-drag on the bezel sent ${vectorEventsAfterTouchDrag} vector event(s) - DragMotion must never fire for a touch pointer`);
  }
  console.log("touch-drag on the bezel sent no vector events, as expected");

  if (touchPageErrors.length > 0) fail(`touch-drag check threw: ${touchPageErrors.join(" | ")}`);
  await touchPage.close();
  console.log("PASS (FIX 2): no bezel-drag response at all on a touch device in embed mode");
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
