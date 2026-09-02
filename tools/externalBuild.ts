// Fetching a bundle port's module from someone else's repository, at a
// pinned commit, by running that repository's own build command.
//
// This is the one implementation of clone-pin-run in this repository.
// tools/verify-bundle.ts drives it for verification; anything that later
// needs the same module (a gallery build, a CI job) imports from here
// rather than growing a second copy that would agree with this one exactly
// once, on the day it was written. Same argument
// docs/decisions/0002-two-compilers-not-one.md makes about firmware logic,
// applied to this repository's own tooling.
//
// What it does NOT do: verify anything. It produces a .wasm file and says
// where it came from. Whatever asked for it then verifies that module
// exactly like any other, with the same traces, the same recorded frames
// and the same tolerance rules
// (docs/convention/app-bundle.md: "listing is a reproduction, not a
// submission"). An external port is not a softer claim, it is the same
// claim about a module that was built somewhere else.
//
// The trust model is deliberate and is written down in
// docs/decisions/0005-external-ports-are-reproduced.md: running this means
// executing another repository's build command on this machine. The pinned
// commit narrows what that command can be, it does not remove the trust.
//
// Every path goes through node:path, never a hand-built string with a
// literal separator: this runs on Windows (development) and Linux (the
// zero-secret CI workflow) unmodified.

import { cpSync, existsSync, mkdtempSync, rmSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve, sep, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

// The four fields a bundle port's "build" object carries
// (docs/convention/app-bundle.md). Named exactly as they appear in JSON.
export interface ExternalBuild {
  // A git URL, or a path to a directory on this machine. A local path is
  // resolved against the bundle's own repository root, the same rule every
  // other path in bundle.json follows.
  repo: string;
  // A full or abbreviated commit sha, or WORKING_TREE_COMMIT for a local
  // directory that is not a git repository at all. A branch or tag name is
  // rejected: it names a moving target, and a reproduction that can move
  // is not a reproduction.
  commit: string;
  // Run at the root of the checkout, through `bash -c`.
  command: string;
  // Where the command leaves the module, relative to the checkout root.
  artifact: string;
}

// The one non-sha value `commit` may take: a local directory with no git
// history of its own (a test fixture, a developer's scratch checkout).
// Spelled out rather than allowed silently, because the difference matters:
// everything else here is pinned, and this is the one shape that is not.
export const WORKING_TREE_COMMIT = "working-tree";

// A FULL 40-character sha, not an abbreviated prefix: an abbreviated sha is
// only unambiguous against the object database it was typed against, and a
// bundle.json entry is read long after that database (and whatever objects
// happened to exist in it that day) is gone. The full sha is the only form
// that still names exactly one commit, forever, in any clone.
const COMMIT_RE = /^[0-9a-f]{40}$/;

export class ExternalBuildError extends Error {}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Remote in the sense that matters here: git has to go over a network or a
// transport to get it, so a local-path copy is not an option.
export function isRemoteRepo(repo: string): boolean {
  return /^https?:\/\//.test(repo) || /^git@/.test(repo) || /^ssh:\/\//.test(repo) || /^git:\/\//.test(repo);
}

// Schema validation, returned as a list of messages rather than thrown, so
// a bundle validator can report every problem in the bundle at once (the
// shape tools/verify-bundle.ts's own validateBundleShape uses).
export function validateExternalBuild(raw: unknown, label: string): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [`${label} must be an object with "repo", "commit", "command" and "artifact"`];
  }
  const b = raw as Record<string, unknown>;
  if (!isNonEmptyString(b.repo)) errors.push(`${label}.repo must be a non-empty string (a git URL or a local path)`);
  if (!isNonEmptyString(b.command)) errors.push(`${label}.command must be a non-empty string (a shell command run at the checkout root)`);
  if (!isNonEmptyString(b.artifact)) errors.push(`${label}.artifact must be a non-empty string (the built .wasm, relative to the checkout root)`);
  if (!isNonEmptyString(b.commit)) {
    errors.push(`${label}.commit must be a non-empty string (a commit sha, or "${WORKING_TREE_COMMIT}" for a local directory with no git history)`);
  } else if (b.commit !== WORKING_TREE_COMMIT && !COMMIT_RE.test(b.commit)) {
    errors.push(
      `${label}.commit must be a full 40-character commit sha, got ${JSON.stringify(b.commit)}. ` +
        `An abbreviated sha is not accepted: it is only unambiguous against the object database it was typed against, ` +
        `which will not still exist when this bundle is verified later. ` +
        `A branch or tag name is not accepted either: it names a moving target, and a build that can move is not a reproduction. ` +
        `Use "${WORKING_TREE_COMMIT}" only for a local directory that is not a git repository.`
    );
  }
  if (isNonEmptyString(b.artifact) && (isAbsolute(b.artifact) || b.artifact.split(/[\\/]/).includes(".."))) {
    errors.push(`${label}.artifact must stay inside the checkout: no absolute path, no ".." segment (got ${JSON.stringify(b.artifact)})`);
  }
  return errors;
}

// A short, honest one-liner for a human reading a verifier's output: what
// was built, from where, at what. An unpinned working tree says so in
// words rather than showing a sha it does not have.
export function describeExternalBuild(build: ExternalBuild): string {
  const at = build.commit === WORKING_TREE_COMMIT ? "unpinned working tree" : build.commit.slice(0, 10);
  return `${build.repo}@${at}`;
}

export interface ExternalBuildOptions {
  // What a local `repo` path resolves against: the bundle's own repository
  // root. Absolute paths in `repo` are used as-is.
  baseDir: string;
  // Extra environment for the build command, merged over process.env. The
  // caller passes ZIG_EXE and friends the same way it does for a local
  // pack build.
  env?: Record<string, string | undefined>;
  // Per-step output, line by line, for a caller that wants to show
  // progress. Silent when omitted.
  onLog?: (line: string) => void;
  // Wall-clock cap on the build command itself. A build that hangs is
  // worse than a build that fails: it looks like one that is working.
  timeoutMs?: number;
}

export interface ExternalBuildOutcome {
  // The built module, absolute, inside the temporary checkout.
  artifactPath: string;
  // The temporary checkout's root.
  workDir: string;
  // describeExternalBuild()'s string, carried alongside the artifact so a
  // caller reporting a result never has to re-derive it.
  provenance: string;
  // Removes the temporary checkout. Always call it, in a finally.
  cleanup(): void;
}

const DEFAULT_TIMEOUT_MS = 600_000;

// timeoutMs applies here too, not just to the build command below: a git
// clone/fetch/checkout against a host that stalls (a bad URL, a network
// that hangs instead of refusing) is exactly the same "looks like it's
// still working" failure mode the build command's own timeout exists for.
function runGit(args: string[], cwd: string | undefined, timeoutMs: number, onLog?: (line: string) => void): { ok: boolean; stdout: string; stderr: string } {
  onLog?.(`git ${args.join(" ")}`);
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  return {
    ok: result.success,
    stdout: result.stdout ? result.stdout.toString().trim() : "",
    stderr: result.stderr ? result.stderr.toString().trim() : "",
  };
}

// Puts the repository's contents at `commit` into `workDir`.
//
// Remote: a single-commit fetch first (the cheap path, and the one that
// works against any host that allows fetching a sha directly), falling
// back to a full clone plus checkout for hosts that do not. Local git
// repository: cloned from disk, which git does with hardlinks, then
// checked out at the pinned commit, so a dirty working tree in the
// developer's own checkout can never leak into a verification. Local
// directory with no git history: copied, and only when the bundle says
// WORKING_TREE_COMMIT, so nothing ever claims a pin it does not have.
function checkout(build: ExternalBuild, workDir: string, options: ExternalBuildOptions): void {
  const { onLog } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const git = (args: string[], cwd: string | undefined) => runGit(args, cwd, timeoutMs, onLog);

  if (isRemoteRepo(build.repo)) {
    if (build.commit === WORKING_TREE_COMMIT) {
      throw new ExternalBuildError(`"${WORKING_TREE_COMMIT}" is only meaningful for a local directory; ${build.repo} is remote and must name a commit sha`);
    }
    const init = git(["init", "--quiet", workDir], undefined);
    if (!init.ok) throw new ExternalBuildError(`could not git init ${workDir}: ${init.stderr}`);
    // "--" before the repo URL in both `remote add` and `clone` below: it
    // stops git's own option parser there, so a repo value that happens to
    // start with "-" is never read back as a flag.
    const remote = git(["remote", "add", "origin", "--", build.repo], workDir);
    if (!remote.ok) throw new ExternalBuildError(`could not add ${build.repo} as a remote: ${remote.stderr}`);
    const fetch = git(["fetch", "--depth", "1", "origin", build.commit], workDir);
    if (fetch.ok) {
      const co = git(["checkout", "--quiet", "FETCH_HEAD"], workDir);
      if (!co.ok) throw new ExternalBuildError(`fetched ${build.commit} from ${build.repo} but could not check it out: ${co.stderr}`);
      verifyCheckedOutCommit(build, workDir, git);
      return;
    }
    // Some hosts refuse to serve an arbitrary sha directly. Full clone,
    // then checkout: slower, but it is the only remaining way to honour
    // the pin, and honouring the pin is the point.
    onLog?.(`shallow fetch of ${build.commit} refused, falling back to a full clone`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const clone = git(["clone", "--quiet", "--", build.repo, workDir], undefined);
    if (!clone.ok) throw new ExternalBuildError(`could not clone ${build.repo}: ${clone.stderr}`);
    const co = git(["checkout", "--quiet", build.commit], workDir);
    if (!co.ok) throw new ExternalBuildError(`cloned ${build.repo} but commit ${build.commit} could not be checked out: ${co.stderr}`);
    verifyCheckedOutCommit(build, workDir, git);
    return;
  }

  const source = resolve(options.baseDir, build.repo);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new ExternalBuildError(`local repo path does not exist or is not a directory: ${source}`);
  }
  const isGitRepo = existsSync(join(source, ".git"));

  if (build.commit === WORKING_TREE_COMMIT) {
    if (isGitRepo) {
      throw new ExternalBuildError(
        `${source} is a git repository, so "${WORKING_TREE_COMMIT}" is not accepted: name the commit sha this port is built from. ` +
          `An unpinned build of a repository that HAS history is a reproduction nobody can repeat.`
      );
    }
    onLog?.(`copying ${source} (no git history: this build is not pinned)`);
    cpSync(source, workDir, { recursive: true });
    return;
  }

  if (!isGitRepo) {
    throw new ExternalBuildError(
      `${source} is not a git repository, so commit ${build.commit} cannot be checked out. ` +
        `Use "${WORKING_TREE_COMMIT}" if this directory genuinely has no history, and know that such a build is not pinned.`
    );
  }
  const clone = git(["clone", "--quiet", "--", source, workDir], undefined);
  if (!clone.ok) throw new ExternalBuildError(`could not clone local repository ${source}: ${clone.stderr}`);
  const co = git(["checkout", "--quiet", build.commit], workDir);
  if (!co.ok) throw new ExternalBuildError(`cloned ${source} but commit ${build.commit} could not be checked out: ${co.stderr}`);
}

// Belt and suspenders on top of the pin itself: FETCH_HEAD is whatever the
// remote handed back for the ref/sha asked for, and a checkout of it always
// succeeds even if a misbehaving or compromised remote served something
// other than the exact commit requested (a mutated ref, a same-named
// object on a host that does not actually enforce immutable shas). Checking
// what actually got checked out against what was declared is what makes
// this a verified pin rather than a polite request.
function verifyCheckedOutCommit(build: ExternalBuild, workDir: string, git: (args: string[], cwd: string | undefined) => { ok: boolean; stdout: string; stderr: string }): void {
  const rev = git(["rev-parse", "HEAD"], workDir);
  if (!rev.ok) throw new ExternalBuildError(`checked out ${build.commit} from ${build.repo} but could not verify it (git rev-parse HEAD failed): ${rev.stderr}`);
  if (rev.stdout !== build.commit) {
    throw new ExternalBuildError(
      `checked out HEAD=${rev.stdout} from ${build.repo}, which does not match the declared commit ${build.commit}. ` +
        `Refusing to build: this is not the pinned commit, whatever the remote handed back.`
    );
  }
}

// Runs the build command and returns the artifact it produced.
//
// The command goes to `bash -c` as a single string, never assembled from
// bundle fields into a shell line here: the ONLY thing this file ever
// interpolates into a shell is the command the bundle itself wrote, which
// is what the trust model already covers. Everything else (the checkout
// path, the artifact path) is passed as an argument or resolved with
// node:path.
//
// `bash -c`, not `bash -lc`: a login shell re-reads the system profile,
// which on Windows (Git Bash) rewrites PATH and can hide the very
// toolchain the caller just put there.
export async function buildExternalPort(build: ExternalBuild, options: ExternalBuildOptions): Promise<ExternalBuildOutcome> {
  const workDir = mkdtempSync(join(tmpdir(), "puck-external-build-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  const provenance = describeExternalBuild(build);

  try {
    checkout(build, workDir, options);

    const artifactPath = resolve(workDir, build.artifact);
    if (!artifactPath.startsWith(workDir + sep)) {
      throw new ExternalBuildError(`artifact ${build.artifact} resolves outside the checkout (${artifactPath})`);
    }
    // Removed BEFORE the build, so "the artifact exists" can only mean
    // "this command produced it". Without this, a .wasm committed into the
    // repository (or left behind in a copied working tree) would pass as a
    // build output that never ran.
    rmSync(artifactPath, { force: true });

    options.onLog?.(`bash -c ${JSON.stringify(build.command)} (cwd ${workDir})`);
    // Spawned through a named helper rather than inline, so the return type
    // keeps its literal "pipe" stdio (a `ReturnType<typeof Bun.spawn>`
    // annotation widens it and loses the readable streams below).
    const startBuild = () =>
      Bun.spawn(["bash", "-c", build.command], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(options.env ?? {}) },
      });
    let proc: ReturnType<typeof startBuild>;
    try {
      proc = startBuild();
    } catch (err) {
      throw new ExternalBuildError(
        `could not run the build command: ${err instanceof Error ? err.message : String(err)} ` +
          `(a bundle's build command runs through bash; on Windows that is Git Bash's, which must be on PATH)`
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    let exitCode: number;
    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (exitCode !== 0) {
      // Last 40 lines, not 8: enough of the actual compiler/linker error to
      // read what broke without pasting an entire log, and kept on their
      // own lines (not joined into one) so a stack trace or a multi-line
      // diagnostic stays legible instead of turning into one long ribbon.
      const tail = [stdout, stderr]
        .join("\n")
        .trim()
        .split("\n")
        .slice(-40)
        .join("\n");
      throw new ExternalBuildError(`build command exited ${exitCode} for ${provenance}: ${build.command}${tail ? `\n${tail}` : ""}`);
    }
    if (!existsSync(artifactPath)) {
      throw new ExternalBuildError(
        `build command succeeded but produced no ${build.artifact} for ${provenance} ` +
          `(looked at ${artifactPath}; the artifact is deleted before the build, so a file committed into the repository does not count)`
      );
    }

    return { artifactPath, workDir, provenance, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// The whole thing, for a caller that only wants the module somewhere
// stable: build, copy the artifact to outPath, clean the checkout up.
export async function buildExternalPortTo(build: ExternalBuild, options: ExternalBuildOptions, outPath: string): Promise<{ provenance: string }> {
  const outcome = await buildExternalPort(build, options);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(outcome.artifactPath, outPath);
    return { provenance: outcome.provenance };
  } finally {
    outcome.cleanup();
  }
}
