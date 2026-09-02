// What an attestation run needs, and where it comes from.
//
// site/build.ts writes one of these next to the flash page for every combo
// that has BOTH a browser-flashable firmware artifact and a bundle port
// this repository knows how to check on a board. That pairing is the whole
// idea: the page can put the firmware on the board, so the page can then
// run that app's own trace on the board it just flashed and check the
// result the same way `bun run verify-bundle` checks it.
//
// TWO KINDS, BECAUSE A PORT IS VERIFIED ONE OF TWO WAYS and both of them
// are a run somebody's board performed (docs/decisions/0011):
//
//   "pixel-exact"  the port has recorded frames, so the board's frames are
//                  diffed against them at tolerance zero. What a
//                  `faithful`/`native` port claims is pixel identity, so
//                  pixel identity is what gets checked.
//
//   "invariants"   the port has a checker instead (an `adaptation` port
//                  changed the interaction surface, so there is no second
//                  module to be identical to). The board's frames go to
//                  that bundle's OWN invariants.ts, the same function
//                  verify-bundle runs, bundled into the page.
//
// The two are counted together and named apart. They are not two grades of
// the same check: one says "these pixels", the other says "this behaviour",
// and a card that showed one number without ever being able to say which
// kind produced it would be doing what the hand-typed `silicon` block did.
//
// The shape is deliberately small and self-describing: a page loads one
// JSON file and knows everything it needs, with no second lookup into
// registry.json or a bundle.json it would have to parse in the browser.

import type { TraceEvent } from "../../src/recorder";
import type { DeviceDescriptor } from "../../src/wasm";
import type { InvariantStatus } from "../../harness/invariantTypes";

/** Which browser flashing path this combo's board uses. Decides DTR, and is posted with the verdict. */
export type BoardFamily = "rp2350" | "esp32";

/** The two ways a port is verified, and therefore the two ways a board can answer for one. */
export type AttestKind = "pixel-exact" | "invariants";

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

/** An invariants port's trace: the same events, and the capture points the bundle's own verification.captureAt states. */
export interface AttestInvariantTrace {
  name: string;
  events: TraceEvent[];
  /** In bundle.json's own order, which is the order the checker reads them in. Never sorted here. */
  captureAt: number[];
}

interface AttestPlanCommon {
  /** site/build.ts's combo id, e.g. "chrono-rp2350". Identifies the flash page this plan belongs to. */
  combo: string;
  app: string;
  pack: string;
  boardFamily: BoardFamily;
  /**
   * The firmware artifact this page flashes, hashed in the page and posted
   * with the verdict. Resolved against the PLAN's own URL, like framesBase
   * below, so both are relative to one thing rather than to two.
   */
  artifact: string;
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

export interface AttestPixelExactPlan extends AttestPlanCommon {
  kind: "pixel-exact";
  /** Per-channel difference below which a pixel counts as matching. Zero for a pixel-exact port, and it stays zero. */
  tolerance: number;
  /** URL prefix for this plan's recorded frames, relative to the plan file itself. */
  framesBase: string;
  /** Every trace this port is verified against, in bundle.json's own order. */
  traces: AttestTrace[];
}

export interface AttestInvariantsPlan extends AttestPlanCommon {
  kind: "invariants";
  /**
   * The bundle's own checker path, verbatim from bundle.json's
   * verification.checker (e.g. "apps/fluidbox/invariants.ts"). It is a KEY,
   * not a URL: site/attest/checkers.ts maps it to the function bundled into
   * the page. Carrying the bundle's own string rather than inventing a
   * short name means a plan can never point at a checker the bundle does
   * not claim.
   */
  checker: string;
  /**
   * The pack's own device.json, which is what the checker reads as
   * meta.device. The board itself only reports its panel geometry over
   * devlink (PING), so this is the declaration the firmware was built
   * against; the page checks the board's reported panel against it before
   * trusting either.
   */
  device: DeviceDescriptor;
  traces: AttestInvariantTrace[];
}

export type AttestPlan = AttestPixelExactPlan | AttestInvariantsPlan;

export interface AttestPointResult {
  trace: string;
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
}

/** One invariant's outcome on the board, as the bundle's own checker reported it. */
export interface AttestInvariantResult {
  id: string;
  name: string;
  status: InvariantStatus;
  message: string;
}

/** "match" only when every check held. Anything else is "diverge", including a run that never reached the end. */
export type AttestVerdict = "match" | "diverge";

export interface AttestResult {
  kind: AttestKind;
  verdict: AttestVerdict;
  /** Pixel-exact runs only; empty for an invariants run. */
  points: AttestPointResult[];
  /** Invariants runs only; empty for a pixel-exact run. */
  invariants: AttestInvariantResult[];
  /**
   * At least one invariant applies to this board and could not be answered
   * from what the board reports (harness/invariantTypes.ts's "unevaluable").
   * The run is shown in full and is NOT postable: a verdict computed as
   * though an unanswered check had passed is exactly the kind of claim
   * docs/decisions/0011 exists to stop making.
   */
  incomplete: boolean;
}

/** Exactly what POST /api/attest accepts. Nothing personal, no fingerprint, no cookie. */
export interface AttestPost {
  app: string;
  pack: string;
  /** sha256 of the firmware artifact's bytes, hex, computed in the page from what it actually flashed. */
  portSha: string;
  /** Which kind of check produced this verdict. The counter adds both kinds up and names them apart. */
  kind: AttestKind;
  verdict: AttestVerdict;
  /** Present for kind "pixel-exact", absent otherwise. */
  points?: AttestPointResult[];
  /** Present for kind "invariants", absent otherwise. Never carries an "unevaluable" outcome: such a run is not posted at all. */
  invariants?: AttestInvariantResult[];
  boardFamily: BoardFamily;
  /** The browser's own date, YYYY-MM-DD. Recorded, but never what the endpoint counts by: see site/functions/api/attest.ts. */
  date: string;
}
