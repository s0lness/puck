// Compiles every hostile firmware under test/hostile/firmware/*.c to
// wasm32-freestanding, one .wasm each, into test/hostile/dist/ (gitignored,
// same as wasm/dist/ - see .gitignore). Mirrors example/build.ts's toolchain
// invocation exactly (same flags, same reasoning; see that file's header
// comment for why each flag is there): the point of this suite is that
// these are REAL compiled modules driven through the REAL dev server, not
// TypeScript stand-ins for what a hostile module might do.
//
// Run directly (`bun run test/hostile/build.ts`) or via test/hostile/run.ts,
// which calls buildHostileFirmware() per case before driving it.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { runZigCc } from "../../tools/zigSpawn";

const ROOT = resolve(import.meta.dir, "..", ".."); // repo root
const FIRMWARE_DIR = join(import.meta.dir, "firmware");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(import.meta.dir, "dist");

// The base ABI every hostile firmware implements (identical set to
// example/build.ts's EMU_EXPORTS). One case (audio_bad_buffer) also
// declares the optional sound exports; see SOUND_EXPORTS below.
const BASE_EXPORTS = [
  "emu_device",
  "emu_init",
  "emu_tick",
  "emu_fb",
  "emu_push_count",
  "emu_push_x",
  "emu_push_y",
  "emu_push_w",
  "emu_push_h",
  "emu_touch",
  "emu_button",
  "emu_button_verdict",
  "emu_sensor_event",
];
const SOUND_EXPORTS = ["emu_sound_sample_rate", "emu_sound_play_seq", "emu_sound_stop_seq", "emu_sound_buffer", "emu_sound_frames"];
const APP_EXPORTS = ["emu_app_current", "emu_app_switch"];

// Firmware files whose export list includes the optional sound ABI. Every
// other .c file in firmware/ gets BASE_EXPORTS only.
const SOUND_CASES = new Set(["audio_bad_buffer"]);

// Firmware files whose export list includes the optional apps ABI (see
// emu_abi.h: "a firmware without a concept of apps leaves these
// unimplemented and the emulator will not call them").
const APP_CASES = new Set(["app_switch_trap"]);

export interface BuildResult {
  name: string;
  wasmPath: string;
}

function exportsFor(name: string): string[] {
  let exports = BASE_EXPORTS;
  if (SOUND_CASES.has(name)) exports = [...exports, ...SOUND_EXPORTS];
  if (APP_CASES.has(name)) exports = [...exports, ...APP_EXPORTS];
  return exports;
}

// Compiles one firmware/<name>.c -> dist/<name>.wasm. Throws (with zig's
// own diagnostics already printed by tools/zigSpawn.ts's runZigCc, on a
// real failure) rather than returning a pass/fail flag: a build failure
// here means the test suite itself cannot run, which is categorically
// different from a hostile firmware behaving hostilely at runtime, and
// must not be swallowed into a false pass.
export function buildHostileFirmware(name: string): BuildResult {
  const src = join(FIRMWARE_DIR, `${name}.c`);
  if (!existsSync(src)) throw new Error(`no such hostile firmware: ${src}`);
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
    ...exportsFor(name).map((n) => `-Wl,--export=${n}`),
    "-I",
    ABI_DIR,
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
  // maxAttempts left at tools/zigSpawn.ts's default (8, same as every
  // pack's own build.ts): this used to be capped at 5 with a flat 300ms
  // pause, measurably too thin under today's actual concurrent load (this
  // repo's other worktrees/agents building at the same time) - proven by
  // running it directly, which succeeded immediately, right after five
  // straight failures through `bun run test:hostile`'s own extra process
  // layer. The flake is real contention, not a coin flip; the fix is
  // giving it the same room every other zig invocation in this repo now
  // gets, not a smaller one for no reason tied to this file.
  const result = runZigCc(args, out, { isWasm: true });
  if (result.ok) return { name, wasmPath: out };
  throw new Error(
    result.stderr.trim().length > 0
      ? `zig cc failed building ${name} (see diagnostics above)`
      : `zig cc exited ${result.exitCode} building ${name} on all ${result.attempts} attempts and wrote nothing, with no diagnostic text`
  );
}

export function listHostileFirmwareNames(): string[] {
  return readdirSync(FIRMWARE_DIR)
    .filter((f) => f.endsWith(".c"))
    .map((f) => basename(f, ".c"))
    .sort();
}

// Runnable standalone: `bun run test/hostile/build.ts` builds every case
// and reports sizes, without driving any of them through the browser.
if (import.meta.main) {
  for (const name of listHostileFirmwareNames()) {
    const { wasmPath } = buildHostileFirmware(name);
    console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
  }
}
