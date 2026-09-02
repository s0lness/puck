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
//
// A THIRD failure mode, worse than either of the above two and found
// AFTER this file's first version shipped: `bun run <script-name>` (the
// package.json alias form every entry in this repo's package.json is) is
// not the same environment as running the underlying file directly. It
// prepends one nonexistent `node_modules/.bin` PER ANCESTOR DIRECTORY of
// the repo root to PATH (nine of them on this development machine,
// walking to the filesystem root) - see tools/env.ts's header comment for
// the full finding. Under that alias-polluted PATH, a tight loop
// compiling the same fixture wrote NOTHING AT ALL, 0/5 attempts, every
// one exiting 5 with empty stderr; the same loop under a sanitized PATH
// wrote a real artifact 3/5 times (the remaining 2/5 being the ordinary,
// separate flake this file's OWN retry already handles). Bun.spawnSync
// never threw in either case, so this is not Bun failing to LAUNCH zig at
// all (ZIG_EXE is an absolute path, never PATH-searched for the top-level
// process) - exit 5 is a real code zig's own process reports, from
// somewhere inside its compile/link path that shells out to a further
// unqualified command, resolved through whatever PATH it was handed.
// Every spawn this file makes now goes through tools/env.ts's
// sanitizedEnv(), which removes the dominant cause outright rather than
// retrying around it.
//
// A FOURTH failure mode, found after the alias-PATH fix above stopped
// covering every remaining red run: zig's own GLOBAL CACHE
// (content-addressed, under `zig env`'s `global_cache_dir` - the OS
// default, shared across every project and every process on the machine
// unless ZIG_GLOBAL_CACHE_DIR overrides it) can hold a POISONED entry - a
// zero-byte manifest file under its `h/` directory, an empty directory
// under its `o/` directory - left behind by an attempt that got killed
// mid-write (this file's own DEFAULT_TIMEOUT_MS kill included) or lost
// a race with a concurrent one. Confirmed directly on the default global
// cache: hundreds of zero-byte manifests and several empty content
// directories, spanning days of ordinary use, not one bad run. Windows
// exit code 5 IS `ERROR_ACCESS_DENIED` - every future compilation whose
// content hash lands on a poisoned entry dies the same silent way, for
// the SAME fixture, every time: deterministic per fixture, which is
// exactly what this repository spent a long time calling "flaky". Fixed
// two ways below: every zig spawn gets its OWN cache, private to this
// repository (so no other project or stray process can poison it again),
// and a silent failure wipes that cache before the next attempt (so a
// poisoned entry this repo's own killed attempt left behind cannot wedge
// every future compile of the same fixture forever). Real, but NOT what
// was still making test:hostile fail after that fix landed - see the
// fifth failure mode below, found by actually bisecting that specific
// remaining red run rather than assuming the fourth one covered it.
//
// A FIFTH failure mode, found by bisecting test:hostile's own
// audio_bad_buffer case (the one with the most `-Wl,--export=` flags of
// any fixture in this repo, 18) after wiping the cache clean did NOT fix
// it: with a completely empty cache and no other zig process alive,
// `zig cc` still exited 5 with empty stderr and wrote nothing, EVERY
// time, on the FIRST attempt - not the flake the fourth failure mode
// above describes. Bisected by varying which of -I/source/-o were
// absolute vs relative to cwd, one at a time: any ONE of them absolute
// was fine; ALL THREE absolute together (exactly what every caller here
// constructs, via resolve()/join() from import.meta.dir) reproduced the
// silent exit 5 on every single attempt, and ONLY for a fixture with this
// many export flags - fewer flags with the same all-absolute paths built
// clean. This reads as the same long-documented "many -Wl,--export= flags
// makes zig cc's linker crash" flake, made DETERMINISTIC rather than
// occasional by adding the length of three long, deeply-nested absolute
// Windows paths (this checkout's own worktree path alone is 72
// characters) to an already-long command line - not refuted by the
// measurement above it, sharpened by it. Fixed by relativizeArgs() below:
// every absolute path argument this file is about to hand to zig, that
// resolves inside REPO_ROOT, is rewritten relative to it before the
// spawn (with `cwd: REPO_ROOT` set to match), which cannot change what
// file zig opens and measurably returns the flake rate to the ordinary,
// already-handled range instead of a deterministic wall.
//
// A SIXTH failure mode, found bisecting test:host and test:hostile going
// red on the same tree that had just made every OTHER gate here green
// (typecheck, pack:lint, example:build, pack:build, harness:selftest,
// test:wasi, test:external, test:verdict, test:devlink, verify,
// verify-bundle, every site verifier). Measured, one variable at a time,
// solo, no other zig process alive: disabling the wipe alone - 0/3 both
// suites. Disabling relativizeArgs alone - 0/3 both. Both disabled - 0/3
// both. None of the three explains it. What DOES: swapping in this
// file's own pre-cache-isolation version (no ZIG_GLOBAL_CACHE_DIR
// override at all, so zig falls back to its OS default,
// `~/AppData/Local/zig` here) made test:host pass 4/4 across two separate
// sessions, while the repo-local `.zig-global-cache` - EMPTY, since a
// fresh checkout has never populated it - failed reliably even wiping
// disabled, even with a deliberately SHORT cache path (ruling out the
// fifth failure mode's own path-length mechanism), even after several
// runs let it accumulate a few dozen files without ever fully warming.
// harness/hostSide.ts's native, SANITIZED link needs compiler-rt and the
// ubsan runtime built - real, first-time work a cache that has done it
// thousands of times over ordinary daily use does instantly, and a cache
// that has never done it has to do from nothing, which is exactly the
// long, first-time-heavy build this repo's whole "zig cc exit 5" flake
// hits hardest. Wiping on every silent failure (the fourth failure mode's
// own fix) made this WORSE, not better: every retry started that
// first-time work over again in an emptied cache instead of ever getting
// the chance to finish it once. Fixed two ways, both below: wipe now
// fires ONLY on a timeout kill (the one shape this repo has actual
// evidence of poisoning for), never on a plain silent exit; and
// harness/hostSide.ts's own two zig calls opt out of the repo-local cache
// override entirely (`useAmbientCache: true`) and use zig's own OS
// default instead, warm from everyday use and not this file's own
// poisoning suspect to manage.
//
// test:hostile (wasm32-freestanding, no sanitizer, no compiler-rt) was
// NOT explained by any of the above: it stayed red across every variant
// tried, including zig's own warm default cache, on different fixtures
// each run (button_trap, push_rect_out_of_bounds, sensor_missing_id,
// fb_out_of_bounds) rather than the same one every time - not the
// deterministic shape the fifth failure mode's own fix targets, and not
// fixed by anything cache-related either. Left red and reported as such
// rather than papered over: whatever this is remains unexplained.
import { readFileSync, rmSync, statSync } from "node:fs";
import { resolve, join, isAbsolute, relative } from "node:path";
import { sanitizedEnv } from "./env";

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
  // Run once a SILENT failure is actually detected (not on a diagnosed
  // one), before the pause-and-retry below - `wasTimeoutKill` says whether
  // THIS attempt was a signal-killed timeout (this file's own
  // ATTEMPT_TIMEOUT_MS) rather than a plain non-zero exit. runZigCc below
  // supplies one that wipes zig's own global cache directory ONLY on a
  // timeout kill: see this file's header comment (the sixth failure mode)
  // for why a wipe on every silent failure was measured to be
  // counterproductive for a long, sanitized native link.
  onSilentFailure?: (wasTimeoutKill: boolean) => void;
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
        // Always sanitized, not only when opts.env is given: the
        // alias-PATH pollution this file's own header comment measures
        // is there whenever this process itself was started via `bun run
        // <script-name>`, whether or not a caller passes its own extra
        // env vars on top.
        env: sanitizedEnv(opts.env),
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
    const lied = !r.success && !diagnosed(stderr) && (opts.artifactOk?.() ?? false);
    const ok = r.success || lied;

    if (ok) {
      const output = [stdout.trim(), stderr.trim()].filter((s) => s.length > 0).join("\n");
      if (output.length > 0) console.log(output);
      return { ok: true, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    if (diagnosed(stderr)) {
      // A real diagnosed failure: printed once, here, and never retried.
      console.error(stderr.trim());
      return { ok: false, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    // Only warnings on stderr: printed, so nothing is swallowed, and then
    // treated as the silent failure it is (see diagnosed() above).
    if (stderr.trim().length > 0) console.error(stderr.trim());
    // A genuinely silent failure: no diagnostics, no accepted artifact.
    // Tell onSilentFailure whether THIS attempt was a timeout kill, BEFORE
    // deciding whether there is a next attempt left, so the caller can
    // react (runZigCc: wipe its cache) even on the attempt that exhausts
    // the budget, for whichever script runs next.
    opts.onSilentFailure?.(r.signalCode != null);
    if (attempt >= maxAttempts) {
      return { ok: false, stdout, stderr, exitCode: r.exitCode, signalCode: r.signalCode ?? null, attempts: attempt };
    }
    const how = r.signalCode ? `was killed (${r.signalCode}, most likely this attempt's own ${timeout}ms timeout)` : `exited ${r.exitCode}`;
    console.warn(`${cmd[0]} ${how} with no diagnostic text (attempt ${attempt}/${maxAttempts}), waiting ${pause}ms and retrying...`);
    Bun.sleepSync(pause);
    pause = Math.min(pause * 2, RETRY_PAUSE_CAP_MS);
  }
}

/**
 * Whether this attempt's stderr DIAGNOSED something, as opposed to merely
 * saying something.
 *
 * The rule used to be "any stderr at all means a real compile error, never
 * retry", and it was wrong in one specific and costly way: a source that
 * emits a WARNING prints on stderr on every single run, clean ones
 * included, so the flake this whole file exists to absorb was misread as a
 * diagnosed failure and never retried. apps/gameos's ports redefine an SFX
 * macro and warn about it, which is exactly why gameos was the one build
 * that blocked `bun run site:build` again and again while every other
 * module sailed through on a retry.
 *
 * So: a line naming an error is a real failure and is never retried; stderr
 * carrying nothing but warnings and notes is treated as silence, printed
 * either way so nothing is swallowed. Both clang ("error: ", "fatal
 * error:") and zig's own ("error: ") say the word, and a compiler that
 * failed for a reason it could name always names it.
 */
function diagnosed(stderr: string): boolean {
  return /(^|\s)(fatal error|error)\s*:/i.test(stderr) || /^error/im.test(stderr);
}

// ---- zig cc specifically --------------------------------------------------

// No machine-specific default: zig comes off PATH unless ZIG_EXE says
// otherwise (AGENTS.md's environment note).
export const ZIG_EXE = process.env.ZIG_EXE ?? "zig";

// tools/ -> repo root. Repo-local, not a temp directory: the whole point
// is a cache that PERSISTS across runs (that is what makes it useful at
// all) while staying private to this checkout, so a poisoned entry here
// is this repo's own problem to wipe, never the machine-wide cache every
// other project and every other agent on it shares.
const REPO_ROOT = resolve(import.meta.dir, "..");
export const DEFAULT_ZIG_GLOBAL_CACHE_DIR = join(REPO_ROOT, ".zig-global-cache");

// See this file's header comment (the fifth failure mode) for why this
// exists: any argument that is an absolute path resolving inside baseDir
// is rewritten relative to it - shorter, and resolves to the exact same
// file once the spawn's own `cwd` is set to baseDir to match. An absolute
// path OUTSIDE baseDir (zig's own install dir showing up in some flag
// value, say) is left untouched: relative(baseDir, arg) would start with
// ".." and that is deliberately the signal to leave it alone, not to
// rewrite it into something longer.
function relativizeArgs(args: string[], baseDir: string): string[] {
  return args.map((arg) => {
    if (!isAbsolute(arg)) return arg;
    const rel = relative(baseDir, arg);
    return rel.length > 0 && !rel.startsWith("..") ? rel : arg;
  });
}

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
  // Opts OUT of the repo-local cache override entirely: ZIG_GLOBAL_CACHE_DIR
  // is left unset (zig's own OS default, whatever ambient env this process
  // already has), and no wipe-on-timeout runs against it either. For
  // harness/hostSide.ts's native, sanitized link specifically - see this
  // file's header comment (the sixth failure mode): that link needs to
  // build compiler-rt and the ubsan runtime, and a cache that has never
  // done that before is measurably far more exposed to zig's own silent
  // exit-5 than a cache that already has them, which a fresh repo-local
  // cache never gets the chance to become without first surviving the
  // very builds it keeps failing. zig's own default cache is warm from
  // ordinary, everyday use and is not this file's own poisoning suspect
  // to manage - see AGENTS.md for the measurement.
  useAmbientCache?: boolean;
}

// Runs `zig cc ...args`, writing to `outPath`. See spawnWithRetry above
// for the full retry/verdict contract this wraps. `outPath` is removed
// before every attempt (including the first): a stale file left at that
// exact path, by this call's own previous attempt or an unrelated earlier
// run, must never be mistaken for THIS attempt's output.
export function runZigCc(args: string[], outPath: string, opts: ZigCcOptions = {}): SpawnRetryResult {
  // ZIG_GLOBAL_CACHE_DIR: repo-local by default (DEFAULT_ZIG_GLOBAL_CACHE_DIR
  // above), UNLESS opts.useAmbientCache opts all the way out (see that
  // field's own comment), or it is already set - by this call's own
  // opts.env, or by the ambient process env this script itself was
  // started with - in which case that choice is respected verbatim,
  // wipe-on-timeout included: a caller naming its own cache dir is taking
  // responsibility for it being safe to wipe, the same way this file's
  // own default is. `globalCacheDir` is null exactly when
  // useAmbientCache left ZIG_GLOBAL_CACHE_DIR out of the spawn's env
  // entirely - there is then no single directory this file could safely
  // wipe even if it wanted to (zig's own OS default is not this file's
  // secret to compute or own).
  const globalCacheDir = opts.useAmbientCache ? null : (opts.env?.ZIG_GLOBAL_CACHE_DIR ?? process.env.ZIG_GLOBAL_CACHE_DIR ?? DEFAULT_ZIG_GLOBAL_CACHE_DIR);
  // See this file's header comment (the fifth failure mode) and
  // relativizeArgs() above: every caller here builds args with absolute
  // paths (resolve()/join() from its own import.meta.dir), which this
  // shortens back down before they ever reach zig, cwd set to match so
  // the relative forms still resolve to the exact same files.
  const cwd = opts.cwd ?? REPO_ROOT;
  const relativeArgs = relativizeArgs(args, cwd);
  return spawnWithRetry([ZIG_EXE, ...relativeArgs], {
    cwd,
    env: globalCacheDir ? { ...opts.env, ZIG_GLOBAL_CACHE_DIR: globalCacheDir } : opts.env,
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
    // Wipe ONLY on a timeout kill, not on every silent failure - see this
    // file's header comment (the sixth failure mode) for the measurement:
    // a plain silent exit is far more often the ordinary, already-handled
    // flake than cache poisoning, and wiping on every one of them made a
    // long, sanitized native link (which recompiles compiler-rt and the
    // ubsan runtime from nothing every time the cache is emptied) far more
    // likely to exhaust its whole retry budget than to ever land a clean
    // attempt. A signal-killed attempt is the one shape this repo has
    // actual evidence of poisoning for (an attempt caught mid-write), so
    // that is the one case still worth the coarse, whole-cache wipe - and
    // only when there is a globalCacheDir this file actually owns.
    onSilentFailure: (wasTimeoutKill) => {
      if (!wasTimeoutKill || !globalCacheDir) return;
      console.warn(`zig cc: timeout kill, wiping the zig global cache at ${globalCacheDir} before the next attempt (a killed attempt can leave a poisoned entry there - see this file's header comment)`);
      try {
        rmSync(globalCacheDir, { recursive: true, force: true });
      } catch {
        // best-effort: if this can't be removed, the next attempt's own
        // failure will say so with a real diagnostic, not silence.
      }
    },
  });
}
