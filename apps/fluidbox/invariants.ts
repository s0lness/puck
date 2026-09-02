// fluidbox's own invariant checks - the bundle half of "the bundle owns its
// checks, the instrument owns the runner" (harness/invariantRun.ts's header
// comment). This file has no idea how a wasm module got instantiated or how
// a trace got replayed; it only knows what apps/fluidbox/traces/
// fluid-settle-shake.trace.json's THREE capture points are supposed to mean
// and what a healthy fluid should look like at each of them:
//
//   frames[0]  "settled1"    after several seconds of undisturbed settling
//   frames[1]  "afterShake"  the tick right after the shake sensor event
//   frames[2]  "settled2"    after several more seconds of settling again
//
// This exact order and count is a contract with the trace file, not
// something this checker can discover on its own - see that trace's own
// generation notes in this port's README for the timeline (boot -> settle
// ~4s -> shake -> settle ~5s more).
//
// Every threshold below was picked empirically against this port's own
// FLUID_N=130 build (not copied from the donor's very different 900-
// particle numbers) and is reported, with the measured good/bad values, in
// apps/fluidbox/ports/rp2350-touch-amoled-18/README.md's "invariant
// thresholds" section, including the red-before-green run (gravity
// temporarily zeroed) that this file's own thresholds were checked against
// before being finalised.

// The types and the two small helpers come from harness/invariantTypes.ts,
// not from harness/invariantRun.ts: this file is now ALSO bundled into a
// browser page (site/attest/checkers.ts), where the same check runs over
// the frames a real board drew, and invariantRun.ts opens files. Nothing
// here touches a file, a socket or the DOM - it is a pure function of
// {frames, meta} and always was.
import { held, summariseInvariants } from "../../harness/invariantTypes";
import type { InvariantMeta, InvariantOutcome, InvariantResult, TimedFrame } from "../../harness/invariantTypes";

const BG_R = 0, BG_G = 0, BG_B = 0; // FLUID_BG in fluid.c: pure black

function isBackground(rgb: Uint8Array, idx: number): boolean {
  return rgb[idx] === BG_R && rgb[idx + 1] === BG_G && rgb[idx + 2] === BG_B;
}

function countNonBackground(frame: TimedFrame["frame"]): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    if (!isBackground(rgb, i * 3)) n++;
  }
  return n;
}

// Per-column "top of the fluid" (first non-background row scanning down),
// -1 where a column has no fluid pixel at all.
function topRowPerColumn(frame: TimedFrame["frame"]): number[] {
  const { width, height, rgb } = frame;
  const top = new Array<number>(width).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (top[x] !== -1) continue;
      if (!isBackground(rgb, (y * width + x) * 3)) top[x] = y;
    }
  }
  return top;
}

// Robust flatness of the settled surface: bucket the CENTER columns (the
// rounded-corner margin excluded on both sides - a puddle in a rounded box
// legitimately climbs higher near the corners, which is real geometry, not
// sloshing) into bins, take each bin's MEDIAN top-row among the columns that
// have any fluid, then report the spread across bin medians. Per-column top
// rows alone are far too noisy to threshold directly: fluid is drawn as
// discrete PARTICLE_HALF*2+1 px squares with real gaps between them (this
// port has only 130 particles over a wide box), so plenty of individual
// columns sit between two particles and read as "almost no fluid, just a
// sliver near the very bottom" even when the pool right next to them is
// solid - measured on this port's own good run, raw per-column min/max
// spread is ~54-60px even when the pool is genuinely settled and flat,
// while the SAME frames' bucket-median spread is 20-27px. Binning first
// (10 bins across the ~250px center span) averages out the particle-gap
// noise and leaves the actual surface shape.
const CORNER_MARGIN_PX = 57; // BOX_CORNER_R in fluid.c
const FLATNESS_BINS = 10;

function bucketFlatness(frame: TimedFrame["frame"]): number {
  const top = topRowPerColumn(frame);
  const lo = CORNER_MARGIN_PX, hi = frame.width - CORNER_MARGIN_PX;
  const binWidth = Math.floor((hi - lo) / FLATNESS_BINS);
  const medians: number[] = [];
  for (let b = 0; b < FLATNESS_BINS; b++) {
    const vals: number[] = [];
    for (let x = lo + b * binWidth; x < lo + (b + 1) * binWidth; x++) {
      if (top[x] !== -1) vals.push(top[x]!);
    }
    if (vals.length === 0) continue;
    vals.sort((a, c) => a - c);
    medians.push(vals[Math.floor(vals.length / 2)]!);
  }
  if (medians.length === 0) return Infinity; // no fluid found at all: definitely a failure
  return Math.max(...medians) - Math.min(...medians);
}

function diffPixelCount(a: TimedFrame["frame"], b: TimedFrame["frame"]): number {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0; i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) diff++;
  }
  return diff;
}

// (1) Mass proxy stable. Non-background pixel count is a cheap stand-in for
// "the same fluid is still here": FLUID_N is fixed and every particle draws
// the same fixed-size square regardless of position or speed, so nothing
// should make this count drift far between two settled captures unless
// particles are being lost off-panel (clipped by gfx_fill_rect at the
// edge - see invariant 4) or the draw loop itself is broken. Measured on
// this port's own good run: 6352 -> 6350 non-bg px between settled1 and
// settled2, a 0.03% change. X = 5% leaves a wide margin over that noise
// floor while still catching a real loss (a stuck/vanished particle moves
// this by roughly 1/130 = 0.77% on its own, so 5% is several particles'
// worth, not a hair-trigger).
const MASS_DRIFT_MAX_PCT = 5;

// (2) Settled surface roughly flat. Y = 40px on the bucket-median spread
// (see bucketFlatness() above), checked on BOTH settled captures
// independently. Measured good run: 20-27px on both. Measured broken run
// (GRAVITY_GAIN temporarily set to 0.0f in fluid.c, see the README's
// red-before-green section): 43px right after boot/before the fluid has had
// time to fall in the first place, and 90px on settled2 - the shaken
// particles never fall back into a pool without gravity pulling them down,
// so the surface stays wherever the shake scattered it. 40px sits above the
// good run's worst case with real margin and well below the broken run's,
// on the specific capture (settled2) the break actually shows up on.
const FLATNESS_MAX_SPREAD_PX = 40;

// (3) Shake visibly agitates. The capture right after the shake event must
// differ from the settled capture immediately before it by more than Z
// pixels. Measured good run: 4976px differ (settled1 -> afterShake).
// Z = 1500 is well under that, but still large enough that a shake which
// did nothing (SHAKE_IMPULSE_PXS effectively zero, or f->shaken never
// reaching apply_shake()) could not pass by accident - a handful of
// particles moving a few pixels from ordinary settling jitter alone
// measures in the tens to low hundreds of pixels, not four figures.
const SHAKE_DIFF_MIN_PX = 1500;

// (4) Everything inside panel bounds. gfx_fill_rect() already clips every
// draw to the panel, so a raw "is every drawn pixel inside [0,w)x[0,h)"
// check can never fail and would not be testing anything. The check that
// CAN fail and is worth having: the fluid's own wall containment
// (resolve_walls() in fluid.c) keeps every particle at least WALL_MARGIN
// (5px) from the panel edge along a straight wall, and PARTICLE_HALF (3px)
// is how far a particle's own drawn square can reach past its center - so
// no fluid pixel should ever appear in the panel's outermost 1px border
// ring under correct wall physics, on any captured frame. A genuinely
// broken wall (e.g. resolve_walls() doing nothing) lets particles run all
// the way to the clipped edge and this trips immediately.
function borderIsClean(frame: TimedFrame["frame"]): boolean {
  const { width, height, rgb } = frame;
  for (let x = 0; x < width; x++) {
    if (!isBackground(rgb, (0 * width + x) * 3)) return false;
    if (!isBackground(rgb, ((height - 1) * width + x) * 3)) return false;
  }
  for (let y = 0; y < height; y++) {
    if (!isBackground(rgb, (y * width + 0) * 3)) return false;
    if (!isBackground(rgb, (y * width + (width - 1)) * 3)) return false;
  }
  return true;
}

// (5) Panel push stays a bounding box, not the whole panel, every tick.
// Found on real silicon (packs/rp2350-touch-amoled-18/gotchas.md's "many
// small pushes" entry, this port's own README's "Panel push" section):
// continuous full-panel gfx_push every tick reads as shimmer on the real
// device even though it is pixel-perfect in the emulator, because every
// invariant here reads the framebuffer directly and never sees what
// actually got pushed. This is the gate that WOULD have caught the
// regression before silicon: not a push-COUNT bound (the pre-fix code
// already pushed exactly once a tick, same as the fix - count was never the
// discriminating number here) but a push-PIXELS bound, since that is the
// axis that actually moved (164,864px/tick pre-fix vs 21,344-40,832px/tick
// post-fix, measured over this same trace). Checked against the worst
// (max), not average, tick, so an intermittent regression cannot hide
// behind a low mean. PUSH_PIXELS_MAX = 90,000px (~55% of the 164,864px
// panel) sits comfortably above the post-fix measured max
// (40,832px, room for a bigger splash than this trace's own shake produces)
// and well below the pre-fix constant (164,864px, every tick) - so a
// regression back to "push the whole panel" fails loudly, while ordinary
// per-tick variance in how spread out the fluid is does not.
//
// Also checked, for hygiene rather than because it discriminates this
// specific bug: pushes/tick must stay small. This port issues exactly one
// gfx_push per tick both before and after the fix, so PUSH_COUNT_MAX = 4
// (generous headroom, not a tight bound) exists to catch a genuinely
// different regression - a future edit that reintroduces PER-PARTICLE
// pushes - not the one this task found and fixed.
const PUSH_PIXELS_MAX = 90000; // checked against the WORST tick, not the mean
                                // - a bug that only occasionally pushes the
                                // whole panel would hide under a mean bound.
const PUSH_COUNT_MAX = 4;

export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult {
  if (frames.length !== 3) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "the trace's own three capture points arrived",
        status: "fail",
        message: `expected exactly 3 captures (settled1, afterShake, settled2) per this trace's own contract, got ${frames.length}`,
      },
    ]);
  }

  const [settled1, afterShake, settled2] = frames;
  const outcomes: InvariantOutcome[] = [];

  // (1) mass proxy
  const mass1 = countNonBackground(settled1!.frame);
  const mass2 = countNonBackground(settled2!.frame);
  const massDriftPct = mass1 === 0 ? 100 : (Math.abs(mass1 - mass2) / mass1) * 100;
  const massFails: string[] = [];
  if (mass1 === 0) {
    massFails.push(`mass proxy: settled1 (t=${settled1!.atMs}) has zero non-background pixels - nothing rendered`);
  } else if (massDriftPct > MASS_DRIFT_MAX_PCT) {
    massFails.push(
      `mass proxy: non-background pixel count drifted ${massDriftPct.toFixed(2)}% between settled1 (${mass1}px) and settled2 (${mass2}px), max allowed ${MASS_DRIFT_MAX_PCT}%`
    );
  }
  outcomes.push(
    held(
      "mass",
      "the same fluid is still there after the shake",
      massFails,
      `mass proxy: ${mass1}px non-background at settled1, ${mass2}px at settled2, a ${massDriftPct.toFixed(2)}% drift (max allowed ${MASS_DRIFT_MAX_PCT}%)`
    )
  );

  // (2) settled surface flatness, both settled captures
  const flat1 = bucketFlatness(settled1!.frame);
  const flat2 = bucketFlatness(settled2!.frame);
  const flatFails: string[] = [];
  if (flat1 > FLATNESS_MAX_SPREAD_PX) {
    flatFails.push(`flat surface: settled1 (t=${settled1!.atMs}) bucket-median spread ${flat1}px exceeds max ${FLATNESS_MAX_SPREAD_PX}px`);
  }
  if (flat2 > FLATNESS_MAX_SPREAD_PX) {
    flatFails.push(`flat surface: settled2 (t=${settled2!.atMs}) bucket-median spread ${flat2}px exceeds max ${FLATNESS_MAX_SPREAD_PX}px`);
  }
  outcomes.push(
    held(
      "flatness",
      "the settled surface lies roughly flat",
      flatFails,
      `flat surface: bucket-median spread ${flat1}px at settled1 and ${flat2}px at settled2 (max allowed ${FLATNESS_MAX_SPREAD_PX}px)`
    )
  );

  // (3) shake visibly agitates
  const shakeDiff = diffPixelCount(settled1!.frame, afterShake!.frame);
  const shakeFails: string[] = [];
  if (shakeDiff < SHAKE_DIFF_MIN_PX) {
    shakeFails.push(
      `shake agitation: only ${shakeDiff}px differ between settled1 (t=${settled1!.atMs}) and afterShake (t=${afterShake!.atMs}), min required ${SHAKE_DIFF_MIN_PX}px`
    );
  }
  outcomes.push(
    held(
      "shake",
      "a shake visibly agitates the fluid",
      shakeFails,
      `shake agitation: ${shakeDiff}px differ between settled1 (t=${settled1!.atMs}) and afterShake (t=${afterShake!.atMs}), min required ${SHAKE_DIFF_MIN_PX}px`
    )
  );

  // (4) inside panel bounds, every captured frame
  const boundsFails: string[] = [];
  for (const f of frames) {
    if (!borderIsClean(f.frame)) {
      boundsFails.push(`bounds: fluid pixel found in the panel's outermost 1px border at t=${f.atMs} (wall containment broken)`);
    }
  }
  outcomes.push(
    held(
      "bounds",
      "wall containment keeps every particle off the panel edge",
      boundsFails,
      `bounds: the panel's outermost 1px border is clear on all ${frames.length} captures`
    )
  );

  // (5) panel push stays a bounding box, not the whole panel, every tick -
  // see PUSH_PIXELS_MAX/PUSH_COUNT_MAX's own comment. Scoped to the rp2350
  // pack ONLY (meta.device.name), not to every port this checker file is
  // shared across (apps/fluidbox/bundle.json also verifies esp32-s3 and web
  // with this exact function): the silicon finding this invariant guards
  // against is specific to THIS pack's QSPI bus and panel
  // (packs/rp2350-touch-amoled-18/gotchas.md's "many small pushes" entry) -
  // the esp32-s3 port's own gfx is a different memory model entirely (band
  // renderer, not full-framebuffer, see that port's own README), and the
  // web port has no physical bus to shimmer at all. A shared numeric bound
  // across three unrelated displays would either be meaningless for two of
  // them or would fail two ports for a defect this task never touched or
  // verified on their hardware - apps/fluidbox/ports/rp2350-touch-amoled-18/
  // README.md's own before/after numbers are this pack's alone. On any
  // other device this reports "skip": nothing went unanswered, this check
  // was never about that board.
  //
  // On the rp2350 with no push instrumentation it reports "unevaluable"
  // instead, and the difference is load-bearing (harness/invariantTypes.ts's
  // InvariantStatus). Neither status touches `pass` - an emulator module
  // built before this export existed must not go red for it - but a surface
  // making a public claim about a board reads the outcomes rather than the
  // boolean, and refuses to post a run with a hole in it. That is the case
  // every devlink run is in: a board answers SHOT with its framebuffer and
  // never reports what it pushed, so on the one silicon this invariant was
  // written for, a board cannot answer it.
  if (meta.device.name !== "RP2350-Touch-AMOLED-1.8") {
    outcomes.push({
      id: "push",
      name: "one tick never pushes the whole panel",
      status: "skip",
      message: `panel push: not checked on ${meta.device.name ?? "this device"} - this bound is the RP2350 pack's own QSPI and panel finding, and its numbers are that pack's alone`,
    });
  } else if (!meta.pushStats) {
    outcomes.push({
      id: "push",
      name: "one tick never pushes the whole panel",
      status: "unevaluable",
      message:
        `panel push: this run reports the framebuffer and not what was pushed to the panel, so the ${PUSH_PIXELS_MAX}px-per-tick ` +
        `bound cannot be answered from it. A board answers SHOT with its framebuffer; the bound is checked against the emulator ` +
        `by "bun run verify-bundle".`,
    });
  } else {
    const { maxPushesPerTick, maxPushPixelsPerTick, tickCount } = meta.pushStats;
    const pushFails: string[] = [];
    if (maxPushPixelsPerTick > PUSH_PIXELS_MAX) {
      pushFails.push(
        `panel push: worst tick pushed ${maxPushPixelsPerTick}px (of ${tickCount} ticks replayed), max allowed ${PUSH_PIXELS_MAX}px - see this port's README's "Panel push" section`
      );
    }
    if (maxPushesPerTick > PUSH_COUNT_MAX) {
      pushFails.push(
        `panel push: worst tick issued ${maxPushesPerTick} gfx_push call(s), max allowed ${PUSH_COUNT_MAX} - looks like a return of per-particle pushes`
      );
    }
    outcomes.push(
      held(
        "push",
        "one tick never pushes the whole panel",
        pushFails,
        `panel push: worst of ${tickCount} ticks pushed ${maxPushPixelsPerTick}px in ${maxPushesPerTick} call(s), max allowed ${PUSH_PIXELS_MAX}px in ${PUSH_COUNT_MAX}`
      )
    );
  }

  return summariseInvariants(outcomes);
}
