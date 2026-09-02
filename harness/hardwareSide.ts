// Replays a trace against real hardware, through whatever HardwareLink your
// adapter implements. Unlike the emulator side (emulatorSide.ts), this
// cannot be instant: real hardware runs on its own clock regardless of
// what a trace's recorded timestamps say, so this paces input events in
// real wall-clock time, at the same relative spacing they were originally
// recorded at, and hopes the board's own timing-sensitive behaviour (if
// any) lines up closely enough to be useful. See docs/harness.md for what
// this can and cannot prove.
//
// "tick" events in the trace are NOT sent to the hardware: emu_tick(nowMs)
// is an emulator-only concept (the module's synthetic clock). They are
// still used as pacing/capture-point anchors, since they're what the
// trace's own timestamps are built around.

import type { CapturedFrame, HardwareLink, TraceEvent } from "./types";
// Type-only, so this file stays exactly as browser-safe as it already was
// (site/attest/run.ts bundles it into a page): the same convention
// harness/invariantTypes.ts uses to name PushLoadStats without importing
// anything but its shape.
import type { PushLoadStats } from "../src/replayCore";

export interface HardwareReplayResult {
  frames: { atMs: number; frame: CapturedFrame }[];
  // Present only when the link answered every PUSHSTATS query this replay
  // made (see link.pushStats() on HardwareLink) - absent the moment a board
  // says ERR even once, since a partial aggregate would understate the
  // worst window without saying so. Each capture point brackets one
  // window ("since the last SHOT" - tools/README-devlink.md's PUSHSTATS
  // section), so tickCount here counts WINDOWS, not firmware ticks: a
  // window between two far-apart captures can contain many real ticks,
  // which makes this a coarser, more conservative reading than the
  // emulator's own per-tick figure, never a more lenient one.
  pushStats?: PushLoadStats;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function replayHardware(link: HardwareLink, events: TraceEvent[], capturePoints: number[]): Promise<HardwareReplayResult> {
  await link.connect();
  try {
    if (link.reset) await link.reset();

    const sortedPoints = [...capturePoints].sort((a, b) => a - b);
    const frames: HardwareReplayResult["frames"] = [];

    // Queried right before each screenshot, never after: SHOT is what
    // resets the board's own counters (tools/README-devlink.md), so asking
    // first reads "since the PREVIOUS screenshot" - exactly the window
    // that just elapsed. Stops asking for good the first time the board
    // answers null (does not support it, or fell behind an older
    // firmware): a mix of real and missing windows would be silently
    // incomplete rather than honestly absent.
    let pushStatsSupported = typeof link.pushStats === "function";
    const pushWindows: { pushes: number; pixels: number }[] = [];
    async function captureFrame(atMs: number): Promise<void> {
      if (pushStatsSupported) {
        const stats = await link.pushStats!();
        if (stats) pushWindows.push(stats);
        else pushStatsSupported = false;
      }
      frames.push({ atMs, frame: await link.screenshot() });
    }

    if (events.length === 0) {
      for (const p of sortedPoints) await captureFrame(p);
      return { frames, pushStats: summarisePushWindows(pushStatsSupported, pushWindows) };
    }

    const wallStart = Date.now();
    const traceStart = events[0]!.t;
    let capIdx = 0;

    for (const ev of events) {
      const targetWall = wallStart + (ev.t - traceStart);
      await sleep(targetWall - Date.now());
      if (ev.k !== "tick") await link.send(ev);
      while (capIdx < sortedPoints.length && sortedPoints[capIdx]! <= ev.t) {
        await captureFrame(sortedPoints[capIdx]!);
        capIdx++;
      }
    }
    while (capIdx < sortedPoints.length) {
      const targetWall = wallStart + (sortedPoints[capIdx]! - traceStart);
      await sleep(targetWall - Date.now());
      await captureFrame(sortedPoints[capIdx]!);
      capIdx++;
    }
    return { frames, pushStats: summarisePushWindows(pushStatsSupported, pushWindows) };
  } finally {
    await link.disconnect();
  }
}

// Folds one reading per capture-point window into the same shape the
// emulator's own replayFromBytes (src/replayCore.ts) reports, so a checker
// reads meta.pushStats identically regardless of which side produced it.
function summarisePushWindows(supported: boolean, windows: { pushes: number; pixels: number }[]): PushLoadStats | undefined {
  if (!supported || windows.length === 0) return undefined;
  let maxPushesPerTick = 0;
  let maxPushPixelsPerTick = 0;
  let sumPushPixelsPerTick = 0;
  for (const w of windows) {
    if (w.pushes > maxPushesPerTick) maxPushesPerTick = w.pushes;
    if (w.pixels > maxPushPixelsPerTick) maxPushPixelsPerTick = w.pixels;
    sumPushPixelsPerTick += w.pixels;
  }
  return {
    tickCount: windows.length,
    maxPushesPerTick,
    maxPushPixelsPerTick,
    meanPushPixelsPerTick: sumPushPixelsPerTick / windows.length,
  };
}
