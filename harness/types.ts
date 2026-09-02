// The differential test harness's shared types: a trace (the same shape
// src/recorder.ts records from a live session), and the HardwareLink
// interface a real board's transport implements. See docs/harness.md for
// the full explanation of what this proves and what it cannot.

import type { DeviceDescriptor } from "../src/wasm";
import type { TraceEvent } from "../src/recorder";
import type { CapturedFrame } from "../src/frame";

export type { TraceEvent, CapturedFrame };

export interface Trace {
  schemaVersion: 1;
  recordedAt: string;
  device: DeviceDescriptor;
  events: TraceEvent[];
  // Optional, and only meaningful for a module that imports WASI-lite's
  // random_get: see src/recorder.ts's Trace, whose shape this mirrors, for
  // what it does and why a trace without one still replays identically.
  seed?: number;
}

// A captured frame, in a common representation both sides of a comparison
// produce: RGB, 3 bytes per pixel, row-major, top-left origin. Emulator
// side: converted from the wasm framebuffer via the same pixel-format
// reader the live page uses (src/panel.ts's readFramebufferRGB). Hardware
// side: whatever your HardwareLink.screenshot() returns, already decoded
// to this shape by your adapter - the harness makes no assumption about
// your transport's wire format (base64, RLE, raw SPI dump, a camera
// photograph you've perspective-corrected, anything), only about what your
// adapter hands back.
//
// Defined in src/frame.ts, not here (imported above, re-exported below):
// the in-page hardware-free regression check (src/regression.ts) needs the
// exact same shape and must not depend on anything under harness/, so the
// shared type lives on the src/ side and this file just re-exports it for
// every harness/*.ts file already importing CapturedFrame from here.

// The pluggable side of the harness. Your own transport (serial, USB, a
// debug probe, a camera pointed at the panel with autocrop, anything that
// can inject the same input events a real user would produce and read back
// what the panel shows) implements this. Nothing in harness/ knows or
// cares which.
//
// Every input method mirrors an ABI call from wasm/emu_abi.h exactly,
// because the whole point of the differential harness is replaying the
// SAME trace both ways: what the emulator received via emu_touch/
// emu_button/emu_button_verdict/emu_sensor_event, your hardware must
// receive through whatever real mechanism reaches the same input path on
// the board (a button GPIO, a touch controller register, an injected
// event over your own debug link - see docs/harness.md's worked example
// for how one project's own link maps these).
export interface HardwareLink {
  // Opens the transport (a serial port, a socket, whatever). Called once
  // before the first event is sent.
  connect(): Promise<void>;

  // Closes the transport. Called once after the last screenshot, in a
  // `finally`, even if the run failed partway through.
  disconnect(): Promise<void>;

  // Optional: put the board into a known starting state before replay
  // begins (reboot it, reset to a known app, clear its screen). If your
  // hardware always boots into the same state as the emulator's emu_init(),
  // this can be omitted; if it can't, the comparison is only meaningful
  // from a known-equal starting point, so implement this.
  reset?(): Promise<void>;

  // Sends one input event through whatever real mechanism reaches the
  // board's equivalent of this ABI call. `t` (the trace event's own
  // timestamp) is NOT re-sent to the hardware - real hardware runs on its
  // own clock, always; see docs/harness.md on why this harness paces
  // events in real time rather than pretending it can hand the board a
  // synthetic nowMs the way emu_tick() takes one.
  send(event: TraceEvent): Promise<void>;

  // Captures what the panel currently shows, decoded to a common RGB
  // representation (see CapturedFrame above). Called at each capture
  // point the harness was told to stop at (see harness/diff.ts's --at /
  // --every).
  screenshot(): Promise<CapturedFrame>;

  // Optional: panel-push load (pushes, and pixels touched) since the last
  // screenshot, when your board can answer that (the rp2350 pack's own
  // devlink PUSHSTATS command - tools/README-devlink.md). null means the
  // board was asked and said it does not track this (an older firmware,
  // or a different pack's devlink that never declares the command);
  // omitting the method entirely means "never ask". Either way, a checker
  // that needs this and does not get it reports "unevaluable" rather than
  // passing silently - see harness/invariantTypes.ts's InvariantMeta.
  pushStats?(): Promise<{ pushes: number; pixels: number } | null>;
}
