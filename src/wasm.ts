// Loads and instantiates a firmware compiled to WebAssembly, per
// wasm/emu_abi.h. Nothing here names a specific device: the panel size,
// buttons, sensors and apps all come from the module's own emu_device()
// JSON, read after instantiation (see readDeviceDescriptor below and
// main.ts, which builds the page from it).
//
// The wasm URL is a parameter, not a constant baked in here, on purpose:
// this is a local dev tool (a firmware author runs it against their own
// build), not a hosted page that takes an upload, but keeping the URL a
// parameter costs nothing and avoids closing that door later.

import { validateFbPtr } from "./abiGuard";
import {
  WASI_MODULE,
  DEFAULT_TRACE_SEED,
  buildWasiLite,
  unsupportedWasiImports,
  unsupportedWasiMessage,
  wasiImportNames,
} from "./wasiLite";

export interface EmuExports {
  memory: WebAssembly.Memory;
  emu_device(): number;
  emu_init(): number;
  emu_tick(nowMs: number): void;
  emu_fb(): number;
  emu_push_count(): number;
  emu_push_x(i: number): number;
  emu_push_y(i: number): number;
  emu_push_w(i: number): number;
  emu_push_h(i: number): number;
  emu_touch(down: number, x: number, y: number): void;
  emu_button(index: number, down: number): void;
  emu_button_verdict(index: number, isLong: number): void;
  emu_sensor_event(index: number): void;
  // Optional: only present for a firmware that declared at least one
  // sensor with "kind": "vector" (emu_abi.h) and implemented the export.
  // The host must never assume this exists; every call site guards it
  // (e.g. `emu.emu_sensor_vector?.(...)`) exactly like the sound exports
  // below.
  emu_sensor_vector?(index: number, x: number, y: number, z: number): void;
  // Optional: only present for a firmware that declared at least one
  // sensor with "kind": "stream" (emu_abi.h) and implemented the export.
  // Unlike emu_sensor_vector (one continuous reading), this is called once
  // PER RAW SAMPLE a real accelerometer would have produced since the last
  // call - a trace or a live session may call it several times between two
  // emu_tick()s. tMs shares emu_tick()'s own clock (host-driven, not wall
  // time), so a replay stays deterministic. Every call site guards it with
  // `?.()`, same as emu_sensor_vector.
  emu_accel_sample?(index: number, tMs: number, ax: number, ay: number, az: number): void;
  // Optional: only present when the firmware declared an "apps" array in
  // its device descriptor (emu_abi.h, "the emulator will not call them"
  // otherwise).
  emu_app_current?(): number;
  emu_app_switch?(index: number): void;
  // Sound: two counters to diff against what was last seen, not a call the
  // host makes (sound is an output, driven by firmware logic like the
  // timer's alarm, never by the host directly). See emu_abi.h's "sound"
  // section and audio.ts, which does the diffing. Optional, same reasoning
  // as emu_app_current/emu_app_switch above: a device with no sound simply
  // does not export these, and audio.ts must not assume every firmware has
  // a speaker.
  // Optional: how many bytes of its fixed per-app allocation arena the
  // running app has taken, and how large that arena is (wasm/emu_abi.h's
  // "the app arena"). Only a firmware whose app contract HAS a bump
  // allocator exports these: packs/rp2350-touch-amoled-18 does,
  // packs/web does not, so every call site guards them exactly like the
  // sensor and sound exports above. Read after a replay by
  // src/replayCore.ts, which is how tools/describe.ts states an app's
  // memory demand from the module rather than from a device's budget.
  emu_arena_used?(): number;
  emu_arena_capacity?(): number;
  emu_sound_sample_rate?(): number;
  emu_sound_play_seq?(): number;
  emu_sound_stop_seq?(): number;
  emu_sound_buffer?(): number;
  emu_sound_frames?(): number;
}

export interface DeviceButton {
  id: string;
  label: string;
  edge: "left" | "right" | "top" | "bottom";
  at: number; // 0..1 along that edge, 0 = top (left/right edges) or left (top/bottom edges)
  longPressMs?: number;
}

export interface DeviceSensor {
  id: string;
  kind: string; // "event" is the only kind emu_abi.h currently defines
  label?: string;
}

// One step of a gesture's machine-readable "script" (see DeviceGesture.script
// below). Three verbs, deliberately as small as a chord needs: hold a
// declared button down, release it, or wait a real number of milliseconds
// while whatever is already held stays held. "hold"/"release" name a
// button by its declared id (DeviceButton.id), never a position or a key,
// so the script stays correct however the emulator happens to assign
// keyboard shortcuts this session.
export type GestureStep = { hold: string } | { release: string } | { waitMs: number };

// A compound gesture the runtime itself recognises (a menu, an app switch)
// is not any one button's business to describe, so there is nowhere in
// "buttons" to hang a label like "hold both, then long-press" on; this is
// that description, and emu_abi.h documents both fields below as real,
// shipped parts of emu_device()'s JSON.
//
//   how     prose for a human, in device terms (which buttons, held how).
//           Deliberately not parseable: it must never be the thing this
//           page derives button presses from, because a chord's own wording
//           can change independently of its behaviour, and a page that
//           scraped it would go stale silently the next time that happens,
//           exactly the kind of bug this emulator exists to catch rather
//           than commit.
//
//   script  OPTIONAL. The same gesture, as a small sequence of hold/release/
//           waitMs steps a page can actually execute through the real input
//           path (emu_button/emu_button_verdict, timed across real
//           milliseconds - see main.ts's runGestureScript). A firmware that
//           has not been updated to declare one simply omits it, and the
//           page says so plainly rather than guessing a sequence from `how`
//           or from how many buttons happen to exist.
export interface DeviceGesture {
  id: string;
  label: string;
  how: string;
  script?: GestureStep[];
}

export interface DeviceDescriptor {
  name?: string;
  panel: { w: number; h: number; format: string };
  buttons?: DeviceButton[];
  touch?: { points?: number };
  sensors?: DeviceSensor[];
  apps?: string[];
  gestures?: DeviceGesture[];
}

export const DEFAULT_WASM_URL = "wasm/emu.wasm";

// The nine math functions and the one logging call emu_abi.h documents as
// what a freestanding module imports, under the "env" module namespace the
// header's own import list is written against. If the actual build uses
// different names, a different namespace, or asks for an import not listed
// here, WebAssembly.instantiate throws naming exactly what it asked for and
// didn't get; that error is rethrown verbatim by loadEmuModule rather than
// swallowed, which is the mechanism emu_abi.h itself names for reconciling
// the two sides. The ONE other namespace this host will ever populate is
// wasi_snapshot_preview1, and only when the module itself imports from it,
// and only for four deterministic shims: see src/wasiLite.ts.
function buildImportObject(onLog: (text: string) => void, getMemory: () => WebAssembly.Memory | undefined): WebAssembly.Imports {
  const readString = (ptr: number, len: number): string => {
    const memory = getMemory();
    if (!memory) return "";
    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  };
  return {
    env: {
      sinf: Math.sin,
      cosf: Math.cos,
      atan2f: Math.atan2,
      sqrtf: Math.sqrt,
      fabsf: Math.abs,
      floorf: Math.floor,
      fmodf: (a: number, b: number) => a % b,
      powf: Math.pow,
      expf: Math.exp,
      js_log: (ptr: number, len: number) => onLog(readString(ptr, len)),
    },
  };
}

// Fetches the module's raw bytes. Kept separate from instantiate() so a
// caller (main.ts, for replay / hot-reload; the differential harness, for a
// headless replay with no DOM at all) can re-instantiate a fresh instance
// from the SAME bytes without hitting the network again, which matters for
// two different reasons: replay wants a byte-identical restart, and
// re-fetching mid-rebuild risks reading a half-written file.
export async function fetchWasmBytes(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(
      `wasm module not found at ${url} (HTTP ${res.status}). This half of the project builds separately ` +
        `(see wasm/emu_abi.h); build it, or point the watcher at it, then reload.`
    );
  }
  return res.arrayBuffer();
}

// The wasm magic bytes ("\0asm"), checked before ever attempting to compile.
// The dev server debounces its own reload broadcast until the file has
// stopped changing (server.ts, waitForStableFile), but that is a second
// line of defence, not a substitute for this one: this is the only check
// that runs no matter how the bytes got here (a stale cache, a proxy that
// truncated a response, a build tool the server doesn't watch). A bad
// magic-byte read gets a specific, actionable message instead of whatever
// generic parse error WebAssembly.compile would otherwise throw.
function hasWasmMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 8) return false;
  const b = new Uint8Array(bytes, 0, 4);
  return b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
}

// Options every instantiation shares, all optional so the common call
// (main.ts's hot reload, a replay of a trace that carries no seed of its
// own) keeps working unchanged.
export interface InstantiateOptions {
  // Seeds the deterministic PRNG behind WASI-lite's random_get, and
  // nothing else. Comes from the replayed trace (Trace.seed,
  // src/recorder.ts) so that replaying a trace reproduces the same random
  // bytes it was recorded with. Ignored entirely by a module that does not
  // import random_get, which is every module in this repository today.
  seed?: number;
}

// Instantiates a fresh instance from already-fetched bytes. onLog receives
// every env.js_log() call (and, for a module that imports it, every
// wasi_snapshot_preview1.fd_write to stdout/stderr) decoded to a string.
//
// Validates before touching anything the caller already has running:
// magic bytes, then compile, then the import inspection below, then
// WebAssembly.instantiate (link against the real import object), then (in
// main.ts's bringUp) emu_init() and the device descriptor. Every one of
// those can fail on a half-written or incompatible module, and the whole
// point of checking all of them BEFORE main.ts swaps its `emu` reference
// is that a failure here must never tear down a module that was working.
//
// The imports are inspected between compile and instantiate rather than
// letting the link step fail on its own, for one reason: a module that
// imports wasi_snapshot_preview1 needs either four deterministic shims or
// a precise refusal naming exactly which symbols it asked for that this
// emulator will never provide (src/wasiLite.ts, and
// docs/decisions/0004-wasi-lite-not-wasi.md for why the line is drawn
// there). The shims are built ONLY when the module actually asks: a
// module that imports nothing from that namespace is instantiated against
// the exact same import object it always was, with no WASI namespace
// present at all.
export async function instantiate(bytes: ArrayBuffer, onLog: (text: string) => void, options: InstantiateOptions = {}): Promise<EmuExports> {
  if (!hasWasmMagic(bytes)) {
    throw new Error(
      `not a valid wasm module: bad magic bytes (${bytes.byteLength} bytes read). ` +
        `This usually means the file was read mid-rebuild; wait a moment and retry.`
    );
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(bytes);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  let memory: WebAssembly.Memory | undefined;
  // The last nowMs handed to emu_tick, which is the only clock this
  // emulator has (wasm/emu_abi.h). Read by WASI-lite's clock_time_get, set
  // by the emu_tick wrapper below, and left at 0 until the first tick.
  let lastNowMs = 0;
  const importObject = buildImportObject(onLog, () => memory);

  const wasiNames = wasiImportNames(WebAssembly.Module.imports(module));
  const wantsWasi = wasiNames.length > 0;
  if (wantsWasi) {
    const unsupported = unsupportedWasiImports(wasiNames);
    if (unsupported.length > 0) throw new Error(unsupportedWasiMessage(unsupported));
    importObject[WASI_MODULE] = buildWasiLite({
      onLog,
      getMemory: () => memory,
      nowMs: () => lastNowMs,
      seed: options.seed ?? DEFAULT_TRACE_SEED,
    });
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, importObject);
  } catch (err) {
    // Rethrown as-is: the message names the missing import (module.field),
    // which is exactly what needs to reach the page (see file header).
    throw err instanceof Error ? err : new Error(String(err));
  }

  const exports = instance.exports as unknown as EmuExports;
  memory = exports.memory;
  if (!memory) {
    throw new Error(
      "wasm module has no exported 'memory'; the emulator reads the framebuffer and emu_device() through it."
    );
  }
  if (!wantsWasi) return exports;

  // A module that reads the clock has to be handed one, and the only
  // moment this host learns what time the guest thinks it is, is the
  // emu_tick call itself. Wrapping the export (in a copy: an instance's
  // own exports object is frozen) keeps every caller unchanged and costs
  // nothing at all for the modules that do not import a clock, since this
  // branch never runs for them.
  const rawTick = exports.emu_tick.bind(exports);
  return {
    ...exports,
    emu_tick(nowMs: number): void {
      lastNowMs = nowMs;
      rawTick(nowMs);
    },
  };
}

export function readCString(memory: WebAssembly.Memory, ptr: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

// Safe-ish rendering of an arbitrary JSON value for an error message: never
// throws itself (a value JSON.stringify chokes on, e.g. a BigInt, cannot
// happen from JSON.parse output, but this is cheap insurance against ever
// letting a message-building helper become its own crash).
function jsonOf(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Reads and parses emu_device(), and validates every field the rest of
// this emulator (buildChrome, buildSensorControls, buildAppStrip,
// buildGestures - all in main.ts and its helpers) assumes is there and
// shaped correctly. Thrown errors are meant to be shown verbatim on the
// page: an unparsable descriptor, a missing "panel", a button with no
// "id", a sensor with no "id" are all firmware-side bugs worth seeing
// immediately as exactly what they are, not a blank screen and not a
// TypeError from deep inside some DOM-building code the person reading the
// error has never heard of. This is why this validation belongs HERE
// rather than scattered across every place that reads a field: one
// boundary, checked once, so everything downstream can trust the shape
// without re-checking it.
export function readDeviceDescriptor(emu: EmuExports): DeviceDescriptor {
  const ptr = emu.emu_device();
  const text = readCString(emu.memory, ptr);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`emu_device() returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${text}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`emu_device() must return a JSON object, got: ${text}`);
  }
  const d = parsed as Partial<DeviceDescriptor> & Record<string, unknown>;

  if (typeof d.panel !== "object" || d.panel === null) {
    throw new Error(`emu_device() is missing a "panel" object: ${text}`);
  }
  const panel = d.panel as Partial<DeviceDescriptor["panel"]>;
  if (!Number.isInteger(panel.w) || (panel.w as number) <= 0 || !Number.isInteger(panel.h) || (panel.h as number) <= 0) {
    throw new Error(`emu_device()'s "panel" needs positive integer w/h, got w=${jsonOf(panel.w)} h=${jsonOf(panel.h)}: ${text}`);
  }
  if (typeof panel.format !== "string" || panel.format.length === 0) {
    throw new Error(`emu_device()'s "panel" is missing a valid string "format": ${text}`);
  }

  if (d.buttons !== undefined) {
    if (!Array.isArray(d.buttons)) throw new Error(`emu_device()'s "buttons" must be an array: ${text}`);
    d.buttons.forEach((b: unknown, i: number) => {
      if (typeof b !== "object" || b === null) throw new Error(`emu_device()'s buttons[${i}] is not an object: ${text}`);
      const bb = b as Partial<DeviceButton>;
      if (typeof bb.id !== "string" || bb.id.length === 0) {
        throw new Error(`emu_device()'s buttons[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof bb.label !== "string") {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") is missing a valid string "label": ${text}`);
      }
      if (bb.edge !== "left" && bb.edge !== "right" && bb.edge !== "top" && bb.edge !== "bottom") {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") has an invalid "edge" (${jsonOf(bb.edge)}); must be one of left/right/top/bottom: ${text}`);
      }
      if (typeof bb.at !== "number" || !Number.isFinite(bb.at)) {
        throw new Error(`emu_device()'s buttons[${i}] ("${bb.id}") is missing a valid finite "at": ${text}`);
      }
    });
  }

  if (d.sensors !== undefined) {
    if (!Array.isArray(d.sensors)) throw new Error(`emu_device()'s "sensors" must be an array: ${text}`);
    d.sensors.forEach((s: unknown, i: number) => {
      if (typeof s !== "object" || s === null) throw new Error(`emu_device()'s sensors[${i}] is not an object: ${text}`);
      const ss = s as Partial<DeviceSensor>;
      if (typeof ss.id !== "string" || ss.id.length === 0) {
        throw new Error(`emu_device()'s sensors[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof ss.kind !== "string" || ss.kind.length === 0) {
        throw new Error(`emu_device()'s sensors[${i}] ("${ss.id}") is missing a valid string "kind": ${text}`);
      }
    });
  }

  if (d.apps !== undefined) {
    if (!Array.isArray(d.apps) || d.apps.some((a: unknown) => typeof a !== "string")) {
      throw new Error(`emu_device()'s "apps" must be an array of strings: ${text}`);
    }
  }

  if (d.gestures !== undefined) {
    if (!Array.isArray(d.gestures)) throw new Error(`emu_device()'s "gestures" must be an array: ${text}`);
    d.gestures.forEach((g: unknown, i: number) => {
      if (typeof g !== "object" || g === null) throw new Error(`emu_device()'s gestures[${i}] is not an object: ${text}`);
      const gg = g as Partial<DeviceGesture>;
      if (typeof gg.id !== "string" || gg.id.length === 0) {
        throw new Error(`emu_device()'s gestures[${i}] is missing a valid string "id": ${text}`);
      }
      if (typeof gg.label !== "string") {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}") is missing a valid string "label": ${text}`);
      }
      if (typeof gg.how !== "string") {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}") is missing a valid string "how": ${text}`);
      }
      if (gg.script !== undefined && !Array.isArray(gg.script)) {
        throw new Error(`emu_device()'s gestures[${i}] ("${gg.id}")'s "script" must be an array when present: ${text}`);
      }
    });
  }

  if (d.touch !== undefined) {
    if (typeof d.touch !== "object" || d.touch === null) throw new Error(`emu_device()'s "touch" must be an object: ${text}`);
    const t = d.touch as { points?: unknown };
    if (t.points !== undefined && (typeof t.points !== "number" || !Number.isFinite(t.points))) {
      throw new Error(`emu_device()'s "touch.points" must be a finite number when present: ${text}`);
    }
  }

  return d as DeviceDescriptor;
}

// The framebuffer pointer emu_fb() hands back, validated before anything
// ever reads through it (see abiGuard.ts's validateFbPtr for exactly what
// "valid" means here and why this is fatal rather than a skip-and-report
// finding). Called from bringUp() as one more guarded step, in the same
// spirit as instantiate()/emu_init()/readDeviceDescriptor() above it: a
// module whose own framebuffer pointer cannot be trusted is exactly as
// unable to proceed as one that failed to instantiate at all.
export function readFramebufferPointer(emu: EmuExports, panel: { w: number; h: number }): number {
  const fbPtr = emu.emu_fb();
  validateFbPtr(emu.memory, fbPtr, panel.w, panel.h);
  return fbPtr;
}
