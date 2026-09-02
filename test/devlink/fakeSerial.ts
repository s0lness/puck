// A fake Web Serial port over a ScriptedBoard, so harness/links/
// webSerialLink.ts can be driven with no board, no browser and no
// navigator.serial.
//
// TWO THINGS THIS DELIBERATELY MAKES AWKWARD, because both are real and
// both are where a line-oriented reader over a byte stream goes wrong:
//
//   1. REPLIES ARRIVE IN ARBITRARY CHUNKS. A real USB CDC read hands back
//      whatever happened to be in the buffer, which splits lines anywhere,
//      including between the \r and the \n. This fake enqueues every reply
//      in small fixed-size fragments, so a reader that assumes one read is
//      one line fails here rather than on somebody's desk.
//   2. CLOSING IS ORDER-SENSITIVE. SerialPort.close() rejects while the
//      readable or writable stream is still locked, and that is exactly the
//      bug a "release the port on every exit path" claim hides: the code
//      calls close(), it throws, the catch swallows it, and the port stays
//      held. So close() here THROWS if a lock is still out, and the tests
//      assert it was called and resolved.

import { ScriptedBoard } from "./board";

const CHUNK_BYTES = 7;

export class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  /** Observed by the tests: the exact lifecycle this port went through. */
  readonly log: string[] = [];
  signals: SerialOutputSignals | null = null;
  isOpen = false;
  closedCleanly = false;

  private board: ScriptedBoard;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private streamClosed = false;
  private inbound = "";
  private readerLocked = false;
  private writerLocked = false;

  constructor(board: ScriptedBoard, private info: SerialPortInfo = { usbVendorId: 0x2e8a, usbProductId: 0x0009 }) {
    this.board = board;
  }

  getInfo(): SerialPortInfo {
    return this.info;
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.isOpen) throw new Error("InvalidStateError: the port is already open");
    this.log.push(`open baud=${options.baudRate}`);
    this.isOpen = true;
    this.streamClosed = false;

    const self = this;
    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        self.controller = controller;
      },
      cancel() {
        self.readerLocked = false;
        self.log.push("readable cancelled");
      },
    });
    // The lock bookkeeping the real API enforces, made observable. A
    // ReadableStream already throws on a double getReader(); what it does
    // NOT do is tell a test whether the lock came back, and that is the
    // property under test.
    const originalGetReader = this.readable.getReader.bind(this.readable);
    this.readable.getReader = () => {
      const reader = originalGetReader();
      this.readerLocked = true;
      const originalRelease = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        this.readerLocked = false;
        this.log.push("reader lock released");
        originalRelease();
      };
      return reader;
    };

    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        self.onBytes(chunk);
      },
      close() {
        self.log.push("writable closed");
      },
    });
    const originalGetWriter = this.writable.getWriter.bind(this.writable);
    this.writable.getWriter = () => {
      const writer = originalGetWriter();
      this.writerLocked = true;
      const originalRelease = writer.releaseLock.bind(writer);
      writer.releaseLock = () => {
        this.writerLocked = false;
        this.log.push("writer lock released");
        originalRelease();
      };
      return writer;
    };
  }

  async close(): Promise<void> {
    if (this.readerLocked) throw new Error("the port cannot be closed while its readable stream is still locked");
    if (this.writerLocked) throw new Error("the port cannot be closed while its writable stream is still locked");
    this.log.push("close");
    this.isOpen = false;
    this.closedCleanly = true;
    this.readable = null;
    this.writable = null;
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signals = signals;
    this.log.push(`setSignals dtr=${signals.dataTerminalReady} rts=${signals.requestToSend}`);
  }

  async getSignals(): Promise<SerialInputSignals> {
    return { dataCarrierDetect: true, clearToSend: true, ringIndicator: false, dataSetReady: true };
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  // ---- the board side ---------------------------------------------------

  private onBytes(chunk: Uint8Array): void {
    this.inbound += new TextDecoder().decode(chunk);
    for (;;) {
      const nl = this.inbound.indexOf("\n");
      if (nl < 0) break;
      const line = this.inbound.slice(0, nl).replace(/\r$/, "");
      this.inbound = this.inbound.slice(nl + 1);
      if (line.length === 0) continue;
      const answer = this.board.handle(line);
      if (!answer) continue;
      for (const reply of answer.lines) this.emit(reply + "\r\n");
      if (answer.closeAfter) this.endStream();
    }
  }

  private emit(text: string): void {
    if (this.streamClosed || !this.controller) return;
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      this.controller.enqueue(bytes.slice(i, i + CHUNK_BYTES));
    }
  }

  private endStream(): void {
    if (this.streamClosed) return;
    this.streamClosed = true;
    try {
      this.controller?.close();
    } catch {
      // already closed by a cancel()
    }
  }
}

/** A navigator.serial stand-in that hands out exactly this port. */
export function fakeSerial(port: FakeSerialPort): { requested: number; serial: Serial } {
  const state = { requested: 0, serial: null as unknown as Serial };
  state.serial = {
    async getPorts() {
      return [port as unknown as SerialPort];
    },
    async requestPort() {
      state.requested++;
      return port as unknown as SerialPort;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  } as unknown as Serial;
  return state;
}
