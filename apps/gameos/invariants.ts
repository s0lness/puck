// gameos's own invariant checks - the bundle half of "the bundle owns its
// checks, the instrument owns the runner" (harness/invariantRun.ts's header
// comment). This file has no idea how a wasm module got instantiated or how
// a trace got replayed; it only knows what a trace's capture points are
// supposed to mean and what a healthy run should look like at each of them.
//
// TWO shapes are accepted, both sharing the same first 12 points - the
// rp2350 port (still two games, apps/gameos/traces/gameos-demo.trace.json,
// unchanged, its own bespoke picker never having been the donor's real
// shell to begin with) uses exactly 12. The esp32 port's own trace
// (apps/gameos/traces/gameos-demo-esp32.trace.json) is a DIFFERENT shape
// entirely as of this task: 21 points, because that port's entry point is
// now the donor's real, vendored shell (registry.c/apps.c/shell.c - see
// that port's NOTICE.md), not the port-authored three-card launcher.c this
// trace used to replay against. A Wii-menu-style five-tile grid, a pause
// overlay with an explicit QUIT button, and two more playable screens
// (AIM TEST, DIAG) replace what used to be a bespoke "tap a card" picker -
// see that port's own README, "What changed: the real shell replaces
// launcher.c", for the full argument.
//
//   frames[0..2]  "gridBoot"        fresh boot (past the mandatory
//                                   first-run calibration tap - this
//                                   port's NVS always fails open, so
//                                   shell_init() lands on the calibration
//                                   wizard every session, not the grid -
//                                   see NOTICE.md), grid idle
//   frames[3]     "briefing"        GUNSHIP briefing screen
//   frames[4]     "missionStart"    GUNSHIP mission just started
//   frames[5]     "firing"          GUNSHIP, tilt-aimed, firing held
//   frames[6]     "wave"            GUNSHIP, wave in progress
//   frames[7]     "pauseOverlay"    swipe-paused GUNSHIP, the real shell's
//                                   RESUME/RESTART/CALIBRATE/QUIT overlay
//   frames[8]     "backToGrid"      QUIT tapped, back on the grid
//   frames[9]     "idle"            LUCKY 7, idle
//   frames[10]    "midSpin"         LUCKY 7, mid-spin motion blur
//   frames[11]    "landed"          LUCKY 7, a reel just landed
//   frames[12]    "win"             LUCKY 7, a resolved win, coins
//   frames[13]    "backToGridFromLucky7"  swipe+QUIT, back on the grid
//   frames[14]    "golfReady"       GOLF, ready to swing
//   frames[15]    "golfSwingImpact" GOLF, right after a swing fires the shot
//   frames[16]    "backToGridFromGolf"  swipe+QUIT, back on the grid
//   frames[17]    "aimTestOpen"     AIM TEST opened from the grid
//   frames[18]    "backToGridFromAimTest"  swipe+QUIT, back on the grid
//   frames[19]    "diagOpen"        DIAG opened from the grid
//   frames[20]    "backToGridFromDiag"  swipe+QUIT, back on the grid
//
// This exact order (and one of these two counts) is a contract with the
// trace file, not something this checker can discover on its own.
//
// Every threshold below was picked empirically against this port's own
// built module, replaying this exact trace - the measured good-run numbers
// are quoted next to each threshold. Invariants (1), (2) and (5) were
// rewritten for this task against the real shell (the former launcher.c's
// own invariants of the same number, proven red-before-green against a
// bespoke three-card picker that never existed on the donor's real device,
// are gone along with that file); invariants (3), (4), (6) and (7) are
// unchanged in shape from before this task, re-verified red-before-green
// against the REBUILT module (the real shell now driving the same games).
// Invariant (8) is new for this task, answering its own requirement
// directly: AIM TEST and DIAG (the donor's own harness apps, previously
// undeclared "not vendored - ESP-IDF/FreeRTOS-specific" and out of scope)
// now ship, so "faithful means they appear and open" needs a real check,
// not just a claim in a README.

// The types and the two small helpers come from harness/invariantTypes.ts,
// not from harness/invariantRun.ts: this file is now ALSO bundled into a
// browser page (site/attest/checkers.ts), where the same check runs over
// the frames a real board drew, and invariantRun.ts opens files. Nothing
// here touches a file, a socket or the DOM - it is a pure function of
// {frames, meta} and always was.
import { held, summariseInvariants } from "../../harness/invariantTypes";
import type { InvariantMeta, InvariantOutcome, InvariantResult, TimedFrame } from "../../harness/invariantTypes";

function diffPixelCount(a: TimedFrame["frame"], b: TimedFrame["frame"]): number {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0; i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) diff++;
  }
  return diff;
}

// Dark-pixel proxy: the real shell's own field is a LIGHT gray
// (GOS_GRAY64(50), average channel value ~208 - see shell.c's UI_BG), the
// opposite of the rp2350/former-launcher's dark navy field this file used
// to check brightness against. A blank field clear alone would read as
// almost entirely BRIGHT (>200) here, so "content drawn" instead counts
// genuinely DARK pixels: card borders (UI_EDGE, GOS_GRAY64(38)) and text
// (UI_TEXT, GOS_GRAY64(12)) - a grid that only cleared the background
// would measure 0.
function countDark(frame: TimedFrame["frame"], thresh: number): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if ((r + g + b) / 3 < thresh) n++;
  }
  return n;
}

// Cyan proxy: the grid's own tile letter icons (GOS_CYAN, shell.c's
// grid_frame() fallback glyph when a game declares no `icon`) - a second,
// independent signal that real tile content (not just the field/border
// chrome) is drawn.
function countCyan(frame: TimedFrame["frame"]): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if (r < 120 && g > 150 && b > 150) n++;
  }
  return n;
}

// Gold/amber proxy (GOS_AMBER-family colours: LUCKY 7's whole chrome/gold
// cabinet identity uses this range). GUNSHIP's thermal ramp (deep blue
// through white, gunship.c's own init() overwriting palette indices 0..15)
// never produces a pixel in this range - see this file's own invariant (4).
function countGold(frame: TimedFrame["frame"]): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if (r > 180 && g > 130 && b < 120) n++;
  }
  return n;
}

// (1) The grid actually draws its five tiles, borders and title text, not
// just a flat field clear. Measured good run: 1768px dark(<100) and
// 1200px cyan at every one of grid16/48/80 (five tile-letter glyphs: G/G/
// L/A/D). MIN_GRID_DARK_PX/MIN_GRID_CYAN_PX sit well under those while
// still requiring real rendered content - a grid_frame() that only cleared
// the field would measure 0 for both.
const MIN_GRID_DARK_PX = 500;
const MIN_GRID_CYAN_PX = 300;

// (2) Tapping a tile actually launches: the screen must change
// substantially between the grid and the game it launches. Measured good
// run: 164864px differ between grid80 (t=1882) and briefing (t=2331,
// GUNSHIP) - the entire panel, since the grid's own light field and the
// game's own dark HUD share almost no palette values. Every later
// GUNSHIP/LUCKY 7 invariant below implicitly depends on this one holding,
// the same cascade shape this file's own prior version documented.
// MIN_LAUNCH_DIFF_PX = 50000 sits well under the measured 164864px.
const MIN_LAUNCH_DIFF_PX = 50000;

// (3) Once launched, a game's own simulation keeps advancing tick to tick,
// not frozen on the first rendered frame. Measured good run (GUNSHIP):
// briefing->missionStart = 75264px, missionStart->firing = 14996px,
// firing->wave = 86568px. Measured good run (LUCKY 7): idle->midSpin =
// 18420px, midSpin->landed = 33092px, landed->win = 29224px.
// MIN_TICK_DIFF_PX = 5000 sits well under the smallest of those six
// measured transitions (14996px).
const MIN_TICK_DIFF_PX = 5000;

// (4) GUNSHIP's thermal palette actually applies during play: no
// gold/amber-family pixel appears in any GUNSHIP-screen capture. Measured
// good run: 0 gold px at all four of briefing/missionStart/firing/wave.
// MAX_GUNSHIP_GOLD_PX = 0 is the actual claim, not a margin.
const MAX_GUNSHIP_GOLD_PX = 0;

// (5) Exiting GUNSHIP or LUCKY 7 (swipe to pause, tap QUIT in the real
// shell's own overlay) reproduces the EXACT prior grid screen, not a grid
// with some leftover state (a stale palette entry, a stray pixel from the
// last game, direct565 still active). This is the strongest check in this
// file: backToGrid and backToGridFromLucky7 must both be bit-identical to
// grid80 - quit_game() (shell.c, real and unmodified) resets the default
// palette/scanlines/clip/settings and this dispatcher's own per-tick
// `gos_gfx_direct565(cur && ...)` line (gameos_port.c) turns direct565 off
// the instant `cur` goes NULL, together making that true. Measured good
// run: 0 differing pixels for both. MAX_RETURN_DIFF_PX = 0 is therefore
// the actual claim.
const MAX_RETURN_DIFF_PX = 0;

// (6) GOLF-only. A swing (driven entirely by synthetic raw-accel samples,
// this pack's own stream sensor) must actually change the ball's on-screen
// state: golf.c's fire_shot() sets ball_vx/vy and the camera pans to
// follow the struck ball. Measured good run: 151556px differ (out of
// 164864 total - nearly the whole panel). MIN_GOLF_SWING_DIFF_PX = 30000
// sits well under that while still requiring a real change, not idle-
// animation noise.
const MIN_GOLF_SWING_DIFF_PX = 30000;

// (7) GOLF-only. Exiting GOLF (the same swipe+QUIT flow as (5)) must
// reproduce the exact prior grid screen - the identical claim (5) makes,
// with one more real thing to undo: GOLF's own full-resolution direct565
// framebuffer mode. Measured good run: 0 differing pixels.
const MAX_GOLF_RETURN_DIFF_PX = 0;

// (8) AIM TEST and DIAG (the donor's own harness apps, real and
// unmodified - apps.c, previously out of scope entirely, see NOTICE.md)
// each actually open from the grid (a real, substantial screen change,
// not a blank or frozen grid) and return to it exactly, the same shape (2)
// and (5)/(7) already check for the three games. Measured good run:
// 164864px / 164752px differ between grid80 and aimTestOpen/diagOpen
// respectively; 0px differ between grid80 and either backToGridFromAimTest
// or backToGridFromDiag. MIN_OPEN_DIFF_PX = 50000 mirrors (2)'s own
// margin; MAX_RETURN_DIFF_PX (shared with (5)/(7)) is reused rather than
// restated.
const MIN_OPEN_DIFF_PX = 50000;

export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult {
  void meta; // every check here reads pixels; nothing here needs the device
  if (frames.length !== 12 && frames.length !== 21) {
    return summariseInvariants([
      {
        id: "capture-contract",
        name: "one of this checker's two known capture-point shapes arrived",
        status: "fail",
        message: `expected exactly 12 (rp2350 port, its own bespoke picker) or 21 (esp32 port, the real donor shell) captures per this trace's own contract, got ${frames.length}`,
      },
    ]);
  }

  const outcomes: InvariantOutcome[] = [];

  if (frames.length === 12) {
    // The rp2350 port's own bespoke launcher.c never claimed to be the
    // donor's real shell - its shape and thresholds are untouched by this
    // task, restated here unmodified rather than deleted, so this one
    // checker file still serves both ports (harness/invariantRun.ts's own
    // "the bundle owns its checks" contract assumes one checker per app,
    // not one per port).
    const [launcher16, launcher48, launcher80, briefing, missionStart, firing, wave, backToLauncher, idle, midSpin, landed, win] = frames;
    const contentFails: string[] = [];
    const brights: string[] = [];
    for (const [label, f] of [["launcher16", launcher16], ["launcher48", launcher48], ["launcher80", launcher80]] as const) {
      const bright = (() => {
        const { width, height, rgb } = f!.frame;
        let n = 0;
        for (let i = 0; i < width * height; i++) {
          const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
          if ((r + g + b) / 3 > 200) n++;
        }
        return n;
      })();
      brights.push(`${label} ${bright}px`);
      if (bright < 1500) contentFails.push(`launcher content: only ${bright}px bright(>200) at ${label} (t=${f!.atMs}), min required 1500px`);
    }
    outcomes.push(held("launcher", "the launcher draws its cards, not a blank field", contentFails, `launcher content: bright(>200) ${brights.join(", ")}, min required 1500px`));

    const launchDiff = diffPixelCount(launcher80!.frame, briefing!.frame);
    const launchFails: string[] = [];
    if (launchDiff < 50000) launchFails.push(`launch transition: only ${launchDiff}px differ between launcher80 and briefing, min required 50000px`);
    outcomes.push(held("launch", "tapping a card launches its game", launchFails, `launch transition: ${launchDiff}px differ between launcher80 and briefing, min required 50000px`));

    const ticks: [string, TimedFrame, TimedFrame][] = [
      ["briefing->missionStart", briefing!, missionStart!], ["missionStart->firing", missionStart!, firing!], ["firing->wave", firing!, wave!],
      ["idle->midSpin", idle!, midSpin!], ["midSpin->landed", midSpin!, landed!], ["landed->win", landed!, win!],
    ];
    const simFails: string[] = [];
    const simSeen: string[] = [];
    for (const [label, a, b] of ticks) {
      const d = diffPixelCount(a.frame, b.frame);
      simSeen.push(`${label} ${d}px`);
      if (d < 5000) simFails.push(`simulation alive: only ${d}px differ across ${label}, min required 5000px`);
    }
    outcomes.push(held("sim", "each game's own simulation keeps advancing", simFails, `simulation alive: ${simSeen.join(", ")}, min required 5000px each`));

    const goldFails: string[] = [];
    const goldSeen: string[] = [];
    for (const [label, f] of [["briefing", briefing], ["missionStart", missionStart], ["firing", firing], ["wave", wave]] as const) {
      const gold = countGold(f!.frame);
      goldSeen.push(`${label} ${gold}px`);
      if (gold > 0) goldFails.push(`gunship palette: ${gold}px read as gold/amber at ${label}, max allowed 0px`);
    }
    outcomes.push(held("palette", "GUNSHIP's thermal palette holds during play", goldFails, `gunship palette: gold/amber ${goldSeen.join(", ")}, max allowed 0px`));

    const returnDiff = diffPixelCount(launcher80!.frame, backToLauncher!.frame);
    const returnFails: string[] = [];
    if (returnDiff > 0) returnFails.push(`launcher exactness: backToLauncher differs from launcher80 by ${returnDiff}px, expected 0`);
    outcomes.push(held("launcher-exact", "leaving a game reproduces the launcher exactly", returnFails, `launcher exactness: backToLauncher differs from launcher80 by ${returnDiff}px, expected 0`));

    return summariseInvariants(outcomes);
  }

  const [
    grid16, grid48, grid80,
    briefing, missionStart, firing, wave, pauseOverlay, backToGrid,
    idle, midSpin, landed, win, backToGridFromLucky7,
    golfReady, golfSwingImpact, backToGridFromGolf,
    aimTestOpen, backToGridFromAimTest,
    diagOpen, backToGridFromDiag,
  ] = frames;

  // (1) grid draws real content, at every one of the three boot captures
  const gridFails: string[] = [];
  const gridSeen: string[] = [];
  for (const [label, f] of [["grid16", grid16], ["grid48", grid48], ["grid80", grid80]] as const) {
    const dark = countDark(f!.frame, 100);
    const cyan = countCyan(f!.frame);
    gridSeen.push(`${label} ${dark}px dark / ${cyan}px cyan`);
    if (dark < MIN_GRID_DARK_PX) {
      gridFails.push(`grid content: only ${dark}px dark(<100) at ${label} (t=${f!.atMs}), min required ${MIN_GRID_DARK_PX}px - grid reads as a blank field`);
    }
    if (cyan < MIN_GRID_CYAN_PX) {
      gridFails.push(`grid content: only ${cyan}px cyan (tile icons) at ${label} (t=${f!.atMs}), min required ${MIN_GRID_CYAN_PX}px - tile icons missing`);
    }
  }
  outcomes.push(
    held(
      "grid",
      "the grid draws its five tiles, borders and title, not a flat field",
      gridFails,
      `grid content: ${gridSeen.join(", ")}, min required ${MIN_GRID_DARK_PX}px dark and ${MIN_GRID_CYAN_PX}px cyan`
    )
  );

  // (2) tap launches: grid -> GUNSHIP is a real, substantial screen change
  const launchDiff = diffPixelCount(grid80!.frame, briefing!.frame);
  const launchFails: string[] = [];
  if (launchDiff < MIN_LAUNCH_DIFF_PX) {
    launchFails.push(`launch transition: only ${launchDiff}px differ between grid80 (t=${grid80!.atMs}) and briefing (t=${briefing!.atMs}), min required ${MIN_LAUNCH_DIFF_PX}px - tapping the GUNSHIP tile does not appear to launch it`);
  }
  outcomes.push(
    held(
      "launch",
      "tapping a tile launches its game",
      launchFails,
      `launch transition: ${launchDiff}px differ between grid80 (t=${grid80!.atMs}) and briefing (t=${briefing!.atMs}), min required ${MIN_LAUNCH_DIFF_PX}px`
    )
  );

  // (3) simulation keeps advancing: six consecutive in-game transitions
  const ticks: [string, TimedFrame, TimedFrame][] = [
    ["briefing->missionStart", briefing!, missionStart!],
    ["missionStart->firing", missionStart!, firing!],
    ["firing->wave", firing!, wave!],
    ["idle->midSpin", idle!, midSpin!],
    ["midSpin->landed", midSpin!, landed!],
    ["landed->win", landed!, win!],
  ];
  const simFails: string[] = [];
  const simSeen: string[] = [];
  for (const [label, a, b] of ticks) {
    const d = diffPixelCount(a.frame, b.frame);
    simSeen.push(`${label} ${d}px`);
    if (d < MIN_TICK_DIFF_PX) {
      simFails.push(`simulation alive: only ${d}px differ across ${label} (t=${a.atMs}->t=${b.atMs}), min required ${MIN_TICK_DIFF_PX}px - looks frozen`);
    }
  }
  outcomes.push(held("sim", "each game's own simulation keeps advancing", simFails, `simulation alive: ${simSeen.join(", ")}, min required ${MIN_TICK_DIFF_PX}px each`));

  // (4) GUNSHIP's thermal palette holds during play: no gold/amber leakage
  const goldFails: string[] = [];
  const goldSeen: string[] = [];
  for (const [label, f] of [["briefing", briefing], ["missionStart", missionStart], ["firing", firing], ["wave", wave]] as const) {
    const gold = countGold(f!.frame);
    goldSeen.push(`${label} ${gold}px`);
    if (gold > MAX_GUNSHIP_GOLD_PX) {
      goldFails.push(`gunship palette: ${gold}px read as gold/amber at ${label} (t=${f!.atMs}), max allowed ${MAX_GUNSHIP_GOLD_PX}px - the thermal ramp is not holding during play`);
    }
  }
  outcomes.push(held("palette", "GUNSHIP's thermal palette holds during play", goldFails, `gunship palette: gold/amber ${goldSeen.join(", ")}, max allowed ${MAX_GUNSHIP_GOLD_PX}px`));

  // (5) exiting GUNSHIP or LUCKY 7 (swipe to pause, QUIT in the real
  // shell's own overlay) reproduces the exact prior grid screen
  const returnFails: string[] = [];
  const returnSeen: string[] = [];
  for (const [label, f] of [["backToGrid", backToGrid], ["backToGridFromLucky7", backToGridFromLucky7]] as const) {
    const d = diffPixelCount(grid80!.frame, f!.frame);
    returnSeen.push(`${label} ${d}px`);
    if (d > MAX_RETURN_DIFF_PX) {
      returnFails.push(`grid exactness: ${label} (t=${f!.atMs}) differs from grid80 (t=${grid80!.atMs}) by ${d}px, expected ${MAX_RETURN_DIFF_PX} (returning to the grid must reproduce it exactly)`);
    }
  }
  outcomes.push(held("grid-exact", "leaving a game reproduces the grid exactly", returnFails, `grid exactness: ${returnSeen.join(", ")} against grid80, expected ${MAX_RETURN_DIFF_PX}`));

  // (6) a swing (synthetic raw-accel samples) causes a real ball-state change
  const swingDiff = diffPixelCount(golfReady!.frame, golfSwingImpact!.frame);
  const swingFails: string[] = [];
  if (swingDiff < MIN_GOLF_SWING_DIFF_PX) {
    swingFails.push(`golf swing: only ${swingDiff}px differ between golfReady (t=${golfReady!.atMs}) and golfSwingImpact (t=${golfSwingImpact!.atMs}), min required ${MIN_GOLF_SWING_DIFF_PX}px - the swing does not appear to have armed and fired a shot`);
  }
  outcomes.push(
    held(
      "golf-swing",
      "a swing arms and fires a shot",
      swingFails,
      `golf swing: ${swingDiff}px differ between golfReady (t=${golfReady!.atMs}) and golfSwingImpact (t=${golfSwingImpact!.atMs}), min required ${MIN_GOLF_SWING_DIFF_PX}px`
    )
  );

  // (7) exiting GOLF reproduces the exact prior grid screen
  const golfReturnDiff = diffPixelCount(grid80!.frame, backToGridFromGolf!.frame);
  const golfReturnFails: string[] = [];
  if (golfReturnDiff > MAX_GOLF_RETURN_DIFF_PX) {
    golfReturnFails.push(`golf grid exactness: backToGridFromGolf (t=${backToGridFromGolf!.atMs}) differs from grid80 (t=${grid80!.atMs}) by ${golfReturnDiff}px, expected ${MAX_GOLF_RETURN_DIFF_PX} (returning to the grid from GOLF must reproduce it exactly - GOLF's own direct565 mode must be fully undone)`);
  }
  outcomes.push(
    held(
      "golf-grid-exact",
      "leaving GOLF undoes its direct565 mode and reproduces the grid exactly",
      golfReturnFails,
      `golf grid exactness: backToGridFromGolf differs from grid80 by ${golfReturnDiff}px, expected ${MAX_GOLF_RETURN_DIFF_PX}`
    )
  );

  // (8) AIM TEST and DIAG each open (a real screen change from the grid)
  // and exit back to it exactly - the donor's own harness apps, now
  // faithfully part of this port (NOTICE.md).
  const harnessFails: string[] = [];
  const harnessSeen: string[] = [];
  for (const [label, openFrame, backLabel, backFrame] of [
    ["aimTestOpen", aimTestOpen, "backToGridFromAimTest", backToGridFromAimTest],
    ["diagOpen", diagOpen, "backToGridFromDiag", backToGridFromDiag],
  ] as const) {
    const openDiff = diffPixelCount(grid80!.frame, openFrame!.frame);
    const backDiff = diffPixelCount(grid80!.frame, backFrame!.frame);
    harnessSeen.push(`${label} ${openDiff}px, ${backLabel} ${backDiff}px`);
    if (openDiff < MIN_OPEN_DIFF_PX) {
      harnessFails.push(`${label}: only ${openDiff}px differ from grid80 (t=${grid80!.atMs}) at t=${openFrame!.atMs}, min required ${MIN_OPEN_DIFF_PX}px - tapping the tile does not appear to open it`);
    }
    if (backDiff > MAX_RETURN_DIFF_PX) {
      harnessFails.push(`${backLabel}: differs from grid80 (t=${grid80!.atMs}) by ${backDiff}px at t=${backFrame!.atMs}, expected ${MAX_RETURN_DIFF_PX} (returning to the grid must reproduce it exactly)`);
    }
  }
  outcomes.push(
    held(
      "harness-apps",
      "AIM TEST and DIAG each open from the grid and return to it exactly",
      harnessFails,
      `${harnessSeen.join("; ")} (open min ${MIN_OPEN_DIFF_PX}px, return expected ${MAX_RETURN_DIFF_PX}px)`
    )
  );

  // pauseOverlay is captured for this bundle's own donor-comparison
  // material (apps/gameos/ports/esp32-s3-touch-amoled-18/README.md) but is
  // not itself asserted here beyond frame-count validity: the overlay's
  // own appearance is implied by (5)/(7)/(8) all requiring a clean return
  // afterward, and pauseOverlay's diff-vs-wave is already visible in this
  // bundle's own reproduction log.
  void pauseOverlay;

  return summariseInvariants(outcomes);
}
