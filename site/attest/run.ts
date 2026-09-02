// The attestation run: replay a bundle's own trace on the board the page
// just flashed, and diff the frames against that bundle's own recorded
// ones.
//
// Nothing here is new machinery. It is the SAME replay
// (harness/hardwareSide.ts's replayHardware) and the SAME comparison
// (src/compare.ts's compareFrames) that `bun run verify-bundle` and
// `bun run harness:hardware` use, over the same devlink protocol, reaching
// the board through the browser transport instead of a spawned serial
// bridge. If this file had its own replay loop or its own pixel diff, a
// green verdict here would mean something different from a green verdict on
// the command line, and the number on a card would be worth nothing.
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
import { fetchFramePNG } from "./pngFrame";
import type { AttestPlan, AttestPointResult, AttestResult } from "./plan";

export interface AttestProgress {
  phase: "connecting" | "resetting" | "replaying" | "comparing" | "done";
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
  return { verdict, points };
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
