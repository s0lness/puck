// Compiles test/host/fixtures/clean.c to wasm32-freestanding. Mirrors
// example/build.ts's toolchain invocation (see that file for the full
// header comment on why each flag is there); the retry/verdict mechanics
// come from tools/zigSpawn.ts, the one shared implementation of "pipe the
// child's stdio, retry only a silent failure, trust the artifact on disk
// over a lying exit code" - see that file's header comment for the
// measurement behind it. Only clean.c gets a wasm build: oob.c and
// overflow.c exist to prove the HOST side catches something, and wasm32 is
// memory-safe by construction - building them to wasm would only prove
// wasm still runs their bug clean, which test/host/run.ts's own header
// comment already states as the premise, not something worth spending a
// second build proving per fixture.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runZigCc } from "../../tools/zigSpawn";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(import.meta.dir, "fixtures", "clean.c");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(import.meta.dir, "dist");

const EXPORTS = ["emu_device", "emu_init", "emu_tick", "emu_fb", "emu_push_count", "emu_push_x", "emu_push_y", "emu_push_w", "emu_push_h", "emu_touch", "emu_button", "emu_button_verdict", "emu_sensor_event"];

export interface FixtureWasmBuild {
  wasmPath: string;
}

export function buildCleanFixtureWasm(): FixtureWasmBuild {
  if (!existsSync(SRC)) throw new Error(`source not found: ${SRC}`);
  mkdirSync(DIST, { recursive: true });
  const out = join(DIST, "clean.wasm");

  const args = ["cc", "-target", "wasm32-freestanding", "-O2", "-nostdlib", "-Wl,--no-entry", "-Wl,--import-symbols", ...EXPORTS.map((n) => `-Wl,--export=${n}`), "-I", ABI_DIR, SRC, "-o", out];

  const result = runZigCc(args, out, { isWasm: true });
  if (result.ok) return { wasmPath: out };
  throw new Error(
    result.stderr.trim().length > 0
      ? `zig cc failed building clean.wasm (see diagnostics above)`
      : `zig cc exited ${result.exitCode} building clean.wasm on all ${result.attempts} attempts and wrote nothing, with no diagnostic text`
  );
}

if (import.meta.main) {
  const { wasmPath } = buildCleanFixtureWasm();
  console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
}
