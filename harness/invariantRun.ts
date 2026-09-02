#!/usr/bin/env bun
// invariantRun: the device-agnostic runner half of "verified by invariants"
// (docs/convention/app-bundle.md's `adaptation` port mode). A `faithful`
// port is checked by harness/portdiff.ts's pixel-exact frame diff against a
// second module; an `adaptation` port changes the interaction surface, so
// there is no second module to diff against pixel-for-pixel, and the
// bundle instead states behavioural invariants and checks those instead.
//
// The split this file exists to keep: THE BUNDLE OWNS ITS CHECKS, THE
// INSTRUMENT OWNS THE RUNNER. Nothing here knows what "settled" or "shaken"
// means for any particular app - it only knows how to replay a trace
// against one wasm module, capture the framebuffer at the requested points,
// and hand the resulting frames to whatever checker module the bundle
// supplies. A checker file lives with its bundle (e.g.
// apps/fluidbox/invariants.ts) and is loaded by PATH, not registered here,
// so a new invariant-verified app needs zero changes to this file - the
// same reason harness/portdiff.ts stays device-agnostic (see that file's
// own header comment).
//
// runInvariants(), below, is this file's core check as an importable
// function: tools/verify-bundle.ts calls it directly with the capture
// points a bundle's own bundle.json states (verification.captureAt), so
// the verifier never reimplements "replay, then hand frames to a checker"
// itself. main() is now a thin CLI wrapper around the same function, with
// the same flags, output and exit codes as before.
//
// Usage:
//   bun run invariants <wasm> <trace.json> <checker.ts> [options]
//   bun run harness/invariantRun.ts <wasm> <trace.json> <checker.ts> [options]
//
// Options:
//   --at <ms,ms,...>   explicit capture points, as trace-relative
//                       milliseconds (matching TraceEvent.t) - this is the
//                       normal way to drive this file: an invariant bundle
//                       usually cares about specific moments ("settled",
//                       "right after the shake", "settled again"), not an
//                       even sampling, so most checkers expect an exact,
//                       documented number of captures in a known order (see
//                       the checker interface below and each bundle's own
//                       invariants.ts for what order it expects).
//   --every <ms>       capture every N ms instead of explicit points
//                       (same semantics as harness/portdiff.ts's --every)
//                       (default if neither --at nor --every given:
//                       capture once, at the trace's final tick)
//
// Exit codes, the same three-way split every other harness CLI in this repo
// uses (CI reads the code, not the prose): 0 = ran, every invariant passed;
// 1 = ran, the checker reported at least one failure; 2 = never ran to
// completion (bad args, a malformed or out-of-order trace, a module that
// failed to instantiate, a checker that failed to load or does not export
// `check`).
//
// THE CHECKER INTERFACE, declared in harness/invariantTypes.ts and
// re-exported below, because it is a contract between a bundle and TWO
// runners now, not one:
//
//   export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult
//
// `frames` is one TimedFrame per requested capture point, IN THE SAME ORDER
// the capture points were requested - a checker is free to assume that
// order encodes meaning (frames[0] is "before", frames[1] is "right
// after", etc.) as long as it documents what it assumes, since neither
// runner promises more than "same order you asked for."
//
// The second runner is site/attest/run.ts, which replays the same trace on
// a real board over devlink and hands the frames it captured to the same
// checker, inside a browser page. That is why the types moved out of this
// file: this one opens files (node:fs, node:path, node:url) and a checker
// importing its types from here would drag node:fs into a page bundle.
// Nothing else changed - this file's own behaviour, output and exit codes
// are what they were.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { replayEmulator } from "./emulatorSide";
import type { Trace } from "./types";
import type { DeviceDescriptor } from "../src/wasm";
import type { InvariantChecker, InvariantMeta, InvariantResult, TimedFrame } from "./invariantTypes";

// Re-exported so `import type { TimedFrame } from "../../harness/invariantRun"`
// keeps resolving for anything outside this repository that already wrote
// it that way. Everything in here imports from invariantTypes.ts directly.
export type {
  InvariantChecker,
  InvariantMeta,
  InvariantOutcome,
  InvariantResult,
  InvariantStatus,
  TimedFrame,
} from "./invariantTypes";
export { held, summariseInvariants } from "./invariantTypes";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_INFRA = 2;

// Thrown by runInvariants() for a failure that isn't the checker reporting
// a real invariant failure (a checker that won't load, doesn't export
// `check`, or throws): main() maps this to exit code 2, same as every
// infra failure always has; tools/verify-bundle.ts maps it to its own
// "malformed" bucket instead of a verification failure.
export class InvariantInfraError extends Error {}

interface Args {
  wasmPath: string;
  tracePath: string;
  checkerPath: string;
  at: number[] | null;
  every: number | null;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let at: number[] | null = null;
  let every: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--at") at = (argv[++i] ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    else if (a === "--every") every = Number(argv[++i]);
    else positional.push(a);
  }
  if (positional.length < 3) {
    console.error("usage: bun run invariants <wasm> <trace.json> <checker.ts> [--at ms,ms,... | --every ms]");
    process.exit(EXIT_INFRA);
  }
  return { wasmPath: positional[0]!, tracePath: positional[1]!, checkerPath: positional[2]!, at, every };
}

// Identical rule to harness/portdiff.ts's findOutOfOrderEvent, for the
// identical reason: the replay side assumes ticks arrive with
// non-decreasing `t`, so an out-of-order trace would otherwise produce a
// wrong or skipped capture point rather than an error. Exported for the
// same reuse reason harness/portdiff.ts's own copy is.
export function findOutOfOrderEvent(events: Trace["events"]): { index: number; t: number; prevT: number } | null {
  let prevT = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const t = events[i]!.t;
    if (t < prevT) return { index: i, t, prevT };
    prevT = t;
  }
  return null;
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

// ---- runInvariants: the core check, importable -------------------------

export interface RunInvariantsOptions {
  wasmPath: string;
  trace: Trace;
  capturePoints: number[];
  checkerPath: string;
  quiet?: boolean; // default false: prints the same lines the CLI always has
}

export interface RunInvariantsResult {
  pass: boolean;
  failures: string[];
  device: DeviceDescriptor;
  frameCount: number;
}

export async function runInvariants(opts: RunInvariantsOptions): Promise<RunInvariantsResult> {
  const log = opts.quiet ? (_s: string) => {} : (s: string) => console.log(s);

  const result = await replayEmulator(opts.wasmPath, opts.trace.events, opts.capturePoints, { seed: opts.trace.seed });
  log(`${opts.wasmPath}: ${result.device.name ?? "device"} ${result.device.panel.w}x${result.device.panel.h}, ${result.frames.length} frame(s) captured`);

  const checkerUrl = pathToFileURL(resolve(opts.checkerPath)).href;
  let checkerModule: { check?: unknown };
  try {
    checkerModule = await import(checkerUrl);
  } catch (err) {
    throw new InvariantInfraError(`could not load checker ${opts.checkerPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof checkerModule.check !== "function") {
    throw new InvariantInfraError(`${opts.checkerPath} does not export a "check" function - see harness/invariantRun.ts's header comment for the required interface`);
  }
  const check = checkerModule.check as InvariantChecker;

  const frames: TimedFrame[] = result.frames.map((f) => ({ atMs: f.atMs, frame: f.frame }));
  const meta: InvariantMeta = { device: result.device, pushStats: result.pushStats };

  let verdict: InvariantResult;
  try {
    verdict = check(frames, meta);
  } catch (err) {
    throw new InvariantInfraError(`checker threw: ${err instanceof Error ? err.message : String(err)}${err instanceof Error && err.stack ? `\n${err.stack}` : ""}`);
  }

  log(`\n-- invariants (${opts.checkerPath}) --`);
  if (verdict.pass) {
    log(`PASS: all invariants held over ${frames.length} captured frame(s)`);
  } else {
    log(`FAIL: ${verdict.failures.length} invariant(s) failed:`);
    for (const f of verdict.failures) log(`  - ${f}`);
  }

  return { pass: verdict.pass, failures: verdict.failures, device: result.device, frameCount: frames.length };
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
  console.log(`replaying ${trace.events.length} events, capturing at ${capturePoints.length} point(s): ${capturePoints.join(", ")}`);

  let result: RunInvariantsResult;
  try {
    result = await runInvariants({ wasmPath: args.wasmPath, trace, capturePoints, checkerPath: args.checkerPath });
  } catch (err) {
    if (err instanceof InvariantInfraError) {
      console.error(err.message);
      process.exit(EXIT_INFRA);
    }
    throw err;
  }

  process.exit(result.pass ? EXIT_OK : EXIT_FAIL);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`harness/invariantRun.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(EXIT_INFRA);
  });
}
