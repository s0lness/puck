// site/build.ts: builds the public gallery, site/dist/, the COMMITTED
// static output Cloudflare Pages serves as-is (no Pages-side build). This
// script is the only build step; site/dist/ is checked in.
//
// What it does, in order:
//   1. For every proven app+pack combo (from registry.json + each app's
//      bundle.json, not hand-listed twice), invoke that pack's own
//      wasm/build.ts with the arguments its port README documents. Every
//      pack build writes the SAME repo-root wasm/dist/emu.wasm (see each
//      pack's own build.ts header comment), so these run one at a time,
//      and each output is copied out to site/dist/modules/<combo>.wasm
//      before the next build overwrites it.
//   2. Runs the repo's own root build.ts (bun run build), which produces a
//      plain static bundle of the emulator page (index.html, main.js,
//      family-budget.css, app.css). Copied once into site/dist/emu/ and
//      shared by every run page: one bundle, loaded with a different
//      module each time via the ?module= hook (src/main.ts).
//   3. Writes one run page per combo (site/dist/run/<combo>.html): this
//      repository's own design, embedding the shared emulator bundle in an
//      iframe pointed at that combo's module.
//   4. Writes the gallery (site/dist/index.html) from the same
//      registry.json + bundle.json data used to decide which combos to
//      build, plus a small hand-written table of labels and GitHub doc
//      links (registry.json and bundle.json carry no prose).
//
// Idempotent: every step is deterministic (a compiled .wasm from the same
// C, a template rendered from the same data), so running this twice
// produces byte-identical site/dist/, no timestamps embedded anywhere.
//
// TypeScript only, no shell script, per this repo's own AGENTS.md.
import { existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
// Type-only, so nothing of tools/ledger.ts's own CLI is imported at
// runtime: the shapes below are the ledger's, declared once where it
// writes them rather than restated here where they would drift.
import type { Ledger, LedgerCell, LedgerTarget } from "../tools/ledger";
// The one thing this generator asks the emulator itself rather than
// restating: which declared panel formats it can actually present.
import { supportsPixelFormat } from "../src/panel";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
// The generator and the page agree on one sentence for "nobody has
// confirmed this yet", by importing it rather than by both spelling it out:
// the HTML ships with the empty state already in place (so a deployment
// with no /api/attest behind it never flashes a placeholder), and the
// client rewrites the same node once the counts arrive.
import { ATTEST_EMPTY_STATE } from "./attest-client";
import { spawnWithRetry } from "../tools/zigSpawn";
// The SAME table site/dist/flash/attest.js is built around
// (site/attest/checkers.ts). Imported here so buildAttestPlans can look
// a bundle's own checker path up at BUILD time and refuse to emit a plan
// the page could not run - the alternative is a button that loads, opens
// somebody's port, replays a trace on their board and then discovers it
// has nothing to check the result with.
import { INVARIANT_CHECKERS } from "./attest/checkers";
import type { DeviceDescriptor } from "../src/wasm";

const SITE_DIR = import.meta.dir;
const REPO_ROOT = resolve(SITE_DIR, "..");
const DIST = join(SITE_DIR, "dist");
const GITHUB_BASE = "https://github.com/s0lness/puck/blob/master";

function gh(path: string): string {
  return `${GITHUB_BASE}/${path}`;
}

// ---- content-hash cache busting ------------------------------------------
// Every asset URL this generator emits is otherwise stable across a deploy
// (same filename every build), which is exactly what let Safari go on
// serving a PREVIOUS deploy's emu/main.js, emu/app.css and styles.css after
// a new one shipped (Sylve's own iPhone report: a new hint line rendering
// next to an old, already-fixed layout bug - two different deploys'
// output, stitched together by a cache that had no reason to refetch
// anything). First 10 hex chars of the CONTENT's own sha256, not a build
// timestamp: deterministic given the same bytes, so two consecutive builds
// with no source changes emit byte-identical query strings (this file's own
// idempotency contract) - a clock-based cache-buster would fail that.
function contentHashOf(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 10);
}
function withVersion(url: string, hash: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${hash}`;
}

// ---- read the data that decides what gets built -------------------------
interface Registry {
  packs: { name: string; path: string }[];
  // Silhouettes are their own array, never mixed into packs: a silhouette
  // satisfies none of a pack's required contents (docs/convention/
  // device-pack.md). This generator reads their device.json for the same
  // four things it reads a pack's for, and nothing else.
  silhouettes?: { name: string; path: string }[];
  // An app entry is EITHER local ({name,path}) or external, published in
  // its own repository ({name,url} - docs/convention/app-bundle.md's own
  // registry convention). `path` is therefore optional here, unlike the
  // old (pre-existing, unrelated to this file's own gameos work) shape
  // that assumed every entry had one and crashed reading
  // registry.json's own "aliceisjustplaying/tinydraw" url-only entry.
  apps: { name: string; path?: string; url?: string }[];
}
// Schema v0.2 (docs/convention/app-bundle.md): one "ports" entry per pack
// this app is proven on, replacing 0.1's loose "provenPacks" array. Read
// generically here (verification only down to its "kind" discriminator,
// the two shapes' own extra fields are the verifier's concern, not the
// site generator's) so this file never has to know the difference between
// a pixel-exact port and an invariants one beyond that one label.
interface BundlePort {
  pack: string;
  mode: string;
  // Read down to the "kind" discriminator plus the fields the attestation
  // step needs to emit a plan of that kind: a pixel-exact port's traces and
  // recorded-frame directory, or an invariants port's checker, trace and
  // capture points. All optional here because the two shapes carry
  // different ones, and this generator has to read both without knowing
  // which it has until it looks at "kind".
  verification: { kind: string; traces?: string[]; frames?: string; checker?: string; trace?: string; captureAt?: number[] };
  source: string;
  // Optional, beyond the bundle schema's minimal shape (documented in
  // app-bundle.md alongside "buildArgs"): the porting flow's own
  // go/degraded/refuse verdict (docs/convention/app-bundle.md's "Porting
  // flow"), carried through so a degraded port (fluidbox's touch-and-
  // fixed-gravity rp2350 port) still reads as degraded here, the way 0.1's
  // per-pack "degraded" boolean used to.
  verdict?: "go" | "degraded";
  // Present once a port has been run against real hardware, not only the
  // emulator (docs/convention/app-bundle.md): an attestation, not an
  // automatic guarantee. Drives the matrix's second mark, below.
  silicon?: { attestedAt: string; how: string };
}
interface ChronoLikeBundle {
  convention: string;
  name: string;
  ports: BundlePort[];
}
interface ProvenEntry {
  pack: string;
  mode: string;
  verification: string;
  degraded: boolean;
  // A pixel-exact port's own inputs: the traces to replay, and the
  // directory holding the frames to diff against.
  traces: string[] | null;
  framesDir: string | null;
  // An invariants port's own inputs: the checker that owns the checks, the
  // trace to replay, and the moments the checker's contract is written
  // against. A port has one set or the other, never both.
  checker: string | null;
  invariantTrace: string | null;
  captureAt: number[] | null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const registry = readJson<Registry>(join(REPO_ROOT, "registry.json"));

const packLabel = new Map<string, string>();
// Panel dimensions per pack, read from the SAME device.json packLabel
// already reads (not a second file read) - what sizes each run page's
// embed iframe below, so a run page never hardcodes one device's pixel
// size the way the shared instrument itself is forbidden to (AGENTS.md's
// "nothing names one device" is about src/server.ts/harness/, not this
// site generator, but staying data-driven here costs nothing and avoids a
// magic number per pack anyway).
const packPanel = new Map<string, { w: number; h: number }>();
const packHasVectorSensor = new Map<string, boolean>();
// A device's own buttons (edge + fractional position along it), read from
// the SAME device.json as panel/label above: what site/build.ts's own CSS
// device frame (renderCardDevice, below) draws around the panel-only demo
// video, so the détouré card reads as the same device the run page embeds
// rather than a generic rounded rectangle. Real device geometry (nub
// length/thickness/protrusion) mirrors src/device.ts's
// BTN_LENGTH_PX/BTN_THICKNESS_PX/BTN_OFFSET_PX (restated below, same
// "small enough that a shared constants module is more indirection than
// the number" reasoning as BEZEL_PAD itself already documents).
interface PackButton {
  edge: "left" | "right" | "top" | "bottom";
  at: number;
}
const packButtons = new Map<string, PackButton[]>();
// Silhouettes go into the SAME four maps as real packs, deliberately: a
// silhouette run page is written by the same writeRunPage(), sized by the
// same embedFrameSize(), and framed by the same cardDeviceGeometry(), which
// is only possible because none of those three ever asks whether a target
// has firmware. That is the whole "a silhouette runs, it does not draw"
// claim, spelled out in code rather than in prose.
// The whole device.json, kept as read, for the ONE consumer that needs more
// than a field or two of it: an invariants attestation plan carries it as
// the checker's own meta.device, because a checker reads the device the
// same way every other consumer in this repository does (a checker may key
// a bound on the device's name - fluidbox does) and a board reports only
// its panel geometry over devlink. The pack's own declaration is what the
// firmware was built against, and the page checks the board against it.
const packDevice = new Map<string, DeviceDescriptor>();
for (const p of [...registry.packs, ...(registry.silhouettes ?? [])]) {
  const device = readJson<{
    name?: string;
    panel?: { w: number; h: number };
    sensors?: { id: string; kind: string }[];
    buttons?: { edge: "left" | "right" | "top" | "bottom"; at: number }[];
  }>(join(REPO_ROOT, p.path, "device.json"));
  packDevice.set(p.name, readJson<DeviceDescriptor>(join(REPO_ROOT, p.path, "device.json")));
  packLabel.set(p.name, device.name || p.name);
  if (device.panel) packPanel.set(p.name, device.panel);
  packHasVectorSensor.set(p.name, (device.sensors || []).some((sensor) => sensor.kind === "vector" || sensor.kind === "gravity"));
  packButtons.set(p.name, (device.buttons || []).map((b) => ({ edge: b.edge, at: b.at })));
}

// src/app.css's --bezel-pad, and site/record-demos.ts's own BEZEL_PAD (same
// source of truth, restated in each file since neither imports the other -
// this repo's device geometry values are small enough that a shared
// constants module would be more indirection than the number itself). Read
// by cardDeviceGeometry below, which draws the landing cards' own CSS
// device frame at this same proportion.
const BEZEL_PAD = 18;
// src/device.ts's own BTN_LENGTH_PX / BTN_THICKNESS_PX (a third
// restatement of the same small geometry constants, for the same reason
// as BEZEL_PAD above): a button nub is 56px along its edge, 14px thick.
// Real hardware protrudes past the bezel's own edge (BTN_OFFSET_PX in
// src/device.ts) - the card frame does NOT reproduce that protrusion
// (see cardDeviceGeometry's own header): a nub is drawn flush, INSET
// inside the bezel's own edge instead, so the bezel itself can span the
// card's full width with nothing left over for a protruding button to
// clip against.
const BTN_LENGTH_PX = 56;
const BTN_THICKNESS_PX = 14;

// The full on-page geometry for one détouré landing card: a device bezel
// drawn entirely in CSS, filling the card's own full width (Sylve's own
// read: the device should be as big as the text block below it, not
// sitting in a smaller box with margin around it), with the recorded
// video filling only the rectangular panel inside it. Every number here
// is a PERCENTAGE of some containing box, never a pixel, so the same card
// renders correctly at any width a responsive grid gives it - the actual
// recorded clip is cropped to #panel alone (site/record-demos.ts), a
// plain rectangle with no background pixels, so the only thing that can
// ever look "not-detoure" is this CSS frame itself now, not a recording
// artifact.
interface CardDeviceGeometry {
  bezelW: number; // bezel's own real px size (== the card's own aspect-ratio)
  bezelH: number;
  bezelRadius: string; // border-radius, as an inline CSS value (the bezel itself is a fixed 100%/100% via styles.css's .card-bezel rule)
  panelStyle: string; // left/top/width/height/border-radius, as inline CSS, relative to the bezel box
  buttonsHtml: string; // one <span class="card-btn"> per declared button
  panelW: number; // real panel px, for the aspect-ratio sanity check a verify script does
  panelH: number;
}

// Edge a button visually ends up on after the SAME -90deg (CCW) quarter
// turn every chrono run page auto-applies (writeRunPage's own autoRotate,
// site/record-demos.ts's chrono preroll clicking the same button) - a
// physical rotation swaps which edge each side of the rectangle occupies:
// picture a clock face turned 90deg counterclockwise, the mark at 3
// o'clock (right) ends up at 12 (top), 12 ends up at 9 (left), and so on.
// Exact left/right ORDER along the new edge is not preserved (not derived
// here), which is fine: a .card-btn nub carries no label, so two
// unlabelled nubs on the same edge read identically regardless of which
// is which - only which EDGE they protrude from matters for "reads as the
// same device."
const EDGE_AFTER_QUICK_ROTATE: Record<PackButton["edge"], PackButton["edge"]> = {
  right: "top",
  top: "left",
  left: "bottom",
  bottom: "right",
};

function cardDeviceGeometry(pack: string, rotated: boolean): CardDeviceGeometry {
  const rawPanel = packPanel.get(pack) || { w: 368, h: 448 };
  // rotated: the card's own recorded clip is landscape (site/record-demos.ts's
  // chrono preroll clicks the same -90deg quick-rotate the run page
  // auto-applies, BEFORE the screencast starts), so the CSS frame drawn
  // around it has to be landscape too, panel dimensions and button edges
  // both swapped, or a landscape video would sit inside a portrait-shaped
  // panel box.
  const panel = rotated ? { w: rawPanel.h, h: rawPanel.w } : rawPanel;
  const rawButtons = packButtons.get(pack) || [];
  const buttons = rotated ? rawButtons.map((b) => ({ edge: EDGE_AFTER_QUICK_ROTATE[b.edge], at: b.at })) : rawButtons;
  const bezelW = panel.w + 2 * BEZEL_PAD;
  const bezelH = panel.h + 2 * BEZEL_PAD;

  const pct = (n: number, denom: number) => `${((n / denom) * 100).toFixed(3)}%`;
  // 34px / 6px are src/app.css's own .bezel / .panel border-radius at the
  // reference RP2350 bezel width (404px) and panel width (368px); scaled
  // by the SAME ratio here so a smaller instrument panel (example: 240px)
  // still gets a proportionally similar corner, not a fixed pixel radius
  // that would look sharp-cornered at card scale or blobby at full size.
  const bezelRadius = pct(34, bezelW);
  const panelRadius = pct(6, panel.w);
  const panelStyle = `left:${pct(BEZEL_PAD, bezelW)};top:${pct(BEZEL_PAD, bezelH)};width:${pct(panel.w, bezelW)};height:${pct(panel.h, bezelH)};border-radius:${panelRadius}`;

  const buttonsHtml = buttons
    .map((b) => {
      const alongEdge = b.edge === "left" || b.edge === "right";
      const bezelAlongAxis = alongEdge ? bezelH : bezelW; // the axis the button's LENGTH runs along
      const bezelAcrossAxis = alongEdge ? bezelW : bezelH; // the axis its THICKNESS runs along
      const offset = Math.max(0, b.at) * Math.max(0, bezelAlongAxis - BTN_LENGTH_PX);
      const along = pct(offset, bezelAlongAxis);
      const length = pct(BTN_LENGTH_PX, bezelAlongAxis);
      const thickness = pct(BTN_THICKNESS_PX, bezelAcrossAxis);
      // 0, not a negative protrusion: the bezel fills the card's own full
      // width now (styles.css's .card-bezel, 100%/100% of .thumb), so
      // there is no silhouette margin left for a button to protrude INTO
      // without .card's own overflow:hidden clipping it. Drawn flush
      // against the bezel's own edge instead - a "simplified but
      // faithful" nub, per this task's own original brief, still reads
      // as a button in the right place on the right edge.
      return alongEdge
        ? `<span class="card-btn" style="${b.edge}:0;top:${along};width:${thickness};height:${length}"></span>`
        : `<span class="card-btn" style="${b.edge}:0;left:${along};height:${thickness};width:${length}"></span>`;
    })
    .join("");

  return { bezelW, bezelH, bezelRadius, panelStyle, buttonsHtml, panelW: panel.w, panelH: panel.h };
}

// ---- the ledger, which is now what decides everything on this page ------
// ledger.json (tools/ledger.ts, `bun run ledger`) is a RESULTS document:
// every app in registry.json against every target in it, with the verdict,
// the emulator mark, the host mark, the attestation key and the silhouette
// mark for each pair. This generator used to walk each bundle.json and
// render whatever it found listed there, which meant the page could only
// ever show what had worked - an unported app, a device with no firmware,
// and an external bundle whose build was red all had exactly the same
// representation, which was none at all. See
// docs/decisions/0012-the-gallery-is-built-from-a-ledger.md.
//
// The ONE thing still read out of a bundle.json below is an attestable
// port's own trace files and recorded-frame directory (buildAttestPlans).
// Those are inputs a flash page needs to hand a board, not results about a
// port, so they belong to the bundle and not to a document of outcomes.
// bundle.json's `silicon` block is no longer read anywhere in site/: the
// counter comes from GET /api/attest, keyed by the string the ledger
// stores (docs/decisions/0011).
const LEDGER_PATH = join(REPO_ROOT, "ledger.json");
if (!existsSync(LEDGER_PATH)) {
  throw new Error(`site/build.ts: no ledger.json at the repository root. Run \`bun run ledger\` first: this page is built from it, not from the bundles.`);
}
const ledger = readJson<Ledger>(LEDGER_PATH);

function cellFor(app: string, target: string): LedgerCell | undefined {
  return ledger.cells[`${app}:${target}`];
}

interface AppEntry {
  name: string;
  /** null for an app published in its own repository. */
  path: string | null;
  url: string | null;
  /** "reproduced from <repo>@<sha> on <date>", for an external bundle. */
  provenance: string | null;
  external: boolean;
  /** Every local pack this app declares a port for, in the ledger's own target order. */
  proven: ProvenEntry[];
}

// Local apps first, then the ones published in their own repositories. Not
// registry.json's own order, which happens to put the external bundle at
// the top: the rows a reader recognises come first and the one that needs
// its provenance explained comes last, where the note under the table is.
const ledgerApps = [...ledger.apps.filter((a) => a.kind === "local"), ...ledger.apps.filter((a) => a.kind !== "local")];

const apps: AppEntry[] = ledgerApps.map((a) => {
  const proven: ProvenEntry[] = [];
  for (const target of ledger.targets) {
    if (target.kind !== "pack") continue;
    const cell = cellFor(a.name, target.name);
    if (!cell || !cell.port) continue;
    const bundlePath = a.path ? join(REPO_ROOT, a.path, "bundle.json") : null;
    const bundlePort = bundlePath ? readJson<ChronoLikeBundle>(bundlePath).ports.find((p) => p.pack === target.name) : undefined;
    proven.push({
      pack: target.name,
      mode: cell.port.mode,
      verification: cell.port.verification,
      degraded: cell.port.declaredVerdict === "degraded",
      traces: bundlePort?.verification.kind === "pixel-exact" && Array.isArray(bundlePort.verification.traces) ? bundlePort.verification.traces : null,
      framesDir: bundlePort?.verification.kind === "pixel-exact" && bundlePort.verification.frames ? bundlePort.verification.frames : null,
      checker: bundlePort?.verification.kind === "invariants" && bundlePort.verification.checker ? bundlePort.verification.checker : null,
      invariantTrace: bundlePort?.verification.kind === "invariants" && bundlePort.verification.trace ? bundlePort.verification.trace : null,
      captureAt:
        bundlePort?.verification.kind === "invariants" && Array.isArray(bundlePort.verification.captureAt)
          ? bundlePort.verification.captureAt
          : null,
    });
  }
  return { name: a.name, path: a.path, url: a.url, provenance: a.provenance, external: a.kind !== "local", proven };
});

// ---- the one piece of prose this data cannot carry: how to build each
// proven combo's module, and which doc on GitHub explains that specific
// port. Keyed by "app:pack" and cross-checked against the proven combos
// derived above, so an app+pack this table doesn't know how to build fails
// the build loudly instead of silently skipping a proof the gallery claims.
interface ComboBuild {
  script: string; // relative to REPO_ROOT
  args: string[];
  portDoc: string; // relative to REPO_ROOT, linked on GitHub
  blurb: string; // one line, shown on the run page
}
const COMBO_BUILD: Record<string, ComboBuild> = {
  "chrono:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: [],
    portDoc: "packs/rp2350-touch-amoled-18/firmware/apps/README.md",
    blurb: "Chrono's native home: one of the three apps this pack's own firmware ships, built with no --app override.",
  },
  "chrono:esp32-s3-touch-amoled-18": {
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c"],
    portDoc: "apps/chrono/ports/esp32-s3-touch-amoled-18/README.md",
    blurb: "The same descriptor, ported to a second board with no persistent framebuffer. Pixel-identical to the reference, verified capture by capture.",
  },
  "fluidbox:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c", "--shake"],
    portDoc: "apps/fluidbox/ports/rp2350-touch-amoled-18/README.md",
    blurb: "Ported down from a 900-particle, dual-core donor to 130 particles, single core: the interaction surface changed (fixed gravity, a touch stir), so this is verified by invariants, not pixel identity.",
  },
  "fluidbox:esp32-s3-touch-amoled-18": {
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/fluidbox/ports/esp32-s3-touch-amoled-18/fluid.c"],
    portDoc: "apps/fluidbox/ports/esp32-s3-touch-amoled-18/README.md",
    blurb: "The app coming home: the donor firmware was written for this exact board, and this is it returning through the convention, repainted 28 rows at a time on a device with no framebuffer.",
  },
  "chrono:web": {
    script: "packs/web/wasm/build.ts",
    args: ["--app", "apps/chrono/ports/web/chrono.c", "--landscape"],
    portDoc: "apps/chrono/ports/web/README.md",
    blurb: "The same source as the RP2350 reference, minus its app_t: pixel-identical to the board on both traces, running on the browser as a target device.",
  },
  "fluidbox:web": {
    script: "packs/web/wasm/build.ts",
    args: ["--app", "apps/fluidbox/ports/web/fluid.c", "--shake"],
    portDoc: "apps/fluidbox/ports/web/README.md",
    blurb: "The RP2350 port's file, byte for byte, on a device that finally has the accelerometer the app asks for: tilt the phone and the liquid pours.",
  },
  "tinydraw:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/tinydraw/ports/rp2350-touch-amoled-18/tinydraw.c"],
    portDoc: "apps/tinydraw/ports/rp2350-touch-amoled-18/README.md",
    blurb: "A from-scratch reimplementation of the donor's ink+zoom+undo essence, sized to a 65536-byte app arena: two fixed zoom levels instead of a continuous pannable camera, one-stroke undo instead of ten tile-based slots.",
  },
  "tinydraw:web": {
    script: "packs/web/wasm/build.ts",
    args: ["--app", "apps/tinydraw/ports/web/tinydraw.c"],
    portDoc: "apps/tinydraw/ports/web/README.md",
    blurb: "The RP2350 port's file, byte for byte, on a device with no SRAM budget of its own: the pack still vendors the same 65536-byte app arena contract, so the same reductions apply on their own merits.",
  },
  "tinydraw:esp32-s3-touch-amoled-18": {
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/tinydraw/ports/esp32-s3-touch-amoled-18/tinydraw.c"],
    portDoc: "apps/tinydraw/ports/esp32-s3-touch-amoled-18/README.md",
    blurb: "The third board for the same two-level, one-undo reduction: a fresh implementation against a device with no framebuffer, repainting 28 rows at a time, holding the same 65536-byte app arena contract as its siblings.",
  },
  "gameos:esp32-s3-touch-amoled-18": {
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c", "--wasm-memory-mb", "8"],
    portDoc: "apps/gameos/ports/esp32-s3-touch-amoled-18/README.md",
    blurb: "gameos, born on this chip family, running its own real engine AND its own real shell: core.c, gfx.c, input.c, all three games, and the donor's own launcher grid/settings/pause-overlay (registry.c/apps.c/shell.c) all compiled unmodified against a thin compat shim (GOLF's own font and several-megabyte world state each got one declared substitution - see that port's own NOTICE.md), its indexed-framebuffer present pass repainted 28 rows at a time on a device with no framebuffer.",
  },
  "gameos:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/gameos/ports/rp2350-touch-amoled-18/gameos_port.c"],
    portDoc: "apps/gameos/ports/rp2350-touch-amoled-18/README.md",
    blurb: "The cross-chip port: a from-scratch reimplementation of the same gos.h contract, most of the two games' own code still vendored byte for byte, one 150MHz core doing the game logic, software rasterization AND the 2x upscale the donor's own second core and DMA hardware share.",
  },
};

// The one pack whose run page is not an embedded emulator but the app
// itself. Its build script has a --host mode that emits a standalone,
// installable directory (packs/web/wasm/build.ts), and this generator
// serves that directory at /web/<app>/ instead of writing a run/<id>.html
// around an iframe. Named once here rather than tested for by string in
// four places.
const WEB_PACK = "web";

// Where a visitor should go to run a given combo. Every caller goes
// through this, so the landing page's cards, the proof matrix's cells and
// any future link all agree about where a web combo actually lives.
function comboHref(combo: Combo, depth: "" | "../"): string {
  return combo.pack === WEB_PACK ? `${depth}web/${combo.app}/` : `${depth}run/${combo.id}.html`;
}

// The instrument's own minimal reference firmware (example/firmware/main.c,
// docs/decisions/0001-example-is-minimal-not-a-shim.md), built and embedded
// live the same way every proven combo is: not a device pack (no CMake, no
// real board), not a ported app - this is what a new firmware author
// targeting this instrument for the first time starts from. Panel size is
// a plain literal here, not read from a device.json (example/ has none;
// AGENTS.md's "nothing names one device" rule exempts example/ by name for
// exactly this reason - it is real, minimal, single-purpose firmware, not
// shared instrument code).
const INSTRUMENT_EXAMPLE = {
  id: "example",
  name: "puck-example",
  script: "example/build.ts",
  args: [] as string[],
  doc: "example/firmware/main.c",
  panel: { w: 240, h: 240 },
  // example/firmware/main.c's own emu_device() string literal (grepped, not
  // guessed): button "a" right edge at 0.5 with an 800ms long press, "b"
  // left edge at 0.5. Hand-restated here for the same reason the panel
  // size above already is: example/ has no device.json for this file to
  // read, and AGENTS.md's "nothing names one device" rule exempts example/
  // by name for exactly this reason.
  buttons: [
    { edge: "right", at: 0.5 },
    { edge: "left", at: 0.5 },
  ] as PackButton[],
  blurb: "The instrument's own minimal reference firmware: a 240x240 panel, two buttons (one with a long-press verdict), a shake sensor, and a scripted two-button chord. Not a device pack, not a ported app - the smallest complete emu_device() implementation, and where a new firmware author starts.",
};
// Registered into the SAME lookup maps every real pack uses (never into
// registry.packs itself, so it never appears in the proof matrix, which
// iterates registry.packs specifically) - this is what lets writeRunPage/
// embedFrameSize/renderCardDevice below treat "example" as just another
// pack id with no special-casing of its own.
packLabel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.name);
packPanel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.panel);
packHasVectorSensor.set(INSTRUMENT_EXAMPLE.id, false);
packButtons.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.buttons);

// A fourth card that is not part of the proof matrix at all: the ESP32-S3
// pack's own shipped reference app, included per this site's brief as a
// fourth "reference app" tile (a device pack proving itself, not a ported
// app).
interface ReferenceApp {
  id: string;
  name: string;
  pack: string;
  script: string;
  args: string[];
  doc: string;
  blurb: string;
}
const REFERENCE_APPS: ReferenceApp[] = [
  {
    id: "esp32-demo",
    name: "demo",
    pack: "esp32-s3-touch-amoled-18",
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: [],
    doc: "packs/esp32-s3-touch-amoled-18/firmware/apps/demo.c",
    blurb: "A bouncing square: the pack's own reference app, proving its band-render contract with nothing borrowed from another device.",
  },
];

function comboId(app: string, pack: string): string {
  const short = pack.split("-")[0]; // "rp2350" / "esp32"
  return `${app}-${short}`;
}

interface Combo {
  id: string;
  app: string;
  appPath: string;
  pack: string;
  build: ComboBuild;
  proven: ProvenEntry;
}
const combos: Combo[] = [];
for (const app of apps) {
  for (const entry of app.proven) {
    const key = `${app.name}:${entry.pack}`;
    const build = COMBO_BUILD[key];
    if (!build) {
      throw new Error(
        `site/build.ts has no COMBO_BUILD entry for "${key}", but ledger.json records a port for it. ` +
          `Add one (script, args, portDoc, blurb) or this gallery would silently under-claim what's proven.`
      );
    }
    combos.push({ id: comboId(app.name, entry.pack), app: app.name, appPath: app.path!, pack: entry.pack, build, proven: entry });
  }
}

// ---- silhouette cells that actually run get a run page of their own ----
// The roadmap's workstream 3 in one object: a device nobody has written
// firmware for, running the app's real C at that board's real size. The
// module is built by packs/web's own build.ts against the silhouette's
// device.json (`--silhouette <name>`, MODULE mode, not the host mode the
// ledger proves with), and everything downstream is the ordinary run-page
// path: the same shared emulator bundle, the same iframe, the same chrome
// built from emu_device() at runtime. Nothing here knows a silhouette from
// a pack, which is exactly the claim.
//
// ONLY THE CELLS THE LEDGER SAYS RUN. A cell whose module never built, or
// whose page threw, or whose canvas came out the wrong size, gets no link:
// the matrix says what happened instead. A cell that built and instantiated
// but painted one flat colour (BLANK) also gets no page, because the one
// thing a visitor would come to that page to see is not there.
interface SilhouetteCombo {
  id: string;
  app: string;
  appPath: string | null;
  silhouette: string;
  source: string;
  buildArgs: string[];
  /** Which pack's own port file was borrowed, when it was not this app's web port. */
  via: string;
  panel: { w: number; h: number };
}
const silhouetteCombos: SilhouetteCombo[] = [];
// A silhouette this repository can put on a run page at all. The shared
// emulator blits a framebuffer through a reader chosen by the panel's
// declared format (src/panel.ts), and it has readers for the two 16-bit
// ones the packs here declare and for nothing else. packs/web's own
// framebuffer is RGB565 whatever a device.json calls its glass, so an app
// compiled against a monochrome silhouette really does run in the pack's
// host page (which never asks) and really cannot be presented by the
// emulator (which does, correctly: a module claiming mono1 and handing over
// 16-bit pixels is a module lying about itself, and that is worth refusing).
// The matrix says so on the cell rather than linking to a page that would
// fail on open.
function emulatorCanPresent(target: LedgerTarget): boolean {
  return target.panel ? supportsPixelFormat(target.panel.format) : false;
}
const silhouettePages = new Set<string>();
for (const app of apps) {
  for (const target of ledger.targets) {
    if (target.kind !== "silhouette") continue;
    const cell = cellFor(app.name, target.name);
    if (!cell || cell.silhouette.mark !== "runs" || !cell.silhouette.source || !cell.silhouette.panel) continue;
    if (!emulatorCanPresent(target)) continue;
    silhouettePages.add(`${app.name}:${target.name}`);
    silhouetteCombos.push({
      id: `${app.name}-${target.name}`,
      app: app.name,
      appPath: app.path,
      silhouette: target.name,
      source: cell.silhouette.source,
      buildArgs: cell.silhouette.buildArgs,
      via: cell.silhouette.via ?? "web",
      panel: cell.silhouette.panel,
    });
  }
}

// ---- 1. build every combo's module, one at a time (shared wasm/dist/emu.wasm output) ----
const REPO_WASM_OUT = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
const MODULES_DIR = join(DIST, "modules");

// Retried here too, not just inside packs/rp2350-touch-amoled-18/wasm/build.ts's own loop.
// That pack's own build.ts already retries internally (via
// tools/zigSpawn.ts, as does every other pack and test build script now -
// see that file's header comment for the measurement: `zig cc` on this
// machine can exit non-zero having written a complete, correct module, and
// piped stdio plus an artifact check is what tells that apart from a real
// compile error). This function invokes each of those scripts as a CHILD
// PROCESS in turn - without a retry HERE too, a whole `bun run site:build`
// fails on a single flaky exit from underneath, for a reason that has
// nothing to do with the site itself.
//
// No artifact check at this outer layer (tools/zigSpawn.ts's
// `spawnWithRetry`, not `runZigCc`): the module every combo's build writes
// to, REPO_WASM_OUT, is a SHARED path rewritten by every combo in turn, so
// "the file exists and is non-empty" would still be true here after a
// genuine failure, left over from whichever combo built successfully
// moments before - checking it would silently turn that failure into a
// false success. What IS safe to reuse from that same helper: piped
// stdio (so a child spawned while this process's own stdout is itself a
// pipe cannot die silently the same way), and retrying only a run that
// printed no diagnostics at all - a real error from the child script
// (which already ran its own internal zig retries before giving up) is
// reported immediately rather than retried four more times for nothing.
const BUILD_MAX_ATTEMPTS = 4;

function runBuild(script: string, args: string[]): void {
  console.log(`\n--- building: bun run ${script} ${args.join(" ")}`);
  const result = spawnWithRetry(["bun", "run", script, ...args], {
    cwd: REPO_ROOT,
    maxAttempts: BUILD_MAX_ATTEMPTS,
  });
  if (!result.ok) {
    throw new Error(
      result.stderr.trim().length > 0
        ? `build failed: bun run ${script} ${args.join(" ")} (see diagnostics above)`
        : `build failed: bun run ${script} ${args.join(" ")} (exit ${result.exitCode}) on all ${result.attempts} attempts with no diagnostic text`
    );
  }
}

function buildAllModules(): void {
  mkdirSync(MODULES_DIR, { recursive: true });
  for (const c of combos) {
    runBuild(c.build.script, c.build.args);
    if (!existsSync(REPO_WASM_OUT)) throw new Error(`${c.build.script} did not write ${REPO_WASM_OUT}`);
    copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${c.id}.wasm`));
    console.log(`copied -> site/dist/modules/${c.id}.wasm`);
  }
  for (const r of REFERENCE_APPS) {
    runBuild(r.script, r.args);
    if (!existsSync(REPO_WASM_OUT)) throw new Error(`${r.script} did not write ${REPO_WASM_OUT}`);
    copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${r.id}.wasm`));
    console.log(`copied -> site/dist/modules/${r.id}.wasm`);
  }
  runBuild(INSTRUMENT_EXAMPLE.script, INSTRUMENT_EXAMPLE.args);
  if (!existsSync(REPO_WASM_OUT)) throw new Error(`${INSTRUMENT_EXAMPLE.script} did not write ${REPO_WASM_OUT}`);
  copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${INSTRUMENT_EXAMPLE.id}.wasm`));
  console.log(`copied -> site/dist/modules/${INSTRUMENT_EXAMPLE.id}.wasm`);

  for (const s of silhouetteCombos) {
    runBuild("packs/web/wasm/build.ts", ["--silhouette", s.silhouette, "--app", s.source, ...s.buildArgs]);
    if (!existsSync(REPO_WASM_OUT)) throw new Error(`the silhouette build for ${s.id} did not write ${REPO_WASM_OUT}`);
    copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${s.id}.wasm`));
    console.log(`copied -> site/dist/modules/${s.id}.wasm`);
  }
}

// ---- 1.2. the web pack's own app pages -----------------------------------
// Unlike every other run page, these are not this generator's HTML wrapped
// around an iframe: they are the pack's OWN host build, emitted whole by
// packs/web/wasm/build.ts --host. The distinction is the point of the pack.
// A chip's run page can only ever be a window onto an emulator, because the
// chip is not here; a browser IS here, so /web/chrono/ is not a preview of
// chrono on the web, it is chrono on the web - full viewport, installable,
// and offline once installed.
//
// Everything inside those directories (the module's and the host bundle's
// content-hashed filenames, the service worker's cache name) is produced by
// the pack, not by this file, so cache-busting there follows the pack's own
// rule rather than this generator's ?v= convention. Both are content
// hashes; only the shape differs, because a service worker keys its cache
// on a URL and a query string is a poor cache key for one.
function buildWebApps(): void {
  for (const c of combos) {
    if (c.pack !== WEB_PACK) continue;
    const outDir = join(DIST, "web", c.app);
    runBuild(c.build.script, [
      ...c.build.args,
      "--host",
      "--out",
      outDir,
      "--title",
      c.app,
      // From /web/<app>/index.html back to the gallery root. The pack has
      // no idea where it is deployed, so the link is an argument.
      "--gallery",
      "../../",
    ]);
    if (!existsSync(join(outDir, "index.html"))) {
      throw new Error(`${c.build.script} --host did not write ${join(outDir, "index.html")}`);
    }
    console.log(`built -> site/dist/web/${c.app}/`);
  }
}

// ---- 1.5. flash artifacts + the WebUSB flasher's own bundled JS --------
// The two verified RP2350 UF2s live in site/flash-artifacts/ (tracked,
// source), never directly in site/dist/flash/ (untracked build output):
// this step's whole job is making sure a clean rebuild (which rm -rf's
// DIST first, see "run everything" below) never deletes the artifacts, it
// only ever regenerates a copy of them.
const FLASH_ARTIFACTS_SRC = join(SITE_DIR, "flash-artifacts");

// The ESP32-S3 artifacts sit one level down, in their own directory, because
// they come with an index: three parts merged into one image per combo plus a
// manifest.json naming the chip, the flash parameters and each image's MD5
// (written by packs/esp32-s3-touch-amoled-18/tools/build-native.ts). The
// RP2350's .uf2 needs none of that - a UF2 file carries its own load
// addresses - which is why one board's artifacts are bare files and the
// other's are a directory.
const ESP32_ARTIFACTS_SRC = join(FLASH_ARTIFACTS_SRC, "esp32");
const ESP32_MANIFEST_NAME = "manifest.json";

function copyFlashArtifacts(): void {
  const flashDir = join(DIST, "flash");
  mkdirSync(flashDir, { recursive: true });
  for (const name of readdirSync(FLASH_ARTIFACTS_SRC)) {
    if (!name.endsWith(".uf2")) continue;
    copyFileSync(join(FLASH_ARTIFACTS_SRC, name), join(flashDir, name));
    console.log(`copied -> site/dist/flash/${name}`);
  }
  if (!existsSync(ESP32_ARTIFACTS_SRC)) return;
  const esp32Dir = join(flashDir, "esp32");
  mkdirSync(esp32Dir, { recursive: true });
  for (const name of readdirSync(ESP32_ARTIFACTS_SRC)) {
    if (!name.endsWith(".bin") && name !== ESP32_MANIFEST_NAME) continue;
    copyFileSync(join(ESP32_ARTIFACTS_SRC, name), join(esp32Dir, name));
    console.log(`copied -> site/dist/flash/esp32/${name}`);
  }
}

// Which ESP32 images exist, read from the artifact index rather than listed
// here a second time: build-native.ts's --id IS the combo id, so a combo has a
// browser-flashable image exactly when the manifest has an entry under its
// own name. Nothing to keep in sync, and a run page can never advertise a
// button for a file that was never built.
interface Esp32ManifestEntry {
  file: string;
  bytes: number;
  app: string;
  builtAt: string;
}
interface Esp32ManifestShape {
  chip: string;
  flashSize: string;
  images: Record<string, Esp32ManifestEntry>;
}

function readEsp32Manifest(): Esp32ManifestShape | null {
  const path = join(ESP32_ARTIFACTS_SRC, ESP32_MANIFEST_NAME);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Esp32ManifestShape;
}

const ESP32_MANIFEST = readEsp32Manifest();

// ---- 1.55. attestation plans: what a flash page needs to prove itself ----
// After a flash page writes firmware to a real board, it can run that app's
// own recorded trace ON that board and diff the frames against the same
// recorded frames `bun run verify-bundle` compares against
// (site/attest/run.ts). This step emits everything that needs, next to the
// flash page: one plan per attestable combo, plus a copy of that port's
// recorded frames.
//
// A COMBO IS ATTESTABLE WHEN TWO THINGS ARE TRUE, and no others:
//   1. This page can flash it (an .uf2 in FLASH_ARTIFACTS, or an image in
//      the ESP32 artifact index). A verdict about firmware the visitor
//      could not have put on the board is not evidence about anything.
//   2. Its bundle port is verified in a way a board can be put through:
//      pixel-exact (it has recorded frames to diff against) or invariants
//      (it has a checker, and this gallery carries that checker - see the
//      INVARIANT_CHECKERS lookup below).
// Everything else gets no plan and no button, rather than a button that
// would have to lie about what it proved.
//
// BOTH KINDS, NOT ONE, and that is this step's own change. Until now only a
// pixel-exact port got a plan, on the argument that running "a different,
// weaker check under the same word would make two different things share
// one number on a card" (docs/decisions/0011). The word is what was wrong
// there, not the check: an invariants port IS verified, by its own
// bundle's own checker, and a board can be put through that same function.
// So both get a plan, the plan says which kind it is, and every surface
// downstream carries the kind rather than flattening it - see that
// decision's own addendum.
//
// The capture points come from each kind's own source of truth, never from
// a list restated here: a pixel-exact port's from the frames directory's
// <trace-stem>.t<ms>.png filenames (the SAME rule harness/portdiff.ts's
// verifyPortFrames() applies), an invariants port's from its bundle.json's
// own verification.captureAt (the SAME array tools/verify-bundle.ts hands
// runInvariants).
const ATTEST_DIR_NAME = "attest";

// Which browser flashing path a pack's board uses, and therefore how its
// devlink port must be opened. The RP2350's USB CDC stack does not answer
// unless DTR is asserted; the ESP32-S3's USB Serial/JTAG peripheral wires
// DTR to the chip's own boot strap and is rebooted by it. Keyed by pack
// rather than hardcoded in the page, so a third board is a line here.
const PACK_BOARD_FAMILY: Record<string, { family: "rp2350" | "esp32"; dataTerminalReady: boolean }> = {
  "rp2350-touch-amoled-18": { family: "rp2350", dataTerminalReady: true },
  "esp32-s3-touch-amoled-18": { family: "esp32", dataTerminalReady: false },
};

interface AttestPlanTrace {
  name: string;
  events: unknown[];
  points: { atMs: number; frame: string }[];
}

interface AttestPlanInvariantTrace {
  name: string;
  events: unknown[];
  captureAt: number[];
}

/** Combo ids that got a plan, read back by writeRunPage to decide whether to render the section. */
const attestPlans = new Set<string>();
/** Which kind of plan each of those got, read back by renderAttestSection for its intro line. */
const attestKinds = new Map<string, "pixel-exact" | "invariants">();

function attestArtifactHref(combo: Combo): string | null {
  const uf2 = FLASH_ARTIFACTS[combo.id];
  if (uf2) return `../flash/${uf2.file}`;
  const imageId = esp32ImageIdFor(combo.id);
  if (imageId && ESP32_MANIFEST) return `../flash/esp32/${ESP32_MANIFEST.images[imageId]!.file}`;
  return null;
}

/** The stem a bundle's trace path is known by, on both sides of the wire. */
function traceStem(tracePath: string): string {
  return tracePath.split(/[\\/]/).pop()!.replace(/\.trace\.json$|\.json$/, "");
}

function writeAttestPlan(comboId: string, plan: Record<string, unknown>, what: string): void {
  writeFileSync(join(DIST, ATTEST_DIR_NAME, `${comboId}.json`), JSON.stringify(plan, null, 2) + "\n");
  attestPlans.add(comboId);
  attestKinds.set(comboId, plan.kind as "pixel-exact" | "invariants");
  console.log(`wrote -> site/dist/${ATTEST_DIR_NAME}/${comboId}.json (${what})`);
}

function buildAttestPlans(): void {
  const outDir = join(DIST, ATTEST_DIR_NAME);
  mkdirSync(outDir, { recursive: true });

  for (const combo of combos) {
    const entry = combo.proven;
    const artifact = attestArtifactHref(combo);
    if (!artifact) continue;
    const board = PACK_BOARD_FAMILY[combo.pack];
    if (!board) continue;

    if (entry.checker) {
      buildInvariantsPlan(combo, artifact, board);
      continue;
    }
    if (!entry.traces || !entry.framesDir) continue;

    const framesSrc = join(REPO_ROOT, entry.framesDir);
    if (!existsSync(framesSrc)) continue;
    const framesOut = join(outDir, combo.id);
    mkdirSync(framesOut, { recursive: true });

    const traces: AttestPlanTrace[] = [];
    for (const tracePath of entry.traces) {
      const abs = join(REPO_ROOT, tracePath);
      if (!existsSync(abs)) {
        throw new Error(`${combo.appPath}/bundle.json names the trace ${tracePath}, which does not exist`);
      }
      const stem = traceStem(tracePath);
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const frameRe = new RegExp(`^${escaped}\\.t(\\d+)\\.png$`);
      const points: { atMs: number; frame: string }[] = [];
      for (const name of readdirSync(framesSrc)) {
        const m = frameRe.exec(name);
        if (!m) continue;
        copyFileSync(join(framesSrc, name), join(framesOut, name));
        points.push({ atMs: Number(m[1]), frame: name });
      }
      if (points.length === 0) continue;
      points.sort((a, b) => a.atMs - b.atMs);
      const trace = readJson<{ events: unknown[] }>(abs);
      traces.push({ name: stem, events: trace.events, points });
    }
    if (traces.length === 0) continue;

    const plan = {
      combo: combo.id,
      app: combo.app,
      pack: combo.pack,
      kind: "pixel-exact",
      boardFamily: board.family,
      // Zero, and it stays zero: a pixel-exact port's whole claim is that
      // the frames are identical, and a tolerance here would quietly turn
      // that into "close enough" on the one surface where a stranger is
      // reading the result.
      tolerance: 0,
      artifact,
      framesBase: `${combo.id}/`,
      // The emulator side of every recorded frame started from emu_init(),
      // which enters app 0, so this is the only value that makes the two
      // sides start alike.
      appIndex: 0,
      dataTerminalReady: board.dataTerminalReady,
      traces,
    };
    const frameCount = traces.reduce((n, t) => n + t.points.length, 0);
    writeAttestPlan(combo.id, plan, `pixel-exact, ${traces.length} trace(s), ${frameCount} recorded frame(s)`);
  }
}

// An invariants port's plan: the bundle's own trace, the bundle's own
// capture points, the bundle's own checker named by the bundle's own path,
// and the pack's own device.json as the checker's meta.device. Everything
// in it is quoted from a file that already existed; nothing about which
// moments matter or what they mean is decided here.
function buildInvariantsPlan(combo: Combo, artifact: string, board: { family: "rp2350" | "esp32"; dataTerminalReady: boolean }): void {
  const entry = combo.proven;
  const checker = entry.checker!;
  // Refused loudly rather than skipped: a bundle that declares a checker
  // this gallery cannot run is a gap somebody has to close (one line in
  // site/attest/checkers.ts), not a port to quietly drop off the page.
  if (!INVARIANT_CHECKERS[checker]) {
    throw new Error(
      `${combo.appPath}/bundle.json verifies ${combo.pack} with the checker ${checker}, which site/attest/checkers.ts does not carry. ` +
        `Add it there (one import and one line) so the flash page can actually run it, or this gallery would offer a button with nothing behind it.`
    );
  }
  if (!entry.invariantTrace || !entry.captureAt || entry.captureAt.length === 0) {
    throw new Error(
      `${combo.appPath}/bundle.json verifies ${combo.pack} by invariants but names no trace and captureAt for it, so a board has nothing to replay.`
    );
  }
  const abs = join(REPO_ROOT, entry.invariantTrace);
  if (!existsSync(abs)) {
    throw new Error(`${combo.appPath}/bundle.json names the trace ${entry.invariantTrace}, which does not exist`);
  }
  const device = packDevice.get(combo.pack);
  if (!device) return;

  const trace = readJson<{ events: unknown[] }>(abs);
  const traces: AttestPlanInvariantTrace[] = [
    { name: traceStem(entry.invariantTrace), events: trace.events, captureAt: entry.captureAt },
  ];

  writeAttestPlan(
    combo.id,
    {
      combo: combo.id,
      app: combo.app,
      pack: combo.pack,
      kind: "invariants",
      boardFamily: board.family,
      checker,
      device,
      artifact,
      // The emulator side of every recorded frame started from emu_init(),
      // which enters app 0, so this is the only value that makes the two
      // sides start alike.
      appIndex: 0,
      dataTerminalReady: board.dataTerminalReady,
      traces,
    },
    `invariants via ${checker}, ${entry.captureAt.length} capture point(s)`
  );
}

// ---- 1.6. landing demo loops: recorded, tracked source, copied out -------
// Same pattern as flash-artifacts above: site/demo-media/ is the tracked
// source (written by site/record-demos.ts, committed like any other
// asset), site/dist/assets/demos/ is untracked build output regenerated
// from it every time. Every id the landing page actually links to
// (demoThumb's own callers) must have all three files - missing media is
// a loud warning, not a thrown error, so a fresh clone can still run
// site:build once (to produce the wasm modules site/record-demos.ts itself
// needs to drive) before any recording has happened yet.
const DEMO_MEDIA_EXTS = ["mp4", "gif", "png"] as const;

function copyDemoMedia(ids: string[]): void {
  const outDir = join(DIST, "assets", "demos");
  mkdirSync(outDir, { recursive: true });
  for (const id of ids) {
    for (const ext of DEMO_MEDIA_EXTS) {
      const src = join(DEMO_MEDIA_DIR, `${id}.${ext}`);
      if (!existsSync(src)) {
        console.warn(`site/build.ts: no site/demo-media/${id}.${ext} yet (run \`bun run site:record-demos\` to generate it) - the landing page will link to a missing asset until then`);
        continue;
      }
      copyFileSync(src, join(outDir, `${id}.${ext}`));
      console.log(`copied -> site/dist/assets/demos/${id}.${ext}`);
    }
  }
}

// flash-ui.ts is the run page's own small entrypoint (wires the "Flash
// over USB" button to site/flasher/flash.ts); bundled the same way the
// root build.ts bundles src/main.ts, so this page ships one local JS file
// and never a CDN import.
// Set by buildFlashUi() below, read by writeRunPage()'s flashScript - one
// bundle shared by every run page that has a flash section of that board's
// kind. TWO bundles, not one: esp32-ui.ts pulls in esptool-js and its deflate
// dependency, and an RP2350 run page has no reason to download an ESP32
// serial protocol stack it will never call. The DOM code they share
// (flash-ui-common.ts) is small and is simply in both.
let FLASH_JS_VERSION = "";
let ESP32_FLASH_JS_VERSION = "";
// A THIRD bundle, and for the same reason there are already two: the attest
// step's imports have nothing to do with either flasher's. It pulls in the
// devlink protocol, the browser Web Serial transport, the shared replay and
// the shared pixel comparison; neither flasher needs any of that, and a
// page with no attestable port should not download it. It also loads on
// BOTH families' pages, which neither flash bundle does.
let ATTEST_JS_VERSION = "";
// A FOURTH, and the smallest: the landing page reads four integers and must
// not download a serial protocol stack to do it (site/attest/counters.ts).
let ATTEST_COUNTERS_JS_VERSION = "";

async function bundleBrowserEntry(entry: string, outDir: string, outName: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(SITE_DIR, entry)],
    outdir: outDir,
    naming: outName,
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`site/build.ts: failed to bundle site/${entry}`);
  }
  const rel = outDir.slice(DIST.length + 1).replace(/\\/g, "/");
  console.log(`built -> site/dist/${rel ? `${rel}/` : ""}${outName}`);
  return contentHashOf(join(outDir, outName));
}

async function buildFlashUi(): Promise<void> {
  const flashDir = join(DIST, "flash");
  FLASH_JS_VERSION = await bundleBrowserEntry("flasher/flash-ui.ts", flashDir, "flash.js");
  ESP32_FLASH_JS_VERSION = await bundleBrowserEntry("flasher/esp32-ui.ts", flashDir, "esp32-flash.js");
  ATTEST_JS_VERSION = await bundleBrowserEntry("attest/attest-ui.ts", flashDir, "attest.js");
  ATTEST_COUNTERS_JS_VERSION = await bundleBrowserEntry("attest/counters.ts", DIST, "attest-counters.js");
}

// ---- 2. the shared emulator bundle, built once via the repo's own build.ts ----
// Set by buildEmulatorBundle() below, read by writeRunPage(): the SAME
// emu/index.html is embedded by every run page, so its content hash is
// computed once here rather than re-hashing the same file per run page.
let EMU_INDEX_VERSION = "";

function buildEmulatorBundle(): void {
  runBuild("build.ts", []);
  const repoDist = join(REPO_ROOT, "dist");
  const emuDir = join(DIST, "emu");
  mkdirSync(emuDir, { recursive: true });
  for (const f of ["main.js", "family-budget.css", "app.css"]) {
    copyFileSync(join(repoDist, f), join(emuDir, f));
  }
  // index.html itself is not a byte-for-byte copy: its own internal
  // references to main.js/family-budget.css/app.css need the SAME
  // cache-busting query string every other emitted asset URL gets (this is
  // the "copied emu/index.html" half of this task's cache-busting fix -
  // the outer run page versioning its iframe src is not enough on its own,
  // because the browser caches main.js/app.css by THEIR OWN url, resolved
  // against this document, not against whatever versioned url embedded it).
  const mainJsV = contentHashOf(join(emuDir, "main.js"));
  const fbCssV = contentHashOf(join(emuDir, "family-budget.css"));
  const appCssV = contentHashOf(join(emuDir, "app.css"));
  let html = readFileSync(join(repoDist, "index.html"), "utf8");
  html = html
    .replace('href="./family-budget.css"', `href="${withVersion("./family-budget.css", fbCssV)}"`)
    .replace('href="./app.css"', `href="${withVersion("./app.css", appCssV)}"`)
    .replace('src="./main.js"', `src="${withVersion("./main.js", mainJsV)}"`);
  writeFileSync(join(emuDir, "index.html"), html);
  EMU_INDEX_VERSION = contentHashOf(join(emuDir, "index.html"));
  console.log("copied -> site/dist/emu/ (shared emulator bundle)");
}

// ---- html helpers ----
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// A monochrome puck glyph, inline (no separate .ico/.png asset to keep in
// sync with the rest of the gallery): a disc with a smaller punched-out
// centre, the same silhouette a hockey puck reads as from directly above.
// One colour (the site's own accent), on transparent - matches "system
// sans, one accent, no marketing" as much as a 32x32 glyph can. A data URI
// means every page carries its own favicon with zero extra requests, and a
// static build with no build-time image pipeline never has to write a
// second file this could drift from.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2f6feb"/><circle cx="16" cy="16" r="5" fill="#fafafa"/></svg>`;
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// One footer, everywhere: the index page and every run page end on the
// same GitHub link + MIT note, rather than the index's own copy being the
// only place a visitor sees it. The "agents" link is set once ROOT_DEPTH_*
// versions exist (see buildAgentSurfaces below) via patchFooterAgentsLink;
// it starts unversioned so every page() call before that step still has a
// working (if uncached) href rather than a dangling one.
let AGENTS_HTML_VERSION = "";
function siteFooter(depth: "" | "../"): string {
  const href = `${depth}agents.html${AGENTS_HTML_VERSION ? `?v=${AGENTS_HTML_VERSION}` : ""}`;
  return `<footer>
    <div class="wrap" style="padding:0">
      <a href="${gh("README.md")}">s0lness/puck</a> on GitHub, MIT licensed.
      &middot; <a href="${href}">agents</a>
    </div>
  </footer>`;
}

// Set once styles.css is copied into DIST (see "run everything" below),
// read by every page() call - index.html and every run page link the SAME
// physical file, just at a different relative depth ("styles.css" vs
// "../styles.css"), so one hash covers all of them.
let STYLES_VERSION = "";

// Markup's own key-gated loader (markup/scripts/install-loader.py's
// SNIPPET, the same one gazette/public/*.html embeds verbatim): inert on a
// plain load. It only ever runs past its first "return" when the URL
// carries ?markup or ?edit (or a tab already opted in via
// sessionStorage["markup-on"]), and only fetches markup.js past its
// second "return" when a key is already in localStorage (seeded once from
// a #k=<key> URL fragment) or the page is being served from localhost. No
// key lives in this repo; Sylve's own key lives outside it entirely
// (~/projects/.secrets.env), pasted into the URL once per device via
// https://<site>/?edit#k=<key>. Deliberately backslash-free (a stray `\b`
// once got mangled to a control byte through a shell and silently
// disabled this, per markup's own AGENTS.md), and copied verbatim rather
// than re-derived, so it never drifts from the version every other
// s0lness site embeds.
const MARKUP_LOADER = `<script>/* markup: visual-feedback overlay, only for a browser holding the key */(function(){if(!(/[?&](markup|edit)([=&]|$)/.test(location.search)||sessionStorage.getItem("markup-on")))return;var m=/[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash),k=null;try{if(m)localStorage.setItem("markup-key",m[1]);k=localStorage.getItem("markup-key")}catch(e){}var local=location.hostname==="localhost"||location.hostname==="127.0.0.1";if(!k&&!local)return;document.head.appendChild(Object.assign(document.createElement("script"),{src:"https://markup.sylve.org/markup.js"}))})()</script>`;

function page(title: string, description: string, stylesHref: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<link rel="icon" href="${FAVICON_HREF}" />
<link rel="stylesheet" href="${withVersion(stylesHref, STYLES_VERSION)}" />
</head>
<body>
${body}
${MARKUP_LOADER}
</body>
</html>
`;
}

// ---- landing thumbnails: recorded loops, not live emulators -------------
// The index page used to embed the same live ?embed=1 iframe every run page
// does, once per card. Real, but expensive on a phone (four wasm fetches +
// instantiations before anything paints) and fragile in exactly the way
// Sylve's own iPhone Safari report showed ("the fluid simulation doesn't
// seem to work"): a live embed's correctness depends on wasm compiling,
// touch reaching the panel, and the device fitting its iframe, all before
// a visitor sees anything move. A short recorded loop (site/record-demos.ts,
// see its own header for how these are captured) has none of that: it is a
// <video>, it always plays, and it costs one small file instead of a wasm
// module. The live thing still exists, one click away - every thumbnail
// links to its real run page, per site/build.ts's own COMBO ids so this
// never points at a made-up id.
const DEMO_MEDIA_DIR = join(SITE_DIR, "demo-media");
// Hashed on demand, not from a precomputed table: called from
// buildIndexHtml(), which always runs after copyDemoMedia() has already
// populated DIST/assets/demos/ (see "run everything" below), so the file
// this hashes is the one actually shipped. Falls back to an unversioned
// href when the file is missing (a fresh clone that has not run
// site:record-demos yet - copyDemoMedia's own warning already covers that
// case without failing the build, this matches it rather than throwing).
function demoAssetHref(id: string, ext: string): string {
  const base = `assets/demos/${id}.${ext}`;
  const filePath = join(DIST, "assets", "demos", `${id}.${ext}`);
  return existsSync(filePath) ? withVersion(base, contentHashOf(filePath)) : base;
}

// The card itself: a CSS device frame (cardDeviceGeometry above) sized by
// the pack's own device.json, wrapping a video/poster/gif that were all
// cropped to #panel alone (site/record-demos.ts) - never a plain video
// filling the whole box. The outer link's own aspect-ratio is the
// BEZEL's own (not a wider silhouette that reserves margin for a
// protruding button - cardDeviceGeometry no longer adds one), so the
// device fills the card's full width, the same width as the text block
// below it. The video only fills the inner .card-panel box, positioned by
// cardDeviceGeometry's panelStyle. data-panel-w/-h on the <video> are what
// scripts/verify-site-embeds.ts reads to confirm the recorded clip's own
// intrinsic size actually matches this pack's panel aspect, independent of
// whatever this function draws around it.
function demoThumb(id: string, alt: string, href: string, pack: string, rotated: boolean): string {
  const g = cardDeviceGeometry(pack, rotated);
  return `<a class="thumb thumb-video" style="aspect-ratio:${g.bezelW} / ${g.bezelH}" href="${href}" aria-label="${escapeHtml(alt)}, open the live run page">
    <span class="card-bezel" style="border-radius:${g.bezelRadius}">
      <span class="card-panel" style="${g.panelStyle}">
        <video autoplay muted loop playsinline poster="${demoAssetHref(id, "png")}" data-panel-w="${g.panelW}" data-panel-h="${g.panelH}">
          <source src="${demoAssetHref(id, "mp4")}" type="video/mp4" />
        </video>
      </span>
      ${g.buttonsHtml}
    </span>
    <noscript><img src="${demoAssetHref(id, "gif")}" alt="${escapeHtml(alt)}" /></noscript>
  </a>`;
}

// ROOT-ABSOLUTE, deliberately, not relative. src/main.ts's fetchWasmBytes()
// calls fetch(WASM_URL) INSIDE the emu/index.html document, so a relative
// value in the ?module= param resolves against THAT document's own
// location (site/dist/emu/), never against whichever page is embedding it.
// A relative "modules/<id>.wasm" from an index-page card therefore resolved
// to site/dist/emu/modules/<id>.wasm (one directory too deep - it does not
// exist, 404) even though the exact same relative depth ("../modules/") was
// correct from a run page one level further down in run/. Root-absolute
// sidesteps embedding depth entirely: it means the same thing regardless of
// which page (or how deeply nested) embeds emu/index.html. Correct on both
// targets this repo ever serves site/dist/ from: Cloudflare Pages (a
// project's dist is served at its own domain root) and this repo's own
// local static servers (scripts/verify-flash-ui.ts, scripts/verify-embed.ts
// pointed at site/dist/, and any other server that maps site/dist/ itself
// to "/"), never at a deeper mount path.
function moduleUrlAbs(moduleId: string): string {
  return `/modules/${moduleId}.wasm`;
}

// ---- hand-written one-liners: bundle.json has no prose, this is it -----
const APP_BLURB: Record<string, string> = {
  chrono: "A full-screen stopwatch: six seven-segment digits, two buttons, nothing else on screen.",
  fluidbox: "A particle liquid that sloshes and settles inside the device's own enclosure shape.",
  tinydraw: "A full-panel finger-drawing canvas: variable-width antialiased ink, two-level zoom, one-stroke undo.",
  gameos: "A handheld game console shell: pick a game to launch a thermal gunner, a slot machine, or a swing-driven procedural golf course.",
};

// ---- 3 & 4: generate every page --------------------------------------
function modeLabel(mode: string): string {
  if (mode === "faithful") return "faithful port";
  if (mode === "native") return "native";
  return "adaptation";
}

// ---- the matrix: one cell per app per target, from the ledger ----------
// docs/decisions/0012. Every cell here is a row out of ledger.json, and the
// rule the whole page turns on is that a cell must be one of exactly three
// things and never a blank: something that RUNS (a thumbnail and a link),
// a VERDICT (the mechanical go/degraded/refuse and its reason, for a
// target this app has no port on), or an EMPTY STATE that says what is
// missing. "Not ported" as a grey word in a box was the fourth thing, and
// it said nothing at all.

/** Whether site/demo-media/ carries a complete recorded loop for this id. */
function hasDemoMedia(id: string): boolean {
  return DEMO_MEDIA_EXTS.every((ext) => existsSync(join(DEMO_MEDIA_DIR, `${id}.${ext}`)));
}

/** Where a silhouette cell's proof PNG is served from, mirroring demo media's own assets/ convention. */
function proofHref(target: string, app: string): string {
  const name = `${target}-${app.replace(/[\\/]/g, "-")}.png`;
  const filePath = join(DIST, "assets", "proofs", name);
  const base = `assets/proofs/${name}`;
  return existsSync(filePath) ? withVersion(base, contentHashOf(filePath)) : base;
}

function copyProofs(): void {
  const outDir = join(DIST, "assets", "proofs");
  mkdirSync(outDir, { recursive: true });
  for (const cell of Object.values(ledger.cells)) {
    if (!cell.silhouette.proof) continue;
    const src = join(REPO_ROOT, cell.silhouette.proof);
    if (!existsSync(src)) {
      console.warn(`site/build.ts: ledger.json names the proof ${cell.silhouette.proof}, which is not on disk - that cell will render without a picture`);
      continue;
    }
    copyFileSync(src, join(outDir, `${cell.target}-${cell.app.replace(/[\\/]/g, "-")}.png`));
  }
}

type ChipTone = "ok" | "warn" | "bad" | "mute";

function chip(tone: ChipTone, label: string, title: string): string {
  return `<span class="chip chip-${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(label)}</span>`;
}

const EMULATOR_TONE: Record<string, ChipTone> = { PASS: "ok", FAIL: "bad", ERROR: "bad" };
const HOST_TONE: Record<string, ChipTone> = { MATCH: "ok", DIVERGE: "warn", SANITIZER: "bad", CRASHED: "bad", BUILD_FAILED: "mute" };
const SILHOUETTE_TONE: Record<string, ChipTone> = { runs: "ok", blank: "warn", "wrong-panel": "bad", "page-error": "bad", "build-failed": "bad" };
const VERDICT_TONE: Record<string, ChipTone> = { go: "ok", degraded: "warn", refuse: "bad" };

/** The mechanical verdict, always shown, always with its own sentence behind it. */
function verdictChip(cell: LedgerCell): string {
  if (!cell.verdict) return chip("mute", "no verdict", cell.verdictUnavailable ?? "");
  const v = cell.verdict.verdict;
  const degrades = cell.verdict.degrades.filter((d) => d.value !== d.reference);
  const label = v === "degraded" && degrades.length > 0 ? `degraded: ${degrades[0]!.value} ${degrades[0]!.name}` : v;
  return chip(VERDICT_TONE[v]!, label, cell.verdict.human);
}

/** The silicon counter: the empty state ships in the HTML, the number arrives from GET /api/attest. */
function siliconChip(app: string, pack: string): string {
  return (
    `<span class="chip chip-mute attest-counter attest-counter-empty" data-attest-app="${escapeHtml(app)}" data-attest-pack="${escapeHtml(pack)}">` +
    `${escapeHtml(ATTEST_EMPTY_STATE)}</span>`
  );
}

/** The first sentence of a reason, for a cell that has to say what is missing without becoming a paragraph. */
function firstSentence(text: string, limit = 220): string {
  const line = text.split("\n")[0]!.trim();
  if (line.length <= limit) return line;
  // Cut at the last word boundary before the limit, not mid-word: a cell
  // that ends "quarter tu…" reads as a rendering bug rather than as a
  // deliberate trim.
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`;
}

/**
 * The one <td> opener every branch below goes through. `state` is the
 * three-way classification the page makes about itself and
 * scripts/verify-matrix.ts checks against the ledger: `runs` (a link to
 * something that opens and runs), `verdict` (a mark and the sentence behind
 * it), `empty` (says what is missing and where the procedure is), and
 * `void` for a column that is not this app's target at all. Written into
 * the markup rather than inferred from what the cell happens to contain,
 * because a check that inferred it could never catch the page and the
 * ledger disagreeing.
 */
function cellOpen(state: "runs" | "verdict" | "empty" | "void", target: string, extraClass: string, groupStart: boolean): string {
  return `<td class="cell ${extraClass}${groupStart ? " group-start" : ""}" data-cell="${state}" data-target="${escapeHtml(target)}">`;
}

function matrixCell(app: AppEntry, target: LedgerTarget, groupStart: boolean): string {
  const cell = cellFor(app.name, target.name);
  if (!cell) {
    return `${cellOpen("void", target.name, "cell-void", groupStart)}<p class="cell-why">not in the ledger</p></td>`;
  }

  // ---- a target this repository does not carry, named by somebody else's
  // bundle. Only the app that declares a port there has anything to say.
  if (target.kind === "external-pack") {
    if (!cell.port) return `${cellOpen("void", target.name, "cell-void", groupStart)}<p class="cell-why">not this app's target</p></td>`;
    const tone = EMULATOR_TONE[cell.emulator.mark] ?? "mute";
    return `${cellOpen("verdict", target.name, "cell-external", groupStart)}
        <div class="chips">${chip(tone, `emulator ${cell.emulator.mark}`, cell.emulator.reason)}</div>
        <p class="cell-why">${escapeHtml(firstSentence(cell.emulator.reason, 320))}</p>
        ${cell.port.provenance ? `<p class="cell-prov">${escapeHtml(cell.port.provenance)}</p>` : ""}
      </td>`;
  }

  // ---- a silhouette: no firmware exists, so the only question is whether
  // the app's own C runs at that board's size, and the picture is the answer.
  if (target.kind === "silhouette") {
    const s = cell.silhouette;
    const tone = SILHOUETTE_TONE[s.mark] ?? "mute";
    const runnable = silhouettePages.has(`${app.name}:${target.name}`);
    // It ran, and this site still cannot show it running: said here rather
    // than swallowed, because "runs here" with no link would be the one
    // thing this whole page exists not to do.
    const unpresentable =
      s.mark === "runs" && !runnable
        ? `. It ran, and there is no page for it here: this board declares a ${escapeHtml(target.panel?.format ?? "an unnamed")} panel and the shared emulator only reads the 16-bit formats the real packs declare, so presenting it would mean pretending packs/web&#39;s own RGB565 framebuffer is this board&#39;s glass`
        : "";
    const id = `${app.name}-${target.name}`;
    const picture = s.proof
      ? `<img src="${proofHref(target.name, app.name)}" alt="${escapeHtml(`${app.name} running on the ${target.label} silhouette`)}" class="proof-img" loading="lazy" />`
      : "";
    const thumb = runnable
      ? `<a class="thumb-proof" href="run/${id}.html" aria-label="${escapeHtml(`open ${app.name} running on the ${target.label} silhouette`)}">${picture}</a>`
      : picture
        ? `<span class="thumb-proof thumb-proof-still">${picture}</span>`
        : "";
    const borrowed = s.via && s.via !== WEB_PACK ? ` <span class="cell-note">via its ${escapeHtml(packLabel.get(s.via) || s.via)} port's own file</span>` : "";
    return `${cellOpen(runnable ? "runs" : "verdict", target.name, "cell-silhouette", groupStart)}
        ${thumb}
        <div class="chips">${verdictChip(cell)}${chip(tone, s.mark === "runs" ? (runnable ? "runs here" : "runs, no page here") : s.mark, s.reason)}</div>
        <p class="cell-why">${escapeHtml(firstSentence(s.reason, runnable ? 220 : 320))}${borrowed}${unpresentable}</p>
      </td>`;
  }

  // ---- a real pack, with a port on it: the thing runs, and every mark it
  // has earned sits under it.
  if (cell.port) {
    const combo = combos.find((c) => c.app === app.name && c.pack === target.name)!;
    const href = comboHref(combo, "");
    const media = hasDemoMedia(combo.id);
    const thumb = media ? demoThumb(combo.id, `${app.name} on ${target.label}`, href, target.name, app.name === "chrono") : "";
    const chips = [
      chip(EMULATOR_TONE[cell.emulator.mark] ?? "mute", `emulator ${cell.emulator.mark}`, cell.emulator.reason),
      cell.host.mark === "not run" ? chip("mute", "host not run", cell.host.reason) : chip(HOST_TONE[cell.host.mark] ?? "mute", `host ${cell.host.mark}`, cell.host.reason),
      target.name === WEB_PACK ? "" : siliconChip(app.name, target.name),
    ]
      .filter(Boolean)
      .join("");
    const label = `${modeLabel(cell.port.mode)}, ${cell.port.verification}${cell.port.declaredVerdict === "degraded" ? " (degraded)" : ""}`;
    const trouble = cell.emulator.mark !== "PASS" || cell.host.mark === "DIVERGE" || cell.host.mark === "SANITIZER";
    return `${cellOpen("runs", target.name, "cell-port", groupStart)}
        ${thumb}
        <a class="cell-open" href="${href}">${escapeHtml(target.name === WEB_PACK ? "run it on your phone" : "run it")}</a>
        <p class="cell-mode">${escapeHtml(label)}</p>
        <div class="chips">${chips}</div>
        ${trouble ? `<p class="cell-why">${escapeHtml(firstSentence(cell.emulator.mark !== "PASS" ? cell.emulator.reason : cell.host.reason, 320))}</p>` : ""}
      </td>`;
  }

  // ---- a real pack with no port: the empty state, which has to say what
  // is missing rather than leave a hole in the grid.
  return `${cellOpen("empty", target.name, "cell-empty", groupStart)}
        <div class="chips">${verdictChip(cell)}</div>
        <p class="cell-why">no port yet.${cell.verdict ? ` ${escapeHtml(firstSentence(reasonFor(cell), 260))}` : ` ${escapeHtml(firstSentence(cell.verdictUnavailable ?? "", 260))}`}</p>
        <a class="cell-publish" href="puck-publish/">how to port it</a>
      </td>`;
}

/** The sentence a no-port cell shows: the refusal if there is one, else the cost, else that everything fits. */
function reasonFor(cell: LedgerCell): string {
  if (!cell.verdict) return cell.verdictUnavailable ?? "";
  const refused = cell.verdict.checks.find((c) => c.status === "refuse");
  if (refused) return `${refused.dimension}: ${refused.reason}`;
  const cost = cell.verdict.checks.find((c) => c.status === "degraded");
  if (cost) return `${cost.dimension}: ${cost.reason}`;
  const shrunk = cell.verdict.degrades.find((d) => d.value !== d.reference);
  if (shrunk) return `${shrunk.value} ${shrunk.name} against the reference ${shrunk.reference}, bound by ${shrunk.boundBy}`;
  return "every dimension this app states is met by what the device declares";
}

// The column groups, in the order a reader should meet them: devices this
// repository has real firmware for, then a device somebody else's bundle
// targets, then devices nobody has written firmware for at all.
const TARGET_GROUPS: { kind: LedgerTarget["kind"]; label: string; note: string }[] = [
  { kind: "pack", label: "device packs", note: "real firmware, in this repository" },
  { kind: "external-pack", label: "an author's own pack", note: "named by their bundle, not carried here" },
  { kind: "silhouette", label: "silhouettes", note: "a device.json and nothing else, no firmware anywhere" },
];

function buildIndexHtml(): void {
  const groups = TARGET_GROUPS.map((g) => ({ ...g, targets: ledger.targets.filter((t) => t.kind === g.kind) })).filter((g) => g.targets.length > 0);
  const orderedTargets = groups.flatMap((g) => g.targets);

  const groupHead = groups
    .map((g, i) => `<th class="group-head${i > 0 ? " group-start" : ""}" colspan="${g.targets.length}"><span class="group-label">${escapeHtml(g.label)}</span><span class="group-note">${escapeHtml(g.note)}</span></th>`)
    .join("\n            ");

  const targetHead = groups
    .flatMap((g, gi) =>
      g.targets.map((t, ti) => {
        const unverified = t.provenance && t.provenance.verified !== true;
        const panel = t.panel ? `${t.panel.w}&times;${t.panel.h}` : "";
        const doc = t.path ? gh(`${t.path}/${t.kind === "silhouette" ? "AGENTS.md" : "AGENTS.md"}`) : null;
        const name = doc ? `<a href="${doc}">${escapeHtml(t.label)}</a>` : escapeHtml(t.label);
        return `<th class="target-head${gi > 0 && ti === 0 ? " group-start" : ""}" data-target="${escapeHtml(t.name)}">${name}<span class="target-sub">${panel}${unverified ? `${panel ? " &middot; " : ""}datasheet only` : ""}</span></th>`;
      })
    )
    .join("\n            ");

  const rows = apps
    .map((app) => {
      const cells = groups.flatMap((g, gi) => g.targets.map((t, ti) => matrixCell(app, t, gi > 0 && ti === 0))).join("\n          ");
      const docHref = app.path ? gh(`${app.path}/descriptor.md`) : app.url ? app.url.replace(/\.git$/, "") : null;
      const blurb = APP_BLURB[app.name] || "";
      return `        <tr>
          <th class="app-row" scope="row" data-app="${escapeHtml(app.name)}">
            <span class="app-name">${escapeHtml(app.name)}</span>
            ${blurb ? `<span class="app-blurb">${escapeHtml(blurb)}</span>` : ""}
            ${docHref ? `<a class="app-doc" href="${docHref}">${escapeHtml(app.path ? "descriptor" : "their repository")}</a>` : ""}
            ${app.provenance ? `<span class="app-prov">${escapeHtml(app.provenance)}</span>` : ""}
          </th>
          ${cells}
        </tr>`;
    })
    .join("\n");

  // Every "reference" tile (a device pack proving itself, plus the
  // instrument's own minimal example) gets the same recorded-loop
  // treatment as the matrix cells above, and the same click-through to its
  // real, live run page.
  const refTiles = [
    ...REFERENCE_APPS.map((r) => ({
      id: r.id,
      pack: r.pack,
      title: `${packLabel.get(r.pack) || r.pack}: ${r.name}`,
      blurb: r.blurb,
      docHref: gh(r.doc),
    })),
    {
      id: INSTRUMENT_EXAMPLE.id,
      pack: INSTRUMENT_EXAMPLE.id, // pseudo-pack, registered into packPanel above
      title: INSTRUMENT_EXAMPLE.name,
      blurb: INSTRUMENT_EXAMPLE.blurb,
      docHref: gh(INSTRUMENT_EXAMPLE.doc),
    },
  ];
  const refCardsHtml = refTiles
    .map(
      (r) => `<div class="ref-card">
  ${demoThumb(r.id, `${r.title} demo`, `run/${r.id}.html`, r.pack, false)}
  <h3>${escapeHtml(r.title)}</h3>
  <p>${escapeHtml(r.blurb)}</p>
  <div class="links"><a href="run/${r.id}.html">open full page</a> <a href="${r.docHref}">source</a></div>
</div>`
    )
    .join("\n");

  const cellCount = apps.length * orderedTargets.length;

  // THE MATRIX BREAKS OUT OF THE PAGE'S OWN COLUMN, and the markup is where
  // that happens rather than a CSS trick: every other section on this page
  // lives inside one 1040px .wrap, which is a good measure for prose and
  // far too narrow for nine device columns - inside it, the silhouettes
  // (the whole reason the table exists) sat past the right edge on every
  // desktop. So the matrix is its own top-level section with its own wider
  // wrap, and the prose sections close and reopen around it. The table
  // still scrolls inside .matrix-scroll and the page still never does.
  const body = `<div class="wrap">
  <header class="hero">
    <h1>puck</h1>
    <p class="tagline">apps that travel between tiny computers.</p>
    <p class="sub">${apps.length} apps down, ${orderedTargets.length} devices across, ${cellCount} cells. Every one of them either runs that app's own C, one click away, or says plainly what is missing. Nothing below is a mockup and nothing below is a date somebody typed: the whole table is <a href="${gh("ledger.json")}">ledger.json</a>, written by <a href="${gh("tools/ledger.ts")}"><code>bun run ledger</code></a>, which builds and replays every cell it claims. <a href="${gh("README.md")}">puck</a> is a device-agnostic emulator, a set of self-contained device packs, and a set of portable app bundles.</p>
  </header>
</div>

<section id="matrix">
  <div class="wrap">
      <h2>the matrix</h2>
      <p class="lede">A cell with a picture is a build that ran: <strong>emulator</strong> is the module rebuilt from the port's own source and its traces replayed, <strong>host</strong> is the same C compiled natively under address and undefined-behaviour sanitizers and diffed against it frame by frame, and <strong>silicon</strong> is how many real boards have run that port's trace and confirmed the frames. A cell with no port carries the mechanical verdict instead, with the reason it came out that way. Hover or focus any mark for the sentence behind it.</p>
  </div>
  <div class="wrap wrap-wide">
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr class="group-row"><th class="corner"></th>
            ${groupHead}
            </tr>
            <tr><th class="corner"></th>
            ${targetHead}
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
  </div>
  <div class="wrap">
    <p class="matrix-foot">A silhouette is a board nobody has written firmware for: one <code>device.json</code> with its numbers read off a datasheet and never measured against silicon, compiled against through <a href="${gh("packs/web")}">packs/web</a> so the app really runs at that panel size with those buttons. Last computed ${escapeHtml(ledger.generatedAt)}.</p>
  </div>
</section>

<div class="wrap">
  <section id="reference">
    <div class="wrap" style="padding:0">
      <h2>reference app</h2>
      <p class="lede">Not a port: each device pack's own shipped app, plus the instrument's own minimal example firmware - every tile below links to it running live, the same as the cells above.</p>
      <div class="ref-cards">
${refCardsHtml}
      </div>
    </div>
  </section>

  <section id="how">
    <div class="wrap" style="padding:0">
      <h2>how it works</h2>
      <div class="how-grid">
        <div class="item">
          <h3>device packs</h3>
          <p>A self-contained folder for one target: real drivers, a real board's firmware, and a <code>device.json</code> descriptor the emulator reads at runtime. Nothing in the shared instrument names one device; every panel size and button comes from the pack itself. The browser is one of those targets, so a phone is a device pack too, and an app ported to it goes through the same verifier as an app ported to a chip.</p>
          <span class="src"><a href="${gh("docs/convention/device-pack.md")}">device-pack.md</a></span>
        </div>
        <div class="item">
          <h3>app descriptors</h3>
          <p>An app is defined by its descriptor and traces, not by one implementation's source code: what appears on screen, every interaction, and separate requirements from preferences. A port starts with a verdict against the target pack, computed from those two documents, before any code is written.</p>
          <span class="src"><a href="${gh("docs/convention/app-bundle.md")}">app-bundle.md</a></span>
        </div>
        <div class="item">
          <h3>the ledger</h3>
          <p>Every cell above is recomputed when its own inputs change, and reused when they do not. A faithful port replays its traces and compares frames pixel for pixel; an adaptation states behavioral invariants and gets checked against those; either way the shared harness decides, not a claim in a README.</p>
          <span class="src"><a href="${gh("docs/decisions/0012-the-gallery-is-built-from-a-ledger.md")}">decision 0012</a></span>
        </div>
      </div>
    </div>
  </section>

  ${siteFooter("")}
</div>
<script type="module" src="${withVersion("attest-counters.js", ATTEST_COUNTERS_JS_VERSION)}"></script>`;

  writeFileSync(
    join(DIST, "index.html"),
    page(
      "puck: apps that travel between tiny computers",
      "Every app in this repository against every device it knows about, one cell each: a build that ran, or a plain statement of what is missing.",
      "styles.css",
      body
    )
  );
}


// ---- flash section: real-device flashing over WebUSB, or an honest note ----
// Keyed by combo id (not by pack) because the artifact choice is per
// combo, not per pack: both chrono-rp2350 and fluidbox-rp2350 target the
// same pack but ship different firmware.
interface FlashArtifact {
  file: string; // filename under site/flash-artifacts/ and site/dist/flash/
  note?: string; // shown above the buttons; chrono's explains the artifact is the full firmware, not an app-only build
}
const FLASH_ARTIFACTS: Record<string, FlashArtifact> = {
  "chrono-rp2350": {
    file: "puck-full.uf2",
    note: "This artifact is the full puck firmware for this board, not a chrono-only build: chrono is simply the app it boots into.",
  },
  "fluidbox-rp2350": {
    file: "fluidbox-rp2350.uf2",
  },
};

// Quoted compactly from packs/rp2350-touch-amoled-18/gotchas.md's own
// recovery ritual: replugging alone does not reset this board, because its
// PMIC keeps the rails powered through a simple unplug/replug.
//
// This is the RECOVERY path now, not the entry path. A board running
// firmware built on or after 2026-08-19 carries pico-sdk's USB reset
// interface, so the flasher reboots it into BOOTSEL itself over USB
// (site/flasher/flash.ts) and nobody has to hold anything. The fold stays
// because the two cases it still covers are the two where a button is the
// only thing left: firmware too old to have the interface, and firmware so
// broken that its USB stack never comes up.
const BOOTSEL_RITUAL_INTRO =
  "Only needed for a bricked board, or for firmware older than the USB reset interface. Otherwise the flasher reboots the board into BOOTSEL itself.";
const BOOTSEL_RITUAL =
  "Unplug USB. Hold PWR for at least 12 seconds, until the screen goes black (replugging alone does not reset the board: the PMIC keeps the rails up). Then hold BOOT while plugging the USB cable back in.";

// The ESP32-S3's own ritual fold, mirroring the RP2350's above and true for
// the same reason it is: it is the RECOVERY path, not the entry path. This
// board's ESP32-S3 has native USB, and its USB Serial/JTAG peripheral maps the
// host's DTR and RTS lines onto GPIO0 (BOOT) and EN (reset) - which is exactly
// the wiring packs/esp32-s3-touch-amoled-18/docs/decisions/0002 warns devlink
// about, pointed the other way. So the flasher walks the chip into download
// mode over the wire and nobody touches the board. The fold covers the one
// case where that fails: firmware that hangs or reconfigures those pins before
// the host gets a chance, leaving the button as the only way in.
const ESP32_BOOT_RITUAL_INTRO =
  "Only needed if the board's own USB port never appears in the browser's list, which means firmware too broken to answer. Otherwise the flasher puts the chip in download mode itself.";
const ESP32_BOOT_RITUAL =
  "Unplug USB. Hold BOOT while plugging the cable back in, then release it. The board comes up in the ROM download mode, its port appears, and this button works from there.";

// The three parts and offsets are not a UI detail, but where they went is:
// the artifact is one merged image written at offset 0 and this sentence is
// the one place a reader is told so, since the page otherwise looks exactly
// like the RP2350's single-file flash.
const ESP32_FLASH_HINT =
  "No install needed: the download is one merged image (bootloader, partition table and app) written at offset 0, the same bytes this button writes.";

function esp32FlashSection(comboId: string, imageId: string): string {
  const manifestHref = "../flash/esp32/manifest.json";
  const image = ESP32_MANIFEST!.images[imageId]!;
  const binHref = `../flash/esp32/${image.file}`;
  const note =
    comboId === "esp32-demo"
      ? "This artifact is the pack's reference app, built into its one app slot: the same firmware, with the bouncing square as the app it boots."
      : `This artifact is the full pack firmware for this board with ${comboId.replace(/-esp32$/, "")} in its one app slot, not an app-only build.`;
  return `  <section class="flash-section" data-esp32-manifest="${manifestHref}" data-esp32-image="${escapeHtml(imageId)}">
    <h2>Flash to the real device</h2>
    <p class="flash-note">${escapeHtml(note)}</p>
    <div class="flash-actions">
      <button type="button" class="flash-btn btn-flash">Flash over USB</button>
      <a class="flash-btn-alt" href="${binHref}" download>Download .bin</a>
    </div>
    <p class="flash-hint">${escapeHtml(ESP32_FLASH_HINT)}</p>
    <div class="flash-progress" hidden>
      <div class="flash-progress-track"><div class="flash-progress-bar"></div></div>
      <p class="flash-status"></p>
    </div>
    <p class="flash-done" hidden></p>
    <p class="flash-error" hidden></p>
    <details class="flash-ritual">
      <summary>ROM download-mode ritual</summary>
      <p class="flash-ritual-intro">${escapeHtml(ESP32_BOOT_RITUAL_INTRO)}</p>
      <p>${escapeHtml(ESP32_BOOT_RITUAL)}</p>
    </details>
  </section>`;
}

// An ESP32 combo with no image in the artifact index: the pack's firmware
// runs on silicon and the browser path exists, this particular port simply
// has no built artifact yet. Said plainly rather than as a promise about a
// future build.
const ESP32_NO_ARTIFACT_NOTE =
  "No prebuilt image for this port yet. The pack's firmware and this page's flasher both work; build this port's image with the pack's own tools/build-native.ts and it appears here.";

/** True when this combo has a browser-flashable image built for it. */
function esp32ImageIdFor(comboId: string): string | null {
  if (!ESP32_MANIFEST) return null;
  return ESP32_MANIFEST.images[comboId] ? comboId : null;
}

function renderFlashSection(comboId: string, pack: string): string {
  const artifact = FLASH_ARTIFACTS[comboId];
  if (artifact) {
    const uf2Href = `../flash/${artifact.file}`;
    return `  <section class="flash-section" data-uf2="${uf2Href}">
    <h2>Flash to the real device</h2>
    ${artifact.note ? `<p class="flash-note">${escapeHtml(artifact.note)}</p>` : ""}
    <div class="flash-actions">
      <button type="button" class="flash-btn btn-flash">Flash over USB</button>
      <a class="flash-btn-alt" href="${uf2Href}" download>Download .uf2</a>
    </div>
    <p class="flash-hint">No install needed: copy the downloaded file onto the RP2350 BOOTSEL drive once it appears.</p>
    <div class="flash-progress" hidden>
      <div class="flash-progress-track"><div class="flash-progress-bar"></div></div>
      <p class="flash-status"></p>
    </div>
    <p class="flash-done" hidden></p>
    <p class="flash-error" hidden></p>
    <details class="flash-ritual">
      <summary>BOOTSEL entry ritual</summary>
      <p class="flash-ritual-intro">${escapeHtml(BOOTSEL_RITUAL_INTRO)}</p>
      <p>${escapeHtml(BOOTSEL_RITUAL)}</p>
    </details>
  </section>`;
  }
  if (pack.startsWith("esp32")) {
    const imageId = esp32ImageIdFor(comboId);
    if (imageId) return esp32FlashSection(comboId, imageId);
    return `  <section class="flash-section flash-section-note">
    <h2>Flash to the real device</h2>
    <p class="flash-note">${escapeHtml(ESP32_NO_ARTIFACT_NOTE)}</p>
  </section>`;
  }
  return "";
}

// ---- attest section: the board answers for itself -----------------------
// Rendered under the flash section, on every combo that got a plan
// (buildAttestPlans above). The framing matters: this is not "did the flash
// work", it is "does this port do what the bundle says it does, on YOUR
// board", answered by replaying that port's own trace over devlink and then
// putting the result through the same check the command-line verifier puts
// it through - a frame-by-frame pixel diff for a pixel-exact port, that
// bundle's own invariants.ts for an invariants one.
//
// TWO INTROS, because the two checks are different claims and the section
// has to say which one it is about to make. The rest of the section is
// identical for both: same button, same rows, same counter, same endpoint.
//
// The counter under it is the same counter the gallery cards carry, filled
// from the same endpoint by the same helper (site/attest-client.ts), with
// its empty state already in the HTML so a page served with no function
// behind it never flashes a placeholder.
const ATTEST_INTRO_PIXEL =
  "The board can answer for itself. This replays this port's own recorded trace over the board's devlink port and compares every captured frame against the frames the verifier uses, pixel for pixel.";
const ATTEST_INTRO_INVARIANTS =
  "The board can answer for itself. This port is verified by behaviour rather than by pixel identity, so this replays its own trace over the board's devlink port and puts the frames it captures through this bundle's own invariants - the same checks, the same thresholds, the same file the verifier runs.";
const ATTEST_HINT =
  "Needs the board running this firmware, and Chrome or Edge on desktop. Nothing about you is sent: the result carries the app, the pack, the firmware's own sha256, the kind of check, the verdict and what each check measured.";

function renderAttestSection(comboId: string, app: string, pack: string): string {
  if (!attestPlans.has(comboId)) return "";
  const ATTEST_INTRO = attestKinds.get(comboId) === "invariants" ? ATTEST_INTRO_INVARIANTS : ATTEST_INTRO_PIXEL;
  const planHref = `../${ATTEST_DIR_NAME}/${comboId}.json`;
  return `  <section class="attest-section" data-attest-plan="${planHref}">
    <h2>Prove it runs</h2>
    <p class="attest-note">${escapeHtml(ATTEST_INTRO)}</p>
    <p class="attest-counter attest-counter-empty" data-attest-app="${escapeHtml(app)}" data-attest-pack="${escapeHtml(pack)}">${escapeHtml(ATTEST_EMPTY_STATE)}</p>
    <div class="attest-actions">
      <button type="button" class="attest-btn">Run the trace on this board</button>
    </div>
    <p class="attest-hint">${escapeHtml(ATTEST_HINT)}</p>
    <div class="attest-progress" hidden><p class="attest-status"></p></div>
    <ol class="attest-points" hidden></ol>
    <p class="attest-verdict" hidden></p>
    <div class="attest-post" hidden>
      <button type="button" class="attest-post-btn">Post this result</button>
    </div>
    <p class="attest-posted" hidden></p>
    <p class="attest-error" hidden></p>
  </section>`;
}

// Native size for the run page's iframe: since site/build.ts's iframe now
// points at the emulator's `?embed=1` view (device + minimal control strip
// only, no topbar/sidebar/console - see src/main.ts's EMBED and
// src/app.css's html.embed rules), the iframe only needs to fit the
// device itself, not the full dev-UI layout the old fixed 980x760 was
// sized for. Computed per pack from its own device.json panel size (never
// a hardcoded 368x448 here), plus fixed margins for the bezel's own
// padding and the bottom control strip - generous enough that nothing
// wraps, and the embed page's own fitDeviceToStage() scales the device
// down further still if a narrower viewport asks for it. A quarter-turned
// device (chrono's autoRotate below) is still comfortable at these
// margins since they are added on both axes.
const EMBED_MARGIN_W = 80; // bezel padding, both sides, plus breathing room
const EMBED_MARGIN_H = 170; // bezel padding + the bottom control strip
const EMBED_MIN = 260; // floor, so a very small/no-panel pack still gets a usable frame

function embedFrameSize(pack: string): { w: number; h: number } {
  const panel = packPanel.get(pack);
  const pw = panel?.w ?? 368;
  const ph = panel?.h ?? 448;
  return {
    w: Math.max(EMBED_MIN, pw + EMBED_MARGIN_W),
    h: Math.max(EMBED_MIN, ph + EMBED_MARGIN_H),
  };
}

function buildRunDir(): void {
  const runDir = join(DIST, "run");
  mkdirSync(runDir, { recursive: true });

  function writeRunPage(opts: {
    id: string;
    title: string;
    pack: string;
    packLabelStr: string;
    modeStr: string | null;
    verifStr: string | null;
    blurb: string;
    docLinks: { label: string; href: string }[];
    autoRotate: boolean;
    // Present only for a combo that is a real app+pack port (a reference
    // app or the instrument's own example has no bundle, so nothing to
    // attest and nothing to count).
    attest?: { app: string; pack: string };
  }) {
    // Root-absolute module URL, same reasoning and same helper as the
    // index page's live card embeds (moduleUrlAbs's own header comment);
    // the run page's iframe `src` itself stays relative ("../emu/..."),
    // resolved normally by the browser against this page's own location.
    const iframeSrc = withVersion(`../emu/index.html?embed=1&module=${encodeURIComponent(moduleUrlAbs(opts.id))}`, EMU_INDEX_VERSION);
    const { w: nativeW, h: nativeH } = embedFrameSize(opts.pack);
    const badges = [opts.modeStr, opts.verifStr]
      .filter((x): x is string => !!x)
      .map((x) => `<span class="badge accent">${escapeHtml(x)}</span>`)
      .join(" ");
    const links = opts.docLinks.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join("\n      ");
    const flashSection = renderFlashSection(opts.id, opts.pack);
    const flashScript = FLASH_ARTIFACTS[opts.id]
      ? `\n<script type="module" src="${withVersion("../flash/flash.js", FLASH_JS_VERSION)}"></script>`
      : esp32ImageIdFor(opts.id)
        ? `\n<script type="module" src="${withVersion("../flash/esp32-flash.js", ESP32_FLASH_JS_VERSION)}"></script>`
        : "";
    // Prefixed with its own newline rather than joined with one in the
    // template below, so a page with nothing to attest is byte-identical to
    // what it was before this section existed instead of gaining a stray
    // blank line (site/dist/ is committed, so cosmetic churn is real churn).
    const attestSectionRaw = opts.attest ? renderAttestSection(opts.id, opts.attest.app, opts.attest.pack) : "";
    const attestSection = attestSectionRaw ? `${attestSectionRaw}\n` : "";
    const attestScript = attestSectionRaw
      ? `\n<script type="module" src="${withVersion("../flash/attest.js", ATTEST_JS_VERSION)}"></script>`
      : "";
    const phoneTiltHint = packHasVectorSensor.get(opts.pack) ? " &middot; tilt with your phone" : "";
    const body = `<div class="wrap">
  <div class="run-header">
    <div class="back"><a href="../index.html">&larr; puck</a></div>
    <h1>${escapeHtml(opts.title)}</h1>
    <p class="meta">running on ${escapeHtml(opts.packLabelStr)}</p>
    <div class="badges">${badges}</div>
    <p>${escapeHtml(opts.blurb)}</p>
    <div class="links">
      ${links}
    </div>
  </div>

  <div class="emu-stage" id="stage">
    <div class="emu-frame" id="frame" style="width:${nativeW}px;height:${nativeH}px">
      <iframe id="emu" allowtransparency="true" src="${iframeSrc}" width="${nativeW}" height="${nativeH}" title="${escapeHtml(opts.title)} running live" allow="autoplay"></iframe>
    </div>
  </div>
  <p class="embed-hint">touch the screen${phoneTiltHint}</p>

  <div class="run-footer"></div>

${flashSection}
${attestSection}${siteFooter("../")}
</div>${flashScript}${attestScript}
<script>
(function () {
  var NATIVE_W = ${nativeW}, NATIVE_H = ${nativeH};
  var stage = document.getElementById("stage");
  var frame = document.getElementById("frame");
  function fit() {
    var scale = Math.min(1, stage.clientWidth / NATIVE_W);
    frame.style.transform = "scale(" + scale + ")";
    stage.style.height = Math.round(NATIVE_H * scale) + "px";
  }
  window.addEventListener("resize", fit);
  fit();
  ${
    opts.autoRotate
      ? `// Chrono renders landscape into a portrait-native panel; this clicks
  // the emulator's own "-90deg" quick-rotate button once the page loads,
  // the same control a person would click by hand (or the "r" keyboard
  // shortcut would cycle to), rather than defaulting to a sideways view.
  var emu = document.getElementById("emu");
  emu.addEventListener("load", function () {
    setTimeout(function () {
      try {
        var doc = emu.contentDocument;
        var btn = doc && doc.querySelector('#rotQuick button[data-deg="-90"]');
        if (btn) btn.click();
      } catch (e) {}
    }, 400);
  });`
      : ""
  }
})();
</script>`;
    writeFileSync(join(runDir, `${opts.id}.html`), page(`${opts.title}: puck`, opts.blurb, "../styles.css", body));
  }

  for (const c of combos) {
    // The web pack writes its own page, whole, at /web/<app>/ (see
    // buildWebApps above): there is no emulator to embed when the device
    // is the browser already displaying the page.
    if (c.pack === WEB_PACK) continue;
    const entry = c.proven;
    writeRunPage({
      id: c.id,
      title: `${c.app} on ${packLabel.get(c.pack) || c.pack}`,
      pack: c.pack,
      packLabelStr: packLabel.get(c.pack) || c.pack,
      modeStr: modeLabel(entry.mode),
      verifStr: entry.degraded ? `${entry.verification} (degraded)` : entry.verification,
      blurb: c.build.blurb,
      docLinks: [
        { label: "descriptor", href: gh(`${c.appPath}/descriptor.md`) },
        { label: c.build.args.length === 0 ? "reference source" : "port notes", href: gh(c.build.portDoc) },
      ],
      autoRotate: c.app === "chrono",
      attest: { app: c.app, pack: c.pack },
    });
  }

  for (const r of REFERENCE_APPS) {
    writeRunPage({
      id: r.id,
      title: `${packLabel.get(r.pack) || r.pack}: ${r.name}`,
      pack: r.pack,
      packLabelStr: packLabel.get(r.pack) || r.pack,
      modeStr: null,
      verifStr: null,
      blurb: r.blurb,
      docLinks: [{ label: "source", href: gh(r.doc) }],
      autoRotate: false,
    });
  }

  writeRunPage({
    id: INSTRUMENT_EXAMPLE.id,
    title: INSTRUMENT_EXAMPLE.name,
    pack: INSTRUMENT_EXAMPLE.id, // pseudo-pack, registered into packLabel/packPanel above
    packLabelStr: "the instrument itself, no device pack",
    modeStr: null,
    verifStr: null,
    blurb: INSTRUMENT_EXAMPLE.blurb,
    docLinks: [{ label: "source", href: gh(INSTRUMENT_EXAMPLE.doc) }],
    autoRotate: false,
  });

  // A silhouette cell's own page, through the same generator as every
  // other: the only differences are the words, and they are the honest
  // ones. There is no flash section (nothing to flash: there is no
  // firmware) and no attest section (no board has this firmware on it,
  // because there is none), and both of those fall out of the same
  // conditions the pack pages already use rather than from a special case.
  for (const s of silhouetteCombos) {
    const label = packLabel.get(s.silhouette) || s.silhouette;
    const cell = cellFor(s.app, s.silhouette);
    const verdictLine = cell?.verdict ? cell.verdict.human : "";
    const borrowed =
      s.via === WEB_PACK
        ? ""
        : ` This is the app's ${packLabel.get(s.via) || s.via} port's own file, compiled unchanged: this app has no web-pack port of its own, and packs/web vendored that pack's app contract byte for byte, so the file compiles here on its own merits.`;
    writeRunPage({
      id: s.id,
      title: `${s.app} on ${label}`,
      pack: s.silhouette,
      packLabelStr: `${label}, a silhouette: a device.json and nothing else, no firmware`,
      modeStr: "silhouette",
      verifStr: `${s.panel.w}x${s.panel.h}`,
      blurb:
        `Nobody has written firmware for this board. This is ${s.app}'s own C, compiled against that board's own device.json through packs/web and run at its panel size with its buttons, and it proves exactly that much: no driver, no timing, no memory pressure, no silicon.${borrowed}` +
        (verdictLine ? ` ${verdictLine}` : ""),
      docLinks: [
        ...(s.appPath ? [{ label: "descriptor", href: gh(`${s.appPath}/descriptor.md`) }] : []),
        { label: "the board", href: gh(`packs/silhouettes/${s.silhouette}/AGENTS.md`) },
        { label: "device.json", href: gh(`packs/silhouettes/${s.silhouette}/device.json`) },
      ],
      autoRotate: false,
    });
  }
}

// ---- agent-browsable surfaces: llms.txt, registry.json, convention docs,
// each app's descriptor.md, and an HTML mirror (agents.html) -----------
// docs/convention/*.md + registry.json + each app's descriptor.md are
// already the machine-readable contract this repo asks a porting agent to
// read BEFORE writing code (docs/convention/*.md's own "Porting flow"):
// serving them raw under the same domain as the live gallery means an
// agent with only a URL, not a git checkout, reads the real files, never
// an LLM's paraphrase of them. Called from "run everything" below, before
// buildRunDir()/buildIndexHtml() so AGENTS_HTML_VERSION (read by every
// page's own footer, see siteFooter above) is already set by the time
// those write anything.
const AGENT_DOCS = ["docs/convention/device-pack.md", "docs/convention/app-bundle.md"];

function buildAgentSurfaces(): void {
  copyFileSync(join(REPO_ROOT, "registry.json"), join(DIST, "registry.json"));
  console.log("copied -> site/dist/registry.json");

  for (const rel of AGENT_DOCS) {
    const outPath = join(DIST, rel);
    mkdirSync(join(outPath, ".."), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), outPath);
    console.log(`copied -> site/dist/${rel}`);
  }

  const descriptorHrefs: { name: string; href: string }[] = [];
  for (const app of apps) {
    // An app published in its own repository has no descriptor here to
    // serve: it lives at its own url, and copying a clone's copy of it
    // under this domain would be presenting somebody else's document as
    // this site's. The matrix links to their repository instead.
    if (!app.path) continue;
    const outDir = join(DIST, "apps", app.name);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "descriptor.md");
    copyFileSync(join(REPO_ROOT, app.path, "descriptor.md"), outPath);
    descriptorHrefs.push({ name: app.name, href: withVersion(`apps/${app.name}/descriptor.md`, contentHashOf(outPath)) });
    console.log(`copied -> site/dist/apps/${app.name}/descriptor.md`);
  }
  const registryHref = withVersion("registry.json", contentHashOf(join(DIST, "registry.json")));
  const docHrefs = AGENT_DOCS.map((rel) => ({ rel, href: withVersion(rel, contentHashOf(join(DIST, rel))) }));

  // /puck-publish/: where every empty cell in the matrix points. An empty
  // state that only said "no port yet" would be a shrug; this is the
  // procedure for making it not empty, which is a document this repository
  // already has (skills/puck-publish/SKILL.md, the same one an agent is
  // handed). Served whole rather than paraphrased, for the same reason
  // llms.txt serves the convention docs raw: an agent with only a URL
  // should read the real file, never this generator's summary of it.
  const skill = readFileSync(join(REPO_ROOT, "skills", "puck-publish", "SKILL.md"), "utf8");
  const publishDir = join(DIST, "puck-publish");
  mkdirSync(publishDir, { recursive: true });
  writeFileSync(join(publishDir, "SKILL.md"), skill);
  const publishBody = `<div class="wrap">
  <div class="run-header">
    <div class="back"><a href="../index.html">&larr; puck</a></div>
    <h1>porting an app</h1>
    <p class="meta">the procedure behind every empty cell in the matrix: <a href="${gh("skills/puck-publish/SKILL.md")}">skills/puck-publish/SKILL.md</a>, served whole</p>
  </div>
  <section>
    <div class="wrap" style="padding:0">
      <p class="lede">Listing is a reproduction, not a submission. A port appears on this site once <code>bun run verify-bundle</code> has rebuilt its module from its own declared source and replayed its own declared traces, and <code>bun run ledger</code> has written the result down. Nothing here is listed on a claim.</p>
      <pre class="agent-doc">${escapeHtml(skill)}</pre>
    </div>
  </section>
  ${siteFooter("../")}
</div>`;
  writeFileSync(
    join(publishDir, "index.html"),
    page("puck: porting an app", "The step-by-step procedure for porting an app onto a puck device pack and getting it verified.", "../styles.css", publishBody)
  );
  console.log("wrote -> site/dist/puck-publish/index.html");

  const llms = `# puck

Apps that travel between tiny computers: portable app bundles (a descriptor
plus recorded input traces, independent of any one implementation) ported
onto self-contained device packs (real firmware, a device.json an emulator
reads at runtime), verified by a shared emulator and differential harness:
pixel-exact frame diffs for a faithful port, stated behavioral invariants
for an adaptation.

This site (puck.sylve.org) is the gallery: every proven combination runs
live in the browser, compiled to WebAssembly, and the reference RP2350
firmware also flashes onto real hardware over WebUSB.

A browser is one of the target devices, not only the thing the others are
shown in. The "web" pack (Web-Touch) is a device pack like any other: it
declares the same 368x448 panel, the same two buttons and a tilt sensor,
it vendors the RP2350 pack's app contract, and its ports are verified by
the same harness. /web/chrono/, /web/fluidbox/ and /web/tinydraw/ are not
previews of those apps: they are those apps, full-viewport, installable to
a phone's home screen, and offline once installed.

## Machine-readable surfaces on this domain

- /registry.json: local paths and external URLs for every device pack and app bundle this repo knows about.
- /docs/convention/device-pack.md: what a device pack must contain.
- /docs/convention/app-bundle.md: what an app bundle (descriptor + traces) must contain, including how an affordance carries its intent.
- /apps/<name>/descriptor.md: the portable descriptor for each proven app (chrono, fluidbox, tinydraw, gameos).
- /web/<name>/: the app itself, running on the browser as its target device (chrono, fluidbox, tinydraw).
- https://github.com/s0lness/puck: the repository itself, MIT licensed.

## Consuming a pack or app as an agent

1. git clone https://github.com/s0lness/puck
2. Read docs/convention/device-pack.md and docs/convention/app-bundle.md.
3. Pick a target device pack from registry.json; read its own AGENTS.md and device.json.
4. Pick an app from registry.json; read its descriptor.md and bundle.json (its "ports" array: pack, mode, verification).
5. Give a verdict against the target pack's device.json before writing any code: go, degraded, or refuse, stated plainly.
6. Build: bun install, then bun run <pack>/wasm/build.ts (writes wasm/dist/emu.wasm), then bun run dev for http://127.0.0.1:5340.
7. Verify: bun run verify-bundle <bundle> rebuilds every declared port and replays its traces end to end; bun run harness:selftest proves the differential harness with no hardware; bun run harness/diff.ts <trace.json> --link <yourBoardLink.ts> replays a trace against real hardware and diffs the resulting frames.

## Further reading

- docs/harness.md: how the differential harness proves a port.
- docs/abi.md: the ABI every firmware implements.
- AGENTS.md: conventions and gotchas, repo root.
`;
  writeFileSync(join(DIST, "llms.txt"), llms);
  console.log("wrote -> site/dist/llms.txt");

  const surfaceLinks = [
    `<li><a href="${registryHref}">registry.json</a>: local paths and external URLs for every device pack and app bundle.</li>`,
    ...docHrefs.map((d) => `<li><a href="${d.href}">${escapeHtml(d.rel)}</a></li>`),
    ...descriptorHrefs.map((d) => `<li><a href="${d.href}">apps/${escapeHtml(d.name)}/descriptor.md</a></li>`),
    `<li><a href="${gh("README.md")}">github.com/s0lness/puck</a>, MIT licensed.</li>`,
  ].join("\n        ");

  const agentsBody = `<div class="wrap">
  <div class="run-header">
    <div class="back"><a href="index.html">&larr; puck</a></div>
    <h1>puck, for an agent</h1>
    <p class="meta">the same content as <a href="${withVersion("llms.txt", contentHashOf(join(DIST, "llms.txt")))}">/llms.txt</a>, in HTML</p>
  </div>
  <section>
    <div class="wrap" style="padding:0">
      <h2>machine-readable surfaces</h2>
      <ul class="agent-links">
        ${surfaceLinks}
      </ul>
      <pre class="agent-doc">${escapeHtml(llms)}</pre>
    </div>
  </section>
  ${siteFooter("")}
</div>`;
  writeFileSync(
    join(DIST, "agents.html"),
    page(
      "puck: for an agent",
      "What this site is, its machine-readable surfaces (registry.json, convention docs, app descriptors), and how an agent consumes a pack or app.",
      "styles.css",
      agentsBody
    )
  );
  AGENTS_HTML_VERSION = contentHashOf(join(DIST, "agents.html"));
  console.log("wrote -> site/dist/agents.html");
}

// ---- run everything -------------------------------------------------
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

buildAllModules();
buildWebApps();
buildEmulatorBundle();
copyFileSync(join(SITE_DIR, "styles.css"), join(DIST, "styles.css"));
STYLES_VERSION = contentHashOf(join(DIST, "styles.css"));
copyFlashArtifacts();
// Every id the landing page's own demoThumb() calls link to: the primary
// (first-proven-pack) combo per app, plus every reference tile - the same
// set site/record-demos.ts records.
// Every combo the matrix can show a recorded loop for, rather than one per
// app: a matrix cell is per app AND per device, so gameos on the RP2350 and
// gameos on the ESP32-S3 are two different cells and two different clips.
// Filtered by what site/record-demos.ts has actually recorded, since a
// missing loop is a cell that reads fine without a picture, not a build
// failure (copyDemoMedia's own warning covers the fresh-clone case).
const DEMO_IDS = [...combos.map((c) => c.id).filter(hasDemoMedia), ...REFERENCE_APPS.map((r) => r.id), INSTRUMENT_EXAMPLE.id];
copyDemoMedia(DEMO_IDS);
copyProofs();
// After copyFlashArtifacts (it reads which combos actually have a flashable
// artifact) and before buildRunDir (it reads which combos got a plan).
buildAttestPlans();
await buildFlashUi();
buildAgentSurfaces();
buildRunDir();
buildIndexHtml();

function totalSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) total += totalSize(p);
    else total += Bun.file(p).size;
  }
  return total;
}
const bytes = totalSize(DIST);
console.log(`\nbuilt site/dist/ (${(bytes / 1024).toFixed(0)} KiB)`);
