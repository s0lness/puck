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
//                     needs a Pages Function, a D1 database or a network.
//                     The POST body is captured and asserted against the
//                     documented shape (site/attest/plan.ts's AttestPost).
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
  boardFamily: string;
  artifact: string;
  framesBase: string;
  dataTerminalReady: boolean;
  traces: { name: string; events: unknown[]; points: { atMs: number; frame: string }[] }[];
}

const planPath = join(DIST, "attest", `${COMBO}.json`);
if (!existsSync(planPath)) fail(`site/dist/attest/${COMBO}.json is missing: site/build.ts did not emit an attestation plan.`);
const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanShape;

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
const frameFiles = plan.traces.flatMap((t) => t.points.map((p) => p.frame));
const frames = frameFiles.map(greyFromRecordedFrame);
const board = { width: frames[0]!.width, height: frames[0]!.height, greys: frames.map((f) => f.grey) };
console.log(
  `scripted board will show, in order: ${frameFiles.join(", ")} (${board.width}x${board.height}), each decoded from the bundle's own recorded frame`
);

const totalPoints = plan.traces.reduce((n, t) => n + t.points.length, 0);

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

const server = serveDist(DIST, PORT);

try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    async function runScenario(shiftPixel: boolean): Promise<ScenarioResult> {
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
        const counts =
          posted === null
            ? {}
            : {
                [`${plan.app}:${plan.pack}`]: {
                  app: plan.app,
                  pack: plan.pack,
                  confirmations: 1,
                  diverged: 0,
                  lastConfirmedAt: new Date().toISOString().slice(0, 10),
                },
              };
        void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ counts }) });
      });

      // ---- the scripted board over navigator.serial --------------------
      await page.evaluateOnNewDocument(
        (greys: number[][], width: number, height: number, shiftFrame: number) => {
          const log: string[] = [];
          const sent: string[] = [];
          Object.defineProperty(window, "__boardLog", { value: log, configurable: true });
          Object.defineProperty(window, "__boardSent", { value: sent, configurable: true });

          const screens = greys.map((g, index) => {
            const pixels = new Uint8Array(g);
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

          let app = { index: 0, name: "chrono" };
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
              app = { index: Number(cmd.split(/\s+/)[1]) || 0, name: "chrono" };
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
                      for (let i = 0; i < bytes.length; i += 13) controller?.enqueue(bytes.slice(i, i + 13));
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
        board.greys,
        board.width,
        board.height,
        // -1 shifts nothing; 1 puts the single wrong pixel on the SECOND
        // capture point, so a passing DIVERGE run has to name that one and
        // leave the other three reading MATCH.
        shiftPixel ? 1 : -1
      );

      await page.goto(`http://127.0.0.1:${PORT}/run/${COMBO}.html`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 500));

      const hasSection = await page.evaluate(() => !!document.querySelector(".attest-section[data-attest-plan]"));
      if (!hasSection) fail(`run/${COMBO}.html has no .attest-section[data-attest-plan]: the attest section did not render`);

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
      await page.waitForFunction(
        () => {
          const post = document.querySelector<HTMLElement>(".attest-post");
          const e = document.querySelector<HTMLElement>(".attest-error");
          return (post && !post.hidden) || (e && !e.hidden);
        },
        { timeout: 60000 }
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
      if (beforePost.postVisible) {
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
    const good = await runScenario(false);
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
    const expectedKeys = ["app", "pack", "portSha", "verdict", "points", "boardFamily", "date"].sort();
    const actualKeys = Object.keys(body).sort();
    if (actualKeys.join(",") !== expectedKeys.join(",")) {
      fail(`the POST body's fields are ${JSON.stringify(actualKeys)}, not the documented ${JSON.stringify(expectedKeys)}`);
    }
    if (body.app !== plan.app || body.pack !== plan.pack) fail(`the POST names ${body.app}:${body.pack}, not ${plan.app}:${plan.pack}`);
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
    const bad = await runScenario(true);
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

    console.log("\nOK: attestation UI verified, end to end, with no board and no Cloudflare.");
  } finally {
    await closeBrowser(browser);
  }
} finally {
  server.stop(true);
}
