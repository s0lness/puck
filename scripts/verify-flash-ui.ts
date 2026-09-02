// scripts/verify-flash-ui.ts: headless proof the "Flash to the real
// device" section actually renders on a real run page, and that the
// unsupported-browser path is a clean message, not a thrown exception.
//
// Same shape as scripts/verify.ts (a local static server, puppeteer-core
// against a local Chrome install, no bundled Chromium download), but
// serving the built gallery (site/dist/, static output) instead of the
// dev server, and driving the fluidbox-rp2350 run page instead of the
// bare emulator.
//
// The unsupported-browser path is forced deterministically rather than
// hoped for: real headless Chrome does expose navigator.usb, and calling
// requestDevice() from there would either hang waiting on a device chooser
// that can never appear headless, or behave inconsistently across Chrome
// versions. So this script deletes navigator.usb before any page script
// runs (page.evaluateOnNewDocument), which is exactly the condition
// flash-ui.ts's isWebUsbSupported() check exists to handle, and then
// clicks the real button and reads the real DOM.
//
// The same trick, pointed the other way, is what lets the RUNNING-DEVICE
// path be checked at all. A board running puck firmware enumerates as
// 2E8A:0009 and has to be rebooted into BOOTSEL over its reset interface
// before anything can be written (site/flasher/flash.ts). No headless
// browser has one plugged in, so navigator.usb is replaced with a fake
// that answers with descriptors shaped like the real device's, records
// every call, and lets the REAL bundled flash.js drive it. What that
// proves is the framing and the state machine: which interface gets
// claimed, the exact control-transfer setup fields, that the
// re-enumerated BOOTSEL device is picked up from getDevices(), and that
// each failure renders as a sentence instead of an exception. What it
// cannot prove is that a real RP2350 obeys the request - only the bench
// can, and packs/rp2350-touch-amoled-18/AGENTS.md says so.
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53411;

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

if (!existsSync(DIST)) fail(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

async function main(): Promise<void> {
// The shared emulator bundle's main.ts unconditionally tries to open a
// live-reload websocket on boot (by design, see scripts/verify.ts's own
// comment); this static server (scripts/staticSite.ts) answers that (and
// any other unknown path, e.g. /favicon.ico) with a plain 404 instead of
// letting a missing file bubble into a noisy 500 - nothing this script
// needs to special-case itself.
const server = serveDist(DIST, PORT);

try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    // Only uncaught exceptions count as a failure here. The emulator
    // bundle's own live-reload websocket (main.ts, by design - see
    // scripts/verify.ts's header comment) has nothing to connect to under
    // this static server and logs a console error for it; that's expected
    // noise unrelated to the flash button, not the exception this check
    // is trying to catch.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    // Strip navigator.usb before any page script executes, so the
    // "unsupported browser" branch is exercised deterministically instead
    // of depending on this Chrome build's real WebUSB behaviour.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window.navigator, "usb", { value: undefined, configurable: true });
    });

    await page.goto(`http://127.0.0.1:${PORT}/run/fluidbox-rp2350.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 500));

    const hasSection = await page.evaluate(() => !!document.querySelector(".flash-section[data-uf2]"));
    if (!hasSection) fail("fluidbox-rp2350.html has no .flash-section[data-uf2]: the flash section did not render");
    console.log("flash section renders on fluidbox-rp2350.html");

    const hasDownloadLink = await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(".flash-btn-alt");
      return !!a && a.hasAttribute("download") && a.getAttribute("href") === "../flash/fluidbox-rp2350.uf2";
    });
    if (!hasDownloadLink) fail("no working .flash-btn-alt download link pointing at ../flash/fluidbox-rp2350.uf2");
    console.log("download .uf2 fallback link present and correct");

    const ritual = await page.evaluate(() => {
      const details = document.querySelector("details.flash-ritual");
      return {
        text: details ? details.textContent || "" : null,
        intro: details ? details.querySelector(".flash-ritual-intro")?.textContent || null : null,
      };
    });
    if (ritual.text === null || !ritual.text.includes("BOOT")) fail("no BOOTSEL entry ritual <details> found");
    console.log("BOOTSEL entry ritual present");
    // The ritual is the recovery path now, not the entry path: the fold
    // has to say so, or a reader still believes holding two buttons is
    // step one (site/build.ts's BOOTSEL_RITUAL_INTRO).
    if (!ritual.intro || !/only needed/i.test(ritual.intro) || !/bricked/i.test(ritual.intro)) {
      fail(`the ritual fold does not open with its "only needed for a bricked board..." caveat, got: ${JSON.stringify(ritual.intro)}`);
    }
    console.log(`ritual fold framed as recovery only: "${ritual.intro}"`);

    const clicked = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(".flash-btn");
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) fail("no .flash-btn found to click");

    await new Promise((r) => setTimeout(r, 300));

    const errorState = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".flash-error");
      return { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
    });
    if (errorState.hidden !== false) fail(`clicking Flash over USB did not surface a visible .flash-error (state: ${JSON.stringify(errorState)})`);
    if (!errorState.text || !/webusb/i.test(errorState.text)) {
      fail(`expected an unsupported-browser message mentioning WebUSB, got: ${JSON.stringify(errorState.text)}`);
    }
    console.log(`unsupported-browser message shown: "${errorState.text}"`);

    if (pageErrors.length > 0) {
      fail(`clicking Flash over USB with no navigator.usb threw/logged an error instead of a clean message: ${pageErrors.join(" | ")}`);
    }
    console.log("no exceptions thrown");

    // ---- the running-device path, against a fake WebUSB stack ----------
    type Scenario = "no-device" | "no-reset-interface" | "reboots-and-flashes";

    interface ScenarioResult {
      errorHidden: boolean | null;
      errorText: string | null;
      statusLog: string[];
      usbLog: Array<Record<string, unknown>>;
      pageErrors: string[];
      // FIX 1: the completed-state banner .flash-done replaces the
      // progress block once the done-phase fade finishes (flash-ui.ts's
      // showDone) - read straight from the DOM rather than inferred from
      // statusLog, since that banner is a different element than the one
      // the MutationObserver above is watching.
      doneHidden: boolean | null;
      doneText: string | null;
      progressHidden: boolean | null;
      progressBarHasDoneClass: boolean | null;
    }

    async function runScenario(scenario: Scenario, settleMs: number): Promise<ScenarioResult> {
      const scenarioPage = await browser.newPage();
      const errors: string[] = [];
      scenarioPage.on("pageerror", (e) => errors.push(String(e)));

      // The whole fake USB stack, installed before any page script runs.
      // Descriptor shapes are the real ones: a running puck is CDC control
      // + CDC data + (unless this scenario is testing old firmware) the
      // vendor reset interface at number 2; the device that "comes back"
      // is a BOOTSEL device with a mass-storage interface and PICOBOOT's
      // class 0xFF bulk pair.
      await scenarioPage.evaluateOnNewDocument((mode: string) => {
        const log: unknown[] = [];
        Object.defineProperty(window, "__usbLog", { value: log, configurable: true });

        const bulk = (n: number, dir: string) => ({ endpointNumber: n, direction: dir, type: "bulk", packetSize: 64 });
        const alt = (cls: number, sub: number, proto: number, endpoints: unknown[]) => ({
          alternateSetting: 0,
          interfaceClass: cls,
          interfaceSubclass: sub,
          interfaceProtocol: proto,
          interfaceName: null,
          endpoints,
        });

        const cdc = [
          { interfaceNumber: 0, alternates: [alt(0x02, 0x02, 0x00, [{ endpointNumber: 1, direction: "in", type: "interrupt", packetSize: 8 }])] },
          { interfaceNumber: 1, alternates: [alt(0x0a, 0x00, 0x00, [bulk(2, "out"), bulk(2, "in")])] },
        ];
        const resetItf = { interfaceNumber: 2, alternates: [alt(0xff, 0x00, 0x01, [])] };

        function fakeDevice(productId: number, interfaces: unknown[]) {
          let opened = false;
          let configuration: unknown = null;
          return {
            vendorId: 0x2e8a,
            productId,
            productName: productId === 0x0009 ? "Pico" : "RP2 Boot",
            get opened() {
              return opened;
            },
            get configuration() {
              return configuration;
            },
            configurations: [{ configurationValue: 1, configurationName: null, interfaces }],
            async open() {
              opened = true;
              log.push({ op: "open", productId });
            },
            async close() {
              opened = false;
              log.push({ op: "close", productId });
            },
            async selectConfiguration(value: number) {
              configuration = { configurationValue: value, configurationName: null, interfaces };
            },
            async claimInterface(interfaceNumber: number) {
              log.push({ op: "claim", productId, interfaceNumber });
            },
            async releaseInterface(interfaceNumber: number) {
              log.push({ op: "release", productId, interfaceNumber });
            },
            async controlTransferOut(setup: unknown) {
              log.push({ op: "controlTransferOut", productId, setup });
              return { status: "ok", bytesWritten: 0 };
            },
            async transferOut(endpointNumber: number, data: Uint8Array) {
              return { status: "ok", bytesWritten: data.byteLength };
            },
            async transferIn() {
              return { status: "ok", data: new DataView(new ArrayBuffer(16)) };
            },
            async clearHalt() {},
            async reset() {},
          };
        }

        const running = fakeDevice(0x0009, mode === "no-reset-interface" ? cdc : cdc.concat([resetItf]));
        const bootsel = fakeDevice(0x000f, [
          { interfaceNumber: 0, alternates: [alt(0x08, 0x06, 0x50, [bulk(1, "in"), bulk(1, "out")])] },
          { interfaceNumber: 1, alternates: [alt(0xff, 0x00, 0x00, [bulk(3, "in"), bulk(4, "out")])] },
        ]);

        let getDevicesCalls = 0;
        const usb = {
          async getDevices() {
            getDevicesCalls++;
            // The board is not back on the first look, which is also what
            // exercises flash.ts's polling rather than a single check.
            if (mode === "reboots-and-flashes" && getDevicesCalls >= 2) return [bootsel];
            return [];
          },
          async requestDevice(options: { filters: unknown[] }) {
            log.push({ op: "requestDevice", filters: options.filters });
            if (mode === "no-device") throw new DOMException("No device selected.", "NotFoundError");
            return running;
          },
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return true;
          },
        };
        Object.defineProperty(window.navigator, "usb", { value: usb, configurable: true });
      }, scenario);

      await scenarioPage.goto(`http://127.0.0.1:${PORT}/run/fluidbox-rp2350.html`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 400));

      await scenarioPage.evaluate(() => {
        const w = window as unknown as { __statusLog: string[]; __progressBarWasDone: boolean };
        w.__statusLog = [];
        w.__progressBarWasDone = false;
        const status = document.querySelector(".flash-status");
        if (status) {
          const record = () => {
            const text = status.textContent || "";
            if (text && w.__statusLog[w.__statusLog.length - 1] !== text) w.__statusLog.push(text);
          };
          new MutationObserver(record).observe(status, { childList: true, characterData: true, subtree: true });
        }
        // FIX 1: the bar's "done" (success-green) class is added, held, and
        // then removed again as the whole block fades - a snapshot read
        // AFTER settleMs would always see it gone. Latching the flag the
        // moment the class is ever added is what lets this script prove the
        // green beat actually happened, not just that the final banner
        // showed up.
        const bar = document.querySelector(".flash-progress-bar");
        if (bar) {
          const watch = () => {
            if (bar.classList.contains("done")) w.__progressBarWasDone = true;
          };
          new MutationObserver(watch).observe(bar, { attributes: true, attributeFilter: ["class"] });
        }
        document.querySelector<HTMLButtonElement>(".flash-btn")?.click();
      });
      await new Promise((r) => setTimeout(r, settleMs));

      const observed = await scenarioPage.evaluate(() => {
        const w = window as unknown as { __statusLog: string[]; __usbLog: Array<Record<string, unknown>>; __progressBarWasDone: boolean };
        const el = document.querySelector<HTMLElement>(".flash-error");
        const doneEl = document.querySelector<HTMLElement>(".flash-done");
        const progressEl = document.querySelector<HTMLElement>(".flash-progress");
        return {
          errorHidden: el ? el.hidden : null,
          errorText: el ? el.textContent : null,
          statusLog: w.__statusLog || [],
          usbLog: w.__usbLog || [],
          doneHidden: doneEl ? doneEl.hidden : null,
          doneText: doneEl ? doneEl.textContent : null,
          progressHidden: progressEl ? progressEl.hidden : null,
          progressBarHasDoneClass: w.__progressBarWasDone,
        };
      });
      await scenarioPage.close();
      return { ...observed, pageErrors: errors };
    }

    // 1. Nothing plugged in (or the picker cancelled): the message has to
    //    name the fallback, and must not be a stack trace.
    const noDevice = await runScenario("no-device", 400);
    if (noDevice.errorHidden !== false) fail(`no-device path did not surface a visible .flash-error: ${JSON.stringify(noDevice)}`);
    if (!noDevice.errorText || !/no device was selected/i.test(noDevice.errorText) || !/BOOTSEL/i.test(noDevice.errorText)) {
      fail(`expected a no-device message pointing at the BOOTSEL fallback, got: ${JSON.stringify(noDevice.errorText)}`);
    }
    if (noDevice.pageErrors.length > 0) fail(`no-device path threw: ${noDevice.pageErrors.join(" | ")}`);
    const askedFilters = noDevice.usbLog.find((e) => e.op === "requestDevice")?.filters as
      | Array<{ vendorId: number; productId: number }>
      | undefined;
    if (!askedFilters || !askedFilters.some((f) => f.vendorId === 0x2e8a && f.productId === 0x0009)) {
      fail(`the device picker does not offer a RUNNING puck (2E8A:0009), so a running board can never be selected: ${JSON.stringify(askedFilters)}`);
    }
    console.log(`no-device message shown: "${noDevice.errorText}"`);
    console.log(`picker filters include the running puck: ${JSON.stringify(askedFilters)}`);

    // 2. A running board whose firmware predates the reset interface: the
    //    one case where the button ritual is still the answer, and it has
    //    to say which case it is rather than failing as a USB error.
    const noReset = await runScenario("no-reset-interface", 500);
    if (noReset.errorHidden !== false) fail(`old-firmware path did not surface a visible .flash-error: ${JSON.stringify(noReset)}`);
    if (!noReset.errorText || !/reset interface/i.test(noReset.errorText) || !/2026-08-19/.test(noReset.errorText)) {
      fail(`expected an old-firmware message naming the reset interface and the cutoff date, got: ${JSON.stringify(noReset.errorText)}`);
    }
    if (noReset.pageErrors.length > 0) fail(`old-firmware path threw: ${noReset.pageErrors.join(" | ")}`);
    console.log(`old-firmware message shown: "${noReset.errorText}"`);

    // 3. The whole buttonless path, end to end against the fake: claim the
    //    reset interface, send the BOOTSEL control request, notice the
    //    re-enumerated device, flash it.
    // 3500ms: enough for the fake stack's own ~250ms re-enumeration poll
    // PLUS flash-ui.ts's own done-phase beat (FLASH_DONE_HOLD_MS 900 +
    // FLASH_DONE_FADE_MS 400 = 1300ms) to fully play out before this
    // script reads the DOM below.
    const reboot = await runScenario("reboots-and-flashes", 3500);
    if (reboot.pageErrors.length > 0) fail(`running-device path threw: ${reboot.pageErrors.join(" | ")}`);
    if (reboot.errorHidden !== true) fail(`running-device path surfaced an error: ${JSON.stringify(reboot.errorText)}`);

    const control = reboot.usbLog.find((e) => e.op === "controlTransferOut");
    if (!control) fail("the running device was never sent a control transfer: nothing asked it to reboot into BOOTSEL");
    const setup = control!.setup as { requestType: string; recipient: string; request: number; value: number; index: number };
    // The same golden setup site/flasher/flash.test.ts pins as bytes,
    // checked here as it leaves the REAL bundled flash.js.
    if (
      setup.requestType !== "class" ||
      setup.recipient !== "interface" ||
      setup.request !== 0x01 ||
      setup.value !== 0x0000 ||
      setup.index !== 2
    ) {
      fail(`wrong reboot-to-BOOTSEL control setup: ${JSON.stringify(setup)}`);
    }
    const claimedReset = reboot.usbLog.some((e) => e.op === "claim" && e.productId === 0x0009 && e.interfaceNumber === 2);
    if (!claimedReset) fail("the reset interface (number 2) was never claimed before the control transfer");
    const releasedReset = reboot.usbLog.some((e) => e.op === "release" && e.productId === 0x0009 && e.interfaceNumber === 2);
    if (!releasedReset) fail("the reset interface was never released after the control transfer");
    console.log(`reset interface claimed, control setup ${JSON.stringify(setup)}, released`);

    if (!reboot.statusLog.some((s) => /rebooting into BOOTSEL/i.test(s))) {
      fail(`the status line never said the device was being rebooted into BOOTSEL: ${JSON.stringify(reboot.statusLog)}`);
    }
    const finalStatus = reboot.statusLog[reboot.statusLog.length - 1] ?? "";
    if (!/^done:/.test(finalStatus)) {
      fail(`the running-device path did not run through to a finished flash, last status: ${JSON.stringify(reboot.statusLog)}`);
    }
    console.log(`status line walked: ${JSON.stringify(reboot.statusLog)}`);

    // FIX 1: the done phase must render as an unambiguous completed state,
    // not leave the muted "done: Done. The board is rebooting..." log line
    // as the last thing on screen - that's the exact report this fix
    // answers (a real flash that worked, read as "stuck"). Three things,
    // all against the REAL bundled flash-ui.ts, none of them CSS-by-name
    // trust alone: the bar actually turned success-green at some point
    // (the transient .done class, latched by the page-side observer
    // above), the progress block ended up hidden (faded away, not just
    // painted over), and .flash-done itself is visible with the completed
    // sentence and its check glyph - a different, distinctly-styled
    // element from the log line, per site/styles.css's .flash-done rule.
    if (!reboot.progressBarHasDoneClass) {
      fail("the done phase never added the progress bar's success-green \"done\" class - the bar must visibly turn green before it fades");
    }
    console.log("progress bar turned success-green (\"done\" class) on the done phase");
    if (reboot.progressHidden !== true) {
      fail(`the progress block is still visible after the done-phase fade should have finished (progressHidden=${reboot.progressHidden}) - it must fade away, not linger next to the completed banner`);
    }
    console.log("progress block faded away and is hidden, as expected");
    if (reboot.doneHidden !== false) {
      fail(`the completed-state banner (.flash-done) is not visible after a successful flash (doneHidden=${reboot.doneHidden})`);
    }
    if (!reboot.doneText || !/flashed/i.test(reboot.doneText) || !/restart/i.test(reboot.doneText) || !/✓/.test(reboot.doneText)) {
      fail(`expected .flash-done to read a clear completed sentence with a check glyph, got: ${JSON.stringify(reboot.doneText)}`);
    }
    console.log(`completed state shown: "${reboot.doneText}"`);

    // ---- the ESP32-S3 run pages ----------------------------------------
    // Same three questions as the RP2350 page above, against the other
    // board's section: does it render at all, does the unsupported-browser
    // branch produce a sentence rather than an exception, and do the URLs
    // it points at actually resolve. What is NOT here is any equivalent of
    // the fake-USB scenarios: esptool-js drives a Web Serial port through a
    // ROM loader handshake, a RAM stub upload and SLIP framing, and a fake
    // that answered all of that would be a reimplementation of the chip,
    // grading itself. That part is the bench's (see this repo's report and
    // the pack's README).
    const espPage = await browser.newPage();
    const espErrors: string[] = [];
    espPage.on("pageerror", (e) => espErrors.push(String(e)));
    // Web Serial is behind a secure context and is not exposed in every
    // headless build, so the unsupported branch is forced deterministically
    // rather than depending on this Chrome's own answer - exactly the trick
    // used for navigator.usb above.
    await espPage.evaluateOnNewDocument(() => {
      Object.defineProperty(window.navigator, "serial", { value: undefined, configurable: true });
    });

    await espPage.goto(`http://127.0.0.1:${PORT}/run/chrono-esp32.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 500));

    const espSection = await espPage.evaluate(() => {
      const section = document.querySelector<HTMLElement>(".flash-section[data-esp32-manifest]");
      const alt = document.querySelector<HTMLAnchorElement>(".flash-btn-alt");
      const details = document.querySelector("details.flash-ritual");
      return {
        manifest: section?.dataset.esp32Manifest ?? null,
        image: section?.dataset.esp32Image ?? null,
        altHref: alt?.getAttribute("href") ?? null,
        altDownload: alt?.hasAttribute("download") ?? false,
        ritualText: details?.textContent ?? null,
        ritualIntro: details?.querySelector(".flash-ritual-intro")?.textContent ?? null,
        bodyText: document.body.textContent ?? "",
      };
    });
    if (!espSection.manifest) fail("chrono-esp32.html has no .flash-section[data-esp32-manifest]: the flash section did not render");
    if (espSection.image !== "chrono-esp32") {
      fail(`chrono-esp32.html's flash section points at image ${JSON.stringify(espSection.image)}, not "chrono-esp32"`);
    }
    console.log(`esp32 flash section renders on chrono-esp32.html (image ${espSection.image})`);

    if (espSection.altHref !== "../flash/esp32/chrono-esp32.bin" || !espSection.altDownload) {
      fail(`no working .flash-btn-alt download link pointing at ../flash/esp32/chrono-esp32.bin (got ${JSON.stringify(espSection.altHref)})`);
    }
    console.log("download .bin fallback link present and correct");

    if (!espSection.ritualText || !/BOOT/.test(espSection.ritualText)) fail("no ROM download-mode ritual <details> found on the esp32 page");
    if (!espSection.ritualIntro || !/only needed/i.test(espSection.ritualIntro)) {
      fail(`the esp32 ritual fold does not open with its "only needed..." caveat, got: ${JSON.stringify(espSection.ritualIntro)}`);
    }
    console.log(`esp32 ritual fold framed as recovery only: "${espSection.ritualIntro}"`);

    // The old page said browser flashing was waiting on something. It is
    // not waiting on anything any more, and a stale sentence saying so is
    // the exact failure this check exists to catch.
    if (/waits? for silicon|arrives when the firmware is validated|flashing it from a browser does not/i.test(espSection.bodyText)) {
      fail("an esp32 run page still carries a sentence saying browser flashing is unavailable or pending");
    }
    console.log("no stale \"flashing is not available here\" sentence left on the esp32 page");

    const espClicked = await espPage.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(".flash-btn");
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!espClicked) fail("no .flash-btn found to click on the esp32 page");
    await new Promise((r) => setTimeout(r, 400));

    const espError = await espPage.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".flash-error");
      return { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
    });
    if (espError.hidden !== false) fail(`clicking Flash over USB on the esp32 page did not surface a visible .flash-error (state: ${JSON.stringify(espError)})`);
    if (!espError.text || !/web serial/i.test(espError.text)) {
      fail(`expected an unsupported-browser message mentioning Web Serial, got: ${JSON.stringify(espError.text)}`);
    }
    console.log(`esp32 unsupported-browser message shown: "${espError.text}"`);
    if (espErrors.length > 0) {
      fail(`the esp32 page threw instead of rendering a message: ${espErrors.join(" | ")}`);
    }
    console.log("no exceptions thrown on the esp32 page");

    // The artifact index and every image it names have to be reachable from
    // the page's own location, at the size the build recorded. A section
    // that renders while its .bin 404s is worse than no section at all: the
    // failure would land after the human has already picked a port.
    const artifacts = await espPage.evaluate(async () => {
      const section = document.querySelector<HTMLElement>(".flash-section[data-esp32-manifest]")!;
      const manifestUrl = new URL(section.dataset.esp32Manifest!, window.location.href).href;
      const resp = await fetch(manifestUrl);
      if (!resp.ok) return { ok: false, why: `manifest HTTP ${resp.status}`, images: [] as { id: string; ok: boolean; bytes: number; expected: number }[] };
      const manifest = (await resp.json()) as { images: Record<string, { file: string; bytes: number }> };
      const images: { id: string; ok: boolean; bytes: number; expected: number }[] = [];
      for (const [id, image] of Object.entries(manifest.images)) {
        const url = new URL(image.file, manifestUrl).href;
        const r = await fetch(url);
        const bytes = r.ok ? (await r.arrayBuffer()).byteLength : -1;
        images.push({ id, ok: r.ok && bytes === image.bytes, bytes, expected: image.bytes });
      }
      return { ok: true, why: "", images };
    });
    if (!artifacts.ok) fail(`the esp32 artifact index is not reachable from the run page: ${artifacts.why}`);
    if (artifacts.images.length === 0) fail("the esp32 artifact index names no images");
    for (const image of artifacts.images) {
      if (!image.ok) fail(`esp32 artifact ${image.id} did not resolve at the size the index records (${image.bytes} vs ${image.expected})`);
    }
    console.log(`esp32 artifacts resolve: ${artifacts.images.map((i) => `${i.id} (${i.expected} bytes)`).join(", ")}`);

    // The demo combo is the other one the task names by hand, and it has to
    // point at its OWN image, not chrono's.
    await espPage.goto(`http://127.0.0.1:${PORT}/run/esp32-demo.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 300));
    const demoImage = await espPage.evaluate(
      () => document.querySelector<HTMLElement>(".flash-section[data-esp32-manifest]")?.dataset.esp32Image ?? null
    );
    if (demoImage !== "esp32-demo") fail(`esp32-demo.html's flash section points at ${JSON.stringify(demoImage)}, not "esp32-demo"`);
    console.log("esp32-demo.html points at its own image");
    await espPage.close();

    console.log("\nOK: flash UI verified.");
  } finally {
    await closeBrowser(browser);
  }
} finally {
  server.stop(true);
}
}

main().catch((err) => {
  if (!(err instanceof VerifyFailure)) console.error(err);
  process.exitCode = 1;
});
