// A regression check that needs no hardware: "did this firmware change
// break something that used to work", answered against nothing but the
// emulator itself.
//
// A baseline is the recorded input trace plus the frames captured at a
// handful of points along it (see pickCapturePoints below) - the same
// ingredients docs/harness.md's differential harness already uses, reused
// here rather than forked (see src/replayCore.ts's header comment). Saving
// one calls captureBaseline(); checking the current module against it
// calls checkAgainstBaseline(), which replays the SAME trace through
// src/replayCore.ts's replayFromBytes and diffs the result against the
// saved frames with src/compare.ts's compareFrames - the exact function
// the differential harness's own CLI and self-test use.
//
// BE HONEST ABOUT WHAT THIS PROVES: this compares the emulator against
// itself, at two points in time (when the baseline was saved, and now). It
// catches a firmware regression - the same input now draws something
// different than it used to. It says NOTHING about whether the emulator
// still agrees with real hardware, and nothing about timing: exactly the
// same bound docs/harness.md states for the differential harness, minus
// even the "compared against a real board" half. See docs/harness.md's "A
// regression check with no hardware" section for the full statement of
// this.
//
// Where a baseline actually lives: server.ts's /api/baseline route persists
// it to baselines/latest/ on disk (baselineStore.ts), specifically so it
// survives a live reload - the page reloading is exactly the moment this
// question gets asked, and an in-memory baseline would be gone by then.
// This file only holds the pure replay/compare/serialize logic; main.ts
// wires it to the "baseline" and "check" buttons and the two fetch() calls
// that persist through the server.

import { replayFromBytes } from "./replayCore";
import { compareFrames } from "./compare";
import type { CapturedFrame } from "./frame";
import type { DeviceDescriptor } from "./wasm";
import type { TraceEvent } from "./recorder";

export interface BaselineFrame {
  atMs: number;
  width: number;
  height: number;
  rgbBase64: string;
}

export interface BaselineBundle {
  schemaVersion: 1;
  capturedAt: string;
  device: DeviceDescriptor;
  events: TraceEvent[];
  capturePoints: number[];
  frames: BaselineFrame[];
}

export interface RegressionPointResult {
  atMs: number;
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  firstDiffAt: { x: number; y: number } | null;
  maxChannelDelta: number;
}

export interface RegressionCheck {
  pass: boolean;
  points: RegressionPointResult[];
  // Full frames for every capture point, both sides, plus a diff heatmap
  // for points that diverged - kept around so a caller (the in-page
  // result panel, the agent-loop export) can show or save exactly what
  // changed without replaying anything a second time.
  baselineFrames: { atMs: number; frame: CapturedFrame }[];
  currentFrames: { atMs: number; frame: CapturedFrame }[];
  diffImages: { atMs: number; rgb: Uint8Array }[]; // one entry per diverging point only
}

// btoa/atob operate on a "binary string" (one JS char per byte); both are
// real globals in a browser AND in Bun (verified - this file is imported
// directly by test/regression/run.ts, a plain Bun script, with no DOM).
// String.fromCharCode(...bytes) blows the call stack on a large typed
// array (a panel frame is easily >60k elements), so this chunks it rather
// than spreading the whole array at once.
const BASE64_CHUNK = 0x8000;
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Evenly samples up to `max` capture points across a trace's own tick
// timestamps, always keeping the last one (the trace's final state, "does
// the end state match" - the same default harness/diff.ts falls back to
// when neither --at nor --every narrows it). A short trace (fewer ticks
// than `max`) just captures every tick. A long one (a session left running
// a while before "baseline" was clicked) is capped, both to bound the
// baseline's own disk size - each frame is a few hundred KB - and because
// most ticks in a long session carry no new information for a regression
// check anyway.
export function pickCapturePoints(tickTimes: number[], max: number): number[] {
  if (tickTimes.length === 0) return [];
  if (tickTimes.length <= max) return [...tickTimes];
  const points: number[] = [];
  const step = (tickTimes.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    points.push(tickTimes[Math.round(i * step)]!);
  }
  return [...new Set(points)]; // rounding can collide for ticks packed close together
}

const DEFAULT_MAX_CAPTURE_POINTS = 8;

// Replays `events` once against `wasmBytes` (a fresh module instance,
// never the page's own live, ticking one - see src/replayCore.ts) and
// packages the result as a baseline: the trace itself plus a frame at each
// chosen capture point, base64-encoded so the whole thing is one JSON
// object a server route can persist verbatim.
export async function captureBaseline(wasmBytes: ArrayBuffer, events: TraceEvent[], maxCapturePoints = DEFAULT_MAX_CAPTURE_POINTS): Promise<BaselineBundle> {
  const tickTimes = events.filter((e) => e.k === "tick").map((e) => e.t);
  const capturePoints = pickCapturePoints(tickTimes, maxCapturePoints);
  if (capturePoints.length === 0) {
    throw new Error("nothing to baseline: the recorded trace has no tick events yet");
  }
  const replay = await replayFromBytes(wasmBytes, events, capturePoints);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    device: replay.device,
    events,
    capturePoints,
    frames: replay.frames.map((f) => ({ atMs: f.atMs, width: f.frame.width, height: f.frame.height, rgbBase64: bytesToBase64(f.frame.rgb) })),
  };
}

// Replays the baseline's OWN trace, at the baseline's OWN capture points,
// against `wasmBytes` (the currently loaded module - could be a fresh
// rebuild, could be unchanged), and diffs every resulting frame against
// what the baseline says used to be there. tolerance mirrors
// harness/diff.ts's own --tolerance: 0 (exact match) unless a caller has a
// reason to allow noise.
export async function checkAgainstBaseline(wasmBytes: ArrayBuffer, baseline: BaselineBundle, tolerance = 0): Promise<RegressionCheck> {
  const replay = await replayFromBytes(wasmBytes, baseline.events, baseline.capturePoints);
  const baselineFrames = baseline.frames.map((f) => ({ atMs: f.atMs, frame: { width: f.width, height: f.height, rgb: base64ToBytes(f.rgbBase64) } }));
  const byAtMs = new Map(baselineFrames.map((f) => [f.atMs, f.frame]));

  const points: RegressionPointResult[] = [];
  const diffImages: { atMs: number; rgb: Uint8Array }[] = [];
  for (const cur of replay.frames) {
    const base = byAtMs.get(cur.atMs);
    if (!base) {
      // Should not happen (replayFromBytes was driven by baseline.capturePoints
      // itself), but a missing point is reported as a divergence rather than
      // silently skipped - the same "never trust and stay quiet" instinct
      // src/panel.ts's readPushes applies to raw ABI output.
      points.push({ atMs: cur.atMs, match: false, diffPixels: -1, totalPixels: cur.frame.width * cur.frame.height, firstDiffAt: null, maxChannelDelta: 255 });
      continue;
    }
    const d = compareFrames(base, cur.frame, tolerance);
    points.push({ atMs: cur.atMs, match: d.match, diffPixels: d.diffPixels, totalPixels: d.totalPixels, firstDiffAt: d.firstDiffAt, maxChannelDelta: d.maxChannelDelta });
    if (!d.match && d.diffImage) diffImages.push({ atMs: cur.atMs, rgb: d.diffImage });
  }

  // points.every() on an empty array is vacuously true: a baseline whose
  // trace produced zero capture points (a malformed baseline, an empty
  // capturePoints array) must never read as "pass", which is exactly what
  // Array.prototype.every() would report with nothing to check.
  return { pass: points.length > 0 && points.every((p) => p.match), points, baselineFrames, currentFrames: replay.frames, diffImages };
}

export interface RegressionResultPayload {
  schemaVersion: 1;
  checkedAt: string;
  pass: boolean;
  device: DeviceDescriptor;
  // Same shape as a freeze bundle's own `input` field (src/freeze.ts): the
  // exact input that provoked (or didn't) the divergence, so an agent
  // already used to reading freezes/latest/bundle.json recognises this
  // immediately.
  input: TraceEvent[];
  points: RegressionPointResult[];
  // Only for points that diverged: the frame that used to be right (the
  // baseline), the frame that is wrong now (the current module), and the
  // diff heatmap between them - the three things docs/agent-loop.md's
  // freeze bundle already treats as what an agent needs at least as much
  // as the pixels themselves.
  diverged: {
    atMs: number;
    width: number;
    height: number;
    baselineRgbBase64: string;
    currentRgbBase64: string;
    diffRgbBase64: string | null;
  }[];
}

// Packages a RegressionCheck for export, in the shape server.ts's
// /api/regression-result route writes to regressions/latest/ - see
// docs/agent-loop.md's "A failed regression check, for an agent" section.
export function toRegressionResultPayload(baseline: BaselineBundle, check: RegressionCheck): RegressionResultPayload {
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    pass: check.pass,
    device: baseline.device,
    input: baseline.events,
    points: check.points,
    diverged: check.points
      .filter((p) => !p.match)
      .map((p) => {
        const base = check.baselineFrames.find((f) => f.atMs === p.atMs)!.frame;
        const cur = check.currentFrames.find((f) => f.atMs === p.atMs)!.frame;
        const diff = check.diffImages.find((d) => d.atMs === p.atMs);
        return {
          atMs: p.atMs,
          width: cur.width,
          height: cur.height,
          baselineRgbBase64: bytesToBase64(base.rgb),
          currentRgbBase64: bytesToBase64(cur.rgb),
          diffRgbBase64: diff ? bytesToBase64(diff.rgb) : null,
        };
      }),
  };
}

// ---- the in-page result panel: a visual diff, not just a count ----------
//
// The person's next question after "something changed" is always "show me
// where" (see this feature's own spec). One small modal, reusing the same
// .modalov/.modalbox shell src/freeze.ts's annotation modal already
// established: a labelled pill per capture point, and for anything that
// diverged, the baseline frame, the current frame and the diff heatmap
// side by side, at native pixel size. No prose beyond the pill's own count
// - the images are the argument.

function frameCanvas(frame: CapturedFrame): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(frame.width, frame.height);
  for (let i = 0, di = 0; i < frame.rgb.length; i += 3, di += 4) {
    img.data[di] = frame.rgb[i]!;
    img.data[di + 1] = frame.rgb[i + 1]!;
    img.data[di + 2] = frame.rgb[i + 2]!;
    img.data[di + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function frameThumb(frame: CapturedFrame, label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "regression-thumb";
  wrap.appendChild(frameCanvas(frame));
  const cap = document.createElement("div");
  cap.className = "regression-thumb-label";
  cap.textContent = label;
  wrap.appendChild(cap);
  return wrap;
}

export function openRegressionModal(check: RegressionCheck): Promise<void> {
  return new Promise((resolve) => {
    const overlayEl = document.createElement("div");
    overlayEl.className = "modalov";

    const box = document.createElement("div");
    box.className = "modalbox regression-modal";
    overlayEl.appendChild(box);

    const failCount = check.points.filter((p) => !p.match).length;
    const title = document.createElement("div");
    title.className = "regression-modal-title";
    title.innerHTML = check.pass
      ? `<b>regression check: pass</b> <span class="hint">${check.points.length} capture point(s), against the emulator only - see docs/harness.md</span>`
      : `<b>regression check: ${failCount}/${check.points.length} capture point(s) diverged</b>`;
    box.appendChild(title);

    for (const p of check.points) {
      const row = document.createElement("div");
      row.className = "regression-row";
      const label = document.createElement("span");
      label.className = `pill status ${p.match ? "ok" : "fail"}`;
      label.textContent = p.match ? `t=${p.atMs}ms match` : `t=${p.atMs}ms  ${p.diffPixels}/${p.totalPixels}px`;
      row.appendChild(label);

      if (!p.match) {
        const base = check.baselineFrames.find((f) => f.atMs === p.atMs);
        const cur = check.currentFrames.find((f) => f.atMs === p.atMs);
        const diff = check.diffImages.find((d) => d.atMs === p.atMs);
        const imgs = document.createElement("div");
        imgs.className = "regression-imgs";
        if (base) imgs.appendChild(frameThumb(base.frame, "baseline"));
        if (cur) imgs.appendChild(frameThumb(cur.frame, "current"));
        if (diff && cur) imgs.appendChild(frameThumb({ width: cur.frame.width, height: cur.frame.height, rgb: diff.rgb }, "diff"));
        row.appendChild(imgs);
      }
      box.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.className = "regression-modal-actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn sec sm";
    closeBtn.textContent = "close";
    closeBtn.addEventListener("click", () => {
      overlayEl.remove();
      resolve();
    });
    actions.appendChild(closeBtn);
    box.appendChild(actions);

    document.body.appendChild(overlayEl);
  });
}
