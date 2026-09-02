// A REAL HardwareLink, over devlink, against the boards this repo's packs
// are the firmware for. This is the file harness/types.ts left a seam for
// and docs/harness.md described in the abstract for months without anybody
// writing: everything under harness/ was built to compare an emulator
// against real hardware and had only ever been run against
// harness/fixtures/loopbackLink.ts, which is a second copy of the same wasm
// module and therefore proves nothing about a board.
//
// WHAT IS LEFT IN THIS FILE, AND WHAT MOVED. The devlink PROTOCOL - reply
// shapes, the SHOT read loop, the RLE decoder, the grey-to-RGB inverse, the
// trace-event mapping, the pacing, the reset detection - now lives in
// harness/links/devlinkProtocol.ts, because a second transport appeared
// (the gallery's flash page runs the same protocol from a browser over Web
// Serial, harness/links/webSerialLink.ts) and two copies of a wire protocol
// agree exactly once, on the day the second is written (docs/decisions/
// 0002). What is left here is exactly what that file may not contain: the
// TRANSPORT. Opening the port, and deciding whether to open it at all.
//
// The transport is packs/rp2350-touch-amoled-18/tools/dev.ts's PowerShell
// serial bridge (packs/rp2350-touch-amoled-18/tools/README-devlink.md): one
// command per line over the board's USB CDC port, shared with the runtime's
// own debug prints. Nothing here reimplements THAT either - the port
// opening (DTR before Open(), the one gotcha most likely to make a first
// run look like a dead board), the line reader and the server-vs-direct
// arbitration are all imported from dev.ts.
//
// THREE THINGS THIS ADAPTER AND ITS PROTOCOL EXIST TO GET RIGHT, each of
// which has already cost this project a day or a reboot:
//
// 1. THE PORT IS EXCLUSIVE AND SOMETHING ELSE MAY OWN IT. The emulator's dev
//    server holds the port whenever it is running. So this link asks the
//    server first (openServerBridge, GET /api/devlink/status then a
//    WebSocket) and only opens the port itself when the server is not
//    holding one - the same arbitration dev.ts's own openBridge() does.
//    Opening the port directly while the server holds it does not "win": it
//    fails with an access-denied, and the run dies for a reason that has
//    nothing to do with the firmware under test. THIS IS THIS FILE'S JOB,
//    and the reason a transport-agnostic protocol core could not swallow
//    it.
//
// 2. SCREENSHOTS CAN REBOOT THE BOARD. A SHOT walks the whole framebuffer
//    twice and writes the result one character at a time inside a single
//    devlink_poll(), i.e. inside one iteration of the main loop that feeds
//    the 4s watchdog. Firmware caps one reply at DEVLINK_SHOT_BUDGET_US
//    (750ms) and then truncates, which bounds a single shot but says nothing
//    about a loop of them. A differential run is by nature a lot of
//    screenshots, so the protocol paces them (minShotIntervalMs, measured -
//    see harness/hardwarePacing.ts and docs/harness.md) and reports a
//    truncated payload as a truncation rather than as a corrupt image.
//
// 3. A REBOOTED BOARD MUST NOT BE DIFFED. If the board resets mid-run it
//    comes back in app 0 with a cleared arena, and every frame after that
//    point is a comparison against a different device state. Diffing that
//    and reporting "divergence" would be exactly the instrument that lies
//    (packs/rp2350-touch-amoled-18/docs/decisions/0004). So every capture is
//    bracketed by an APP query, and every line of shared-port noise the
//    protocol reads on its way to a reply is checked for the profiler's own
//    cumulative counters going backwards. Either one aborts the run with
//    what was seen.
//
// Usage (see package.json's harness:hardware):
//   bun run harness/diff.ts <trace.json> --link harness/links/devlinkLink.ts
//
// TWO BOARDS, ONE ADAPTER. This was written for the RP2350 pack and now
// also drives packs/esp32-s3-touch-amoled-18, which implements the same
// devlink wire protocol over its native USB Serial/JTAG port (see that
// pack's docs/decisions/0002-devlink-over-usb-serial-jtag.md). Nothing here
// is per-board except what the environment variables below select: the
// port, and whether opening it asserts DTR. Everything device-specific
// stayed in the firmware, which is the arrangement that makes a second
// board cost one env var rather than a second link.
//
// Environment:
//   DEVLINK_PORT        serial port (default COM4, read by dev.ts). The
//                       ESP32-S3 board is on its own port; name it here.
//   DEVLINK_DTR         "0" to open the port WITHOUT asserting DTR. Required
//                       for the ESP32-S3 board, whose USB Serial/JTAG
//                       peripheral wires DTR to the chip's own boot strap;
//                       leave it alone (default "1") for the RP2350, whose
//                       USB CDC stack needs DTR to answer at all.
//   DEVLINK_SERVER_URL  emulator dev server (default http://127.0.0.1:5330)
//   PUCK_HW_APP         app index to reset into before replay (default 0,
//                       the index rtcore_init() itself boots into)
//   PUCK_HW_SHOT_MIN_MS minimum gap between screenshots, ms (default 250,
//                       measured - see DEFAULT_SHOT_MIN_MS)
//   PUCK_HW_APP_TRACKING "strict" (default: any app change aborts the run,
//                       the strongest reset detector this device offers) or
//                       "follow" (for a trace that switches apps itself)
//   PUCK_HW_RESTORE_APP "0" to leave the board in whatever app the trace
//                       ended in instead of putting it back

import {
  openDirectBridge,
  openServerBridge,
  type Bridge,
} from "../../packs/rp2350-touch-amoled-18/tools/dev";
import {
  DEFAULT_SHOT_MIN_MS,
  DevlinkSession,
  type DevlinkOptions,
  type DevlinkTransport,
  type RawShot,
} from "./devlinkProtocol";
import type { CapturedFrame, HardwareLink, TraceEvent } from "../types";

// Re-exported so every existing importer keeps working after the protocol
// moved out from under it (harness/hardwarePacing.ts reads DEFAULT_SHOT_MIN_MS
// and RawShot; harness/diff.ts catches BoardResetError and
// ShotTruncatedError by name).
export { BoardResetError, ShotTruncatedError, DEFAULT_SHOT_MIN_MS, greyToRGB } from "./devlinkProtocol";
export type { RawShot } from "./devlinkProtocol";

export type DevlinkLinkOptions = DevlinkOptions;

export function optionsFromEnv(): DevlinkLinkOptions {
  const appIndex = Number(process.env.PUCK_HW_APP ?? "0");
  const minShotIntervalMs = Number(process.env.PUCK_HW_SHOT_MIN_MS ?? String(DEFAULT_SHOT_MIN_MS));
  return {
    appIndex: Number.isFinite(appIndex) ? appIndex : 0,
    minShotIntervalMs: Number.isFinite(minShotIntervalMs) ? minShotIntervalMs : DEFAULT_SHOT_MIN_MS,
    restoreApp: process.env.PUCK_HW_RESTORE_APP !== "0",
    appTracking: process.env.PUCK_HW_APP_TRACKING === "follow" ? "follow" : "strict",
  };
}

// The pack's Bridge is already line-in/line-out/close; this is the whole
// adapter, and it is three methods long on purpose. Anything longer here
// would be protocol leaking back out of devlinkProtocol.ts.
function transportOverBridge(bridge: Bridge, description: string): DevlinkTransport {
  return {
    description,
    readLine: () => bridge.lines.readLine(),
    send: (cmd: string) => bridge.send(cmd),
    close: () => bridge.close(),
  };
}

export class DevlinkLink implements HardwareLink {
  readonly opts: DevlinkLinkOptions;

  private bridge: Bridge | null = null;
  private session: DevlinkSession | null = null;
  private route: "server" | "direct" | null = null;

  constructor(opts: Partial<DevlinkLinkOptions> = {}) {
    this.opts = { ...optionsFromEnv(), ...opts };
  }

  get transport(): string {
    return this.route === "server"
      ? `the emulator dev server at ${process.env.DEVLINK_SERVER_URL ?? "http://127.0.0.1:5330"} (it owns the port)`
      : `${process.env.DEVLINK_PORT ?? "COM4"} directly (no dev server holding the port)`;
  }

  get panel(): { w: number; h: number } {
    return this.session?.panel ?? { w: 0, h: 0 };
  }

  /** Everything the run saw that says the board stopped being the same board. */
  get resetEvidence(): string[] {
    return this.session?.resetEvidence ?? [];
  }

  /** App changes observed at capture points, in order. Only populated in "follow" tracking. */
  get appTransitions(): string[] {
    return this.session?.appTransitions ?? [];
  }

  /** Every SHOT this run performed, for the pacing probe and the run summary. */
  get shots(): RawShot[] {
    return this.session?.shots ?? [];
  }

  async connect(): Promise<void> {
    const port = process.env.DEVLINK_PORT ?? "COM4";
    // Same arbitration as dev.ts's own openBridge(): the dev server first
    // (fast to rule out - an unreachable 127.0.0.1 port fails in
    // milliseconds under Bun), the port itself only if nothing else holds
    // it. Never the port first: that races the server for an exclusive
    // handle and loses for a reason unrelated to what is being tested.
    let bridge = await openServerBridge();
    if (bridge) {
      this.route = "server";
    } else {
      try {
        bridge = await openDirectBridge();
      } catch (err) {
        throw new Error(
          `no board: could not reach ${port}. The emulator dev server is not holding a port either, and opening it ` +
            `directly failed with: ${err instanceof Error ? err.message : String(err)}. ` +
            `Set DEVLINK_PORT if the board is on a different port, or DEVLINK_SERVER_URL if the dev server is elsewhere.`
        );
      }
      this.route = "direct";
    }
    this.bridge = bridge;
    this.session = new DevlinkSession(transportOverBridge(bridge, this.transport), this.opts);

    try {
      await this.session.handshake();
    } catch (err) {
      await this.closeBridge();
      const msg = err instanceof Error ? err.message : String(err);
      // Two genuinely different failures, kept apart because they send you
      // to different places. openDirectBridge() only waits 300ms to see
      // whether its PowerShell child survived, and PowerShell can take
      // longer than that just to start, so a port that does not exist (or
      // is held by something else) often gets past that check and shows up
      // here as a closed transport instead of an open failure.
      throw new Error(
        /transport closed|bridge closed the connection/.test(msg)
          ? `no board: the devlink bridge for ${port} closed before answering PING. The serial bridge process exited, ` +
            `which means the port does not exist or another process is holding it - its own stderr, relayed above, ` +
            `carries the OS's wording. Set DEVLINK_PORT if the board is elsewhere.`
          : `no board answered devlink on ${this.transport}: ${msg}. The port is open and nothing closed it, so something ` +
            `is there, but nothing spoke devlink within 3s - a board running non-devlink firmware, a board mid-reboot, ` +
            `or another client draining the replies.`
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.bridge) return;
    // Said out loud rather than only kept in a field: in "follow" mode
    // these transitions are the run's only account of which app each frame
    // was actually captured from.
    if (this.appTransitions.length > 0) {
      console.log(`  app changed during the run: ${this.appTransitions.join(", ")}`);
    }
    // Safety before release: PWR left injected-held powers the board off
    // after 5s, BOOT and an injected touch are both sticky. See
    // DevlinkSession.park().
    if (this.session) await this.session.park();
    await this.closeBridge();
  }

  async reset(): Promise<void> {
    await this.requireSession().reset();
  }

  async send(event: TraceEvent): Promise<void> {
    await this.requireSession().sendEvent(event);
  }

  async screenshot(): Promise<CapturedFrame> {
    return this.requireSession().screenshot();
  }

  /** The screenshot without the throw-on-truncation, for harness/hardwarePacing.ts. */
  async captureRaw(): Promise<RawShot> {
    return this.requireSession().captureRaw();
  }

  async readApp(): Promise<{ index: number; name: string }> {
    return this.requireSession().readApp();
  }

  private requireSession(): DevlinkSession {
    if (!this.session) throw new Error("devlink link used before connect()");
    return this.session;
  }

  private async closeBridge(): Promise<void> {
    const b = this.bridge;
    this.bridge = null;
    this.session = null;
    if (b) await b.close();
  }
}

// harness/diff.ts's --link contract: a default export taking no arguments.
export default function makeDevlinkLink(): HardwareLink {
  return new DevlinkLink();
}
