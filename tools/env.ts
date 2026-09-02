// tools/env.ts: one shared sanitizedEnv(), for every child process this
// repository's own tooling spawns.
//
// `bun run <script-name>` (the package.json alias form, e.g. `bun run
// test:host`) prepends one `node_modules/.bin` entry PER ANCESTOR
// DIRECTORY of the repo root to PATH, ahead of everything else - verified
// directly (not assumed) by printing process.env.PATH from inside a script
// invoked both ways: `bun run tools/externalBuild.ts`'s own process saw a
// plain PATH, `bun run <alias-that-runs-the-same-file>` saw nine extra
// `.../node_modules/.bin` segments in front of it, walking all the way up
// to the filesystem root, NONE of which exist on disk on this machine.
// Every one of those is a directory that has to be stat()'d and found
// missing before reaching the real Git/System32 entries behind them - for
// EVERY unqualified command a spawned process runs, not just once, and
// that includes `zig cc` ITSELF: it is not merely a passthrough binary,
// its own compile/link path shells out to further unqualified commands
// internally, resolved through whatever PATH it was launched with.
//
// MEASURED, not assumed (this file's own commit message has the numbers):
// with the alias-polluted PATH inherited unchanged, a tight loop of
// `zig cc` compiling test/host/fixtures/clean.c wrote NOTHING at all, 0/5
// attempts, every one exiting 5 with empty stderr - not the pre-existing
// "exits non-zero but the artifact is fine" flake tools/zigSpawn.ts's
// runZigCc() already retries around, but a WORSE, deterministic failure
// with the artifact genuinely never produced. The same loop under a
// sanitized PATH wrote a real artifact 3/5 times (the remaining 2 were the
// pre-existing, separate flake, unrelated to PATH - see runZigCc's own
// header comment). Bun.spawnSync never threw in either case (the
// top-level `zig.exe` launch itself always succeeds - ZIG_EXE is an
// absolute path, never PATH-resolved), so exit code 5 is a real code
// zig's own process reports, not Bun surfacing an ENOENT it could not
// launch at all: the failure is one level INSIDE zig cc, in whatever
// unqualified command its own compile/link path shells out to, exactly
// the mechanism the paragraph above describes.
//
// A nonexistent directory can never resolve a real binary, so dropping it
// from PATH before spawning any child process can only remove noise,
// never change which binary answers a real command.
import { existsSync } from "node:fs";

export function sanitizedEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const raw = process.env.PATH ?? "";
  const pathSep = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const cleaned = raw
    .split(pathSep)
    .filter((p) => p.length > 0 && !seen.has(p) && seen.add(p) && existsSync(p))
    .join(pathSep);
  return { ...process.env, ...extra, PATH: cleaned };
}
