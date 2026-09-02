// A REAL HardwareLink over devlink, from a browser page, through Web Serial.
//
// Same protocol, same board, same reply shapes as harness/links/devlinkLink.ts
// - literally the same implementation, harness/links/devlinkProtocol.ts, which
// is why that file exists. This one owns nothing but the transport: getting a
// SerialPort, opening it, framing bytes into lines, and giving it back.
//
// WHY A BROWSER TRANSPORT AT ALL. The gallery's flash pages already write
// firmware to a real board over WebUSB (RP2350) and Web Serial (ESP32-S3).
// A board that has just been flashed by the page is the one moment where
// "does this port actually run on this silicon" can be answered by the
// person holding it rather than asserted in a bundle.json by whoever last
// had a board on their desk. So after a flash, the page replays the app's
// own trace through this link, diffs the frames against the bundle's
// recorded ones, and offers to post the verdict. See site/attest/.
//
// BOTH BOARDS SPEAK DEVLINK OVER A CDC SERIAL PORT, so there is exactly one
// browser transport here and no WebUSB twin: the RP2350 pack answers on its
// USB CDC port and the ESP32-S3 pack on its native USB Serial/JTAG port
// (packs/esp32-s3-touch-amoled-18/docs/decisions/0002). WebUSB is what the
// FLASHER needs on the RP2350 (PICOBOOT is a vendor-class bulk protocol, not
// a serial port); devlink is not that, and claiming a CDC interface over
// WebUSB while the OS's own serial driver holds it is a fight this has no
// reason to pick.
//
// THE DTR TRAP, WHICH IS THE SAME TRAP ON BOTH SIDES OF THE WIRE. The RP2350's
// USB CDC stack looks completely dead unless DTR is asserted, and the
// ESP32-S3's USB Serial/JTAG peripheral wires DTR and RTS to the chip's own
// BOOT strap and EN (reset) pins, so asserting them there reboots the board
// into the ROM downloader instead of talking to it. One board needs the
// signal, the other is broken by it. That is a per-board fact, so it is an
// option here (dataTerminalReady), defaulted per family by the caller, and it
// is the single most likely reason a first run looks like a board that never
// answers.
//
// EVERY EXIT PATH RELEASES THE PORT. A Web Serial port is exclusive to the
// tab that opened it, and a page that keeps one after a failed run leaves
// the person with a board no other tool can reach until they close the tab
// (and, on some systems, unplug the board). So release() runs from
// connect()'s own failure path, from disconnect(), and is idempotent, and
// it drops the reader's and writer's locks before closing the port, because
// SerialPort.close() rejects while either stream is still locked. The
// devlink tests (test/devlink/run.ts) assert the release for every one of
// those paths, including a transport that dies in the middle of a SHOT
// body.

import {
  DevlinkSession,
  type DevlinkOptions,
  type DevlinkTransport,
  type RawShot,
} from "./devlinkProtocol";
import type { CapturedFrame, HardwareLink, TraceEvent } from "../types";

export {
  BoardResetError,
  DevlinkClosedError,
  DevlinkTimeoutError,
  ShotTruncatedError,
} from "./devlinkProtocol";

// The devlink port runs at whatever the CDC stack advertises; neither board
// cares about the number (both are native USB, not a UART bridge), but Web
// Serial requires one.
export const DEFAULT_BAUD_RATE = 115200;

export interface WebSerialLinkOptions extends Partial<DevlinkOptions> {
  /** Defaults to DEFAULT_BAUD_RATE. Ignored by both native-USB boards, required by the API. */
  baudRate?: number;
  /**
   * true for the RP2350 (its CDC stack does not answer without it), false for
   * the ESP32-S3 (DTR is wired to its BOOT strap). See this file's header.
   * Defaults to true, matching the RP2350, matching devlinkLink.ts's own
   * DEVLINK_DTR default.
   */
  dataTerminalReady?: boolean;
  /** Offered to the port picker when no `port` is supplied. Empty means "every serial port". */
  filters?: SerialPortFilter[];
  /**
   * An already-chosen port. The flash page has one in hand the moment a flash
   * finishes, and asking the person to pick the same board a second time is a
   * worse experience than reusing it. When absent, connect() calls
   * requestPort(), which needs a user gesture.
   */
  port?: SerialPort;
  /** Defaults to navigator.serial. Injectable so tests can drive a scripted board. */
  serial?: Serial;
}

/** Checked before any picker is opened, so an unsupported browser gets a sentence, not an exception. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

// ---------------------------------------------------------------------
// Byte stream -> lines
// ---------------------------------------------------------------------

// A queue, not a read-on-demand wrapper, and that is load-bearing. The
// protocol races every read against a timeout (devlinkProtocol.ts's
// readLine), so when a timeout wins there is still an in-flight
// reader.read() that the NEXT read must not duplicate: calling read() twice
// concurrently on one ReadableStreamDefaultReader is an error. One pump
// loop owns the reader, and readers of this queue just wait for lines.
class LineQueue {
  private queue: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private done = false;

  push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  finish(): void {
    this.done = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }

  readLine(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ---------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------

export class WebSerialLink implements HardwareLink {
  readonly opts: WebSerialLinkOptions;

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private session: DevlinkSession | null = null;
  private lines = new LineQueue();
  private released = false;
  // True only for a port this link opened itself. A port handed in already
  // open (the flasher's, mid-session) is still released by this link, since
  // the alternative is leaving it locked to a tab with nothing driving it.
  private opened = false;

  constructor(opts: WebSerialLinkOptions = {}) {
    this.opts = opts;
  }

  get description(): string {
    const info = this.port?.getInfo?.();
    if (info && info.usbVendorId !== undefined) {
      const vid = info.usbVendorId.toString(16).padStart(4, "0");
      const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
      return `the serial port at USB ${vid}:${pid}, over Web Serial`;
    }
    return "the serial port picked in this browser, over Web Serial";
  }

  get panel(): { w: number; h: number } {
    return this.session?.panel ?? { w: 0, h: 0 };
  }

  get resetEvidence(): string[] {
    return this.session?.resetEvidence ?? [];
  }

  get appTransitions(): string[] {
    return this.session?.appTransitions ?? [];
  }

  get shots(): RawShot[] {
    return this.session?.shots ?? [];
  }

  async connect(): Promise<void> {
    const serial = this.opts.serial ?? (typeof navigator !== "undefined" ? navigator.serial : undefined);
    if (!this.opts.port && !serial) {
      throw new Error("Web Serial isn't available in this browser. Use Chrome or Edge on desktop.");
    }

    if (this.opts.port) {
      this.port = this.opts.port;
    } else {
      // requestPort() needs a user gesture. Whatever it throws when the
      // picker is cancelled or empty is already a DOMException with a
      // readable message; it is reworded here because "NotFoundError" on its
      // own tells a person nothing about what to do next.
      try {
        this.port = await serial!.requestPort({ filters: this.opts.filters ?? [] });
      } catch (err) {
        throw new Error(
          `no serial port was selected, so there is no board to run the trace on. Plug the board in, then pick its ` +
            `port in the browser's list. (${err instanceof Error ? err.message : String(err)})`
        );
      }
    }

    this.released = false;
    try {
      // A port handed to us by the flasher may already be open; opening it
      // twice throws InvalidStateError, and that is not a failure worth
      // ending the run over.
      if (!this.port.readable || !this.port.writable) {
        await this.port.open({ baudRate: this.opts.baudRate ?? DEFAULT_BAUD_RATE });
        this.opened = true;
      }

      // See this file's header: one board needs DTR, the other is rebooted
      // by it. RTS is held low in both cases, because on the ESP32-S3 it is
      // the chip's EN (reset) line.
      await this.port.setSignals({
        dataTerminalReady: this.opts.dataTerminalReady ?? true,
        requestToSend: false,
      });

      if (!this.port.readable || !this.port.writable) {
        throw new Error("the serial port opened but exposes no readable/writable stream, so nothing can be sent to the board");
      }
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.pump();

      this.session = new DevlinkSession(this.transport(), this.opts);
      await this.session.handshake();
    } catch (err) {
      // The one rule this file exists to keep: no exit path leaves the port
      // held. A failed handshake is the likeliest of them all (wrong board,
      // wrong DTR, firmware without devlink).
      await this.release();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `no board answered devlink on ${this.description}: ${msg}. Either this is not the board's devlink port, or its ` +
          `firmware does not speak devlink, or the DTR signal is wrong for this board (the RP2350 needs it asserted, ` +
          `the ESP32-S3 is rebooted by it).`
      );
    }
  }

  async disconnect(): Promise<void> {
    // Safety before release: an aborted run must not leave a button or a
    // finger injected-held on the owner's board. Best effort by design, and
    // it must never keep the port from being given back.
    try {
      if (this.session) await this.session.park();
    } catch {
      // Whatever already went wrong is the interesting error, not this one.
    }
    await this.release();
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

  async readApp(): Promise<{ index: number; name: string }> {
    return this.requireSession().readApp();
  }

  /** Idempotent, and safe to call from a failure path. Locks first, port second. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.session = null;

    const reader = this.reader;
    this.reader = null;
    if (reader) {
      // cancel() ends the pump loop (its read() resolves done), which is
      // what lets releaseLock() succeed.
      try {
        await reader.cancel();
      } catch {
        // already errored or closed under us
      }
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }

    const writer = this.writer;
    this.writer = null;
    if (writer) {
      try {
        await writer.close();
      } catch {
        // a writable stream that already errored rejects here; the lock
        // still has to go back
      }
      try {
        writer.releaseLock();
      } catch {
        // already released
      }
    }

    this.lines.finish();

    const port = this.port;
    this.port = null;
    if (port && this.opened) {
      try {
        await port.close();
      } catch {
        // the board was unplugged, or something else already closed it
      }
    }
    this.opened = false;
  }

  // ---- plumbing --------------------------------------------------------

  private transport(): DevlinkTransport {
    return {
      description: this.description,
      readLine: () => this.lines.readLine(),
      send: async (cmd: string) => {
        const writer = this.writer;
        if (!writer) throw new Error("the serial port was released before this command could be sent");
        await writer.write(new TextEncoder().encode(cmd + "\n"));
      },
      close: () => this.release(),
    };
  }

  // One loop, owning the reader, turning bytes into lines. A trailing \r is
  // stripped: this firmware writes \r\n throughout, and a line that keeps it
  // matches none of the protocol's reply shapes.
  private pump(): void {
    const reader = this.reader;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this.lines.push(line);
          }
        }
      } catch {
        // The port went away under the run (unplugged, or closed by
        // release()). finish() below turns every pending and future read
        // into the protocol's DevlinkClosedError, which says exactly that.
      } finally {
        if (buf.length > 0) this.lines.push(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
        this.lines.finish();
      }
    })();
  }

  private requireSession(): DevlinkSession {
    if (!this.session) throw new Error("web serial devlink link used before connect(), or after it was released");
    return this.session;
  }
}

// harness/diff.ts's --link contract, kept for symmetry with devlinkLink.ts.
// It cannot actually run under bun (there is no navigator.serial there); the
// export exists so the two links have the same shape, and so a future
// bun-side Web Serial polyfill needs no change here.
export default function makeWebSerialLink(): HardwareLink {
  return new WebSerialLink();
}
