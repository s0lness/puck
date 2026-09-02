// tinydraw's own invariant checks - the bundle half of "the bundle owns its
// checks, the instrument owns the runner" (harness/invariantRun.ts's header
// comment). This file has no idea how a wasm module got instantiated or how
// a trace got replayed; it only knows what apps/tinydraw/traces/
// tinydraw-demo.trace.json's FOUR capture points are supposed to mean and
// what a healthy tinydraw port should look like at each of them (the same
// timeline apps/tinydraw/ports/rp2350-touch-amoled-18/README.md's own
// "What was verified this pass" table already documents from looking at the
// captured PNGs by eye):
//
//   frames[0]  "drawn"      t=750:  one fast-slow-fast stroke, freshly drawn
//                                   at 1x zoom.
//   frames[1]  "zoomed"     t=1050: the SAME stroke, after a PWR short press,
//                                   reprojected at 2x about the panel center.
//   frames[2]  "twoStrokes" t=1350: a second, short stroke drawn on top,
//                                   still at 2x zoom.
//   frames[3]  "afterUndo"  t=1600: after a BOOT click, back to exactly the
//                                   "zoomed" state - undo removed the second
//                                   stroke and nothing else.
//
// This exact order and count is a contract with the trace file, not
// something this checker can discover on its own - see
// apps/tinydraw/traces/tinydraw-demo.trace.json's own event list for the
// timeline (draw -> PWR short -> draw -> BOOT).
//
// Every threshold below was picked empirically against this port's own
// built module (`bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app
// apps/tinydraw/ports/rp2350-touch-amoled-18/tinydraw.c`) replaying this
// exact trace, not guessed: the measured good-run numbers are quoted next to
// each threshold below, and every one of the five checks here was run
// red-before-green (see this port's README's own note, and the PR this
// bundle ships with) by deliberately breaking the one behaviour it is meant
// to catch, confirming THIS check (and not some other one) fails, then
// restoring and confirming green again.

// The types and the two small helpers come from harness/invariantTypes.ts,
// not from harness/invariantRun.ts: this file is now ALSO bundled into a
// browser page (site/attest/checkers.ts), where the same check runs over
// the frames a real board drew, and invariantRun.ts opens files. Nothing
// here touches a file, a socket or the DOM - it is a pure function of
// {frames, meta} and always was.
import { held, summariseInvariants } from "../../harness/invariantTypes";
import type { InvariantMeta, InvariantOutcome, InvariantResult, TimedFrame } from "../../harness/invariantTypes";

function isWhite(rgb: Uint8Array, idx: number): boolean {
  return rgb[idx] === 255 && rgb[idx + 1] === 255 && rgb[idx + 2] === 255;
}

function countInk(frame: TimedFrame["frame"]): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    if (!isWhite(rgb, i * 3)) n++;
  }
  return n;
}

// Per-column ink height (count of non-white pixels in that column) is a
// cheap proxy for local stroke THICKNESS, valid here because the demo
// stroke runs mostly horizontally (see the trace's own touch samples): a
// vertical scan through a shallow diagonal line crosses it roughly
// perpendicular to its own direction, so a taller column really does mean a
// thicker line at that point, not just a longer diagonal run through it.
function colHeights(frame: TimedFrame["frame"]): number[] {
  const { width, height, rgb } = frame;
  const heights = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x++) {
    let c = 0;
    for (let y = 0; y < height; y++) {
      if (!isWhite(rgb, (y * width + x) * 3)) c++;
    }
    heights[x] = c;
  }
  return heights;
}

// Average column height over the columns in [lo,hi) that actually have any
// ink (an x with height 0 sits in a gap between the two strokes on a
// two-stroke frame and would otherwise drag a band average toward zero for
// no reason connected to stroke thickness).
function bandAvgHeight(heights: number[], lo: number, hi: number): number {
  const vals: number[] = [];
  for (let x = lo; x < hi; x++) {
    if (heights[x]! > 0) vals.push(heights[x]!);
  }
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function diffPixelCount(a: TimedFrame["frame"], b: TimedFrame["frame"]): number {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0; i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) diff++;
  }
  return diff;
}

// (1) Ink drawn at all. Measured good run: 2493 non-white px at t=750 (one
// stroke, unzoomed). MIN_INK_PX = 500 sits well under that but far above
// zero, so a module that instantiates and ticks but never actually draws
// (draw_capsule() short-circuited, or never called) fails loudly rather
// than passing on an accidentally-white panel.
const MIN_INK_PX = 500;

// (2) Variable width: the stroke must read visibly thicker in its middle
// than at either end (this port's whole reason to exist over a fixed-width
// line tool - see descriptor.md's Essence). Measured good run (t=750,
// bandAvgHeight over the leftmost/center/rightmost 15%/20%/15% of the
// stroke's own x-extent): start 10.94px, mid 12.88px, end 10.97px - the
// middle band is ~17-18% taller than either end band. WIDTH_RATIO_MIN =
// 1.10 sits below that measured ratio with real margin (a antialiasing- or
// sampling-jitter-scale gap would not trip it) while still catching a
// constant-radius line, whose start/mid/end bands would measure equal
// (ratio ~1.00) - see this file's own red-before-green note.
const WIDTH_RATIO_MIN = 1.1;

// (3) Zoom reprojects existing ink, not a no-op and not fresh ink. Measured
// good run: 2493px (t=750, 1x) -> 7961px (t=1050, 2x) - a 3.19x increase
// (less than the naive 4x area scaling because part of the stroke's 2x
// bounding box clips off-panel near the top-left, per the captured PNG).
// [ZOOM_RATIO_MIN, ZOOM_RATIO_MAX] = [2.2, 4.4] brackets that measured 3.19x
// with real margin on both sides: a broken zoom that leaves the panel
// unchanged would read ~1.0x (caught by the floor), and there is no
// legitimate way for a 2x reprojection of the SAME strokes to exceed the
// full 4x area scaling (caught by the ceiling).
const ZOOM_RATIO_MIN = 2.2;
const ZOOM_RATIO_MAX = 4.4;

// (4) A second stroke actually adds ink. Measured good run: 7961px (t=1050,
// zoomed, one stroke) -> 8412px (t=1350, zoomed, two strokes), a +451px
// delta. MIN_SECOND_STROKE_DELTA_PX = 150 sits well under that measured
// delta while still requiring real, substantial new ink (not antialiasing
// noise) - a build where the second touch-down never starts a new stroke
// (stroke_pool_begin() capped or skipped) would measure ~0.
const MIN_SECOND_STROKE_DELTA_PX = 150;

// (5) Undo removes EXACTLY the most recent stroke and nothing else. This is
// the strongest check in this file because the trace's own timeline makes
// it an exact pixel-identity claim, not a fuzzy threshold: t=1600 (after
// the BOOT click) must repaint to the BIT-IDENTICAL panel state as t=1050
// (right after the zoom, before the second stroke existed) - both are
// "one stroke, zoomed" and repaint_all() is a deterministic function of the
// stored stroke list and the current zoom, so if undo really popped only
// the second stroke, there is nothing left to differ. Measured good run: 0
// differing pixels. MAX_UNDO_DIFF_PX = 0 is therefore not a margin, it is
// the actual claim - seeing this file's own red-before-green note for what
// a broken undo (clearing everything, or leaving the second stroke behind)
// measures instead.
const MAX_UNDO_DIFF_PX = 0;

export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult {
  void meta; // every check here reads pixels; nothing here needs the device
  if (frames.length !== 4) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "the trace's own four capture points arrived",
        status: "fail",
        message: `expected exactly 4 captures (drawn, zoomed, twoStrokes, afterUndo) per this trace's own contract, got ${frames.length}`,
      },
    ]);
  }

  const [drawn, zoomed, twoStrokes, afterUndo] = frames;
  const outcomes: InvariantOutcome[] = [];

  // (1) ink drawn at all
  const inkDrawn = countInk(drawn!.frame);
  const inkFails: string[] = [];
  if (inkDrawn < MIN_INK_PX) {
    inkFails.push(`ink drawn: only ${inkDrawn}px non-white at drawn (t=${drawn!.atMs}), min required ${MIN_INK_PX}px`);
  }
  outcomes.push(
    held("ink", "the stroke is actually drawn", inkFails, `ink drawn: ${inkDrawn}px non-white at drawn (t=${drawn!.atMs}), min required ${MIN_INK_PX}px`)
  );

  // (2) variable width, measured on the "drawn" frame (unzoomed, single stroke)
  const heights = colHeights(drawn!.frame);
  const nonZeroXs: number[] = [];
  for (let x = 0; x < heights.length; x++) if (heights[x]! > 0) nonZeroXs.push(x);
  const widthFails: string[] = [];
  let widthPassMessage = "";
  if (nonZeroXs.length < 10) {
    widthFails.push(`variable width: too little ink at drawn (t=${drawn!.atMs}) to measure a width profile (${nonZeroXs.length} ink columns)`);
  } else {
    const lo = nonZeroXs[0]!, hi = nonZeroXs[nonZeroXs.length - 1]!;
    const span = hi - lo;
    const startAvg = bandAvgHeight(heights, lo, lo + Math.floor(span * 0.15));
    const midAvg = bandAvgHeight(heights, lo + Math.floor(span * 0.4), lo + Math.floor(span * 0.6));
    const endAvg = bandAvgHeight(heights, hi - Math.floor(span * 0.15), hi);
    const ratioStart = startAvg > 0 ? midAvg / startAvg : 0;
    const ratioEnd = endAvg > 0 ? midAvg / endAvg : 0;
    if (ratioStart < WIDTH_RATIO_MIN || ratioEnd < WIDTH_RATIO_MIN) {
      widthFails.push(
        `variable width: mid-band avg height ${midAvg.toFixed(2)}px is not >= ${WIDTH_RATIO_MIN}x both end bands (start ${startAvg.toFixed(2)}px, end ${endAvg.toFixed(2)}px) at drawn (t=${drawn!.atMs}) - line reads roughly constant width`
      );
    }
    widthPassMessage =
      `variable width: mid-band avg height ${midAvg.toFixed(2)}px against start ${startAvg.toFixed(2)}px (${ratioStart.toFixed(2)}x) and ` +
      `end ${endAvg.toFixed(2)}px (${ratioEnd.toFixed(2)}x), min required ${WIDTH_RATIO_MIN}x`;
  }
  outcomes.push(held("width", "the stroke is thicker in its middle than at either end", widthFails, widthPassMessage));

  // (3) zoom reprojects existing ink at ~2x, neither a no-op nor fresh ink
  const inkZoomed = countInk(zoomed!.frame);
  const zoomRatio = inkDrawn > 0 ? inkZoomed / inkDrawn : 0;
  const zoomFails: string[] = [];
  if (zoomRatio < ZOOM_RATIO_MIN || zoomRatio > ZOOM_RATIO_MAX) {
    zoomFails.push(
      `zoom scaling: ink went from ${inkDrawn}px (drawn, t=${drawn!.atMs}) to ${inkZoomed}px (zoomed, t=${zoomed!.atMs}), a ${zoomRatio.toFixed(2)}x change, expected between ${ZOOM_RATIO_MIN}x and ${ZOOM_RATIO_MAX}x`
    );
  }
  outcomes.push(
    held(
      "zoom",
      "zoom reprojects the ink already there, at about 2x",
      zoomFails,
      `zoom scaling: ${inkDrawn}px (drawn) to ${inkZoomed}px (zoomed), a ${zoomRatio.toFixed(2)}x change, expected between ${ZOOM_RATIO_MIN}x and ${ZOOM_RATIO_MAX}x`
    )
  );

  // (4) a second stroke actually adds ink
  const inkTwoStrokes = countInk(twoStrokes!.frame);
  const secondStrokeDelta = inkTwoStrokes - inkZoomed;
  const secondFails: string[] = [];
  if (secondStrokeDelta < MIN_SECOND_STROKE_DELTA_PX) {
    secondFails.push(
      `second stroke: only +${secondStrokeDelta}px between zoomed (t=${zoomed!.atMs}, ${inkZoomed}px) and twoStrokes (t=${twoStrokes!.atMs}, ${inkTwoStrokes}px), min required +${MIN_SECOND_STROKE_DELTA_PX}px`
    );
  }
  outcomes.push(
    held(
      "second-stroke",
      "a second stroke adds real ink of its own",
      secondFails,
      `second stroke: +${secondStrokeDelta}px between zoomed (${inkZoomed}px) and twoStrokes (${inkTwoStrokes}px), min required +${MIN_SECOND_STROKE_DELTA_PX}px`
    )
  );

  // (5) undo removes exactly the most recent stroke and nothing else:
  // afterUndo must be bit-identical to zoomed.
  const undoDiff = diffPixelCount(zoomed!.frame, afterUndo!.frame);
  const undoFails: string[] = [];
  if (undoDiff > MAX_UNDO_DIFF_PX) {
    undoFails.push(
      `undo exactness: afterUndo (t=${afterUndo!.atMs}) differs from zoomed (t=${zoomed!.atMs}) by ${undoDiff}px, expected ${MAX_UNDO_DIFF_PX} (undo must reproduce the pre-second-stroke panel exactly)`
    );
  }
  outcomes.push(
    held(
      "undo",
      "undo removes exactly the most recent stroke and nothing else",
      undoFails,
      `undo exactness: afterUndo (t=${afterUndo!.atMs}) differs from zoomed (t=${zoomed!.atMs}) by ${undoDiff}px, expected ${MAX_UNDO_DIFF_PX}`
    )
  );

  return summariseInvariants(outcomes);
}
