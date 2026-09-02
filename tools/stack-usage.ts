#!/usr/bin/env bun
// tools/stack-usage.ts: bun run stack-usage <pack>
//
// Compiles a pack's real firmware sources with THAT PACK'S OWN real cross
// toolchain (never zig, which this repository otherwise uses only to
// target wasm32-freestanding and, per harness/hostSide.ts, the local
// host - neither is the chip this firmware actually ships on) with
// -fstack-usage, aggregates every .su file GCC emits (one per compiled
// source, one line per function: file:line:col, byte count, a
// static/dynamic/bounded qualifier), prints the 15 largest frames, and
// exits 1 if the single largest exceeds the pack's declared stack budget
// (device.json's "stack" field - added here for rp2350-touch-amoled-18,
// see that file's own comment for where the number comes from).
//
// WHAT THIS DOES NOT MEASURE, stated plainly rather than implied: GCC's
// -fstack-usage reports each FUNCTION's own local frame size, never a
// call-graph total. The real worst case at runtime is some CALL CHAIN's
// summed frames (main -> app_tick -> sketch_tick -> gfx_fill_rect, say),
// which this tool does not compute - doing that honestly needs the
// compiler's own call graph (-fcallgraph-info) or a linker map, not just
// the .su files, and is future work this file's own comment flags rather
// than fakes. "the largest single frame fits under the budget" is a real,
// useful signal (a function that alone blows the budget is definitely a
// bug) but is not proof no call chain overflows it.
//
// PORTABLE SOURCES ONLY, for rp2350-touch-amoled-18: this pack's firmware
// splits into PORTABLE sources (runtime_core.c, gfx.c, tilt.c,
// sound_synth.c, tune_registry.c, apps/*.c - the same set
// packs/rp2350-touch-amoled-18/wasm/build.ts already compiles unmodified
// to wasm, per that pack's own CMakeLists.txt comment: "do not add
// anything to it that depends on pico-sdk or hardware/*") and BOARD-ONLY
// sources (runtime.c, sensors.c, storage.c, sound.c, bootbtn.c, devlink.c),
// which `#include` real pico-sdk headers (pico/stdlib.h, hardware/*.h).
// The pico-sdk itself is fetched externally by firmware/pico_sdk_import.cmake
// and is not vendored in this repository, so this tool cannot compile the
// board-only half here - it compiles the portable half against the SAME
// vendor-header shim (packs/rp2350-touch-amoled-18/wasm/shim/) the wasm
// build already relies on for the identical reason (no pico-sdk, no real
// AMOLED_1in8.h/DEV_Config.h available). This is the SAME class of bound
// docs/decisions/0002-two-compilers-not-one.md already states for the wasm
// side: real code, a real cross compiler, not the full firmware image.
//
// esp32-s3-touch-amoled-18: skipped with a clear message when
// xtensa-esp32-elf-gcc is not on this machine (this task's own
// instruction) - that pack's toolchain was not found here at the time
// this tool was written.
//
// web: refused outright. It ships to a browser, not silicon; there is no
// stack budget to check.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function fail(msg: string): never {
  console.error(`stack-usage: ${msg}`);
  process.exit(1);
}
function skip(msg: string): never {
  console.log(`stack-usage: SKIPPED - ${msg}`);
  process.exit(0);
}

interface Registry {
  packs: { name: string; path?: string; url?: string }[];
}
function loadRegistry(): Registry {
  return JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8")) as Registry;
}

// ---- per-pack toolchain configuration -------------------------------------

interface StackBudget {
  core0Bytes: number;
  core1Bytes?: number;
  source: string;
}

interface PackPlan {
  compiler: string;
  archFlags: string[];
  sources: string[];
  includes: string[];
}

function findArmNoneEabiGcc(): string | null {
  const envPath = process.env.ARM_NONE_EABI_GCC;
  if (envPath) return existsSync(envPath) ? envPath : null;
  const defaultPath = "C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\14.2 rel1\\bin\\arm-none-eabi-gcc.exe";
  if (existsSync(defaultPath)) return defaultPath;
  const onPath = Bun.spawnSync(["arm-none-eabi-gcc", "--version"], { stdout: "pipe", stderr: "pipe" });
  return onPath.success ? "arm-none-eabi-gcc" : null;
}

function findXtensaEsp32Gcc(): string | null {
  const envPath = process.env.XTENSA_ESP32_GCC;
  if (envPath) return existsSync(envPath) ? envPath : null;
  const onPath = Bun.spawnSync(["xtensa-esp32-elf-gcc", "--version"], { stdout: "pipe", stderr: "pipe" });
  return onPath.success ? "xtensa-esp32-elf-gcc" : null;
}

function rp2350Plan(packDir: string): PackPlan {
  const firmware = join(REPO_ROOT, packDir, "firmware");
  const shim = join(REPO_ROOT, packDir, "wasm", "shim");
  const abi = join(REPO_ROOT, "wasm");
  const compiler = findArmNoneEabiGcc();
  if (!compiler) fail(`arm-none-eabi-gcc not found (set ARM_NONE_EABI_GCC, or install at the default path this repo's AGENTS.md documents)`);
  return {
    compiler,
    // Cortex-M33 (RP2350's own core, "pico2" board - see
    // firmware/CMakeLists.txt's `set(PICO_BOARD pico2 ...)`), hard-float
    // ABI with the M33's single-precision FPU. -Os: this is stack-
    // constrained embedded code, and the pack's own CMakeLists.txt states
    // no release optimization level explicitly to read instead (pico-sdk's
    // own default varies by build type) - -Os is the defensible middle
    // ground for a size/stack-constrained target, documented here rather
    // than silently assumed.
    archFlags: ["-mcpu=cortex-m33", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv5-sp-d16", "-Os"],
    sources: [
      join(firmware, "runtime", "runtime_core.c"),
      join(firmware, "runtime", "gfx.c"),
      join(firmware, "runtime", "tilt.c"),
      join(firmware, "runtime", "sound_synth.c"),
      join(firmware, "runtime", "tune_registry.c"),
      join(firmware, "apps", "digits.c"),
      join(firmware, "apps", "chrono.c"),
      join(firmware, "apps", "sketch.c"),
      join(firmware, "apps", "menu.c"),
      join(firmware, "apps", "timer.c"),
      join(firmware, "apps", "shapes.c"),
    ],
    includes: [shim, join(firmware, "runtime"), join(firmware, "apps"), abi],
  };
}

function esp32Plan(packDir: string): PackPlan {
  const firmware = join(REPO_ROOT, packDir, "firmware");
  const abi = join(REPO_ROOT, "wasm");
  const compiler = findXtensaEsp32Gcc();
  if (!compiler) skip(`xtensa-esp32-elf-gcc not found on this machine (set XTENSA_ESP32_GCC, or install the ESP32 toolchain) - nothing to measure here`);
  return {
    compiler,
    archFlags: ["-Os"],
    sources: [join(firmware, "runtime", "runtime_core.c"), join(firmware, "runtime", "gfx_band.c"), join(firmware, "apps", "demo.c")],
    includes: [join(firmware, "runtime"), join(firmware, "apps"), abi],
  };
}

function planFor(packName: string, packDir: string): PackPlan {
  if (packName === "rp2350-touch-amoled-18") return rp2350Plan(packDir);
  if (packName === "esp32-s3-touch-amoled-18") return esp32Plan(packDir);
  if (packName === "web") skip(`pack "web" ships to a browser, not silicon - no stack budget to check`);
  fail(`no stack-usage toolchain configured for pack "${packName}" (see this file's per-pack plan functions)`);
}

function stackBudgetFor(packDir: string): StackBudget {
  const deviceJsonPath = join(REPO_ROOT, packDir, "device.json");
  const device = JSON.parse(readFileSync(deviceJsonPath, "utf8")) as { stack?: StackBudget };
  if (!device.stack || typeof device.stack.core0Bytes !== "number") {
    fail(`${deviceJsonPath} has no "stack" field (core0Bytes, at least) - add one before running stack-usage (see this file's own header comment for the reasoning device.json's stack field should record)`);
  }
  return device.stack;
}

// ---- .su parsing -----------------------------------------------------------
// GCC's -fstack-usage emits one line per function into <obj-basename>.su,
// next to the .o: "<file>:<line>:<col>:<function>\t<bytes>\t<qualifier>",
// qualifier one of "static" (fixed-size frame, the common case),
// "dynamic" (a VLA or alloca - size unknown at compile time, reported as
// the bytes BEFORE the dynamic part) or "dynamic,bound" (dynamic but GCC
// could still bound it).
interface StackFrame {
  file: string;
  line: number;
  func: string;
  bytes: number;
  qualifier: string;
}

function parseSu(path: string): StackFrame[] {
  const text = readFileSync(path, "utf8");
  const frames: StackFrame[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // file:line:col:function \t bytes \t qualifier
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const head = line.slice(0, tab1);
    const bytes = Number(line.slice(tab1 + 1, tab2));
    const qualifier = line.slice(tab2 + 1).trim();
    const m = /^(.*):(\d+):(\d+):(.+)$/.exec(head);
    if (!m || !Number.isFinite(bytes)) continue;
    frames.push({ file: m[1]!, line: Number(m[2]), func: m[4]!, bytes, qualifier });
  }
  return frames;
}

async function main(): Promise<void> {
  const packName = process.argv[2];
  if (!packName) {
    console.error("usage: bun run stack-usage <pack>");
    process.exit(1);
  }

  const registry = loadRegistry();
  const packEntry = registry.packs.find((p) => p.name === packName);
  if (!packEntry) fail(`unknown pack "${packName}" (not in registry.json's "packs")`);
  if (!packEntry.path) fail(`pack "${packName}" is registered by url; stack-usage needs a local pack`);

  const plan = planFor(packName, packEntry.path);
  const budget = stackBudgetFor(packEntry.path);

  console.log(`stack-usage: ${packName}`);
  console.log(`compiler: ${plan.compiler}`);
  console.log(`flags: ${plan.archFlags.join(" ")}`);
  console.log(`budget: core0=${budget.core0Bytes}B${budget.core1Bytes !== undefined ? ` core1=${budget.core1Bytes}B` : ""} (${budget.source})`);

  const buildDir = mkdtempSync(join(tmpdir(), "puck-stack-usage-"));
  const allFrames: StackFrame[] = [];
  try {
    for (const src of plan.sources) {
      if (!existsSync(src)) fail(`source not found: ${src}`);
      const outObj = join(buildDir, `${basename(src).replace(/\.c$/, "")}.o`);
      const args = ["-c", "-fstack-usage", "-g", ...plan.archFlags, ...plan.includes.flatMap((d) => ["-I", d]), src, "-o", outObj];
      const result = Bun.spawnSync([plan.compiler, ...args], { stdout: "pipe", stderr: "pipe" });
      if (!result.success) {
        fail(`${plan.compiler} failed compiling ${src}:\n${result.stderr.toString().trim()}`);
      }
      const suPath = outObj.replace(/\.o$/, ".su");
      if (!existsSync(suPath)) fail(`${plan.compiler} did not emit ${suPath} (was -fstack-usage accepted by this compiler?)`);
      allFrames.push(...parseSu(suPath));
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }

  if (allFrames.length === 0) fail("no stack-usage frames collected (nothing compiled?)");

  allFrames.sort((a, b) => b.bytes - a.bytes);
  const top = allFrames.slice(0, 15);
  console.log(`\ntop ${top.length} frame(s) of ${allFrames.length} compiled:`);
  const widths = { func: Math.max(8, ...top.map((f) => f.func.length)), bytes: Math.max(5, ...top.map((f) => String(f.bytes).length)) };
  for (const f of top) {
    console.log(`  ${f.bytes.toString().padStart(widths.bytes)}B  ${f.func.padEnd(widths.func)}  ${basename(f.file)}:${f.line}  ${f.qualifier}`);
  }

  const worst = top[0]!;
  console.log(`\nlargest single frame: ${worst.bytes}B (${worst.func}, ${basename(worst.file)}:${worst.line})`);
  if (worst.bytes > budget.core0Bytes) {
    console.error(`FAIL: largest frame (${worst.bytes}B) exceeds the declared core0 stack budget (${budget.core0Bytes}B)`);
    process.exit(1);
  }
  console.log(`PASS: largest frame fits within the declared core0 stack budget (${budget.core0Bytes}B)`);
}

main();
