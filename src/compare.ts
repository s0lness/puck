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
  maxChannelDelta: number;
  // A heatmap the same size as the input frames: red where a pixel
  // exceeded tolerance, a dim copy of `a`'s own pixel otherwise. null when
  // there was nothing to highlight (an exact match, or a size mismatch).
  diffImage: Uint8Array | null;
}

export function compareFrames(a: CapturedFrame, b: CapturedFrame, tolerance: number): FrameDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, maxChannelDelta: 255, diffImage: null };
  }
  // A frame whose rgb buffer is short of width*height*3 (a truncated
  // capture, a torn write, a caller that built a CapturedFrame by hand and
  // got the size wrong) must fail here, not read whatever bytes happen to
  // exist and silently agree with the other frame just because the loop
  // below runs out of real data and both sides return `undefined` at the
  // same offset (`undefined !== undefined` is false, which is a match).
  const expectedLength = a.width * a.height * 3;
  if (a.rgb.length !== expectedLength || b.rgb.length !== expectedLength) {
    return { match: false, diffPixels: -1, totalPixels: a.width * a.height, firstDiffAt: null, maxChannelDelta: 255, diffImage: null };
  }
  const w = a.width, h = a.height;
  let diffPixels = 0;
  let firstDiffAt: { x: number; y: number } | null = null;
  let maxChannelDelta = 0;
  const diffRgb = new Uint8Array(w * h * 3);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const dr = Math.abs(a.rgb[p]! - b.rgb[p]!);
    const dg = Math.abs(a.rgb[p + 1]! - b.rgb[p + 1]!);
    const db = Math.abs(a.rgb[p + 2]! - b.rgb[p + 2]!);
    const maxD = Math.max(dr, dg, db);
    if (maxD > tolerance) {
      diffPixels++;
      if (!firstDiffAt) firstDiffAt = { x: i % w, y: Math.floor(i / w) };
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
  return { match: diffPixels === 0, diffPixels, totalPixels: w * h, firstDiffAt, maxChannelDelta, diffImage: diffPixels > 0 ? diffRgb : null };
}
