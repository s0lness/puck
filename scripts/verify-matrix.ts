// scripts/verify-matrix.ts: headless proof that the BUILT matrix page
// (site/dist/matrix/index.html) really is the apps-by-devices matrix
// ledger.json says it is, and that no cell in it is a blank.
//
// It used to be the landing page. docs/decisions/0014 moved it, whole, to
// /matrix/, and put a store of app cards at the front door instead: the
// matrix is the PROOF, and a proof is not a front door. Nothing about what
// this file asserts changed with the move - only where the page is, and the
// fact that every href it emits is now one directory up (site/build.ts's
// MATRIX_DEPTH), which is why fetchOk below resolves against /matrix/ and
// not against the site root.
//
// This is the check the whole "the gallery is built from a ledger" change
// stands or falls on (docs/decisions/0012). The failure it exists to catch
// is not a crash: it is a page that LOOKS like a matrix and quietly drops
// the row nobody would miss. A list of proven ports had exactly one
// representation for "this app was never ported here", "this device has no
// firmware", and "this external bundle's build has been red for a week",
// and that representation was absence. So:
//
//   1. THE GRID IS COMPLETE. One row per app in the ledger, one column per
//      target in it, and rows x columns cells - counted against the ledger,
//      not against a number written here.
//   2b. EVERY SENTENCE IS BEHIND A MARK. The reasons are in the DOM and
//      none of them is laid out until a disclosure is opened, a mark takes
//      keyboard focus and opening it really does show its sentence, and no
//      row stands more than twice as tall as its own thumbnail. Cells that
//      printed their reason inline turned one paragraph into nine copies
//      across a row and buried the pictures the grid exists to show.
//   2. EVERY CELL IS EXACTLY ONE OF THREE THINGS, declared on the cell
//      itself as data-cell and cross-checked against what it actually
//      contains: `runs` (a link to something that opens and runs, and the
//      link resolves), `verdict` (a mark and the sentence behind it, and no
//      link pretending otherwise), or `empty` (says what is missing and
//      links to the procedure for fixing it). A cell that is none of those,
//      or more than one of them, is the blank this check exists to fail on.
//   3. A SILHOUETTE CELL THAT CLAIMS TO RUN ACTUALLY RUNS. Not "links
//      somewhere": the page is opened, the emulator's own canvas is
//      measured, and it must be that silhouette's declared panel size (in
//      either orientation, because a landscape app is presented a quarter
//      turn round). A cell claiming a device it does not render at is worse
//      than an empty cell.
//   4. THE EXTERNAL ROW IS PRESENT, with its provenance sentence, because
//      the whole point of the ledger is that a bundle whose build is red
//      shows up red rather than vanishing.
//   5. THE PAGE DOES NOT SCROLL SIDEWAYS ON A PHONE. The table does, inside
//      its own container. Checked at 390px, the narrowest realistic phone,
//      the same width scripts/verify-site-embeds.ts holds run pages to.
//
// Run with: bun run site:verify-matrix (needs site/dist/ - run
// `bun run site:build` first, which needs ledger.json - run
// `bun run ledger` before that).
import puppeteer, { type Frame, type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";
import type { Ledger } from "../tools/ledger";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53418;
/** Where the matrix lives now, and what every relative href on it resolves against. */
const MATRIX_URL = `http://127.0.0.1:${PORT}/matrix/`;

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

// Resolved against the matrix page's own URL, not against the site root: a
// cell's href is relative to the document that carries it, and reading it as
// root-relative would silently "pass" a link one directory off.
async function fetchOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(new URL(path.split("#")[0]!, MATRIX_URL).toString());
    return r.ok;
  } catch {
    return false;
  }
}

interface ScrapedCell {
  app: string;
  target: string;
  state: string | null;
  /** Every href inside the cell that points at a run page or an app page. */
  runLinks: string[];
  publishLinks: string[];
  chips: string[];
  /** Every reason folded behind a mark in this cell, and whether it is laid out. */
  reasons: { text: string; visible: boolean }[];
  /** Any prose the cell puts in the visible flow: the external row's provenance, a void cell's one line. */
  prose: string[];
  hasLinkedThumb: boolean;
}

const server = serveDist(DIST, PORT);
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ---- 1 & 2: the grid, and what every cell in it is ---------------------
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1700, height: 1200, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => fail(`matrix/index.html page error: ${e instanceof Error ? e.message : String(e)}`));
  await page.goto(MATRIX_URL, { waitUntil: "domcontentloaded" });

  const scraped = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table.matrix tbody tr"));
    const heads = Array.from(document.querySelectorAll("table.matrix thead tr")).pop();
    const targets = heads ? Array.from(heads.querySelectorAll("th.target-head")).map((th) => (th as HTMLElement).dataset.target ?? "") : [];
    return {
      targets,
      rows: rows.map((tr) => ({
        app: (tr.querySelector("th.app-row") as HTMLElement | null)?.dataset.app ?? "",
        provenance: (tr.querySelector(".app-prov")?.textContent ?? "").trim(),
        cells: Array.from(tr.querySelectorAll("td.cell")).map((td) => {
          const el = td as HTMLElement;
          const links = Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
          return {
            target: el.dataset.target ?? "",
            state: el.dataset.cell ?? null,
            runLinks: links.filter((h) => !h.includes("puck-publish")),
            publishLinks: links.filter((h) => h.includes("puck-publish")),
            chips: Array.from(el.querySelectorAll(".chip")).map((c) => (c.textContent ?? "").trim()),
            // getClientRects() rather than a style read: a <details> that is
            // closed lays its own content out nowhere at all, which is
            // exactly the property being asserted, and it stays true however
            // the disclosure is implemented later.
            reasons: Array.from(el.querySelectorAll(".mark-why")).map((w) => ({
              text: (w.textContent ?? "").trim(),
              visible: (w as HTMLElement).getClientRects().length > 0,
            })),
            prose: Array.from(el.querySelectorAll("p")).filter((n) => !n.classList.contains("mark-why")).map((n) => (n.textContent ?? "").trim()),
            hasLinkedThumb: el.querySelector("a.thumb-video, a.thumb-proof") !== null,
          };
        }),
      })),
    };
  });

  const expectedTargets = ledger.targets.map((t) => t.name);
  const expectedApps = ledger.apps.map((a) => a.name);

  if (scraped.targets.join("|") !== expectedTargets.join("|")) {
    fail(`the matrix's columns are [${scraped.targets.join(", ")}], and ledger.json's targets are [${expectedTargets.join(", ")}]`);
  } else {
    pass(`${scraped.targets.length} columns, in ledger.json's own order`);
  }

  const scrapedApps = scraped.rows.map((r) => r.app);
  const missingApps = expectedApps.filter((a) => !scrapedApps.includes(a));
  if (missingApps.length > 0) fail(`ledger.json has ${expectedApps.length} apps and the matrix has no row for: ${missingApps.join(", ")}`);
  else pass(`${scrapedApps.length} rows, one per app in ledger.json`);

  const cells: ScrapedCell[] = [];
  for (const row of scraped.rows) {
    if (row.cells.length !== expectedTargets.length) {
      fail(`row "${row.app}" has ${row.cells.length} cells and there are ${expectedTargets.length} targets`);
    }
    for (const c of row.cells) cells.push({ app: row.app, ...c });
  }
  const expectedCellCount = expectedApps.length * expectedTargets.length;
  if (cells.length !== expectedCellCount) fail(`the matrix has ${cells.length} cells and the ledger has ${expectedCellCount} (${expectedApps.length} apps x ${expectedTargets.length} targets)`);
  else pass(`${cells.length} cells, one per app per target`);

  const STATES = new Set(["runs", "verdict", "empty", "void"]);
  for (const c of cells) {
    const where = `${c.app} x ${c.target}`;
    if (!c.state || !STATES.has(c.state)) {
      fail(`${where}: the cell declares data-cell="${c.state ?? "(none)"}", which is not one of runs/verdict/empty/void`);
      continue;
    }
    const ledgerCell = ledger.cells[`${c.app}:${c.target}`];
    if (!ledgerCell) {
      fail(`${where}: the page has a cell the ledger does not`);
      continue;
    }

    // The three-way exclusivity: a cell that runs has a link and no "how to
    // port it"; a cell that does not has the sentence and no link claiming
    // it runs.
    if (c.state === "runs") {
      if (c.runLinks.length === 0) fail(`${where}: declares itself a running cell and carries no link to anything`);
      if (c.publishLinks.length > 0) fail(`${where}: declares itself a running cell AND links to the porting procedure`);
      for (const href of c.runLinks) {
        if (!(await fetchOk(href))) fail(`${where}: its link 404s (${href})`);
      }
    } else {
      if (c.hasLinkedThumb) fail(`${where}: declares itself "${c.state}" and still carries a clickable thumbnail`);
      // A cell that does not run has to say why. "Why" is now a reason
      // folded behind a mark, or - for the two cells that carry a fact
      // rather than a reason - one short line of prose: the external row's
      // provenance, and a column that is not this app's target.
      const saysWhy = c.reasons.some((r) => r.text.length > 0) || c.prose.some((t) => t.length > 0);
      if (!saysWhy) fail(`${where}: declares itself "${c.state}" and says nothing about why, behind a mark or otherwise`);
    }
    if (c.state === "empty") {
      if (c.publishLinks.length === 0) fail(`${where}: an empty cell must link to the porting procedure`);
      if (c.chips.length === 0) fail(`${where}: an empty cell must carry the mechanical verdict`);
      if (ledgerCell.port) fail(`${where}: the page says no port and the ledger records one`);
      // The procedure has to be there, not just pointed at: an empty state
      // whose one link 404s is a shrug with extra steps.
      for (const href of c.publishLinks) {
        if (!(await fetchOk(href))) fail(`${where}: its link to the porting procedure 404s (${href})`);
      }
    }
    if (c.state === "runs" && ledgerCell.targetKind === "pack" && !ledgerCell.port) {
      fail(`${where}: the page says this runs and the ledger records no port for it`);
    }
    if (c.state === "runs" && ledgerCell.targetKind === "silhouette" && ledgerCell.silhouette.mark !== "runs") {
      fail(`${where}: the page says this runs and the ledger's silhouette mark is "${ledgerCell.silhouette.mark}"`);
    }
  }
  if (failures === 0) pass("every cell is exactly one of: runs (with a link that resolves), a verdict with its reason, or an empty state pointing at the procedure");

  // ---- 2b: every sentence is behind a mark, not in the row ---------------
  // THE REGRESSION THIS EXISTS FOR: every cell used to print its own reason
  // paragraph inline, so the same sentence appeared across nine columns, a
  // row stood three times taller than the thumbnail it was built around, and
  // the intro's promise (hover a mark for the sentence behind it) was not
  // what the page did. The sentences have to still BE there - nothing may be
  // lost to make the grid tidy - and they have to be out of the visible flow
  // until somebody asks.
  const allReasons = cells.flatMap((c) => c.reasons.map((r) => ({ ...r, where: `${c.app} x ${c.target}` })));
  if (allReasons.length === 0) {
    fail("not one mark on the page folds a reason behind it: either the reasons are gone, or they are still in the row");
  } else {
    const laidOut = allReasons.filter((r) => r.visible);
    if (laidOut.length > 0) {
      fail(`${laidOut.length} of ${allReasons.length} folded reasons are in the visible flow with nothing opened (first: ${laidOut[0]!.where})`);
    } else {
      pass(`${allReasons.length} reasons are in the DOM and none of them is laid out until a mark is opened`);
    }
    const empty = allReasons.filter((r) => r.text.length === 0);
    if (empty.length > 0) fail(`${empty.length} folded reason(s) are empty, so a mark exists with nothing behind it (first: ${empty[0]!.where})`);
  }

  // And they must be reachable: a disclosure that only a pointer can open is
  // a title attribute with extra steps. Opening one by keyboard is the test.
  const opened = await page.evaluate(() => {
    const details = document.querySelector("table.matrix .mark") as HTMLDetailsElement | null;
    if (!details) return null;
    const summary = details.querySelector("summary") as HTMLElement | null;
    if (!summary) return null;
    summary.focus();
    const focused = document.activeElement === summary;
    details.open = true;
    const why = details.querySelector(".mark-why") as HTMLElement | null;
    const shown = why ? why.getClientRects().length > 0 : false;
    details.open = false;
    return { focused, shown };
  });
  if (!opened) fail("there is no .mark disclosure in the table at all");
  else if (!opened.focused) fail("a mark's own summary does not take focus, so its sentence is unreachable by keyboard");
  else if (!opened.shown) fail("opening a mark does not lay its sentence out, so the disclosure hides it for good");
  else pass("a mark takes keyboard focus and opening it lays its sentence out");

  // The whole point of compacting: a row should be about as tall as the
  // thumbnail it is built around, not three times that.
  const tallest = await page.evaluate(() => {
    let worst = { app: "", ratio: 0, row: 0, thumb: 0 };
    for (const tr of Array.from(document.querySelectorAll("table.matrix tbody tr"))) {
      const app = (tr.querySelector("th.app-row") as HTMLElement | null)?.dataset.app ?? "";
      const rowH = (tr as HTMLElement).getBoundingClientRect().height;
      const thumbs = Array.from(tr.querySelectorAll("video, img.proof-img")).map((n) => n.getBoundingClientRect().height);
      const thumbH = thumbs.length ? Math.max(...thumbs) : 0;
      if (thumbH > 0 && rowH / thumbH > worst.ratio) worst = { app, ratio: rowH / thumbH, row: rowH, thumb: thumbH };
    }
    return worst;
  });
  if (tallest.ratio > 2) {
    fail(`row "${tallest.app}" is ${tallest.row.toFixed(0)}px tall around a ${tallest.thumb.toFixed(0)}px thumbnail (${tallest.ratio.toFixed(1)}x): the cells are still printing their reasons`);
  } else {
    pass(`the tallest row is ${tallest.ratio.toFixed(1)}x its own thumbnail ("${tallest.app}", ${tallest.row.toFixed(0)}px around ${tallest.thumb.toFixed(0)}px)`);
  }

  // ---- 4: the external row, with its provenance -------------------------
  for (const app of ledger.apps.filter((a) => a.kind !== "local")) {
    const row = scraped.rows.find((r) => r.app === app.name);
    if (!row) {
      fail(`the matrix has no row for the external bundle "${app.name}"`);
      continue;
    }
    if (!app.provenance) {
      fail(`ledger.json records no provenance for "${app.name}", so the row cannot state where it was reproduced from`);
      continue;
    }
    if (row.provenance.replace(/\s+/g, " ") !== app.provenance.replace(/\s+/g, " ")) {
      fail(`"${app.name}"'s row says "${row.provenance}" and the ledger says "${app.provenance}"`);
    } else {
      pass(`the external row states its provenance: ${row.provenance}`);
    }
    const declared = Object.values(ledger.cells).filter((c) => c.app === app.name && c.port);
    for (const cell of declared) {
      const scrapedCell = cells.find((c) => c.app === app.name && c.target === cell.target);
      if (!scrapedCell) continue;
      const carriesReason = scrapedCell.reasons.some((r) => r.text.length > 0);
      if (cell.emulator.mark !== "PASS" && !carriesReason) {
        fail(`"${app.name}" x ${cell.target}: the ledger says ${cell.emulator.mark} and the cell folds no reason behind its mark`);
      } else {
        pass(`"${app.name}" x ${cell.target}: ${cell.emulator.mark}, with its reason behind the mark on the page`);
      }
    }
  }

  // ---- 5: a phone scrolls the table, never the page ---------------------
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await wait(300);
  const scroll = await page.evaluate(() => ({
    page: document.scrollingElement!.scrollWidth,
    inner: window.innerWidth,
    container: (() => {
      const el = document.querySelector(".matrix-scroll") as HTMLElement | null;
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    })(),
  }));
  if (scroll.page > scroll.inner) fail(`at 390px the PAGE scrolls sideways (${scroll.page} > ${scroll.inner}): the table must scroll inside its own container, not move the page`);
  else pass(`at 390px the page does not scroll sideways (${scroll.page} = ${scroll.inner})`);
  if (!scroll.container) fail("there is no .matrix-scroll container for the table to scroll inside");
  else if (scroll.container.scrollWidth <= scroll.container.clientWidth) fail(`at 390px the table fits its container (${scroll.container.scrollWidth} <= ${scroll.container.clientWidth}), which means the columns collapsed rather than scrolled`);
  else pass(`at 390px the table scrolls inside its own container (${scroll.container.scrollWidth} > ${scroll.container.clientWidth})`);

  await page.close();

  // ---- 3: a silhouette cell that claims to run, actually runs -----------
  const silhouetteCells = cells.filter((c) => {
    const target = ledger.targets.find((t) => t.name === c.target);
    return target?.kind === "silhouette" && c.state === "runs";
  });
  if (silhouetteCells.length === 0) fail("no silhouette cell on the page claims to run, so there is nothing here to prove");
  console.log(`\nopening ${silhouetteCells.length} silhouette cell(s) that claim to run`);

  for (const c of silhouetteCells) {
    const target = ledger.targets.find((t) => t.name === c.target)!;
    const panel = target.panel;
    const href = c.runLinks.find((h) => h.includes("run/")) ?? c.runLinks[0];
    if (!href || !panel) {
      fail(`${c.app} x ${c.target}: no run-page link, or the ledger's target declares no panel`);
      continue;
    }
    const runPage = await browser.newPage();
    const errors: string[] = [];
    runPage.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await runPage.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1 });
    await runPage.goto(new URL(href, MATRIX_URL).toString(), { waitUntil: "domcontentloaded" });
    await wait(2500);

    // The emulator runs inside the run page's own iframe, and #panel is the
    // canvas it blits the device's framebuffer onto (src/main.ts). Its
    // width and height in device pixels ARE the panel this module declared,
    // which is the only thing that proves the cell is not linking to some
    // other device's page.
    const emu: Frame | undefined = runPage.frames().find((f) => f.url().includes("/emu/"));
    if (!emu) {
      fail(`${c.app} x ${c.target}: ${href} embeds no emulator frame`);
      await runPage.close();
      continue;
    }
    const measured = await emu.evaluate(() => {
      const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      return canvas ? { w: canvas.width, h: canvas.height } : null;
    });
    if (!measured) {
      fail(`${c.app} x ${c.target}: ${href}'s emulator painted no canvas#panel`);
    } else if ((measured.w === panel.w && measured.h === panel.h) || (measured.w === panel.h && measured.h === panel.w)) {
      pass(`${c.app} x ${c.target}: ${href} runs at ${measured.w}x${measured.h}, which is ${target.label}'s own ${panel.w}x${panel.h}`);
    } else {
      fail(`${c.app} x ${c.target}: ${href} paints a ${measured.w}x${measured.h} panel, and ${target.label}'s device.json declares ${panel.w}x${panel.h}`);
    }
    if (errors.length > 0) fail(`${c.app} x ${c.target}: ${href} threw: ${errors[0]}`);
    await runPage.close();
  }
} finally {
  server.stop(true);
  if (browser) await closeBrowser(browser);
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed - see above`);
  process.exit(1);
}
console.log(`\nPASS: /matrix/ is ledger.json's matrix, every cell says what it is, and every silhouette cell that claims to run opens at that board's own panel size`);
