// tools/zigSpawn.ts: one shared implementation of "pipe the child's stdio,
// retry only a SILENT failure with backoff, trust the artifact on disk
// over a lying exit code" - the pattern harness/hostSide.ts's runZig()
// worked out while chasing this repo's "zig link segfaults roughly one
// run in three" folklore. That folklore is retired by the measurement
// behind this file (see the commit that introduced it, "zig cc's exit
// code is not the verdict: the artifact on disk is", and AGENTS.md):
//
//   `zig cc` on this project's Windows-on-ARM development machine
//   intermittently exits 5 with EMPTY stderr after writing a complete,
//   correct output file. And when a build script spawns it with `stdout:
//   "inherit"` while the PARENT's own stdout is itself a drained pipe
//   (piped through `bun run`, a test harness capturing output, a second
//   build script one level up...), the child can die at exit 5 having
//   written NOTHING AT ALL, on every attempt, while the exact same command
//   typed by hand succeeds immediately.
//
// Piping the child's own stdio sidesteps the second failure mode entirely
// (the child no longer depends on the parent's stdout at all, so it never
// gets starved by it) and checking the artifact on disk - rather than the
// exit code - is what tells the first failure mode apart from a real
// compiler crash: nothing written means the compiler genuinely failed;
// something written and valid means it did the work and only its own exit
// status is wrong.
//
// Every wasm/build.ts and every test build script used to carry its own
// copy of this loop, spawning zig with inherited stdio and therefore
// UNABLE to tell a real compile error apart from the flake (inherited
// stdio streams straight to the terminal; there is no text left to
// inspect once the child exits). Every one of them fell back to blindly
// retrying ANY non-zero exit up to N times, which wastes a whole build's
// worth of timeouts reporting a real error N times slower than it needed
// to, and - the actually dangerous half - had no way to notice a build
// that lied about failing while a correct module sat on disk the whole
// time.
//
// This file is that one implementation, callable from
// harness/hostSide.ts (native host builds, one object file per source),
// every pack's wasm/build.ts, every test/*/build.ts, and site/build.ts's
// own build-orchestration loop (which does not invoke zig directly, but
// exists only because a build one level down might hit exactly this).
import { readFileSync, rmSync, statSync } from "node:fs";

export interface SpawnRetryResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: string | null;
  attempts: number;
}

export interface SpawnRetryOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  // When given, a run that exits non-zero with EMPTY stderr is still
  // accepted if this returns true once the process has exited - the "the
  // artifact on disk is the verdict, not the exit code" escape hatch.
  // Omit it for a spawn with no single artifact to check: site/build.ts's
  // own orchestration loop spawns a CHILD BUILD SCRIPT whose own output
  // path is shared across several different builds in turn, so checking
  // that path here could mistake a PREVIOUS build's leftover file for
  // this attempt's success - see that call site for the full reasoning.
  artifactOk?: () => boolean;
  // Run before every attempt, including the first. runZigCc below always
  // supplies one that removes its own outPath: without it, a crashed
  // attempt N could leave attempt N+1's silent, wrote-nothing failure
  // looking like a success, by way of attempt N-1's (or an entirely
  // earlier run's) leftover file still sitting at that same path.
  beforeAttempt?: () => void;
}

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_START_MS = 400;
const RETRY_PAUSE_CAP_MS = 10_000;

// Runs `cmd`, retrying only a SILENT failure (no diagnostic text on
// stderr, and no artifact accepted via `artifactOk`) with exponential
// backoff up to `maxAttempts`. A failure that DID print diagnostics is a
// real error and is returned immediately, never retried - retrying it
// only delays reporting a bug that will not go away. Prints the child's
// own output on the way out, since piping means it no longer streams live
// the way an inherited child's did: diagnostics as soon as a real failure
// is found (so a caller does not need to re-print `result.stderr`
// itself), or the combined stdout+stderr once on a clean success if
// either was non-empty (a compiler is not always silent on a clean run).
export function spawnWithRetry(cmd: string[], opts: SpawnRetryOptions = {}): SpawnRetryResult {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let pause = RETRY_PAUSE_START_MS;

  for (let attempt = 1; ; attempt++) {
    opts.beforeAttempt?.();
    let r: ReturnType<typeof Bun.spawnSync>;
    try {
      // Bun.spawnSync THROWS (does not return a failed result) when the
      // executable itself can't be found (ENOENT) - a plain
      // `if (!r.success)` below never runs in that case, which is exactly
      // the newcomer path (no zig installed yet, ZIG_EXE unset). Every
      // caller of this loop used to carry its own copy of this catch; now
      // there is one.
      r = Bun.spawnSync(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        timeout,
      });
    } catch (err) {
      throw new Error(`could not run "${cmd[0]}": ${err instanceof Error ? err.message : String(err)} (not installed, or not on PATH? for zig, set ZIG_EXE to its path)`);
    }
    const stdout = r.stdout ? r.stdout.toString() : "";
    const stderr = r.stderr ? r.stderr.toString() : "";
    // THE ARTIFACT ON DISK IS THE VERDICT, NOT THE EXIT CODE: an attempt
    // that exited non-zero with nothing on stderr, but that left a real
    // artifact behind, is accepted rather than retried - see this file's
    // header comment for the measurement.
    const lied = !r.success && stderr.trim().length === 0 && (opts.artifactOk?.() ?? false);
    const ok = r.success || lied;

    if (ok) {
      const output = [stdout.trim(), stderr.trim()].filter((s) => s.length > 0).join("\n");
      if (output.length > 0) console.log(output);
      return { ok: true, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    if (stderr.trim().length > 0) {
      // A real diagnosed failure: printed once, here, and never retried.
      console.error(stderr.trim());
      return { ok: false, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    if (attempt >= maxAttempts) {
      return { ok: false, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    const how = r.signalCode ? `was killed (${r.signalCode}, most likely this attempt's own ${timeout}ms timeout)` : `exited ${r.exitCode}`;
    console.warn(`${cmd[0]} ${how} with no diagnostic text (attempt ${attempt}/${maxAttempts}), waiting ${pause}ms and retrying...`);
    Bun.sleepSync(pause);
    pause = Math.min(pause * 2, RETRY_PAUSE_CAP_MS);
  }
}

// ---- zig cc specifically --------------------------------------------------

// No machine-specific default: zig comes off PATH unless ZIG_EXE says
// otherwise (AGENTS.md's environment note).
export const ZIG_EXE = process.env.ZIG_EXE ?? "zig";

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"

function looksLikeWasm(path: string): boolean {
  try {
    const bytes = readFileSync(path);
    return bytes.length >= 4 && WASM_MAGIC.every((b, i) => bytes[i] === b);
  } catch {
    return false;
  }
}

// Non-empty, and - for a wasm module - starting with the wasm magic bytes,
// so a half-written module a crashed linker left behind (possible even
// under a temp-file-then-rename scheme, before the rename happens) is
// never mistaken for a real one.
function artifactWritten(outPath: string, isWasm: boolean): boolean {
  let size: number;
  try {
    size = statSync(outPath).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  return isWasm ? looksLikeWasm(outPath) : true;
}

export interface ZigCcOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  // Set for a `-target wasm32-freestanding` build, so a silent failure's
  // artifact check also requires the wasm magic bytes, not just a
  // non-empty file.
  isWasm?: boolean;
}

// Runs `zig cc ...args`, writing to `outPath`. See spawnWithRetry above
// for the full retry/verdict contract this wraps. `outPath` is removed
// before every attempt (including the first): a stale file left at that
// exact path, by this call's own previous attempt or an unrelated earlier
// run, must never be mistaken for THIS attempt's output.
export function runZigCc(args: string[], outPath: string, opts: ZigCcOptions = {}): SpawnRetryResult {
  return spawnWithRetry([ZIG_EXE, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    beforeAttempt: () => {
      try {
        rmSync(outPath, { force: true });
      } catch {
        // best-effort: a permission error here surfaces soon enough as a
        // real compile/link failure once zig itself tries to write there.
      }
    },
    artifactOk: () => artifactWritten(outPath, opts.isWasm ?? false),
  });
}
