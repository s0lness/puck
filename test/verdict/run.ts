#!/usr/bin/env bun
// Proves `puck verdict` (tools/verdict.ts) decides go / degraded / refuse
// from the files themselves, and for reasons a reader can check.
//
// It runs the real CLI as a subprocess, against the real descriptors and
// the real device.json files in this repository, never against fixtures of
// its own. That is deliberate: the thing worth protecting is not "the
// scoring function computes what it computes", it is "chrono is refused on
// a one-button board, and fluidbox's particle count on a small panel is
// the number that actually runs". Both of those are claims about THESE
// files, so a fixture would prove the wrong thing.
//
// Nine checks, each failing loudly on its own line:
//   1. chrono on the M5StickC PLUS2 silhouette is not refused, and the
//      reason it is degraded is the panel, not the buttons
//   2. that same verdict names both button roles as satisfied
//   3. chrono on the one-button silhouette is REFUSED
//   4. and the refusal names the button count, in the app's own words
//      about why the two controls are separate
//   5. fluidbox on the M5StickC PLUS2 is degraded, not refused
//   6. and it prints a particle count of 25, the number
//      apps/fluidbox/ports/web/fluid.c's own FLUID_N computes at 135x240
//   7. fluidbox on the one-button silhouette is refused for the missing
//      tilt vector (that board has no IMU), naming the fallback's cost
//   8. every app against packs/web is go: the pack the ports were written
//      against must not be told it fails its own apps
//   9. an unknown app or target exits 2 (never 0, and never a verdict)
//
// Exit codes follow the repo's own three-way split: 0 = every check
// passed, 1 = a check failed, and the CLI's own 2 means "never ran".
//
// Run: bun run test:verdict   (no zig, no browser, no hardware: this reads
// JSON and markdown, so it is one of the fast ones)

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

let failures = 0;
function fail(message: string): void {
  failures++;
  console.error(`FAIL: ${message}`);
}
function pass(message: string): void {
  console.log(`  ok: ${message}`);
}

interface VerdictCheck {
  dimension: string;
  status: "go" | "degraded" | "refuse" | "unchecked";
  reason: string;
}
interface VerdictResult {
  app: string;
  target: string;
  targetKind: string;
  verdict: "go" | "degraded" | "refuse";
  checks: VerdictCheck[];
  degrades: { name: string; value: number; reference: number; boundBy: string; what: string }[];
  human: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runVerdict(app: string, target: string): Run {
  const result = Bun.spawnSync(["bun", "run", "tools/verdict.ts", app, target, "--json"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

// A verdict this test expected to be able to read. Anything else (the tool
// missing, a crash, output that is not JSON) is reported as the failure it
// is instead of throwing an unhandled exception at the reader.
function verdictOf(app: string, target: string): VerdictResult | null {
  const run = runVerdict(app, target);
  if (run.exitCode > 1) {
    fail(`${app} x ${target}: verdict exited ${run.exitCode} (it never ran)\n${run.stderr.trim()}`);
    return null;
  }
  try {
    return JSON.parse(run.stdout) as VerdictResult;
  } catch {
    fail(`${app} x ${target}: verdict printed no JSON\n  stdout: ${run.stdout.trim().slice(0, 400)}\n  stderr: ${run.stderr.trim().slice(0, 400)}`);
    return null;
  }
}

function checkFor(result: VerdictResult, dimension: string): VerdictCheck | undefined {
  return result.checks.find((c) => c.dimension === dimension);
}

// ---- 1, 2: chrono fits the stick, at the cost of its layout -------------
{
  const result = verdictOf("chrono", "m5stickc-plus2");
  if (result) {
    if (result.verdict === "degraded") {
      pass(`chrono x m5stickc-plus2: ${result.verdict}`);
    } else {
      fail(`chrono x m5stickc-plus2: expected degraded (135x240 is under the 200x200 the app asks for, but its layout scales), got ${result.verdict}`);
    }
    const panel = checkFor(result, "panel");
    if (panel && panel.status === "degraded" && /135x240/.test(panel.reason)) {
      pass(`chrono x m5stickc-plus2: the degrade is the panel, and it says so: ${panel.reason}`);
    } else {
      fail(`chrono x m5stickc-plus2: expected the panel check to be the degraded one, naming the size; got ${JSON.stringify(panel)}`);
    }
    const buttons = checkFor(result, "buttons");
    if (buttons && buttons.status === "go") {
      pass(`chrono x m5stickc-plus2: both buttons satisfied (${buttons.reason})`);
    } else {
      fail(`chrono x m5stickc-plus2: this board declares a key and a click, so the buttons must be a fit; got ${JSON.stringify(buttons)}`);
    }
  }
}

// ---- 3, 4: chrono is refused on one button ------------------------------
{
  const result = verdictOf("chrono", "feather-esp32s2-tft");
  if (result) {
    if (result.verdict === "refuse") {
      pass(`chrono x feather-esp32s2-tft: ${result.verdict}`);
    } else {
      fail(`chrono x feather-esp32s2-tft: a stopwatch whose toggle and reset are deliberately separate cannot run on one button; expected refuse, got ${result.verdict}`);
    }
    const buttons = checkFor(result, "buttons");
    if (buttons && buttons.status === "refuse" && /\b1\b/.test(buttons.reason) && /2\b/.test(buttons.reason)) {
      pass(`chrono x feather-esp32s2-tft: the refusal counts the buttons: ${buttons.reason}`);
    } else {
      fail(`chrono x feather-esp32s2-tft: expected the buttons check to refuse and to name both counts; got ${JSON.stringify(buttons)}`);
    }
    if (/accident/.test(result.human)) {
      pass("chrono x feather-esp32s2-tft: the human line carries the app's own reason the controls are separate");
    } else {
      fail(`chrono x feather-esp32s2-tft: the human line should quote the demand's own "why", got: ${result.human}`);
    }
  }
}

// ---- 5, 6: fluidbox degrades to a stated particle count -----------------
{
  const result = verdictOf("fluidbox", "m5stickc-plus2");
  if (result) {
    if (result.verdict === "degraded") {
      pass(`fluidbox x m5stickc-plus2: ${result.verdict}`);
    } else {
      fail(`fluidbox x m5stickc-plus2: this board has the tilt vector and the colour panel, so the only cost is the particle count; expected degraded, got ${result.verdict}`);
    }
    const particles = result.degrades.find((d) => d.name === "particles");
    // 135 * 240 = 32400 px of panel, one particle per 1268 of them.
    // apps/fluidbox/ports/web/fluid.c computes exactly this, so a
    // disagreement here means the verdict is quoting a number that does
    // not run.
    if (particles && particles.value === 25 && particles.reference === 130) {
      pass(`fluidbox x m5stickc-plus2: ${particles.value} particles of the reference ${particles.reference}, bound by ${particles.boundBy}`);
    } else {
      fail(`fluidbox x m5stickc-plus2: expected 25 particles of 130 (32400 px / 1268), got ${JSON.stringify(particles)}`);
    }
    if (/\b25\b/.test(result.human)) {
      pass("fluidbox x m5stickc-plus2: the human line prints the number, not the word");
    } else {
      fail(`fluidbox x m5stickc-plus2: the human line should carry the particle count, got: ${result.human}`);
    }
  }
}

// ---- 7: fluidbox has nothing to pour with on a board with no IMU --------
{
  const result = verdictOf("fluidbox", "feather-esp32s2-tft");
  if (result) {
    if (result.verdict === "refuse") {
      pass(`fluidbox x feather-esp32s2-tft: ${result.verdict}`);
    } else {
      fail(`fluidbox x feather-esp32s2-tft: that board declares no sensors at all; expected refuse, got ${result.verdict}`);
    }
    const sensors = checkFor(result, "sensors");
    if (sensors && sensors.status === "refuse" && /vector/.test(sensors.reason)) {
      pass(`fluidbox x feather-esp32s2-tft: the refusal names the missing signal: ${sensors.reason}`);
    } else {
      fail(`fluidbox x feather-esp32s2-tft: expected the sensors check to refuse, naming the vector; got ${JSON.stringify(sensors)}`);
    }
  }
}

// ---- 8: the pack the ports were written against passes its own apps -----
{
  for (const app of ["chrono", "fluidbox", "tinydraw"]) {
    const result = verdictOf(app, "web");
    if (!result) continue;
    if (result.verdict === "go") {
      pass(`${app} x web: go`);
    } else {
      const worst = result.checks.filter((c) => c.status !== "go" && c.status !== "unchecked");
      fail(`${app} x web: the web pack is what these ports were written against, so it must be go; got ${result.verdict} (${worst.map((c) => `${c.dimension}: ${c.reason}`).join("; ")})`);
    }
  }
}

// ---- 9: an unknown name never produces a verdict ------------------------
{
  const unknownApp = runVerdict("nosuchapp", "web");
  if (unknownApp.exitCode === 2) pass("an unknown app exits 2");
  else fail(`an unknown app must exit 2 (never ran), got ${unknownApp.exitCode}`);

  const unknownTarget = runVerdict("chrono", "nosuchdevice");
  if (unknownTarget.exitCode === 2) pass("an unknown target exits 2");
  else fail(`an unknown target must exit 2 (never ran), got ${unknownTarget.exitCode}`);
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed - see above`);
  process.exit(1);
}
console.log("\nPASS: verdict decides go, degraded and refuse from the descriptors and the device.json files");
