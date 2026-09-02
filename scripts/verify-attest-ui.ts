// scripts/verify-attest-ui.ts: headless proof that the "Prove it runs"
// section on a real flash page walks all the way from a board to a posted
// attestation, with no board and no Cloudflare account anywhere.
//
//   bun run site:verify-attest-ui
//
// Same shape as scripts/verify-flash-ui.ts next door: the built site/dist/
// on a local static server (scripts/staticSite.ts), puppeteer-core against a
// local Chrome install, no bundled Chromium download. Two stubs, both
// installed before any page script runs, and both the deliberate opposite of
// a mock of our own code - the REAL bundled attest.js drives them:
//
//   navigator.serial  a scripted devlink board (the same wire protocol
//                     test/devlink/run.ts drives, re-stated in the page
//                     because a page-side stub cannot import a module) whose
//                     SHOT reply is built from THIS repository's own recorded
//                     reference frame, decoded here in bun and handed to the
//                     page as the grey bytes a real board's SHOT would carry.
//                     That is what makes a MATCH verdict mean something: the
//                     page's own decode, replay and pixel comparison have to
//                     recover exactly the frame the bundle recorded.
//
//   /api/attest       a puppeteer request route, which is why nothing here
//                     needs a Pages Function, a KV namespace or a network.
//                     The POST body is captured and asserted against the
//                     documented shape (site/attest/plan.ts's AttestPost).
//
// BOTH KINDS OF CHECK, and the invariants half is scripted the same honest
// way the pixel-exact half is. Its frames are not drawn here: they come
// from replaying that port's own trace against that port's own built module
// (site/dist/modules/<combo>.wasm) and converting each captured frame to
// the greyscale bytes a devlink SHOT carries, exactly as the pixel-exact
// half converts a recorded PNG. So a PASS here means fluidbox's own
// thresholds held on frames that survived the round trip through the page's
// RLE decode and grey-to-RGB expansion - which is a real fact about this
// port worth knowing, since a board answers SHOT in GREY and a checker that
// read colour would have nothing to read.
//
// WHAT THIS CANNOT PROVE, said here rather than discovered later: that a real
// board answers devlink the way this stub does. That is the bench's job, and
// packs/rp2350-touch-amoled-18/AGENTS.md says so. What it proves is
// everything on this side of the wire: the plan is emitted and reachable, the
// recorded frames are reachable and decode to the right bytes in a browser,
// the replay drives the protocol, the comparison runs at tolerance zero, the
// per-point MATCH/DIVERGE and the verdict render, and the POST carries
// exactly the fields it claims and nothing about the person.
//
// The DIVERGE half is not optional: a check that can only ever come back
// green is worth nothing, so the second scenario feeds the page a board
// drawing one pixel differently and demands the verdict say so.
import puppeteer, { type HTTPRequest } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";
import { decodeRGBPNG } from "../harness/png";
import { replayEmulator } from "../harness/emulatorSide";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53412;
const COMBO = "chrono-rp2350";

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

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST)) fail(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

// ---- what the scripted board will show --------------------------------
//
// Not an invented picture: the bundle's OWN recorded frames, read back
// through the same decoder tools/verify-bundle.ts uses, and turned into the
// greyscale bytes a devlink SHOT carries. The inverse of what the page does
// with them, so a MATCH is a real round trip through the page's decoder,
// its RLE decode, its grey-to-RGB expansion and its pixel comparison.
//
// The grey byte is the panel's own 6-bit green channel shifted up by two
// (packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h's px_to_gray), so
// from a recorded RGB triple it is recovered from the green channel exactly:
// g8 = (g6<<2)|(g6>>4), so g6 = g8>>2, and the SHOT byte is g6<<2.
interface PlanShape {
  combo: string;
  app: string;
  pack: string;
  kind: "pixel-exact" | "invariants";
  boardFamily: string;
  artifact: string;
  framesBase?: string;
  checker?: string;
  device?: { name?: string; panel: { w: number; h: number } };
  dataTerminalReady: boolean;
  traces: { name: string; events: unknown[]; points?: { atMs: number; frame: string }[]; captureAt?: number[] }[];
}

function readPlan(combo: string): PlanShape {
  const path = join(DIST, "attest", `${combo}.json`);
  if (!existsSync(path)) fail(`site/dist/attest/${combo}.json is missing: site/build.ts did not emit an attestation plan for it.`);
  return JSON.parse(readFileSync(path, "utf8")) as PlanShape;
}

const plan = readPlan(COMBO);
if (plan.kind !== "pixel-exact") fail(`${COMBO}'s plan is ${plan.kind}, but this scenario is the pixel-exact one`);

function greyFromRecordedFrame(file: string): { width: number; height: number; grey: number[] } {
  const png = decodeRGBPNG(new Uint8Array(readFileSync(join(DIST, "attest", COMBO, file))));
  const grey: number[] = [];
  for (let i = 0; i < png.width * png.height; i++) {
    const g8 = png.rgb[i * 3 + 1]!;
    grey.push((g8 >> 2) << 2);
  }
  return { width: png.width, height: png.height, grey };
}

// Every capture point's frame, in the order replayHardware will ask for
// them: trace by trace, point by point, sorted by time. The scripted board
// answers the Nth SHOT with the Nth frame, which is a second thing this
// proves for free - a page that captured in the wrong order, or captured
// one screen four times, would come back with three divergences rather
// than a green run.
const frameFiles = plan.traces.flatMap((t) => t.points!.map((p) => p.frame));
const frames = frameFiles.map(greyFromRecordedFrame);
const board = { width: frames[0]!.width, height: frames[0]!.height, greys: frames.map((f) => f.grey), appName: "chrono" };
console.log(
  `scripted board will show, in order: ${frameFiles.join(", ")} (${board.width}x${board.height}), each decoded from the bundle's own recorded frame`
);

const totalPoints = plan.traces.reduce((n, t) => n + t.points!.length, 0);

// ---- and what an INVARIANTS board will show ----------------------------
//
// The same trick pointed at a port with no recorded frames: replay that
// port's own trace against that port's own built module, capture at the
// bundle's own captureAt, and hand the page the grey bytes a SHOT would
// carry. This is not the emulator standing in for a board - the page still
// has to decode, expand and check them itself, and the checker it runs is
// the bundle's, not this file's.
async function invariantsBoard(planned: PlanShape): Promise<{ width: number; height: number; greys: number[][]; appName: string }> {
  const tracePath = join(ROOT, "apps", planned.app, "traces");
  void tracePath;
  const modulePath = join(DIST, "modules", `${planned.combo}.wasm`);
  if (!existsSync(modulePath)) fail(`site/dist/modules/${planned.combo}.wasm is missing: run \`bun run site:build\` first.`);
  const greys: number[][] = [];
  let width = 0;
  let height = 0;
  for (const trace of planned.traces) {
    const replay = await replayEmulator(modulePath, trace.events as never, trace.captureAt!, {});
    for (const atMs of trace.captureAt!) {
      const captured = replay.frames.find((f) => f.atMs === atMs);
      if (!captured) fail(`${planned.combo}: the emulator produced no frame at ${atMs}ms, so this scenario has nothing to script the board with`);
      const { width: w, height: h, rgb } = captured!.frame;
      width = w;
      height = h;
      const grey: number[] = [];
      for (let i = 0; i < w * h; i++) grey.push((rgb[i * 3 + 1]! >> 2) << 2);
      greys.push(grey);
    }
  }
  return { width, height, greys, appName: planned.app };
}

// ---------------------------------------------------------------------

interface ScenarioResult {
  verdictText: string | null;
  verdictClass: string | null;
  points: { mark: string; label: string; detail: string }[];
  errorHidden: boolean | null;
  errorText: string | null;
  postVisible: boolean;
  postedText: string | null;
  posted: unknown;
  pageErrors: string[];
  statusLog: string[];
  counterText: string | null;
}

/** One board, one page, one press of the button. */
interface Scenario {
  combo: string;
  app: string;
  pack: string;
  board: { width: number; height: number; greys: number[][]; appName: string };
  /** Nudge this frame by one grey level (the smallest thing tolerance zero must catch). -1 for none. */
  shiftFrame: number;
  /** Serve an EARLIER frame in place of this one, which is how a behavioural invariant is broken without inventing a picture. */
  substitute?: { at: number; with: number };
  /** Bytes per enqueue on the scripted port. Small values put the page's line reassembly under test; a fluid frame RLEs to megabytes of base64 and does not need it done a second time. */
  chunkBytes: number;
  /** Press "Post this result" when the run offers it. False when the point of the scenario is that nothing is posted. */
  postIt: boolean;
}

const server = serveDist(DIST, PORT);

try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
      const { combo, app: scenarioApp, pack: scenarioPack, board: scenarioBoard } = scenario;
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      // ---- the /api/attest stub ---------------------------------------
      // A puppeteer route, not a second HTTP server: the point is to prove
      // the page posts the right thing to the right place, and a route
      // captures that without pretending to be Cloudflare.
      let posted: unknown = null;
      let getCount = 0;
      await page.setRequestInterception(true);
      page.on("request", (req: HTTPRequest) => {
        const url = new URL(req.url());
        if (url.pathname !== "/api/attest") {
          void req.continue();
          return;
        }
        if (req.method() === "POST") {
          try {
            posted = JSON.parse(req.postData() ?? "null");
          } catch {
            posted = { unparseable: req.postData() };
          }
          void req.respond({ status: 201, contentType: "application/json", body: JSON.stringify({ recorded: true }) });
          return;
        }
        getCount++;
        // The first GET is the page load, before anything has been posted;
        // once a run lands, the counter has to move. Both are asserted.
        const postedKind = (posted as { kind?: string } | null)?.kind === "invariants" ? "invariants" : "pixel-exact";
        const counts =
          posted === null
            ? {}
            : {
                [`${scenarioApp}:${scenarioPack}`]: {
                  app: scenarioApp,
                  pack: scenarioPack,
                  confirmations: 1,
                  diverged: 0,
                  lastConfirmedAt: new Date().toISOString().slice(0, 10),
                  kinds: {
                    "pixel-exact": { confirmations: postedKind === "pixel-exact" ? 1 : 0, diverged: 0 },
                    invariants: { confirmations: postedKind === "invariants" ? 1 : 0, diverged: 0 },
                  },
                },
              };
        void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ counts }) });
      });

      // ---- the scripted board over navigator.serial --------------------
      await page.evaluateOnNewDocument(
        (
          greys: number[][],
          width: number,
          height: number,
          shiftFrame: number,
          appName: string,
          chunkBytes: number,
          substitute: { at: number; with: number } | null
        ) => {
          const log: string[] = [];
          const sent: string[] = [];
          Object.defineProperty(window, "__boardLog", { value: log, configurable: true });
          Object.defineProperty(window, "__boardSent", { value: sent, configurable: true });

          const screens = greys.map((g, index) => {
            // A behavioural invariant is broken by showing the board a
            // screen it should not be showing at that moment, not by
            // inventing a picture: serving the "settled" frame again where
            // "right after the shake" belongs is exactly the failure
            // "a shake visibly agitates the fluid" exists to catch, and it
            // leaves every other invariant reading the same numbers.
            const source = substitute && index === substitute.at ? greys[substitute.with]! : g;
            const pixels = new Uint8Array(source);
            if (index === shiftFrame) {
              // ONE pixel, ONE grey level, on ONE of four frames: the
              // smallest thing a tolerance-zero comparison must still
              // catch. Moved AWAY from whichever end the pixel is at, so it
              // never wraps: +4 on a 252 background would come back as 0
              // and turn "one level" into maximum contrast, which would
              // pass this test while proving nothing about the tolerance.
              // One level here is a delta of about 5 after the panel's
              // grey-to-RGB expansion, which a tolerance of 8 would mask -
              // and that is exactly the mutation this scenario is red for.
              const at = Math.floor(pixels.length / 2);
              pixels[at] = pixels[at]! >= 128 ? pixels[at]! - 4 : pixels[at]! + 4;
            }
            return pixels;
          });

          function encodeRLE(g: Uint8Array): number[] {
            const out: number[] = [];
            let i = 0;
            while (i < g.length) {
              const value = g[i]!;
              let count = 1;
              while (i + count < g.length && g[i + count] === value && count < 255) count++;
              out.push(value, count);
              i += count;
            }
            return out;
          }
          const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          function b64(bytes: number[]): string {
            let out = "";
            for (let i = 0; i < bytes.length; i += 3) {
              const b0 = bytes[i]!;
              const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
              const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
              out += A[b0 >> 2]! + A[((b0 & 3) << 4) | (b1 >> 4)]!;
              out += i + 1 < bytes.length ? A[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
              out += i + 2 < bytes.length ? A[b2 & 63]! : "=";
            }
            return out;
          }

          const shots = screens.map((pixels) => {
            const rle = encodeRLE(pixels);
            const payload = b64(rle);
            const bodyLines: string[] = [];
            for (let i = 0; i < payload.length; i += 76) bodyLines.push(payload.slice(i, i + 76));
            return { rleLength: rle.length, bodyLines };
          });

          let app = { index: 0, name: appName };
          let served = 0;
          let shotIndex = 0;

          function reply(cmd: string): string[] {
            sent.push(cmd);
            served++;
            const out: string[] = [];
            // The shared port's own noise, once in a while: a client that
            // trusted the first line back would break here, which is the
            // failure this firmware's README opens with.
            if (served % 5 === 0) out.push(`prof app=${app.name} switch=15287us | loops=217088/s | uptime=${1000 + served}`);
            const word = cmd.split(/\s+/)[0]!.toUpperCase();
            if (word === "PING") out.push(`OK devlink 1 ${width} ${height}`);
            else if (word === "APP") out.push(`APP ${app.index} ${app.name}`);
            else if (word === "SWITCH") {
              app = { index: Number(cmd.split(/\s+/)[1]) || 0, name: appName };
              out.push("OK");
            } else if (word === "SHOT") {
              const shot = shots[Math.min(shotIndex, shots.length - 1)]!;
              shotIndex++;
              out.push(`SHOT ${width} ${height} ${shot.rleLength}`, ...shot.bodyLines, "END");
            } else out.push("OK");
            return out;
          }

          let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
          let inbound = "";
          const encoder = new TextEncoder();

          const port = {
            readable: null as ReadableStream<Uint8Array> | null,
            writable: null as WritableStream<Uint8Array> | null,
            getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 0x0009 }),
            async open(options: { baudRate: number }) {
              log.push(`open baud=${options.baudRate}`);
              port.readable = new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                },
                cancel() {
                  log.push("readable cancelled");
                },
              });
              port.writable = new WritableStream<Uint8Array>({
                write(chunk) {
                  inbound += new TextDecoder().decode(chunk);
                  for (;;) {
                    const nl = inbound.indexOf("\n");
                    if (nl < 0) break;
                    const line = inbound.slice(0, nl).replace(/\r$/, "");
                    inbound = inbound.slice(nl + 1);
                    if (!line) continue;
                    for (const r of reply(line)) {
                      const bytes = encoder.encode(r + "\r\n");
                      // Chopped, so the page's line reassembly is actually
                      // under test rather than assumed.
                      for (let i = 0; i < bytes.length; i += chunkBytes) controller?.enqueue(bytes.slice(i, i + chunkBytes));
                    }
                  }
                },
              });
            },
            async close() {
              log.push("close");
              port.readable = null;
              port.writable = null;
            },
            async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
              log.push(`setSignals dtr=${s.dataTerminalReady} rts=${s.requestToSend}`);
            },
            async getSignals() {
              return { dataCarrierDetect: true, clearToSend: true, ringIndicator: false, dataSetReady: true };
            },
            addEventListener() {},
            removeEventListener() {},
          };

          Object.defineProperty(window.navigator, "serial", {
            configurable: true,
            value: {
              async getPorts() {
                return [port];
              },
              async requestPort() {
                log.push("requestPort");
                return port;
              },
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent() {
                return true;
              },
            },
          });
        },
        scenarioBoard.greys,
        scenarioBoard.width,
        scenarioBoard.height,
        // -1 shifts nothing; 1 puts the single wrong pixel on the SECOND
        // capture point, so a passing DIVERGE run has to name that one and
        // leave the other three reading MATCH.
        scenario.shiftFrame,
        scenarioBoard.appName,
        scenario.chunkBytes,
        scenario.substitute ?? null
      );

      await page.goto(`http://127.0.0.1:${PORT}/run/${combo}.html`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 500));

      const hasSection = await page.evaluate(() => !!document.querySelector(".attest-section[data-attest-plan]"));
      if (!hasSection) fail(`run/${combo}.html has no .attest-section[data-attest-plan]: the attest section did not render`);

      await page.evaluate(() => {
        const w = window as unknown as { __statusLog: string[] };
        w.__statusLog = [];
        const status = document.querySelector(".attest-status");
        if (status) {
          const record = () => {
            const text = status.textContent || "";
            if (text && w.__statusLog[w.__statusLog.length - 1] !== text) w.__statusLog.push(text);
          };
          new MutationObserver(record).observe(status, { childList: true, characterData: true, subtree: true });
        }
        document.querySelector<HTMLButtonElement>(".attest-btn")?.click();
      });

      // Bounded wait rather than a fixed sleep: the run replays two traces
      // in real time (the second one's own timestamps run to ~2.1s) plus a
      // reset settle, so a fixed number here would either be flaky or slow.
      //
      // The verdict is NOT the end of the run: the artifact is fetched and
      // hashed after it renders, and only then does the post button appear.
      // Waiting on the verdict alone raced that and read postVisible=false
      // every time.
      // THE END OF THE RUN IS THE BUTTON COMING BACK, not the verdict and not
      // the post offer. The three endings look different - a finished run
      // offers a post, a broken one shows an error, one with an unanswered
      // invariant shows its verdict and stops - and only the button is
      // common to all three, because attestOnce() re-enables it in its own
      // finally, after everything else it is going to do.
      //
      // Waiting on the verdict instead was a real hole, found by mutation:
      // an incomplete run renders its verdict and only THEN would fetch and
      // hash the artifact, so a build that had lost the "do not post an
      // incomplete run" guard still read postVisible=false here, and the
      // scenario that exists to catch exactly that passed. The button is
      // last, so it cannot race what comes before it.
      await page.waitForFunction(
        () => {
          const btn = document.querySelector<HTMLButtonElement>(".attest-btn");
          return !!btn && !btn.disabled;
        },
        { timeout: 120000 }
      );

      const beforePost = await page.evaluate(() => {
        const verdict = document.querySelector<HTMLElement>(".attest-verdict");
        const error = document.querySelector<HTMLElement>(".attest-error");
        const postWrap = document.querySelector<HTMLElement>(".attest-post");
        return {
          verdictText: verdict && !verdict.hidden ? verdict.textContent : null,
          verdictClass: verdict ? verdict.className : null,
          errorHidden: error ? error.hidden : null,
          errorText: error ? error.textContent : null,
          postVisible: !!postWrap && !postWrap.hidden,
          points: Array.from(document.querySelectorAll<HTMLElement>(".attest-point")).map((li) => ({
            mark: li.querySelector(".attest-point-mark")?.textContent ?? "",
            label: li.querySelector(".attest-point-label")?.textContent ?? "",
            detail: li.querySelector(".attest-point-detail")?.textContent ?? "",
          })),
          statusLog: (window as unknown as { __statusLog: string[] }).__statusLog ?? [],
        };
      });

      // The post button only appears once a run finished; a failed run has
      // nothing to post and this returns without pressing anything.
      if (beforePost.postVisible && scenario.postIt) {
        await page.evaluate(() => document.querySelector<HTMLButtonElement>(".attest-post-btn")?.click());
        // The confirmation line shows before the counter repaints (the
        // repaint is a second round trip), so waiting on the confirmation
        // alone read a stale counter about half the time. Wait for the
        // counter to have stopped saying the empty state instead, which is
        // the last thing a successful post does.
        await page.waitForFunction(
          () => {
            const counter = document.querySelector<HTMLElement>(".attest-section .attest-counter");
            const e = document.querySelector<HTMLElement>(".attest-error");
            const repainted = !!counter && !counter.classList.contains("attest-counter-empty");
            return repainted || (e && !e.hidden && (e.textContent ?? "").includes("HTTP"));
          },
          { timeout: 15000 }
        );
      }

      const after = await page.evaluate(() => {
        const postedEl = document.querySelector<HTMLElement>(".attest-posted");
        const error = document.querySelector<HTMLElement>(".attest-error");
        const counter = document.querySelector<HTMLElement>(".attest-section .attest-counter");
        return {
          postedText: postedEl && !postedEl.hidden ? postedEl.textContent : null,
          errorHidden: error ? error.hidden : null,
          errorText: error ? error.textContent : null,
          counterText: counter ? counter.textContent : null,
        };
      });

      await page.close();
      if (getCount === 0) fail("the page never read GET /api/attest, so its counter was never filled from the endpoint");
      return { ...beforePost, ...after, posted, pageErrors };
    }

    // ---- 1. the board agrees: MATCH, then posted -----------------------
    console.log(`\n1. a board drawing exactly what the bundle recorded`);
    const chronoScenario = { combo: COMBO, app: plan.app, pack: plan.pack, board, chunkBytes: 13, postIt: true };
    const good = await runScenario({ ...chronoScenario, shiftFrame: -1 });
    if (good.pageErrors.length > 0) fail(`the attest run threw: ${good.pageErrors.join(" | ")}`);
    if (good.errorHidden !== true) fail(`the attest run surfaced an error: ${JSON.stringify(good.errorText)}`);
    if (good.points.length !== totalPoints) {
      fail(`expected ${totalPoints} capture points rendered (the plan's own), got ${good.points.length}: ${JSON.stringify(good.points)}`);
    }
    const marks = good.points.map((p) => p.mark);
    if (!marks.every((m) => m === "MATCH")) fail(`expected every point to read MATCH, got ${JSON.stringify(marks)}`);
    console.log(`  every capture point rendered MATCH: ${good.points.map((p) => `${p.label} (${p.detail})`).join(", ")}`);
    if (!good.verdictText || !/runs on this board/i.test(good.verdictText)) {
      fail(`expected a "runs on this board" verdict, got: ${JSON.stringify(good.verdictText)}`);
    }
    if (!good.verdictClass || !/attest-verdict-match/.test(good.verdictClass)) {
      fail(`the match verdict is not styled as a match (class ${JSON.stringify(good.verdictClass)})`);
    }
    console.log(`  verdict: "${good.verdictText}"`);
    if (!good.statusLog.some((s) => /Replaying chrono-idle/i.test(s))) {
      fail(`the status line never said it was replaying the bundle's trace: ${JSON.stringify(good.statusLog)}`);
    }
    if (!good.statusLog.some((s) => /Comparing/i.test(s))) {
      fail(`the status line never said it was comparing against a recorded frame: ${JSON.stringify(good.statusLog)}`);
    }
    console.log(`  status line walked ${good.statusLog.length} steps, replay then compare`);

    // ---- the POST body shape -------------------------------------------
    const body = good.posted as Record<string, unknown> | null;
    if (!body) fail("nothing was posted to /api/attest after a successful run");
    const expectedKeys = ["app", "pack", "portSha", "kind", "verdict", "points", "boardFamily", "date"].sort();
    const actualKeys = Object.keys(body).sort();
    if (actualKeys.join(",") !== expectedKeys.join(",")) {
      fail(`the POST body's fields are ${JSON.stringify(actualKeys)}, not the documented ${JSON.stringify(expectedKeys)}`);
    }
    if (body.app !== plan.app || body.pack !== plan.pack) fail(`the POST names ${body.app}:${body.pack}, not ${plan.app}:${plan.pack}`);
    if (body.kind !== "pixel-exact") fail(`the POST carries kind ${JSON.stringify(body.kind)} for a port verified by recorded frames`);
    if (body.verdict !== "match") fail(`the POST carries verdict ${JSON.stringify(body.verdict)} after an all-matching run`);
    if (body.boardFamily !== plan.boardFamily) fail(`the POST carries boardFamily ${JSON.stringify(body.boardFamily)}, not ${plan.boardFamily}`);
    if (typeof body.portSha !== "string" || !/^[0-9a-f]{64}$/.test(body.portSha)) {
      fail(`the POST's portSha is not a sha256 hex digest: ${JSON.stringify(body.portSha)}`);
    }
    if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) fail(`the POST's date is not YYYY-MM-DD: ${JSON.stringify(body.date)}`);
    if (!Array.isArray(body.points) || body.points.length !== totalPoints) {
      fail(`the POST carries ${Array.isArray(body.points) ? body.points.length : "no"} points, expected ${totalPoints}`);
    }
    console.log(`  POST body shape is exactly {${actualKeys.join(", ")}}, sha ${String(body.portSha).slice(0, 12)}…`);

    // The sha has to be the artifact's own, computed in the page. Checked
    // against bun's own digest of the same file: a page that hashed the
    // wrong bytes (an error page, a cached response) would pass every shape
    // check above and still be identifying firmware nobody flashed.
    const artifactPath = join(DIST, plan.artifact.replace(/^\.\.\//, ""));
    const expectedSha = new Bun.CryptoHasher("sha256").update(readFileSync(artifactPath)).digest("hex");
    if (body.portSha !== expectedSha) {
      fail(`the page hashed something other than ${plan.artifact}: posted ${body.portSha}, the file's own sha256 is ${expectedSha}`);
    }
    console.log(`  the posted sha is ${plan.artifact}'s own sha256`);

    // Nothing personal: asserted as an absence, by name, so adding one later
    // is a test failure and not a quiet change of policy.
    const forbidden = ["ip", "ua", "userAgent", "user_agent", "id", "sessionId", "session", "fingerprint", "cookie", "email", "name"];
    const present = forbidden.filter((k) => k in body);
    if (present.length > 0) fail(`the POST body carries identifying fields it must not: ${JSON.stringify(present)}`);
    console.log(`  nothing identifying in the body (checked for ${forbidden.length} field names)`);

    if (!good.postedText || !/posted/i.test(good.postedText)) fail(`the page did not confirm the post, got: ${JSON.stringify(good.postedText)}`);
    console.log(`  posted state shown: "${good.postedText}"`);
    if (!good.counterText || !/1 confirmation/i.test(good.counterText)) {
      fail(`the counter did not repaint from the endpoint after posting, got: ${JSON.stringify(good.counterText)}`);
    }
    console.log(`  counter repainted from the endpoint: "${good.counterText}"`);

    // ---- 2. the board disagrees: DIVERGE -------------------------------
    console.log(`\n2. a board one pixel off the recorded frame, on one capture point only`);
    const bad = await runScenario({ ...chronoScenario, shiftFrame: 1 });
    if (bad.pageErrors.length > 0) fail(`the diverging run threw instead of reporting a divergence: ${bad.pageErrors.join(" | ")}`);
    if (bad.errorHidden !== true) fail(`the diverging run surfaced an error rather than a verdict: ${JSON.stringify(bad.errorText)}`);
    const badMarks = bad.points.map((p) => p.mark);
    if (!badMarks.includes("DIVERGE")) fail(`a one-pixel difference was not caught at tolerance zero: ${JSON.stringify(badMarks)}`);
    const diverging = bad.points.filter((p) => p.mark === "DIVERGE");
    if (!diverging.every((p) => /\d+\/\d+ pixels differ/.test(p.detail))) {
      fail(`a diverging point does not say how many pixels differ: ${JSON.stringify(diverging)}`);
    }
    if (diverging.length !== 1) {
      fail(`exactly one capture point was fed a wrong pixel, but ${diverging.length} read DIVERGE: ${JSON.stringify(badMarks)}`);
    }
    if (!/1\/\d+ pixels differ/.test(diverging[0]!.detail)) {
      fail(`one wrong pixel was not counted as exactly one: ${JSON.stringify(diverging[0]!.detail)}`);
    }
    console.log(`  ${diverging.length}/${bad.points.length} points read DIVERGE: ${diverging.map((p) => `${p.label} (${p.detail})`).join(", ")}`);
    if (!bad.verdictText || !/drew something else/i.test(bad.verdictText)) {
      fail(`expected a divergence verdict, got: ${JSON.stringify(bad.verdictText)}`);
    }
    if (!bad.verdictClass || !/attest-verdict-diverge/.test(bad.verdictClass)) {
      fail(`the divergence verdict is not styled as one (class ${JSON.stringify(bad.verdictClass)})`);
    }
    console.log(`  verdict: "${bad.verdictText}"`);
    const badBody = bad.posted as Record<string, unknown> | null;
    if (!badBody) fail("a divergence was not offered for posting: a result that only reports agreement is worth nothing");
    if (badBody.verdict !== "diverge") fail(`the divergence posted verdict ${JSON.stringify(badBody.verdict)}`);
    console.log(`  the divergence is postable too, as verdict "diverge"`);

    // ---- 3. the other board family --------------------------------------
    // The RP2350 run above is the deep one; this is the check that the SAME
    // section reached the other family's page at all, pointing at its own
    // plan, its own artifact, and - the one thing that differs on the wire -
    // its own DTR setting. The ESP32-S3's USB Serial/JTAG peripheral wires
    // DTR to the chip's boot strap, so asserting it there reboots the board
    // into the ROM downloader instead of talking to it. A plan that got that
    // backwards would look fine on every page and fail on every desk.
    console.log("\n3. the same section on the other board family");
    {
      const espCombo = "chrono-esp32";
      const espPlanPath = join(DIST, "attest", `${espCombo}.json`);
      if (!existsSync(espPlanPath)) fail(`site/dist/attest/${espCombo}.json is missing: only one board family got an attestation plan`);
      const espPlan = JSON.parse(readFileSync(espPlanPath, "utf8")) as PlanShape;
      if (espPlan.boardFamily !== "esp32") fail(`${espCombo}'s plan claims board family ${JSON.stringify(espPlan.boardFamily)}`);
      if (espPlan.dataTerminalReady !== false) {
        fail(`${espCombo}'s plan asserts DTR, which reboots this board into its ROM downloader instead of talking to it`);
      }
      if (plan.dataTerminalReady === false) fail(`${COMBO}'s plan does not assert DTR, and the RP2350's CDC stack does not answer without it`);
      console.log(`  ${espCombo} plan: family ${espPlan.boardFamily}, DTR ${espPlan.dataTerminalReady}; ${COMBO}: family ${plan.boardFamily}, DTR ${plan.dataTerminalReady}`);

      const espPage = await browser.newPage();
      const espErrors: string[] = [];
      espPage.on("pageerror", (e) => espErrors.push(String(e)));
      // No navigator.serial at all: the section still has to render, and
      // clicking it has to produce a sentence rather than an exception.
      await espPage.evaluateOnNewDocument(() => {
        Object.defineProperty(window.navigator, "serial", { value: undefined, configurable: true });
      });
      await espPage.goto(`http://127.0.0.1:${PORT}/run/${espCombo}.html`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 500));

      const espSection = await espPage.evaluate(async () => {
        const section = document.querySelector<HTMLElement>(".attest-section[data-attest-plan]");
        if (!section) return null;
        const planHref = section.dataset.attestPlan!;
        const resp = await fetch(new URL(planHref, window.location.href).href);
        const counter = section.querySelector<HTMLElement>(".attest-counter");
        return {
          planHref,
          planOk: resp.ok,
          counterText: counter?.textContent ?? null,
          counterEmpty: counter?.classList.contains("attest-counter-empty") ?? false,
        };
      });
      if (!espSection) fail(`run/${espCombo}.html has no .attest-section[data-attest-plan]`);
      if (!espSection.planOk) fail(`${espCombo}'s attest section points at ${espSection.planHref}, which does not resolve from the page`);
      // The endpoint answers here too (the route above is per-page, and this
      // page has none), so this is the "no /api/attest behind the static
      // build" case, which has to read as the empty state and not as a
      // failure. That is the case every local preview and every clone is in.
      if (!espSection.counterEmpty || !/no board has confirmed this yet/i.test(espSection.counterText ?? "")) {
        fail(`with no endpoint behind it, the counter reads ${JSON.stringify(espSection.counterText)} instead of the empty state`);
      }
      console.log(`  attest section renders and its plan resolves; with no endpoint the counter reads "${espSection.counterText}"`);

      await espPage.evaluate(() => document.querySelector<HTMLButtonElement>(".attest-btn")?.click());
      await espPage.waitForFunction(
        () => {
          const e = document.querySelector<HTMLElement>(".attest-error");
          return !!e && !e.hidden;
        },
        { timeout: 10000 }
      );
      const espError = await espPage.evaluate(() => document.querySelector<HTMLElement>(".attest-error")?.textContent ?? null);
      if (!espError || !/web serial/i.test(espError)) {
        fail(`expected an unsupported-browser message naming Web Serial, got: ${JSON.stringify(espError)}`);
      }
      if (espErrors.length > 0) fail(`the esp32 attest section threw instead of rendering a message: ${espErrors.join(" | ")}`);
      console.log(`  unsupported-browser message shown: "${espError}"`);
      await espPage.close();
    }

    // ---- 4. the other KIND of check: an invariants port -----------------
    // fluidbox is verified by its own bundle's invariants.ts rather than by
    // recorded frames, and this is the whole point of that file being a
    // pure function of {frames, meta}: the page runs the SAME function over
    // what the board drew. The board here is scripted from that port's own
    // module, replayed at that bundle's own captureAt and converted to the
    // grey bytes a SHOT carries - so a PASS means fluidbox's own thresholds
    // held on frames that went through the page's decode, not on frames
    // this file handed it in the shape it wanted.
    console.log("\n4. an invariants port: the board's frames through the bundle's own checker");
    const fluidPlan = readPlan("fluidbox-esp32");
    if (fluidPlan.kind !== "invariants") fail(`fluidbox-esp32's plan is ${fluidPlan.kind}, so nothing here is testing the invariants path`);
    if (fluidPlan.checker !== "apps/fluidbox/invariants.ts") {
      fail(`fluidbox-esp32's plan names the checker ${JSON.stringify(fluidPlan.checker)}, not the bundle's own`);
    }
    if (!fluidPlan.device || fluidPlan.device.name !== "ESP32-S3-Touch-AMOLED-1.8") {
      fail(`fluidbox-esp32's plan carries no device for the checker to read, or the wrong one: ${JSON.stringify(fluidPlan.device?.name)}`);
    }
    const fluidBoard = await invariantsBoard(fluidPlan);
    console.log(
      `  scripted board will show ${fluidBoard.greys.length} frames (${fluidBoard.width}x${fluidBoard.height}) replayed from site/dist/modules/fluidbox-esp32.wasm, as SHOT greys`
    );
    // 512 rather than the chrono run's 13: a fluid frame RLEs to hundreds of
    // kilobytes of base64 and the page's line reassembly is already proven
    // byte by byte one scenario up.
    const fluidScenario = {
      combo: "fluidbox-esp32",
      app: fluidPlan.app,
      pack: fluidPlan.pack,
      board: fluidBoard,
      shiftFrame: -1,
      chunkBytes: 512,
      postIt: true,
    };
    const held = await runScenario(fluidScenario);
    if (held.pageErrors.length > 0) fail(`the invariants run threw: ${held.pageErrors.join(" | ")}`);
    if (held.errorHidden !== true) fail(`the invariants run surfaced an error: ${JSON.stringify(held.errorText)}`);
    if (held.points.length !== 5) {
      fail(`expected one row per invariant fluidbox declares (5), got ${held.points.length}: ${JSON.stringify(held.points)}`);
    }
    const marks4 = held.points.map((p) => p.mark);
    if (marks4.includes("FAIL") || marks4.includes("UNANSWERED")) {
      fail(`a board drawing what the emulator draws should hold every invariant, got ${JSON.stringify(held.points)}`);
    }
    // Every row carries the invariant's OWN sentence with its OWN numbers,
    // which is what makes the list a result rather than five green ticks.
    const shakeRow = held.points.find((p) => /shake visibly agitates/i.test(p.label));
    if (!shakeRow) fail(`no row named the shake invariant: ${JSON.stringify(held.points.map((p) => p.label))}`);
    if (!/\d+px differ/.test(shakeRow!.detail)) fail(`the shake invariant's row prints no measured number: ${JSON.stringify(shakeRow!.detail)}`);
    // The device-scoped one reads N/A here and must not read as a hole: the
    // RP2350's panel-push bound was never about this board.
    const pushRow = held.points.find((p) => /pushes the whole panel/i.test(p.label));
    if (!pushRow || pushRow.mark !== "N/A") {
      fail(`fluidbox's rp2350-scoped push bound should read N/A on an esp32 board, got ${JSON.stringify(pushRow)}`);
    }
    console.log(`  ${marks4.filter((m) => m === "PASS").length} invariants PASS, 1 N/A, each with its own measured numbers`);
    console.log(`    e.g. "${shakeRow!.label}" - ${shakeRow!.detail}`);
    if (!held.verdictText || !/runs on this board/i.test(held.verdictText)) {
      fail(`expected a "runs on this board" verdict for a held invariants run, got: ${JSON.stringify(held.verdictText)}`);
    }
    if (!held.verdictClass || !/attest-verdict-match/.test(held.verdictClass)) {
      fail(`the held invariants verdict is not styled as a match (class ${JSON.stringify(held.verdictClass)})`);
    }
    console.log(`  verdict: "${held.verdictText}"`);
    if (!held.statusLog.some((s) => /Running fluidbox's own invariants/i.test(s))) {
      fail(`the status line never said it was running the bundle's own invariants: ${JSON.stringify(held.statusLog)}`);
    }

    const fluidBody = held.posted as Record<string, unknown> | null;
    if (!fluidBody) fail("nothing was posted to /api/attest after a held invariants run");
    const fluidKeys = Object.keys(fluidBody!).sort();
    const expectedFluidKeys = ["app", "pack", "portSha", "kind", "verdict", "invariants", "boardFamily", "date"].sort();
    if (fluidKeys.join(",") !== expectedFluidKeys.join(",")) {
      fail(`the invariants POST body's fields are ${JSON.stringify(fluidKeys)}, not the documented ${JSON.stringify(expectedFluidKeys)}`);
    }
    if (fluidBody!.kind !== "invariants") fail(`the POST carries kind ${JSON.stringify(fluidBody!.kind)} for an invariants port`);
    if (fluidBody!.verdict !== "match") fail(`the POST carries verdict ${JSON.stringify(fluidBody!.verdict)} after a run where every invariant held`);
    const postedInvariants = fluidBody!.invariants as { id: string; status: string }[];
    if (!Array.isArray(postedInvariants) || postedInvariants.length !== 5) {
      fail(`the POST carries ${JSON.stringify(fluidBody!.invariants)} rather than five invariant outcomes`);
    }
    if (postedInvariants.some((i) => i.status === "unevaluable")) {
      fail(`the POST carries an unanswered invariant, which the endpoint refuses by name`);
    }
    const fluidForbidden = ["ip", "ua", "userAgent", "user_agent", "id", "sessionId", "session", "fingerprint", "cookie", "email", "name"];
    const fluidPresent = fluidForbidden.filter((k) => k in fluidBody!);
    if (fluidPresent.length > 0) fail(`the invariants POST body carries identifying fields it must not: ${JSON.stringify(fluidPresent)}`);
    console.log(`  POST body shape is exactly {${fluidKeys.join(", ")}}, kind invariants, ${postedInvariants.length} outcomes`);
    if (!held.postedText || !/posted/i.test(held.postedText)) fail(`the page did not confirm the post, got: ${JSON.stringify(held.postedText)}`);
    if (!held.counterText || !/1 confirmation/i.test(held.counterText)) {
      fail(`the counter did not repaint after posting an invariants run, got: ${JSON.stringify(held.counterText)}`);
    }
    console.log(`  posted, and the counter repainted: "${held.counterText}"`);

    // ---- 5. an invariant that does not hold ----------------------------
    // Broken the way a real regression would break it, not by drawing a
    // wrong picture: the board is made to show the SETTLED screen again
    // where "right after the shake" belongs, which is exactly what a shake
    // that did nothing looks like. Every other invariant reads the same
    // numbers it read above, so the run has to name this one and only this
    // one.
    console.log("\n5. an invariants port where one invariant does not hold");
    const broken = await runScenario({ ...fluidScenario, substitute: { at: 1, with: 0 }, postIt: false });
    if (broken.pageErrors.length > 0) fail(`the failing-invariant run threw instead of reporting it: ${broken.pageErrors.join(" | ")}`);
    if (broken.errorHidden !== true) fail(`the failing-invariant run surfaced an error rather than a verdict: ${JSON.stringify(broken.errorText)}`);
    const failing = broken.points.filter((p) => p.mark === "FAIL");
    if (failing.length !== 1) {
      fail(`exactly one invariant was broken, but ${failing.length} read FAIL: ${JSON.stringify(broken.points.map((p) => `${p.mark} ${p.label}`))}`);
    }
    if (!/shake visibly agitates/i.test(failing[0]!.label)) {
      fail(`the failing invariant is not named by the check that was broken: ${JSON.stringify(failing[0]!.label)}`);
    }
    if (!/min required 1500px/.test(failing[0]!.detail)) {
      fail(`the failing invariant does not print its own threshold and measurement: ${JSON.stringify(failing[0]!.detail)}`);
    }
    console.log(`  1/${broken.points.length} invariants FAIL, by name: "${failing[0]!.label}" - ${failing[0]!.detail}`);
    if (!broken.verdictText || !/behaves differently/i.test(broken.verdictText)) {
      fail(`expected a behavioural-divergence verdict, got: ${JSON.stringify(broken.verdictText)}`);
    }
    if (!broken.verdictClass || !/attest-verdict-diverge/.test(broken.verdictClass)) {
      fail(`the invariants divergence is not styled as one (class ${JSON.stringify(broken.verdictClass)})`);
    }
    console.log(`  verdict: "${broken.verdictText}"`);
    // Nothing left this page. A divergence is still OFFERED for posting -
    // docs/decisions/0011: "an attestation system that only recorded
    // agreement would be an applause meter" - but the run itself posts
    // nothing, and this scenario never presses the button.
    if (broken.posted !== null) fail(`the run posted by itself, without the button being pressed: ${JSON.stringify(broken.posted)}`);
    if (!broken.postVisible) fail(`a behavioural divergence was not offered for posting: a result that only records agreement is worth nothing`);
    console.log(`  nothing was posted by the run itself, and the divergence stays offerable`);

    // ---- 6. an invariant a board cannot answer at all -------------------
    // The same app on the OTHER board, where its panel-push bound stops
    // being "not about this device" and becomes "about this device, and
    // unanswerable from what a board reports". This is the case
    // docs/decisions/0011's addendum is about: the section shows it, says
    // the run is incomplete, and offers no post button at all.
    console.log("\n6. an invariant this board cannot answer: shown, and not posted");
    const rpPlan = readPlan("fluidbox-rp2350");
    if (rpPlan.kind !== "invariants") fail(`fluidbox-rp2350's plan is ${rpPlan.kind}`);
    const rpBoard = await invariantsBoard(rpPlan);
    const incomplete = await runScenario({
      combo: "fluidbox-rp2350",
      app: rpPlan.app,
      pack: rpPlan.pack,
      board: rpBoard,
      shiftFrame: -1,
      chunkBytes: 512,
      postIt: true, // pressed if offered, which is the point: it must not be
    });
    if (incomplete.pageErrors.length > 0) fail(`the incomplete run threw: ${incomplete.pageErrors.join(" | ")}`);
    if (incomplete.errorHidden !== true) fail(`the incomplete run surfaced an error rather than saying what it could not answer: ${JSON.stringify(incomplete.errorText)}`);
    const unanswered = incomplete.points.filter((p) => p.mark === "UNANSWERED");
    if (unanswered.length !== 1 || !/pushes the whole panel/i.test(unanswered[0]!.label)) {
      fail(`expected exactly the panel-push bound to read UNANSWERED, got ${JSON.stringify(incomplete.points.map((p) => `${p.mark} ${p.label}`))}`);
    }
    if (!/cannot be answered/i.test(unanswered[0]!.detail)) {
      fail(`the unanswered invariant does not say why it could not be answered: ${JSON.stringify(unanswered[0]!.detail)}`);
    }
    if (incomplete.points.filter((p) => p.mark === "PASS").length !== 4) {
      fail(`the four invariants a board CAN answer should still be shown as held: ${JSON.stringify(incomplete.points.map((p) => p.mark))}`);
    }
    console.log(`  4 invariants PASS and 1 reads UNANSWERED: "${unanswered[0]!.label}"`);
    console.log(`    ${unanswered[0]!.detail}`);
    if (!incomplete.verdictText || !/incomplete/i.test(incomplete.verdictText)) {
      fail(`the section does not say the run is incomplete, it says: ${JSON.stringify(incomplete.verdictText)}`);
    }
    if (!incomplete.verdictClass || !/attest-verdict-incomplete/.test(incomplete.verdictClass)) {
      fail(`an incomplete run is styled as a verdict it is not (class ${JSON.stringify(incomplete.verdictClass)})`);
    }
    console.log(`  verdict: "${incomplete.verdictText}"`);
    if (incomplete.postVisible) fail(`an incomplete run offered a post button: a confirmation with an unanswered check inside it is exactly the claim 0011 refuses`);
    if (incomplete.posted !== null) fail(`an incomplete run posted anyway: ${JSON.stringify(incomplete.posted)}`);
    console.log(`  no post button, and nothing reached /api/attest`);

    console.log("\nOK: attestation UI verified, end to end, with no board and no Cloudflare.");
  } finally {
    await closeBrowser(browser);
  }
} finally {
  server.stop(true);
}
