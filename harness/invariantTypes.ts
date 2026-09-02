// The checker contract, and nothing else.
//
// This is the half of harness/invariantRun.ts that a bundle's own
// invariants.ts actually depends on: the shape of a captured frame, the
// shape of the metadata a checker reads, and the shape of what it reports
// back. The runner around it (reading a trace off disk, instantiating a
// wasm module, importing a checker by path, printing lines, choosing an
// exit code) stays there.
//
// WHY THE SPLIT, and it is the same argument harness/links/devlinkProtocol.ts
// makes one directory over: a checker now runs in TWO places. It runs under
// bun, loaded by path from `bun run verify-bundle`; and it runs in a browser
// page, bundled into site/dist/flash/attest.js, checking the frames a real
// board just drew (site/attest/run.ts). invariantRun.ts opens files - it
// imports node:fs, node:path and node:url - so a checker that imported its
// types from there would drag `node:fs` into a browser bundle's import
// graph, and that is the end of the bundle. A type-only import happens to
// erase today, which means the whole arrangement would rest on a bundler's
// behaviour rather than on the import graph. So the contract lives here,
// in a file with no imports that are not types.
//
// WHAT THIS FILE MAY NOT DO, restated as a rule rather than left as a
// habit: no node:*, no Bun.*, no DOM, no import from any pack. Same rule
// devlinkProtocol.ts's header states, for the same reason and enforced by
// the same fact - it is bundled into a page.

import type { CapturedFrame } from "../src/frame";
import type { DeviceDescriptor } from "../src/wasm";
import type { PushLoadStats } from "../src/replayCore";

// One captured frame plus the trace-relative millisecond it was captured
// at - the same pairing harness/portdiff.ts's own ReplayResult.frames
// already uses, renamed here so a checker file importing this module's
// types does not have to reach into harness/emulatorSide.ts's return shape
// to name it.
export interface TimedFrame {
  atMs: number;
  frame: CapturedFrame;
}

// Deliberately small. A checker that needs more than "what device is this"
// can read it off `device` (panel size/format, buttons, sensors - the same
// DeviceDescriptor every other consumer in this repo already uses) rather
// than this file inventing a second, app-specific metadata shape per
// bundle.
export interface InvariantMeta {
  device: DeviceDescriptor;
  // Panel-push load aggregated over the WHOLE replayed trace (every tick,
  // not just the requested capture points), from src/replayCore.ts's own
  // emu_push_count()/emu_push_x/y/w/h() instrumentation. Undefined for a
  // module built without that export - and undefined for EVERY run driven
  // over devlink, because a board reports its framebuffer and never what
  // it pushed. A checker that needs it must therefore report
  // "unevaluable" rather than quietly passing: see InvariantStatus below.
  pushStats?: PushLoadStats;
}

/**
 * What one invariant did on one run.
 *
 * The two statuses that are neither pass nor fail carry a distinction this
 * repository cannot afford to blur, because one of them is evidence and the
 * other is a hole in it:
 *
 *   "skip"        this invariant does not apply to this device at all, so
 *                 there is nothing missing. fluidbox's panel-push bound is
 *                 scoped to one pack's QSPI bus by name; on any other board
 *                 it is not a check that went unanswered, it is a check that
 *                 was never about that board.
 *
 *   "unevaluable" this invariant DOES apply here and the data it needs is
 *                 not available on this surface (the pushStats no board
 *                 reports). The run is incomplete, and a verdict computed
 *                 as though the invariant had passed would be a claim its
 *                 own evidence does not support. site/attest/ refuses to
 *                 post such a run and says which invariant is why
 *                 (docs/decisions/0011).
 */
export type InvariantStatus = "pass" | "fail" | "skip" | "unevaluable";

export interface InvariantOutcome {
  /** Stable across runs and across surfaces: this is what a UI keys a row on. */
  id: string;
  /** What the invariant asserts, in one short line. */
  name: string;
  status: InvariantStatus;
  /**
   * The invariant's OWN sentence, with its own measured numbers in it -
   * the failure message when it failed, what was measured when it passed,
   * and why it could not be answered when it could not. Never a generic
   * "ok"/"failed": the number is the whole point of the check.
   */
  message: string;
}

export interface InvariantResult {
  pass: boolean;
  failures: string[];
  /**
   * Per-invariant detail, when a checker reports it. Optional so a checker
   * written against the original two-field contract still type-checks and
   * still runs; every checker in this repository reports it.
   */
  invariants?: InvariantOutcome[];
}

export type InvariantChecker = (frames: TimedFrame[], meta: InvariantMeta) => InvariantResult;

/**
 * One invariant's outcome from the failures it produced. `fails` is empty
 * when it held; `passMessage` is what to say when it did, and is expected to
 * carry the measured numbers.
 */
export function held(id: string, name: string, fails: string[], passMessage: string): InvariantOutcome {
  return fails.length > 0
    ? { id, name, status: "fail", message: fails.join("; ") }
    : { id, name, status: "pass", message: passMessage };
}

/**
 * The two-field result every existing caller reads, derived from the
 * per-invariant outcomes rather than tracked beside them.
 *
 * `unevaluable` does NOT fail the run here, and that is deliberate: on the
 * emulator side an invariant that cannot be answered has always been
 * skipped rather than turned into a failure (a module built before an
 * invariant existed must not go red for it), and this function is what
 * `bun run verify-bundle` reads. The surface that must refuse an
 * unanswered invariant is the one making a public claim about a board, and
 * it reads `invariants` rather than `pass`.
 */
export function summariseInvariants(outcomes: InvariantOutcome[]): InvariantResult {
  const failures = outcomes.filter((o) => o.status === "fail").map((o) => o.message);
  return { pass: failures.length === 0, failures, invariants: outcomes };
}
