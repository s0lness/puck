// scripts/silhouetteProof.ts: build one app against one silhouette and prove
// it actually runs there, headlessly, for any app and any silhouette.
//
// This is the generic half of what scripts/verify-silhouette.ts does for one
// hand-picked cell. That script is the DEEP proof of a single pair (fluidbox
// on the M5StickC PLUS2: it tilts the page with synthetic devicemotion and
// asserts the fluid poured the way gravity pointed, which is a claim only
// that app can make). This module is the WIDE one, run by tools/ledger.ts
// across every app times every silhouette, and it therefore asserts only
// what is true of every app:
//
//   1. the pack's host build actually compiled the app against this
//      silhouette's device.json (packs/web/wasm/build.ts --silhouette)
//   2. the MODULE's own emu_device() reports that silhouette's panel, read
//      back through the page rather than from the file on disk, so a build
//      against the wrong descriptor cannot pass by agreeing with the file
//   3. the canvas the browser paints is that panel's size in device pixels,
//      so the page is presenting the panel rather than a scaled stand-in
//   4. the panel is not one flat colour: some fraction of it is something
//      other than its own most common pixel
//
// FOUR IS THE ONE THAT CATCHES A HARDCODED PANEL. A port that writes its
// layout at coordinates it took from another device still compiles here
// (this pack's gfx.h clips rather than faults), and what comes out is a
// panel with the app drawn mostly off the edge of it, or nothing at all.
// A frame that is one flat colour is therefore reported as a failure with
// its own name (BLANK) rather than as a pass with a picture nobody looked
// at. It is not a substitute for looking at the PNG, and the ledger's own
// header says so.
//
// The proof PNG is the canvas itself at 1:1, not a screenshot of a page.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { serveDist } from "./staticSite";

const ROOT = resolve(import.meta.dir, "..");

export interface SilhouettePanel {
  w: number;
  h: number;
}

export interface SilhouetteBuildRequest {
  /** Silhouette folder name under packs/silhouettes/, e.g. "watchy". */
  silhouette: string;
  /** App name, used to name the output directory and the proof file. */
  app: string;
  /** Repo-root-relative path to the port's C file. */
  source: string;
  /** The port's own build arguments from its bundle.json entry, e.g. ["--landscape"]. */
  buildArgs: string[];
}

export interface SilhouetteBuildResult {
  ok: boolean;
  /** Absolute path to the host build's directory, when ok. */
  distDir: string;
  /** The compiler's own last lines, when it failed. */
  error: string;
}

/**
 * `bun run pack:web:silhouette <name> --app <source> [...buildArgs]`, spawned
 * exactly as a person would run it, with its own output captured so a failure
 * carries the compiler's reason instead of an exit code.
 *
 * Not retried. Every other build call site in this repository retries around
 * a known zig wasm-link segfault (AGENTS.md), and this one deliberately does
 * not: a silhouette cell that only builds on the second attempt is a fact the
 * ledger should record rather than paper over, and the ledger re-runs the
 * whole cell on the next input change anyway.
 */
export function buildSilhouette(req: SilhouetteBuildRequest): SilhouetteBuildResult {
  const stem = req.source.split(/[\\/]/).pop()!.replace(/\.c$/, "");
  const distDir = join(ROOT, "packs", "web", "dist", "silhouettes", req.silhouette, stem);
  const args = ["run", "packs/web/wasm/build.ts", "--host", "--silhouette", req.silhouette, "--app", req.source, ...req.buildArgs];
  const result = Bun.spawnSync(["bun", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  if (!result.success) {
    const tail = [result.stdout?.toString() ?? "", result.stderr?.toString() ?? ""].join("\n").trim().split("\n").slice(-20).join("\n");
    return { ok: false, distDir, error: tail || `bun ${args.join(" ")} exited ${result.exitCode}` };
  }
  if (!existsSync(join(distDir, "index.html"))) {
    return { ok: false, distDir, error: `the build reported success but wrote no index.html to ${distDir}` };
  }
  return { ok: true, distDir, error: "" };
}

export type SilhouetteMark = "runs" | "build-failed" | "wrong-panel" | "blank" | "page-error";

export interface SilhouetteProofResult {
  mark: SilhouetteMark;
  reason: string;
  /** Repo-root-relative path to the written PNG, or null when there was nothing to write. */
  proof: string | null;
  /** The panel the MODULE declared, read back through the page. */
  declared: SilhouettePanel | null;
  /** The canvas the browser actually painted. */
  canvas: SilhouettePanel | null;
  /** Fraction of the panel that is not its own most common pixel value. */
  ink: number | null;
  /** The ghost buttons the page drew, from the module's own descriptor. */
  buttons: string[];
}

/** Below this, a frame is one flat colour with a rounding error on it, not a running app. */
const INK_FLOOR = 0.005;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serves one built silhouette directory, opens it, and runs the four
 * assertions above. `browser` is passed in rather than launched here: the
 * ledger drives twenty of these in a row and paying Chrome's startup twenty
 * times would dominate the run.
 */
export async function proveSilhouettePage(
  browser: Browser,
  distDir: string,
  panel: SilhouettePanel,
  proofPath: string,
  port: number
): Promise<SilhouetteProofResult> {
  const empty: SilhouetteProofResult = { mark: "page-error", reason: "", proof: null, declared: null, canvas: null, ink: null, buttons: [] };
  const server = serveDist(distDir, port);
  let page: Page | null = null;
  const pageErrors: string[] = [];
  try {
    page = await browser.newPage();
    page.on("pageerror", (e: unknown) => pageErrors.push(e instanceof Error ? e.message : String(e)));
    // Opened wide first, then sized exactly, because the size that makes the
    // canvas land at one device pixel per panel pixel depends on something
    // only the page can say. A LANDSCAPE APP OCCUPIES ITS PANEL SWAPPED: the
    // host presents a --landscape module rotated a quarter turn (see
    // packs/web/host/host.ts's Panel, and its data-landscape attribute), so
    // chrono on a 135x240 stick is a 240x135 canvas, and a rig that demanded
    // 135x240 would report a bug that only exists in the rig. The width is
    // then the wanted width plus the 8px the host reserves, which makes the
    // host's own fit scale exactly 1, and the height is generous so the fit
    // is never bound by it instead.
    await page.setViewport({ width: 1400, height: 1400, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await wait(1200);
    const rotated = await page.evaluate(() => document.body.dataset.landscape === "1");
    const wantW = rotated ? panel.h : panel.w;
    const wantH = rotated ? panel.w : panel.h;
    await page.setViewport({ width: wantW + 8, height: wantH + 260, deviceScaleFactor: 1 });
    await wait(2500);

    // The descriptor the MODULE returned, not the file on disk: instantiated
    // a second time here with the same nine math imports the host provides,
    // so a build against the wrong device.json cannot pass by agreeing with
    // whatever this process read.
    const declared = await page.evaluate(async () => {
      const url = document.body.dataset.module;
      if (!url) return null;
      const bytes = await (await fetch(url)).arrayBuffer();
      const nine = {
        sinf: Math.sin,
        cosf: Math.cos,
        atan2f: Math.atan2,
        sqrtf: Math.sqrt,
        fabsf: Math.abs,
        floorf: Math.floor,
        fmodf: (a: number, b: number) => a % b,
        powf: Math.pow,
        expf: Math.exp,
        js_log: () => {},
      };
      const { instance } = await WebAssembly.instantiate(bytes, { env: nine });
      const exports = instance.exports as unknown as { memory: WebAssembly.Memory; emu_init(): number; emu_device(): number };
      exports.emu_init();
      const memory = new Uint8Array(exports.memory.buffer);
      let end = exports.emu_device();
      const start = end;
      while (memory[end] !== 0) end++;
      const json = JSON.parse(new TextDecoder().decode(memory.subarray(start, end))) as {
        name?: string;
        panel: { w: number; h: number };
        buttons?: { id: string }[];
      };
      return { w: json.panel.w, h: json.panel.h, buttons: (json.buttons ?? []).map((b) => b.id) };
    });

    const painted = await page.evaluate(() => {
      const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return null;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // The most common pixel is the background whatever colour it is, so
      // this reads the same on a white drawing canvas and a black one.
      const histogram = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
        histogram.set(key, (histogram.get(key) ?? 0) + 1);
      }
      let top = 0;
      for (const n of histogram.values()) if (n > top) top = n;
      const total = data.length / 4;
      return { w: canvas.width, h: canvas.height, ink: total === 0 ? 0 : 1 - top / total, dataUrl: canvas.toDataURL("image/png") };
    });

    const buttons = declared?.buttons ?? [];
    if (!declared) return { ...empty, reason: "the page carries no module url, so nothing could be read back from it", buttons };
    if (!painted) return { ...empty, declared: { w: declared.w, h: declared.h }, reason: "the page painted no canvas#panel", buttons };

    // Written before any verdict below: a wrong picture is the most useful
    // thing a failing cell can leave behind.
    mkdirSync(dirname(proofPath), { recursive: true });
    writeFileSync(proofPath, Buffer.from(painted.dataUrl.split(",")[1]!, "base64"));
    const proof = proofPath.slice(ROOT.length + 1).replace(/\\/g, "/");

    const base: SilhouetteProofResult = {
      mark: "runs",
      reason: "",
      proof,
      declared: { w: declared.w, h: declared.h },
      canvas: { w: painted.w, h: painted.h },
      ink: painted.ink,
      buttons,
    };

    if (declared.w !== panel.w || declared.h !== panel.h) {
      return { ...base, mark: "wrong-panel", reason: `the module's own emu_device() declares ${declared.w}x${declared.h}, and this silhouette's device.json says ${panel.w}x${panel.h}` };
    }
    if (painted.w !== wantW || painted.h !== wantH) {
      const shape = rotated ? `${wantW}x${wantH} (this panel's ${panel.w}x${panel.h}, presented a quarter turn round because the app is a landscape one)` : `${wantW}x${wantH}`;
      return { ...base, mark: "wrong-panel", reason: `the painted canvas is ${painted.w}x${painted.h}, and this silhouette's device.json asks for ${shape}` };
    }
    if (pageErrors.length > 0) {
      return { ...base, mark: "page-error", reason: pageErrors[0]! };
    }
    if (painted.ink < INK_FLOOR) {
      return {
        ...base,
        mark: "blank",
        reason:
          `the app compiled, instantiated and painted this ${painted.w}x${painted.h} panel, and ${(100 - painted.ink * 100).toFixed(2)}% of it is one single colour. ` +
          `That is what an app with nothing to show yet looks like, and it is also what an app drawing at coordinates outside this panel looks like: the PNG beside this line is the only thing that tells the two apart`,
      };
    }
    // packs/web's host presents a --landscape module a quarter turn round
    // unconditionally, which is right for a portrait-native panel (the two
    // real packs, and the reference board this contract came from) and a
    // quarter turn out on a panel that is already landscape. Named on the
    // cell rather than treated as a failure: the app genuinely runs at this
    // panel's size and this is a fact about the pack's presentation, which
    // the gallery should say out loud rather than quietly show sideways.
    const sideways = rotated && panel.w > panel.h ? ", and this panel is already landscape, so the host's own quarter turn puts the app across the device's short side rather than along it" : "";
    return {
      ...base,
      reason: `${painted.w}x${painted.h}${rotated ? ` (this panel's ${panel.w}x${panel.h}, presented a quarter turn round)` : ""}, ${(painted.ink * 100).toFixed(1)}% of the panel painted, ghost buttons ${buttons.join(", ") || "none"}${sideways}`,
    };
  } catch (err) {
    return { ...empty, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (page) await page.close().catch(() => {});
    server.stop(true);
  }
}
