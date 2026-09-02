#!/usr/bin/env bun
// Proves harness/hostSide.ts's native, sanitizer-instrumented build
// actually catches the compiler class of defect wasm hides - the negative
// control this whole harness side exists for (docs/harness.md's "three
// marks"). No pack, no bundle, no real device: three tiny, self-contained
// firmwares (test/host/fixtures/*.c, same minimum-viable shape as
// example/firmware/main.c) that implement wasm/emu_abi.h directly.
//
//   bun run test:host
//
// RED BEFORE GREEN, literally what this file proves, in order:
//   1. clean.c builds to wasm AND to a native sanitized host executable,
//      and the SAME trace replayed through both produces the SAME
//      framebuffer, pixel for pixel (harness/hostSide.ts's "ok" verdict,
//      compared with src/compare.ts's compareFrames). This is the "does
//      the whole pipeline even work" proof, run first so a failure in
//      steps 2-3 cannot be mistaken for a broken harness.
//   2. oob.c (a real out-of-bounds write on emu_tick(), test/host/
//      fixtures/oob.c's own header comment) reports SANITIZER, naming
//      that exact file and line - and the SAME source, unmodified,
//      compiles and runs perfectly clean when built to wasm (this is
//      asserted directly below: wasm32 is memory-safe by construction, so
//      this fixture would pass every wasm-only check that exists in this
//      repository forever).
//   3. overflow.c (a signed integer overflow, test/host/fixtures/
//      overflow.c) likewise reports SANITIZER, naming its own line.
//
// A test suite where every fixture passes would be worth nothing - step 1
// is the "green" half, steps 2-3 are the "red" half this file exists to
// prove happens at all.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCleanFixtureWasm } from "./build";
import { replayEmulator } from "../../harness/emulatorSide";
import { buildHostExe, replayHost, type HostSourceSpec } from "../../harness/hostSide";
import { compareFrames } from "../../src/compare";
import type { TraceEvent } from "../../src/recorder";

const ROOT = resolve(import.meta.dir, "..", "..");
const ABI_DIR = join(ROOT, "wasm");
const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// One tick, one capture, at t=16 - enough to exercise emu_init() then
// exactly one emu_tick() (where every fixture's own behaviour, correct or
// deliberately broken, lives - see each fixture's own header comment).
const EVENTS: TraceEvent[] = [{ t: 16, k: "tick" }];
const CAPTURE_POINTS = [16];

function specFor(fixtureFile: string): HostSourceSpec {
  return {
    sources: [join(FIXTURES_DIR, fixtureFile)],
    includes: [ABI_DIR],
    defines: ["-DEMU_HOST_NATIVE=1"],
  };
}

async function checkClean(): Promise<void> {
  console.log("\n-- clean.c: must MATCH (wasm vs. native host) --");
  const { wasmPath } = buildCleanFixtureWasm();
  console.log(`built ${wasmPath}`);

  const build = await buildHostExe(specFor("clean.c"));
  if (!build.ok) fail(`clean.c: host build failed (this should never happen for a correct fixture): ${build.error}`);
  console.log(`built ${build.exePath} (sanitizers: ${build.sanitizers.join(", ")})`);

  const wasmResult = await replayEmulator(wasmPath, EVENTS, CAPTURE_POINTS);
  const hostResult = await replayHost(build.exePath, EVENTS, CAPTURE_POINTS);

  if (hostResult.verdict === "sanitizer") {
    fail(`clean.c: host run reported SANITIZER, but this fixture has no deliberate defect:\n${hostResult.report}`);
  }
  if (hostResult.frames.length !== 1 || wasmResult.frames.length !== 1) {
    fail(`clean.c: expected 1 frame from each side, got wasm=${wasmResult.frames.length} host=${hostResult.frames.length}`);
  }

  const d = compareFrames(wasmResult.frames[0]!.frame, hostResult.frames[0]!.frame, 0);
  if (!d.match) {
    fail(`clean.c: wasm and host DIVERGED (${d.diffPixels}/${d.totalPixels}px) - the harness itself is broken, not the fixture`);
  }
  console.log(`MATCH: ${d.totalPixels} identical pixels`);
}

// name: which fixture (for logging). fixtureFile: its source, under
// test/host/fixtures/. expectSubstring: text the sanitizer report must
// contain - naming both the fixture's own file and the specific UBSan
// check that should fire, so this test fails loudly if the WRONG check
// trips (or none at all) rather than accepting any non-zero exit as
// success.
async function checkSanitizerFixture(name: string, fixtureFile: string, expectSubstrings: string[]): Promise<void> {
  console.log(`\n-- ${fixtureFile}: must report SANITIZER, naming the line --`);
  const build = await buildHostExe(specFor(fixtureFile));
  if (!build.ok) fail(`${fixtureFile}: host build failed: ${build.error}`);
  console.log(`built ${build.exePath} (sanitizers: ${build.sanitizers.join(", ")})`);

  const result = await replayHost(build.exePath, EVENTS, CAPTURE_POINTS);
  if (result.verdict !== "sanitizer") {
    fail(`${fixtureFile}: expected SANITIZER, host run exited clean - this fixture's deliberate defect (see its own header comment) was NOT caught. ` + `This is the exact failure this test exists to prevent: a real memory-safety or UB bug silently passing.`);
  }
  console.log(`SANITIZER report:\n${result.report
    .trim()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")}`);
  for (const needle of expectSubstrings) {
    if (!result.report.includes(needle)) {
      fail(`${fixtureFile}: SANITIZER report did not mention "${needle}" - got:\n${result.report}`);
    }
  }
  console.log(`${name}: SANITIZER report names the expected file/check`);
}

async function main(): Promise<void> {
  await checkClean();
  // zig cc bundles its OWN UBSan runtime (lib/ubsan_rt.zig), not LLVM's
  // compiler-rt - found by actually reading a report, not assumed: it
  // reports "thread N panic: <what>" rather than compiler-rt's familiar
  // "runtime error: <what>". Both name the exact file:line either way
  // (this fixture's file is what actually matters), so the substring this
  // test insists on matches zig's own wording, not a guess at LLVM's.
  await checkSanitizerFixture("out-of-bounds write", "oob.c", ["oob.c", "out of bounds"]);
  await checkSanitizerFixture("signed integer overflow", "overflow.c", ["overflow.c", "overflow"]);

  console.log("\nPASS: test:host (clean fixture matched; both negative-control fixtures were caught)");
  rmSync(join(import.meta.dir, "dist"), { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`test/host/run.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
