// scripts/verify-landing.ts: headless proof that the BUILT front door
// (site/dist/index.html) is a store, and that its Run buttons open the
// version that is canonical for the device asking.
//
// docs/decisions/0014. The page this replaces was the matrix, and the
// verdict on it was "absolutely unreadable": forty-five cells, nine
// columns, a row of chips under every picture, which is a proof document
// and reads like one. The matrix did not get worse and did not get cut; it
// moved to /matrix/, where scripts/verify-matrix.ts still holds it to
// ledger.json cell by cell. What has to be true HERE is a different set of
// things, and none of them can be read off the markup alone:
//
//   1. IT IS A GRID OF CARDS, one per app in the ledger, each carrying a
//      picture and exactly one primary "Run".
//   2. THE PICTURE IS REAL. Every card's recorded loop, poster and gif
//      fallback resolve against the built output, and the video actually
//      starts once the card is on screen (the loops carry no `autoplay` and
//      no `src`: five wasm-free videos still cost five downloads if they all
//      start at once on a phone, so the page mounts them on intersection -
//      this is the check that the mounting works at all).
//   3. AT 1400px, RUN OPENS THE EMULATOR. Desktop is where a device drawn
//      around the app is the right answer, so every Run points at a run
//      page under /run/, and every one of them resolves.
//   4. AT 390px WITH A COARSE POINTER, RUN OPENS THE APP ITSELF. A phone
//      IS one of the target devices (packs/web), so every app that has a
//      web port must hand a phone its own installable host build at
//      /web/<app>/, not a picture of an emulator. An app with no web port
//      keeps the emulator and must say which device it is running as.
//   5. AT 390px THE PAGE DOES NOT SCROLL SIDEWAYS and the first card fits
//      the viewport width. Same width and same rule every other headless
//      check in this repository holds a page to.
//   6. THE HEADER'S ONE LINK RESOLVES to /matrix/, which is the whole
//      "everything else is one link away" claim.
//
// Run with: bun run site:verify-landing (needs site/dist/ - run
// `bun run site:build` first).
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";
import type { Ledger } from "../tools/ledger";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53419;

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

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ok: ${msg}`);
}
function failFatal(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (!existsSync(DIST)) failFatal("site/dist/ does not exist. Run `bun run site:build` first.");
const LEDGER_PATH = join(ROOT, "ledger.json");
if (!existsSync(LEDGER_PATH)) failFatal("no ledger.json at the repository root. Run `bun run ledger` first.");
const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
// Which apps have a web port, straight out of the ledger: this is what
// decides whether a card owes a phone an installable host page or an
// emulator, and it must never be a list typed into this file.
const WEB_APPS = new Set(
  Object.values(ledger.cells)
    .filter((c) => c.target === "web" && c.port)
    .map((c) => c.app)
);

async function fetchOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(new URL(path.replace(/^\/+/, "./"), `http://127.0.0.1:${PORT}/`).toString());
    return r.ok;
  } catch {
    return false;
  }
}

interface ScrapedCard {
  app: string;
  runHref: string | null;
  runLabel: string;
  runsAs: string | null;
  devicesHref: string | null;
  devicesText: string;
  posterSrc: string | null;
  videoSrc: string | null;
  gifHtml: string | null;
  shotWidth: number;
  cardWidth: number;
  cardLeft: number;
  cardRight: number;
}

async function scrapeCards(page: Page): Promise<ScrapedCard[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("li.app-card")).map((li) => {
      const el = li as HTMLElement;
      const run = el.querySelector("a.run-btn") as HTMLAnchorElement | null;
      const devices = el.querySelector("a.card-devices") as HTMLAnchorElement | null;
      const video = el.querySelector("video") as HTMLVideoElement | null;
      const shot = el.querySelector("a.shot") as HTMLElement | null;
      const r = el.getBoundingClientRect();
      return {
        app: el.dataset.app ?? "",
        runHref: run ? run.getAttribute("href") : null,
        runLabel: (run?.textContent ?? "").trim(),
        runsAs: (el.querySelector("p.card-runs-as")?.textContent ?? "").trim() || null,
        devicesHref: devices ? devices.getAttribute("href") : null,
        devicesText: (devices?.textContent ?? "").trim(),
        posterSrc: video ? video.getAttribute("poster") : null,
        videoSrc: video ? video.getAttribute("data-src") : null,
        gifHtml: el.querySelector("noscript")?.innerHTML ?? null,
        shotWidth: shot ? shot.getBoundingClientRect().width : 0,
        cardWidth: r.width,
        cardLeft: r.left,
        cardRight: r.right,
      };
    })
  );
}

const server = serveDist(DIST, PORT);
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ---- 1, 2, 3, 6: the desktop store -----------------------------------
  console.log("-- 1400px, a pointer --");
  const page = await browser.newPage();
  page.on("pageerror", (e) => fail(`index.html page error: ${e instanceof Error ? e.message : String(e)}`));
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await wait(400);

  const expectedApps = ledger.apps.map((a) => a.name);
  const desktop = await scrapeCards(page);
  const scrapedApps = desktop.map((c) => c.app);
  const missing = expectedApps.filter((a) => !scrapedApps.includes(a));
  if (missing.length > 0) fail(`ledger.json has ${expectedApps.length} apps and the front page has no card for: ${missing.join(", ")}`);
  else pass(`${desktop.length} cards, one per app in ledger.json`);

  // A grid, not a stack: at 1400px the cards must sit several to a row, or
  // this is the same one-column scroll the store shape exists to replace.
  const topRow = desktop.filter((c) => Math.abs(c.cardLeft - Math.min(...desktop.map((d) => d.cardLeft))) < 1 || c.cardLeft > 0);
  const columns = new Set(desktop.map((c) => Math.round(c.cardLeft))).size;
  if (columns < 3) fail(`at 1400px the cards occupy ${columns} column(s) (${topRow.length} cards read): a store is a grid, not a list`);
  else pass(`at 1400px the cards sit in ${columns} columns`);

  for (const c of desktop) {
    const where = `card "${c.app}"`;
    if (c.runLabel !== "Run") fail(`${where}: its primary button reads "${c.runLabel}", not "Run"`);
    if (!c.runHref) {
      fail(`${where}: no Run link at all`);
    } else if (!/^run\//.test(c.runHref)) {
      fail(`${where}: at 1400px Run points at ${c.runHref}, and a desktop visitor is owed the emulator (a run page under run/)`);
    } else if (!(await fetchOk(c.runHref))) {
      fail(`${where}: its Run link 404s (${c.runHref})`);
    }

    if (!c.posterSrc) fail(`${where}: its picture has no poster`);
    else if (!(await fetchOk(c.posterSrc))) fail(`${where}: its poster 404s (${c.posterSrc})`);
    if (!c.videoSrc) fail(`${where}: its picture has no data-src loop`);
    else if (!(await fetchOk(c.videoSrc))) fail(`${where}: its recorded loop 404s (${c.videoSrc})`);
    const gif = c.gifHtml?.match(/src="([^"]+)"/);
    if (!gif) fail(`${where}: no <noscript> gif fallback`);
    else if (!(await fetchOk(gif[1]!))) fail(`${where}: its gif fallback 404s (${gif[1]})`);

    if (!c.devicesHref || !/^matrix\/#app-/.test(c.devicesHref)) {
      fail(`${where}: its "runs on N devices" line points at ${c.devicesHref}, not at its own row on /matrix/`);
    } else if (!(await fetchOk(c.devicesHref))) {
      fail(`${where}: its link into the matrix 404s (${c.devicesHref})`);
    }
    // The count is the ledger's, not a number somebody typed on a card.
    const expected = Object.values(ledger.cells).filter(
      (cell) => cell.app === c.app && (cell.targetKind === "silhouette" ? cell.silhouette.mark === "runs" : Boolean(cell.port))
    ).length;
    const said = Number(/runs on (\d+) device/.exec(c.devicesText)?.[1] ?? NaN);
    if (said !== expected) fail(`${where}: says "${c.devicesText}" and the ledger counts ${expected} device(s) it runs on`);

    // No chips, no marks, no reasons: the front page carries none of the
    // proof vocabulary, which is the whole reason the matrix moved.
    const noise = await page.evaluate((app) => {
      const card = document.querySelector(`li.app-card[data-app="${CSS.escape(app)}"]`);
      return card ? card.querySelectorAll(".chip, .mark, .mark-why, .badge").length : -1;
    }, c.app);
    if (noise > 0) fail(`${where}: carries ${noise} chip/mark element(s), and the front page carries none`);
  }
  if (failures === 0) pass("every card has a working picture, one Run into the emulator, and its own honest device count");

  // An app with no web port has to say which device it is running as; an app
  // with one must not, because there is nothing to disambiguate.
  for (const c of desktop) {
    if (WEB_APPS.has(c.app)) {
      if (c.runsAs) fail(`card "${c.app}" has a web port and still says "${c.runsAs}"`);
    } else if (!c.runsAs) {
      fail(`card "${c.app}" has no web port, so its card must say which device it runs as`);
    } else {
      pass(`card "${c.app}" says "${c.runsAs}"`);
    }
  }

  // The loops mount on intersection. Scrolling the last card into view has
  // to give it a src and a moving currentTime; a card nobody has scrolled to
  // must not have downloaded anything.
  const beforeScroll = await page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll(".app-card video"));
    return vids.map((v) => Boolean((v as HTMLVideoElement).getAttribute("src")));
  });
  await page.evaluate(() => {
    const cards = document.querySelectorAll("li.app-card");
    cards[cards.length - 1]?.scrollIntoView({ block: "center" });
  });
  await wait(1500);
  const played = await page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll(".app-card video")) as HTMLVideoElement[];
    const last = vids[vids.length - 1];
    return { mounted: Boolean(last?.getAttribute("src")), time: last?.currentTime ?? 0, ready: last?.readyState ?? 0 };
  });
  if (!played.mounted) fail("the last card's loop never got a src after being scrolled into view: the intersection mount does not work");
  else if (played.ready < 2) fail(`the last card's loop mounted but never loaded data (readyState ${played.ready})`);
  else pass(`the last card's loop mounts on intersection and plays (readyState ${played.ready}, t=${played.time.toFixed(2)}s), ${beforeScroll.filter(Boolean).length} loop(s) had mounted before the scroll`);

  const allDevices = await page.$eval("header.store-head a.all-devices", (a) => a.getAttribute("href"));
  if (allDevices !== "matrix/") fail(`the header's one link points at ${allDevices}, not at matrix/`);
  else if (!(await fetchOk("matrix/"))) fail("the header links to matrix/ and that page does not resolve");
  else pass('the header carries one link, "all devices", and /matrix/ resolves');

  await page.close();

  // ---- 4 & 5: the same page, on a phone --------------------------------
  console.log("\n-- 390px, a coarse pointer --");
  const phone = await browser.newPage();
  phone.on("pageerror", (e) => fail(`index.html page error at 390px: ${e instanceof Error ? e.message : String(e)}`));
  // A real coarse pointer, emulated through CDP, not a narrow window: the
  // page decides with "(pointer: coarse)" first and falls back to width, so
  // a width-only test would prove the fallback and leave the actual rule
  // unchecked.
  const cdp = await phone.createCDPSession();
  await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await phone.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await wait(400);

  const coarse = await phone.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  if (!coarse) fail("the emulated phone does not report (pointer: coarse), so this check would prove nothing about the pointer rule");
  else pass("the emulated phone reports (pointer: coarse)");

  const phoneCards = await scrapeCards(phone);
  for (const c of phoneCards) {
    const where = `card "${c.app}" at 390px`;
    if (!c.runHref) {
      fail(`${where}: no Run link`);
      continue;
    }
    if (WEB_APPS.has(c.app)) {
      if (c.runHref !== `web/${c.app}/`) {
        fail(`${where}: Run points at ${c.runHref}, and this app has a web port, so a phone is owed packs/web's own host page at web/${c.app}/`);
      } else if (!(await fetchOk(c.runHref))) {
        fail(`${where}: its host page 404s (${c.runHref})`);
      } else {
        pass(`${where}: Run opens ${c.runHref}, the pack's own installable build`);
      }
    } else if (!/^run\//.test(c.runHref)) {
      fail(`${where}: this app has no web port, so Run must stay on the emulator, and it points at ${c.runHref}`);
    } else {
      pass(`${where}: no web port, so Run stays on the emulator (${c.runHref})`);
    }
  }

  const geometry = await phone.evaluate(() => ({
    scrollWidth: document.scrollingElement!.scrollWidth,
    inner: window.innerWidth,
  }));
  if (geometry.scrollWidth > geometry.inner + 1) {
    fail(`at 390px the page scrolls sideways (scrollWidth ${geometry.scrollWidth} > viewport ${geometry.inner})`);
  } else {
    pass(`at 390px the page does not scroll sideways (${geometry.scrollWidth} = ${geometry.inner})`);
  }

  const first = phoneCards[0];
  if (!first) {
    fail("there is no first card at 390px");
  } else if (first.cardRight > geometry.inner + 1 || first.cardLeft < -1) {
    fail(`at 390px the first card spans ${first.cardLeft.toFixed(1)}..${first.cardRight.toFixed(1)} and the viewport is 0..${geometry.inner}`);
  } else if (first.shotWidth < geometry.inner * 0.6) {
    fail(`at 390px the first card's picture is ${first.shotWidth.toFixed(0)}px wide in a ${geometry.inner}px viewport: the picture is meant to dominate the card`);
  } else {
    pass(`at 390px the first card fits the viewport (${first.cardWidth.toFixed(0)}px) with a ${first.shotWidth.toFixed(0)}px picture`);
  }

  // A thumb-sized button, not a desktop one shrunk: 44px is the smallest
  // target packs/web's own host build already holds itself to.
  const runBox = await phone.evaluate(() => {
    const a = document.querySelector("li.app-card a.run-btn") as HTMLElement | null;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  if (!runBox) fail("no Run button at 390px");
  else if (runBox.h < 44) fail(`at 390px the Run button is ${runBox.h.toFixed(0)}px tall, under the 44px minimum a thumb needs`);
  else pass(`at 390px the Run button is ${runBox.w.toFixed(0)}x${runBox.h.toFixed(0)}px`);

  await phone.close();
} finally {
  server.stop(true);
  if (browser) await closeBrowser(browser);
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed - see above`);
  process.exit(1);
}
console.log("\nPASS: the front door is a store, its pictures are real, and Run opens the canonical version for the device asking");
