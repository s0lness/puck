// Pixel comparison between two captured frames. One function, reused by
// every consumer that needs to know whether two frames match: the
// differential harness's CLI (harness/diff.ts) and self-test
// (harness/selftest.ts), comparing the emulator against real hardware or a
// loopback fake, AND the in-page hardware-free regression check
// (src/regression.ts), comparing the current module's output against a
// saved baseline. Lives in src/, not harness/, precisely so the page can
// import it directly with no dependency on anything under harness/.

import type { CapturedFrame } from "./frame";

export interface FrameDiff {
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  firstDiffAt: { x: number; y: number } | null;
  // The bounding box of every pixel that exceeded tolerance, in pixels,
  // top-left origin, inclusive of both corners (so w/h are already the box's
  // real extent). null when nothing differed, or when the two frames could
  // not be compared at all. firstDiffAt answers "where does the divergence
  // start" for a person reading a failure; this answers "how much of the
  // panel is involved", which is what tools/describe.ts measures an
  // affordance's result by. Computed here rather than by a caller scanning
  // diffImage for red pixels: red is also a legitimate colour a firmware may
  // paint, so that scan would be wrong on any app that draws in it.
  diffBox: { x: number; y: number; w: number; h: number } | null;
  maxChannelDelta: number;
  // A heatmap the same size as the input frames: red where a pixel
  // exceeded tolerance, a dim copy of `a`'s own pixel otherwise. null when
  // there was nothing to highlight (an exact match, or a size mismatch).
  diffImage: Uint8Array | null;
}

export function compareFrames(a: CapturedFrame, b: CapturedFrame, tolerance: number): FrameDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, diffBox: null, maxChannelDelta: 255, diffImage: null };
  }
  // A frame whose rgb buffer is short of width*height*3 (a truncated
  // capture, a torn write, a caller that built a CapturedFrame by hand and
  // got the size wrong) must fail here, not read whatever bytes happen to
  // exist and silently agree with the other frame just because the loop
  // below runs out of real data and both sides return `undefined` at the
  // same offset (`undefined !== undefined` is false, which is a match).
  const expectedLength = a.width * a.height * 3;
  if (a.rgb.length !== expectedLength || b.rgb.length !== expectedLength) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, diffBox: null, maxChannelDelta: 255, diffImage: null };
  }
  const w = a.width, h = a.height;
  let diffPixels = 0;
  let firstDiffAt: { x: number; y: number } | null = null;
  let maxChannelDelta = 0;
  let boxX0 = w, boxY0 = h, boxX1 = -1, boxY1 = -1;
  const diffRgb = new Uint8Array(w * h * 3);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const dr = Math.abs(a.rgb[p]! - b.rgb[p]!);
    const dg = Math.abs(a.rgb[p + 1]! - b.rgb[p + 1]!);
    const db = Math.abs(a.rgb[p + 2]! - b.rgb[p + 2]!);
    const maxD = Math.max(dr, dg, db);
    if (maxD > tolerance) {
      diffPixels++;
      const x = i % w;
      const y = Math.floor(i / w);
      if (!firstDiffAt) firstDiffAt = { x, y };
      if (x < boxX0) boxX0 = x;
      if (x > boxX1) boxX1 = x;
      if (y < boxY0) boxY0 = y;
      if (y > boxY1) boxY1 = y;
      if (maxD > maxChannelDelta) maxChannelDelta = maxD;
      diffRgb[p] = 255;
      diffRgb[p + 1] = 0;
      diffRgb[p + 2] = 0;
    } else {
      diffRgb[p] = a.rgb[p]!;
      diffRgb[p + 1] = a.rgb[p + 1]!;
      diffRgb[p + 2] = a.rgb[p + 2]!;
    }
  }
  const diffBox = boxX1 >= 0 ? { x: boxX0, y: boxY0, w: boxX1 - boxX0 + 1, h: boxY1 - boxY0 + 1 } : null;
  return { match: diffPixels === 0, diffPixels, totalPixels: w * h, firstDiffAt, diffBox, maxChannelDelta, diffImage: diffPixels > 0 ? diffRgb : null };
}
