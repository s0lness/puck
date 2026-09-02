// scripts/verify-matrix.ts: headless proof that the BUILT landing page
// (site/dist/index.html) really is the apps-by-devices matrix ledger.json
// says it is, and that no cell in it is a blank.
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

async function fetchOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${path.replace(/^\/+/, "").split("#")[0]}`);
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
  why: string;
  hasLinkedThumb: boolean;
}

const server = serveDist(DIST, PORT);
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ---- 1 & 2: the grid, and what every cell in it is ---------------------
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1700, height: 1200, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => fail(`index.html page error: ${e instanceof Error ? e.message : String(e)}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

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
            runLinks: links.filter((h) => !h.startsWith("puck-publish")),
            publishLinks: links.filter((h) => h.startsWith("puck-publish")),
            chips: Array.from(el.querySelectorAll(".chip")).map((c) => (c.textContent ?? "").trim()),
            why: (el.querySelector(".cell-why")?.textContent ?? "").trim(),
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
      if (c.why.length === 0) fail(`${where}: declares itself "${c.state}" and says nothing about why`);
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
      if (cell.emulator.mark !== "PASS" && scrapedCell.why.length === 0) {
        fail(`"${app.name}" x ${cell.target}: the ledger says ${cell.emulator.mark} and the cell prints no reason`);
      } else {
        pass(`"${app.name}" x ${cell.target}: ${cell.emulator.mark}, with its reason on the page`);
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
    const href = c.runLinks.find((h) => h.startsWith("run/")) ?? c.runLinks[0];
    if (!href || !panel) {
      fail(`${c.app} x ${c.target}: no run-page link, or the ledger's target declares no panel`);
      continue;
    }
    const runPage = await browser.newPage();
    const errors: string[] = [];
    runPage.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await runPage.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1 });
    await runPage.goto(`http://127.0.0.1:${PORT}/${href}`, { waitUntil: "domcontentloaded" });
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
console.log(`\nPASS: the landing page is ledger.json's matrix, every cell says what it is, and every silhouette cell that claims to run opens at that board's own panel size`);
