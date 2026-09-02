// The core of a headless emulator replay: instantiate a wasm module from
// already-fetched bytes, then call the ABI functions in order for a
// trace's events, capturing the framebuffer at whatever nowMs values were
// asked for. No filesystem, no browser DOM: this is what makes it callable
// from every place this repo needs to replay a trace against the emulator
// with nothing but the module's bytes -
//   - harness/emulatorSide.ts, for the differential test harness's CLI
//     (reads a wasm PATH off disk with node:fs, then hands the bytes here)
//   - src/regression.ts, the in-page hardware-free regression check (the
//     page already has the current module's bytes in memory, see
//     main.ts's wasmBytes, no file to read)
//   - test/regression/run.ts, a plain Bun script proving the regression
//     check catches a real firmware change, with no browser involved
//
// This function used to live only inside harness/emulatorSide.ts. Reused
// here rather than forked: two copies of "replay a trace against the
// emulator" would have agreed with each other exactly once, at the moment
// the second copy was written, and drifted from then on with nothing to
// notice - see docs/decisions/0002-two-compilers-not-one.md for the same
// argument made about firmware logic, applied here to this repo's own code.
//
// emu_tick(nowMs) takes the timestamp as an argument (wasm/emu_abi.h), so
// this never has to wait for real time to pass: replaying a trace here is
// "call the ABI functions in order, as fast as the host can", and the
// result is bit-identical to what the live page would have shown at each
// of those same nowMs values, per the determinism guarantee emu_abi.h
// documents.

import { instantiate, readDeviceDescriptor, type EmuExports, type DeviceDescriptor } from "./wasm";
import { pixelReaderFor, readFramebufferRGB } from "./panel";
import type { CapturedFrame } from "./frame";
import type { TraceEvent } from "./recorder";

// Aggregate panel-push load over an entire replay, from emu_push_count()/
// emu_push_x/y/w/h() (wasm/emu_abi.h) - the same ABI a firmware author
// reaches for by hand to check "how much am I pushing per tick" (see
// packs/rp2350-touch-amoled-18/gotchas.md's "many small pushes" entry, found
// exactly this way). Tracked here, once, in the shared replay path, so any
// bundle wanting a push-load invariant (apps/fluidbox/invariants.ts today)
// gets it for free instead of re-instrumenting its own replay. Aggregate
// only (max/mean over the whole trace), not a per-tick array: a checker
// caring about the shimmer class of bug wants "did any tick push far more
// than usual", not a full timeline, and an array here would scale with
// trace length for no caller that exists today.
export interface PushLoadStats {
  tickCount: number;
  maxPushesPerTick: number;
  maxPushPixelsPerTick: number;
  meanPushPixelsPerTick: number;
}

// How much of the module's own fixed per-app arena the app had taken by the
// end of the replay, straight from wasm/emu_abi.h's OPTIONAL emu_arena_used()
// / emu_arena_capacity(). Read once, at the end, rather than per tick: a bump
// allocator only grows, so the last reading is the high-water mark, and a
// per-tick series would cost a call per tick for a number no caller has asked
// for. Absent whenever the module does not export the pair, which is the
// normal case for a firmware with no arena in its app contract (packs/web);
// a caller wanting a memory figure anyway has to fall back to the device's
// own declared budget and SAY SO, which is what tools/describe.ts does.
export interface ArenaStats {
  usedBytes: number;
  capacityBytes: number;
}

export interface ReplayResult {
  device: DeviceDescriptor;
  // One captured frame per requested capture point, in the same order,
  // paired with the trace timestamp (nowMs) it was captured at.
  frames: { atMs: number; frame: CapturedFrame }[];
  log: string[];
  // Present whenever the module exports emu_push_count() (every module
  // built against wasm/emu_abi.h's documented export list does - see
  // packs/*/wasm/build.ts's EMU_EXPORTS). Optional only for defensive
  // symmetry with the other optional emu_* exports this file already treats
  // that way (emu_sensor_vector, above).
  pushStats?: PushLoadStats;
  // Present only when the module exports emu_arena_used()/emu_arena_capacity()
  // (see ArenaStats above).
  arena?: ArenaStats;
}

// Options carried from the replayed trace into the instantiation itself.
// Today the only one is the seed behind WASI-lite's random_get
// (src/wasiLite.ts): a trace records the seed its session ran with
// (Trace.seed, src/recorder.ts), and a replay that used a different seed
// would produce different pixels for the same input, which is exactly the
// determinism this whole file exists to guarantee. A trace with no seed
// replays with DEFAULT_TRACE_SEED, the same value the page uses when it
// has no trace at all, so every trace recorded before this field existed
// still replays bit-identically.
export interface ReplayOptions {
  seed?: number;
}

// capturePoints: nowMs values (matching TraceEvent's "t" field / the tick
// event's own timestamp) at which to read the framebuffer. A capture
// happens right after the emu_tick() whose timestamp is >= the requested
// point - the same "capture at whatever the state is after this tick"
// semantics the live page's push overlay uses.
export async function replayFromBytes(bytes: ArrayBuffer, events: TraceEvent[], capturePoints: number[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const log: string[] = [];
  const emu: EmuExports = await instantiate(bytes, (text) => log.push(text), { seed: options.seed });
  if (emu.emu_init() === 0) throw new Error("emu_init() returned 0");

  const device = readDeviceDescriptor(emu);
  const reader = pixelReaderFor(device.panel.format);
  const fbPtr = emu.emu_fb();

  const remainingPoints = [...capturePoints].sort((a, b) => a - b);
  const frames: { atMs: number; frame: CapturedFrame }[] = [];

  // Push-load aggregation (see PushLoadStats above). Guarded on the export
  // existing at all: a module built before wasm/emu_abi.h grew this export,
  // or one that genuinely omits it, simply gets no pushStats back rather
  // than throwing mid-replay.
  const tracksPushes = typeof emu.emu_push_count === "function";
  let pushTickCount = 0;
  let maxPushesPerTick = 0;
  let maxPushPixelsPerTick = 0;
  let sumPushPixelsPerTick = 0;

  function recordPushLoad(): void {
    if (!tracksPushes) return;
    const count = emu.emu_push_count();
    let pixels = 0;
    for (let i = 0; i < count; i++) pixels += emu.emu_push_w(i) * emu.emu_push_h(i);
    pushTickCount++;
    if (count > maxPushesPerTick) maxPushesPerTick = count;
    if (pixels > maxPushPixelsPerTick) maxPushPixelsPerTick = pixels;
    sumPushPixelsPerTick += pixels;
  }

  function captureNow(atMs: number): void {
    const rgb = readFramebufferRGB(emu.memory, fbPtr, device.panel.w, reader, {
      x: 0,
      y: 0,
      w: device.panel.w,
      h: device.panel.h,
    });
    frames.push({ atMs, frame: { width: device.panel.w, height: device.panel.h, rgb } });
  }

  for (const ev of events) {
    switch (ev.k) {
      case "touch":
        emu.emu_touch(ev.down, ev.x, ev.y);
        break;
      case "button":
        emu.emu_button(ev.i, ev.down);
        break;
      case "verdict":
        emu.emu_button_verdict(ev.i, ev.long);
        break;
      case "sensor":
        emu.emu_sensor_event(ev.i);
        break;
      case "vector":
        // Optional export: a module that never declared a "kind": "vector"
        // sensor (or predates this ABI addition) simply does not have it,
        // and this is a silent no-op against it, per emu_abi.h's own
        // "unimplemented means uncalled" contract - see recorder.ts's
        // header comment on this event kind for why that is what keeps a
        // pre-existing trace (no vector events at all) replaying bit-
        // identically either way.
        emu.emu_sensor_vector?.(ev.i, ev.x, ev.y, ev.z);
        break;
      case "accel":
        // Optional export, same silent-no-op contract as "vector" above -
        // see recorder.ts's header comment on this event kind.
        emu.emu_accel_sample?.(ev.i, ev.t, ev.ax, ev.ay, ev.az);
        break;
      case "tick":
        emu.emu_tick(ev.t);
        recordPushLoad();
        while (remainingPoints.length > 0 && remainingPoints[0]! <= ev.t) {
          captureNow(remainingPoints.shift()!);
        }
        break;
    }
  }
  // Any capture point past the trace's last tick: capture the final state
  // rather than silently dropping it, since "after the trace finished" is
  // a legitimate thing to ask for (e.g. --at the trace's total duration).
  for (const p of remainingPoints) captureNow(p);

  const pushStats: PushLoadStats | undefined = tracksPushes
    ? {
        tickCount: pushTickCount,
        maxPushesPerTick,
        maxPushPixelsPerTick,
        meanPushPixelsPerTick: pushTickCount > 0 ? sumPushPixelsPerTick / pushTickCount : 0,
      }
    : undefined;

  const arena: ArenaStats | undefined =
    typeof emu.emu_arena_used === "function" && typeof emu.emu_arena_capacity === "function"
      ? { usedBytes: emu.emu_arena_used(), capacityBytes: emu.emu_arena_capacity() }
      : undefined;

  return { device, frames, log, pushStats, arena };
}
