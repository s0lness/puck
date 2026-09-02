#!/usr/bin/env bun
// CI's own driver for tools/verify-bundle.ts: read every app entry in
// registry.json (a local path or an external url) and run
// `bun run tools/verify-bundle.ts <target> --json` against each in turn.
// Kept as its own small TypeScript file, not inlined shell in
// .github/workflows/verify-bundles.yml, so that workflow stays short and
// this repository's own TypeScript-only rule (AGENTS.md) holds for CI the
// same as everywhere else.
//
// Writes a compact PASS/FAIL markdown table to $GITHUB_STEP_SUMMARY when
// running inside GitHub Actions (falls back to stdout otherwise, so this
// is still runnable by hand: `bun run tools/ci-verify-registry.ts`), and
// exits non-zero if any app's verify-bundle run did - that non-zero exit
// is what fails the CI job, per docs/convention/publishing.md's "CI
// re-verifies on every PR, push, and nightly."

import { readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Registry {
  apps: { name: string; path?: string; url?: string }[];
}

interface AppRunResult {
  name: string;
  target: string;
  exitCode: number;
  detail: string;
}

function runVerifyBundle(target: string): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(["bun", "run", "tools/verify-bundle.ts", target, "--json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "inherit",
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ? result.stdout.toString() : "" };
}

function detailFor(stdout: string, exitCode: number): string {
  try {
    const parsed = JSON.parse(stdout) as { ports?: { pack: string; status: string; reason?: string }[]; errors?: string[] };
    if (Array.isArray(parsed.ports)) {
      return parsed.ports
        .map((p) => {
          if (p.status === "pass") return `${p.pack}: ${p.status}`;
          // The reason's first line, so a bare "error"/"fail" in this
          // summary line always names WHY, not just that it happened - the
          // rest of a build failure's captured output is already in the job
          // log (tools/verify-bundle.ts prints it as it happens).
          const first = (p.reason ?? "").split("\n")[0] ?? "";
          return `${p.pack}: ${p.status}${first ? ` (${first})` : ""}`;
        })
        .join(", ");
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return parsed.errors[0]!;
  } catch {
    // stdout was not JSON: the run crashed before verify-bundle printed its
    // own result. Fall through to the generic detail below.
  }
  return exitCode === 0 ? "all ports verified" : "see job log";
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8")) as Registry;

  const results: AppRunResult[] = [];
  for (const app of registry.apps) {
    const target = app.path ?? app.url;
    if (!target) {
      results.push({ name: app.name, target: "(none)", exitCode: 2, detail: "malformed registry.json entry: no path or url" });
      continue;
    }
    const { exitCode, stdout } = runVerifyBundle(target);
    results.push({ name: app.name, target, exitCode, detail: detailFor(stdout, exitCode) });
    console.log(`${app.name} (${target}): exit ${exitCode}`);
  }

  const rows = results.map((r) => `| ${r.name} | ${r.target} | ${r.exitCode === 0 ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "\\|")} |`);
  const table = ["| app | target | result | detail |", "|---|---|---|---|", ...rows].join("\n") + "\n";

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `## verify-bundle results\n\n${table}\n`);
  else console.log(`\n${table}`);

  const allPass = results.every((r) => r.exitCode === 0);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(`tools/ci-verify-registry.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
