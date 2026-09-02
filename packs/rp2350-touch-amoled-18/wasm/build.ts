// build.ts: compiles the real firmware (runtime_core.c, gfx.c, sound_synth.c,
// every app under firmware/apps/) plus this directory's emu_shim.c to a
// single wasm32-freestanding module, per docs/decisions/0003-emulator-runs-
// the-real-apps.md. TypeScript, run with `bun run pack:build` from the repo
// root, not .js/.mjs: this repo is TypeScript-only for everything it owns,
// build scripts included (AGENTS.md).
//
// Toolchain notes that shaped the flags below, found by actually invoking
// zig 0.16.0 rather than assumed from its docs:
//
//   - `-Wl,--allow-undefined` (the flag this file's task brief expected to
//     need) is rejected outright by zig cc: "unsupported linker arg". The
//     flag that actually leaves undefined externs as wasm imports for this
//     target is `-Wl,--import-symbols` (a zig/lld wasm-specific option, only
//     reachable through -Wl, from the `cc` frontend). Verified by inspecting
//     the built module with `WebAssembly.Module.imports()`: sinf/floorf
//     etc. come through as env.* imports exactly as emu_abi.h documents,
//     with no other flag needed.
//   - `-Wl,--export-dynamic` was tried first for "export every emu_*
//     symbol" (matching this task's original invocation) but is flaky on
//     this zig build for wasm32-freestanding: it intermittently segfaults
//     the linker and, even when it does not crash, does not reliably export
//     C functions with default visibility. Dropped in favour of one
//     `-Wl,--export=<name>` per emu_* symbol below, which is deterministic
//     and was verified the same way (Module.exports()).
//   - zig's freestanding wasm32 target ships NO <stdlib.h>, <math.h> or
//     <stdio.h> at all (a real "file not found", not a link error) - it
//     takes the C standard's freestanding/hosted split literally, unlike a
//     hosted target that would bundle a minimal libc for these. gfx.c and
//     several apps `#include` all three as real, unmodified firmware code,
//     so shim/ carries stand-ins for those three IN ADDITION TO the
//     DEV_Config.h/AMOLED_1in8.h vendor-header shims this task named up
//     front. See each shim header's own comment for exactly what it
//     provides and why.
//
// None of the above changes what the JS host has to implement: js_log plus
// the eight math functions, exactly emu_abi.h's documented list. Everything
// this file works around (malloc, printf, the three extra math functions)
// is compiled INTO the module by emu_shim.c or shim/math.h, never imported.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { runZigCc, ZIG_EXE } from "../../../tools/zigSpawn";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WASM_DIR = import.meta.dir; // packs/rp2350-touch-amoled-18/wasm
const DEVICE_ROOT = resolve(WASM_DIR, ".."); // packs/rp2350-touch-amoled-18/
const REPO_ROOT = resolve(DEVICE_ROOT, "..", ".."); // the puck repo root
const FIRMWARE = join(DEVICE_ROOT, "firmware");

// The emulator half of this repo loads exactly one module, wasm/dist/emu.wasm
// (see the root README and server.ts). Writing there rather than into a
// device-local dist/ is what makes `bun run pack:build && bun run dev` show
// this firmware instead of example/, with no wiring step in between.
const DIST = join(REPO_ROOT, "wasm", "dist");
const OUT = join(DIST, "emu.wasm");

// The linker writes HERE, and the result is renamed onto OUT only once it has
// succeeded. Two reasons, and the second one cost an afternoon twice on the
// device project this pack was extracted from.
//
// A failed or crashed link leaves a truncated file behind, which the next test
// run happily loads as if it were a module.
//
// And more importantly, a tree like this is worked on by more than one agent
// at a time, so a second `zig cc` writing dist/emu.wasm while a test is
// reading it is entirely normal. A torn read still COMPILES (the wasm prefix
// is valid) and then fails at the first call after an app switch with
// "RuntimeError: call_indirect to a signature that does not match", which
// reads exactly like a firmware bug in whatever app you happen to be working
// on and is nothing of the sort. A rename is atomic, so a reader sees either
// the whole old module or the whole new one, never half of one. The pid keeps
// two concurrent builders off each other's temp file.
const OUT_TMP = `${OUT}.tmp-${process.pid}`;

// The ABI header is the emulator's, at the repo root: one copy, so the
// firmware cannot compile against a stale private fork of the contract.
const ABI_DIR = join(REPO_ROOT, "wasm");

// Every symbol emu_abi.h declares. Exported explicitly (see the header
// comment above on why --export-dynamic was dropped) rather than derived by
// parsing emu_abi.h, so a symbol added there and forgotten here fails loudly
// (an undefined-export link error) instead of silently missing from the
// module the JS side expects.
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
  "emu_sensor_vector",
  "emu_tilt",
  "emu_app_current",
  "emu_app_switch",
  "emu_menu_app_count",
  "emu_menu_app_index",
  "emu_arena_used",
  "emu_arena_capacity",
  "emu_tune_get",
  "emu_tune_set",
  "emu_tune_reset",
  "emu_sound_sample_rate",
  "emu_sound_play_seq",
  "emu_sound_stop_seq",
  "emu_sound_buffer",
  "emu_sound_frames",
];

// --app <path> [--landscape] [--shake]: additive, for the first DEGRADED
// cross-device port on this pack (apps/fluidbox/ports/rp2350-touch-amoled-18/
// fluid.c - see that port's README.md). Default behaviour (no --app) is
// UNCHANGED below: same SOURCES, same INCLUDES, same full firmware with its
// menu. This is not the esp32-s3 sibling's --app convention (a single
// g_demoApp slot, swapped by defining a symbol of that same name): on this
// pack the app layer is declared by firmware/apps/app_roster.inc, which
// runtime_core.c (a pack firmware source, never edited by a port - see
// AGENTS.md and docs/convention/device-pack.md) includes. So a single-app
// build GENERATES that one file into an OS temp directory and puts the
// directory FIRST on the include path, and nothing else about the build
// changes: no new translation unit, no link-order question, and
// runtime_core.c is not touched.
//
// This used to be much worse, and the difference is the point of the
// roster's own extraction: runtime_core.c hardcoded three named app slots
// plus a menu app, all four referenced by exact symbol name, so a
// single-app build had to alias EVERY slot onto the same app and ship a
// firmware whose menu gesture opened the app it was already running. The
// generated roster now says what it means - one app, one menu slot, one
// entry - and the menu gesture opens that app because there is genuinely no
// menu compiled in, not because four symbols were pointed at one object.
//
// The --app FILE's contract (this pack's own, not emu_abi.h's or app.h's):
// two plain functions, `void port_enter(void)` and
// `void port_tick(const app_frame_t *f)` - no app_t of its own, since the
// generated roster below is what builds the app_t object this build links.
// `--landscape` and `--shake` set the generated app_t's
// `landscape`/`wantsShake` fields (both default false); nothing else in
// app_t varies per port on this pack today, so a CLI flag is simpler than
// inventing a second file format the port's own .c would have to satisfy.
function parseArgs(argv: string[]): { appPath: string | null; landscape: boolean; shake: boolean } {
  const appIndex = argv.indexOf("--app");
  let appPath: string | null = null;
  if (appIndex !== -1) {
    const value = argv[appIndex + 1];
    if (!value) {
      console.error("--app needs a path argument (a single .c file defining port_enter()/port_tick(), see this file's header comment)");
      process.exit(1);
    }
    appPath = resolve(process.cwd(), value);
  }
  return {
    appPath,
    landscape: argv.includes("--landscape"),
    shake: argv.includes("--shake"),
  };
}

const { appPath: APP_PATH, landscape: APP_LANDSCAPE, shake: APP_SHAKE } = parseArgs(process.argv.slice(2));

// Written only when --app is given; cleaned up in the `finally` at the
// bottom of this file regardless of build outcome, since it is a build
// artifact, not a source this repository tracks.
let generatedRosterDir: string | null = null;

// Writes the generated app_roster.inc and returns the directory holding it,
// which the caller puts FIRST on the include path so runtime_core.c's
// `#include "app_roster.inc"` resolves to this one rather than to
// firmware/apps/'s hand-written reference roster.
//
// The tunables stubs and the port's own app_t sit in here too rather than in
// a second generated file, because everything below is the same thing: what
// the app LAYER supplies to a build that has no apps/ directory compiled
// into it.
function generateRoster(appName: string, landscape: boolean, shake: boolean): string {
  generatedRosterDir = mkdtempSync(join(tmpdir(), "puck-port-roster-"));
  const rosterPath = join(generatedRosterDir, "app_roster.inc");
  const source = `// GENERATED by packs/rp2350-touch-amoled-18/wasm/build.ts's --app flag.
// Not a pack firmware source (docs/convention/device-pack.md): written to a
// temp file for this one build and deleted afterwards. Included by
// firmware/runtime/runtime_core.c, which is never edited - see build.ts's
// header comment on --app, and firmware/apps/app_roster.inc for the
// hand-written reference roster this stands in for.
extern void port_enter(void);
extern void port_tick(const app_frame_t *f);

static const app_t g_portApp = { .name = "${appName}", .enter = port_enter, .tick = port_tick, .leave = NULL, .landscape = ${landscape ? "true" : "false"}, .wantsShake = ${shake ? "true" : "false"} };

const app_t *const g_apps[] = { &g_portApp };
const int g_appCount = 1;

// One entry, so the picker would draw exactly the app already running. It is
// never drawn: g_menuApp below IS the port, so the BOOT+PWR chord switches to
// the same app rather than to a menu. Nothing menu-shaped is compiled into a
// single-app build; the gesture is not disabled, there is simply nothing else
// to reach.
const int g_menuAppIndex[] = { 0 };
const int g_menuAppCount = 1;

const app_t g_menuApp = { .name = "${appName}", .enter = port_enter, .tick = port_tick, .leave = NULL, .landscape = ${landscape ? "true" : "false"}, .wantsShake = ${shake ? "true" : "false"} };

// Called only from inside runtime_core.c's BOOT+PWR chord branch that opens
// the menu. There is no distinct menu here, so there is nothing to remember
// returning from.
void menu_set_return_app(int index) { (void)index; }

// emu_shim.c's tunables surface (emu_device()'s "tunables" JSON,
// emu_tune_get/set/reset) calls these unconditionally. They are normally
// sketch.c's; sketch.c is not compiled into a single-app --app build, so
// this supplies the same "0 tunables, every call fails" contract
// sensors.h documents for a SKETCH_LIVE_TUNE=0 build.
int sketch_tune_count(void) { return 0; }
bool sketch_tune_describe(int index, const char **name, float *min, float *max, float *def) {
    (void)index; (void)name; (void)min; (void)max; (void)def;
    return false;
}
const char *sketch_tune_define_name(int index) { (void)index; return NULL; }
bool sketch_tune_get(const char *name, float *out) { (void)name; (void)out; return false; }
bool sketch_tune_set(const char *name, float value, float *outApplied) {
    (void)name; (void)value; (void)outApplied;
    return false;
}
`;
  writeFileSync(rosterPath, source, "utf8");
  return generatedRosterDir;
}

// The generated roster's directory, or null for a normal build. Computed
// before SOURCES because the include path below has to lead with it.
const ROSTER_DIR = APP_PATH
  ? generateRoster(APP_PATH.replace(/\.c$/, "").split(/[\\/]/).pop() ?? "port", APP_LANDSCAPE, APP_SHAKE)
  : null;

// The runtime half, identical either way. tilt.c is in here for the same
// reason sound_synth.c is: the emulator must run the board's OWN orientation
// filter, axis mapping and hysteresis, not a browser-side second copy of them
// that agrees on the day it is written and drifts after. storage.c is NOT:
// it is flash, and emu_shim.c supplies an in-RAM stand-in for storage.h.
const RUNTIME_SOURCES = [
  join(WASM_DIR, "emu_shim.c"),
  join(FIRMWARE, "runtime", "runtime_core.c"),
  join(FIRMWARE, "runtime", "gfx.c"),
  join(FIRMWARE, "runtime", "tilt.c"),
  join(FIRMWARE, "runtime", "sound_synth.c"),
  // The live-tune registry (firmware/runtime/tune_registry.h): one flat
  // name/index space over whatever apps firmware/apps/app_tunables.inc
  // lists. Portable like runtime_core.c and gfx.c above, so it belongs
  // here the same way they do - and it MUST be here, because omitting it
  // does not fail the link: -Wl,--import-symbols turns tune_registry_*
  // into wasm imports the host never provides, silently.
  join(FIRMWARE, "runtime", "tune_registry.c"),
];

const SOURCES = APP_PATH
  ? [...RUNTIME_SOURCES, APP_PATH]
  : [
      ...RUNTIME_SOURCES,
      join(FIRMWARE, "apps", "digits.c"),
      join(FIRMWARE, "apps", "chrono.c"),
      join(FIRMWARE, "apps", "sketch.c"),
      join(FIRMWARE, "apps", "menu.c"),
      join(FIRMWARE, "apps", "timer.c"),
      join(FIRMWARE, "apps", "shapes.c"),
    ];

// shim/ goes FIRST: it is what makes the real firmware sources compile
// unmodified (DEV_Config.h and AMOLED_1in8.h stand in for the vendor
// headers; stdlib.h/math.h/stdio.h stand in for libc headers this target
// does not ship - see this file's header comment). runtime/ and apps/ give
// the bare-filename #includes those directories' own files already use on
// the board (app.h, gfx.h, sensors.h, runtime_core.h, digits.h, menu.h).
// dirname(APP_PATH) is added too (only relevant for --app) so a ported app
// living outside firmware/apps/ can #include a private helper header of its
// own, the same allowance the esp32-s3 sibling's build.ts gives its --app.
//
// ROSTER_DIR goes ahead of all of them when --app is given: it holds the
// generated app_roster.inc, and it must win over firmware/apps/'s
// hand-written one, which is the whole mechanism by which a single-app build
// replaces the app layer without editing a pack source.
const INCLUDES = [
  ...(ROSTER_DIR ? [ROSTER_DIR] : []),
  join(WASM_DIR, "shim"),
  join(FIRMWARE, "runtime"),
  join(FIRMWARE, "apps"),
  ABI_DIR,  // emu_abi.h, included bare from emu_shim.c: the emulator's own
            // copy at the repo root, never a second one in here.
  ...(APP_PATH ? [resolve(APP_PATH, "..")] : []),
];

// The generated roster (if any) is a temp file, not a source this repo
// tracks - removed on every exit path below, success or failure, so a
// --app build never leaves it behind.
function cleanupRoster(): void {
  if (generatedRosterDir) rmSync(generatedRosterDir, { recursive: true, force: true });
}

if (ZIG_EXE.includes("/") || ZIG_EXE.includes("\\")) {
  // An explicit path was given (ZIG_EXE): check it, so a typo fails here
  // rather than as an opaque spawn error. A bare "zig" is resolved by PATH
  // and cannot be checked this way.
  if (!existsSync(ZIG_EXE)) {
    console.error(`zig not found at ${ZIG_EXE} (set ZIG_EXE to override)`);
    cleanupRoster();
    process.exit(1);
  }
}
for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.error(`source not found: ${src}`);
    cleanupRoster();
    process.exit(1);
  }
}

mkdirSync(DIST, { recursive: true });

const args = [
  "cc",
  "-target", "wasm32-freestanding",
  "-O2",
  // The --app roster lives in a unique temp directory so concurrent builds
  // cannot collide, but zig records that source path in wasm debug metadata.
  // Map only that random prefix to a stable virtual path so byte-identical
  // source emits byte-identical wasm across consecutive site builds.
  ...(generatedRosterDir ? [`-ffile-prefix-map=${generatedRosterDir}=puck-port-roster`] : []),
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--import-symbols", // undefined externs (js_log, the math imports)
                           // become real wasm imports instead of a hard
                           // link error - see this file's header comment.
  // Sketchpad live tuning (firmware/apps/sketch.c's SKETCH_LIVE_TUNE),
  // always ON for the emulator build, unlike the board's default build
  // (off unless -DSKETCH_LIVE_TUNE=1 is passed to cmake, see
  // firmware/CMakeLists.txt): the emulator IS a development tool, so there
  // is no shipped-firmware state to protect here, and the tunables panel
  // (emu_abi.h's "tunables" section) has nothing to build controls from
  // without this.
  "-DSKETCH_LIVE_TUNE=1",
  // Extra flags from the environment, whitespace separated. This exists for
  // firmware that carries a compile-time LAYOUT VARIANT somebody is meant to
  // judge rather than a knob to be tuned, so that rendering the alternative is
  //
  //   EMU_EXTRA_DEFINES=-DSOME_LAYOUT=0 bun run pack:build
  //
  // rather than editing a #define, building, capturing, and remembering to put
  // it back. It is deliberately NOT the tunables mechanism (emu_abi.h): that
  // one is for values a running module can change, and a layout that decides
  // the size of every rectangle on screen is not one of those.
  ...(process.env.EMU_EXTRA_DEFINES ?? "").split(/\s+/).filter(Boolean),
  ...EMU_EXPORTS.map((name) => `-Wl,--export=${name}`),
  ...INCLUDES.flatMap((dir) => ["-I", dir]),
  ...SOURCES,
  "-o", OUT_TMP,
];

console.log(`${ZIG_EXE} ${args.join(" ")}`);

// zig cc crashes inside its own linker roughly one run in three with this
// many -Wl,--export= flags: exit code 5, no diagnostic, and the very next
// attempt with identical arguments succeeds. It is a compiler bug, not
// anything wrong with the tree.
//
// Retried here rather than merely documented, because the person most likely
// to hit it is somebody running this for the first time, on their first
// command, before they have any reason to believe the repository works. A
// crash with no message is where they stop. Anyone debugging a real build
// failure still sees every attempt's output, and a genuine error reproduces
// on all of them.
// The pause matters as much as the retry. The failure rate is far worse when
// something else is compiling at the same time (measured here: five straight
// failures under a concurrent build, then a clean first attempt once it
// finished), so this is contention, not a coin flip, and hammering it
// immediately mostly reproduces the same collision.
//
// THE TIMEOUT IS NOT DECORATION: the same bug also HANGS, not just crashes
// (a zig process sitting at 0.02 seconds of CPU for thirteen minutes on
// arguments that then succeeded immediately on a manual retry - see
// packs/web/wasm/build.ts's compileModule for the original writeup). A
// retry loop that only catches a non-zero exit waits forever for that one,
// which is a far worse failure than a crash: a build that never returns
// looks like a build that is working. Two minutes is many times what a
// real compile of these files takes, even under a saturated machine.
//
// The retry/verdict mechanics themselves live in tools/zigSpawn.ts now
// (one shared implementation across every pack and every test build
// script - see that file's header comment for the measurement this loop
// used to guess at blind: piped stdio means a genuine compile error is
// captured and reported immediately instead of retried, and the artifact
// at OUT_TMP is checked directly rather than trusted to zig's own exit
// code).
const result = runZigCc(args, OUT_TMP, { isWasm: true });

if (!result.ok) {
  // Whatever half-written module the crashed linker left behind goes with it,
  // rather than sitting in dist/ as a *.tmp-1234 nobody will ever look at. The
  // previous emu.wasm is untouched and still valid, which is the other half of
  // what the temp file buys.
  rmSync(OUT_TMP, { force: true });
  console.error(
    result.stderr.trim().length > 0
      ? `zig cc failed (exit ${result.exitCode}), so this is a real build failure - see diagnostics above`
      : `zig cc exited ${result.exitCode} on all ${result.attempts} attempts with no diagnostic text and wrote nothing, so this is a real build failure`
  );
  cleanupRoster();
  process.exit(result.exitCode ?? 1);
}

renameSync(OUT_TMP, OUT); // atomic: see OUT_TMP's own comment
const size = statSync(OUT).size;
console.log(`built ${OUT} (${size} bytes)`);
cleanupRoster();
