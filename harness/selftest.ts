// Proves the harness mechanism itself works, with no real hardware
// attached: builds a small synthetic trace against the example firmware,
// replays it through both emulatorSide.ts AND the fake loopback link
// (fixtures/loopbackLink.ts, which is just a second instance of the same
// wasm module - see that file's header comment for exactly what this does
// and does not prove), and asserts the frames match.
//
// This is NOT a test that your differential harness setup will work
// against real hardware. It is a test that this repo's own harness code
// (pacing, capture points, pixel comparison) is not broken. Run it after
// any change to harness/*.ts; run `bun run example:build` first if
// wasm/dist/emu.wasm doesn't exist yet.
//
//   bun run harness:selftest

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { replayHardware } from "./hardwareSide";
import { compareFrames } from "../src/compare";
import makeLoopbackLink from "./fixtures/loopbackLink";
import type { TraceEvent } from "./types";
import type { CapturedFrame } from "../src/frame";

const ROOT = join(import.meta.dir, "..");
const WASM = join(ROOT, "wasm", "dist", "emu.wasm");
const EXAMPLE_FIRMWARE_C = join(ROOT, "example", "firmware", "main.c");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(WASM)) {
  fail(`${WASM} does not exist. Run "bun run example:build" first.`);
}

// The name this self-test's own wasm/dist/emu.wasm is EXPECTED to declare,
// read from example/firmware/main.c's own emu_device() JSON rather than
// hardcoded here (AGENTS.md: nothing in harness/ names one device's shape -
// a panel size least of all, but a device NAME hardcoded here would be the
// same mistake). One string, read from the one place that owns it, so this
// file can never drift from what example/build.ts actually compiles.
function expectedDeviceName(): string {
  const src = readFileSync(EXAMPLE_FIRMWARE_C, "utf8");
  // g_deviceJson is written as a C string literal, so every JSON quote is
  // escaped (\") in the source text this reads - matching the LITERAL
  // backslash-quote here, not a plain JSON quote, is what makes this find
  // anything at all.
  const m = src.match(/\\"name\\"\s*:\s*\\"([^\\"]+)\\"/);
  if (!m) fail(`could not find a "name" field in ${EXAMPLE_FIRMWARE_C}'s emu_device() JSON string`);
  return m[1]!;
}

// A small hand-built trace exercising touch (a partial-refresh push) and a
// button short-press (a full-panel push), against the example firmware's
// declared button/sensor indices (see example/firmware/main.c: BTN_A = 0).
// Timestamps are milliseconds, matching performance.now()'s unit.
const events: TraceEvent[] = [
  { t: 0, k: "tick" },
  { t: 16, k: "touch", down: 1, x: 100, y: 100 },
  { t: 16, k: "tick" },
  { t: 32, k: "touch", down: 0, x: 100, y: 100 },
  { t: 32, k: "tick" },
  { t: 300, k: "button", i: 0, down: 1 },
  { t: 300, k: "tick" },
  { t: 320, k: "button", i: 0, down: 0 },
  { t: 320, k: "verdict", i: 0, long: 0 },
  { t: 320, k: "tick" },
];

const capturePoints = [32, 320];

console.log(`replaying ${events.length} synthetic events against ${WASM}`);

const emuResult = await replayEmulator(WASM, events, capturePoints);
console.log(`emulator side: ${emuResult.frames.length} frame(s), device "${emuResult.device.name}"`);

// This self-test's synthetic events (BTN_A at index 0, a single touch
// point) are hand-built against example/firmware/main.c specifically - a
// wasm/dist/emu.wasm built from some OTHER firmware (a pack build left in
// place, say) could easily load, declare a device, and even produce frames
// that happen not to diverge from the loopback link's copy of that SAME
// wrong module, which would make everything below pass for the wrong
// reason. Checking the device name against the one file this test's events
// are actually written for catches that before it gets there.
const wantDeviceName = expectedDeviceName();
if (emuResult.device.name !== wantDeviceName) {
  fail(
    `${WASM} declares device "${emuResult.device.name}", not "${wantDeviceName}" (example/firmware/main.c's own emu_device()). ` +
      `This is some other module, not the example firmware this self-test's events are written for - run "bun run example:build" and try again.`
  );
}

const hwResult = await replayHardware(makeLoopbackLink(WASM), events, capturePoints);
console.log(`loopback side: ${hwResult.frames.length} frame(s)`);

if (emuResult.frames.length !== hwResult.frames.length) {
  fail(`frame count mismatch: ${emuResult.frames.length} vs ${hwResult.frames.length}`);
}

let allMatch = true;
for (let i = 0; i < emuResult.frames.length; i++) {
  const a = emuResult.frames[i]!;
  const b = hwResult.frames[i]!;
  const d = compareFrames(a.frame, b.frame, 0);
  if (d.match) {
    console.log(`  t=${a.atMs}ms  MATCH`);
  } else {
    allMatch = false;
    console.log(`  t=${a.atMs}ms  DIVERGE  ${d.diffPixels}/${d.totalPixels} px`);
  }
}

if (!allMatch) fail("harness self-test diverged against its own loopback link; the harness mechanism itself is broken (see harness/compare.ts, harness/emulatorSide.ts, harness/hardwareSide.ts)");

// ---- negative control -----------------------------------------------------
// Every comparison above passing proves the emulator and the loopback link
// agree. It does NOT prove compareFrames() is capable of reporting a
// divergence at all - a compareFrames that always returned match:true (a
// stray early return, an inverted condition) would sail through everything
// above and this self-test would report PASS while checking nothing. This
// corrupts a copy of one real captured frame and asserts compareFrames
// actually flags it, at the exact capture point it was corrupted for -
// proof this self-test can fail, not just that it happened not to.
const sample = emuResult.frames[0];
if (!sample) fail("no captured frames to run the negative control against");
const corruptedRgb = new Uint8Array(sample.frame.rgb);
const CORRUPT_BYTES = Math.min(12, corruptedRgb.length);
for (let i = 0; i < CORRUPT_BYTES; i++) corruptedRgb[i] = 255 - corruptedRgb[i]!;
const corrupted: CapturedFrame = { width: sample.frame.width, height: sample.frame.height, rgb: corruptedRgb };
const negControl = compareFrames(sample.frame, corrupted, 0);
if (negControl.match || negControl.diffPixels <= 0) {
  fail(
    `negative control failed: corrupting ${CORRUPT_BYTES} byte(s) of the frame captured at t=${sample.atMs}ms was NOT reported as a divergence by compareFrames - the comparison mechanism itself cannot be trusted to catch a real one`
  );
}
console.log(`negative control: corrupting the frame captured at t=${sample.atMs}ms was correctly reported as a divergence (${negControl.diffPixels}/${negControl.totalPixels}px) by compareFrames`);

console.log("\nPASS: harness mechanism verified (emulator replay, loopback replay, pacing, capture points and pixel comparison all agree, and a corrupted frame is correctly caught)");
console.log("Reminder: this used the fake loopback link, not real hardware - see fixtures/loopbackLink.ts's header comment.");
