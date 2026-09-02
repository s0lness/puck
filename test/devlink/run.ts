#!/usr/bin/env bun
// Proves the devlink protocol core (harness/links/devlinkProtocol.ts) and
// the browser transport over it (harness/links/webSerialLink.ts), with no
// board plugged in anywhere.
//
//   bun run test:devlink
//
// WHY THIS EXISTS. harness/links/devlinkLink.ts was one file: a wire
// protocol welded to a spawned PowerShell process. The gallery's flash page
// now runs the same protocol against the board the visitor just flashed,
// from a browser, over Web Serial - so the protocol moved into a
// transport-agnostic core and the two transports became thin adapters over
// it. That refactor is only safe if the core is actually exercised, and
// only one of its two transports can ever run under `bun`.
//
// WHAT THIS PROVES, in order:
//   1. The two copies of decodeRLE()/isBase64Line() this repo is forced to
//      keep (see devlinkProtocol.ts's header: a pack may not import
//      emulator internals, and the emulator may not import a pack's
//      node-only serial code) still agree, on real payloads.
//   2. The trace-event -> command mapping is total, and refuses what it
//      cannot deliver rather than dropping it silently.
//   3. A whole replayHardware() run through the protocol against a scripted
//      board: the right commands go out, the frames come back, and
//      compareFrames() calls them a match at tolerance zero.
//   4. A board drawing something else is reported as a DIVERGENCE, not as
//      an error. A check that can only ever pass is worth nothing.
//   5. The same run over the browser transport, through a fake SerialPort
//      whose replies are chopped into 7-byte chunks: line framing, \r\n,
//      DTR, and the port given back.
//   6. TIMEOUT: a board that goes silent fails as a timeout naming the
//      transport, and the port comes back.
//   7. ERR: a board that refuses a command fails naming the command and the
//      reply, and the port comes back.
//   8. DISCONNECT MID-SHOT: a port that vanishes inside a multi-line SHOT
//      body fails as a closed transport, not as a corrupt image, and the
//      port comes back.
//   9. A reset seen on the shared port (the profiler's cumulative counter
//      going backwards) voids the run instead of reporting a divergence.
//
// Points 6, 7 and 8 all end with the same assertion, which is the one this
// file exists for: `port.closedCleanly`. A leaked serial port is invisible
// until the next person tries to open the board.
import { replayHardware } from "../../harness/hardwareSide";
import {
  BoardResetError,
  DevlinkClosedError,
  DevlinkSession,
  DevlinkTimeoutError,
  commandsForEvent,
  decodeBase64,
  decodeRLE,
  greyToRGB,
  isBase64Line,
  type DevlinkTransport,
} from "../../harness/links/devlinkProtocol";
import { WebSerialLink } from "../../harness/links/webSerialLink";
import { decodeRLE as packDecodeRLE, isBase64Line as packIsBase64Line } from "../../packs/rp2350-touch-amoled-18/tools/dev";
import { compareFrames } from "../../src/compare";
import type { CapturedFrame, HardwareLink, TraceEvent } from "../../harness/types";
import { ScriptedBoard, encodeBase64, encodeRLE, testScreen } from "./board";
import { FakeSerialPort, fakeSerial } from "./fakeSerial";

let failures = 0;

function ok(what: string): void {
  console.log(`  ok: ${what}`);
}

function bad(what: string, detail: string): void {
  failures++;
  console.error(`  FAIL: ${what}\n        ${detail}`);
}

function check(condition: boolean, what: string, detail: string): void {
  if (condition) ok(what);
  else bad(what, detail);
}

// A small panel, not a real one: nothing in this file may name a device's
// size (AGENTS.md), and a 24x16 board proves the same framing a 368x448 one
// does, in a millisecond instead of a second.
const W = 24;
const H = 16;
const SCREEN_A = testScreen(W, H, 252, 12, { x: 3, y: 2, w: 9, h: 6 });
const SCREEN_B = testScreen(W, H, 252, 12, { x: 4, y: 2, w: 9, h: 6 });

// What the emulator side of a real comparison would have produced for the
// same framebuffer: the SAME inverse the protocol applies to a SHOT byte,
// which is the whole reason a matching frame matches at tolerance 0.
const EXPECTED_A: CapturedFrame = greyToRGB(SCREEN_A, W, H);

// A trace exercising every event kind this link can actually deliver: a
// stroke (DOWN, MOVE, UP), both buttons, a long-press verdict, and the
// shake sensor. Ticks are anchors only and must never reach the board.
const TRACE: TraceEvent[] = [
  { t: 0, k: "tick" },
  { t: 10, k: "touch", down: 1, x: 5, y: 6 },
  { t: 20, k: "touch", down: 1, x: 7, y: 8 },
  { t: 30, k: "touch", down: 0, x: 7, y: 8 },
  { t: 40, k: "button", i: 0, down: 1 },
  { t: 50, k: "button", i: 0, down: 0 },
  { t: 60, k: "button", i: 1, down: 1 },
  { t: 70, k: "button", i: 1, down: 0 },
  { t: 70, k: "verdict", i: 1, long: 1 },
  { t: 80, k: "sensor", i: 0 },
  { t: 90, k: "tick" },
];
const EXPECTED_COMMANDS = [
  "DOWN 5 6",
  "MOVE 7 8",
  "UP",
  "BOOT DOWN",
  "BOOT UP",
  "KEY PRESS",
  "KEY RELEASE",
  "KEY LONG",
  "ERASE",
];

// ---------------------------------------------------------------------
// A HardwareLink over the protocol core with no transport of consequence:
// the same adapter shape devlinkLink.ts and webSerialLink.ts both are,
// minus the port. Lets points 3, 4 and 9 test the protocol on its own
// before the browser transport is added underneath it.
// ---------------------------------------------------------------------
class DirectBoardLink implements HardwareLink {
  readonly session: DevlinkSession;
  closed = false;

  constructor(private board: ScriptedBoard) {
    const queue: string[] = [];
    const waiters: ((line: string | null) => void)[] = [];
    let done = false;
    const push = (line: string) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    };
    const transport: DevlinkTransport = {
      description: "a scripted board (test/devlink/board.ts)",
      readLine: () => {
        if (queue.length > 0) return Promise.resolve(queue.shift()!);
        if (done) return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
      },
      send: async (cmd: string) => {
        const answer = this.board.handle(cmd);
        if (!answer) return;
        for (const line of answer.lines) push(line);
        if (answer.closeAfter) {
          done = true;
          while (waiters.length) waiters.shift()!(null);
        }
      },
      close: async () => {
        this.closed = true;
        done = true;
        while (waiters.length) waiters.shift()!(null);
      },
    };
    this.session = new DevlinkSession(transport, { minShotIntervalMs: 0 });
  }

  async connect(): Promise<void> {
    await this.session.handshake();
  }
  async disconnect(): Promise<void> {
    await this.session.park();
    this.closed = true;
  }
  async reset(): Promise<void> {
    await this.session.reset();
  }
  async send(event: TraceEvent): Promise<void> {
    await this.session.sendEvent(event);
  }
  async screenshot(): Promise<CapturedFrame> {
    return this.session.screenshot();
  }
}

// ---------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. The guarded duplication ------------------------------------------
  console.log("\n1. the two copies of the RLE/base64 helpers agree");
  {
    const rle = encodeRLE(SCREEN_A);
    const mine = decodeRLE(rle, W, H);
    const theirs = packDecodeRLE(rle, W, H);
    check(
      mine.length === theirs.length && mine.every((v, i) => v === theirs[i]),
      "decodeRLE agrees with packs/rp2350-touch-amoled-18/tools/dev.ts on a real payload",
      `harness ${mine.length} bytes, pack ${theirs.length} bytes, first difference at ${mine.findIndex((v, i) => v !== theirs[i])}`
    );
    check(
      mine.every((v, i) => v === SCREEN_A[i]),
      "decodeRLE round-trips the encoder byte for byte",
      "a decoded screen differs from the one that was encoded"
    );
    const b64 = encodeBase64(rle);
    const lines = [b64.slice(0, 76), b64.slice(76, 152), "prof app=chrono switch=15287us | loops=217088/s", "END"];
    const mineFlags = lines.map(isBase64Line).join(",");
    const theirsFlags = lines.map(packIsBase64Line).join(",");
    check(mineFlags === theirsFlags, "isBase64Line agrees with the pack's copy, payload and noise alike", `${mineFlags} vs ${theirsFlags}`);
    const bytes = decodeBase64(b64);
    check(
      bytes.length === rle.length && bytes.every((v, i) => v === rle[i]),
      "decodeBase64 round-trips the encoder (no Buffer, no atob: this code has to run in a browser)",
      `${bytes.length} bytes back from ${rle.length}`
    );
  }

  // 2. The event mapping is total ---------------------------------------
  console.log("\n2. the trace-event mapping is total, and refuses rather than drops");
  {
    check(commandsForEvent({ t: 0, k: "tick" }, false).commands.length === 0, "a tick maps to no command at all", "a tick reached the board");
    const opened = commandsForEvent({ t: 0, k: "touch", down: 1, x: 1, y: 2 }, false);
    const continued = commandsForEvent({ t: 0, k: "touch", down: 1, x: 3, y: 4 }, true);
    check(
      opened.commands[0] === "DOWN 1 2" && continued.commands[0] === "MOVE 3 4",
      "a stroke opens with DOWN and continues with MOVE",
      `${opened.commands[0]} then ${continued.commands[0]}`
    );
    for (const [label, event] of [
      ["a vector sensor reading", { t: 0, k: "vector", i: 0, x: 0, y: 0, z: 0 }],
      ["a raw accel sample", { t: 0, k: "accel", i: 0, ax: 0, ay: 0, az: 0 }],
      ["an unknown button index", { t: 0, k: "button", i: 7, down: 1 }],
    ] as [string, TraceEvent][]) {
      let threw = false;
      try {
        commandsForEvent(event, false);
      } catch {
        threw = true;
      }
      check(threw, `${label} throws rather than being silently dropped`, "it was accepted, so the two sides would replay different traces");
    }
  }

  // 3. A whole run, through the protocol --------------------------------
  console.log("\n3. a whole replay through the protocol against a scripted board");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A });
    const link = new DirectBoardLink(board);
    const result = await replayHardware(link, TRACE, [90]);
    check(result.frames.length === 1, "one capture point produced one frame", `got ${result.frames.length}`);
    const inputs = board.received.filter((c) => /^(DOWN|MOVE|UP|BOOT|KEY|ERASE)/.test(c));
    check(
      inputs.slice(0, EXPECTED_COMMANDS.length).join("|") === EXPECTED_COMMANDS.join("|"),
      "every trace event reached the board as the command it maps to, in order",
      `sent: ${inputs.join(", ")}`
    );
    // The tail is not noise: it is the politeness pass that has to run on
    // the way out of every run, successful or not. PWR left injected-held
    // powers this board off after 5 seconds and BOOT's injected level is
    // sticky, so a run that ends without these leaves the owner a board
    // behaving as if a button were welded down.
    check(
      inputs.slice(EXPECTED_COMMANDS.length).join("|") === "KEY RELEASE|BOOT UP",
      "the run parks the board's buttons on the way out",
      `tail: ${inputs.slice(EXPECTED_COMMANDS.length).join(", ")}`
    );
    check(!board.received.includes("TICK"), "no tick was ever sent to the board", "a synthetic clock tick reached real hardware");
    const diff = compareFrames(result.frames[0]!.frame, EXPECTED_A, 0);
    check(diff.match, "the captured frame matches the reference at tolerance zero", `${diff.diffPixels}/${diff.totalPixels} pixels differ`);
    check(link.closed, "the transport was closed on the happy path", "the port was left held after a successful run");
  }

  // 4. A divergence reads as a divergence --------------------------------
  console.log("\n4. a board drawing something else is a divergence, not an error");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_B });
    const link = new DirectBoardLink(board);
    const result = await replayHardware(link, TRACE, [90]);
    const diff = compareFrames(result.frames[0]!.frame, EXPECTED_A, 0);
    check(!diff.match && diff.diffPixels > 0, "the shifted box is reported as differing pixels", `match=${diff.match} diff=${diff.diffPixels}`);
    check(diff.firstDiffAt !== null, "the divergence names where it starts", "no first-difference coordinate was reported");
  }

  // 5. The browser transport, over a chunked byte stream -----------------
  console.log("\n5. the same run over Web Serial, replies chopped into 7-byte chunks");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A });
    const port = new FakeSerialPort(board);
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0, dataTerminalReady: true });
    const result = await replayHardware(link, TRACE, [90]);
    const diff = compareFrames(result.frames[0]!.frame, EXPECTED_A, 0);
    check(diff.match, "a frame reassembled from 7-byte chunks matches the reference exactly", `${diff.diffPixels} pixels differ`);
    check(
      port.signals?.dataTerminalReady === true && port.signals?.requestToSend === false,
      "DTR was asserted and RTS held low, as the RP2350's CDC stack needs",
      JSON.stringify(port.signals)
    );
    check(port.closedCleanly, "the port was closed after a successful run", `port log: ${port.log.join(" -> ")}`);
    check(
      port.log.includes("reader lock released") && port.log.includes("writer lock released"),
      "both stream locks were given back before the port was closed",
      `port log: ${port.log.join(" -> ")}`
    );
    check(port.log.indexOf("close") === port.log.length - 1, "close() was the last thing done to the port", `port log: ${port.log.join(" -> ")}`);
  }

  // 5b. The other board's signalling --------------------------------------
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A });
    const port = new FakeSerialPort(board, { usbVendorId: 0x303a, usbProductId: 0x1001 });
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0, dataTerminalReady: false });
    await link.connect();
    await link.disconnect();
    check(
      port.signals?.dataTerminalReady === false,
      "DTR is left deasserted when the caller asks, as the ESP32-S3's boot strap needs",
      JSON.stringify(port.signals)
    );
    check(port.closedCleanly, "the port was closed after a bare connect/disconnect", `port log: ${port.log.join(" -> ")}`);
  }

  // 6. Timeout ------------------------------------------------------------
  console.log("\n6. a board that goes silent");
  {
    // The handshake's PING and APP get through; the SWITCH that reset()
    // sends does not, which puts the silence inside the run rather than at
    // the door, where a bad transport would be the easier explanation.
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A, fault: { kind: "silent", afterCommands: 2 } });
    const port = new FakeSerialPort(board);
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0 });
    let err: unknown = null;
    try {
      await replayHardware(link, TRACE, [90]);
    } catch (e) {
      err = e;
    }
    check(err instanceof DevlinkTimeoutError, "a silent board fails as a timeout", `got ${err instanceof Error ? err.name : String(err)}`);
    check(
      err instanceof Error && /Web Serial/.test(err.message) && /within \d+ms/.test(err.message),
      "the timeout names the transport and the budget it blew",
      err instanceof Error ? err.message : String(err)
    );
    check(port.closedCleanly, "the port was released after a timeout", `port log: ${port.log.join(" -> ")}`);
  }

  // 7. ERR ----------------------------------------------------------------
  console.log("\n7. a board that refuses a command");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A, fault: { kind: "refuse", command: "SWITCH", reply: "ERR range" } });
    const port = new FakeSerialPort(board);
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0 });
    let err: unknown = null;
    try {
      await replayHardware(link, TRACE, [90]);
    } catch (e) {
      err = e;
    }
    check(
      err instanceof Error && /ERR range/.test(err.message) && /SWITCH/.test(err.message),
      "a refused SWITCH fails naming the command and the board's own reply",
      err instanceof Error ? err.message : String(err)
    );
    check(port.closedCleanly, "the port was released after a refusal", `port log: ${port.log.join(" -> ")}`);
  }
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A, fault: { kind: "refuse", command: "DOWN", reply: "ERR args" } });
    const port = new FakeSerialPort(board);
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0 });
    let err: unknown = null;
    try {
      await replayHardware(link, TRACE, [90]);
    } catch (e) {
      err = e;
    }
    check(
      err instanceof Error && /devlink refused "DOWN 5 6"/.test(err.message),
      "a refused input event fails naming the exact command line that was rejected",
      err instanceof Error ? err.message : String(err)
    );
    check(port.closedCleanly, "the port was released after a refused input event", `port log: ${port.log.join(" -> ")}`);
  }

  // 8. Disconnect mid-SHOT -------------------------------------------------
  console.log("\n8. the port vanishes inside a SHOT body");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A, fault: { kind: "vanish", afterBodyLines: 1 } });
    const port = new FakeSerialPort(board);
    const link = new WebSerialLink({ port: port as unknown as SerialPort, minShotIntervalMs: 0 });
    let err: unknown = null;
    try {
      await replayHardware(link, TRACE, [90]);
    } catch (e) {
      err = e;
    }
    check(
      err instanceof DevlinkClosedError,
      "a port that disappears mid-body fails as a closed transport, not as a corrupt image",
      `got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
    );
    check(
      err instanceof Error && /SHOT body/.test(err.message),
      "the error says what was being read when the port went away",
      err instanceof Error ? err.message : String(err)
    );
    check(port.closedCleanly, "the port was released after a mid-SHOT disconnect", `port log: ${port.log.join(" -> ")}`);
  }

  // 9. A reset voids the run ------------------------------------------------
  console.log("\n9. a reset seen on the shared port voids the run");
  {
    const board = new ScriptedBoard({ width: W, height: H, screen: SCREEN_A, profilerEvery: 1 });
    const link = new DirectBoardLink(board);
    await link.connect();
    await link.reset();
    // The board reboots: its cumulative uptime counter restarts, which is
    // the reading that costs nothing to take because it shares the port
    // with every reply this run is already reading past.
    board.uptime = 3;
    let err: unknown = null;
    try {
      await link.screenshot();
      await link.screenshot();
    } catch (e) {
      err = e;
    }
    check(
      err instanceof BoardResetError,
      "a cumulative counter going backwards aborts the run instead of reporting a divergence",
      `got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
    );
    check(
      err instanceof Error && /uptime/.test(err.message) && /rebooted/.test(err.message),
      "the abort says which counter moved and what that means",
      err instanceof Error ? err.message : String(err)
    );
    await link.disconnect();
  }

  console.log("");
  if (failures > 0) {
    console.error(`FAIL: ${failures} devlink check(s) failed.`);
    process.exit(1);
  }
  console.log("OK: devlink protocol and its browser transport verified, with no board.");
}

await main();
