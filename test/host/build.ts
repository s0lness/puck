// Compiles test/host/fixtures/clean.c to wasm32-freestanding. Mirrors
// example/build.ts's toolchain invocation and retry logic exactly (see
// that file for the full header comment on why the retry loop and its
// timeout exist). Only clean.c gets a wasm build: oob.c and overflow.c
// exist to prove the HOST side catches something, and wasm32 is
// memory-safe by construction - building them to wasm would only prove
// wasm still runs their bug clean, which test/host/run.ts's own header
// comment already states as the premise, not something worth spending a
// second build proving per fixture.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(import.meta.dir, "fixtures", "clean.c");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(import.meta.dir, "dist");

const ZIG = process.env.ZIG_EXE ?? "zig";

const EXPORTS = ["emu_device", "emu_init", "emu_tick", "emu_fb", "emu_push_count", "emu_push_x", "emu_push_y", "emu_push_w", "emu_push_h", "emu_touch", "emu_button", "emu_button_verdict", "emu_sensor_event"];

export interface FixtureWasmBuild {
  wasmPath: string;
}

export function buildCleanFixtureWasm(): FixtureWasmBuild {
  if (!existsSync(SRC)) throw new Error(`source not found: ${SRC}`);
  mkdirSync(DIST, { recursive: true });
  const out = join(DIST, "clean.wasm");

  const args = ["cc", "-target", "wasm32-freestanding", "-O2", "-nostdlib", "-Wl,--no-entry", "-Wl,--import-symbols", ...EXPORTS.map((n) => `-Wl,--export=${n}`), "-I", ABI_DIR, SRC, "-o", out];

  const MAX_ATTEMPTS = 8;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit", timeout: 120_000 });
    } catch (err) {
      throw new Error(`could not run "${ZIG}" building clean.wasm: ${err instanceof Error ? err.message : String(err)} (zig not found? set ZIG_EXE to its path)`);
    }
    if (result.success) return { wasmPath: out };
    lastError = new Error(`zig cc exited ${result.exitCode} building clean.wasm`);
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`zig cc exited ${result.exitCode} building clean.wasm (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
      Bun.sleepSync(400);
    }
  }
  throw lastError;
}

if (import.meta.main) {
  const { wasmPath } = buildCleanFixtureWasm();
  console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
}
