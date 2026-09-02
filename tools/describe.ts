#!/usr/bin/env bun
// puck describe: draft an app descriptor from a recorded session.
//
//   bun run describe <app-port.c | module.wasm> --pack <pack> --trace <t.json> [--trace ...]
//
// docs/convention/app-bundle.md says a descriptor has three sections, and
// two of them are claims about observable behaviour: Interactions ("every
// input and its result") and Demands ("what the app requires of a device at
// all"). Both have always been written by hand, by somebody who ran the app
// and remembered. That is the same shape of hand-written step
// docs/roadmap.md's workstreams exist to remove: a sentence nobody can
// recompute when the code changes, and nobody can argue WITH.
//
// This replays a recorded session against the module, measures what
// actually happened, and writes a `descriptor.draft.md` plus a
// `descriptor.draft.json` holding every measurement behind every line, so a
// reader can check where a sentence came from. It NEVER writes
// descriptor.md: the draft is evidence a person or a model then edits, and
// the Essence paragraph (what the app IS) is left as an explicitly marked
// scaffold, because no replay can see it.
//
// HOW A RESULT IS ATTRIBUTED TO AN INPUT, which is the only interesting
// idea in this file. "The panel changed after I pressed the button" is not
// a measurement: a stopwatch's panel changes on every tick whether anything
// was pressed or not, so a diff against the previous frame says nothing
// about the press. So every affordance is measured DIFFERENTIALLY, against
// its own counterfactual: the same trace with that one press (or stroke, or
// sensor event) removed, replayed against the same module, and diffed frame
// by frame at the same tick timestamps. What is left is the part of the
// panel that changed BECAUSE of that input, which is what an Interactions
// line is supposed to state. It is the same method harness/portdiff.ts uses
// on two modules and one trace, turned sideways: one module and two traces.
//
// WHAT THIS CANNOT SEE, and says so in its own output rather than quietly
// guessing:
//
//   - Anything the session never did. A trace with no touch in it proves
//     nothing about touch, and a demand drafted from it says "0 points"
//     for a reason a reader has to be able to check. Every input the device
//     declares and the session never used is listed under its own heading.
//   - What an affordance is FOR. Interactions lines carry the convention's
//     `(intent: ...)` parenthetical as a TODO, never a guess: the intent is
//     what a porter needs when the target device has no such control, and
//     inventing one would be worse than leaving it blank.
//   - The size at which the app is still itself. `panel.minW`/`minH` here is
//     the extent the app ACTUALLY PAINTED on the panel it ran on. That is an
//     observation; the convention's minW/minH is a judgement about identity,
//     and the two are not the same number.
//   - Device time. `tick.needsMs` is measured as emulator time per tick on
//     the machine that ran this, not as a frame's cost on the board. It is
//     labelled that way everywhere it appears and must be replaced by a real
//     device measurement before publishing.
//
// Exit codes follow the repo's three-way split: 0 = a draft was written,
// 2 = it never ran (a missing module, an unknown pack, an unreadable trace).

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { replayEmulator } from "../harness/emulatorSide";
import { compareFrames } from "../src/compare";
import type { CapturedFrame } from "../src/frame";
import type { TraceEvent } from "../src/recorder";
import type { DeviceDescriptor } from "../src/wasm";
import type { Trace } from "../harness/types";
import type { DeviceJson, Demands, DemandButton, DemandSensor } from "./verdict";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EXIT_OK = 0;
const EXIT_INFRA = 2;

// A capture is a full RGB frame held in memory, so the window around each
// affordance is bounded rather than "every tick": a 368x448 panel costs
// ~0.5MB per frame, and a 565-tick trace captured whole would be 280MB for
// numbers no line needs. Twelve ticks is about a fifth of a second at the
// 60Hz these traces were recorded at, which is long enough for an affordance
// whose result is a redraw and short enough to stay cheap.
const DEFAULT_WINDOW_TICKS = 12;
// How long after an input to look again, to tell a change that STAYS from
// one that reverts. Two seconds is longer than any redraw and shorter than
// the shortest trace here.
const DEFAULT_PERSIST_MS = 2000;
// The "fixed intervals" half of the capture plan: a coarse sample across the
// whole session, which is what the panel-extent and colour measurements are
// read off. Independent of the affordance windows on purpose, so an app
// nobody touched still gets a panel measurement.
const DEFAULT_EVERY_MS = 250;
// Repeats behind the tick-cost measurement (see measureTickCost). The MIN of
// several runs, not the mean: a slower run is always the machine, never the
// module.
const TIMING_REPEATS = 5;

// ---- the two documents this reads besides the trace ----------------------

interface RegistryEntry {
  name: string;
  path?: string;
}
interface Registry {
  packs: RegistryEntry[];
  silhouettes?: RegistryEntry[];
}

function die(message: string): never {
  console.error(`describe: ${message}`);
  process.exit(EXIT_INFRA);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---- affordances ---------------------------------------------------------

// One thing a person did, as a group of trace events that belong together: a
// button press is a down, an up and (on a `key`) a verdict, and removing one
// of the three would not be removing the press. The counterfactual replay
// removes the whole group.
interface Occurrence {
  // Groups sharing a key are the same affordance done again, and their
  // measurements are aggregated into one Interactions line.
  key: string;
  // The affordance's own sentence opener, e.g. "A short PWR press".
  phrase: string;
  // Which input this reaches, for the Demands half.
  input:
    | { kind: "button"; index: number; press: "short" | "long" | "click" }
    | { kind: "touch"; phase: "contact" | "drag" | "release" }
    | { kind: "sensor"; index: number; signal: "event" | "vector" | "stream" };
  // Indices into the trace's own events array, removed together for the
  // counterfactual.
  removes: number[];
  // The last event index of the group: the first tick AFTER this is the
  // earliest tick that could possibly show a result.
  lastEventIndex: number;
  firstEventIndex: number;
  // When the affordance started, and when it finished. Latency is measured
  // from the END: a press is not over until it is released, and calling the
  // whole hold time "latency" would report the person's own thumb.
  atMs: number;
  endMs: number;
}

function labelOf(device: DeviceDescriptor, index: number): string {
  const button = (device.buttons ?? [])[index];
  return button?.label ?? button?.id ?? `button ${index}`;
}

function sensorNameOf(device: DeviceDescriptor, index: number): string {
  const sensor = (device.sensors ?? [])[index];
  return sensor?.label ?? sensor?.id ?? `sensor ${index}`;
}

function groupOccurrences(events: TraceEvent[], device: DeviceDescriptor): Occurrence[] {
  const out: Occurrence[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    if (consumed.has(i)) continue;
    const ev = events[i]!;

    if (ev.k === "button" && ev.down === 1) {
      const removes = [i];
      let lastIndex = i;
      let verdictLong: number | null = null;
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        if (e.k === "button" && e.i === ev.i) {
          removes.push(j);
          lastIndex = j;
          if (e.down === 0) {
            // A verdict lands with the release, at the same timestamp
            // (src/main.ts sends both), so take any that follows it there.
            for (let v = j + 1; v < events.length && events[v]!.t === e.t; v++) {
              const cand = events[v]!;
              if (cand.k === "verdict" && cand.i === ev.i) {
                removes.push(v);
                lastIndex = v;
                verdictLong = cand.long;
              }
            }
            break;
          }
        } else if (e.k === "verdict" && e.i === ev.i) {
          removes.push(j);
          lastIndex = j;
          verdictLong = e.long;
        }
      }
      for (const r of removes) consumed.add(r);
      // A press the device answered with a verdict is a `key` press: that
      // short/long distinction is exactly what device-pack.md says a `key`
      // delivers and a `click` does not. A press with no verdict is a click.
      const press = verdictLong === null ? "click" : verdictLong === 1 ? "long" : "short";
      const label = labelOf(device, ev.i);
      const phrase = press === "click" ? `A ${label} click` : `A ${press} ${label} press`;
      out.push({
        key: `button:${ev.i}:${press}`,
        phrase,
        input: { kind: "button", index: ev.i, press },
        removes,
        firstEventIndex: i,
        lastEventIndex: lastIndex,
        atMs: ev.t,
        endMs: events[lastIndex]!.t,
      });
      continue;
    }

    if (ev.k === "touch" && ev.down === 1) {
      // A stroke: this contact, every sample while it is held, and the
      // release. Three affordances come out of one stroke, because the three
      // are separately portable: some apps act on contact, some only on the
      // drag, some only on release.
      const strokeAll = [i];
      const moves: number[] = [];
      let release = -1;
      let lastIndex = i;
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        if (e.k !== "touch") continue;
        strokeAll.push(j);
        lastIndex = j;
        if (e.down === 0) {
          release = j;
          break;
        }
        moves.push(j);
      }
      for (const r of strokeAll) consumed.add(r);
      out.push({
        key: "touch:contact",
        phrase: `A touch contact at ${ev.x},${ev.y}`,
        input: { kind: "touch", phase: "contact" },
        removes: strokeAll,
        firstEventIndex: i,
        lastEventIndex: lastIndex,
        atMs: ev.t,
        endMs: events[lastIndex]!.t,
      });
      if (moves.length > 0) {
        out.push({
          key: "touch:drag",
          phrase: `Dragging that contact (${moves.length} samples)`,
          input: { kind: "touch", phase: "drag" },
          removes: moves,
          firstEventIndex: moves[0]!,
          lastEventIndex: moves[moves.length - 1]!,
          atMs: events[moves[0]!]!.t,
          endMs: events[moves[moves.length - 1]!]!.t,
        });
      }
      if (release >= 0) {
        out.push({
          key: "touch:release",
          phrase: "Lifting that contact",
          input: { kind: "touch", phase: "release" },
          removes: [release],
          firstEventIndex: release,
          lastEventIndex: release,
          atMs: events[release]!.t,
          endMs: events[release]!.t,
        });
      }
      continue;
    }

    if (ev.k === "sensor") {
      consumed.add(i);
      out.push({
        key: `sensor:${ev.i}:event`,
        phrase: `A ${sensorNameOf(device, ev.i)} event`,
        input: { kind: "sensor", index: ev.i, signal: "event" },
        removes: [i],
        firstEventIndex: i,
        lastEventIndex: i,
        atMs: ev.t,
        endMs: ev.t,
      });
      continue;
    }

    if (ev.k === "vector" || ev.k === "accel") {
      // A continuous signal is one affordance, not one per sample: removing
      // a single reading out of a stream measures nothing a porter can use.
      const signal = ev.k === "vector" ? "vector" : "stream";
      const removes: number[] = [];
      for (let j = i; j < events.length; j++) {
        const e = events[j]!;
        if (e.k === ev.k && e.i === ev.i) {
          removes.push(j);
          consumed.add(j);
        }
      }
      const name = sensorNameOf(device, ev.i);
      out.push({
        key: `sensor:${ev.i}:${signal}`,
        phrase: signal === "vector" ? `The ${name} reading (${removes.length} samples)` : `The ${name} sample stream (${removes.length} samples)`,
        input: { kind: "sensor", index: ev.i, signal },
        removes,
        firstEventIndex: i,
        lastEventIndex: removes[removes.length - 1]!,
        atMs: ev.t,
        endMs: events[removes[removes.length - 1]!]!.t,
      });
    }
  }

  return out;
}

// ---- the capture plan ----------------------------------------------------

interface TickTimeline {
  // Tick timestamps in order, deduped: a capture point is matched to the
  // FIRST tick at or past it (src/replayCore.ts), so two ticks sharing a
  // timestamp are one capture opportunity, not two.
  ts: number[];
  // ts index -> the tick's own position in the events array, so an
  // occurrence can be told which ticks came after it.
  eventIndex: number[];
}

function timelineOf(events: TraceEvent[]): TickTimeline {
  const ts: number[] = [];
  const eventIndex: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.k !== "tick") continue;
    if (ts.length > 0 && ts[ts.length - 1] === e.t) continue;
    ts.push(e.t);
    eventIndex.push(i);
  }
  return { ts, eventIndex };
}

interface Window {
  // Tick timestamps to compare, in order, starting at the first tick that
  // could have seen the input.
  points: number[];
  // The later probe that answers "did it stay". null when this session gave
  // it nowhere to stand (see windowFor).
  persistAt: number | null;
  // Why the probe is where it is, when it is not where it was asked for.
  persistNote: string | null;
}

// The probe that answers "did the change stay" has to land while this
// affordance is still the only thing that has happened. A LATER input can
// erase the difference all by itself (chrono's BOOT reset makes a session
// that started the clock and a session that never did agree again, both at
// 00:00:00), and reading that as "the press reverted" would be a false
// sentence backed by a real diff. So the probe is capped at the last tick
// before the next affordance, and when there is no room at all the line says
// the session could not answer rather than answering wrongly.
function windowFor(timeline: TickTimeline, occ: Occurrence, nextEventIndex: number | null, windowTicks: number, persistMs: number): Window | null {
  let start = -1;
  for (let k = 0; k < timeline.ts.length; k++) {
    if (timeline.eventIndex[k]! > occ.lastEventIndex) {
      start = k;
      break;
    }
  }
  if (start === -1) return null; // the input landed after the last tick: nothing could show it

  let end = timeline.ts.length - 1;
  if (nextEventIndex !== null) {
    for (let k = start; k < timeline.ts.length; k++) {
      if (timeline.eventIndex[k]! > nextEventIndex) {
        end = k - 1;
        break;
      }
    }
  }
  if (end < start) {
    return {
      points: [timeline.ts[start]!],
      persistAt: null,
      persistNote: "the next input arrived before the next tick, so this session cannot say whether the change stayed",
    };
  }

  const points = timeline.ts.slice(start, Math.min(start + windowTicks, end + 1));
  const target = timeline.ts[start]! + persistMs;
  let persistIdx = end;
  for (let k = start; k <= end; k++) {
    if (timeline.ts[k]! >= target) {
      persistIdx = k;
      break;
    }
  }
  const persistAt = timeline.ts[persistIdx]!;
  const short = persistAt < target;
  return {
    points,
    persistAt,
    persistNote: short
      ? `probed ${persistAt - timeline.ts[start]!}ms on rather than ${persistMs}ms, because ${nextEventIndex !== null ? "the next input arrived" : "the session ended"}`
      : null,
  };
}

// ---- pixel readings ------------------------------------------------------

type Rgb = [number, number, number];

// The most common colour in a frame, taken as its background. Nothing here
// assumes what that colour is: a stopwatch's white field and a fluid scene's
// black one both come out of the same count.
function backgroundOf(frame: CapturedFrame): Rgb {
  const counts = new Map<number, number>();
  for (let p = 0; p < frame.rgb.length; p += 3) {
    const key = (frame.rgb[p]! << 16) | (frame.rgb[p + 1]! << 8) | frame.rgb[p + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = key;
    }
  }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The extent of everything drawn ON TOP of the background, which is what
// "the app painted this much of the panel" means.
function inkBox(frame: CapturedFrame, bg: Rgb): { box: Box | null; pixels: number } {
  let x0 = frame.width;
  let y0 = frame.height;
  let x1 = -1;
  let y1 = -1;
  let pixels = 0;
  for (let i = 0, p = 0; i < frame.width * frame.height; i++, p += 3) {
    if (frame.rgb[p] === bg[0] && frame.rgb[p + 1] === bg[1] && frame.rgb[p + 2] === bg[2]) continue;
    pixels++;
    const x = i % frame.width;
    const y = Math.floor(i / frame.width);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, pixels };
}

// A frame is monochrome when every pixel's three channels agree. This is the
// question `panel.color` actually asks: not "is the format a colour one" (the
// device already says that) but "does this app ever paint a colour", which is
// what refuses it on an e-paper board.
function colourfulPixels(frame: CapturedFrame): number {
  let n = 0;
  for (let p = 0; p < frame.rgb.length; p += 3) {
    if (frame.rgb[p] !== frame.rgb[p + 1] || frame.rgb[p + 1] !== frame.rgb[p + 2]) n++;
  }
  return n;
}

// ---- the measurement -----------------------------------------------------

interface OccurrenceMeasurement {
  phrase: string;
  atMs: number;
  endMs: number;
  removedEvents: number;
  changed: boolean;
  latencyTicks: number | null;
  latencyMs: number | null;
  peakDiffPixels: number;
  box: Box | null;
  persistAt: number | null;
  persistNote: string | null;
  // true = still different at the probe, false = the two sessions agreed
  // again, null = this session could not be asked (see windowFor).
  persists: boolean | null;
  perTick: { atMs: number; diffPixels: number; box: Box | null }[];
}

interface AffordanceMeasurement {
  key: string;
  phrase: string;
  input: Occurrence["input"];
  occurrences: OccurrenceMeasurement[];
  changed: boolean;
  latencyTicks: number | null;
  latencyMs: number | null;
  box: Box | null;
  peakDiffPixels: number;
  persists: boolean | null;
  panelFraction: number;
}

// What the device offered this session, and whether the session used it.
// Kept per trace and folded together across traces at drafting time: a
// session with no touch in it says nothing about touch, but two sessions
// where only one had touch say plenty, and computing this per trace and then
// unioning the ABSENCES would have claimed a button was never pressed
// because the second trace did not press it.
interface InputInventory {
  buttons: { index: number; label: string; used: boolean }[];
  sensors: { index: number; name: string; kind: string; used: boolean }[];
  touch: { points: number; used: boolean };
}

interface TraceMeasurement {
  trace: string;
  recordedAt: string;
  events: number;
  ticks: number;
  durationMs: number;
  seed?: number;
  capturePoints: number;
  counterfactualReplays: number;
  affordances: AffordanceMeasurement[];
  panel: {
    w: number;
    h: number;
    format: string;
    background: Rgb;
    paintedBox: Box | null;
    paintedFraction: number;
    everChangedBox: Box | null;
    colourfulFrames: number;
    framesInspected: number;
    maxColourfulPixels: number;
  };
  arena: { usedBytes: number; capacityBytes: number } | null;
  pushLoad: { tickCount: number; maxPushesPerTick: number; maxPushPixelsPerTick: number; meanPushPixelsPerTick: number } | null;
  tick: { msPerTick: number; withTicksMs: number; withoutTicksMs: number; repeats: number };
  firmwareLog: string[];
  inputs: InputInventory;
}

function frameMap(frames: { atMs: number; frame: CapturedFrame }[]): Map<number, CapturedFrame> {
  const map = new Map<number, CapturedFrame>();
  for (const f of frames) map.set(f.atMs, f.frame);
  return map;
}

// Emulator time per tick, by difference rather than by division: a whole
// replay's wall time is mostly instantiation and the first paint, so
// (total / tickCount) would be an answer about module load. Running the same
// trace with its ticks stripped out costs everything BUT the ticks, and the
// gap between the two, over the tick count, is what one tick costs. Both
// numbers are reported, so a reader can see the subtraction.
async function measureTickCost(modulePath: string, events: TraceEvent[], seed: number | undefined, tickCount: number): Promise<TraceMeasurement["tick"]> {
  const withoutTicks = events.filter((e) => e.k !== "tick");
  let withTicksMs = Number.POSITIVE_INFINITY;
  let withoutTicksMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TIMING_REPEATS; i++) {
    let t0 = performance.now();
    await replayEmulator(modulePath, events, [], { seed });
    withTicksMs = Math.min(withTicksMs, performance.now() - t0);
    t0 = performance.now();
    await replayEmulator(modulePath, withoutTicks, [], { seed });
    withoutTicksMs = Math.min(withoutTicksMs, performance.now() - t0);
  }
  const msPerTick = tickCount > 0 ? Math.max(0, withTicksMs - withoutTicksMs) / tickCount : 0;
  return { msPerTick, withTicksMs, withoutTicksMs, repeats: TIMING_REPEATS };
}

async function measureTrace(
  modulePath: string,
  tracePath: string,
  options: { windowTicks: number; persistMs: number; everyMs: number }
): Promise<TraceMeasurement> {
  const trace = readJson<Trace>(tracePath);
  if (!Array.isArray(trace.events) || trace.events.length === 0) die(`${tracePath} carries no events`);
  const timeline = timelineOf(trace.events);
  if (timeline.ts.length === 0) die(`${tracePath} carries no tick events, so nothing in it can be replayed against a clock`);

  // A first, capture-free replay: the device descriptor this module actually
  // declares is what every label and index below is read from, never a pack
  // file, so describing a module whose device disagrees with its pack is
  // possible rather than silently wrong.
  const probe = await replayEmulator(modulePath, trace.events, [], { seed: trace.seed });
  const device = probe.device;

  const occurrences = groupOccurrences(trace.events, device);
  const windows = new Map<Occurrence, Window>();
  const points = new Set<number>();
  for (let ms = timeline.ts[0]!; ms <= timeline.ts[timeline.ts.length - 1]!; ms += options.everyMs) {
    const tick = timeline.ts.find((t) => t >= ms);
    if (tick !== undefined) points.add(tick);
  }
  points.add(timeline.ts[0]!);
  points.add(timeline.ts[timeline.ts.length - 1]!);
  // Sorted by where they start, so "the next affordance" (which caps the
  // persist probe) is the next one in this list rather than the next one the
  // grouper happened to emit: a touch stroke emits three affordances at once,
  // in phase order, not in start order.
  const inOrder = [...occurrences].sort((a, b) => a.firstEventIndex - b.firstEventIndex);
  for (let k = 0; k < inOrder.length; k++) {
    const occ = inOrder[k]!;
    // The next affordance that is not part of the same gesture: a stroke's
    // own drag and release must not cap the contact's probe at zero.
    let next: number | null = null;
    for (let j = k + 1; j < inOrder.length; j++) {
      if (inOrder[j]!.firstEventIndex > occ.lastEventIndex) {
        next = inOrder[j]!.firstEventIndex;
        break;
      }
    }
    const window = windowFor(timeline, occ, next, options.windowTicks, options.persistMs);
    if (!window) continue;
    windows.set(occ, window);
    for (const p of window.points) points.add(p);
    if (window.persistAt !== null) points.add(window.persistAt);
  }
  const capturePoints = [...points].sort((a, b) => a - b);

  const actual = await replayEmulator(modulePath, trace.events, capturePoints, { seed: trace.seed });
  const actualFrames = frameMap(actual.frames);

  // Panel readings, off the whole captured set.
  const first = actualFrames.get(capturePoints[0]!)!;
  const background = backgroundOf(first);
  let paintedBox: Box | null = null;
  let paintedPixels = 0;
  let everChangedBox: Box | null = null;
  let colourfulFrames = 0;
  let maxColourfulPixels = 0;
  for (const ms of capturePoints) {
    const frame = actualFrames.get(ms)!;
    const ink = inkBox(frame, backgroundOf(frame));
    paintedBox = unionBox(paintedBox, ink.box);
    paintedPixels = Math.max(paintedPixels, ink.pixels);
    const colourful = colourfulPixels(frame);
    if (colourful > 0) colourfulFrames++;
    if (colourful > maxColourfulPixels) maxColourfulPixels = colourful;
    if (ms !== capturePoints[0]) {
      everChangedBox = unionBox(everChangedBox, compareFrames(first, frame, 0).diffBox);
    }
  }

  // The differential half: one counterfactual replay per occurrence.
  const byKey = new Map<string, AffordanceMeasurement>();
  let counterfactuals = 0;
  for (const occ of occurrences) {
    const window = windows.get(occ);
    if (!window) continue;
    const removed = new Set(occ.removes);
    const without = trace.events.filter((_, i) => !removed.has(i));
    const cf = await replayEmulator(modulePath, without, capturePoints, { seed: trace.seed });
    counterfactuals++;
    const cfFrames = frameMap(cf.frames);

    const perTick: OccurrenceMeasurement["perTick"] = [];
    let box: Box | null = null;
    let peak = 0;
    let latencyTicks: number | null = null;
    for (let k = 0; k < window.points.length; k++) {
      const ms = window.points[k]!;
      const diff = compareFrames(actualFrames.get(ms)!, cfFrames.get(ms)!, 0);
      perTick.push({ atMs: ms, diffPixels: diff.diffPixels, box: diff.diffBox });
      box = unionBox(box, diff.diffBox);
      if (diff.diffPixels > peak) peak = diff.diffPixels;
      if (latencyTicks === null && diff.diffPixels > 0) latencyTicks = k;
    }
    const persists =
      window.persistAt === null ? null : compareFrames(actualFrames.get(window.persistAt)!, cfFrames.get(window.persistAt)!, 0).diffPixels > 0;
    const measurement: OccurrenceMeasurement = {
      phrase: occ.phrase,
      atMs: occ.atMs,
      endMs: occ.endMs,
      removedEvents: occ.removes.length,
      changed: peak > 0,
      latencyTicks,
      latencyMs: latencyTicks === null ? null : window.points[latencyTicks]! - occ.endMs,
      peakDiffPixels: peak,
      box,
      persistAt: window.persistAt,
      persistNote: window.persistNote,
      persists,
      perTick,
    };

    const existing = byKey.get(occ.key);
    if (existing) {
      existing.occurrences.push(measurement);
    } else {
      byKey.set(occ.key, {
        key: occ.key,
        phrase: occ.phrase,
        input: occ.input,
        occurrences: [measurement],
        changed: false,
        latencyTicks: null,
        latencyMs: null,
        box: null,
        peakDiffPixels: 0,
        persists: false,
        panelFraction: 0,
      });
    }
  }

  const panelPixels = device.panel.w * device.panel.h;
  const affordances = [...byKey.values()].map((a) => {
    const changedOnes = a.occurrences.filter((o) => o.changed);
    const box = a.occurrences.reduce<Box | null>((acc, o) => unionBox(acc, o.box), null);
    const latencies = changedOnes.map((o) => o.latencyTicks!).filter((n) => n !== null);
    return {
      ...a,
      changed: changedOnes.length > 0,
      latencyTicks: latencies.length > 0 ? Math.min(...latencies) : null,
      latencyMs: changedOnes.length > 0 ? Math.min(...changedOnes.map((o) => o.latencyMs!)) : null,
      box,
      peakDiffPixels: Math.max(0, ...a.occurrences.map((o) => o.peakDiffPixels)),
      // "Persists" only when EVERY occurrence that changed anything was still
      // showing its change at its own probe. One that reverted makes the
      // whole line the weaker claim, and one the session could not ask makes
      // it null rather than a guess.
      persists:
        changedOnes.length === 0 || changedOnes.some((o) => o.persists === null)
          ? null
          : changedOnes.every((o) => o.persists === true),
      panelFraction: box ? (box.w * box.h) / panelPixels : 0,
    };
  });

  const inputs: InputInventory = {
    buttons: (device.buttons ?? []).map((_, i) => ({
      index: i,
      label: labelOf(device, i),
      used: occurrences.some((o) => o.input.kind === "button" && o.input.index === i),
    })),
    sensors: (device.sensors ?? []).map((s, i) => ({
      index: i,
      name: sensorNameOf(device, i),
      kind: s.kind,
      used: occurrences.some((o) => o.input.kind === "sensor" && o.input.index === i),
    })),
    touch: { points: device.touch?.points ?? 0, used: trace.events.some((e) => e.k === "touch") },
  };

  const tick = await measureTickCost(modulePath, trace.events, trace.seed, timeline.ts.length);

  return {
    trace: relative(REPO_ROOT, tracePath).replaceAll("\\", "/"),
    recordedAt: trace.recordedAt ?? "unstated",
    events: trace.events.length,
    ticks: timeline.ts.length,
    durationMs: timeline.ts[timeline.ts.length - 1]! - timeline.ts[0]!,
    seed: trace.seed,
    capturePoints: capturePoints.length,
    counterfactualReplays: counterfactuals,
    affordances,
    panel: {
      w: device.panel.w,
      h: device.panel.h,
      format: device.panel.format,
      background,
      paintedBox,
      paintedFraction: paintedBox ? (paintedBox.w * paintedBox.h) / panelPixels : 0,
      everChangedBox,
      colourfulFrames,
      framesInspected: capturePoints.length,
      maxColourfulPixels,
    },
    arena: actual.arena ?? null,
    pushLoad: actual.pushStats ?? null,
    tick,
    firmwareLog: actual.log,
    inputs,
  };
}

// ---- drafting ------------------------------------------------------------

function boxPhrase(box: Box | null): string {
  if (!box) return "no pixels at all";
  return `${box.w} by ${box.h} pixels at x ${box.x}, y ${box.y}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const INTENT_TODO = "intent: TODO, say what this affordance is FOR, not what it does";

// One affordance, however many sessions it appeared in. Merged before the
// Interactions section is written, so two traces that both press PWR produce
// one line backed by both, never two lines that a reader has to reconcile.
function mergeAffordances(measurements: TraceMeasurement[]): AffordanceMeasurement[] {
  const byKey = new Map<string, AffordanceMeasurement>();
  for (const trace of measurements) {
    for (const a of trace.affordances) {
      const existing = byKey.get(a.key);
      if (!existing) {
        byKey.set(a.key, { ...a, occurrences: [...a.occurrences] });
        continue;
      }
      existing.occurrences.push(...a.occurrences);
      existing.changed = existing.changed || a.changed;
      existing.box = unionBox(existing.box, a.box);
      existing.peakDiffPixels = Math.max(existing.peakDiffPixels, a.peakDiffPixels);
      existing.panelFraction = Math.max(existing.panelFraction, a.panelFraction);
      const latencies = [existing.latencyTicks, a.latencyTicks].filter((n): n is number => n !== null);
      existing.latencyTicks = latencies.length > 0 ? Math.min(...latencies) : null;
      const msList = [existing.latencyMs, a.latencyMs].filter((n): n is number => n !== null);
      existing.latencyMs = msList.length > 0 ? Math.min(...msList) : null;
      existing.persists = existing.persists === null || a.persists === null ? null : existing.persists && a.persists;
    }
  }
  return [...byKey.values()];
}

function interactionLine(a: AffordanceMeasurement): string {
  const times = `over ${a.occurrences.length} occurrence(s)`;
  if (!a.changed) {
    return `- ${a.phrase} changes nothing the app would not have changed anyway, ${times}. (${INTENT_TODO}.)`;
  }
  const latency = a.latencyMs === 0 ? "in the same tick that receives it" : `${a.latencyTicks} tick(s) later (${a.latencyMs}ms)`;
  const probe = a.occurrences.find((o) => o.persistAt !== null);
  const staying =
    a.persists === null
      ? "and this session cannot say whether the change stayed, because something else happened before the probe could look"
      : a.persists
        ? `and the change is still there at the later probe${probe?.persistNote ? ` (${probe.persistNote})` : ""}`
        : `and by the later probe the panel is back to what it would have shown anyway${probe?.persistNote ? ` (${probe.persistNote})` : ""}`;
  return `- ${a.phrase} redraws ${boxPhrase(a.box)}, ${pct(a.panelFraction)} of the panel, first visible ${latency}, ${staying}. Measured ${times}, peak ${a.peakDiffPixels} pixels different from the same session with this input removed. (${INTENT_TODO}.)`;
}

// Everything the device declared that these sessions leave unanswered. Folded
// across every trace: an input is unexercised only when NO session used it.
function unexercisedLines(measurements: TraceMeasurement[], affordances: AffordanceMeasurement[]): string[] {
  const out: string[] = [];
  const first = measurements[0]!.inputs;
  for (const b of first.buttons) {
    if (measurements.some((m) => m.inputs.buttons[b.index]?.used)) continue;
    out.push(`${b.label}: declared by the device and never pressed in any of these sessions`);
  }
  for (const s of first.sensors) {
    if (measurements.some((m) => m.inputs.sensors[s.index]?.used)) continue;
    out.push(`${s.name} (${s.kind}): declared by the device and never delivered in any of these sessions`);
  }
  if (first.touch.points > 0 && !measurements.some((m) => m.inputs.touch.used)) {
    out.push(`touch: the device declares ${first.touch.points} point(s) and no session contains a touch event`);
  }
  for (const a of affordances) {
    if (!a.changed) out.push(`${a.phrase}: happened ${a.occurrences.length} time(s) and changed no pixel the app would not have changed anyway`);
  }
  return out;
}

// The Demands block, built only out of what was measured. Every field here
// has a matching line in the JSON saying which measurement produced it.
function draftDemands(m: TraceMeasurement[], affordances: AffordanceMeasurement[], device: DeviceJson): { demands: Demands; memorySource: string } {
  const panelBox = m.reduce<Box | null>((acc, t) => unionBox(acc, t.panel.paintedBox), null);
  const colour = m.some((t) => t.panel.maxColourfulPixels > 0);

  const buttons: DemandButton[] = [];
  const seenButton = new Set<string>();
  const sensors: DemandSensor[] = [];
  const seenSensor = new Set<string>();
  let touchPoints = 0;
  // Only an input that was used AND measurably changed the panel earns a
  // demand. A control the session pressed to no effect is a control this app
  // does not need, as far as this session can tell, and it is named under
  // Interactions instead of quietly listed here.
  for (const a of affordances) {
    if (!a.changed) continue;
    if (a.input.kind === "button") {
      // The device answered this press with a short/long verdict, which is
      // what docs/convention/device-pack.md says a `key` delivers and a
      // `click` does not. The role comes out of the trace, not out of the
      // pack file, so a module whose buttons disagree with its pack is
      // described as it behaved.
      const role = a.input.press === "click" ? "click" : "key";
      if (seenButton.has(role + a.input.index)) continue;
      seenButton.add(role + a.input.index);
      buttons.push({ role, why: `${a.phrase} redraws ${boxPhrase(a.box)}. TODO, say why this control has to exist` });
    } else if (a.input.kind === "touch") {
      touchPoints = 1;
    } else {
      const kind = a.input.signal;
      if (seenSensor.has(kind)) continue;
      seenSensor.add(kind);
      sensors.push({ kind, why: `${a.phrase} redraws ${boxPhrase(a.box)}. TODO, say why this signal has to exist` });
    }
  }

  const arena = m.find((t) => t.arena !== null)?.arena ?? null;
  const declared = device.budget?.ram?.bytes;
  const memorySource = arena
    ? `the module's own emu_arena_used() after the session (${arena.usedBytes} of ${arena.capacityBytes} bytes)`
    : declared !== undefined
      ? `the pack's device.json budget.ram.bytes (${declared}), because this module exports no emu_arena_used()`
      : "nothing: this module exports no emu_arena_used() and the pack declares no budget.ram.bytes";

  const msPerTick = Math.max(...m.map((t) => t.tick.msPerTick));

  const demands: Demands = {
    convention: "0.1",
    panel: {
      minW: panelBox?.w ?? 0,
      minH: panelBox?.h ?? 0,
      orientation: "either",
      color: colour,
    },
    buttons,
    touch: { points: touchPoints },
    sensors,
    ...(arena ? { memory: { baseBytes: arena.usedBytes } } : {}),
    tick: { needsMs: Math.max(1, Math.ceil(msPerTick)) },
  };
  return { demands, memorySource };
}

function essenceScaffold(m: TraceMeasurement[]): string[] {
  const bullets: string[] = [];
  const p = m[0]!.panel;
  const panelPixels = p.w * p.h;
  bullets.push(`Panel: ${p.w} by ${p.h}, format ${p.format}, as the module's own emu_device() declares it.`);
  bullets.push(`Background: rgb(${p.background.join(", ")}), the most common colour in the first captured frame.`);
  const painted = m.reduce<Box | null>((acc, t) => unionBox(acc, t.panel.paintedBox), null);
  bullets.push(
    `Everything ever drawn on top of that background fits in ${boxPhrase(painted)}, ${pct(painted ? (painted.w * painted.h) / panelPixels : 0)} of the panel.`
  );
  const changed = m.reduce<Box | null>((acc, t) => unionBox(acc, t.panel.everChangedBox), null);
  bullets.push(
    `The part that ever changed after the first frame is ${boxPhrase(changed)}, ${pct(changed ? (changed.w * changed.h) / panelPixels : 0)} of the panel: everything outside it was painted once and left alone.`
  );
  bullets.push(
    m.some((t) => t.panel.maxColourfulPixels > 0)
      ? `Colour is used: up to ${Math.max(...m.map((t) => t.panel.maxColourfulPixels))} pixels in one frame had unequal r, g and b.`
      : "No frame in any of these sessions held a single pixel whose r, g and b differed: the app painted in greys only."
  );
  const push = m.find((t) => t.pushLoad)?.pushLoad;
  if (push) {
    bullets.push(
      `Panel pushes: at most ${push.maxPushesPerTick} per tick, at most ${push.maxPushPixelsPerTick} pixels in one tick, ${Math.round(push.meanPushPixelsPerTick)} on average, over ${push.tickCount} ticks.`
    );
  }
  // The firmware's own console, verbatim. It is the app talking about itself,
  // which is worth having in front of whoever writes the paragraph, and it is
  // the one thing on this page that is prose rather than measurement, so it
  // is quoted and attributed rather than folded into a sentence.
  const said = new Set<string>();
  for (const trace of m) {
    for (const line of trace.firmwareLog) {
      const clean = line.trim();
      if (clean) said.add(clean);
    }
  }
  for (const line of said) bullets.push(`The firmware said this on its own console, unprompted: "${line}"`);
  return bullets;
}

function renderDraft(args: {
  app: string;
  moduleLabel: string;
  moduleFrom: string;
  pack: string;
  devicePath: string;
  measurements: TraceMeasurement[];
  affordances: AffordanceMeasurement[];
  demands: Demands;
  memorySource: string;
  generatedAt: string;
  jsonName: string;
}): string {
  const lines: string[] = [];
  const rel = (p: string) => relative(REPO_ROOT, p).replaceAll("\\", "/");

  lines.push(`# ${args.app}: a descriptor drafted from a recorded session`);
  lines.push("");
  lines.push(
    "**Draft. Measured, not written.** `bun run describe` produced this by replaying the sessions named below against the module named below and " +
      "measuring what changed, then diffing every input against the same session with that input removed. It is not a descriptor: " +
      "`descriptor.md` is written by a person or a model, out of this. Nothing here overwrites one."
  );
  lines.push("");
  lines.push(`- module: \`${args.moduleLabel}\` (${args.moduleFrom})`);
  lines.push(`- pack: \`${args.pack}\`, whose \`${rel(args.devicePath)}\` is what the memory and tick numbers are held against`);
  for (const m of args.measurements) {
    lines.push(`- session: \`${m.trace}\`, recorded ${m.recordedAt}, ${m.events} events, ${m.ticks} ticks, ${m.durationMs}ms, ${m.counterfactualReplays} counterfactual replays`);
  }
  lines.push(`- drafted: ${args.generatedAt}`);
  lines.push(`- every number below, with the frames and diffs behind it: \`${args.jsonName}\``);
  lines.push("");

  lines.push("## Essence");
  lines.push("");
  lines.push("**DRAFT, WRITE THE PROSE.** A replay can measure what is on the panel and cannot say what the app IS. What follows is the scaffold of observed facts a paragraph would be built from, and it is deliberately not a paragraph.");
  lines.push("");
  for (const bullet of essenceScaffold(args.measurements)) lines.push(`- ${bullet}`);
  lines.push("");

  lines.push("## Interactions");
  lines.push("");
  lines.push(
    "Each line names the input and the measured result. The result is the difference between this session and the same session with that one input removed, so it is what the input caused rather than what the app was doing anyway. Every `(intent: ...)` is a TODO on purpose: the intent is what a porter needs when the target has no such control (see `docs/convention/app-bundle.md`, \"Affordances carry their intent\"), and a replay cannot see it."
  );
  lines.push("");
  if (args.affordances.length === 0) {
    lines.push("- Nothing. These sessions contain no input event at all, so this draft states no interaction.");
  }
  for (const a of args.affordances) lines.push(interactionLine(a));
  lines.push("");
  const unexercised = unexercisedLines(args.measurements, args.affordances);
  if (unexercised.length > 0) {
    lines.push("What these sessions never exercised, so nothing above covers it:");
    lines.push("");
    for (const u of unexercised) lines.push(`- ${u}`);
    lines.push("");
  }

  lines.push("## Demands");
  lines.push("");
  lines.push("Measured, with the reach of each number stated. A person has to read all four of these before this block is published:");
  lines.push("");
  lines.push(
    `- **Panel.** \`minW\`/\`minH\` is the extent the app ACTUALLY PAINTED, ${boxPhrase(args.measurements.reduce<Box | null>((acc, m) => unionBox(acc, m.panel.paintedBox), null))} of a ${args.measurements[0]!.panel.w} by ${args.measurements[0]!.panel.h} panel. ` +
      "The convention's `minW`/`minH` is the size at which the app is still ITSELF, which is a judgement, not an observation, and is usually smaller than this. There is no `scalesTo` here for the same reason: one session at one size cannot find it."
  );
  lines.push(
    `- **Colour.** \`color\` is true when any captured frame held a pixel whose r, g and b differed. Here: ${args.demands.panel!.color ? "it did" : "no frame did"}. This is the question that refuses an app on a monochrome panel, and it is answerable from pixels.`
  );
  lines.push(
    "- **Buttons and sensors.** One entry per control that was used AND measurably changed the panel. A control the session never touched is not here, and neither is one that changed nothing: both are listed under Interactions above rather than guessed at. Each `why` is a TODO."
  );
  lines.push(`- **Memory and tick.** \`memory.baseBytes\` came from ${args.memorySource}. \`tick.needsMs\` is EMULATOR time per tick on the machine that drafted this (${args.measurements.map((m) => m.tick.msPerTick.toFixed(3)).join(", ")}ms, by subtracting a tick-free replay from a full one, best of ${args.measurements[0]!.tick.repeats}), NOT a frame's cost on the board. Replace it with a device measurement before publishing. There is no \`refuseUnderMs\`: the floor below which the app stops being itself is a judgement.`);
  lines.push("");
  lines.push("```json demands");
  lines.push(JSON.stringify(args.demands, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

// ---- module resolution ---------------------------------------------------

// A `.c` is built through the pack's own `wasm/build.ts --app`, exactly the
// way tools/verify-bundle.ts builds a port, so describing a port and
// verifying one cannot disagree about what "the module" means. A `.wasm` is
// taken as given: an already-built module (site/dist/modules/, a pack's own
// output) describes without a toolchain at all, which is what makes this
// runnable in a test.
function resolveModule(input: string, packPath: string, buildArgs: string[]): { path: string; label: string; from: string; temporary: boolean } {
  const abs = resolve(REPO_ROOT, input);
  if (!existsSync(abs)) die(`no such file: ${abs}`);
  if (abs.endsWith(".wasm")) return { path: abs, label: relative(REPO_ROOT, abs).replaceAll("\\", "/"), from: "given already built", temporary: false };
  if (!abs.endsWith(".c")) die(`${input} is neither a .wasm module nor a .c source file`);

  const buildScript = join(REPO_ROOT, packPath, "wasm", "build.ts");
  if (!existsSync(buildScript)) die(`the pack has no wasm/build.ts at ${buildScript}, so a .c cannot be built for it`);
  const zig = process.env.ZIG_EXE;
  const args = ["--app", abs, ...buildArgs];
  console.error(`describe: building ${relative(REPO_ROOT, abs)} through ${relative(REPO_ROOT, buildScript)}`);
  const built = Bun.spawnSync(["bun", "run", buildScript, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: zig ? { ...process.env, ZIG_EXE: zig } : process.env,
  });
  if (!built.success) {
    const tail = [built.stdout.toString(), built.stderr.toString()].join("\n").trim().split("\n").slice(-20).join("\n");
    die(`the pack build failed (exit ${built.exitCode}): bun run ${buildScript} ${args.join(" ")}\n${tail}`);
  }
  const out = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
  if (!existsSync(out)) die(`${buildScript} exited 0 and wrote no ${out}`);
  // Copied out of the shared build output, because a second build (another
  // app, another test, a live dev server rebuilding) would otherwise replace
  // the module out from under the counterfactual replays.
  const copy = join(REPO_ROOT, "wasm", "dist", `describe-${process.pid}.wasm`);
  copyFileSync(out, copy);
  return {
    path: copy,
    label: relative(REPO_ROOT, abs).replaceAll("\\", "/"),
    from: `built for this run through ${relative(REPO_ROOT, join(packPath, "wasm", "build.ts")).replaceAll("\\", "/")}${buildArgs.length > 0 ? ` ${buildArgs.join(" ")}` : ""}`,
    temporary: true,
  };
}

// ---- run -----------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const traces: string[] = [];
  const buildArgs: string[] = [];
  let pack = "";
  let outDir = "";
  let everyMs = DEFAULT_EVERY_MS;
  let windowTicks = DEFAULT_WINDOW_TICKS;
  let persistMs = DEFAULT_PERSIST_MS;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--pack") pack = next();
    else if (arg === "--trace") traces.push(next());
    else if (arg === "--out") outDir = next();
    else if (arg === "--every") everyMs = Number(next());
    else if (arg === "--window") windowTicks = Number(next());
    else if (arg === "--persist") persistMs = Number(next());
    else if (arg === "--build-arg") buildArgs.push(next());
    else if (arg.startsWith("--")) die(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1 || pack === "" || traces.length === 0) {
    console.error("usage: bun run describe <app-port.c | module.wasm> --pack <pack> --trace <trace.json> [--trace ...] [--out <dir>]");
    console.error("       [--every <ms>] [--window <ticks>] [--persist <ms>] [--build-arg <flag>]");
    process.exit(EXIT_INFRA);
  }

  const registry = readJson<Registry>(join(REPO_ROOT, "registry.json"));
  const packEntry = [...registry.packs, ...(registry.silhouettes ?? [])].find((p) => p.name === pack && p.path);
  if (!packEntry?.path) {
    const known = [...registry.packs, ...(registry.silhouettes ?? [])].filter((p) => p.path).map((p) => p.name).join(", ");
    die(`no pack or silhouette "${pack}" in registry.json. Known: ${known}`);
  }
  const devicePath = join(REPO_ROOT, packEntry.path, "device.json");
  if (!existsSync(devicePath)) die(`${packEntry.path} has no device.json`);
  const device = readJson<DeviceJson>(devicePath);

  const module_ = resolveModule(positional[0]!, packEntry.path, buildArgs);
  const tracePaths = traces.map((t) => {
    const abs = resolve(REPO_ROOT, t);
    if (!existsSync(abs)) die(`no such trace: ${abs}`);
    return abs;
  });

  const measurements: TraceMeasurement[] = [];
  for (const tracePath of tracePaths) {
    console.error(`describe: replaying ${relative(REPO_ROOT, tracePath).replaceAll("\\", "/")}`);
    measurements.push(await measureTrace(module_.path, tracePath, { windowTicks, persistMs, everyMs }));
  }

  const affordances = mergeAffordances(measurements);
  const { demands, memorySource } = draftDemands(measurements, affordances, device);
  // The app's name is the bundle directory the traces live under when there
  // is one, and the trace's own stem otherwise. Nothing here reads a
  // bundle.json: describe answers "what does this module do", which is a
  // question about a module and a session, not about a published bundle.
  const traceDir = dirname(tracePaths[0]!);
  const app = /apps[\\/]([^\\/]+)[\\/]/.test(tracePaths[0]!.replaceAll("\\", "/") + "/")
    ? tracePaths[0]!.replaceAll("\\", "/").split("/apps/")[1]!.split("/")[0]!
    : "app";
  const target = outDir === "" ? traceDir : resolve(REPO_ROOT, outDir);
  mkdirSync(target, { recursive: true });
  const mdPath = join(target, "descriptor.draft.md");
  const jsonPath = join(target, "descriptor.draft.json");
  const generatedAt = new Date().toISOString().slice(0, 10);

  const markdown = renderDraft({
    app,
    moduleLabel: module_.label,
    moduleFrom: module_.from,
    pack,
    devicePath,
    measurements,
    affordances,
    demands,
    memorySource,
    generatedAt,
    jsonName: "descriptor.draft.json",
  });
  writeFileSync(mdPath, markdown, "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        tool: "tools/describe.ts",
        convention: "0.1",
        note: "Every claim in descriptor.draft.md is one of these measurements. A frame diff here is this session against the same session with one input removed, at tolerance zero.",
        generatedAt,
        app,
        module: { path: module_.label, from: module_.from },
        pack: { name: pack, deviceJson: relative(REPO_ROOT, devicePath).replaceAll("\\", "/") },
        settings: { everyMs, windowTicks, persistMs, timingRepeats: TIMING_REPEATS, tolerance: 0 },
        demands,
        memorySource,
        affordances,
        unexercised: unexercisedLines(measurements, affordances),
        traces: measurements,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // The build copy is scratch, and leaving it behind would put a module
  // nobody can account for next to wasm/dist/emu.wasm.
  if (module_.temporary) rmSync(module_.path, { force: true });

  console.log(`describe: wrote ${relative(REPO_ROOT, mdPath).replaceAll("\\", "/")}`);
  console.log(`describe: wrote ${relative(REPO_ROOT, jsonPath).replaceAll("\\", "/")}`);
  for (const m of measurements) {
    console.log(`  ${m.trace}: ${m.affordances.length} affordance(s), ${m.affordances.filter((a) => a.changed).length} of them changed the panel, ${m.counterfactualReplays} counterfactual replays`);
  }
  process.exit(EXIT_OK);
}

export { measureTrace, draftDemands, groupOccurrences, timelineOf, backgroundOf, inkBox, unionBox };
export type { TraceMeasurement, AffordanceMeasurement, Box };
