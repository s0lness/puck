#!/usr/bin/env bun
// gate: the fast device-specific check docs/convention/device-pack.md asks
// every pack for.
//
// What it checks is the one thing that can silently rot here: this pack
// states its own shape in THREE places, and the emulator, the site and the
// host each read a different one.
//
//   runtime/gfx.h        PANEL_W / PANEL_H, what every app draws against
//   wasm/emu_shim.c      emu_device()'s JSON, what the host and the
//                        harness read at runtime (the source of truth)
//   device.json          the comment-free documentation copy, what
//                        site/build.ts and a human read
//
// A disagreement between them is not a crash. It is a panel that renders
// at the wrong size in the gallery while every test still passes, or a
// port compiled against 368 wide talking to a host that laid out 320. So
// it is checked mechanically, by parsing the two C files rather than by
// trusting a comment that says they match.
//
// Deliberately a text scan, not a build: this has to be runnable in a
// second, before zig, and it has to keep working if the module currently
// on disk was built from something else.
//
//   bun run packs/web/gate/device-agrees.ts
//
// Exit 0: they agree. Exit 1: they do not, and the mismatch is named.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeButtonWiring } from "../wasm/buttonWiring";

const PACK_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PACK_ROOT, "..", "..");

interface DeviceJson {
  name: string;
  panel: { w: number; h: number; format: string };
  buttons: { id: string; label: string; edge: string; at: number; longPressMs?: number }[];
  touch: { points: number };
  sensors: { id: string; kind: string }[];
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const device = JSON.parse(readFileSync(join(PACK_ROOT, "device.json"), "utf8")) as DeviceJson;
const gfxH = readFileSync(join(PACK_ROOT, "runtime", "gfx.h"), "utf8");
const shim = readFileSync(join(PACK_ROOT, "wasm", "emu_shim.c"), "utf8");

// ---- gfx.h's panel constants --------------------------------------------
function defineIn(source: string, name: string): number | null {
  const m = new RegExp(`^#define\\s+${name}\\s+(\\d+)\\s*$`, "m").exec(source);
  return m ? Number(m[1]) : null;
}
const gfxW = defineIn(gfxH, "PANEL_W");
const gfxH_ = defineIn(gfxH, "PANEL_H");
check(gfxW === device.panel.w, `runtime/gfx.h PANEL_W is ${gfxW}, device.json panel.w is ${device.panel.w}`);
check(gfxH_ === device.panel.h, `runtime/gfx.h PANEL_H is ${gfxH_}, device.json panel.h is ${device.panel.h}`);

// ---- emu_device()'s JSON ------------------------------------------------
// Reassembled from the json_append() string literals in emu_device(), the
// same way a reader would: take every "..." literal inside that function,
// unescape it, and concatenate - stopping at the one that opens the "apps"
// array, because everything after it is a runtime loop over g_apps[] whose
// literals are separators, not JSON this gate could reconstruct. The array
// is closed off empty instead, which is enough: this gate is about the
// DEVICE's shape, and "apps" is the app's.
const fnStart = shim.indexOf("int emu_device(void) {");
check(fnStart !== -1, "wasm/emu_shim.c has no emu_device() to read");
let deviceJsonFromShim: DeviceJson | null = null;
if (fnStart !== -1) {
  const body = shim.slice(fnStart, shim.indexOf("\n}", fnStart));
  const literals = [...body.matchAll(/json_append\(p,\s*"((?:[^"\\]|\\.)*)"\)/g)].map((m) =>
    m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  );
  const parts: string[] = [];
  for (const lit of literals) {
    parts.push(lit);
    if (lit.endsWith('"apps":[')) break;
  }
  const text = `${parts.join("")}]}`;
  try {
    deviceJsonFromShim = JSON.parse(text) as DeviceJson;
  } catch (err) {
    failures.push(`could not reassemble emu_device()'s JSON from wasm/emu_shim.c: ${err instanceof Error ? err.message : String(err)}\n  reassembled: ${text}`);
  }
}

if (deviceJsonFromShim) {
  const s = deviceJsonFromShim;
  check(s.name === device.name, `emu_device() name is "${s.name}", device.json name is "${device.name}"`);
  check(s.panel.w === device.panel.w, `emu_device() panel.w is ${s.panel.w}, device.json says ${device.panel.w}`);
  check(s.panel.h === device.panel.h, `emu_device() panel.h is ${s.panel.h}, device.json says ${device.panel.h}`);
  check(s.panel.format === device.panel.format, `emu_device() panel.format is "${s.panel.format}", device.json says "${device.panel.format}"`);
  check(
    JSON.stringify(s.buttons) === JSON.stringify(device.buttons),
    `emu_device()'s buttons and device.json's buttons differ:\n  shim: ${JSON.stringify(s.buttons)}\n  json: ${JSON.stringify(device.buttons)}`
  );
  check(
    JSON.stringify(s.sensors) === JSON.stringify(device.sensors),
    `emu_device()'s sensors and device.json's sensors differ:\n  shim: ${JSON.stringify(s.sensors)}\n  json: ${JSON.stringify(device.sensors)}`
  );
  check(s.touch.points === device.touch.points, `emu_device() touch.points is ${s.touch.points}, device.json says ${device.touch.points}`);

  // The tilt sensor's INDEX, not just its presence: emu_shim.c's
  // SENSOR_IDX_TILT is a number that has to match this array's ordering,
  // and getting it wrong means emu_sensor_vector() silently drops every
  // reading (it returns early on any other index) - a fluid that never
  // pours, with nothing logged.
  const tiltIndex = s.sensors.findIndex((x) => x.kind === "vector");
  const declared = defineIn(shim, "SENSOR_IDX_TILT");
  check(
    tiltIndex >= 0 && tiltIndex === declared,
    `SENSOR_IDX_TILT is ${declared} but the vector sensor sits at index ${tiltIndex} in emu_device()'s sensors array`
  );
  const shakeIndex = s.sensors.findIndex((x) => x.id === "shake");
  const declaredShake = defineIn(shim, "SENSOR_IDX_SHAKE");
  check(
    shakeIndex >= 0 && shakeIndex === declaredShake,
    `SENSOR_IDX_SHAKE is ${declaredShake} but "shake" sits at index ${shakeIndex} in emu_device()'s sensors array`
  );
}

// ---- every declared button is wired, not just the first click and key ---
// docs/roadmap.md workstream 3's second finding: packs/web used to wire
// exactly one click and one key, so a board declaring four clicks and no
// key (packs/silhouettes/watchy) silently lost the other three, while
// tools/verdict.ts's buttonCheck reported the friendlier "a click stands in
// for it" - the two disagreed, and this is the check that keeps them from
// disagreeing again. wasm/buttonWiring.ts is the SAME function
// wasm/build.ts's generateDeviceHeader() calls to emit BTN_CLICK[]/
// BTN_KEY[], so this is not a second implementation to drift from the
// first: it is the one implementation, exercised here against a real
// four-button device.json with no zig build at all (this gate stays fast
// and hardware-free, docs/convention/device-pack.md).
const watchyPath = join(REPO_ROOT, "packs", "silhouettes", "watchy", "device.json");
const watchy = JSON.parse(readFileSync(watchyPath, "utf8")) as DeviceJson;
const watchyUsable = watchy.buttons.filter((b) => (b as { role?: string }).role === "click" || (b as { role?: string }).role === "key");
const watchyWiring = computeButtonWiring(watchy.buttons as { role?: string }[]);
check(
  watchy.buttons.length === 4,
  `packs/silhouettes/watchy/device.json declares ${watchy.buttons.length} buttons, expected 4 - this check's own fixture assumption is stale`
);
check(
  watchyWiring.wiredIndices.length === watchyUsable.length,
  `wasm/buttonWiring.ts wires ${watchyWiring.wiredIndices.length} of watchy's ${watchyUsable.length} usable buttons (clickIndices=${JSON.stringify(watchyWiring.clickIndices)}, keyIndices=${JSON.stringify(watchyWiring.keyIndices)}) - every declared click/key button must be wired, not only the primary click and key`
);
check(
  watchyWiring.primaryKey !== -1,
  `watchy declares no key-role button, and wasm/buttonWiring.ts found no spare click-role button to substitute for it either - BTN_PWR would stay -1, so a key demand met by a click would still receive nothing`
);

if (failures.length > 0) {
  console.error("packs/web gate: device declarations disagree");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("packs/web gate: device.json, runtime/gfx.h and wasm/emu_shim.c agree, and every declared button is wired");
