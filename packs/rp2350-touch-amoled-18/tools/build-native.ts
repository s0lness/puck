// build-native.ts: builds this pack's REAL HARDWARE firmware - either the
// full multi-app image (menu, chrono, sketch, timer) or a single-app image
// that aliases every app-table slot onto one ported app. TypeScript, run
// with `bun` (AGENTS.md: everything here that is not firmware is .ts).
//
// This is the native equivalent of wasm/build.ts's --app flag, ported to
// the CMake/Ninja/arm-none-eabi side rather than zig/wasm32-freestanding.
// The idea is identical (see wasm/build.ts's own --app header comment): the
// app layer is declared by firmware/apps/app_roster.inc, which
// runtime_core.c includes and which a port may not edit, so a single-app
// build GENERATES one into this build's own out-of-tree directory and puts
// that directory first on the include path. No extra translation unit, no
// link-order question, and runtime_core.c untouched.
//
// The generated roster carries a few stub symbols the native link needs that
// the wasm one does not: see generateRoster()'s comment below for exactly
// which, and why.
//
// Usage:
//   bun run packs/rp2350-touch-amoled-18/tools/build-native.ts --out <uf2 path>
//   bun run packs/rp2350-touch-amoled-18/tools/build-native.ts \
//     --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake --out <uf2 path>
//
// Toolchain env (packs/rp2350-touch-amoled-18/AGENTS.md's "Building it" and
// tiny-computers' devices/rp2350-amoled-1.8/AGENTS.md's "Running it" -
// the latter carries the Windows-ARM64-specific paths this pack's own copy
// documents only as env-var names, not values): nothing is on PATH by
// default, and this machine is Windows-on-ARM64 with no host C compiler, so
// pico-sdk cannot build its own pioasm/picotool - the prebuilt x64 ones from
// raspberrypi/pico-sdk-tools are used instead (they run fine under
// emulation), pointed at explicitly via -Dpicotool_DIR/-Dpioasm_DIR. cmake
// and ninja are borrowed from the ESP-IDF install under ~/.espressif/tools,
// same as tiny-computers' own build.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TOOLS_DIR = import.meta.dir; // packs/rp2350-touch-amoled-18/tools
const DEVICE_ROOT = resolve(TOOLS_DIR, ".."); // packs/rp2350-touch-amoled-18/
const REPO_ROOT = resolve(DEVICE_ROOT, "..", ".."); // the puck repo root
const FIRMWARE = join(DEVICE_ROOT, "firmware");

const HOME = homedir();
const PICO_SDK_PATH = process.env.PICO_SDK_PATH ?? join(HOME, "pico", "pico-sdk");
const PICO_TOOLCHAIN_PATH =
  process.env.PICO_TOOLCHAIN_PATH ?? "C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\14.2 rel1";
const CMAKE_BIN_DIR = process.env.CMAKE_BIN_DIR ?? join(HOME, ".espressif", "tools", "cmake", "3.30.2", "bin");
const NINJA_BIN_DIR = process.env.NINJA_BIN_DIR ?? join(HOME, ".espressif", "tools", "ninja", "1.12.1");
const PICOTOOL_DIR = join(HOME, "pico", "tools", "picotool-dist", "picotool");
const PIOASM_DIR = join(HOME, "pico", "tools", "sdk-tools", "pioasm");

for (const [label, path] of [
  ["PICO_SDK_PATH", PICO_SDK_PATH],
  ["PICO_TOOLCHAIN_PATH", PICO_TOOLCHAIN_PATH],
  ["cmake dir", CMAKE_BIN_DIR],
  ["ninja dir", NINJA_BIN_DIR],
  ["picotool_DIR", PICOTOOL_DIR],
  ["pioasm_DIR", PIOASM_DIR],
] as const) {
  if (!existsSync(path)) {
    console.error(`toolchain path missing (${label}): ${path}`);
    console.error("See packs/rp2350-touch-amoled-18/AGENTS.md's \"Building it\" and " +
      "tiny-computers' devices/rp2350-amoled-1.8/AGENTS.md's \"Running it\" for where this " +
      "should come from - not invented here.");
    process.exit(1);
  }
}

function parseArgs(argv: string[]): {
  appPath: string | null;
  landscape: boolean;
  shake: boolean;
  out: string;
} {
  const appIndex = argv.indexOf("--app");
  let appPath: string | null = null;
  if (appIndex !== -1) {
    const value = argv[appIndex + 1];
    if (!value) {
      console.error("--app needs a path argument (a single .c file defining port_enter()/port_tick())");
      process.exit(1);
    }
    appPath = resolve(process.cwd(), value);
  }
  const outIndex = argv.indexOf("--out");
  const out = outIndex !== -1 ? argv[outIndex + 1] : null;
  if (!out) {
    console.error("--out needs a path argument (where the built .uf2 is copied)");
    process.exit(1);
  }
  return {
    appPath,
    landscape: argv.includes("--landscape"),
    shake: argv.includes("--shake"),
    out: resolve(process.cwd(), out),
  };
}

const { appPath: APP_PATH, landscape: APP_LANDSCAPE, shake: APP_SHAKE, out: OUT_PATH } = parseArgs(
  process.argv.slice(2)
);

if (APP_PATH && !existsSync(APP_PATH)) {
  console.error(`--app source not found: ${APP_PATH}`);
  process.exit(1);
}

// One out-of-tree build dir per invocation shape, same reasoning as
// packs/rp2350-touch-amoled-18/AGENTS.md's own firmware/build/: never
// committed (.gitignore), regenerable from this script and the tree. The
// full build reuses firmware/build/ (the path AGENTS.md itself documents,
// so `cmake --build packs/rp2350-touch-amoled-18/firmware/build` still
// works by hand); a single-app build gets its own firmware/build-app/<name>/
// so it never collides with the full build's cache or clobbers it.
const appName = APP_PATH ? (APP_PATH.replace(/\.c$/, "").split(/[\\/]/).pop() ?? "port") : null;
const BUILD_DIR = APP_PATH ? join(FIRMWARE, "build-app", appName!) : join(FIRMWARE, "build");

// Written only for a single-app build; not a pack firmware source
// (docs/convention/device-pack.md) - lives inside this build's own
// out-of-tree directory, never in firmware/, and is never committed
// (firmware/build-app/ is gitignored, same as firmware/build/).
//
// Four more stub symbols than wasm/build.ts's roster needs, because the
// native link pulls in runtime.c (the board's own entry point), which the
// wasm build never compiles at all (packs/rp2350-touch-amoled-18/AGENTS.md's
// "WebAssembly" section: runtime.c, sensors.c, bootbtn.c and devlink.c are
// board-only). runtime.c wires devlink's tune_* hooks unconditionally
// (its "devlink wiring" section), including `sketch_tune_define_name` -
// which the wasm side never references because nothing in runtime_core.c or
// emu_shim.c calls it. `sketch_debug_touch_diag` is the other sketch.c
// symbol runtime.c mentions, but only inside `#if TOUCH_POLL_SELFTEST`
// (off by default, and not turned on by this script), so it does not need a
// stub here; if a future single-app build ever passes
// -DTOUCH_POLL_SELFTEST=1, that call site will need one too.
// Returns the DIRECTORY holding the generated app_roster.inc, not the file:
// runtime_core.c includes that name, so what cmake needs is an include path
// that wins over firmware/apps/ (see firmware/CMakeLists.txt's
// PUCK_SINGLE_APP_ROSTER branch), not another source to compile.
function generateRoster(name: string, landscape: boolean, shake: boolean, buildDir: string): string {
  const rosterDir = join(buildDir, "generated-roster");
  mkdirSync(rosterDir, { recursive: true });
  const rosterPath = join(rosterDir, "app_roster.inc");
  const initList = `{ .name = "${name}", .enter = port_enter, .tick = port_tick, .leave = NULL, .landscape = ${landscape ? "true" : "false"}, .wantsShake = ${shake ? "true" : "false"} }`;
  const source = `// GENERATED by packs/rp2350-touch-amoled-18/tools/build-native.ts's --app flag.
// Not a pack firmware source (docs/convention/device-pack.md): written into
// this build's own out-of-tree directory and never committed. Included by
// firmware/runtime/runtime_core.c, which is never edited - see
// build-native.ts's header comment, firmware/apps/app_roster.inc for the
// hand-written reference roster this stands in for, and this file's own extra
// stubs for what the native link needs that the wasm one does not.
extern void port_enter(void);
extern void port_tick(const app_frame_t *f);

static const app_t g_portApp = ${initList};

const app_t *const g_apps[] = { &g_portApp };
const int g_appCount = 1;

// One entry, never drawn: g_menuApp below IS the port, so the BOOT+PWR chord
// switches to the app already running. Nothing menu-shaped is compiled into a
// single-app build; the gesture is not disabled, there is simply nothing else
// to reach.
const int g_menuAppIndex[] = { 0 };
const int g_menuAppCount = 1;

const app_t g_menuApp = ${initList};

// Called only from inside runtime_core.c's BOOT+PWR chord branch that opens
// the menu. There is no distinct menu here, so there is nothing to remember
// returning from.
void menu_set_return_app(int index) { (void)index; }

// runtime.c's devlink wiring (the devlinkHooks_t initializer in its "devlink
// wiring" section) points these five straight at sketch.c's own tune_*
// functions unconditionally, regardless of SKETCH_LIVE_TUNE - sketch.c is
// not compiled into a single-app --app build, so this supplies the same "0
// tunables, every call fails" contract sensors.h documents for a
// SKETCH_LIVE_TUNE=0 build.
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
  return rosterDir;
}

mkdirSync(BUILD_DIR, { recursive: true });

let rosterDir: string | null = null;
if (APP_PATH) {
  rosterDir = generateRoster(appName!, APP_LANDSCAPE, APP_SHAKE, BUILD_DIR);
}

// The child processes below (cmake, then ninja via cmake --build) need this
// exact env: PICO_SDK_PATH/PICO_TOOLCHAIN_PATH as documented, and PATH
// carrying cmake, ninja and the toolchain's own bin/ ahead of whatever is
// already there. bun's own directory is kept on PATH too (rather than
// relying on it already being there) because firmware/CMakeLists.txt's
// post-build step does `find_program(BUN_EXECUTABLE bun)` and silently
// skips tools/invariants (with only a CMake warning, not a failure) if that
// lookup fails - this build wants that check to actually run.
const toolchainBin = join(PICO_TOOLCHAIN_PATH, "bin");
const bunDir = dirname(process.execPath);
const childEnv: Record<string, string> = {
  ...process.env,
  PICO_SDK_PATH,
  PICO_TOOLCHAIN_PATH,
  PATH: [CMAKE_BIN_DIR, NINJA_BIN_DIR, toolchainBin, bunDir, process.env.PATH ?? ""].join(";"),
};

function run(cmd: string[], label: string): void {
  console.log(`$ ${cmd.join(" ")}`);
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", env: childEnv, cwd: REPO_ROOT });
  if (!result.success) {
    console.error(`${label} failed (exit ${result.exitCode})`);
    process.exit(result.exitCode ?? 1);
  }
}

const configureArgs = [
  "cmake",
  "-S", FIRMWARE,
  "-B", BUILD_DIR,
  "-G", "Ninja",
  `-Dpicotool_DIR=${PICOTOOL_DIR}`,
  `-Dpioasm_DIR=${PIOASM_DIR}`,
];
if (APP_PATH && rosterDir) {
  configureArgs.push(`-DPUCK_SINGLE_APP_SOURCE=${APP_PATH}`);
  configureArgs.push(`-DPUCK_SINGLE_APP_ROSTER=${rosterDir}`);
}

run(configureArgs, "cmake configure");
run(["cmake", "--build", BUILD_DIR], "cmake build");

const builtUf2 = join(BUILD_DIR, "main.uf2");
if (!existsSync(builtUf2)) {
  console.error(`build reported success but ${builtUf2} does not exist`);
  console.error(`build dir contents: ${readdirSync(BUILD_DIR).join(", ")}`);
  process.exit(1);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
await Bun.write(OUT_PATH, Bun.file(builtUf2));
console.log(`built ${OUT_PATH} (${(await Bun.file(OUT_PATH).arrayBuffer()).byteLength} bytes)`);
