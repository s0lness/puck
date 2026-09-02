// The devlink wire protocol, with no transport under it.
//
// This is the half of harness/links/devlinkLink.ts that was never about a
// serial port: the reply shapes, the SHOT read loop and its RLE decoder,
// the greyscale-to-RGB inverse of the panel's own packing, the trace-event
// to command mapping, the pacing, and the reset detection that decides a
// run is void rather than divergent. All of it was written against "read a
// line, write a line, close" and none of it needed to know that those lines
// arrived through a spawned PowerShell process.
//
// It got factored out the day a SECOND transport appeared: the gallery's
// own flash page, which flashes a board over WebUSB or Web Serial and then
// wants to run the app's own trace on it and diff the frames, in the
// browser, with no bun and no dev server anywhere (harness/links/
// webSerialLink.ts). Two copies of a wire protocol agree exactly once, on
// the day the second one is written (docs/decisions/0002), and this one
// already carries three separate lessons that cost a day or a reboot each
// (see devlinkLink.ts's own header). So the protocol lives here, once, and
// each transport is a thin DevlinkTransport implementation over it.
//
// WHAT THIS FILE MAY NOT DO. It is pure TypeScript: no node:*, no Bun.*, no
// DOM, no import from any pack. That is not tidiness, it is the requirement
// that makes it work at all - it is bundled into a browser page by
// site/build.ts, and a single `node:fs` anywhere in its import graph would
// end that. The transports carry every platform dependency: devlinkLink.ts
// owns the PowerShell bridge and the dev server's socket, webSerialLink.ts
// owns navigator.serial.
//
// WHERE THIS SITS RELATIVE TO AGENTS.md's "nothing names one device". It
// sits in harness/links/, the one place that rule names as the seam where a
// device-specific adapter is allowed to live ("The device-specific
// harness/links/devlinkLink.ts adapter may import the pack's public USB
// tooling, but shared emulator and harness logic must not"). The button
// index mapping below (0 = BOOT, 1 = PWR) is that adapter's own knowledge
// and always was; moving it one file sideways neither adds nor removes any.
// Nothing in src/, server.ts, or the rest of harness/ imports this.
//
// ONE DUPLICATION, DELIBERATE AND GUARDED. decodeRLE() and isBase64Line()
// below also exist in packs/rp2350-touch-amoled-18/tools/dev.ts, and this
// file cannot import them from there: that module opens serial ports with
// node:os/node:path and Bun.spawn, so importing it would make this file
// unbundleable for a browser, which is the entire reason it exists. Nor can
// the pack import them from here - docs/convention/device-pack.md's
// self-containment rule runs exactly one way ("Nothing inside a pack
// imports emulator internals"). So the two copies stand, and
// test/devlink/run.ts asserts they agree, on the same inputs, every run. A
// guard, not a promise.

import type { CapturedFrame, TraceEvent } from "../types";

// ---------------------------------------------------------------------
// The seam: what a transport owes this protocol
// ---------------------------------------------------------------------

// Line in, line out, and a close that actually releases whatever the
// transport holds. Deliberately the same shape the pack's own CLI bridge
// already had (packs/rp2350-touch-amoled-18/tools/dev.ts's Bridge), so
// wrapping one costs a three-line object literal rather than an adapter.
export interface DevlinkTransport {
  // The next complete line, without its terminator, or null once the
  // transport is done. Null is not an error here: it is what the protocol
  // reads as "the board (or the bridge, or the port) went away", and every
  // read below turns it into a DevlinkClosedError naming what was being
  // waited for at the time.
  readLine(): Promise<string | null>;
  // Writes one command line. The transport appends the terminator.
  send(cmd: string): Promise<void>;
  // Releases the port/socket/process. Must be safe to call twice.
  close(): Promise<void>;
  // Named in every error message this file produces, because "no SHOT
  // header within 8000ms" is not actionable and "...on COM4 directly" is.
  readonly description: string;
}

// ---------------------------------------------------------------------
// Errors: four shapes, because they send a reader to four places
// ---------------------------------------------------------------------

/** The board is not the same device it was a moment ago. The run is void, not divergent. */
export class BoardResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardResetError";
  }
}

/** A SHOT reply ended short of the byte count its own header promised. */
export class ShotTruncatedError extends Error {
  readonly headerBytes: number;
  readonly decodedBytes: number;
  constructor(headerBytes: number, decodedBytes: number) {
    super(
      `SHOT truncated: header promised ${headerBytes} RLE bytes, ${decodedBytes} arrived. The firmware caps one reply at ` +
        `DEVLINK_SHOT_BUDGET_US (750ms) and drops the rest of the body rather than starving the watchdog, so this means the ` +
        `screen being captured does not RLE-compress small enough to leave the board inside that budget at this baud rate. ` +
        `See docs/harness.md's pacing section.`
    );
    this.name = "ShotTruncatedError";
    this.headerBytes = headerBytes;
    this.decodedBytes = decodedBytes;
  }
}

/** Nothing of the expected shape arrived in time. The transport is open; the board is not answering. */
export class DevlinkTimeoutError extends Error {
  constructor(what: string, timeoutMs: number, where: string) {
    super(`no ${what} within ${timeoutMs}ms on ${where}`);
    this.name = "DevlinkTimeoutError";
  }
}

/** The transport ended mid-exchange: the port closed, the bridge died, the board was unplugged. */
export class DevlinkClosedError extends Error {
  constructor(what: string, where: string) {
    super(
      `the devlink transport closed while waiting for ${what} on ${where}. The port was released under the run ` +
        `(board unplugged, bridge process exited, or something else took the port), so nothing captured after this ` +
        `point exists to compare.`
    );
    this.name = "DevlinkClosedError";
  }
}

// ---------------------------------------------------------------------
// Pure protocol helpers
// ---------------------------------------------------------------------

// A devlink SHOT reply body line is a run of complete base64 4-char groups:
// the firmware only ever wraps a line on a group boundary (DEVLINK_B64_WRAP
// is 76, a multiple of 4), so a real payload line's length is always a
// positive multiple of 4 and every character is in the base64 alphabet,
// with '=' padding possible only in the last 1-2 characters of the very
// last line. A profiler tick or any other debug print landing between two
// payload lines will almost certainly contain a space, a pipe, or an '='
// sign outside that trailing position, and will fail this check, so it is
// safe to treat "not valid base64 shape" as "noise, skip it" rather than
// "corrupted transfer".
const BASE64_LINE_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64Line(line: string): boolean {
  return line.length > 0 && line.length % 4 === 0 && BASE64_LINE_RE.test(line);
}

// The framebuffer is walked row-major, each run emitted as two bytes,
// (value, count), count in 1..255. There is no end-of-stream marker inside
// the RLE bytes; the byte count in the SHOT header is what says when to
// stop. See packs/rp2350-touch-amoled-18/tools/README-devlink.md's "SHOT".
export function decodeRLE(rle: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  let o = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const value = rle[i]!;
    const count = rle[i + 1]!;
    for (let k = 0; k < count && o < out.length; k++) out[o++] = value;
  }
  if (o !== out.length) {
    throw new Error(`RLE decoded ${o} pixels, expected ${w * h} (${w}x${h}); payload is corrupt or truncated`);
  }
  return out;
}

// base64 -> bytes without Buffer (which does not exist in a browser) and
// without atob (which is DOM-only, and this file must not touch the DOM).
// Small enough to just write, and it is the one place where a wrong table
// would corrupt every frame silently rather than loudly.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function decodeBase64(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* '=' */) end--;
  const out = new Uint8Array(Math.floor((end * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? B64_REVERSE[code]! : -1;
    if (v < 0) throw new Error(`base64 payload contains a character outside the alphabet at offset ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

// The exact inverse of the panel's own packing, not a naive byte-to-grey
// expansion, so a neutral pixel decodes to EXACTLY the RGB triple the
// emulator side produces for the same framebuffer word and a matching frame
// matches at tolerance 0.
//
// The board stores RGB565 (byte-swapped for the panel DMA). gfx.h's
// gray_to_px(g) writes r5 = g>>3, g6 = g>>2, b5 = g>>3, and SHOT sends
// px_to_gray(px) = g6<<2, i.e. one byte carrying the six bits of green.
// src/panel.ts's rgb565be reader expands those stored fields back with bit
// replication: r8 = (r5<<3)|(r5>>2), g8 = (g6<<2)|(g6>>4). So from the SHOT
// byte alone, both fields are recoverable exactly: g6 is byte>>2, and r5/b5
// are byte>>3.
//
// WHAT THIS CANNOT RECOVER, stated here rather than discovered as a mystery
// diff: colour. SHOT's wire format is one greyscale byte per pixel because
// this panel is used as monochrome, so a coloured pixel arrives as its
// green channel and comes back out of this function as a grey. Against an
// emulator frame that kept the colour, that is a real divergence in the
// DIFF and not one in the FIRMWARE. Do not point this harness at a coloured
// screen and believe the number.
export function greyToRGB(grey: Uint8Array, width: number, height: number): CapturedFrame {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const v = grey[i]!;
    const g6 = v >> 2;
    const c5 = v >> 3;
    const g8 = (g6 << 2) | (g6 >> 4);
    const rb8 = (c5 << 3) | (c5 >> 2);
    rgb[p] = rb8;
    rgb[p + 1] = g8;
    rgb[p + 2] = rb8;
  }
  return { width, height, rgb };
}

// The trace-event -> devlink mapping, in one place and total: an event this
// protocol cannot deliver throws instead of being quietly skipped. A
// silently dropped input would make the hardware side replay a DIFFERENT
// trace from the emulator side and then report the resulting mismatch as a
// firmware divergence, which is the shape of instrument failure
// packs/rp2350-touch-amoled-18/docs/decisions/0004 is about.
//
// Button indices are the ones emu_shim.c declares and firmware/runtime
// agrees with: 0 = BOOT, 1 = PWR. Sensor 0 is "shake", the only sensor
// emu_device() declares. `fingerDown` is threaded through rather than read
// off a field so this stays a pure function: DOWN opens a stroke, MOVE
// continues one, and the caller owns the state that tells them apart.
export function commandsForEvent(event: TraceEvent, fingerDown: boolean): { commands: string[]; fingerDown: boolean } {
  switch (event.k) {
    case "touch": {
      if (event.down) {
        return { commands: [fingerDown ? `MOVE ${event.x} ${event.y}` : `DOWN ${event.x} ${event.y}`], fingerDown: true };
      }
      return { commands: ["UP"], fingerDown: false };
    }
    case "button":
      if (event.i === 0) return { commands: [event.down ? "BOOT DOWN" : "BOOT UP"], fingerDown };
      if (event.i === 1) return { commands: [event.down ? "KEY PRESS" : "KEY RELEASE"], fingerDown };
      throw new Error(`no devlink command for button index ${event.i} (this device declares 0 = BOOT, 1 = PWR)`);
    case "verdict":
      if (event.i === 1) return { commands: [event.long ? "KEY LONG" : "KEY SHORT"], fingerDown };
      throw new Error(
        `no devlink command for a press verdict on button index ${event.i} (only PWR, index 1, declares longPressMs)`
      );
    case "sensor":
      if (event.i === 0) return { commands: ["ERASE"], fingerDown };
      throw new Error(`no devlink command for sensor index ${event.i} (this device declares exactly one, 0 = shake)`);
    case "vector":
      // No devlink command exists to inject a continuous vector sensor
      // reading onto real hardware (see apps/fluidbox/ports/
      // rp2350-touch-amoled-18/README.md's "The missing ABI call"). Per
      // this function's own header comment, an event this protocol cannot
      // deliver throws rather than being silently dropped.
      throw new Error(`no devlink command for a vector sensor event (index ${event.i}): real-hardware tilt injection is not wired`);
    case "accel":
      // Same policy as "vector", just above, and for the same reason.
      throw new Error(`no devlink command for a raw accel sample (index ${event.i}): real-hardware accel injection is not wired`);
    case "tick":
      // Never sent: emu_tick(nowMs) is the emulator's synthetic clock and
      // has no hardware equivalent. harness/hardwareSide.ts already filters
      // these out; this arm exists so the switch is total.
      return { commands: [], fingerDown };
  }
}

// The shared port's profiler line, from whichever board is on the other end.
//
// THIS USED TO REQUIRE THE RP2350'S EXACT FIELD LIST and therefore silently
// stopped detecting resets the moment a second board spoke devlink. The
// ESP32-S3 pack has no second core to restart, so it prints `uptime=`
// instead of `core1restarts=`; under the old regex its profiler line
// matched nothing at all, which is not "no evidence" but "the evidence was
// thrown away". So the app name is the only required field now, and every
// cumulative counter is optional and checked only when BOTH readings carry
// it.
const PROF_APP_RE = /^prof app=(\S+)\b/;

// Counters that only ever climb while a board stays up, so any of them
// going backwards is a reboot seen for free. `uptime` is the strongest of
// the three (it moves on every reset, not only on a core dying) and is what
// the ESP32-S3 pack reports.
const PROF_CUMULATIVE: Record<string, RegExp> = {
  core1restarts: /\bcore1restarts=(\d+)\b/,
  "shot drops": /\bshot drops=(\d+)\b/,
  uptime: /\buptime=(\d+)\b/,
};

export interface ProfReading {
  app: string;
  counters: Record<string, number>;
}

export function parseProf(line: string): ProfReading | null {
  const m = PROF_APP_RE.exec(line);
  if (!m) return null;
  const counters: Record<string, number> = {};
  for (const [name, re] of Object.entries(PROF_CUMULATIVE)) {
    const f = re.exec(line);
    if (f) counters[name] = Number(f[1]);
  }
  return { app: m[1]!, counters };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------
// Options and observations
// ---------------------------------------------------------------------

// Measured, not guessed: 60 consecutive screenshots at a ZERO gap, across
// two different screens, produced no truncation, no watchdog reboot and no
// app change (harness/hardwarePacing.ts, numbers in docs/harness.md). This
// ships at 250ms anyway, as margin on somebody else's board, and because a
// single shot already costs 280-600ms so the margin barely shows in a run.
export const DEFAULT_SHOT_MIN_MS = 250;

export interface DevlinkOptions {
  // Which g_apps[] index to put the board into before replay starts. The
  // emulator side always starts from emu_init(), which is rtcore_init(),
  // which enters app 0 - so 0 is the only value that makes the two sides
  // start alike unless your trace switches apps itself.
  appIndex: number;
  // Minimum wall-clock gap between the END of one screenshot and the start
  // of the next. See docs/harness.md for what was measured.
  minShotIntervalMs: number;
  // Put the board back in whatever app it was running when we connected.
  // Politeness, not correctness: the owner uses this board.
  restoreApp: boolean;
  // How to read "the app changed under us".
  //
  //   "strict" - the board must stay in the app reset() put it in, and any
  //     change aborts the run. This is the strongest reset detector this
  //     device offers (a reset re-enters app 0 with a zeroed arena) and it
  //     is the default.
  //   "follow" - for a trace that drives an app switch itself. Transitions
  //     are recorded and printed rather than treated as failures. Reset
  //     detection is genuinely WEAKER here and the docs say so.
  appTracking: "strict" | "follow";
}

export const DEVLINK_DEFAULTS: DevlinkOptions = {
  appIndex: 0,
  minShotIntervalMs: DEFAULT_SHOT_MIN_MS,
  restoreApp: true,
  appTracking: "strict",
};

export interface RawShot {
  width: number;
  height: number;
  headerBytes: number;
  decodedBytes: number;
  truncated: boolean;
  // One byte per pixel, row-major: the panel's own 6-bit green channel
  // shifted up by two. null when the payload was truncated.
  grey: Uint8Array | null;
  // Wall-clock cost of the whole exchange, command written to END read.
  ms: number;
}

// ---------------------------------------------------------------------
// The session: everything devlinkLink.ts used to be, minus the port
// ---------------------------------------------------------------------

export class DevlinkSession {
  readonly opts: DevlinkOptions;
  private readonly transport: DevlinkTransport;

  private panelW = 0;
  private panelH = 0;
  private appOnConnect: { index: number; name: string } | null = null;
  private expectedApp: { index: number; name: string } | null = null;
  private fingerDown = false;
  private lastShotEndedAt = 0;
  private lastProf: ProfReading | null = null;

  // Everything this session noticed that says the board is not the same
  // device it was a moment ago. Non-empty means the run is void, not
  // divergent.
  readonly resetEvidence: string[] = [];
  // Every app change observed at a capture point, in order. Only ever
  // populated in "follow" tracking mode; in "strict" mode the first one
  // aborts the run instead.
  readonly appTransitions: string[] = [];
  // Bookkeeping the pacing probe and the run summary read back.
  readonly shots: RawShot[] = [];

  constructor(transport: DevlinkTransport, opts: Partial<DevlinkOptions> = {}) {
    this.transport = transport;
    this.opts = { ...DEVLINK_DEFAULTS, ...opts };
  }

  get panel(): { w: number; h: number } {
    return { w: this.panelW, h: this.panelH };
  }

  get where(): string {
    return this.transport.description;
  }

  get appAtHandshake(): { index: number; name: string } | null {
    return this.appOnConnect;
  }

  // PING before anything else: it is the one command that proves the
  // transport works AND tells us the panel geometry to decode SHOT against.
  // A bounded failure here, with the transport named, is the difference
  // between "no board" and a hang.
  async handshake(): Promise<void> {
    const ping = await this.expect(/^(OK devlink \d+ \d+ \d+|ERR .*)$/, 3000, "PING reply", "PING");
    const m = /^OK devlink (\d+) (\d+) (\d+)$/.exec(ping);
    if (!m) throw new Error(`devlink refused PING: ${ping}`);
    this.panelW = Number(m[2]);
    this.panelH = Number(m[3]);
    this.appOnConnect = await this.readApp();
    this.expectedApp = this.appOnConnect;
  }

  // Establishes a known starting point, which is the whole reason
  // HardwareLink has a reset(): the emulator always starts from emu_init(),
  // and the board starts from wherever the last person left it.
  //
  // SWITCH is the lever, because on this device a switch is not just a
  // change of screen: runtime_core.c's do_switch() rewinds the app arena and
  // app_alloc() zeroes every byte it hands back out, and the runtime clears
  // the framebuffer on the way in. So "SWITCH to app 0" reproduces, on
  // hardware, very nearly what emu_init() does on the emulator side.
  //
  // "Very nearly" is doing real work in that sentence, and the gap is
  // stated in docs/harness.md rather than papered over: a switch does not
  // re-run gfx_init(), does not restart core1, does not reset the board's
  // uptime clock, and does not undo any peripheral state the previous app
  // left behind.
  async reset(): Promise<void> {
    const target = this.opts.appIndex;
    await this.expect(/^(OK|ERR .*)$/, 3000, "SWITCH reply", `SWITCH ${target}`, (line) => {
      if (line.startsWith("ERR")) {
        throw new Error(
          `SWITCH ${target} was refused (${line}). Valid indices are g_apps[] positions on the RUNNING firmware.`
        );
      }
    });

    // The switch is applied at the end of the current frame, so APP can
    // still report the old app for a frame or two. Poll rather than sleep a
    // guessed amount.
    const deadline = Date.now() + 2000;
    for (;;) {
      const app = await this.readApp();
      if (app.index === target) {
        this.expectedApp = app;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`the board did not enter app ${target} within 2s (still reporting ${app.index} ${app.name})`);
      }
      await sleep(50);
    }
    // One full-panel push costs about 12ms (gfx.h); this is slack on top of
    // it so the first capture cannot race the switch's own repaint.
    await sleep(200);
  }

  async sendEvent(event: TraceEvent): Promise<void> {
    const mapped = commandsForEvent(event, this.fingerDown);
    this.fingerDown = mapped.fingerDown;
    for (const cmd of mapped.commands) {
      await this.expect(/^(OK|ERR .*)$/, 3000, `${cmd.split(" ")[0]} reply`, cmd, (line) => {
        if (line.startsWith("ERR")) throw new Error(`devlink refused "${cmd}": ${line}`);
      });
    }
  }

  async screenshot(): Promise<CapturedFrame> {
    const raw = await this.captureRaw();
    if (!raw.grey) throw new ShotTruncatedError(raw.headerBytes, raw.decodedBytes);
    await this.assertStillTheSameBoard();
    return greyToRGB(raw.grey, raw.width, raw.height);
  }

  // The screenshot, without the throw-on-truncation and without the reset
  // check, so harness/hardwarePacing.ts can measure what a shot costs and
  // how often it truncates without the measurement aborting on the first
  // bad one.
  async captureRaw(): Promise<RawShot> {
    const wait = this.lastShotEndedAt + this.opts.minShotIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);

    const started = Date.now();
    const header = await this.expect(/^(SHOT \d+ \d+ \d+|ERR .*)$/, 8000, "SHOT header", "SHOT");
    const m = /^SHOT (\d+) (\d+) (\d+)$/.exec(header);
    if (!m) throw new Error(`devlink refused SHOT: ${header}`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    const headerBytes = Number(m[3]);

    let b64 = "";
    for (;;) {
      const line = await this.readLine(8000, "SHOT body");
      if (line === "END") break;
      if (!isBase64Line(line)) {
        this.observeNoise(line);
        continue;
      }
      b64 += line;
    }
    const rle = decodeBase64(b64);
    const ms = Date.now() - started;
    this.lastShotEndedAt = Date.now();

    const truncated = rle.length !== headerBytes;
    let grey: Uint8Array | null = null;
    if (!truncated) {
      try {
        grey = decodeRLE(rle, width, height);
      } catch {
        grey = null;
      }
    }
    const shot: RawShot = { width, height, headerBytes, decodedBytes: rle.length, truncated: grey === null, grey, ms };
    this.shots.push(shot);
    return shot;
  }

  async readApp(): Promise<{ index: number; name: string }> {
    const reply = await this.expect(/^(APP -?\d+ \S+|ERR .*)$/, 3000, "APP reply", "APP");
    const m = /^APP (-?\d+) (\S+)$/.exec(reply);
    if (!m) throw new Error(`devlink refused APP: ${reply}`);
    return { index: Number(m[1]), name: m[2]! };
  }

  // The politeness pass, run before the transport is released and BEFORE
  // anything that can throw: an aborted run must not leave PWR
  // injected-held (runtime_core.c powers the board off after 5s of it),
  // BOOT injected-held (sensors.c's injected level is sticky), or a finger
  // glued to the glass (an injected touch is as sticky as an injected
  // button, and a run that dies partway through a stroke never sends UP).
  //
  // Every command here is best effort: the interesting error at this point
  // is whatever already went wrong, not this one.
  async park(): Promise<void> {
    await this.tryCommand("KEY RELEASE");
    await this.tryCommand("BOOT UP");
    if (this.fingerDown) {
      await this.tryCommand("UP");
      this.fingerDown = false;
    }
    if (this.opts.restoreApp && this.appOnConnect && this.expectedApp && this.appOnConnect.index !== this.expectedApp.index) {
      if (this.appOnConnect.index >= 0) await this.tryCommand(`SWITCH ${this.appOnConnect.index}`);
    }
  }

  // ---- reset detection -------------------------------------------------
  //
  // Two independent readings, both over devlink, because the run has to be
  // able to say "this comparison is void" rather than diff against a board
  // that rebooted into a different app halfway through.
  //
  //   1. WHICH APP IS RUNNING. A reset re-enters g_apps[0] with a zeroed
  //      arena. If the board is not in the app this session put it in, it
  //      is not the same session any more.
  //   2. THE PROFILER'S CUMULATIVE COUNTERS GOING BACKWARDS. Seen for free:
  //      these lines share the port and this session already reads past
  //      them on its way to every reply.
  private observeNoise(line: string): void {
    const prof = parseProf(line);
    if (!prof) return;
    const prev = this.lastProf;
    if (prev) {
      for (const [name, value] of Object.entries(prof.counters)) {
        const before = prev.counters[name];
        if (before === undefined) continue;
        if (value < before) {
          this.resetEvidence.push(
            `the profiler's cumulative "${name}" went backwards (${before} -> ${value}): the board rebooted`
          );
        }
        if (name === "shot drops" && value > before) {
          this.resetEvidence.push(
            `the firmware dropped a SHOT body (shot drops ${before} -> ${value}): a screenshot ran past the firmware's ` +
              `own reply budget, so screenshots are being asked for faster or on a busier screen than this board can serve`
          );
        }
      }
    }
    if (this.opts.appTracking === "strict" && this.expectedApp && prof.app !== this.expectedApp.name) {
      this.resetEvidence.push(
        `the profiler reports app=${prof.app} while this run put the board in "${this.expectedApp.name}": ` +
          `the board reset (a reset re-enters app 0) or something else switched apps under the run`
      );
    }
    this.lastProf = prof;
  }

  private async assertStillTheSameBoard(): Promise<void> {
    const app = await this.readApp();
    const was = this.expectedApp;
    const changed = was !== null && (app.index !== was.index || app.name !== was.name);
    if (changed && this.opts.appTracking === "follow") {
      this.appTransitions.push(`${was.index} "${was.name}" -> ${app.index} "${app.name}"`);
      this.expectedApp = app;
      return;
    }
    if (changed) {
      throw new BoardResetError(
        `the board is now running app ${app.index} "${app.name}", but this run put it in ${was.index} ` +
          `"${was.name}". A reset re-enters app 0 with a zeroed arena, so every frame from here on would be a ` +
          `comparison against a different device state. Aborting instead of reporting a divergence.`
      );
    }
    if (this.resetEvidence.length > 0) {
      throw new BoardResetError(`the board did not stay put during this run:\n  - ${this.resetEvidence.join("\n  - ")}`);
    }
  }

  // ---- plumbing --------------------------------------------------------

  // One read, bounded, with a closed transport told apart from a silent
  // one: those are different failures and they send a reader to different
  // places (see DevlinkClosedError vs DevlinkTimeoutError).
  private async readLine(timeoutMs: number, what: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DevlinkTimeoutError(what, timeoutMs, this.where)), timeoutMs);
    });
    try {
      const line = await Promise.race([this.transport.readLine(), timeout]);
      if (line === null) throw new DevlinkClosedError(what, this.where);
      return line;
    } finally {
      clearTimeout(timer);
    }
  }

  // Sends a command (optionally) and reads until a line matching `shape`
  // arrives, feeding everything else to observeNoise(). This is the pack
  // CLI's expectLine() with one addition: the noise is looked at rather
  // than only discarded, because on this port the noise is the profiler
  // line, and the profiler line is what says whether the board is still the
  // same board.
  private async expect(
    shape: RegExp,
    timeoutMs: number,
    what: string,
    cmd?: string,
    onReply?: (line: string) => void
  ): Promise<string> {
    if (cmd) await this.transport.send(cmd);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DevlinkTimeoutError(what, timeoutMs, this.where);
      const line = await this.readLine(remaining, what);
      if (shape.test(line)) {
        onReply?.(line);
        return line;
      }
      this.observeNoise(line);
    }
  }

  private async tryCommand(cmd: string): Promise<void> {
    try {
      await this.expect(/^(OK|ERR .*)$/, 2000, `${cmd} reply`, cmd);
    } catch {
      // Best effort: this runs on the way out, where the interesting error
      // is whatever already went wrong, not this one.
    }
  }
}
