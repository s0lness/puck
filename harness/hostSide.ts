// hostSide.ts: the third harness side (docs/harness.md's "three marks").
// Builds an app's real C, the SAME sources a pack's wasm/build.ts compiles
// (via that pack's sibling wasm/host.ts, or any equivalent {sources,
// includes, defines} spec - see HostSourceSpec below), as a native
// executable with sanitizers on, then replays a trace through it exactly
// like harness/emulatorSide.ts replays one through wasm: same event order,
// same capture-point semantics. The wasm side catches behavioural
// divergence between an emulator build and real hardware; this side
// catches the COMPILER CLASS of defect wasm hides entirely - an
// out-of-bounds write, a signed overflow, an unaligned access - because
// wasm32 is memory-safe by construction and a bug that corrupts memory on
// real hardware can compile to wasm and run clean forever.
//
// TWO DISTINCT FAILURE SHAPES, never confused with each other or with a
// frame divergence:
//
//   BUILD_FAILED   the native compile or link itself did not produce an
//                  executable (buildHostExe() returns { ok: false }). This
//                  is an infrastructure failure, not a verdict about the
//                  firmware - harness/hostdiff.ts reports it as its own
//                  outcome, never as a frame mismatch.
//
//   "sanitizer"    the executable ran and exited non-zero with sanitizer
//                  report text on stderr (buildHostExe() succeeded,
//                  replayHost()'s own result carries verdict:"sanitizer").
//                  `-fno-sanitize-recover=undefined` (see buildHostExe)
//                  makes UBSan abort on the FIRST violation rather than
//                  keep going and risk a second, unrelated report
//                  overwriting the first - so this is always exactly one
//                  finding, named by file:line in the report text.
//
// Neither is a PortdiffInfraError-shaped thing the caller can paper over:
// both mean "no frame comparison happened", and harness/hostdiff.ts must
// print them plainly rather than let a diff loop silently skip a point.
//
// THE POINTER-WIDTH PROBLEM, stated once here because it shapes this
// file's whole build strategy: emu_fb()/emu_device() are declared `int` by
// wasm/emu_abi.h (correct for a wasm32 module's flat address space, unsafe
// on a native 64-bit host - see harness/host/driver.c's header comment for
// the full argument and the two EMU_HOST_NATIVE accessors every
// host-buildable pack's emu_shim.c now carries because of it).
//
// WHY THIS FILE COMPILES ONE OBJECT PER SOURCE FILE INSTEAD OF ONE
// MONOLITHIC "zig cc *.c -o exe" THE WAY EVERY PACK'S OWN wasm/build.ts
// DOES: found by actually building, not assumed. A pack's own firmware
// sources need that pack's shim/ directory on their include path (e.g.
// packs/rp2350-touch-amoled-18/wasm/shim/stdio.h stands in for a header
// zig's wasm32-freestanding target does not ship). harness/host/driver.c
// is NOT firmware - it is this repository's own harness tooling, and it
// wants the HOST's real <stdio.h>/<stdlib.h> (fwrite, fprintf, fgets,
// strtol...), which a pack's shim headers do not declare (they only
// declare the one or two symbols firmware code actually calls, e.g.
// `int printf(const char *fmt, ...);` and nothing else). Put driver.c on
// the same include path as the firmware and the pack's shim/stdio.h wins
// the header search and hides the real one, and every stdio call in
// driver.c fails to compile - reproduced here while writing this file, not
// hypothesised. So each source is compiled to its own .o with ITS OWN
// include list (driver.c: only wasm/emu_abi.h's directory; a pack's own
// sources: that pack's own `includes`), and only the link step combines
// them.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CapturedFrame } from "../src/frame";
import type { TraceEvent } from "./types";
import { runZigCc } from "../tools/zigSpawn";

const HARNESS_DIR = import.meta.dir; // harness/
const REPO_ROOT = resolve(HARNESS_DIR, ".."); // repo root
const ABI_DIR = join(REPO_ROOT, "wasm"); // wasm/emu_abi.h
const DRIVER_C = join(HARNESS_DIR, "host", "driver.c");

export interface HostSourceSpec {
  // Every pack source to build, INCLUDING that pack's own emu_shim.c (the
  // same list a pack's wasm/build.ts compiles - see e.g.
  // packs/rp2350-touch-amoled-18/wasm/host.ts's hostBuildFiles()).
  // harness/host/driver.c is added automatically; do not include it here.
  sources: string[];
  includes: string[];
  defines: string[]; // must include "-DEMU_HOST_NATIVE=1" for a pack whose
                      // emu_shim.c gates its native pointer accessors on
                      // that macro (every pack this repo ships does).
}

export interface HostBuildOk {
  ok: true;
  exePath: string;
  // Which sanitizer group actually linked - see buildHostExe's own
  // fallback: "undefined,address" tried first, "undefined" alone if that
  // failed to link (documented case: ASan may not be available for a
  // given native target/toolchain combination - see this repo's own
  // AGENTS.md environment note). Never empty: a host build with no
  // sanitizer at all defeats this whole harness side's purpose, so
  // buildHostExe() never returns ok:true without at least UBSan.
  sanitizers: string[];
}
export interface HostBuildFail {
  ok: false;
  error: string;
}
export type HostBuildResult = HostBuildOk | HostBuildFail;

// zig's own silent-flake retry, and "the artifact on disk is the verdict,
// not the exit code", now live in ONE place (tools/zigSpawn.ts) rather
// than a private copy in this file - see that file's header comment for
// the measurement behind both. Object files here are native, not wasm, so
// `isWasm` is left at its default false: no magic-byte check, just
// non-empty.

// -ffp-contract=off: THE HOST BUILD'S FLOATING-POINT SEMANTICS ARE MADE TO
// MATCH WASM'S, because otherwise this mark reports a compiler's licence as
// a firmware divergence. clang defaults to `-ffp-contract=on`, which lets it
// fuse `a * b + c` into a single fused multiply-add - ONE rounding instead
// of two, a different (more accurate, still C-legal) result. wasm32 has no
// FMA instruction at all, so the wasm build always rounds twice; every
// multiply-accumulate in a float-heavy app therefore lands on a slightly
// different number on the two sides. Measured here, not assumed
// (apps/fluidbox x rp2350-touch-amoled-18, its own 566-event trace, capture
// points added at a ladder of times): with contraction ON the two builds
// agree exactly through t=512ms, part company at t=1024ms by 84 of 164,864
// pixels, and are 4.67%/5.06%/4.94% apart by the bundle's own three points -
// a chaotic SPH solver amplifying a last-bit difference, exactly the way a
// chaotic system does. With `-ffp-contract=off` the SAME two builds are
// byte-identical at every one of those eleven points. So the whole 4.7% was
// contraction, not undefined behaviour and not a bug in anybody's C.
//
// This belongs here, on every app and every pack, rather than in one app's
// bundle: it is a property of the two TARGETS, not of any firmware, and a
// host mark that only agrees with wasm on integer code would be a much
// weaker instrument. It does not weaken the mark's actual job - the
// sanitizers are untouched, and a real out-of-bounds write or signed
// overflow traps exactly as before (test/host/fixtures/ proves that on
// every run).
//
// Not -ffast-math, in either direction, and not by omission: -ffast-math
// would go the OTHER way (it turns contraction ON along with reassociation,
// finite-math assumptions and flush-to-zero), which is strictly further from
// wasm's own strict IEEE-754 semantics, not closer.
const FP_FLAGS = ["-ffp-contract=off"];

// Compiles one source to one object file with its own include list.
// Returns an error string on failure (a real compile error, or the flake
// exhausting every retry - either way already printed by runZigCc), null
// on success.
function compileOne(src: string, includes: string[], defines: string[], sanitizeFlags: string[], outObj: string): string | null {
  const args = ["cc", "-c", "-O1", "-g", ...FP_FLAGS, ...sanitizeFlags, ...defines, ...includes.flatMap((d) => ["-I", d]), src, "-o", outObj];
  // useAmbientCache: true - see tools/zigSpawn.ts's ZigCcOptions comment
  // (the sixth failure mode). This is the sanitized native compile that
  // needs compiler-rt built, measured to fail far more often against a
  // cold, never-used cache than against zig's own OS default, which is
  // warm from ordinary everyday use across every project on the machine.
  const result = runZigCc(args, outObj, { useAmbientCache: true });
  if (result.ok) return null;
  return result.stderr.trim().length > 0
    ? `zig cc failed compiling ${src} (see diagnostics above)`
    : `zig cc exited ${result.exitCode} compiling ${src} on all ${result.attempts} attempts with no diagnostic text (see AGENTS.md's toolchain notes)`;
}

function linkAll(objs: string[], sanitizeFlags: string[], outExe: string): string | null {
  const args = ["cc", ...sanitizeFlags, ...objs, "-o", outExe];
  // cwd: tmpdir(), not the default REPO_ROOT tools/zigSpawn.ts's runZigCc()
  // would otherwise use - every one of `objs` and `outExe` lives under the
  // OS temp directory (buildHostExe's own buildDir/exePath), never under
  // this repo, so the default base would leave every one of them absolute.
  // Every object file this link step combines (driver.o plus one per
  // source) is exactly the "many long absolute path arguments" shape
  // tools/zigSpawn.ts's header comment documents zig cc crashing on -
  // reproduced here too, not just in the wasm builds that flag list was
  // originally found in.
  // useAmbientCache: true - see compileOne's own comment above and
  // tools/zigSpawn.ts's ZigCcOptions comment (the sixth failure mode):
  // the link step needs the ubsan runtime, same reasoning.
  const result = runZigCc(args, outExe, { cwd: tmpdir(), useAmbientCache: true });
  if (result.ok) return null;
  return result.stderr.trim().length > 0
    ? `zig cc failed linking (see diagnostics above)`
    : `zig cc exited ${result.exitCode} linking on all ${result.attempts} attempts with no diagnostic text (see AGENTS.md's toolchain notes)`;
}

// -fno-sanitize-recover=undefined: UBSan aborts on the FIRST violation
// instead of logging and continuing, so a report always names exactly one
// finding (this task's own "distinct verdict... with the report text, not
// a frame diff" - a second, unrelated finding stomping the first would
// make that report text a coin flip). ASan already halts on first error by
// default (no ASAN_OPTIONS override here), so nothing extra is needed for
// it. -g so a report's file:line is real, not stripped.
const UBSAN_FLAGS = ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"];
const ASAN_UBSAN_FLAGS = ["-fsanitize=address,undefined", "-fno-sanitize-recover=undefined"];

// Builds harness/host/driver.c plus every source in `spec` into one native
// executable. Tries ASan+UBSan first; if that combination fails to LINK
// (not merely to compile - a compile failure there is compiled code, real
// or flaky, and retrying under UBSan-alone would silently hide a genuine
// bug in sanitizer-instrumented code), falls back to UBSan alone and
// reports that in `sanitizers`. See this file's header comment for why
// each source gets its own compile step with its own include list.
export async function buildHostExe(spec: HostSourceSpec, outExe?: string): Promise<HostBuildResult> {
  // Object files live in their own throwaway directory, always removed
  // below; the executable lives somewhere else entirely (the caller's own
  // outExe, or a second temp directory this function does NOT clean up,
  // since the caller still needs to run it after this function returns).
  const buildDir = mkdtempSync(join(tmpdir(), "puck-hostside-objs-"));
  const exePath = outExe ?? join(mkdtempSync(join(tmpdir(), "puck-hostside-exe-")), "host.exe");
  if (outExe) mkdirSync(resolve(outExe, ".."), { recursive: true });

  try {
    for (const sanitizeFlags of [ASAN_UBSAN_FLAGS, UBSAN_FLAGS]) {
      const objs: string[] = [];
      let compileError: string | null = null;

      // driver.c: only wasm/emu_abi.h's directory on its include path -
      // see this file's header comment for why NOT the pack's own
      // includes.
      const driverObj = join(buildDir, "0-driver.o");
      compileError = compileOne(DRIVER_C, [ABI_DIR], [], sanitizeFlags, driverObj);
      if (compileError) return { ok: false, error: compileError };
      objs.push(driverObj);

      for (let i = 0; i < spec.sources.length; i++) {
        const src = spec.sources[i]!;
        const obj = join(buildDir, `${i + 1}-${basename(src).replace(/\.c$/, "")}.o`);
        compileError = compileOne(src, spec.includes, spec.defines, sanitizeFlags, obj);
        if (compileError) return { ok: false, error: compileError };
        objs.push(obj);
      }

      const linkError = linkAll(objs, sanitizeFlags, exePath);
      if (!linkError) {
        return { ok: true, exePath, sanitizers: sanitizeFlags === ASAN_UBSAN_FLAGS ? ["address", "undefined"] : ["undefined"] };
      }
      if (sanitizeFlags === UBSAN_FLAGS) {
        // Both attempts exhausted: report the UBSan-alone link failure,
        // since that is the more minimal build a reader would expect to
        // work if anything does.
        return { ok: false, error: linkError };
      }
      // else: fall through and retry the whole build with UBSan alone.
    }
    /* unreachable */
    return { ok: false, error: "buildHostExe: unreachable" };
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

// ---- replaying a trace against the built executable ----------------------

export interface HostFrame {
  atMs: number;
  frame: CapturedFrame;
}

export type HostReplayResult =
  | { verdict: "ok"; frames: HostFrame[]; stderr: string }
  | { verdict: "sanitizer"; report: string; frames: HostFrame[] };

// Thrown for a failure that is neither a sanitizer report nor a frame
// result - a malformed protocol response, a frame count mismatch. Mirrors
// harness/portdiff.ts's PortdiffInfraError: never a verdict about the
// firmware, always a bug in this tool or its caller.
export class HostSideInfraError extends Error {}

function buildProtocol(events: TraceEvent[], capturePoints: number[]): string {
  const remaining = [...capturePoints].sort((a, b) => a - b);
  const lines: string[] = [];
  for (const ev of events) {
    switch (ev.k) {
      case "touch":
        lines.push(`TOUCH ${ev.down} ${ev.x} ${ev.y}`);
        break;
      case "button":
        lines.push(`BUTTON ${ev.i} ${ev.down}`);
        break;
      case "verdict":
        lines.push(`VERDICT ${ev.i} ${ev.long}`);
        break;
      case "sensor":
        lines.push(`SENSOR ${ev.i}`);
        break;
      case "vector":
        lines.push(`VECTOR ${ev.i} ${ev.x} ${ev.y} ${ev.z}`);
        break;
      case "accel":
        lines.push(`ACCEL ${ev.i} ${ev.t} ${ev.ax} ${ev.ay} ${ev.az}`);
        break;
      case "tick":
        lines.push(`TICK ${ev.t}`);
        while (remaining.length > 0 && remaining[0]! <= ev.t) lines.push(`CAPTURE ${remaining.shift()!}`);
        break;
    }
  }
  // Same "capture past the trace's end" allowance replayFromBytes gives
  // (src/replayCore.ts): whatever capture points are still outstanding get
  // captured against the final state rather than silently dropped.
  for (const p of remaining) lines.push(`CAPTURE ${p}`);
  lines.push("END");
  return lines.join("\n") + "\n";
}

// Parses harness/host/driver.c's own stdout framing: `FRAME <ms> <w>
// <h>\n` followed by exactly w*h*3 raw RGB bytes, repeated - see that
// file's header comment for the full protocol.
//
// SKIPS any text line that is not a FRAME header, rather than treating it
// as a parse error. Found necessary by actually running this against real
// pack firmware, not assumed: firmware may legitimately call printf()
// directly (apps/chrono.c does, for its own debug logging), and on this
// toolchain that call binds to the REAL host printf rather than a pack's
// own emu_shim.c printf (which would otherwise route it through
// rt_log()/js_log() to stderr, out of this stream entirely) - a real,
// observed linker behaviour on the native target this repository has no
// reason to fight or paper over with a build-time trick, since the whole
// point of this driver is running real, unmodified firmware C. A stray
// log line landing on stdout is not a protocol violation; only a line
// that fails to match ANY known shape after a header is genuinely
// unexpected, and this still cannot happen INSIDE a frame's own binary
// payload (fixed-length, consumed as a whole immediately once its header
// is found), so a raw pixel byte that happens to equal '\n' can never be
// misread as a text line.
function parseFrames(buf: Uint8Array): HostFrame[] {
  const frames: HostFrame[] = [];
  let pos = 0;
  const decoder = new TextDecoder();
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos); // '\n'
    if (nl === -1) break;
    const header = decoder.decode(buf.subarray(pos, nl)).trim();
    const m = /^FRAME (-?\d+) (\d+) (\d+)$/.exec(header);
    if (!m) {
      pos = nl + 1; // not a frame header: firmware log noise, skip this line
      continue;
    }
    const atMs = Number(m[1]);
    const w = Number(m[2]);
    const h = Number(m[3]);
    const dataStart = nl + 1;
    const dataLen = w * h * 3;
    const dataEnd = dataStart + dataLen;
    if (dataEnd > buf.length) {
      throw new HostSideInfraError(`harness/hostSide.ts: truncated frame data for FRAME ${atMs} ${w}x${h} (got ${buf.length - dataStart}/${dataLen} bytes)`);
    }
    frames.push({ atMs, frame: { width: w, height: h, rgb: buf.slice(dataStart, dataEnd) } });
    pos = dataEnd;
  }
  return frames;
}

// Spawns the built executable, feeds it the trace as harness/host/
// driver.c's own line protocol, and reads back its frames. Draining
// stdout/stderr BEFORE stdin is fully written (rather than after) is
// deliberate: driver.c writes each frame as soon as its CAPTURE command
// runs, not only at exit, so a large trace could otherwise fill the OS
// pipe buffer and deadlock against this process still writing stdin.
export async function replayHost(exePath: string, events: TraceEvent[], capturePoints: number[]): Promise<HostReplayResult> {
  const proc = Bun.spawn([exePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(proc.stdout).arrayBuffer();
  const stderrPromise = new Response(proc.stderr).arrayBuffer();

  const protocol = buildProtocol(events, capturePoints);
  proc.stdin.write(new TextEncoder().encode(protocol));
  await proc.stdin.end();

  const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  const stderrText = new TextDecoder().decode(stderrBuf);

  if (exitCode !== 0) {
    // Per this task's own spec: any non-zero exit with stderr text is the
    // SANITIZER verdict, not a crash this tool tries to explain away.
    // Frames captured before the trap (if any) are still returned: they
    // are real, valid comparisons up to the moment things went wrong.
    return { verdict: "sanitizer", report: stderrText.trim().length > 0 ? stderrText : `driver.c exited ${exitCode} with no stderr output`, frames: parseFrames(new Uint8Array(stdoutBuf)) };
  }

  const frames = parseFrames(new Uint8Array(stdoutBuf));
  if (frames.length !== capturePoints.length) {
    throw new HostSideInfraError(`harness/hostSide.ts: expected ${capturePoints.length} frame(s), driver.c produced ${frames.length}`);
  }
  return { verdict: "ok", frames, stderr: stderrText };
}

// Convenience for a caller (harness/hostdiff.ts, test/host/run.ts) that
// just wants "build, then run one trace" with no intermediate exe to
// manage - mirrors harness/emulatorSide.ts's replayEmulator() shape as
// closely as the two targets allow.
export interface HostRunResult {
  build: HostBuildResult;
  replay: HostReplayResult | null; // null when build.ok === false
}

export async function buildAndReplayHost(spec: HostSourceSpec, events: TraceEvent[], capturePoints: number[], outExe?: string): Promise<HostRunResult> {
  const build = await buildHostExe(spec, outExe);
  if (!build.ok) return { build, replay: null };
  const replay = await replayHost(build.exePath, events, capturePoints);
  return { build, replay };
}

// Exposed so a caller can sanity-check a spec before spending a build on
// it (harness/hostdiff.ts's own usage message, test/host/run.ts's fixture
// setup).
export function assertSourcesExist(spec: HostSourceSpec): void {
  for (const src of spec.sources) {
    if (!existsSync(src)) throw new Error(`harness/hostSide.ts: source not found: ${src}`);
  }
  if (!existsSync(DRIVER_C)) throw new Error(`harness/hostSide.ts: driver not found: ${DRIVER_C}`);
}

// For a caller that wants the built executable's size reported (parity
// with every pack's own wasm/build.ts, which always logs its output size).
export function exeSize(path: string): number {
  return statSync(path).size;
}
