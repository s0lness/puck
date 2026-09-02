// The attestation run: replay a bundle's own trace on the board the page
// just flashed, and check the frames the same way `bun run verify-bundle`
// checks that port.
//
// Nothing here is new machinery. It is the SAME replay
// (harness/hardwareSide.ts's replayHardware) over the same devlink
// protocol, reaching the board through the browser transport instead of a
// spawned serial bridge, and then whichever of the two checks that port is
// actually verified by:
//
//   pixel-exact  src/compare.ts's compareFrames, at the plan's tolerance,
//                against the bundle's own recorded frames.
//   invariants   the bundle's OWN invariants.ts check(), the same function,
//                bundled into the page by site/attest/checkers.ts.
//
// If this file had its own replay loop, its own pixel diff or its own
// notion of what "settled" means, a green verdict here would mean something
// different from a green verdict on the command line, and the number on a
// card would be worth nothing.
//
// ONE PORT, EVERY TRACE. replayHardware() connects and disconnects around
// its own run, which is right for a CLI invocation and wrong here: a bundle
// with two traces would open the browser's port picker twice, and the
// second gesture would land after the person has already stopped watching.
// So the caller opens the link once and hands replayHardware a facade whose
// connect/disconnect do nothing (persistentLink, below). The real port is
// still released exactly once, in this file's own finally.

import { replayHardware } from "../../harness/hardwareSide";
import { compareFrames } from "../../src/compare";
import type { HardwareLink, TraceEvent } from "../../harness/types";
import type { InvariantOutcome, TimedFrame } from "../../harness/invariantTypes";
import { checkerFor } from "./checkers";
import { fetchFramePNG } from "./pngFrame";
import type {
  AttestInvariantResult,
  AttestInvariantsPlan,
  AttestPixelExactPlan,
  AttestPlan,
  AttestPointResult,
  AttestResult,
} from "./plan";

export interface AttestProgress {
  phase: "connecting" | "resetting" | "replaying" | "comparing" | "checking" | "done";
  /** 0-100, across the whole run (every trace, every point). */
  percent: number;
  message: string;
}

export type AttestReport = (progress: AttestProgress) => void;

/**
 * replayHardware() owns connect/disconnect. This facade lets one open port
 * serve several traces: the real link is opened and released by
 * runAttestation's own try/finally instead.
 */
export function persistentLink(link: HardwareLink): HardwareLink {
  const facade: HardwareLink = {
    connect: async () => {},
    disconnect: async () => {},
    send: (event: TraceEvent) => link.send(event),
    screenshot: () => link.screenshot(),
  };
  // Only forwarded when the real link has one: an absent reset() means "this
  // hardware always boots into the same state as emu_init()", and inventing
  // one here would silently change what the run starts from.
  if (link.reset) facade.reset = () => link.reset!();
  return facade;
}

export interface RunAttestationOptions {
  plan: AttestPlan;
  /** Opened once, released once, whatever happens. Built by the caller so this file needs no transport of its own. */
  link: HardwareLink;
  report?: AttestReport;
  /** Defaults to fetching the plan's own recorded frames over HTTP. Injectable so a test can hand over frames directly. */
  loadFrame?: (url: string) => Promise<{ width: number; height: number; rgb: Uint8Array }>;
}

export async function runAttestation(opts: RunAttestationOptions): Promise<AttestResult> {
  return opts.plan.kind === "invariants"
    ? runInvariantsAttestation({ ...opts, plan: opts.plan })
    : runPixelExactAttestation({ ...opts, plan: opts.plan });
}

// ---- pixel-exact: the board's frames against the recorded ones ---------

async function runPixelExactAttestation(opts: RunAttestationOptions & { plan: AttestPixelExactPlan }): Promise<AttestResult> {
  const { plan, link } = opts;
  const report = opts.report ?? (() => {});
  const loadFrame = opts.loadFrame ?? fetchFramePNG;

  const totalPoints = plan.traces.reduce((n, t) => n + t.points.length, 0);
  if (totalPoints === 0) {
    throw new Error(`${plan.combo} has no recorded frames to compare against, so there is nothing to attest`);
  }

  const points: AttestPointResult[] = [];
  let donePoints = 0;

  report({ phase: "connecting", percent: 0, message: "Opening the board's devlink port…" });
  await link.connect();
  try {
    for (const trace of plan.traces) {
      report({
        phase: "replaying",
        percent: Math.round((donePoints / totalPoints) * 100),
        message: `Replaying ${trace.name} on the board (${trace.events.length} events)…`,
      });
      const capturePoints = trace.points.map((p) => p.atMs);
      const replay = await replayHardware(persistentLink(link), trace.events, capturePoints);

      for (const captured of replay.frames) {
        const point = trace.points.find((p) => p.atMs === captured.atMs);
        if (!point) continue;
        report({
          phase: "comparing",
          percent: Math.round((donePoints / totalPoints) * 100),
          message: `Comparing ${trace.name} at ${captured.atMs}ms against the recorded frame…`,
        });
        const expected = await loadFrame(`${plan.framesBase}${point.frame}`);
        const diff = compareFrames(captured.frame, expected, plan.tolerance);
        points.push({
          trace: trace.name,
          atMs: captured.atMs,
          match: diff.match,
          diffPixels: diff.diffPixels,
          totalPixels: diff.totalPixels,
        });
        donePoints++;
      }
    }
  } finally {
    // The port goes back whatever happened here, including a board that
    // reset mid-run and threw. See harness/links/webSerialLink.ts's header.
    await link.disconnect();
  }

  const verdict = points.length > 0 && points.every((p) => p.match) ? "match" : "diverge";
  report({
    phase: "done",
    percent: 100,
    message:
      verdict === "match"
        ? `${points.length}/${points.length} frames matched, pixel for pixel.`
        : `${points.filter((p) => !p.match).length}/${points.length} frames diverged.`,
  });
  return { kind: "pixel-exact", verdict, points, invariants: [], incomplete: false };
}

// ---- invariants: the board's frames through the bundle's own checker ---
//
// The capture points are the bundle's own verification.captureAt, in the
// bundle's own order, because that order is a CONTRACT with the checker:
// fluidbox's frames[1] is "the tick right after the shake" and nothing in
// the frames themselves says so. replayHardware sorts the points it
// captures at (a board runs forward in time and cannot be asked for a
// moment that has passed), so the frames come back in time order and are
// put back into the requested order here, by atMs, before the checker sees
// them. For every bundle in this repository the two orders are the same;
// doing it anyway means a future trace that lists them otherwise gets what
// it asked for rather than a silently reordered run.

async function runInvariantsAttestation(opts: RunAttestationOptions & { plan: AttestInvariantsPlan }): Promise<AttestResult> {
  const { plan, link } = opts;
  const report = opts.report ?? (() => {});

  const check = checkerFor(plan.checker);
  if (!check) {
    throw new Error(
      `this page carries no bundled checker for ${plan.checker}, so ${plan.app}'s own invariants cannot be run here. ` +
        `site/attest/checkers.ts is the list, and site/build.ts refuses to emit a plan that is not in it.`
    );
  }

  const totalPoints = plan.traces.reduce((n, t) => n + t.captureAt.length, 0);
  if (totalPoints === 0) {
    throw new Error(`${plan.combo}'s bundle states no capture points, so there is nothing for its invariants to read`);
  }

  const frames: TimedFrame[] = [];
  let donePoints = 0;

  report({ phase: "connecting", percent: 0, message: "Opening the board's devlink port…" });
  await link.connect();
  try {
    for (const trace of plan.traces) {
      report({
        phase: "replaying",
        percent: Math.round((donePoints / totalPoints) * 100),
        message: `Replaying ${trace.name} on the board (${trace.events.length} events)…`,
      });
      const replay = await replayHardware(persistentLink(link), trace.events, trace.captureAt);
      for (const atMs of trace.captureAt) {
        const captured = replay.frames.find((f) => f.atMs === atMs);
        if (!captured) {
          throw new Error(`the board never produced a capture at ${atMs}ms of ${trace.name}, so this port's invariants cannot be checked on it`);
        }
        frames.push({ atMs: captured.atMs, frame: captured.frame });
        donePoints++;
      }
    }
  } finally {
    await link.disconnect();
  }

  // A board whose panel is not the one this port was built for would give
  // the checker frames of the wrong size, and a checker's thresholds are
  // pixel counts. Caught here rather than reported as a behavioural
  // divergence that is really a wiring mistake.
  const panel = plan.device.panel;
  const wrong = frames.find((f) => f.frame.width !== panel.w || f.frame.height !== panel.h);
  if (wrong) {
    throw new Error(
      `the board captured ${wrong.frame.width}x${wrong.frame.height} frames, but ${plan.pack} declares a ${panel.w}x${panel.h} panel. ` +
        `This port's invariants are pixel counts against that panel, so the run is void rather than divergent.`
    );
  }

  report({ phase: "checking", percent: 100, message: `Running ${plan.app}'s own invariants on ${frames.length} captured frame(s)…` });
  // A checker is a synchronous pass over every captured frame - hundreds of
  // thousands of pixels each - so it is the one step here that can hold the
  // main thread long enough to matter. Yielding first lets the line above
  // actually reach the screen instead of being replaced by the verdict in
  // the same frame, which is the difference between a page that says what
  // it is doing and one that appears to hang.
  await new Promise((resolve) => setTimeout(resolve, 0));
  // pushStats is deliberately absent: a board answers SHOT with its
  // framebuffer and reports nothing about what it pushed to the panel. A
  // checker that needs it says "unevaluable" and this run is not postable.
  const result = check(frames, { device: plan.device });
  const outcomes: InvariantOutcome[] = result.invariants ?? [];
  if (outcomes.length === 0) {
    throw new Error(
      `${plan.checker} reported no per-invariant outcomes, so this page cannot say which invariant held and which did not. ` +
        `A checker must return them (harness/invariantTypes.ts's summariseInvariants).`
    );
  }

  const invariants: AttestInvariantResult[] = outcomes.map((o) => ({ id: o.id, name: o.name, status: o.status, message: o.message }));
  const failed = invariants.filter((i) => i.status === "fail").length;
  const unanswered = invariants.filter((i) => i.status === "unevaluable");
  const verdict = failed === 0 ? "match" : "diverge";

  report({
    phase: "done",
    percent: 100,
    message:
      unanswered.length > 0
        ? `${unanswered.length} invariant(s) could not be answered by this board.`
        : verdict === "match"
          ? `${invariants.filter((i) => i.status === "pass").length} invariant(s) held on this board.`
          : `${failed} invariant(s) failed on this board.`,
  });
  return { kind: "invariants", verdict, points: [], invariants, incomplete: unanswered.length > 0 };
}

/**
 * sha256 of the firmware artifact, hex, computed in the page from the bytes
 * it fetched. The point of computing it here rather than emitting it from
 * the build is that this is the number the person's own browser saw: an
 * attestation that trusted a build-time constant would say nothing about
 * what was actually written to the board.
 *
 * crypto.subtle needs a secure context, which is https, 127.0.0.1 and
 * localhost. Every place this runs is one of those.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("this browser exposes no crypto.subtle, so the firmware artifact cannot be identified by its own hash");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
