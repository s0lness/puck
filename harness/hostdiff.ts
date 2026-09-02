#!/usr/bin/env bun
// The HOST differential harness: replays an app bundle's own traces
// through the wasm build AND through a native, sanitizer-instrumented host
// build of the SAME real firmware C, diffing frames at the bundle's own
// capture points. This is harness/portdiff.ts's pattern (two builds, one
// trace, compare) turned toward the compiler instead of toward another
// device: the question is not "does this app draw the same pixels on two
// packs" or "does the emulator match real hardware", it is "does the
// wasm32 compiler and the host compiler agree on what this C means" - see
// docs/harness.md's "three marks" for the full picture (emulator mark,
// host mark, silicon mark).
//
// Usage:
//   bun run hostdiff <app> <pack> [options]
//   bun run harness/hostdiff.ts <app> <pack> [options]
//
// <app>  an app name from registry.json's "apps" (e.g. "chrono",
//        "fluidbox") - must be a local bundle (a {"name","path"} entry),
//        the same restriction tools/verify-bundle.ts's own pack resolution
//        has for a local pack.
// <pack> a pack name from that app's own bundle.json "ports" array (e.g.
//        "rp2350-touch-amoled-18") - must be a LOCAL pack in registry.json
//        (this file builds it twice, once to wasm, once to a native
//        executable; an external "build" port has no local pack to build
//        a host executable from and is refused).
//
// Options:
//   --tolerance <n>   per-channel value difference below which a pixel
//                      counts as matching (default: 0). Per this task's
//                      own instruction: never loosened silently to make a
//                      float-rounding divergence disappear - if you pass
//                      this, the exact pixel counts are still printed, so
//                      what was allowed through stays visible.
//   --json            machine-readable result on stdout instead of a table
//
// Exit codes, the same three-way split every harness CLI in this
// repository uses (harness/diff.ts, harness/portdiff.ts): 0 = every point
// on every trace MATCHed, 1 = at least one point DIVERGEd or reported
// SANITIZER, 2 = the comparison never ran at all (bad args, unknown app or
// pack, malformed bundle, a wasm or host BUILD failure - never a verdict
// about the firmware itself).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { frameFilesFor, findOutOfOrderEvent } from "./portdiff";
import { buildHostExe, replayHost, type HostSourceSpec } from "./hostSide";
import { compareFrames } from "../src/compare";
import type { Trace } from "./types";

const EXIT_OK = 0;
const EXIT_DIVERGENCE = 1;
const EXIT_INFRA = 2;

const REPO_ROOT = resolve(import.meta.dir, "..");
const ZIG_EXE = process.env.ZIG_EXE ?? (process.platform === "win32" ? "C:\\Users\\sylve\\tools\\zig\\zig.exe" : "zig");
// harness/hostSide.ts resolves its OWN zig binary the same way every pack's
// wasm/build.ts does (process.env.ZIG_EXE ?? "zig", no Windows-specific
// fallback - AGENTS.md's convention for build scripts). It is imported
// directly here, not spawned, so it reads THIS process's own env - setting
// it back onto process.env is what makes a bare `bun run hostdiff` (no
// ZIG_EXE set) find the same zig on Windows that the wasm build above just
// used, rather than falling through to a bare "zig" that isn't on PATH.
process.env.ZIG_EXE = ZIG_EXE;

// ---- registry + bundle resolution (deliberately small subset of
// tools/verify-bundle.ts's own: this file only ever looks at ONE named
// app/pack pair a caller already knows, never a whole bundle's every port,
// so it does not need that file's URL-clone or --pack-filter machinery). --

interface RegistryPackEntry {
  name: string;
  path?: string;
  url?: string;
}
interface RegistryAppEntry {
  name: string;
  path?: string;
  url?: string;
}
interface Registry {
  packs: RegistryPackEntry[];
  apps: RegistryAppEntry[];
}

function loadRegistry(): Registry {
  return JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8")) as Registry;
}

interface PortVerificationPixelExact {
  kind: "pixel-exact";
  traces: string[];
  frames: string;
}
interface PortVerificationInvariants {
  kind: "invariants";
  checker: string;
  trace: string;
  captureAt: number[];
}
type PortVerification = PortVerificationPixelExact | PortVerificationInvariants;

interface PortEntry {
  pack: string;
  mode: string;
  verification: PortVerification;
  source?: string;
  buildArgs?: string[];
  build?: unknown; // external port - refused below, see fail()
}

interface BundleV02 {
  convention: string;
  name: string;
  ports: PortEntry[];
}

function fail(msg: string): never {
  console.error(`hostdiff: ${msg}`);
  process.exit(EXIT_INFRA);
}

// ---- building the wasm side, the same way tools/verify-bundle.ts does
// (bun run <pack>/wasm/build.ts [--app <source> ...buildArgs]) ----------

interface RunResult {
  success: boolean;
  stderr: string;
}

function runBunScript(scriptPath: string, args: string[]): RunResult {
  const MAX_ATTEMPTS = 4;
  const spawnOnce = () => Bun.spawnSync(["bun", "run", scriptPath, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ZIG_EXE } });
  let r = spawnOnce();
  for (let attempt = 2; !r.success && attempt <= MAX_ATTEMPTS; attempt++) {
    Bun.sleepSync(400);
    r = spawnOnce();
  }
  return { success: r.success, stderr: r.stderr ? r.stderr.toString() : "" };
}

async function buildWasmModule(packDir: string, port: PortEntry, bundleRoot: string): Promise<string> {
  const buildScript = join(REPO_ROOT, packDir, "wasm", "build.ts");
  if (!existsSync(buildScript)) fail(`pack build script not found: ${buildScript}`);
  const buildArgs = port.mode === "native" ? [] : ["--app", resolve(bundleRoot, port.source!), ...(port.buildArgs ?? [])];
  const result = runBunScript(buildScript, buildArgs);
  if (!result.success) fail(`wasm build failed (bun run ${buildScript} ${buildArgs.join(" ")}):\n${result.stderr.trim()}`);
  const out = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
  if (!existsSync(out)) fail(`${buildScript} did not write ${out}`);
  return out;
}

// ---- building the host side, via the pack's own sibling wasm/host.ts --

async function buildHostSourceSpec(packDir: string, port: PortEntry, bundleRoot: string): Promise<HostSourceSpec> {
  const hostTsPath = join(REPO_ROOT, packDir, "wasm", "host.ts");
  if (!existsSync(hostTsPath)) {
    fail(`pack "${port.pack}" has no wasm/host.ts (see harness/hostdiff.ts's usage comment - a pack must expose one to be host-diffed)`);
  }
  // Dynamic import: each pack's host.ts declares its own HostAppArgs shape
  // (packs/esp32-s3-touch-amoled-18/wasm/host.ts takes no landscape/shake,
  // for instance), so this file cannot statically import all three at
  // once. Extra fields on the args object below are simply ignored by a
  // pack that does not read them - plain JS object shape, not a TS
  // structural check this dynamic import could enforce anyway.
  const mod = (await import(hostTsPath)) as { hostBuildFiles: (args: Record<string, unknown>) => HostSourceSpec };
  const appPath = port.mode === "native" ? null : resolve(bundleRoot, port.source!);
  const buildArgs = port.buildArgs ?? [];
  return mod.hostBuildFiles({ appPath, landscape: buildArgs.includes("--landscape"), shake: buildArgs.includes("--shake") });
}

// ---- resolving which traces + capture points this port's bundle proves -

interface TraceCheck {
  traceStem: string;
  tracePath: string;
  capturePoints: number[];
}

function tracesToCheck(port: PortEntry, bundleRoot: string): TraceCheck[] {
  const verification = port.verification;
  if (verification.kind === "pixel-exact") {
    return verification.traces.map((t) => {
      const tracePath = resolve(bundleRoot, t);
      const stem = t.split(/[\\/]/).pop()!.replace(/\.trace\.json$|\.json$/, "");
      const framesDir = resolve(bundleRoot, verification.frames);
      const fileForPoint = frameFilesFor(framesDir, stem);
      const capturePoints = [...fileForPoint.keys()].sort((a, b) => a - b);
      if (capturePoints.length === 0) fail(`${framesDir}: no recorded frames matching ${stem}.t<ms>.png for trace ${tracePath}`);
      return { traceStem: stem, tracePath, capturePoints };
    });
  }
  const tracePath = resolve(bundleRoot, verification.trace);
  const stem = verification.trace.split(/[\\/]/).pop()!.replace(/\.trace\.json$|\.json$/, "");
  return [{ traceStem: stem, tracePath, capturePoints: [...verification.captureAt].sort((a, b) => a - b) }];
}

// ---- CLI -----------------------------------------------------------------

interface Args {
  app: string;
  pack: string;
  tolerance: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let tolerance = 0;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tolerance") tolerance = Number(argv[++i] ?? "0");
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  if (positional.length < 2) {
    console.error("usage: bun run hostdiff <app> <pack> [--tolerance <n>] [--json]");
    console.error("       (see harness/hostdiff.ts's header comment for the full option list)");
    process.exit(EXIT_INFRA);
  }
  return { app: positional[0]!, pack: positional[1]!, tolerance, json };
}

interface PointResult {
  trace: string;
  atMs: number;
  verdict: "match" | "diverge" | "sanitizer";
  diffPixels?: number;
  totalPixels?: number;
  report?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();

  const appEntry = registry.apps.find((a) => a.name === args.app);
  if (!appEntry) fail(`unknown app "${args.app}" (not in registry.json's "apps")`);
  if (!appEntry.path) fail(`app "${args.app}" is registered by url; hostdiff needs a local bundle to read traces/frames from`);
  const bundleRoot = REPO_ROOT; // registry.json paths are repo-root-relative, same convention every other tool here follows
  const bundleDir = resolve(REPO_ROOT, appEntry.path);
  const bundleJsonPath = join(bundleDir, "bundle.json");
  if (!existsSync(bundleJsonPath)) fail(`no bundle.json at ${bundleJsonPath}`);
  const bundle = JSON.parse(readFileSync(bundleJsonPath, "utf8")) as BundleV02;

  const port = bundle.ports.find((p) => p.pack === args.pack);
  if (!port) fail(`app "${args.app}" has no port for pack "${args.pack}". Known: ${bundle.ports.map((p) => p.pack).join(", ")}`);
  if (port.build) fail(`app "${args.app}"'s "${args.pack}" port is external (a "build" entry, docs/convention/app-bundle.md): hostdiff needs a local pack to build a host executable from`);

  const packEntry = registry.packs.find((pk) => pk.name === args.pack);
  if (!packEntry) fail(`unknown pack "${args.pack}" (not in registry.json's "packs")`);
  if (!packEntry.path) fail(`pack "${args.pack}" is registered by url; hostdiff needs a local pack to build`);

  console.log(`hostdiff: ${args.app} x ${args.pack}`);

  console.log(`\n-- building wasm --`);
  const wasmPath = await buildWasmModule(packEntry.path, port, bundleRoot);
  console.log(`built ${wasmPath}`);

  console.log(`\n-- building host (native, sanitized) --`);
  const spec = await buildHostSourceSpec(packEntry.path, port, bundleRoot);
  const build = await buildHostExe(spec);
  if (!build.ok) {
    console.error(`\nBUILD_FAILED: ${build.error}`);
    process.exit(EXIT_INFRA);
  }
  console.log(`built ${build.exePath} (sanitizers: ${build.sanitizers.join(", ")})`);

  const checks = tracesToCheck(port, bundleRoot);
  const results: PointResult[] = [];

  for (const check of checks) {
    const trace = JSON.parse(readFileSync(check.tracePath, "utf8")) as Trace;
    const outOfOrder = findOutOfOrderEvent(trace.events);
    if (outOfOrder) fail(`${check.tracePath}: event[${outOfOrder.index}].t = ${outOfOrder.t} is earlier than the previous event's t = ${outOfOrder.prevT}`);

    console.log(`\n-- ${check.traceStem}: replaying ${trace.events.length} events, ${check.capturePoints.length} capture point(s) --`);

    const wasmResult = await replayEmulator(wasmPath, trace.events, check.capturePoints, { seed: trace.seed });
    const hostResult = await replayHost(build.exePath, trace.events, check.capturePoints);

    if (hostResult.verdict === "sanitizer") {
      console.log(`  SANITIZER (host run aborted; ${hostResult.frames.length}/${check.capturePoints.length} frame(s) captured before the trap)`);
      console.log(
        hostResult.report
          .trim()
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
      results.push({ trace: check.traceStem, atMs: -1, verdict: "sanitizer", report: hostResult.report });
      continue;
    }

    for (let i = 0; i < check.capturePoints.length; i++) {
      const atMs = check.capturePoints[i]!;
      const wasmFrame = wasmResult.frames[i]!.frame;
      const hostFrame = hostResult.frames[i]!.frame;
      const d = compareFrames(wasmFrame, hostFrame, args.tolerance);
      if (d.match) {
        console.log(`  t=${atMs}ms  MATCH`);
        results.push({ trace: check.traceStem, atMs, verdict: "match" });
      } else {
        const pct = d.totalPixels > 0 ? ((d.diffPixels / d.totalPixels) * 100).toFixed(2) : "?";
        console.log(
          `  t=${atMs}ms  DIVERGE  ${d.diffPixels}/${d.totalPixels} px (${pct}%)` +
            (d.firstDiffAt ? `  first at (${d.firstDiffAt.x},${d.firstDiffAt.y})` : "") +
            `  max channel delta ${d.maxChannelDelta}`
        );
        results.push({ trace: check.traceStem, atMs, verdict: "diverge", diffPixels: d.diffPixels, totalPixels: d.totalPixels });
      }
    }
  }

  const allMatch = results.every((r) => r.verdict === "match");

  if (args.json) {
    console.log(JSON.stringify({ app: args.app, pack: args.pack, sanitizers: build.sanitizers, results, allMatch }, null, 2));
  } else {
    console.log(`\n${allMatch ? "PASS" : "FAIL"}: ${results.filter((r) => r.verdict === "match").length}/${results.length} point(s) matched`);
  }

  process.exit(allMatch ? EXIT_OK : EXIT_DIVERGENCE);
}

main().catch((err) => {
  console.error(`harness/hostdiff.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(EXIT_INFRA);
});
