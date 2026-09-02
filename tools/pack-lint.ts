#!/usr/bin/env bun
// pack-lint: checks every local pack in registry.json against
// docs/convention/device-pack.md's required contents, mechanically rather
// than by trusting a README that says a pack is conformant. This is the
// `pack:lint` job docs/roadmap.md's workstream 6 names ("checks every pack
// against the convention's required contents, so the reference pack is
// held to its own standard") - the reference pack has been the least
// conformant of the three in practice, which is the whole reason to check
// this by machine instead of by memory.
//
// What "required contents" means here, straight from
// docs/convention/device-pack.md plus docs/abi.md's emu_device() field
// list:
//
//   - AGENTS.md                the entry point for a person or LLM
//   - device.json               parseable JSON carrying, at minimum, the
//                               fields emu_device() requires (name,
//                               panel.{w,h,format}, buttons[],
//                               touch.points, sensors[]) plus the
//                               convention/memory metadata device-pack.md
//                               says this file adds on top of the wire ABI
//   - gotchas.md                (or another non-empty hardware-traps doc
//                               under that exact name - the convention
//                               names one file, so this checks for it)
//   - wasm/build.ts             the build script that writes the pinned
//                               puck checkout's wasm/dist/emu.wasm
//   - gate/, OR an "## Gate" section in AGENTS.md naming the pack's own
//     equivalent set of fast checks explicitly. device-pack.md allows
//     either; this tool only accepts the substitute when it is actually
//     named under that heading, not implied.
//
// One check beyond the file list: every wasm/build.ts's zig invocation
// must bound each attempt with a timeout. Not part of the convention doc
// yet, added here because a build with no per-attempt bound has already
// hung past ten minutes on this machine (see docs/decisions/0008, and
// docs/roadmap.md's workstream 0). Checked by finding every
// `Bun.spawnSync(...)` call in the file and requiring at least one to
// carry a `timeout:` option - a text check, not a build, so it stays fast
// and works without zig installed.
//
// External packs (a `{"name","url"}` registry.json entry) are not checked:
// nothing about them exists on this machine to lint.
//
//   bun run pack:lint
//
// Exit 0: every local pack is clean. Exit 1: one line per violation,
// printed to stderr, naming the pack and exactly what is missing.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface RegistryPack {
  name: string;
  path?: string;
  url?: string;
}

interface Registry {
  packs?: RegistryPack[];
}

const registry: Registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8"));

const violations: string[] = [];

function fail(pack: string, message: string): void {
  violations.push(`${pack}: ${message}`);
}

// Bracket-balanced extraction of every `needle(...)` call's own text, so a
// multi-line Bun.spawnSync([...], { ... }) call is checked as one unit
// rather than by a line-by-line regex that could match the wrong call.
function extractCalls(text: string, needle: string): string[] {
  const calls: string[] = [];
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf(needle, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let i = start + needle.length;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    calls.push(text.slice(start, i));
    searchFrom = i;
  }
  return calls;
}

function checkDeviceJson(pack: string, dir: string): void {
  const devicePath = join(dir, "device.json");
  if (!existsSync(devicePath)) {
    fail(pack, "missing device.json");
    return;
  }
  let device: any;
  try {
    device = JSON.parse(readFileSync(devicePath, "utf8"));
  } catch (e) {
    fail(pack, `device.json is not valid JSON (${(e as Error).message})`);
    return;
  }
  const missing: string[] = [];
  if (typeof device.name !== "string") missing.push("name");
  if (typeof device.convention !== "string") missing.push("convention");
  if (
    typeof device.panel !== "object" ||
    device.panel === null ||
    typeof device.panel.w !== "number" ||
    typeof device.panel.h !== "number" ||
    typeof device.panel.format !== "string"
  ) {
    missing.push("panel.{w,h,format}");
  }
  if (!Array.isArray(device.buttons)) missing.push("buttons[]");
  if (typeof device.touch !== "object" || device.touch === null || typeof device.touch.points !== "number") {
    missing.push("touch.points");
  }
  if (!Array.isArray(device.sensors)) missing.push("sensors[]");
  if (typeof device.memory !== "object" || device.memory === null) missing.push("memory{}");
  if (missing.length > 0) {
    fail(pack, `device.json missing required field(s): ${missing.join(", ")}`);
  }
}

function checkGotchas(pack: string, dir: string): void {
  const gotchasPath = join(dir, "gotchas.md");
  if (!existsSync(gotchasPath)) {
    fail(pack, "missing gotchas.md");
    return;
  }
  if (readFileSync(gotchasPath, "utf8").trim().length === 0) {
    fail(pack, "gotchas.md is empty");
  }
}

function checkBuildTimeout(pack: string, buildPath: string): void {
  const text = readFileSync(buildPath, "utf8");
  const calls = extractCalls(text, "Bun.spawnSync(");
  if (calls.length === 0) {
    fail(pack, "wasm/build.ts has no Bun.spawnSync call to bound with a per-attempt timeout");
    return;
  }
  const uncapped = calls.filter((call) => !/timeout\s*:/.test(call));
  if (uncapped.length > 0) {
    fail(
      pack,
      `wasm/build.ts: ${uncapped.length} of ${calls.length} Bun.spawnSync call(s) have no per-attempt timeout: option`
    );
  }
}

function checkGate(pack: string, dir: string, agentsText: string | null): void {
  if (existsSync(join(dir, "gate"))) return;
  const namesGateSection = agentsText !== null && /^##\s+Gate\b/m.test(agentsText);
  if (!namesGateSection) {
    fail(
      pack,
      'no gate/ directory, and AGENTS.md names no "## Gate" section naming an equivalent set of fast checks (docs/convention/device-pack.md)'
    );
  }
}

function checkPack(pack: RegistryPack): void {
  if (!pack.path) return; // external (url-only) packs: nothing local to lint
  const dir = resolve(REPO_ROOT, pack.path);
  if (!existsSync(dir)) {
    fail(pack.name, `pack path does not exist: ${pack.path}`);
    return;
  }

  const agentsPath = join(dir, "AGENTS.md");
  let agentsText: string | null = null;
  if (!existsSync(agentsPath)) {
    fail(pack.name, "missing AGENTS.md");
  } else {
    agentsText = readFileSync(agentsPath, "utf8");
  }

  checkDeviceJson(pack.name, dir);
  checkGotchas(pack.name, dir);

  const buildPath = join(dir, "wasm", "build.ts");
  if (!existsSync(buildPath)) {
    fail(pack.name, "missing wasm/build.ts");
  } else {
    checkBuildTimeout(pack.name, buildPath);
  }

  checkGate(pack.name, dir, agentsText);
}

const localPacks = (registry.packs ?? []).filter((p) => p.path);
for (const pack of registry.packs ?? []) checkPack(pack);

if (violations.length > 0) {
  console.error(`pack:lint: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`pack:lint: ${localPacks.length} local pack(s) clean`);
process.exit(0);
