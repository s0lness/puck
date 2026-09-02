#!/usr/bin/env bun
// puck ledger: every app in registry.json against every target in it, one
// row per pair, written to ledger.json at the repository root.
//
//   bun run ledger [--force] [--app <name>] [--target <name>]
//
// WHY THIS FILE EXISTS. The gallery used to be a list of ports that had
// been proven, walked out of each bundle.json by site/build.ts. A list can
// only ever say what worked: an app nobody has ported is absent, a device
// nobody has written firmware for is absent, and an external bundle whose
// build broke last week is absent, which is the one absence that matters
// most. This computes the whole grid instead, including every cell that
// does NOT run, and site/build.ts renders it. A cell either runs the app's
// own C or says plainly what is missing, and neither of those is a
// sentence anybody types.
//
// WHAT A CELL HOLDS, and how far each mark reaches (docs/harness.md's
// "three marks", plus two the roadmap's workstream 3 adds):
//
//   verdict     tools/verdict.ts's mechanical go / degraded / refuse, from
//               the app descriptor's own `json demands` against the
//               target's device.json. Two documents compared, never a
//               prediction that the port runs. Computed in-process through
//               that file's own computeVerdict(), not by shelling out.
//   emulator    tools/verify-bundle.ts's verdict for this port: the module
//               rebuilt from the port's own declared source and its own
//               declared traces replayed, pixel-exact or by invariants.
//               "no port" when the bundle declares none for this target.
//   host        harness/hostdiff.ts: the same C built natively with
//               -fsanitize=address,undefined and replayed against the wasm
//               build, frame for frame. MATCH, DIVERGE with the pixel
//               count, SANITIZER, BUILD_FAILED (no executable came out),
//               or CRASHED (one did, and the replay through it did not
//               finish). "not run" and why, for a target with no host
//               build to make.
//   silicon     a key and nothing else. Only a real board can answer this
//               one, and only a person holding it can make it: the count
//               arrives at page load from GET /api/attest, which keys on
//               exactly the string stored here. See
//               docs/decisions/0011-attestation-is-a-run-not-a-claim.md.
//               THIS REPLACES bundle.json's hand-typed `silicon.attestedAt`
//               as what the gallery reads. The field stays in the bundles
//               as the record of what was done on a bench; nothing in
//               site/ reads it any more.
//   silhouette  for a silhouette target: whether packs/web's host build
//               compiled this app against that device.json and the page it
//               produced actually painted that panel
//               (scripts/silhouetteProof.ts), plus the proof PNG.
//
// INCREMENTAL, BY INPUT SHA, NOT BY CLOCK (docs/decisions/0009: a proof of
// pinned inputs does not decay). A cell carries the tree hash of the app
// bundle, the tree hash of the pack that builds it, and the hash of
// tools/verdict.ts. A rerun reuses any cell whose three hashes are
// unchanged, so a full sweep costs minutes once and seconds afterwards.
// --force recomputes everything.
//
// THE HONEST GAP IN THAT: those three hashes do not cover the shared
// instrument (src/, harness/, wasm/emu_abi.h). A change to the replay path
// or the comparison does not invalidate a cell, because hashing the whole
// repository would invalidate every cell on every commit and nobody would
// run this. --force is the answer, and this sentence is the warning.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import puppeteer, { type Browser } from "puppeteer-core";
import { computeVerdict, readDemands, DemandsUnavailable, type Demands, type DeviceJson, type VerdictResult } from "./verdict";
import { buildSilhouette, proveSilhouettePage, type SilhouetteMark } from "../scripts/silhouetteProof";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LEDGER_PATH = join(REPO_ROOT, "ledger.json");

// Same env-first shape every build script in this repository uses
// (AGENTS.md's "every executable path a build script needs is env-first"),
// with the same one-machine last resort tools/verify-bundle.ts already
// carries, and for the same reason: this file spawns those scripts.
const ZIG_EXE = process.env.ZIG_EXE ?? (process.platform === "win32" ? "C:\\Users\\sylve\\tools\\zig\\zig.exe" : "zig");

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

// ---- the ledger's own shape ----------------------------------------------

export type EmulatorMark = "PASS" | "FAIL" | "ERROR" | "no port";
export type HostMark = "MATCH" | "DIVERGE" | "SANITIZER" | "BUILD_FAILED" | "CRASHED" | "not run";

export interface LedgerVerdict {
  verdict: "go" | "degraded" | "refuse";
  human: string;
  /** Every dimension the app states, with its own status and reason. */
  checks: { dimension: string; status: string; reason: string }[];
  /** Every degrade the app declares, with the number this target lands on. */
  degrades: { name: string; what: string; value: number; reference: number; boundBy: string }[];
}

export interface LedgerCell {
  app: string;
  target: string;
  targetKind: "pack" | "silhouette" | "external-pack";
  /** null when nothing could compute one: no machine-readable demands, or a target with no device.json here. */
  verdict: LedgerVerdict | null;
  /** Why there is no verdict, when there is none. */
  verdictUnavailable: string | null;
  /**
   * The bundle's own port entry for this target, flattened, or null when it
   * declares none. `declaredVerdict` is what the PORT'S AUTHOR wrote, which
   * is a different thing from `verdict` above and is allowed to disagree
   * with it: docs/convention/app-bundle.md asks a port's prose verdict to
   * agree with the mechanical one or argue against it explicitly, and it
   * cannot do either if only one of the two is ever recorded.
   */
  port: { mode: string; verification: string; declaredVerdict: string | null; source: string | null; external: boolean; provenance: string | null } | null;
  emulator: { mark: EmulatorMark; reason: string };
  host: { mark: HostMark; reason: string };
  /**
   * The string GET /api/attest keys its counts on. Nothing about silicon is
   * computed here: a board is the only thing that can answer, and the page
   * asks the endpoint at load.
   */
  silicon: { key: string };
  silhouette: {
    mark: SilhouetteMark | "not applicable";
    reason: string;
    /** Repo-relative path to the PNG the run wrote, or null. */
    proof: string | null;
    /** Which port source was compiled against the silhouette, when one was. */
    source: string | null;
    /** Which pack's port that source belongs to: "gameos ran here" and "gameos's RP2350 port ran here" are not the same sentence. */
    via: string | null;
    /** That port's own build arguments, so site/build.ts rebuilds the identical module rather than guessing at a flag. */
    buildArgs: string[];
    panel: { w: number; h: number } | null;
  };
  inputs: { bundleSha: string; packSha: string; verdictToolSha: string };
  /** YYYY-MM-DD, the day this cell was last actually computed. */
  computedAt: string;
}

export interface LedgerTarget {
  name: string;
  kind: "pack" | "silhouette" | "external-pack";
  /** The device's own name from its device.json, when there is one to read. */
  label: string;
  path: string | null;
  panel: { w: number; h: number; format: string } | null;
  /** A silhouette's provenance, carried so the gallery can say the numbers are unverified. */
  provenance: { datasheet?: string; verified?: boolean; hypothetical?: boolean; note?: string } | null;
}

export interface LedgerApp {
  name: string;
  kind: "local" | "external";
  path: string | null;
  url: string | null;
  commit: string | null;
  /** "reproduced from <repo>@<sha> on <date>", for an external bundle. */
  provenance: string | null;
}

export interface Ledger {
  convention: string;
  /** The newest computedAt across every cell. Derived, so two runs with no input change write the same file. */
  generatedAt: string;
  apps: LedgerApp[];
  targets: LedgerTarget[];
  /** Keyed "<app>:<target>". */
  cells: Record<string, LedgerCell>;
}

const CONVENTION = "0.1";

// ---- registry ------------------------------------------------------------

interface RegistryEntry {
  name: string;
  path?: string;
  url?: string;
  commit?: string;
}
interface Registry {
  packs: RegistryEntry[];
  silhouettes?: RegistryEntry[];
  apps: RegistryEntry[];
}

interface BundlePort {
  pack: string;
  mode: string;
  verdict?: string;
  verification: { kind: string; [k: string]: unknown };
  source?: string;
  buildArgs?: string[];
  build?: { repo: string; commit: string; command: string; artifact: string };
}
interface Bundle {
  convention: string;
  name: string;
  ports: BundlePort[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---- input hashing -------------------------------------------------------
// A directory's tree hash: every file's repo-relative path and its content
// sha, in sorted order, hashed together. Build output and generated proofs
// are skipped, and `proof/` in particular MUST be, since this file writes
// into it: a cell whose own output was part of its input hash would
// recompute forever.
const HASH_SKIP = new Set(["dist", "build", "out", "node_modules", ".git", "proof", "__pycache__"]);

function treeHash(dir: string): string {
  if (!existsSync(dir)) return "absent";
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string): void => {
    const names = readdirSync(current).sort();
    for (const name of names) {
      if (HASH_SKIP.has(name)) continue;
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else hash.update(`${rel}\u0000${createHash("sha256").update(readFileSync(full)).digest("hex")}\u0000`);
    }
  };
  walk(dir, "");
  return hash.digest("hex").slice(0, 16);
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- spawning the tools this file orchestrates ---------------------------
// Nothing here reimplements a build, a replay or a comparison: it runs the
// same commands a person runs and reads what they print. That is the whole
// reason verify-bundle and hostdiff grew a --json flag.

interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Terminal colour has no business in a JSON document that a web page then
// prints: bun and the tools it runs colour their own errors, and a reason
// string carrying raw escape bytes renders as garbage on a gallery cell and
// diffs noisily in a committed file.
const ANSI = /\u001b\[[0-9;]*m/g;
function plain(text: string): string {
  return text.replace(ANSI, "");
}

async function runCaptured(args: string[], timeoutMs: number): Promise<Captured> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ZIG_EXE },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout: plain(stdout), stderr: plain(stderr), timedOut };
}

/**
 * The last top-level JSON object printed on stdout. Both tools print a
 * progress log and then their --json payload, so this reads from the last
 * line that is a bare "{" rather than trying to parse the whole stream.
 */
function tailJson<T>(stdout: string): T | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trimEnd() !== "{") continue;
    try {
      return JSON.parse(lines.slice(i).join("\n")) as T;
    } catch {
      return null;
    }
  }
  return null;
}

const VERIFY_BUNDLE_TIMEOUT_MS = 20 * 60 * 1000;
const HOSTDIFF_TIMEOUT_MS = 20 * 60 * 1000;

interface VerifyBundleJson {
  ports: { pack: string; mode: string; kind: string; status: "pass" | "fail" | "error"; reason: string; provenance?: string }[];
}

/** One verify-bundle run covers every port of one app, so this is called per app, not per cell. */
async function runVerifyBundle(target: string): Promise<{ byPack: Map<string, VerifyBundleJson["ports"][number]>; failure: string | null }> {
  const r = await runCaptured(["run", "tools/verify-bundle.ts", target, "--json"], VERIFY_BUNDLE_TIMEOUT_MS);
  const byPack = new Map<string, VerifyBundleJson["ports"][number]>();
  if (r.timedOut) return { byPack, failure: `verify-bundle ${target} was killed after ${VERIFY_BUNDLE_TIMEOUT_MS / 60000} minutes` };
  const parsed = tailJson<VerifyBundleJson>(r.stdout);
  if (!parsed || !Array.isArray(parsed.ports)) {
    const tail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
    return { byPack, failure: `verify-bundle ${target} exited ${r.exitCode} without a port list${tail ? `: ${tail}` : ""}` };
  }
  for (const p of parsed.ports) byPack.set(p.pack, p);
  return { byPack, failure: null };
}

interface HostDiffJson {
  results: { trace: string; atMs: number; verdict: "match" | "diverge" | "sanitizer"; diffPixels?: number; totalPixels?: number }[];
  allMatch: boolean;
  sanitizers: string[];
}

/**
 * ONE RETRY, AND HERE IS WHY. `zig cc` on this project's development machine
 * exits 5 with no diagnostic text at all, reproducibly, on its FIRST native
 * compile after a wasm build in another process (measured while writing this
 * file: twelve isolated runs, zero failures; the same compile immediately
 * after a `packs/web/wasm/build.ts` run, one failure then three successes).
 * harness/hostSide.ts already retries eight times for exactly that flake, and
 * under the load this file puts on the machine it can still exhaust them. A
 * BUILD_FAILED mark is a real thing to record, so it is never suppressed; it
 * just has to mean "the sanitized build failed twice over" rather than "zig
 * lost a race once", or the ledger would be publishing a toolchain hiccup as
 * a fact about somebody's firmware.
 */
// Growing, not fixed: harness/hostSide.ts's own eight retries are 400ms
// apart and can all land inside one stuck window, which is exactly the
// failure this backs off from.
const HOSTDIFF_FLAKE_PAUSES_MS = [5_000, 20_000];

async function runHostDiff(app: string, pack: string): Promise<{ mark: HostMark; reason: string }> {
  // Only a BUILD_FAILED is retried. A CRASHED run is a fact about the
  // firmware and the sanitizers, not about the toolchain losing a race, and
  // running it again would only produce the same crash more slowly.
  let last = await runHostDiffOnce(app, pack);
  for (const pause of HOSTDIFF_FLAKE_PAUSES_MS) {
    if (last.mark !== "BUILD_FAILED") return last;
    await new Promise((r) => setTimeout(r, pause));
    last = await runHostDiffOnce(app, pack);
  }
  if (last.mark !== "BUILD_FAILED") return last;
  return { mark: "BUILD_FAILED", reason: `${last.reason} (on all ${HOSTDIFF_FLAKE_PAUSES_MS.length + 1} attempts, backing off ${HOSTDIFF_FLAKE_PAUSES_MS.map((p) => `${p / 1000}s`).join(" then ")})` };
}

async function runHostDiffOnce(app: string, pack: string): Promise<{ mark: HostMark; reason: string }> {
  const r = await runCaptured(["run", "harness/hostdiff.ts", app, pack, "--json"], HOSTDIFF_TIMEOUT_MS);
  if (r.timedOut) return { mark: "BUILD_FAILED", reason: `hostdiff was killed after ${HOSTDIFF_TIMEOUT_MS / 60000} minutes` };
  const parsed = tailJson<HostDiffJson>(r.stdout);
  if (!parsed) {
    // hostdiff exits 2 before it prints anything when a build fails, and
    // says why on stderr. That sentence is the mark's whole value. A run
    // with no BUILD_FAILED line got further than that: an executable was
    // produced and the replay through it did not finish, which is a
    // different fact and gets a different word.
    const combined = `${r.stdout}\n${r.stderr}`;
    const build = /BUILD_FAILED:([\s\S]*?)(\n\n|$)/.exec(combined);
    const tail = (build ? build[1]! : r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ").slice(0, 400);
    if (build) return { mark: "BUILD_FAILED", reason: tail || `hostdiff exited ${r.exitCode} with nothing to say` };
    return { mark: "CRASHED", reason: tail || `hostdiff exited ${r.exitCode} without reaching a comparison, and said nothing` };
  }
  const sanitized = parsed.results.find((x) => x.verdict === "sanitizer");
  if (sanitized) return { mark: "SANITIZER", reason: `the sanitized host build trapped on ${sanitized.trace} (${parsed.sanitizers.join(", ")})` };
  if (parsed.allMatch) {
    return { mark: "MATCH", reason: `${parsed.results.length}/${parsed.results.length} capture point(s) identical to the wasm build, sanitizers ${parsed.sanitizers.join(", ")}` };
  }
  const diverged = parsed.results.filter((x) => x.verdict === "diverge");
  const first = diverged[0]!;
  const pct = first.totalPixels ? ((first.diffPixels! / first.totalPixels) * 100).toFixed(2) : "?";
  return {
    mark: "DIVERGE",
    reason: `${diverged.length}/${parsed.results.length} capture point(s) differ from the wasm build, first ${first.trace} t=${first.atMs}ms at ${first.diffPixels}/${first.totalPixels}px (${pct}%)`,
  };
}

// ---- resolution ----------------------------------------------------------

interface ResolvedApp extends LedgerApp {
  /** Absolute path to the directory holding bundle.json and descriptor.md. */
  dir: string;
  /** What to hand verify-bundle: a repo-relative path for a local app, the url for an external one. */
  verifyTarget: string;
  bundle: Bundle | null;
  bundleError: string | null;
  demands: Demands | null;
  demandsError: string | null;
  bundleSha: string;
}

/**
 * The same pinned fetch tools/verify-bundle.ts's cloneBundle() performs:
 * init, fetch --depth 1 the pinned sha, checkout FETCH_HEAD, and check that
 * HEAD is what registry.json pinned. Repeated here rather than shared
 * because that function is private to a CLI that also verifies; if a third
 * caller appears it should move, and this comment is the note saying so.
 */
function cloneAtPin(url: string, commit: string): { dir: string; error: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "puck-ledger-clone-"));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const tail = (r: ReturnType<typeof run>) => (r.stderr ? r.stderr.toString().trim() : "");
  const init = Bun.spawnSync(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
  if (!init.success) return { dir, error: `could not git init: ${tail(init)}` };
  const remote = run(["remote", "add", "origin", "--", url]);
  if (!remote.success) return { dir, error: `could not add ${url} as a remote: ${tail(remote)}` };
  const fetched = run(["fetch", "--depth", "1", "origin", commit]);
  if (!fetched.success) return { dir, error: `could not fetch ${commit} from ${url}: ${tail(fetched)}` };
  const co = run(["checkout", "--quiet", "FETCH_HEAD"]);
  if (!co.success) return { dir, error: `fetched ${commit} but could not check it out: ${tail(co)}` };
  const rev = run(["rev-parse", "HEAD"]);
  const head = rev.stdout ? rev.stdout.toString().trim() : "";
  if (!rev.success || head !== commit) return { dir, error: `checked out HEAD=${head || "(unknown)"}, which is not the commit registry.json pins (${commit})` };
  return { dir, error: null };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// ---- the silhouette source an app is compiled from ------------------------
// Data-driven, never a table here: an app's own bundle.json says which file
// is its web-pack port, and packs/web vendored the RP2350 pack's app
// contract byte for byte (docs/convention/device-pack.md, "Self-containment
// cuts both ways"), so an app with no web port at all can still be tried
// with its RP2350 port's file. Which one was used is recorded on the cell,
// because "gameos ran on this silhouette" and "gameos's RP2350 port ran on
// this silhouette" are not the same sentence.
const SILHOUETTE_SOURCE_PACKS = ["web", "rp2350-touch-amoled-18"];

function silhouetteSourceFor(bundle: Bundle | null): { source: string; buildArgs: string[]; via: string } | null {
  if (!bundle) return null;
  for (const pack of SILHOUETTE_SOURCE_PACKS) {
    const port = bundle.ports.find((p) => p.pack === pack && typeof p.source === "string");
    if (port) return { source: port.source!, buildArgs: port.buildArgs ?? [], via: pack };
  }
  return null;
}

// ---- run -----------------------------------------------------------------

interface Args {
  force: boolean;
  app: string | null;
  target: string | null;
}

function parseArgs(argv: string[]): Args {
  let app: string | null = null;
  let targetName: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app") app = argv[++i] ?? null;
    else if (argv[i] === "--target") targetName = argv[++i] ?? null;
  }
  return { force: argv.includes("--force"), app, target: targetName };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson<Registry>(join(REPO_ROOT, "registry.json"));
  const verdictToolSha = fileHash(join(REPO_ROOT, "tools", "verdict.ts"));
  const webPackSha = treeHash(join(REPO_ROOT, "packs", "web"));

  const previous: Ledger | null = existsSync(LEDGER_PATH) ? readJson<Ledger>(LEDGER_PATH) : null;

  // ---- targets ----------------------------------------------------------
  const targets: LedgerTarget[] = [];
  const deviceOf = new Map<string, DeviceJson>();
  const packShaOf = new Map<string, string>();

  for (const pack of registry.packs) {
    if (!pack.path) continue;
    const device = readJson<DeviceJson>(join(REPO_ROOT, pack.path, "device.json"));
    deviceOf.set(pack.name, device);
    packShaOf.set(pack.name, treeHash(join(REPO_ROOT, pack.path)));
    targets.push({
      name: pack.name,
      kind: "pack",
      label: device.name ?? pack.name,
      path: pack.path,
      panel: device.panel ? { w: device.panel.w, h: device.panel.h, format: device.panel.format ?? "" } : null,
      provenance: null,
    });
  }

  // ---- apps -------------------------------------------------------------
  const cleanups: string[] = [];
  const apps: ResolvedApp[] = [];
  for (const entry of registry.apps) {
    const kind: "local" | "external" = entry.path ? "local" : "external";
    let dir = entry.path ? join(REPO_ROOT, entry.path) : "";
    let bundleError: string | null = null;
    let provenance: string | null = null;
    let bundleSha = "";

    if (kind === "external") {
      if (!entry.url || !entry.commit) {
        bundleError = `registry.json's "${entry.name}" entry has no url or no commit pin, and nothing here verifies an unpinned clone`;
      } else {
        const cloned = cloneAtPin(entry.url, entry.commit);
        dir = cloned.dir;
        cleanups.push(cloned.dir);
        bundleError = cloned.error;
        // The commit IS the tree hash for a repository pinned by sha: there
        // is nothing else it could be, and hashing a clone would only be a
        // slower way of saying the same thing.
        bundleSha = entry.commit.slice(0, 16);
      }
    } else {
      bundleSha = treeHash(dir);
    }

    let bundle: Bundle | null = null;
    if (!bundleError) {
      const bundlePath = join(dir, "bundle.json");
      if (!existsSync(bundlePath)) bundleError = `no bundle.json at ${bundlePath}`;
      else {
        try {
          bundle = readJson<Bundle>(bundlePath);
        } catch (err) {
          bundleError = `${bundlePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    let demands: Demands | null = null;
    let demandsError: string | null = null;
    const descriptorPath = join(dir, "descriptor.md");
    if (!bundleError && existsSync(descriptorPath)) {
      try {
        demands = readDemands(descriptorPath);
      } catch (err) {
        demandsError = err instanceof DemandsUnavailable ? err.message.replace(`${descriptorPath}`, `${entry.name}'s descriptor.md`) : String(err);
      }
    } else if (!bundleError) {
      demandsError = `${entry.name} has no descriptor.md, so it states no demands anything could compare`;
    }

    if (kind === "external" && entry.url && entry.commit) {
      provenance = `reproduced from ${entry.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}@${shortSha(entry.commit)}`;
    }

    apps.push({
      name: entry.name,
      kind,
      path: entry.path ?? null,
      url: entry.url ?? null,
      commit: entry.commit ?? null,
      provenance,
      dir,
      verifyTarget: entry.path ?? entry.url ?? entry.name,
      bundle,
      bundleError,
      demands,
      demandsError: demandsError ?? bundleError,
      bundleSha,
    });
  }

  // ---- targets, part two: packs an app declares that this repo does not
  // carry. The external tinydraw bundle's only port names its author's own
  // pack, and dropping that column would drop the one cell whose failure
  // this whole ledger exists to stop hiding.
  const knownPacks = new Set(registry.packs.map((p) => p.name));
  for (const app of apps) {
    for (const port of app.bundle?.ports ?? []) {
      if (knownPacks.has(port.pack) || targets.some((t) => t.name === port.pack)) continue;
      targets.push({ name: port.pack, kind: "external-pack", label: port.pack, path: null, panel: null, provenance: null });
      packShaOf.set(port.pack, port.build ? port.build.commit.slice(0, 16) : "external");
    }
  }

  for (const silhouette of registry.silhouettes ?? []) {
    if (!silhouette.path) continue;
    const device = readJson<DeviceJson>(join(REPO_ROOT, silhouette.path, "device.json"));
    deviceOf.set(silhouette.name, device);
    // The silhouette's own descriptor AND the pack that compiles against it:
    // a change to either really does change what this cell means.
    packShaOf.set(silhouette.name, `${treeHash(join(REPO_ROOT, silhouette.path))}-${webPackSha}`);
    targets.push({
      name: silhouette.name,
      kind: "silhouette",
      label: device.name ?? silhouette.name,
      path: silhouette.path,
      panel: device.panel ? { w: device.panel.w, h: device.panel.h, format: device.panel.format ?? "" } : null,
      provenance: device.provenance ?? null,
    });
  }

  // ---- decide what needs recomputing ------------------------------------
  interface Pending {
    app: ResolvedApp;
    target: LedgerTarget;
    key: string;
    inputs: LedgerCell["inputs"];
  }
  const cells: Record<string, LedgerCell> = {};
  const pending: Pending[] = [];

  for (const app of apps) {
    for (const target of targets) {
      const key = `${app.name}:${target.name}`;
      const inputs = { bundleSha: app.bundleSha, packSha: packShaOf.get(target.name) ?? "unknown", verdictToolSha };
      const selected = (!args.app || args.app === app.name) && (!args.target || args.target === target.name);
      const cached = previous?.cells[key];
      const reusable =
        !args.force &&
        cached !== undefined &&
        cached.inputs.bundleSha === inputs.bundleSha &&
        cached.inputs.packSha === inputs.packSha &&
        cached.inputs.verdictToolSha === inputs.verdictToolSha;
      if (!selected || reusable) {
        if (cached) cells[key] = cached;
        else if (selected) pending.push({ app, target, key, inputs });
        continue;
      }
      pending.push({ app, target, key, inputs });
    }
  }

  console.log(`ledger: ${apps.length} app(s) x ${targets.length} target(s) = ${apps.length * targets.length} cell(s), ${pending.length} to compute`);
  if (pending.length === 0) console.log("every cell's inputs are unchanged. --force recomputes anyway.");

  // ---- the emulator mark, one verify-bundle run per app -----------------
  const verifyByApp = new Map<string, { byPack: Map<string, VerifyBundleJson["ports"][number]>; failure: string | null }>();
  const appsNeedingVerify = new Set(pending.filter((p) => (p.app.bundle?.ports ?? []).some((port) => port.pack === p.target.name)).map((p) => p.app.name));
  for (const app of apps) {
    if (!appsNeedingVerify.has(app.name)) continue;
    console.log(`\n-- verify-bundle ${app.verifyTarget}`);
    const result = await runVerifyBundle(app.verifyTarget);
    if (result.failure) console.log(`   ${result.failure}`);
    else for (const [pack, port] of result.byPack) console.log(`   ${pack}: ${port.status}`);
    verifyByApp.set(app.name, result);
  }

  // ---- the host mark ----------------------------------------------------
  for (const p of pending) {
    if (p.target.kind !== "pack") continue;
    const port = p.app.bundle?.ports.find((x) => x.pack === p.target.name);
    if (!port || port.build || p.app.kind !== "local") continue;
    if (!existsSync(join(REPO_ROOT, p.target.path!, "wasm", "host.ts"))) continue;
    console.log(`\n-- hostdiff ${p.app.name} x ${p.target.name}`);
    const result = await runHostDiff(p.app.name, p.target.name);
    console.log(`   ${result.mark}: ${result.reason}`);
    (p as Pending & { host?: { mark: HostMark; reason: string } }).host = result;
  }

  // ---- the silhouette mark, one browser for all of them -----------------
  const silhouettePending = pending.filter((p) => p.target.kind === "silhouette");
  let browser: Browser | null = null;
  if (silhouettePending.length > 0) {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || findChrome(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  const silhouetteResults = new Map<string, LedgerCell["silhouette"]>();
  let proofPort = 53420;
  try {
    for (const p of silhouettePending) {
      const panel = p.target.panel;
      const pick = silhouetteSourceFor(p.app.bundle);
      if (!panel) {
        silhouetteResults.set(p.key, { mark: "build-failed", reason: `${p.target.name}'s device.json declares no panel`, proof: null, source: null, via: null, buildArgs: [], panel: null });
        continue;
      }
      if (!pick) {
        silhouetteResults.set(p.key, {
          mark: "build-failed",
          reason: `${p.app.name}'s bundle names no port source this pack could compile: a silhouette runs through packs/web, and this bundle declares no web port and no rp2350 port to borrow one from`,
          proof: null,
          source: null,
          via: null,
          buildArgs: [],
          panel: { w: panel.w, h: panel.h },
        });
        continue;
      }
      console.log(`\n-- silhouette ${p.app.name} x ${p.target.name} (${pick.source}, via the ${pick.via} port)`);
      const built = buildSilhouette({ silhouette: p.target.name, app: p.app.name, source: pick.source, buildArgs: pick.buildArgs });
      if (!built.ok) {
        console.log(`   build failed`);
        silhouetteResults.set(p.key, { mark: "build-failed", reason: built.error, proof: null, source: pick.source, via: pick.via, buildArgs: pick.buildArgs, panel: { w: panel.w, h: panel.h } });
        continue;
      }
      const proofPath = join(REPO_ROOT, "packs", "silhouettes", p.target.name, "proof", `${p.app.name.replace(/[\\/]/g, "-")}.png`);
      const proof = await proveSilhouettePage(browser!, built.distDir, { w: panel.w, h: panel.h }, proofPath, proofPort++);
      console.log(`   ${proof.mark}: ${proof.reason}`);
      silhouetteResults.set(p.key, {
        mark: proof.mark,
        reason: proof.reason,
        proof: proof.proof,
        source: pick.source,
        via: pick.via,
        buildArgs: pick.buildArgs,
        panel: { w: panel.w, h: panel.h },
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // ---- assemble ---------------------------------------------------------
  const day = today();
  for (const p of pending) {
    const { app, target, key, inputs } = p;
    const device = deviceOf.get(target.name);
    const port = app.bundle?.ports.find((x) => x.pack === target.name) ?? null;

    let verdict: LedgerVerdict | null = null;
    let verdictUnavailable: string | null = null;
    if (!device) {
      verdictUnavailable = `this repository carries no device.json for "${target.name}": it is a pack an app's own bundle names and nothing here can read, so there is nothing to compare a demand against`;
    } else if (!app.demands) {
      verdictUnavailable = app.demandsError ?? `${app.name} states no machine-readable demands`;
    } else {
      const computed: VerdictResult = computeVerdict(app.name, target.name, target.kind === "silhouette" ? "silhouette" : "pack", app.demands, device);
      verdict = {
        verdict: computed.verdict,
        human: computed.human,
        checks: computed.checks.map((c) => ({ dimension: c.dimension, status: c.status, reason: c.reason })),
        degrades: computed.degrades.map((d) => ({ name: d.name, what: d.what, value: d.value, reference: d.reference, boundBy: d.boundBy })),
      };
    }

    let emulator: LedgerCell["emulator"];
    if (!port) {
      emulator = { mark: "no port", reason: app.bundleError ?? `${app.name}'s bundle.json declares no port for ${target.name}` };
    } else {
      const run = verifyByApp.get(app.name);
      const result = run?.byPack.get(target.name);
      if (!result) emulator = { mark: "ERROR", reason: run?.failure ?? `verify-bundle reported nothing for ${target.name}` };
      else if (result.status === "pass") emulator = { mark: "PASS", reason: result.reason };
      else if (result.status === "fail") emulator = { mark: "FAIL", reason: result.reason };
      else emulator = { mark: "ERROR", reason: result.reason };
    }

    let host: LedgerCell["host"] = (p as Pending & { host?: { mark: HostMark; reason: string } }).host ?? {
      mark: "not run",
      reason: "",
    };
    if (host.reason === "" && host.mark === "not run") {
      if (target.kind === "silhouette") host.reason = "a silhouette has no firmware to build natively: it is one device.json and nothing else";
      else if (target.kind === "external-pack") host.reason = `"${target.name}" is a pack this repository does not carry, so there is no wasm/host.ts here to build against`;
      else if (!port) host.reason = `${app.name}'s bundle.json declares no port for ${target.name}, so there is nothing to build twice`;
      else if (port.build) host.reason = "this port is built by its own repository at a pinned commit, and hostdiff needs a local pack to make a second, sanitized build from";
      else if (app.kind !== "local") host.reason = "hostdiff reads traces and frames out of a local bundle";
      else host.reason = `pack "${target.name}" exposes no wasm/host.ts`;
    }

    const silhouette: LedgerCell["silhouette"] =
      target.kind === "silhouette"
        ? (silhouetteResults.get(key) ?? { mark: "build-failed", reason: "not computed", proof: null, source: null, via: null, buildArgs: [], panel: null })
        : {
            mark: "not applicable",
            reason: target.kind === "pack" ? "this target has firmware of its own, so it is proven by the emulator and host marks rather than by a silhouette run" : "this is a pack carried by its own author, not a silhouette",
            proof: null,
            source: null,
            via: null,
            buildArgs: [],
            panel: null,
          };

    cells[key] = {
      app: app.name,
      target: target.name,
      targetKind: target.kind,
      verdict,
      verdictUnavailable,
      port: port
        ? {
            mode: port.mode,
            verification: port.verification.kind,
            declaredVerdict: port.verdict ?? null,
            source: port.source ?? null,
            external: Boolean(port.build),
            provenance: port.build ? `built by ${port.build.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}@${shortSha(port.build.commit)}, its own command: ${port.build.command}` : null,
          }
        : null,
      emulator,
      host,
      silicon: { key: `${app.name}:${target.name}` },
      silhouette,
      inputs,
      computedAt: day,
    };
  }

  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });

  // ---- write ------------------------------------------------------------
  const ordered: Record<string, LedgerCell> = {};
  for (const key of Object.keys(cells).sort()) ordered[key] = cells[key]!;
  const newest = Object.values(ordered).reduce((max, c) => (c.computedAt > max ? c.computedAt : max), "1970-01-01");

  const ledger: Ledger = {
    convention: CONVENTION,
    generatedAt: newest,
    apps: apps.map((a) => ({
      name: a.name,
      kind: a.kind,
      path: a.path,
      url: a.url,
      commit: a.commit,
      // The date belongs to the cell that was actually reproduced, not to
      // the clock: "reproduced ... on <date>" has to mean the day the build
      // ran, or it is the hand-typed attestedAt this whole file replaces.
      provenance: a.provenance
        ? `${a.provenance} on ${Object.values(ordered).filter((c) => c.app === a.name && c.emulator.mark !== "no port").reduce((max, c) => (c.computedAt > max ? c.computedAt : max), newest)}`
        : null,
    })),
    targets,
    cells: ordered,
  };
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`\nwrote ledger.json (${Object.keys(ordered).length} cells)`);

  printTable(ledger);
}

// ---- the table -----------------------------------------------------------

function printTable(ledger: Ledger): void {
  const rows: string[][] = [["APP", "TARGET", "VERDICT", "EMULATOR", "HOST", "SILHOUETTE"]];
  for (const target of ledger.targets) {
    for (const app of ledger.apps) {
      const cell = ledger.cells[`${app.name}:${target.name}`];
      if (!cell) continue;
      rows.push([
        app.name,
        target.name,
        cell.verdict ? cell.verdict.verdict : "-",
        cell.emulator.mark,
        cell.host.mark,
        cell.silhouette.mark === "not applicable" ? "-" : cell.silhouette.mark,
      ]);
    }
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  console.log("");
  for (const [i, row] of rows.entries()) {
    console.log(row.map((cell, j) => cell.padEnd(widths[j]!)).join("  ").trimEnd());
    if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }
}

// Guarded like tools/verdict.ts's own CLI: site/build.ts imports this
// file's TYPES, and a type-only import is erased, but a runtime import from
// anywhere else must not start a forty-cell sweep as a side effect.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`tools/ledger.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
