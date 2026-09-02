#!/usr/bin/env bun
// The PORT differential harness: given two wasm modules and one trace,
// replays the SAME trace against both, headless, and compares the
// captured frames. This is harness/diff.ts's pattern (emulator vs. real
// hardware) turned sideways: emulator vs. emulator, two different device
// packs, one app bundle. The question this answers is not "does the
// emulator match my board" but "do these two ports of one app draw the
// same pixels for the same input" - the check the porting flow
// (docs/convention/app-bundle.md) calls "faithful" verification: replay
// the trace verbatim, diff the frames pixel-exact.
//
// Deliberately device-agnostic: nothing here hardcodes a panel size, a
// button name or index, or a device name. Both modules' shapes come from
// their own emu_device() (via replayEmulator -> replayFromBytes ->
// readDeviceDescriptor), same as every other consumer in this repo. A
// trace itself already carries only portable input (touch/button/verdict/
// sensor indices and coordinates, and tick timestamps - src/recorder.ts),
// so replaying it against two different packs' modules needs nothing
// pack-specific here.
//
// This file exports two things beyond its own CLI, both used by
// tools/verify-bundle.ts so the verifier never reimplements a pixel diff
// of its own (docs/convention/app-bundle.md's "listing is a reproduction,
// not a submission" - one comparison implementation, not two that could
// silently drift apart):
//
//   runPortdiff()      the CLI's own module-A-vs-module-B comparison,
//                       extracted so a caller gets a structured result
//                       instead of only console output + an exit code.
//   verifyPortFrames() a different shape of the same underlying check: one
//                       module against a bundle's own recorded frames/
//                       directory (docs/convention/app-bundle.md's
//                       pixel-exact verification), deriving which moments
//                       to check directly from that directory's own
//                       <trace-stem>.t<ms>.png filenames rather than
//                       needing a second live module to diff against. This
//                       is what makes a "native" port (nothing to pair it
//                       against within its own bundle) and a "faithful"
//                       port equally checkable from bundle.json alone.
//
// CLI usage:
//   bun run portdiff <moduleA.wasm> <moduleB.wasm> <trace.json> [options]
//   bun run harness/portdiff.ts <moduleA.wasm> <moduleB.wasm> <trace.json> [options]
//
// Options:
//   --at <ms,ms,...>     explicit capture points, as trace-relative
//                        milliseconds (matching TraceEvent.t)
//   --every <ms>         capture every N ms instead of explicit points
//                        (default if neither --at nor --every given:
//                        capture once, at the trace's final tick)
//   --tolerance <n>      per-channel value difference (0-255) below which a
//                        pixel counts as matching (default: 0, exact match -
//                        this harness compares two wasm builds, not a real
//                        capture path, so there is no compression/quantisation
//                        noise to allow for)
//   --out <dir>          on a divergence, write PNGs of both frames plus a
//                        diff heatmap (default: harness/out)
//   --write-frames <dir> write MODULE A's frames as PNGs into <dir>, one
//                        per capture point, regardless of match/diverge.
//                        This is how a proven port's expected frames get
//                        written for its app bundle (docs/convention/
//                        app-bundle.md's "expected frames"): point module A
//                        at the reference pack's build and this at the
//                        bundle's own frames/ directory once every capture
//                        point matches.
//
// Exit codes, same three-way split harness/diff.ts uses and for the same
// reason (CI reads the code, not the prose): 0 = ran, every frame matched;
// 1 = ran, at least one frame diverged; 2 = never ran to completion (bad
// args, a malformed or out-of-order trace, a module that failed to
// instantiate).

import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { encodeRGBPNG, decodeRGBPNG } from "./png";
import { compareFrames } from "../src/compare";
import type { CapturedFrame, Trace } from "./types";
import type { DeviceDescriptor } from "../src/wasm";

const EXIT_OK = 0;
const EXIT_DIVERGENCE = 1;
const EXIT_INFRA = 2;

// Thrown by runPortdiff() for a failure that could never be a real frame
// divergence (a malformed trace, mismatched frame counts): main() maps
// this to exit code 2, same as every infra failure below it always has;
// tools/verify-bundle.ts maps it to its own "malformed" bucket instead of
// a verification failure.
export class PortdiffInfraError extends Error {}

interface Args {
  moduleAPath: string;
  moduleBPath: string;
  tracePath: string;
  at: number[] | null;
  every: number | null;
  outDir: string;
  writeFramesDir: string | null;
  tolerance: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let at: number[] | null = null;
  let every: number | null = null;
  let outDir = join(import.meta.dir, "out");
  let writeFramesDir: string | null = null;
  let tolerance = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--at") at = (argv[++i] ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    else if (a === "--every") every = Number(argv[++i]);
    else if (a === "--out") outDir = argv[++i] ?? outDir;
    else if (a === "--write-frames") writeFramesDir = argv[++i] ?? null;
    else if (a === "--tolerance") tolerance = Number(argv[++i] ?? "0");
    else positional.push(a);
  }
  if (positional.length < 3) {
    console.error("usage: bun run portdiff <moduleA.wasm> <moduleB.wasm> <trace.json> [options]");
    console.error("       (see harness/portdiff.ts's header comment for the full option list)");
    process.exit(EXIT_INFRA);
  }
  return {
    moduleAPath: positional[0]!,
    moduleBPath: positional[1]!,
    tracePath: positional[2]!,
    at,
    every,
    outDir,
    writeFramesDir,
    tolerance,
  };
}

// Identical rule to harness/diff.ts's findOutOfOrderEvent, and for the
// identical reason: both replay sides assume ticks arrive with
// non-decreasing `t` (replayFromBytes's capture-point loop), so a hand- or
// tool-authored trace with a strict decrease would otherwise produce a
// wrong or skipped capture point rather than an error. Ties are fine.
// Exported: tools/verify-bundle.ts's own frame-directory check
// (verifyPortFrames, below) reuses this exact rule rather than restating
// it, and a bundle's other trace-consuming checks (invariants) apply the
// identical rule from harness/invariantRun.ts's own copy.
export function findOutOfOrderEvent(events: Trace["events"]): { index: number; t: number; prevT: number } | null {
  let prevT = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const t = events[i]!.t;
    if (t < prevT) return { index: i, t, prevT };
    prevT = t;
  }
  return null;
}

// A "pixel-exact" port bundle's own frame-naming convention
// (<trace-stem>.t<ms>.png), read back off a directory listing: which
// capture points a bundle proves for a given trace comes from what got
// recorded, never a separate list restated in bundle.json (docs/convention/
// app-bundle.md). Extracted from verifyPortFrames() below (its own,
// unchanged behaviour) so a second caller with the same "what does this
// bundle claim to check" question - harness/hostdiff.ts, diffing a wasm
// build against a native host build at those SAME points - does not
// reimplement this filename convention a second time.
export function frameFilesFor(framesDir: string, traceStem: string): Map<number, string> {
  const escapedStem = traceStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const frameFileRe = new RegExp(`^${escapedStem}\\.t(\\d+)\\.png$`);
  const fileForPoint = new Map<number, string>();
  for (const name of readdirSync(framesDir)) {
    const m = frameFileRe.exec(name);
    if (m) fileForPoint.set(Number(m[1]), name);
  }
  return fileForPoint;
}

function capturePointsFor(events: Trace["events"], args: Args): number[] {
  const tickTimes = events.filter((e) => e.k === "tick").map((e) => e.t);
  if (args.at && args.at.length > 0) return args.at;
  if (args.every && args.every > 0) {
    if (tickTimes.length === 0) return [];
    const first = tickTimes[0]!, last = tickTimes[tickTimes.length - 1]!;
    const points: number[] = [];
    for (let t = first; t <= last; t += args.every) points.push(t);
    return points;
  }
  return tickTimes.length > 0 ? [tickTimes[tickTimes.length - 1]!] : [];
}

async function writePng(path: string, frame: CapturedFrame): Promise<void> {
  await Bun.write(path, encodeRGBPNG(frame.width, frame.height, frame.rgb));
}

// ---- runPortdiff: module A vs module B, the CLI's own core check -------

export interface RunPortdiffOptions {
  moduleAPath: string;
  moduleBPath: string;
  trace: Trace;
  capturePoints: number[];
  tolerance?: number; // default 0
  writeFramesDir?: string | null;
  outDir?: string | null;
  traceStem: string;
  quiet?: boolean; // default false: prints the same lines the CLI always has
}

export interface PortdiffFrameResult {
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  firstDiffAt: { x: number; y: number } | null;
  maxChannelDelta: number;
}

export interface PortdiffResult {
  allMatch: boolean;
  frames: PortdiffFrameResult[];
  deviceA: DeviceDescriptor;
  deviceB: DeviceDescriptor;
}

export async function runPortdiff(opts: RunPortdiffOptions): Promise<PortdiffResult> {
  const tolerance = opts.tolerance ?? 0;
  const log = opts.quiet ? (_s: string) => {} : (s: string) => console.log(s);

  log(`\n-- module A: ${opts.moduleAPath} --`);
  const resultA = await replayEmulator(opts.moduleAPath, opts.trace.events, opts.capturePoints, { seed: opts.trace.seed });
  log(`${resultA.device.name ?? "device"} ${resultA.device.panel.w}x${resultA.device.panel.h}, ${resultA.frames.length} frame(s) captured`);

  log(`\n-- module B: ${opts.moduleBPath} --`);
  const resultB = await replayEmulator(opts.moduleBPath, opts.trace.events, opts.capturePoints, { seed: opts.trace.seed });
  log(`${resultB.device.name ?? "device"} ${resultB.device.panel.w}x${resultB.device.panel.h}, ${resultB.frames.length} frame(s) captured`);

  if (resultA.frames.length !== resultB.frames.length) {
    throw new PortdiffInfraError(`frame count mismatch: module A captured ${resultA.frames.length}, module B captured ${resultB.frames.length}`);
  }

  if (opts.writeFramesDir && !existsSync(opts.writeFramesDir)) mkdirSync(opts.writeFramesDir, { recursive: true });
  if (opts.outDir && !existsSync(opts.outDir)) mkdirSync(opts.outDir, { recursive: true });

  log(`\n-- comparison (tolerance ${tolerance}) --`);
  let allMatch = true;
  const frames: PortdiffFrameResult[] = [];
  for (let i = 0; i < resultA.frames.length; i++) {
    const frameA = resultA.frames[i]!;
    const frameB = resultB.frames[i]!;
    const atMs = frameA.atMs;

    if (opts.writeFramesDir) {
      // Frame naming is this file's own invention (docs/convention/
      // app-bundle.md names "expected frames" but does not prescribe a
      // filename scheme): <trace-stem>.t<ms>.png, one per capture point, so
      // a bundle's frames/ directory holds a self-describing set with no
      // extra index file needed, and verifyPortFrames() below can recover
      // the capture points straight from the directory listing.
      await writePng(join(opts.writeFramesDir, `${opts.traceStem}.t${atMs}.png`), frameA.frame);
    }

    const d = compareFrames(frameA.frame, frameB.frame, tolerance);
    const pct = d.totalPixels > 0 ? ((d.diffPixels / d.totalPixels) * 100).toFixed(2) : "?";
    if (d.match) {
      log(`  t=${atMs}ms  MATCH`);
    } else {
      allMatch = false;
      log(
        `  t=${atMs}ms  DIVERGE  ${d.diffPixels}/${d.totalPixels} px (${pct}%)` +
          (d.firstDiffAt ? `  first at (${d.firstDiffAt.x},${d.firstDiffAt.y})` : "") +
          `  max channel delta ${d.maxChannelDelta}`
      );
      if (opts.outDir) {
        const base = `${opts.traceStem}.t${atMs}`;
        await writePng(join(opts.outDir, `${base}.a.png`), frameA.frame);
        await writePng(join(opts.outDir, `${base}.b.png`), frameB.frame);
        if (d.diffImage) await writePng(join(opts.outDir, `${base}.diff.png`), { width: frameA.frame.width, height: frameA.frame.height, rgb: d.diffImage });
        log(`    wrote ${base}.{a,b,diff}.png -> ${opts.outDir}`);
      }
    }
    frames.push({ atMs, match: d.match, diffPixels: d.diffPixels, totalPixels: d.totalPixels, firstDiffAt: d.firstDiffAt, maxChannelDelta: d.maxChannelDelta });
  }

  if (opts.writeFramesDir) log(`\nwrote ${resultA.frames.length} frame(s) from module A to ${opts.writeFramesDir}`);

  return { allMatch, frames, deviceA: resultA.device, deviceB: resultB.device };
}

// ---- verifyPortFrames: one module vs a bundle's own frames/ directory --
// The shape tools/verify-bundle.ts actually drives for a "pixel-exact"
// port entry (docs/convention/app-bundle.md's 0.2 schema): the bundle
// names its traces and its frames directory, nothing else, so the capture
// points come from the frames directory's own <trace-stem>.t<ms>.png
// filenames rather than being restated anywhere. This works identically
// for a "native" port (nothing else in the bundle to diff live against)
// and a "faithful" one (whose own build should reproduce the SAME
// recorded frames the reference build already wrote here).

export interface VerifyPortFramesTrace {
  tracePath: string;
  framesDir: string;
}

export interface VerifyPortFramesOptions {
  modulePath: string;
  traces: VerifyPortFramesTrace[];
  tolerance?: number; // default 0
}

export interface VerifyPortFramesFrameResult {
  trace: string;
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  expectedFile: string;
}

export interface VerifyPortFramesResult {
  allMatch: boolean;
  frames: VerifyPortFramesFrameResult[];
  // Structural problems (an unreadable trace, an out-of-order trace, a
  // frames directory with nothing matching a trace's own stem): returned
  // rather than thrown, since these are exactly the "bundle claims more
  // than its own files back up" errors tools/verify-bundle.ts needs to
  // report per-port, not crash the whole run over.
  errors: string[];
}

export async function verifyPortFrames(opts: VerifyPortFramesOptions): Promise<VerifyPortFramesResult> {
  const tolerance = opts.tolerance ?? 0;
  const frames: VerifyPortFramesFrameResult[] = [];
  const errors: string[] = [];

  for (const { tracePath, framesDir } of opts.traces) {
    let trace: Trace;
    try {
      trace = JSON.parse(readFileSync(tracePath, "utf8")) as Trace;
    } catch (err) {
      errors.push(`${tracePath}: could not read or parse trace (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!Array.isArray(trace.events)) {
      errors.push(`${tracePath}: not a trace file (missing events array)`);
      continue;
    }
    const outOfOrder = findOutOfOrderEvent(trace.events);
    if (outOfOrder) {
      errors.push(
        `${tracePath}: event[${outOfOrder.index}].t = ${outOfOrder.t} is earlier than the previous event's t = ${outOfOrder.prevT}`
      );
      continue;
    }

    const stem = basename(tracePath).replace(/\.trace\.json$|\.json$/, "");
    let fileForPoint: Map<number, string>;
    try {
      fileForPoint = frameFilesFor(framesDir, stem);
    } catch (err) {
      errors.push(`${framesDir}: could not read frames directory (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const capturePoints = [...fileForPoint.keys()].sort((a, b) => a - b);
    if (capturePoints.length === 0) {
      errors.push(`${framesDir}: no recorded frames matching ${stem}.t<ms>.png for trace ${tracePath}`);
      continue;
    }

    const replay = await replayEmulator(opts.modulePath, trace.events, capturePoints, { seed: trace.seed });
    for (const captured of replay.frames) {
      const file = fileForPoint.get(captured.atMs)!;
      const expectedPath = join(framesDir, file);
      let expected: { width: number; height: number; rgb: Uint8Array };
      try {
        expected = decodeRGBPNG(readFileSync(expectedPath));
      } catch (err) {
        errors.push(`${expectedPath}: could not decode recorded frame (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const d = compareFrames(captured.frame, { width: expected.width, height: expected.height, rgb: expected.rgb }, tolerance);
      frames.push({ trace: stem, atMs: captured.atMs, match: d.match, diffPixels: d.diffPixels, totalPixels: d.totalPixels, expectedFile: file });
    }
  }

  return { allMatch: errors.length === 0 && frames.length > 0 && frames.every((f) => f.match), frames, errors };
}

// ---- CLI entrypoint, unchanged behaviour -------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const trace = JSON.parse(readFileSync(args.tracePath, "utf8")) as Trace;
  if (!Array.isArray(trace.events)) throw new Error(`${args.tracePath}: not a trace file (missing events array)`);

  const outOfOrder = findOutOfOrderEvent(trace.events);
  if (outOfOrder) {
    console.error(
      `${args.tracePath}: event[${outOfOrder.index}].t = ${outOfOrder.t} is earlier than the previous event's t = ${outOfOrder.prevT}. ` +
        `Trace timestamps must be non-decreasing (ties are fine). Fix the trace and retry.`
    );
    process.exit(EXIT_INFRA);
  }

  const capturePoints = capturePointsFor(trace.events, args);
  if (capturePoints.length === 0) {
    console.error("no capture points (trace has no tick events, and neither --at nor --every produced any)");
    process.exit(EXIT_INFRA);
  }
  console.log(`${basename(args.tracePath)}: replaying ${trace.events.length} events, capturing at ${capturePoints.length} point(s): ${capturePoints.join(", ")}`);

  const traceStem = basename(args.tracePath).replace(/\.trace\.json$|\.json$/, "");

  let result: PortdiffResult;
  try {
    result = await runPortdiff({
      moduleAPath: args.moduleAPath,
      moduleBPath: args.moduleBPath,
      trace,
      capturePoints,
      tolerance: args.tolerance,
      writeFramesDir: args.writeFramesDir,
      outDir: args.outDir,
      traceStem,
    });
  } catch (err) {
    if (err instanceof PortdiffInfraError) {
      console.error(err.message);
      process.exit(EXIT_INFRA);
    }
    throw err;
  }

  console.log(`\n${result.allMatch ? "PASS" : "FAIL"}: ${result.frames.length} frame(s) compared (${basename(args.tracePath)})`);
  process.exit(result.allMatch ? EXIT_OK : EXIT_DIVERGENCE);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`harness/portdiff.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(EXIT_INFRA);
  });
}
