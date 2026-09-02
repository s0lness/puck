// A scripted devlink board: answers the wire protocol the way the real
// firmware does, including the noise that shares its port, and can be told
// to fail in the three ways a real one actually fails.
//
// This is a FAKE, in the same sense harness/fixtures/loopbackLink.ts is a
// fake, and the same caveat applies: it proves what the HOST does with a
// board's answers, never what a board does. What it can prove is everything
// the host side owns - the reply shapes, the line framing across arbitrary
// byte-chunk boundaries, the RLE decode, the noise skipping, the reset
// detection, and above all that every exit path gives the port back, which
// is the one property no bench run would reliably show (a leaked port looks
// like "worked fine" until the next person tries to open it).
//
// The three failure modes are the three that have actually happened on this
// project's own bench, which is why they are the three the tests demand:
//   silent   - the board stops answering (mid-reboot, wrong firmware, or
//              another client draining the replies)
//   refuse   - the board answers ERR (a SWITCH past the end of g_apps[])
//   vanish   - the port disappears mid-SHOT (unplugged, or something else
//              took it), which is the ugliest one because it lands inside a
//              multi-line body rather than at a reply boundary

export type BoardFault =
  | { kind: "none" }
  // Stop answering entirely once `afterCommands` commands have been served.
  | { kind: "silent"; afterCommands: number }
  // Answer `reply` (an ERR line) to the first command whose first word is `command`.
  | { kind: "refuse"; command: string; reply: string }
  // Close the port partway through the SHOT body, after `afterBodyLines` payload lines.
  | { kind: "vanish"; afterBodyLines: number };

export interface ScriptedBoardOptions {
  width: number;
  height: number;
  /** Grey bytes, one per pixel, row-major. What SHOT reports. Replaceable mid-run. */
  screen: Uint8Array;
  /** g_apps[] index and name the board reports. */
  app?: { index: number; name: string };
  fault?: BoardFault;
  /** Emitted before the reply to every Nth command, as the real profiler line does. Set 0 to silence it. */
  profilerEvery?: number;
  /**
   * What PUSHSTATS answers, when set: `{pushes, pixels}`. Left undefined by
   * default, which falls through to the same `ERR unknown PUSHSTATS` any
   * unrecognised command gets - exactly what a build that never wires
   * devlink_hooks_t.push_stats_get answers (tools/README-devlink.md), and
   * what the esp32-s3 pack's own devlink.c answers too, since it never
   * declares this command at all.
   */
  pushStats?: { pushes: number; pixels: number };
}

// (value, count) pairs, count in 1..255, row-major. The exact encoder
// packs/rp2350-touch-amoled-18/firmware/devlink.c writes, so decodeRLE's
// contract is exercised against real runs and not against a shape invented
// to suit it.
export function encodeRLE(grey: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < grey.length) {
    const value = grey[i]!;
    let count = 1;
    while (i + count < grey.length && grey[i + count] === value && count < 255) count++;
    out.push(value, count);
    i += count;
  }
  return new Uint8Array(out);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

// DEVLINK_B64_WRAP, restated: the firmware wraps on a group boundary, which
// is what makes isBase64Line()'s "length is a positive multiple of 4" test
// safe in the first place.
const B64_WRAP = 76;

export class ScriptedBoard {
  readonly width: number;
  readonly height: number;
  screen: Uint8Array;
  app: { index: number; name: string };
  fault: BoardFault;
  /** Settable mid-run, same as `screen`: a test can flip support on or off between commands. */
  pushStats?: { pushes: number; pixels: number };
  private profilerEvery: number;

  /** Every command line the host sent, in order. The trace-event mapping's own proof. */
  readonly received: string[] = [];
  /** Cumulative counters the profiler line carries, and the reset detector reads. */
  uptime = 1000;
  shotDrops = 0;

  private commandsServed = 0;
  private vanished = false;

  constructor(opts: ScriptedBoardOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.screen = opts.screen;
    this.app = opts.app ?? { index: 0, name: "chrono" };
    this.fault = opts.fault ?? { kind: "none" };
    this.pushStats = opts.pushStats;
    this.profilerEvery = opts.profilerEvery ?? 3;
  }

  private profilerLine(): string {
    return `prof app=${this.app.name} switch=15287us | loops=217088/s | shot drops=${this.shotDrops} | uptime=${this.uptime}`;
  }

  /**
   * Answers one command. Returns the reply lines (each without a terminator),
   * or null when the transport should be torn down instead of answered
   * (the "vanish" fault, delivered as a closed port rather than a line).
   */
  handle(cmd: string): { lines: string[]; closeAfter: boolean } | null {
    if (this.vanished) return null;
    this.received.push(cmd);
    this.commandsServed++;
    this.uptime += 7;

    if (this.fault.kind === "silent" && this.commandsServed > this.fault.afterCommands) {
      return { lines: [], closeAfter: false };
    }

    const out: string[] = [];
    if (this.profilerEvery > 0 && this.commandsServed % this.profilerEvery === 0) out.push(this.profilerLine());

    const word = cmd.split(/\s+/)[0]!.toUpperCase();
    if (this.fault.kind === "refuse" && word === this.fault.command.toUpperCase()) {
      out.push(this.fault.reply);
      return { lines: out, closeAfter: false };
    }

    switch (word) {
      case "PING":
        out.push(`OK devlink 1 ${this.width} ${this.height}`);
        return { lines: out, closeAfter: false };
      case "APP":
        out.push(`APP ${this.app.index} ${this.app.name}`);
        return { lines: out, closeAfter: false };
      case "SWITCH": {
        const index = Number(cmd.split(/\s+/)[1]);
        if (!Number.isFinite(index)) {
          out.push("ERR args");
          return { lines: out, closeAfter: false };
        }
        this.app = { index, name: index === 0 ? "chrono" : `app${index}` };
        out.push("OK");
        return { lines: out, closeAfter: false };
      }
      case "SHOT":
        return this.shot(out);
      case "PUSHSTATS":
        if (this.pushStats) {
          out.push(`PUSHSTATS ${this.pushStats.pushes} ${this.pushStats.pixels}`);
        } else {
          out.push(`ERR unknown ${word}`);
        }
        return { lines: out, closeAfter: false };
      case "DOWN":
      case "MOVE":
      case "UP":
      case "TAP":
      case "ERASE":
      case "KEY":
      case "BOOT":
      case "CHORD":
        out.push("OK");
        return { lines: out, closeAfter: false };
      default:
        out.push(`ERR unknown ${word}`);
        return { lines: out, closeAfter: false };
    }
  }

  private shot(out: string[]): { lines: string[]; closeAfter: boolean } {
    const rle = encodeRLE(this.screen);
    const b64 = encodeBase64(rle);
    out.push(`SHOT ${this.width} ${this.height} ${rle.length}`);
    const body: string[] = [];
    for (let i = 0; i < b64.length; i += B64_WRAP) body.push(b64.slice(i, i + B64_WRAP));

    if (this.fault.kind === "vanish") {
      this.vanished = true;
      // Exactly what a port disappearing mid-SHOT looks like from the host:
      // a header, some payload, and then nothing at all, forever.
      return { lines: out.concat(body.slice(0, this.fault.afterBodyLines)), closeAfter: true };
    }
    return { lines: out.concat(body, ["END"]), closeAfter: false };
  }
}

// A flat screen of one grey value, plus a rectangle of another: enough
// structure that a wrong RLE decode shows up as a wrong picture rather than
// as an accidentally-correct blank.
export function testScreen(width: number, height: number, background: number, ink: number, box: { x: number; y: number; w: number; h: number }): Uint8Array {
  const grey = new Uint8Array(width * height).fill(background);
  for (let y = box.y; y < box.y + box.h && y < height; y++) {
    for (let x = box.x; x < box.x + box.w && x < width; x++) grey[y * width + x] = ink;
  }
  return grey;
}
