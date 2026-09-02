// Compiles example/firmware/main.c to wasm32-freestanding with `zig cc`,
// writing the result to wasm/dist/emu.wasm - the exact path server.ts
// watches and serves. This is a real invocation of the same kind of build
// step your own firmware needs: zig (or any C-to-wasm32-freestanding
// toolchain) is a BINARY this script invokes, never a language this repo
// is written in. See AGENTS.md's "TypeScript only" rule.
//
// One command, per the README's promise: `bun run example/build.ts`.
//
// Toolchain notes, so your own firmware's build script doesn't have to
// rediscover these the hard way:
//
//   - `-Wl,--import-symbols` (a zig/lld wasm-specific flag, reachable
//     through -Wl, from the `cc` frontend) leaves undefined externs
//     (js_log, and any math function you use but don't define) as wasm
//     imports instead of a hard link error. `-Wl,--allow-undefined`,
//     which sounds like the right flag, is rejected by zig cc outright.
//   - `-Wl,--export-dynamic` ("export everything with default
//     visibility") is flaky for wasm32-freestanding on the zig/lld
//     versions this was tested against: it can silently fail to export
//     what you expect. One `-Wl,--export=<name>` per ABI symbol below is
//     deterministic instead: verified by inspecting the built module with
//     WebAssembly.Module.exports() in Chrome devtools if you ever need to
//     double check.
//   - The freestanding wasm32 target ships the C standard's REQUIRED
//     freestanding headers (stdint.h, stdbool.h, stddef.h, stdarg.h) but
//     NOT the hosted-only ones (stdlib.h, stdio.h, math.h). This example
//     firmware avoids all three, so it needs no shim headers at all. If
//     your firmware includes any of those, you'll need to provide a
//     stand-in header on your own include path - see docs/abi.md for
//     the shape of one.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runZigCc, ZIG_EXE } from "../tools/zigSpawn";

const ROOT = resolve(import.meta.dir, ".."); // repo root
const SRC = join(ROOT, "example", "firmware", "main.c");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(ABI_DIR, "dist");
const OUT = join(DIST, "emu.wasm");

// Exactly the ABI symbols this example firmware implements. Deliberately
// NOT the full emu_abi.h list: apps and sound are optional, and this
// firmware declares neither (see main.c's header comment). Exporting a
// symbol that isn't implemented is a link error, which is the point: a
// forgotten export fails loudly here, not silently at runtime in the page.
const EMU_EXPORTS = [
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

if (!existsSync(SRC)) {
  console.error(`source not found: ${SRC}`);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

const args = [
  "cc",
  "-target", "wasm32-freestanding",
  "-O2",
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--import-symbols",
  ...EMU_EXPORTS.map((name) => `-Wl,--export=${name}`),
  "-I", ABI_DIR, // emu_abi.h
  SRC,
  "-o", OUT,
];

console.log(`${ZIG_EXE} ${args.join(" ")}`);

// zig cc crashes inside its own linker roughly one run in three with this
// many -Wl,--export= flags (verified against this exact toolchain by the
// RP2350 sibling's build.ts, packs/rp2350-touch-amoled-18/wasm/build.ts):
// exit code 5, no diagnostic, and the very next attempt with identical
// arguments succeeds. Retried here, with a pause between attempts, for the
// same reason that file gives: the failure rate is far worse under
// concurrent contention, and the person most likely to hit this is running
// the command for the first time with no reason yet to believe the
// repository works.
//
// THE TIMEOUT IS NOT DECORATION: the same bug also HANGS, not just crashes
// (observed twice on 2026-08-19, a zig process sitting at 0.02 seconds of
// CPU for thirteen minutes on arguments that then succeeded immediately on
// a manual retry - see packs/web/wasm/build.ts's compileModule for the
// original writeup). A retry loop that only catches a non-zero exit waits
// forever for that one, which is a far worse failure than a crash: a build
// that never returns looks like a build that is working. Two minutes is
// many times what a real compile of this one file takes, even under a
// saturated machine.
// The retry/verdict mechanics live in tools/zigSpawn.ts now (one shared
// implementation across every pack and every test build script - see that
// file's header comment for the measurement this loop used to guess at
// blind: piped stdio means a genuine compile error is captured and
// reported immediately instead of retried, and the artifact at OUT is
// checked directly rather than trusted to zig's own exit code). That same
// helper also carries the ENOENT catch this loop used to need (no zig
// installed yet, ZIG_EXE unset) - verified by actually removing zig from
// PATH and running this script.
let result: ReturnType<typeof runZigCc>;
try {
  result = runZigCc(args, OUT, { isWasm: true });
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}`);
  console.error(`(zig not found? set ZIG_EXE to its path, or install it: https://ziglang.org/download/)`);
  process.exit(1);
}

if (!result.ok) {
  console.error(
    result.stderr.trim().length > 0
      ? `zig cc failed (exit ${result.exitCode}), so this is a real build failure - see diagnostics above`
      : `zig cc exited ${result.exitCode} on all ${result.attempts} attempts with no diagnostic text and wrote nothing, so this is a real build failure`
  );
  console.error(`(zig not found? set ZIG_EXE to its path, or install it: https://ziglang.org/download/)`);
  process.exit(result.exitCode ?? 1);
}

const size = statSync(OUT).size;
console.log(`built ${OUT} (${size} bytes)`);
