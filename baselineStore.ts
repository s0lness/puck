// Disk persistence for the hardware-free regression check (src/regression.ts):
// where a saved baseline lives, and where a check's result gets exported for
// an agent to read. Node-fs-based, like server.ts's own saveFreeze/saveTrace
// - never bundled into the browser page, which only ever reaches this
// through server.ts's /api/baseline and /api/regression-result routes.
//
// Kept in its own module rather than inlined into server.ts the way
// saveFreeze/saveTrace are, specifically so test/regression/run.ts can call
// saveBaseline()/loadBaseline() directly and prove the round-trip with no
// HTTP server and no browser: importing server.ts itself is not an option
// for a test, since it calls Bun.serve() at module load time as a side
// effect the moment it's imported.
//
// Exactly one baseline slot ("latest") and one regression-result slot
// ("latest"): a baseline is "what good currently looks like", singular, not
// something to version by hand the way freezes/<id>/ keeps a full history
// (a freeze IS a moment in time worth keeping several of; a baseline is
// replaced, not archived). A regression result is a status report, written
// fresh on every check, pass or fail - see docs/agent-loop.md.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeRGBPNG } from "./harness/png";

const ROOT = import.meta.dir;
const BASELINES_DIR = join(ROOT, "baselines");
const REGRESSIONS_DIR = join(ROOT, "regressions");

export interface StoredFrame {
  atMs: number;
  width: number;
  height: number;
  rgbBase64: string;
}

export interface BaselineOnDisk {
  schemaVersion: 1;
  capturedAt: string;
  device: unknown;
  events: unknown[];
  capturePoints: number[];
  frames: StoredFrame[];
}

function writeFramePngs(dir: string, prefix: string, frames: StoredFrame[]): void {
  for (const f of frames) {
    const rgb = Buffer.from(f.rgbBase64, "base64");
    writeFileSync(join(dir, `${prefix}${f.atMs}.png`), encodeRGBPNG(f.width, f.height, rgb));
  }
}

// Writes baselines/latest/baseline.json (the exact bytes needed to check
// against later, read back with loadBaseline()) plus one PNG per capture
// point, purely so a person or an agent can open a baseline's frames
// directly without decoding base64 out of the JSON by hand. The directory is
// cleared first, the same reason saveRegressionResult() below clears its
// own: a previous baseline's frame-<atMs>.png files (from a trace with MORE
// or DIFFERENT capture points than this one) must never survive into a new
// baseline's directory looking like they still belong to it.
export function saveBaseline(bundle: BaselineOnDisk): { path: string } {
  const dir = join(BASELINES_DIR, "latest");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), JSON.stringify(bundle, null, 2));
  writeFramePngs(dir, "frame-", bundle.frames);
  return { path: "baselines/latest/" };
}

export function loadBaseline(): BaselineOnDisk | null {
  const file = join(BASELINES_DIR, "latest", "baseline.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as BaselineOnDisk;
}

export function hasBaseline(): boolean {
  return existsSync(join(BASELINES_DIR, "latest", "baseline.json"));
}

export interface DivergedPointOnDisk {
  atMs: number;
  width: number;
  height: number;
  baselineRgbBase64: string;
  currentRgbBase64: string;
  diffRgbBase64: string | null;
}

export interface RegressionResultOnDisk {
  schemaVersion: 1;
  checkedAt: string;
  pass: boolean;
  device: unknown;
  input: unknown[];
  points: unknown[];
  diverged: DivergedPointOnDisk[];
}

// Written fresh on every check, pass or fail - see docs/agent-loop.md's "A
// failed regression check, for an agent" section for the shape this
// produces and why it deliberately mirrors a freeze bundle. The directory
// is cleared first: a previous FAILING check's PNGs must never survive
// into a later PASSING check's directory looking like they still apply,
// since a pass has nothing to diverge on.
export function saveRegressionResult(bundle: RegressionResultOnDisk): { path: string } {
  const dir = join(REGRESSIONS_DIR, "latest");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const { diverged, ...rest } = bundle;
  const divergedMeta = diverged.map(({ baselineRgbBase64, currentRgbBase64, diffRgbBase64, ...meta }) => meta);
  writeFileSync(join(dir, "result.json"), JSON.stringify({ ...rest, diverged: divergedMeta }, null, 2));

  for (const d of diverged) {
    writeFileSync(join(dir, `t${d.atMs}.baseline.png`), encodeRGBPNG(d.width, d.height, Buffer.from(d.baselineRgbBase64, "base64")));
    writeFileSync(join(dir, `t${d.atMs}.current.png`), encodeRGBPNG(d.width, d.height, Buffer.from(d.currentRgbBase64, "base64")));
    if (d.diffRgbBase64) writeFileSync(join(dir, `t${d.atMs}.diff.png`), encodeRGBPNG(d.width, d.height, Buffer.from(d.diffRgbBase64, "base64")));
  }
  return { path: "regressions/latest/" };
}
