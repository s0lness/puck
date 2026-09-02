#!/usr/bin/env bun
// puck verify-bundle: the harness-verified proof behind "listing is a
// reproduction, not a submission" (docs/convention/app-bundle.md). Given a
// bundle (a local apps/<name> directory, a bare bundle.json path, or a URL
// to clone), this rebuilds every declared port's module from its own
// declared source, replays its declared traces through the shared harness,
// and reports PASS or FAIL per port - never taking a README's word for it.
//
// Nothing here reimplements a pixel diff or an invariant check: the actual
// comparison logic lives in harness/portdiff.ts (verifyPortFrames, for
// "pixel-exact" ports) and harness/invariantRun.ts (runInvariants, for
// "invariants" ports), both refactored to export their core logic as
// importable functions alongside their own unchanged CLIs. This file is
// the orchestration around them: resolve the bundle, validate its schema,
// resolve each port's pack, build it, and call into the right checker.
//
// Usage:
//   puck verify-bundle <bundle-path-or-url> [--pack <name>] [--json]
//   bun run verify-bundle <bundle-path-or-url> [--pack <name>] [--json]
//
// <bundle-path-or-url> is either:
//   - a local bundle.json file, or a directory containing one (e.g.
//     "apps/chrono" resolves to "apps/chrono/bundle.json")
//   - an http(s):// or git@ URL, shallow-cloned into a temp directory first
//
// A port may also be EXTERNAL: instead of naming a source file for a local
// pack to compile, it declares a "build" object (repo, commit, command,
// artifact) and the module comes from that repository's own build, cloned
// at that pinned commit and run here (tools/externalBuild.ts, which is the
// one implementation of that step). Everything after the module exists is
// identical, deliberately: same traces, same recorded frames, same
// tolerance. See docs/decisions/0005-external-ports-are-reproduced.md,
// including its trust model: listing such a bundle means choosing to run
// that repository's build command on this machine.
//
// --pack <name>   only build and verify the port for this pack
// --json          machine-readable JSON result on stdout instead of a table
//
// Exit codes:
//   0   every verified port passed
//   1   at least one port failed verification (or could not be built /
//       named an unsupported pack - a real problem with the port, not with
//       bundle.json's own shape)
//   2   malformed bundle: bad JSON, schema v0.2 shape violated, a missing
//       or malformed descriptor.md, or the minimum listing bar unmet -
//       caught before any build or verification is attempted
//
// Every path this file touches goes through node:path (join/resolve/
// dirname/basename), never a hand-built string with a literal "/" or "\\":
// this script is meant to run unmodified in the zero-secret CI workflow
// (.github/workflows/verify-bundles.yml), which runs on Linux, while this
// repository is developed on Windows - see this file's own ZIG_EXE default
// below for the one place that distinction actually matters.

import { existsSync, mkdtempSync, statSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { verifyPortFrames } from "../harness/portdiff";
import { runInvariants, InvariantInfraError } from "../harness/invariantRun";
import { buildExternalPortTo, describeExternalBuild, validateExternalBuild, ExternalBuildError, type ExternalBuild } from "./externalBuild";
import type { Trace } from "../harness/types";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_MALFORMED = 2;

const REPO_ROOT = resolve(import.meta.dir, "..");

// ---- bundle schema v0.2, hand-rolled validation (docs/convention/app-bundle.md) ----

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
  mode: "faithful" | "adaptation" | "native";
  verification: PortVerification;
  // Required for a port built by a local pack (the module is built FROM
  // this file). Optional for an external port, whose source lives in the
  // repository "build" names and is identified by repo + commit instead.
  source?: string;
  silicon?: { attestedAt: string; how: string };
  buildArgs?: string[];
  verdict?: "go" | "degraded";
  // When present, this port's module is not built by a local pack's
  // wasm/build.ts: it is produced by another repository's own build,
  // cloned at a pinned commit and run here (tools/externalBuild.ts,
  // docs/decisions/0005-external-ports-are-reproduced.md). Everything
  // after the module exists is identical: same traces, same recorded
  // frames, same tolerance.
  build?: ExternalBuild;
}

interface BundleV02 {
  convention: string;
  name: string;
  ports: PortEntry[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateBundleShape(raw: unknown): { errors: string[]; bundle: BundleV02 | null } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { errors: ["bundle.json must be a JSON object"], bundle: null };
  }
  const b = raw as Record<string, unknown>;

  if (b.convention !== "0.2") {
    errors.push(`bundle.json "convention" must be "0.2", got ${JSON.stringify(b.convention)} (see docs/convention/app-bundle.md)`);
  }
  if (!isNonEmptyString(b.name)) {
    errors.push('bundle.json "name" must be a non-empty string');
  }
  if (!Array.isArray(b.ports)) {
    errors.push('bundle.json "ports" must be an array');
  } else if (b.ports.length === 0) {
    errors.push('bundle.json "ports" is empty: at least one port entry is required to list this app');
  } else {
    b.ports.forEach((portRaw, i) => {
      const label = `ports[${i}]`;
      if (typeof portRaw !== "object" || portRaw === null) {
        errors.push(`${label} must be an object`);
        return;
      }
      const p = portRaw as Record<string, unknown>;
      if (!isNonEmptyString(p.pack)) errors.push(`${label}.pack must be a non-empty string`);
      if (p.mode !== "faithful" && p.mode !== "adaptation" && p.mode !== "native") {
        errors.push(`${label}.mode must be one of "faithful", "adaptation", "native", got ${JSON.stringify(p.mode)}`);
      }
      // "source" names the file a LOCAL pack build is pointed at, so an
      // external port (whose source lives in another repository entirely,
      // identified by build.repo + build.commit) does not carry one.
      if (p.build === undefined && !isNonEmptyString(p.source)) {
        errors.push(`${label}.source must be a non-empty string (path to the port's source file)`);
      }
      if (p.build !== undefined) errors.push(...validateExternalBuild(p.build, `${label}.build`));

      const v = p.verification;
      if (typeof v !== "object" || v === null) {
        errors.push(`${label}.verification must be an object`);
      } else {
        const vr = v as Record<string, unknown>;
        if (vr.kind === "pixel-exact") {
          if (!Array.isArray(vr.traces) || vr.traces.length === 0 || !vr.traces.every(isNonEmptyString)) {
            errors.push(`${label}.verification.traces must be a non-empty array of paths`);
          }
          if (!isNonEmptyString(vr.frames)) errors.push(`${label}.verification.frames must be a non-empty string (path to the frames directory)`);
        } else if (vr.kind === "invariants") {
          if (!isNonEmptyString(vr.checker)) errors.push(`${label}.verification.checker must be a non-empty string`);
          if (!isNonEmptyString(vr.trace)) errors.push(`${label}.verification.trace must be a non-empty string`);
          if (!Array.isArray(vr.captureAt) || vr.captureAt.length === 0 || !vr.captureAt.every((n) => typeof n === "number")) {
            errors.push(`${label}.verification.captureAt must be a non-empty array of numbers (milliseconds)`);
          }
        } else {
          errors.push(`${label}.verification.kind must be "pixel-exact" or "invariants", got ${JSON.stringify(vr.kind)}`);
        }
      }

      if (p.silicon !== undefined) {
        if (typeof p.silicon !== "object" || p.silicon === null) {
          errors.push(`${label}.silicon must be an object when present`);
        } else {
          const s = p.silicon as Record<string, unknown>;
          if (!isNonEmptyString(s.attestedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(s.attestedAt)) {
            errors.push(`${label}.silicon.attestedAt must be a "YYYY-MM-DD" date string`);
          }
          if (!isNonEmptyString(s.how)) errors.push(`${label}.silicon.how must be a non-empty string`);
        }
      }
      if (p.buildArgs !== undefined && (!Array.isArray(p.buildArgs) || !p.buildArgs.every(isNonEmptyString))) {
        errors.push(`${label}.buildArgs must be an array of strings when present`);
      }
      if (p.verdict !== undefined && p.verdict !== "go" && p.verdict !== "degraded") {
        errors.push(`${label}.verdict must be "go" or "degraded" when present, got ${JSON.stringify(p.verdict)}`);
      }
    });
  }

  return { errors, bundle: errors.length === 0 ? (raw as BundleV02) : null };
}

// Exactly three level-2 sections, in this order (docs/convention/app-bundle.md's
// Descriptor section, matched against what apps/chrono/descriptor.md and
// apps/fluidbox/descriptor.md actually use).
const REQUIRED_DESCRIPTOR_SECTIONS = ["Essence", "Interactions", "Demands"];

function validateDescriptor(bundleDir: string): string[] {
  const path = join(bundleDir, "descriptor.md");
  if (!existsSync(path)) return [`descriptor.md not found next to bundle.json (expected at ${path})`];
  const text = readFileSync(path, "utf8");
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim());
  const matches = headings.length === REQUIRED_DESCRIPTOR_SECTIONS.length && REQUIRED_DESCRIPTOR_SECTIONS.every((h, i) => headings[i] === h);
  if (!matches) {
    return [
      `descriptor.md must have exactly three level-2 sections, in order: ${REQUIRED_DESCRIPTOR_SECTIONS.join(", ")}. ` +
        `Found: ${headings.length ? headings.join(", ") : "(none)"}.`,
    ];
  }
  return [];
}

function validateMinimumBar(bundle: BundleV02): string[] {
  const errors: string[] = [];
  let traceCount = 0;
  for (const p of bundle.ports) {
    traceCount += p.verification.kind === "pixel-exact" ? p.verification.traces.length : 1;
  }
  if (traceCount === 0) errors.push("no traces referenced by any port (minimum listing bar: descriptor.md, >=1 port, >=1 trace)");
  return errors;
}

// ---- resolving a bundle: local path or URL -----------------------------

function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s) || /^git@/.test(s);
}

// commit, when given, is registry.json's own pin for this external app
// (registry entry's own "commit" field, next to "url"): a full 40-hex sha,
// fetched directly and checked, rather than trusting whatever that
// repository's HEAD happens to be on the day this runs. Without a pin, an
// external app's own commits under it silently change what gets
// verified - the exact "reproduction, not a submission" claim
// docs/convention/app-bundle.md makes for a PORT's own external build
// (tools/externalBuild.ts, docs/decisions/0005-external-ports-are-
// reproduced.md) applies just as much to the bundle repository itself.
function cloneBundle(url: string, commit?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "puck-verify-bundle-clone-"));

  if (!commit) {
    // Loud and on stderr (not folded into a table cell or --json output
    // nobody reads until something breaks): an unpinned external app is a
    // real gap in "listing is a reproduction, not a submission", not a
    // quiet default worth staying quiet about.
    console.error(`verify-bundle: WARNING: ${url} has no "commit" pin in registry.json - verifying an unpinned clone of its current HEAD, which nothing here can reproduce later`);
    const result = Bun.spawnSync(["git", "clone", "--depth", "1", "--", url, dir], { stdout: "pipe", stderr: "pipe" });
    if (!result.success) {
      const stderr = result.stderr ? result.stderr.toString().trim() : "";
      throw new Error(`could not clone ${url}${stderr ? `: ${stderr}` : ` (git exited ${result.exitCode})`}`);
    }
    return dir;
  }

  // Pinned: init + fetch --depth 1 origin <sha> + checkout FETCH_HEAD, then
  // verify what actually got checked out against the declared pin - the
  // identical sequence tools/externalBuild.ts's checkout()/
  // verifyCheckedOutCommit() use for a port's own external build, applied
  // here to the bundle repository itself rather than duplicated by accident
  // with a subtly different shape.
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const tail = (r: ReturnType<typeof run>) => (r.stderr ? r.stderr.toString().trim() : "");
  const init = Bun.spawnSync(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
  if (!init.success) throw new Error(`could not git init ${dir}: ${tail(init)}`);
  const remote = run(["remote", "add", "origin", "--", url]);
  if (!remote.success) throw new Error(`could not add ${url} as a remote: ${tail(remote)}`);
  const fetch = run(["fetch", "--depth", "1", "origin", commit]);
  if (!fetch.success) throw new Error(`could not fetch ${commit} from ${url}: ${tail(fetch)}`);
  const co = run(["checkout", "--quiet", "FETCH_HEAD"]);
  if (!co.success) throw new Error(`fetched ${commit} from ${url} but could not check it out: ${tail(co)}`);
  const rev = run(["rev-parse", "HEAD"]);
  const head = rev.stdout ? rev.stdout.toString().trim() : "";
  if (!rev.success || head !== commit) {
    throw new Error(`checked out HEAD=${head || "(unknown)"} from ${url}, which does not match the "commit" pinned in registry.json (${commit})`);
  }
  return dir;
}

interface ResolvedBundle {
  bundleJsonPath: string;
  bundleDir: string;
  cloneRoot: string | null;
}

function resolveBundleJsonPath(target: string): ResolvedBundle {
  if (isUrl(target)) {
    // registry.json is the one place an external app's pin lives (see
    // above); a target given as a bare URL not found there (someone
    // running verify-bundle against a URL that isn't registered at all) is
    // simply unpinned, same as an unregistered app always was.
    const pinnedCommit = loadRegistry().apps.find((a) => a.url === target)?.commit;
    const cloneRoot = cloneBundle(target, pinnedCommit);
    const candidate = join(cloneRoot, "bundle.json");
    if (!existsSync(candidate)) throw new Error(`cloned ${target} but found no bundle.json at its root (${candidate})`);
    return { bundleJsonPath: candidate, bundleDir: cloneRoot, cloneRoot };
  }
  const abs = resolve(process.cwd(), target);
  if (!existsSync(abs)) throw new Error(`no such file or directory: ${abs}`);
  if (statSync(abs).isDirectory()) {
    const candidate = join(abs, "bundle.json");
    if (!existsSync(candidate)) throw new Error(`no bundle.json found in directory ${abs}`);
    return { bundleJsonPath: candidate, bundleDir: abs, cloneRoot: null };
  }
  return { bundleJsonPath: abs, bundleDir: dirname(abs), cloneRoot: null };
}

// Every path INSIDE bundle.json (traces, frames, checker, source) is
// relative to the root of the repository the bundle lives in: this
// repository's own root for an in-repo apps/ bundle (so
// "apps/chrono/traces/..." resolves correctly, matching every other path
// convention already in this repo - site/build.ts's docLinks, the port
// READMEs' own repro commands), or a cloned external bundle's own root
// (its bundle.json is presumed to sit at or near that repo's root, the
// natural place for a single-app repo to put it). Found by walking up from
// bundle.json's own directory to the nearest ancestor that looks like a
// repository root (has registry.json, this repo's own marker, or failing
// that a .git directory); falls back to bundle.json's own directory for a
// minimal external repo with neither.
function findBundleRoot(bundleDir: string): string {
  let dir = bundleDir;
  for (;;) {
    if (existsSync(join(dir, "registry.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = bundleDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return bundleDir;
}

// ---- registry.json: pack resolution, local packs only for now ---------

interface RegistryPackEntry {
  name: string;
  path?: string;
  url?: string;
}
interface Registry {
  packs: RegistryPackEntry[];
  // commit: an external app's own pin (a full 40-hex sha), next to its
  // "url" - see cloneBundle()'s own header comment above. Optional so an
  // in-repo apps/ entry (which only ever has "path") and a not-yet-pinned
  // external one both still parse.
  apps: { name: string; path?: string; url?: string; commit?: string }[];
}

function loadRegistry(): Registry {
  return JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8")) as Registry;
}

// ---- building a pack's module -------------------------------------------

// This repository is developed on Windows, where zig has to be pointed at
// explicitly (no package manager install on PATH); the zero-secret CI
// workflow runs on Linux, where zig is installed onto PATH directly (see
// .github/workflows/verify-bundles.yml). ZIG_EXE always wins when set,
// which is how CI overrides this without editing this file; the Windows
// fallback path only applies when nothing overrides it AND the platform
// actually looks like Windows, so a Linux run with no ZIG_EXE set falls
// through to plain "zig" on PATH instead of a Windows path that could
// never exist there.
const ZIG_EXE = process.env.ZIG_EXE ?? (process.platform === "win32" ? "C:\\Users\\sylve\\tools\\zig\\zig.exe" : "zig");

// Every pack's own wasm/build.ts already retries zig cc's own linker crash
// internally (documented in each build.ts's header comment: exit code 5,
// no diagnostic, roughly one run in three, worse under concurrent build
// load). This outer retry mirrors site/build.ts's own runBuild, for the
// identical reason that file gives: a whole verify-bundle run should not
// fail because one `bun run <pack>/wasm/build.ts` invocation hit that same
// documented flake on an unlucky day, on top of its own internal retries.
const BUILD_MAX_ATTEMPTS = 4;
const BUILD_RETRY_PAUSE_MS = 400;

interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runBunScript(scriptPath: string, args: string[]): RunResult {
  const spawnOnce = () =>
    Bun.spawnSync(["bun", "run", scriptPath, ...args], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ZIG_EXE },
    });
  let result = spawnOnce();
  for (let attempt = 2; !result.success && attempt <= BUILD_MAX_ATTEMPTS; attempt++) {
    Bun.sleepSync(BUILD_RETRY_PAUSE_MS);
    result = spawnOnce();
  }
  return {
    success: result.success,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
    exitCode: result.exitCode,
  };
}

// ---- per-port verification ----------------------------------------------

interface PortVerifyResult {
  pack: string;
  mode: string;
  kind: "pixel-exact" | "invariants";
  status: "pass" | "fail" | "error";
  reason: string;
  details?: string[];
  // Only for an external port: what was built, from where, at what commit
  // (tools/externalBuild.ts's describeExternalBuild). Reported rather than
  // implied, so a passing external port never reads as if this repository
  // built it.
  provenance?: string;
}

async function verifyPort(bundleRoot: string, port: PortEntry, index: number, registry: Registry, buildDir: string): Promise<PortVerifyResult> {
  const resolvePath = (p: string) => resolve(bundleRoot, p);
  const base = { pack: port.pack, mode: port.mode, kind: port.verification.kind };
  const modulePath = join(buildDir, `port-${index}-${port.pack}.wasm`);
  let provenance: string | undefined;

  if (port.build) {
    // An external port: another repository's own build, at a pinned
    // commit, run here. NOTHING about verification changes below this
    // block, which is the whole design (docs/decisions/
    // 0005-external-ports-are-reproduced.md). The pack is not looked up in
    // registry.json at all, because no local pack is being built: the pack
    // name still says which device the recorded frames belong to.
    provenance = describeExternalBuild(port.build);
    try {
      await buildExternalPortTo(
        port.build,
        { baseDir: bundleRoot, env: { ZIG_EXE }, onLog: (line) => console.error(`  [${port.pack}] ${line}`) },
        modulePath
      );
    } catch (err) {
      if (err instanceof ExternalBuildError) {
        // err.message already carries the failing command's own last 40
        // lines of stdout/stderr (tools/externalBuild.ts). Printed here too,
        // not just returned in `reason`, so it is visible in the plain
        // table run and not only in --json output.
        console.error(`  [${port.pack}] ${err.message}`);
        return { ...base, provenance, status: "error", reason: err.message };
      }
      throw err;
    }
  } else {
    const packEntry = registry.packs.find((pk) => pk.name === port.pack);
    if (!packEntry) {
      return { ...base, status: "error", reason: `unknown pack "${port.pack}": not found in ${join(REPO_ROOT, "registry.json")}` };
    }
    if (!packEntry.path) {
      return {
        ...base,
        status: "error",
        reason: `pack "${port.pack}" is registered by url, and this port names no "build" of its own: an app whose pack is not local must build its own module (docs/convention/app-bundle.md)`,
      };
    }

    const buildScript = join(REPO_ROOT, packEntry.path, "wasm", "build.ts");
    if (!existsSync(buildScript)) {
      return { ...base, status: "error", reason: `pack build script not found: ${buildScript}` };
    }

    const buildArgs = port.mode === "native" ? [] : ["--app", resolvePath(port.source!), ...(port.buildArgs ?? [])];
    const build = runBunScript(buildScript, buildArgs);
    if (!build.success) {
      // Last 40 lines of stdout+stderr (zig writes its own diagnostics to
      // either stream depending on how it fails), not a bare exit code: an
      // agent (or a person) reading this needs to see WHY the build broke,
      // not just that it did.
      const tailLines = [build.stdout, build.stderr].join("\n").trim().split("\n").slice(-40);
      const tail = tailLines.join("\n");
      console.error(`  [${port.pack}] build failed (exit ${build.exitCode}) after ${BUILD_MAX_ATTEMPTS} attempt(s): bun run ${buildScript} ${buildArgs.join(" ")}`);
      if (tail) console.error(tail);
      return {
        ...base,
        status: "error",
        reason: `build failed (exit ${build.exitCode}) after ${BUILD_MAX_ATTEMPTS} attempt(s): bun run ${buildScript} ${buildArgs.join(" ")}${tail ? `\n${tail}` : ""}`,
        details: tail ? tailLines : undefined,
      };
    }
    const repoWasmOut = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
    if (!existsSync(repoWasmOut)) {
      return { ...base, status: "error", reason: `${buildScript} did not write ${repoWasmOut}` };
    }
    copyFileSync(repoWasmOut, modulePath);
  }

  // Provenance is carried as its own field rather than glued into the
  // reason string: the table prints it in place of an empty reason on a
  // pass (printTable, below), and --json consumers get it structured.
  const withProvenance = (r: PortVerifyResult): PortVerifyResult => (provenance ? { ...r, provenance } : r);

  if (port.verification.kind === "pixel-exact") {
    const traces = port.verification.traces.map((t) => ({ tracePath: resolvePath(t), framesDir: resolvePath(port.verification.frames as string) }));
    const result = await verifyPortFrames({ modulePath, traces, tolerance: 0 });
    if (result.errors.length > 0) {
      return withProvenance({ ...base, status: "error", reason: result.errors[0]!, details: result.errors });
    }
    const mismatches = result.frames.filter((f) => !f.match);
    if (mismatches.length > 0) {
      const first = mismatches[0]!;
      return withProvenance({
        ...base,
        status: "fail",
        reason: `${mismatches.length}/${result.frames.length} frame(s) diverged (first: ${first.trace} t=${first.atMs}ms, ${first.diffPixels}/${first.totalPixels}px)`,
        details: mismatches.map((m) => `${m.trace} t=${m.atMs}ms: ${m.diffPixels}/${m.totalPixels}px vs ${m.expectedFile}`),
      });
    }
    return withProvenance({ ...base, status: "pass", reason: `${result.frames.length}/${result.frames.length} frame(s) matched` });
  }

  // kind === "invariants"
  const tracePath = resolvePath(port.verification.trace);
  let trace: Trace;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf8")) as Trace;
  } catch (err) {
    return withProvenance({ ...base, status: "error", reason: `could not read trace ${tracePath}: ${err instanceof Error ? err.message : String(err)}` });
  }
  const checkerPath = resolvePath(port.verification.checker);
  try {
    const result = await runInvariants({ wasmPath: modulePath, trace, capturePoints: port.verification.captureAt, checkerPath, quiet: true });
    if (!result.pass) {
      return withProvenance({
        ...base,
        status: "fail",
        reason: `${result.failures.length} invariant(s) failed: ${result.failures[0] ?? ""}`,
        details: result.failures,
      });
    }
    return withProvenance({ ...base, status: "pass", reason: `all invariants held over ${result.frameCount} frame(s)` });
  } catch (err) {
    if (err instanceof InvariantInfraError) return withProvenance({ ...base, status: "error", reason: err.message });
    throw err;
  }
}

// ---- output ---------------------------------------------------------------

function printTable(results: PortVerifyResult[]): void {
  const header = ["PACK", "MODE", "KIND", "RESULT", "REASON"];
  // A passing port normally has nothing to say. An externally built one
  // does: where its module came from, which is the one thing a reader
  // cannot infer from the fact that it passed.
  // A build failure's `reason` can now run to 40 lines (the failing
  // command's own captured output, printed in full to stderr as it
  // happens). The table cell stays one line: only the first line of
  // `reason`, with a pointer to the log just printed above for the rest.
  const rows = results.map((r) => {
    if (r.status === "pass") return [r.pack, r.mode, r.kind, r.status.toUpperCase(), r.provenance ? `built from ${r.provenance}` : ""];
    const lines = r.reason.split("\n");
    const first = lines[0]!;
    const cell = lines.length > 1 ? `${first} (see log above)` : first;
    return [r.pack, r.mode, r.kind, r.status.toUpperCase(), cell];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(fmt(row));
}

function printMalformed(target: string, errors: string[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ bundle: target, malformed: true, errors, exitCode: EXIT_MALFORMED }, null, 2));
    return;
  }
  console.error(`verify-bundle: malformed bundle (${target})`);
  for (const e of errors) console.error(`  - ${e}`);
}

// ---- CLI --------------------------------------------------------------

interface Argv {
  target: string;
  pack: string | null;
  json: boolean;
}

function parseArgv(argv: string[]): Argv {
  let target: string | null = null;
  let pack: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pack") pack = argv[++i] ?? null;
    else if (a === "--json") json = true;
    else if (!target) target = a;
  }
  if (!target) {
    console.error("usage: puck verify-bundle <bundle-path-or-url> [--pack <name>] [--json]");
    process.exit(EXIT_MALFORMED);
  }
  return { target, pack, json };
}

async function main(): Promise<void> {
  const { target, pack: packFilter, json } = parseArgv(process.argv.slice(2));

  let bundleJsonPath: string;
  let bundleDir: string;
  let cloneRoot: string | null;
  try {
    ({ bundleJsonPath, bundleDir, cloneRoot } = resolveBundleJsonPath(target));
  } catch (err) {
    printMalformed(target, [err instanceof Error ? err.message : String(err)], json);
    process.exit(EXIT_MALFORMED);
  }

  const errors: string[] = [];
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(bundleJsonPath, "utf8"));
  } catch (err) {
    errors.push(`${bundleJsonPath}: could not read or parse JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  let bundle: BundleV02 | null = null;
  if (errors.length === 0) {
    const shape = validateBundleShape(raw);
    errors.push(...shape.errors);
    bundle = shape.bundle;
  }
  if (bundle) {
    errors.push(...validateDescriptor(bundleDir));
    errors.push(...validateMinimumBar(bundle));
  }

  if (errors.length > 0 || !bundle) {
    printMalformed(target, errors, json);
    if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
    process.exit(EXIT_MALFORMED);
  }

  let portsToRun = bundle.ports;
  if (packFilter) {
    portsToRun = bundle.ports.filter((p) => p.pack === packFilter);
    if (portsToRun.length === 0) {
      printMalformed(target, [`no port for pack "${packFilter}" in this bundle. Known packs: ${bundle.ports.map((p) => p.pack).join(", ")}`], json);
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      process.exit(EXIT_MALFORMED);
    }
  }

  const registry = loadRegistry();
  const bundleRoot = findBundleRoot(bundleDir);
  const buildDir = mkdtempSync(join(tmpdir(), "puck-verify-bundle-build-"));

  const results: PortVerifyResult[] = [];
  try {
    for (let i = 0; i < portsToRun.length; i++) {
      results.push(await verifyPort(bundleRoot, portsToRun[i]!, i, registry, buildDir));
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
    if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
  }

  const allPass = results.every((r) => r.status === "pass");
  const exitCode = allPass ? EXIT_OK : EXIT_FAIL;

  if (json) {
    console.log(JSON.stringify({ bundle: target, name: bundle.name, convention: bundle.convention, ports: results, exitCode }, null, 2));
  } else {
    console.log(`verify-bundle: ${bundle.name} (${target})\n`);
    printTable(results);
    console.log(`\n${allPass ? "PASS" : "FAIL"}: ${results.filter((r) => r.status === "pass").length}/${results.length} port(s) verified`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`tools/verify-bundle.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(EXIT_MALFORMED);
});
