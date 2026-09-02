// Compiles the two WASI-lite fixture firmwares (test/wasi/firmware/) to
// wasm32-freestanding, into test/wasi/dist/. Same toolchain invocation and
// same retry loop as test/regression/build.ts and example/build.ts: zig cc
// crashes in its own linker roughly one run in three on this toolchain
// (AGENTS.md), clean on immediate retry.
//
// No -I for wasm/: these two fixtures deliberately do not include
// emu_abi.h, so that what they compile against is only "a C compiler and a
// target", the same position an external app's own repository is in. No
// -Wl,--export= flags either: both fixtures export the ABI from their own
// source with __attribute__((export_name(...))), which keeps zig cc off the
// linker path that crashes deterministically under a nested bun process
// (see test/fixtures/external-app/README.md for the measurement).
//
// Run directly (`bun run test/wasi/build.ts`) or via test/wasi/run.ts,
// which calls buildWasiFixture() per module.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runZigCc } from "../../tools/zigSpawn";

const SRC_DIR = join(import.meta.dir, "firmware");
const DIST = join(import.meta.dir, "dist");

// name: the .c file's stem under firmware/, and the .wasm's stem under
// dist/. Throws (zig's own diagnostics already printed by
// tools/zigSpawn.ts's runZigCc, on a real failure) rather than returning a
// flag: a build failure means the test cannot run at all, which is a
// different thing from the test running and reporting a failure.
export function buildWasiFixture(name: string): string {
  const src = join(SRC_DIR, `${name}.c`);
  if (!existsSync(src)) throw new Error(`source not found: ${src}`);
  mkdirSync(DIST, { recursive: true });
  const out = join(DIST, `${name}.wasm`);

  const args = [
    "cc",
    "-target",
    "wasm32-freestanding",
    "-O2",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--import-symbols",
    src,
    "-o",
    out,
  ];

  // The retry/verdict mechanics live in tools/zigSpawn.ts now (one shared
  // implementation across every pack and every test build script - see
  // that file's header comment for the measurement this loop used to
  // guess at blind: piped stdio means a genuine compile error is captured
  // and reported immediately instead of retried, and the artifact at
  // `out` is checked directly rather than trusted to zig's own exit code).
  // maxAttempts left at tools/zigSpawn.ts's default (16, same as every
  // pack's own build.ts) - see test/hostile/build.ts's equivalent comment
  // for why the previous 5-attempt, flat-300ms-pause budget measurably
  // was not enough under today's real concurrent load.
  const result = runZigCc(args, out, { isWasm: true });
  if (result.ok) return out;
  throw new Error(
    result.stderr.trim().length > 0
      ? `zig cc failed building ${name} (see diagnostics above)`
      : `zig cc exited ${result.exitCode} building ${name} on all ${result.attempts} attempts and wrote nothing, with no diagnostic text`
  );
}

if (import.meta.main) {
  for (const name of ["probe", "unsupported"]) {
    const out = buildWasiFixture(name);
    console.log(`built ${out} (${statSync(out).size} bytes)`);
  }
}
