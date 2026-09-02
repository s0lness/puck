// What an attestation run needs, and where it comes from.
//
// site/build.ts writes one of these next to the flash page for every combo
// that has BOTH a browser-flashable firmware artifact and a bundle port
// verified pixel-exact against recorded frames. That pairing is the whole
// idea: the page can put the firmware on the board, so the page can then
// run that app's own trace on the board it just flashed and diff the result
// against the same recorded frames `bun run verify-bundle` uses. A port
// verified by invariants has no recorded frames to diff against, so it gets
// no plan and no button, rather than a button that would have to invent a
// weaker check to have something to say.
//
// The shape is deliberately small and self-describing: a page loads one
// JSON file and knows everything it needs, with no second lookup into
// registry.json or a bundle.json it would have to parse in the browser.

import type { TraceEvent } from "../../src/recorder";

/** Which browser flashing path this combo's board uses. Decides DTR, and is posted with the verdict. */
export type BoardFamily = "rp2350" | "esp32";

export interface AttestCapturePoint {
  /** Trace-relative milliseconds, matching TraceEvent.t: the moment the reference frame was recorded at. */
  atMs: number;
  /** Filename of the recorded frame, under the plan's own frames directory. */
  frame: string;
}

export interface AttestTrace {
  /** The trace's stem, as the bundle names it, and as it appears in a per-point result. */
  name: string;
  events: TraceEvent[];
  /** Sorted by atMs. Derived from the frames directory's own <stem>.t<ms>.png filenames, same rule harness/portdiff.ts's verifyPortFrames uses. */
  points: AttestCapturePoint[];
}

export interface AttestPlan {
  /** site/build.ts's combo id, e.g. "chrono-rp2350". Identifies the flash page this plan belongs to. */
  combo: string;
  app: string;
  pack: string;
  boardFamily: BoardFamily;
  /** Per-channel difference below which a pixel counts as matching. Zero for a pixel-exact port, and it stays zero. */
  tolerance: number;
  /**
   * The firmware artifact this page flashes, hashed in the page and posted
   * with the verdict. Resolved against the PLAN's own URL, like framesBase
   * below, so both are relative to one thing rather than to two.
   */
  artifact: string;
  /** URL prefix for this plan's recorded frames, relative to the plan file itself. */
  framesBase: string;
  /** Every trace this port is verified against, in bundle.json's own order. */
  traces: AttestTrace[];
  /**
   * g_apps[] index the board is put into before each trace replays. The
   * emulator side always starts from emu_init(), which enters app 0, so 0 is
   * the only value that makes the two sides start alike.
   */
  appIndex: number;
  /**
   * Whether opening the port asserts DTR. The RP2350's USB CDC stack does
   * not answer without it; the ESP32-S3's USB Serial/JTAG peripheral wires
   * it to the chip's own boot strap and is rebooted by it. A per-board fact,
   * carried in the plan rather than guessed in the page.
   */
  dataTerminalReady: boolean;
}

export interface AttestPointResult {
  trace: string;
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
}

/** "match" only when every point matched. Anything else is "diverge", including a run that never reached the end. */
export type AttestVerdict = "match" | "diverge";

export interface AttestResult {
  verdict: AttestVerdict;
  points: AttestPointResult[];
}

/** Exactly what POST /api/attest accepts. Nothing personal, no fingerprint, no cookie. */
export interface AttestPost {
  app: string;
  pack: string;
  /** sha256 of the firmware artifact's bytes, hex, computed in the page from what it actually flashed. */
  portSha: string;
  verdict: AttestVerdict;
  points: AttestPointResult[];
  boardFamily: BoardFamily;
  /** The browser's own date, YYYY-MM-DD. Recorded, but never what the endpoint counts by: see site/functions/api/attest.ts. */
  date: string;
}
