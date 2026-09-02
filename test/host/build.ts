// Compiles test/host/fixtures/clean.c to wasm32-freestanding. Mirrors
// example/build.ts's toolchain invocation and retry logic exactly (see
// that file for the full header comment on why the retry loop and its
// timeout exist). Only clean.c gets a wasm build: oob.c and overflow.c
// exist to prove the HOST side catches something, and wasm32 is
// memory-safe by construction - building them to wasm would only prove
// wasm still runs their bug clean, which test/host/run.ts's own header
// comment already states as the premise, not something worth spending a
// second build proving per fixture.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
  // Growing, for the same measured reason harness/hostSide.ts backs off: the
  // attempts that write nothing at all are a window, and eight of them
  // 400ms apart can land entirely inside one.
  let pause = 400;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Removed before every attempt, so the check below can only ever see a
    // module THIS attempt wrote. See that check for why it exists at all.
    rmSync(out, { force: true });
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      // PIPED, NOT INHERITED, and that is not cosmetic. Measured while
      // writing this: with inherit, this exact command dies at exit 5
      // having written nothing, eight attempts running, while the same
      // command run by hand and the same command with piped stdio both
      // succeed immediately. A child handed a parent stdout that is itself
      // a pipe some tool is draining can fail to start at all on Windows,
      // and silently, since there is nowhere for it to say so. Piping also
      // means a REAL compile error is captured and can be reported, which
      // inherit could only ever scroll past.
      result = Bun.spawnSync([ZIG, ...args], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    } catch (err) {
      throw new Error(`could not run "${ZIG}" building clean.wasm: ${err instanceof Error ? err.message : String(err)} (zig not found? set ZIG_EXE to its path)`);
    }
    if (result.success) return { wasmPath: out };
    // THE MODULE ON DISK IS THE VERDICT, NOT THE EXIT CODE, and the same
    // measurement harness/hostSide.ts's own runZig() documents applies here:
    // `zig cc` on this project's Windows-on-ARM development machine
    // intermittently exits 5 having written a complete, correct artifact,
    // with nothing at all on stderr. Retrying that is time spent hoping the
    // next run reports itself honestly. An attempt that produced the module
    // it was asked for is accepted; an attempt that produced nothing is
    // retried, and the wait between attempts is what the flake actually
    // needs when the process never got to run at all.
    if (existsSync(out) && statSync(out).size > 0) return { wasmPath: out };
    const diagnostics = [result.stdout?.toString() ?? "", result.stderr?.toString() ?? ""].join("").trim();
    if (diagnostics) console.error(diagnostics);
    lastError = new Error(`zig cc exited ${result.exitCode} building clean.wasm${diagnostics ? `:
${diagnostics}` : " and wrote nothing, with no diagnostic text"}`);
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`zig cc exited ${result.exitCode} building clean.wasm and wrote nothing (attempt ${attempt}/${MAX_ATTEMPTS}), waiting ${pause}ms and retrying...`);
      Bun.sleepSync(pause);
      pause = Math.min(pause * 2, 10_000);
    }
  }
  throw lastError;
}

if (import.meta.main) {
  const { wasmPath } = buildCleanFixtureWasm();
  console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
}
