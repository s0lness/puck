#!/usr/bin/env bun
// Proves tools/externalBuild.ts, the one clone-pin-run implementation
// behind an external port (docs/decisions/0005-external-ports-are-
// reproduced.md), against the in-repo fixture
// (test/fixtures/external-app/) rather than any real external repository:
// no network, no clone of anything, nothing that can rot.
//
// This is the module-level test. The bundle-level proof is
// `bun run verify-bundle test/fixtures/external-bundle`, which drives the
// same module and then verifies the produced .wasm against recorded
// frames exactly like any local port.
//
// Six checks:
//   1. the fixture builds through buildExternalPortTo, and the artifact is
//      a real module (it instantiates and reports its own device)
//   2. a build command that produces nothing fails, naming the artifact:
//      the artifact is deleted before the command runs, so "the file is
//      there" can only mean "this command produced it"
//   3. a moving target (a branch name where a commit sha belongs) is
//      rejected by validation, before anything is run
//   4. an artifact path escaping the checkout is rejected the same way
//   5. a local directory with git history refuses "working-tree": a repo
//      that HAS a commit must name one
//   6. provenance reads honestly, including when there is no pin
//
// Run: bun run test:external   (needs zig, like every firmware fixture
// here; set ZIG_EXE if it is not on PATH)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildExternalPortTo,
  describeExternalBuild,
  validateExternalBuild,
  ExternalBuildError,
  WORKING_TREE_COMMIT,
  type ExternalBuild,
} from "../../tools/externalBuild";
import { instantiate, readDeviceDescriptor } from "../../src/wasm";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const ZIG_EXE = process.env.ZIG_EXE ?? (process.platform === "win32" ? "C:\\Users\\sylve\\tools\\zig\\zig.exe" : "zig");

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// The fixture bundle's own port entry, read from bundle.json rather than
// restated here: if the fixture's build command changes, this test builds
// what the bundle actually declares, not a copy of it that has drifted.
function fixtureBuild(): ExternalBuild {
  const bundle = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "external-bundle", "bundle.json"), "utf8")) as {
    ports: { build?: ExternalBuild }[];
  };
  const build = bundle.ports[0]?.build;
  if (!build) fail("test/fixtures/external-bundle/bundle.json's first port has no build object");
  return build;
}

async function main(): Promise<void> {
  const outDir = mkdtempSync(join(tmpdir(), "puck-external-test-"));
  const outPath = join(outDir, "module.wasm");
  const build = fixtureBuild();

  try {
    // ---- 1. the happy path, through the shared module ------------------
    console.log("1. the fixture builds through tools/externalBuild.ts...");
    const { provenance } = await buildExternalPortTo(build, { baseDir: REPO_ROOT, env: { ZIG_EXE } }, outPath);
    if (!existsSync(outPath)) fail(`buildExternalPortTo reported success but wrote no ${outPath}`);
    const bytes = readFileSync(outPath).buffer as ArrayBuffer;
    const emu = await instantiate(bytes, () => {});
    if (emu.emu_init() === 0) fail("the externally built module's emu_init() returned 0");
    const device = readDeviceDescriptor(emu);
    if (device.panel.w !== 32 || device.panel.h !== 32) {
      fail(`expected the fixture's own 32x32 panel, got ${device.panel.w}x${device.panel.h}`);
    }
    console.log(`PASS: built ${provenance}, a real module reporting "${device.name}" ${device.panel.w}x${device.panel.h}`);

    // ---- 2. a command that produces nothing -----------------------------
    console.log("\n2. a build command that produces no artifact fails, naming it...");
    let noArtifact: string | null = null;
    try {
      await buildExternalPortTo({ ...build, command: "true" }, { baseDir: REPO_ROOT, env: { ZIG_EXE } }, outPath);
    } catch (err) {
      if (!(err instanceof ExternalBuildError)) throw err;
      noArtifact = err.message;
    }
    if (noArtifact === null) fail("a no-op build command was accepted as if it had produced a module");
    if (!noArtifact.includes(build.artifact)) fail(`the error does not name the missing artifact: ${noArtifact}`);
    console.log(`PASS: "${noArtifact.slice(0, 100)}..."`);

    // ---- 3. a moving target is not a pin ---------------------------------
    console.log("\n3. a branch name where a commit sha belongs is rejected...");
    const branchErrors = validateExternalBuild({ ...build, commit: "main" }, "ports[0].build");
    if (branchErrors.length === 0) fail('"commit": "main" was accepted: a build that can move is not a reproduction');
    if (!branchErrors.some((e) => e.includes("commit sha"))) fail(`the rejection does not explain what is wrong: ${branchErrors.join("; ")}`);
    if (validateExternalBuild({ ...build, commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }, "ports[0].build").length !== 0) {
      fail("a real 40-character sha was rejected");
    }
    console.log(`PASS: ${branchErrors[0]!.slice(0, 110)}...`);

    // An abbreviated sha is unambiguous only against the object database it
    // was typed against, which will not still exist when this bundle is
    // verified later - so it is refused exactly like a branch/tag name.
    console.log("\n3b. an abbreviated (7-hex) sha is rejected...");
    const shortShaErrors = validateExternalBuild({ ...build, commit: "a1b2c3d" }, "ports[0].build");
    if (shortShaErrors.length === 0) fail('"commit": "a1b2c3d" (7 hex chars) was accepted: only a full 40-character sha is a real pin');
    if (!shortShaErrors.some((e) => e.includes("40-character"))) fail(`the rejection does not explain what is wrong: ${shortShaErrors.join("; ")}`);
    console.log(`PASS: ${shortShaErrors[0]!.slice(0, 110)}...`);

    // ---- 4. an artifact cannot escape the checkout -----------------------
    console.log("\n4. an artifact path escaping the checkout is rejected...");
    const escapeErrors = validateExternalBuild({ ...build, artifact: "../outside.wasm" }, "ports[0].build");
    if (escapeErrors.length === 0) fail('"artifact": "../outside.wasm" was accepted');
    console.log(`PASS: ${escapeErrors[0]!.slice(0, 110)}...`);

    // ---- 5. a repository with history must name a commit -----------------
    console.log("\n5. a local directory WITH git history refuses an unpinned build...");
    const gitDir = mkdtempSync(join(tmpdir(), "puck-external-test-git-"));
    mkdirSync(join(gitDir, ".git"), { recursive: true }); // enough for the "is this a repository" check
    let refusal: string | null = null;
    try {
      await buildExternalPortTo({ ...build, repo: gitDir, commit: WORKING_TREE_COMMIT }, { baseDir: REPO_ROOT, env: { ZIG_EXE } }, outPath);
    } catch (err) {
      if (!(err instanceof ExternalBuildError)) throw err;
      refusal = err.message;
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
    if (refusal === null) fail("a git repository was built unpinned, which claims a reproduction nobody can repeat");
    console.log(`PASS: "${refusal.slice(0, 110)}..."`);

    // ---- 6. provenance says what it knows --------------------------------
    console.log("\n6. provenance reads honestly...");
    const pinned = describeExternalBuild({ ...build, repo: "https://example.invalid/app.git", commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
    if (!pinned.includes("a1b2c3d4e5")) fail(`a pinned build's provenance does not show its commit: ${pinned}`);
    const unpinned = describeExternalBuild({ ...build, commit: WORKING_TREE_COMMIT });
    if (!unpinned.includes("unpinned")) fail(`an unpinned build's provenance does not say so: ${unpinned}`);
    console.log(`PASS: "${pinned}" and "${unpinned}"`);

    console.log(
      "\nPASS: the shared external-build module copies or clones at a pin, runs the declared command, " +
        "takes only an artifact that command actually produced, and refuses a build that cannot be reproduced."
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`test/external/run.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
