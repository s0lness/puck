// scripts/verify-site-embeds.ts: headless proof that the BUILT gallery
// (site/dist/) is correct end to end - not scripts/verify-embed.ts's job,
// which drives the dev server's bare ?embed=1 page directly and never
// touches site/dist/ or anything site/build.ts generates from it.
//
// Two halves, matching this task's own landing/run-page split:
//
//   1. THE LANDING PAGE (site/dist/index.html) no longer embeds a live
//      emulator per card (see site/build.ts's demoThumb, this task's own
//      "recorded loops, not live emulators" pass): it links to a recorded
//      <video>, poster, and gif fallback for every app card and reference
//      tile. This checks every one of those assets actually exists in the
//      build output and that the thumbnail's own link resolves to a real
//      run page - the regression this guards against is a build that
//      silently ships a landing page pointing at demo media nobody
//      recorded yet (site/build.ts's copyDemoMedia only warns, it does not
//      fail the build, precisely so a fresh clone can still build once
//      before any recording has happened - this script is what actually
//      enforces the media exists before calling the SITE correct).
//
//   2. EVERY RUN PAGE, at three widths (390 - the narrowest realistic
//      phone, 700, 1280): the embedded device must fit entirely inside its
//      iframe viewport (the regression check for a real bug: a run page
//      used to shrink the device around the WRONG point at a narrow width,
//      built to fit but pinned to the left, off screen - see
//      site/styles.css's own ".emu-frame { transform-origin }" comment for
//      the geometry), and the page itself must never scroll horizontally
//      at all (document.scrollingElement.scrollWidth <= the viewport
//      width) - not just the device, every element on the page: header,
//      badges, the flash section, the footer.
//
// Run with: bun run site:verify-embeds (needs site/dist/ - run `bun run
// site:build` first).
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53413;

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
function failFatal(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST)) failFatal(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

async function fetchOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${path.replace(/^\/+/, "")}`);
    return r.ok;
  } catch {
    return false;
  }
}

// site/build.ts's own contentHashOf: first 10 hex chars of a sha256 - this
// only checks the QUERY STRING SHAPE ("?v=" or "&v=" followed by hex), not
// that any specific hash is correct (fetchOk below is what proves the URL
// actually resolves against the built output, which is the real proof a
// stale cached copy would fail).
function hasVersion(url: string): boolean {
  return /[?&]v=[0-9a-f]{6,}(?:&|$)/i.test(url);
}

const server = serveDist(DIST, PORT);

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

  // ---- 1. the landing page: every thumbnail's media + link resolves ----
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 4200 });
    page.on("pageerror", (e) => console.error("index.html page error:", e));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    console.log("index.html loaded");

    const thumbs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a.thumb-video")).map((a) => {
        const el = a as HTMLAnchorElement;
        const video = el.querySelector("video");
        const source = el.querySelector("video source") as HTMLSourceElement | null;
        const img = el.querySelector("noscript img") as HTMLImageElement | null;
        return {
          href: el.getAttribute("href"),
          poster: video?.getAttribute("poster") || null,
          mp4: source?.getAttribute("src") || null,
          // <noscript> content is inert markup in a script-enabled browser
          // (never parsed into a real <img>), so its src has to be read
          // out of the raw innerHTML, not a live element query.
          gifHtml: el.querySelector("noscript")?.innerHTML || null,
        };
      });
    });
    console.log(`found ${thumbs.length} demo thumbnail(s) on the landing page`);
    if (thumbs.length < 4) fail(`expected at least 4 demo thumbnails on the landing page (site/build.ts's cardsHtml + refTiles), found ${thumbs.length}`);

    for (const t of thumbs) {
      const label = t.mp4 || t.href || "(unknown thumbnail)";
      if (!t.href) { fail(`thumbnail has no href to a run page: ${label}`); continue; }
      if (!(await fetchOk(t.href))) fail(`thumbnail's run-page link 404s: ${t.href}`);
      if (!t.mp4) fail(`thumbnail has no <source> mp4: ${label}`);
      else if (!(await fetchOk(t.mp4))) fail(`thumbnail's mp4 404s: ${t.mp4}`);
      else if (!hasVersion(t.mp4)) fail(`thumbnail's mp4 has no ?v= cache-buster: ${t.mp4}`);
      if (!t.poster) fail(`thumbnail has no poster image: ${label}`);
      else if (!(await fetchOk(t.poster))) fail(`thumbnail's poster 404s: ${t.poster}`);
      else if (!hasVersion(t.poster)) fail(`thumbnail's poster has no ?v= cache-buster: ${t.poster}`);
      const gifSrcMatch = t.gifHtml?.match(/src="([^"]+)"/);
      if (!gifSrcMatch) fail(`thumbnail has no <noscript> gif fallback: ${label}`);
      else if (!(await fetchOk(gifSrcMatch[1]!))) fail(`thumbnail's gif fallback 404s: ${gifSrcMatch[1]}`);
      else if (!hasVersion(gifSrcMatch[1]!)) fail(`thumbnail's gif fallback has no ?v= cache-buster: ${gifSrcMatch[1]}`);
    }
    if (failures === 0) console.log("PASS: every landing-page thumbnail has a working, cache-busted video, poster, gif fallback, and run-page link");

    const stylesHref = await page.$eval('link[rel="stylesheet"]', (el) => el.getAttribute("href"));
    if (!stylesHref || !hasVersion(stylesHref)) fail(`index.html: styles.css link has no ?v= cache-buster (${stylesHref})`);
    else if (!(await fetchOk(stylesHref))) fail(`index.html: styles.css?v= 404s: ${stylesHref}`);
    else console.log(`PASS: index.html's styles.css link is cache-busted (${stylesHref})`);

    // Each card's own recorded video must actually match its PACK's own
    // panel aspect (368:448, or whatever a device.json declares) - proof
    // that site/record-demos.ts's crop (tight to #panel alone, see that
    // file's own header for why it moved off #bezel: a détouré device has
    // no rectangle of its own to bake page background into) produces a
    // clip that is genuinely just the panel, not the panel plus a sliver
    // of bezel or a scaling artifact. data-panel-w/-h (site/build.ts's own
    // cardDeviceGeometry) are the pack's DECLARED panel size, independent
    // of whatever this page's CSS draws around the video - the video's own
    // fill (.card-panel's object-fit: cover) can absorb a couple of
    // percent of mismatch invisibly, which is exactly why this needs a
    // real number, not just "does it look right."
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const vids = Array.from(document.querySelectorAll("video"));
          let pending = vids.length;
          if (pending === 0) { resolve(); return; }
          for (const v of vids) {
            if (v.readyState >= 1) { pending--; if (pending === 0) resolve(); continue; }
            v.addEventListener("loadedmetadata", () => { pending--; if (pending === 0) resolve(); }, { once: true });
          }
        })
    );
    const aspectChecks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a.thumb-video")).map((a) => {
        const el = a as HTMLAnchorElement;
        const video = el.querySelector("video") as HTMLVideoElement | null;
        const r = video?.getBoundingClientRect();
        return {
          href: el.getAttribute("href"),
          videoW: video?.videoWidth ?? 0,
          videoH: video?.videoHeight ?? 0,
          panelW: video ? Number(video.getAttribute("data-panel-w")) : null,
          panelH: video ? Number(video.getAttribute("data-panel-h")) : null,
          renderedW: r ? r.width : 0,
          renderedH: r ? r.height : 0,
        };
      });
    });
    for (const c of aspectChecks) {
      if (!c.videoW || !c.videoH) { fail(`${c.href}: card video metadata never loaded (${c.videoW}x${c.videoH})`); continue; }
      if (!c.panelW || !c.panelH) { fail(`${c.href}: card video has no data-panel-w/-h`); continue; }
      const videoRatio = c.videoW / c.videoH;
      const panelRatio = c.panelW / c.panelH;
      const pctOff = Math.abs(videoRatio - panelRatio) / panelRatio;
      if (pctOff > 0.02) {
        fail(
          `${c.href}: video intrinsic ${c.videoW}x${c.videoH} (ratio ${videoRatio.toFixed(3)}) is ${(pctOff * 100).toFixed(1)}% off ` +
            `this pack's own panel aspect ${c.panelW}/${c.panelH} (ratio ${panelRatio.toFixed(3)})`
        );
      } else {
        console.log(`  ${c.href}: video ${c.videoW}x${c.videoH} matches panel aspect ${c.panelW}/${c.panelH} (${(pctOff * 100).toFixed(1)}% off)`);
      }
    }
    if (failures === 0) console.log("PASS: every card video's intrinsic dimensions match its pack's own panel aspect within 2%");

    // The check above only proves the video's own INTRINSIC pixels are the
    // right shape - it says nothing about the BOX that video is actually
    // laid out into, which is exactly what a cover-crop or a wrong-orientation
    // frame gets wrong while intrinsic dimensions stay perfectly correct
    // (a landscape clip is still 448x368 whether or not the box around it
    // is portrait). This is the regression check for that real bug: a
    // stray height:100% on .thumb-video once let an ancestor's definite
    // height override the inline aspect-ratio, stretching the video's own
    // RENDERED box away from its intrinsic shape, at which point
    // object-fit had to crop or letterbox to compensate - the crop is
    // what Sylve actually saw on screen. Comparing the video's own
    // getBoundingClientRect() aspect against its intrinsic aspect is what
    // would have caught it: an intrinsic-only check (above) cannot,
    // because the video file itself was never wrong.
    for (const c of aspectChecks) {
      if (!c.renderedW || !c.renderedH) { fail(`${c.href}: card video has no rendered box (${c.renderedW}x${c.renderedH})`); continue; }
      if (!c.videoW || !c.videoH) continue; // already failed above
      const renderedRatio = c.renderedW / c.renderedH;
      const intrinsicRatio = c.videoW / c.videoH;
      const pctOff = Math.abs(renderedRatio - intrinsicRatio) / intrinsicRatio;
      if (pctOff > 0.02) {
        fail(
          `${c.href}: video's RENDERED box ${c.renderedW.toFixed(1)}x${c.renderedH.toFixed(1)} (ratio ${renderedRatio.toFixed(3)}) is ` +
            `${(pctOff * 100).toFixed(1)}% off its own intrinsic aspect ${c.videoW}x${c.videoH} (ratio ${intrinsicRatio.toFixed(3)}) - ` +
            `object-fit is cropping or letterboxing this card, not just displaying it`
        );
      } else {
        console.log(`  ${c.href}: rendered box ${c.renderedW.toFixed(1)}x${c.renderedH.toFixed(1)} matches intrinsic aspect (${(pctOff * 100).toFixed(1)}% off)`);
      }
    }
    if (failures === 0) console.log("PASS: every card video's RENDERED box matches its own intrinsic aspect within 2% (no cover-crop, no wrong-orientation frame)");

    await page.close();
  }

  // ---- 2. every run page: contained at 390/700/1280, and never scrolls
  // horizontally at any of those widths ------------------------------------
  const runDir = join(DIST, "run");
  const runPages = readdirSync(runDir).filter((f) => f.endsWith(".html"));
  console.log(`\nfound ${runPages.length} run page(s): ${runPages.join(", ")}`);

  const WIDTHS = [390, 700, 1280];

  async function checkRunPage(page: Page, file: string, width: number): Promise<void> {
    await page.setViewport({ width, height: 1600 });
    await page.goto(`http://127.0.0.1:${PORT}/run/${file}`, { waitUntil: "domcontentloaded" });
    // Let the embedded iframe boot (fetch -> instantiate -> first ticks)
    // and this page's own fit()/embed-scale settle.
    await new Promise((r) => setTimeout(r, 1800));

    // No horizontal scroll ANYWHERE on the page - not just the device.
    const scrollWidth = await page.evaluate(() => document.scrollingElement!.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    if (scrollWidth > viewportWidth + 1) {
      fail(`${file} @ ${width}px: page scrolls horizontally (scrollWidth ${scrollWidth} > viewport ${viewportWidth})`);
    } else {
      console.log(`  [${width}px] ${file}: no horizontal overflow (scrollWidth ${scrollWidth} <= viewport ${viewportWidth})`);
    }

    // The device itself must fit entirely inside its iframe's viewport -
    // the transform-origin regression this file's header comment covers.
    const frame = page.frames().find((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
    if (!frame) {
      fail(`${file} @ ${width}px: no embedded emulator iframe found`);
      return;
    }

    // The outer page's hint must follow the embedded module's descriptor,
    // including raw "stream" sensors. The site generator used to check only
    // "vector", so stream-only packs had working phone motion with no hint.
    const hasPhoneMotion = await frame.evaluate(() => {
      const debug = (window as unknown as { __debug?: { getDevice?: () => { sensors?: { kind: string }[] } | null } }).__debug;
      return (debug?.getDevice?.()?.sensors || []).some((sensor) => sensor.kind === "vector" || sensor.kind === "stream");
    });
    const hintOffersPhoneTilt = await page.$eval(".embed-hint", (el) => (el.textContent || "").includes("tilt with your phone"));
    if (hasPhoneMotion !== hintOffersPhoneTilt) {
      fail(`${file} @ ${width}px: phone-motion hint is ${hintOffersPhoneTilt ? "shown" : "hidden"} but descriptor support is ${hasPhoneMotion}`);
    }

    let result: { ok: boolean; reason: string } | null = null;
    try {
      result = await frame.evaluate((eps) => {
        const bezel = document.querySelector("#bezel") as HTMLElement | null;
        if (!bezel) return { ok: false, reason: "no #bezel element found in frame" };
        const r = bezel.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const fits = r.left >= -eps && r.top >= -eps && r.right <= vw + eps && r.bottom <= vh + eps;
        return { ok: fits, reason: `bezel rect (${r.left.toFixed(1)},${r.top.toFixed(1)})-(${r.right.toFixed(1)},${r.bottom.toFixed(1)}) vs viewport ${vw}x${vh}` };
      }, 1);
    } catch (err) {
      result = { ok: false, reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const status = result!.ok ? "fits" : "OVERFLOWS";
    console.log(`  [${width}px] ${file}: device ${status} (${result!.reason})`);
    if (!result!.ok) fail(`${file} @ ${width}px: embedded device overflows its iframe viewport (${result!.reason})`);

    // No scrollbar INSIDE the embedded emu document itself, in either axis
    // - a different check from the outer page's own scrollWidth above: this
    // is the emu/index.html?embed=1 document's own html/body, one browsing
    // context down. Root cause this guards against: family-budget.css's
    // `html { scrollbar-gutter: stable; }` reserving a permanent vertical-
    // scrollbar gutter even with nothing to scroll, which shrank #root/
    // .stage's real width below the iframe's own and pushed the device left
    // of centre with dead space on the right (src/app.css's html.embed
    // overflow:hidden + scrollbar-gutter:auto override is the fix; this is
    // the regression check for it).
    let innerResult: { ok: boolean; reason: string } | null = null;
    try {
      innerResult = await frame.evaluate((eps) => {
        const html = document.documentElement;
        const noHScroll = html.scrollWidth <= html.clientWidth + eps;
        const noVScroll = html.scrollHeight <= html.clientHeight + eps;
        const ok = noHScroll && noVScroll;
        return {
          ok,
          reason: `scrollWidth ${html.scrollWidth} vs clientWidth ${html.clientWidth}, scrollHeight ${html.scrollHeight} vs clientHeight ${html.clientHeight}`,
        };
      }, 1);
    } catch (err) {
      innerResult = { ok: false, reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    console.log(`  [${width}px] ${file}: embed document ${innerResult!.ok ? "has no scrollbar" : "SCROLLS"} (${innerResult!.reason})`);
    if (!innerResult!.ok) fail(`${file} @ ${width}px: the embedded emu document itself scrolls (${innerResult!.reason})`);

    // The device's rendered centre must sit within 2px of the iframe's own
    // horizontal centre - the visual half of the same regression: a
    // reserved-but-unscrolled gutter (or any other stray horizontal offset)
    // can shrink the content box without ever tripping the scrollWidth
    // check above (scrollWidth can still be <= clientWidth while everything
    // sits off-centre inside a narrower box), so this is a genuinely
    // separate assertion, not a restatement of the one above.
    let centerResult: { ok: boolean; reason: string } | null = null;
    try {
      centerResult = await frame.evaluate((eps) => {
        const bezel = document.querySelector("#bezel") as HTMLElement | null;
        if (!bezel) return { ok: false, reason: "no #bezel element found in frame" };
        const r = bezel.getBoundingClientRect();
        const deviceCenterX = (r.left + r.right) / 2;
        const viewportCenterX = window.innerWidth / 2;
        const off = Math.abs(deviceCenterX - viewportCenterX);
        return { ok: off <= eps, reason: `device centre x ${deviceCenterX.toFixed(1)} vs viewport centre x ${viewportCenterX.toFixed(1)} (off by ${off.toFixed(1)}px)` };
      }, 2);
    } catch (err) {
      centerResult = { ok: false, reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    console.log(`  [${width}px] ${file}: device horizontal centring ${centerResult!.ok ? "OK" : "OFF"} (${centerResult!.reason})`);
    if (!centerResult!.ok) fail(`${file} @ ${width}px: embedded device is not horizontally centred (${centerResult!.reason})`);
  }

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("run page error:", e));
  for (const file of runPages) {
    console.log(`\n-- ${file} --`);
    for (const w of WIDTHS) {
      await checkRunPage(page, file, w);
    }
  }
  await page.close();

  // ---- 3. cache-busting: every asset URL a run page emits carries ?v= and
  // resolves 200 - both the OUTER page's own refs (styles.css, flash.js,
  // the emu iframe's src) and, separately, the EMBEDDED emu/index.html
  // document's own internal refs to main.js/app.css/family-budget.css
  // (site/build.ts rewrites those during the copy step; a browser caches
  // them by their own url, resolved against that document, so the outer
  // page's iframe src carrying ?v= alone would not be enough - this is the
  // actual regression the cache-busting fix targets). --------------------
  {
    const page = await browser.newPage();
    for (const file of runPages) {
      await page.setViewport({ width: 700, height: 1200 });
      await page.goto(`http://127.0.0.1:${PORT}/run/${file}`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 1200));

      const stylesHref = await page.$eval('link[rel="stylesheet"]', (el) => el.getAttribute("href"));
      if (!stylesHref || !hasVersion(stylesHref)) fail(`${file}: styles.css link has no ?v= (${stylesHref})`);
      else if (!(await fetchOk(stylesHref))) fail(`${file}: styles.css?v= 404s: ${stylesHref}`);

      const flashSrc = await page
        .$eval('script[type="module"][src*="flash"]', (el) => el.getAttribute("src"))
        .catch(() => null);
      if (flashSrc) {
        if (!hasVersion(flashSrc)) fail(`${file}: flash.js script has no ?v= (${flashSrc})`);
        else if (!(await fetchOk(flashSrc))) fail(`${file}: flash.js?v= 404s: ${flashSrc}`);
      }

      const iframeSrc = await page.$eval("#emu", (el) => el.getAttribute("src"));
      if (!iframeSrc || !hasVersion(iframeSrc)) fail(`${file}: emu iframe src has no ?v= (${iframeSrc})`);
      else if (!(await fetchOk(iframeSrc.split("?")[0]!))) fail(`${file}: emu iframe src path 404s: ${iframeSrc}`);

      const frame = page.frames().find((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
      if (!frame) {
        fail(`${file}: no embedded emulator iframe found for the asset-versioning check`);
        continue;
      }
      const inner = await frame.evaluate(() => {
        const css = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => (l as HTMLLinkElement).href);
        const js = Array.from(document.querySelectorAll('script[type="module"]')).map((s) => (s as HTMLScriptElement).src);
        return [...css, ...js];
      });
      if (inner.length < 3) fail(`${file}: emu/index.html has only ${inner.length} internal asset ref(s), expected main.js + app.css + family-budget.css`);
      for (const u of inner) {
        const parsed = new URL(u);
        if (!hasVersion(parsed.search)) fail(`${file}: emu/index.html's own asset ref has no ?v=: ${u}`);
        else if (!(await fetchOk(parsed.pathname))) fail(`${file}: emu/index.html's own asset ref 404s: ${u}`);
      }
      console.log(`  ${file}: styles.css, flash.js (if any), the emu iframe, and its own main.js/app.css/family-budget.css all carry ?v= and resolve`);
    }
    await page.close();
    if (failures === 0) console.log("\nPASS: every run page's own assets, and the embedded emu bundle's internal assets, are cache-busted and resolve");
  }

  // ---- 4. agent-browsable surfaces (site/build.ts's buildAgentSurfaces):
  // llms.txt, registry.json, the convention docs, and every app's
  // descriptor.md all resolve 200 - the whole point of serving them raw
  // is that an agent with only a URL can read the real files, so a build
  // that silently 404s one is worse than not having the surface at all. --
  {
    const registry = JSON.parse(readFileSync(join(DIST, "registry.json"), "utf8")) as {
      apps: { name: string; path?: string; url?: string }[];
    };
    const agentPaths = [
      "llms.txt",
      "registry.json",
      "agents.html",
      "docs/convention/device-pack.md",
      "docs/convention/app-bundle.md",
      ...registry.apps.filter((a) => a.path).map((a) => `apps/${a.name}/descriptor.md`),
    ];
    for (const p of agentPaths) {
      if (await fetchOk(p)) console.log(`  /${p}: 200`);
      else fail(`/${p} does not resolve 200`);
    }
    if (failures === 0) console.log("PASS: llms.txt, registry.json, agents.html, the convention docs, and every app's descriptor.md all resolve 200");
  }

  // ---- 5. markup's key-gated loader (site/build.ts's MARKUP_LOADER,
  // embedded once in the shared page() template so every page gets it):
  // present in the raw HTML of every page, and provably INERT on a plain
  // load - a browser that never carries ?markup/?edit must never issue a
  // single request toward markup.sylve.org. Request interception (not just
  // reading the script's own source) is what actually proves "no network
  // call", the same way this repo's own harness insists on a real proof
  // over a claim in a comment. --------------------------------------------
  {
    const allPages = ["index.html", "agents.html", ...runPages.map((f) => `run/${f}`)];
    for (const p of allPages) {
      const html = await (await fetch(`http://127.0.0.1:${PORT}/${p}`)).text();
      if (!html.includes("markup.sylve.org/markup.js")) fail(`${p}: no markup loader found in the served HTML`);
    }
    if (failures === 0) console.log(`PASS: markup's loader is present in all ${allPages.length} page(s)`);

    const page = await browser.newPage();
    let markupRequested = false;
    page.on("request", (req) => {
      if (req.url().includes("markup.sylve.org")) markupRequested = true;
    });
    for (const p of allPages) {
      await page.goto(`http://127.0.0.1:${PORT}/${p}`, { waitUntil: "networkidle0" });
    }
    if (markupRequested) fail("a plain page load (no ?markup/?edit, no key) made a request toward markup.sylve.org - the loader is not inert");
    else console.log(`PASS: no request toward markup.sylve.org across ${allPages.length} plain page load(s) - the loader is inert`);
    await page.close();
  }

  if (failures === 0) {
    console.log(`\nPASS: every run page is contained and free of horizontal overflow at ${WIDTHS.join("px, ")}px`);
  } else {
    console.error(`\nFAIL: ${failures} check(s) failed - see above`);
    process.exitCode = 1;
  }
} finally {
  server.stop(true);
  if (browser) await closeBrowser(browser);
}
