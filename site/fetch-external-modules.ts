// site/fetch-external-modules.ts: builds the module for every app published
// in its OWN repository, and writes it into site/external-modules/, which is
// tracked.
//
// Why this is a separate step and not part of `bun run site:build`: an
// external port's module is not compiled from anything in this repository.
// It comes from cloning somebody else's repo at a pinned commit and running
// THEIR build command (tools/externalBuild.ts, which says in its own header
// that "a gallery build" is one of the callers it exists for). That command
// wants a toolchain this repository does not carry and cannot vendor -
// tinydraw's own scripts/build-puck-wasm needs a WASI clang++, cmake and
// ninja - so a site build that depended on it would fail on any machine
// that happens not to have them, for a reason that has nothing to do with
// the site.
//
// So the artifact is tracked, exactly like site/flash-artifacts/: built on a
// machine that has the toolchain (toolchains.local.json names where it is),
// committed, and copied into site/dist/ by site/build.ts. index.json beside
// it records what produced each one, so the committed bytes are never an
// anonymous blob: repo, commit, command, artifact path, and the sha256 of
// the module itself.
//
// Run with: bun run site:external-modules
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { buildExternalPortTo, validateExternalBuild, type ExternalBuild } from "../tools/externalBuild";
import { sanitizedEnv } from "../tools/env";
import { externalComboId, externalModulesDir, type ExternalModuleRecord } from "./externalModules";

const SITE_DIR = import.meta.dir;
const REPO_ROOT = resolve(SITE_DIR, "..");
const OUT_DIR = externalModulesDir(SITE_DIR);
const INDEX_PATH = join(OUT_DIR, "index.json");

interface Registry {
  apps: { name: string; path?: string; url?: string; commit?: string }[];
}
interface Bundle {
  name: string;
  ports: { pack: string; build?: ExternalBuild }[];
}

// The same pinned fetch tools/ledger.ts's own cloneAtPin() performs, for the
// same reason it restates it rather than importing: that one is private to a
// CLI that also computes a ledger, and this needs nothing but the bundle.json
// at the pin. tools/externalBuild.ts's checkout() is the shared one, and it
// is for a PORT's build block, not for the bundle that carries it.
function cloneBundleAtPin(url: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "puck-external-bundle-"));
  const git = (args: string[], cwd?: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: sanitizedEnv() });
  const tail = (r: ReturnType<typeof git>) => (r.stderr ? r.stderr.toString().trim() : "");
  const init = git(["init", "--quiet", dir]);
  if (!init.success) throw new Error(`could not git init ${dir}: ${tail(init)}`);
  const remote = git(["remote", "add", "origin", "--", url], dir);
  if (!remote.success) throw new Error(`could not add ${url} as a remote: ${tail(remote)}`);
  const fetched = git(["fetch", "--depth", "1", "origin", commit], dir);
  if (!fetched.success) throw new Error(`could not fetch ${commit} from ${url}: ${tail(fetched)}`);
  const co = git(["checkout", "--quiet", "FETCH_HEAD"], dir);
  if (!co.success) throw new Error(`fetched ${commit} but could not check it out: ${tail(co)}`);
  return dir;
}

const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8")) as Registry;
const external = registry.apps.filter((a) => !a.path && a.url && a.commit);
if (external.length === 0) {
  console.log("registry.json has no app published in its own repository: nothing to build");
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const records: ExternalModuleRecord[] = [];

for (const app of external) {
  console.log(`\n--- ${app.name} @ ${app.commit!.slice(0, 10)}`);
  const bundleDir = cloneBundleAtPin(app.url!, app.commit!);
  try {
    const bundle = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as Bundle;
    for (const port of bundle.ports) {
      if (!port.build) continue;
      const errors = validateExternalBuild(port.build, `${app.name}'s ${port.pack} port's build`);
      if (errors.length > 0) throw new Error(errors.join("; "));
      const slug = externalComboId({ app: app.name, pack: port.pack });
      const outPath = join(OUT_DIR, `${slug}.wasm`);
      await buildExternalPortTo(
        port.build,
        {
          baseDir: bundleDir,
          env: { ZIG_EXE: process.env.ZIG_EXE },
          onLog: (line) => console.log(`    ${line}`),
        },
        outPath
      );
      const sha256 = createHash("sha256").update(readFileSync(outPath)).digest("hex");
      records.push({
        app: app.name,
        pack: port.pack,
        repo: port.build.repo,
        commit: port.build.commit,
        command: port.build.command,
        artifact: port.build.artifact,
        module: `${slug}.wasm`,
        sha256,
      });
      console.log(`  wrote site/external-modules/${slug}.wasm (sha256 ${sha256.slice(0, 16)})`);
    }
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

records.sort((a, b) => (a.app + a.pack).localeCompare(b.app + b.pack));
writeFileSync(INDEX_PATH, JSON.stringify(records, null, 2) + "\n");
console.log(`\nwrote site/external-modules/index.json (${records.length} module(s))`);
