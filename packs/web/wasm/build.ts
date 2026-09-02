// build.ts: compiles this pack's runtime plus one app to a single
// wasm32-freestanding module, and (in host mode) writes a standalone,
// deployable directory around it.
//
// TWO MODES, one build, because a browser is a target device in two
// different senses at once:
//
//   MODULE MODE (default, and what tools/verify-bundle.ts drives)
//     bun run packs/web/wasm/build.ts [--app <file>] [--landscape] [--shake]
//     Writes the repository root's wasm/dist/emu.wasm, the one module
//     puck's own emulator loads - exactly the contract every other pack's
//     build.ts satisfies (docs/convention/device-pack.md). This is what
//     makes a web-pack module replayable by harness/portdiff.ts and
//     checkable by bun run verify-bundle, with no special case anywhere in
//     the verifier: the verifier resolves <pack>/wasm/build.ts from
//     registry.json and passes --app, and this pack answers like any other.
//
//   HOST MODE (--host)
//     bun run packs/web/wasm/build.ts --app <file> --host --out <dir>
//     Writes <dir>/index.html, host.<hash>.js, emu.<hash>.wasm, sw.js,
//     manifest.webmanifest and two icons: the app, deployable as static
//     files, installable, and offline once installed. This is the mode
//     that makes "the browser is a target device" literal rather than a
//     metaphor - the output is the shipped thing, not a preview of one.
//
// THE --app CONTRACT IS THE SIBLING PACK'S, deliberately unchanged
// (packs/rp2350-touch-amoled-18/wasm/build.ts): a port file defines two
// plain functions, `void port_enter(void)` and
// `void port_tick(const app_frame_t *f)`, and this script generates the
// app_t around them, with --landscape/--shake setting the two fields that
// vary per port. Adopting the contract verbatim is the whole point of this
// pack: apps/fluidbox/ports/web/fluid.c is a byte-for-byte copy of the
// rp2350 port's, and it only compiles here because nothing about this
// interface was improved.
//
// --device <path/to/device.json> COMPILES THIS PACK AGAINST ANOTHER DEVICE.
// The panel size, the button roster and the sensor roster stop being this
// pack's own and become whatever that file declares, including a silhouette
// pack's (docs/convention/device-pack.md's "Silhouette packs"): one
// generated header, handed to the compiler with -include, carries PANEL_W/
// PANEL_H, the two button indices, the two sensor indices and the whole
// emu_device() head as one string. Nothing else in the pack changes and no
// chrome code is written anywhere: host/host.ts already builds its panel
// and its ghost buttons from emu_device() at runtime, so a module compiled
// this way describes itself and the page follows. That is the entire
// mechanism behind "the app really runs on a device with no firmware".
//
// CACHE BUSTING IS A CONTENT HASH, everywhere, in host mode: emu.wasm and
// host.js carry the first 10 hex of their own sha256 in their filenames,
// and sw.js's cache name is derived from both. Two consecutive builds of
// unchanged sources therefore emit byte-identical output (site/build.ts's
// own idempotency contract depends on this), while any real change moves
// every URL a browser could have cached. See gotchas.md for the Safari
// failure this exists to close.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { iconPng, iconSvg } from "../host/icon";
import { runZigCc, ZIG_EXE } from "../../../tools/zigSpawn";

const WASM_DIR = import.meta.dir; // packs/web/wasm
const PACK_ROOT = resolve(WASM_DIR, ".."); // packs/web
const REPO_ROOT = resolve(PACK_ROOT, "..", ".."); // the puck repo root
const RUNTIME = join(PACK_ROOT, "runtime");
const HOST_DIR = join(PACK_ROOT, "host");

// The one module puck's own emulator loads (see the root README and
// server.ts). Writing here rather than into a pack-local dist/ is what
// makes `build && bun run dev` show this pack with no wiring step.
const MODULE_OUT = join(REPO_ROOT, "wasm", "dist", "emu.wasm");

// The ABI header is the emulator's, at the repo root: one copy, so a pack
// cannot compile against a stale private fork of the contract.
const ABI_DIR = join(REPO_ROOT, "wasm");

// zig is a binary this script invokes, never a language anything here is
// authored in. No machine-specific default: it comes off PATH unless
// ZIG_EXE says otherwise, the same as both sibling packs.

// Every symbol wasm/emu_abi.h declares that this pack implements.
// Exported explicitly rather than derived by parsing the header, so a
// symbol added there and forgotten here fails loudly (an undefined-export
// link error) instead of silently missing from the module the host
// expects. The sound and tunables exports are absent on purpose: this pack
// declares neither (see wasm/emu_shim.c's header), and both are optional
// on the host side (src/wasm.ts guards every call).
const EMU_EXPORTS = [
  "emu_device",
  "emu_init",
  "emu_tick",
  "emu_fb",
  "emu_push_count",
  "emu_push_x",
  "emu_push_y",
  "emu_push_w",
  "emu_push_h",
  "emu_touch",
  "emu_button",
  "emu_button_verdict",
  "emu_sensor_event",
  "emu_sensor_vector",
  "emu_app_current",
  "emu_app_switch",
];

interface Args {
  appPath: string | null;
  landscape: boolean;
  shake: boolean;
  host: boolean;
  outDir: string | null;
  title: string | null;
  gallery: string;
  devicePath: string | null;
  // The silhouette's folder name, when --device pointed inside one (or
  // --silhouette named one). Only used to name the default output
  // directory; the build itself reads nothing but the device.json.
  deviceLabel: string | null;
}

function parseArgs(argv: string[]): Args {
  const valueOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v) {
      console.error(`${flag} needs an argument (see this file's header comment)`);
      process.exit(1);
    }
    return v;
  };
  const app = valueOf("--app");
  const out = valueOf("--out");
  // --silhouette <name> is --device packs/silhouettes/<name>/device.json,
  // spelled the way somebody actually thinks about it. Both land on the
  // same one field below.
  const silhouette = valueOf("--silhouette");
  const device = valueOf("--device");
  const devicePath = silhouette
    ? join(REPO_ROOT, "packs", "silhouettes", silhouette, "device.json")
    : device
      ? resolve(process.cwd(), device)
      : null;
  return {
    appPath: app ? resolve(process.cwd(), app) : null,
    landscape: argv.includes("--landscape"),
    shake: argv.includes("--shake"),
    host: argv.includes("--host"),
    outDir: out ? resolve(process.cwd(), out) : null,
    title: valueOf("--title"),
    gallery: valueOf("--gallery") ?? "../../",
    devicePath,
    deviceLabel: silhouette ?? (devicePath ? basename(resolve(devicePath, "..")) : null),
  };
}

const ARGS = parseArgs(process.argv.slice(2));

// The app's own name: the --app file's stem, or "demo" for the pack's own
// reference build. Used for the app_t's name (which reaches emu_device()'s
// "apps" array and therefore the emulator's app strip), the page title and
// the manifest.
const APP_NAME = ARGS.appPath ? basename(ARGS.appPath).replace(/\.c$/, "") : "demo";
const TITLE = ARGS.title ?? APP_NAME;

// ---- the generated roster (only for --app) -------------------------------
// runtime/runtime_core.c declares exactly one app slot, `extern const app_t
// g_webApp`, and never changes for a port (it is pack firmware,
// docs/convention/device-pack.md). A port file supplies port_enter/
// port_tick; this is the app_t built around them. Written to an OS temp
// directory for one build and deleted afterwards, so it is never mistaken
// for a source this repository tracks.
let generatedRosterDir: string | null = null;

function generateRoster(): string {
  // Reused rather than recreated: a --device build already opened this
  // directory for its generated header, and two temp directories would
  // leave one of them behind and break the -ffile-prefix-map below.
  if (!generatedRosterDir) generatedRosterDir = mkdtempSync(join(tmpdir(), "puck-web-roster-"));
  const rosterPath = join(generatedRosterDir, "roster.c");
  const source = `// GENERATED by packs/web/wasm/build.ts's --app flag. Not a pack firmware
// source: written to a temp file for one build and deleted afterwards.
#include <stdbool.h>
#include <stddef.h>
#include "app.h"

extern void port_enter(void);
extern void port_tick(const app_frame_t *f);

const app_t g_webApp = {
    .name       = "${APP_NAME}",
    .enter      = port_enter,
    .tick       = port_tick,
    .leave      = NULL,
    .landscape  = ${ARGS.landscape ? "true" : "false"},
    .wantsShake = ${ARGS.shake ? "true" : "false"},
};
`;
  writeFileSync(rosterPath, source, "utf8");
  return rosterPath;
}

function cleanupRoster(): void {
  if (generatedRosterDir) rmSync(generatedRosterDir, { recursive: true, force: true });
  generatedRosterDir = null;
}

// ---- the generated device header (only for --device) ---------------------
// One header, -include'd ahead of every translation unit, carrying the four
// things a device decides that this pack's C states as constants:
//
//   PANEL_W / PANEL_H     runtime/gfx.h's guarded defines (the framebuffer,
//                         every clip, and every app that reads them)
//   BTN_BOOT / BTN_PWR    wasm/emu_shim.c's guarded button indices: which
//                         declared button feeds the click signal and which
//                         feeds the key signal, or -1 for a device that
//                         declares neither
//   SENSOR_IDX_*          the same, for the shake event and the tilt vector
//   PUCK_DEVICE_JSON      emu_device()'s whole head, so the module hands
//                         the host the descriptor it was compiled against
//
// Written next to the roster, in the same temp directory, and deleted with
// it: a generated header this pack cannot tell apart from its own sources
// would be exactly the drift the guards exist to prevent.

interface DeviceButton {
  id: string;
  label: string;
  edge: string;
  at: number;
  role?: string;
  longPressMs?: number;
}
interface DeviceSensor {
  id: string;
  kind: string;
}
interface DeviceJson {
  name?: string;
  panel?: { w: number; h: number; format?: string };
  buttons?: DeviceButton[];
  sensors?: DeviceSensor[];
  [key: string]: unknown;
}

// Everything emu_device() states about the DEVICE, in one string, ending
// with the "apps":[ that emu_shim.c's own runtime loop over g_apps[] then
// fills. The blocks a device.json carries for a reader rather than for a
// firmware (convention, budget, provenance, memory) are dropped: a
// firmware could not have known them, so a descriptor that claimed them at
// runtime would be describing the pack file, not the device.
const NOT_IN_EMU_DEVICE = new Set(["convention", "budget", "provenance", "memory", "apps"]);

function deviceJsonHead(device: DeviceJson): string {
  const runtimeShape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(device)) {
    if (NOT_IN_EMU_DEVICE.has(key)) continue;
    runtimeShape[key] = value;
  }
  const serialized = JSON.stringify(runtimeShape);
  return `${serialized.slice(0, -1)},"apps":[`;
}

function cEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Which declared button carries a role, by index. -1 when none does, which
// is a real device answer (a one-button board cannot deliver both signals)
// and one emu_shim.c already handles: an index that matches nothing is
// ignored, exactly as it ignores a host bug.
function indexOfRole(buttons: DeviceButton[], role: string): number {
  return buttons.findIndex((b) => b.role === role);
}

function generateDeviceHeader(devicePath: string): string {
  if (!existsSync(devicePath)) {
    console.error(`--device: no device.json at ${devicePath}`);
    cleanupRoster();
    process.exit(1);
  }
  const device = JSON.parse(readFileSync(devicePath, "utf8")) as DeviceJson;
  if (!device.panel || !device.panel.w || !device.panel.h) {
    console.error(`--device: ${devicePath} declares no panel; there is nothing to compile against`);
    cleanupRoster();
    process.exit(1);
  }
  const buttons = device.buttons ?? [];
  const sensors = device.sensors ?? [];
  const keyIndex = indexOfRole(buttons, "key");
  if (keyIndex >= 0 && buttons[keyIndex]!.longPressMs === undefined) {
    // Stated by the convention, enforced here rather than discovered as
    // "the app never toggles": the host only emits a verdict for a button
    // that declares a threshold to time against, so a key with no
    // longPressMs delivers no KEY_SHORT at all.
    console.error(`--device: ${devicePath} declares button "${buttons[keyIndex]!.id}" as role key with no longPressMs, so it can never deliver a short-press verdict`);
    cleanupRoster();
    process.exit(1);
  }

  if (!generatedRosterDir) generatedRosterDir = mkdtempSync(join(tmpdir(), "puck-web-roster-"));
  const headerPath = join(generatedRosterDir, "puck_device.h");
  const source = `// GENERATED by packs/web/wasm/build.ts's --device flag, from
// ${devicePath.replace(/\\/g, "/")}
// Not a pack source: written to a temp file for one build and deleted
// afterwards. See that script's own header comment.
#ifndef PUCK_DEVICE_H
#define PUCK_DEVICE_H

#define PANEL_W ${device.panel.w}
#define PANEL_H ${device.panel.h}

#define BTN_BOOT ${indexOfRole(buttons, "click")}
#define BTN_PWR ${keyIndex}

#define SENSOR_IDX_SHAKE ${sensors.findIndex((s) => s.id === "shake" && s.kind === "event")}
#define SENSOR_IDX_TILT ${sensors.findIndex((s) => s.kind === "vector" || s.kind === "gravity")}

#define PUCK_DEVICE_JSON "${cEscape(deviceJsonHead(device))}"

#endif // PUCK_DEVICE_H
`;
  writeFileSync(headerPath, source, "utf8");
  console.log(`compiling against ${device.name ?? "(unnamed device)"}: ${device.panel.w}x${device.panel.h}, ${buttons.length} button(s), ${sensors.length} sensor(s)`);
  return headerPath;
}

// ---- compiling the module ------------------------------------------------

function compileModule(outPath: string): void {
  // Generated FIRST, before the roster and before any source is listed:
  // -include has to name a file that already exists, and this one also
  // decides the panel size every source below compiles against.
  const deviceHeader = ARGS.devicePath ? generateDeviceHeader(ARGS.devicePath) : null;

  const sources = [
    join(WASM_DIR, "emu_shim.c"),
    join(RUNTIME, "runtime_core.c"),
    join(RUNTIME, "gfx.c"),
    join(RUNTIME, "digits.c"),
    ...(ARGS.appPath ? [ARGS.appPath, generateRoster()] : [join(PACK_ROOT, "apps", "demo.c")]),
  ];

  // shim/ goes FIRST: it is what makes a real port source compile
  // unmodified (stdio.h/stdlib.h/math.h stand in for libc headers zig's
  // freestanding wasm32 target does not ship at all). runtime/ gives the
  // bare-filename includes a port already uses (app.h, gfx.h, sensors.h,
  // digits.h). dirname(--app) is added so a port living outside this pack
  // can include a private helper header of its own, the same allowance
  // both sibling packs give.
  const includes = [
    join(WASM_DIR, "shim"),
    RUNTIME,
    ABI_DIR, // emu_abi.h, included bare from emu_shim.c
    ...(ARGS.appPath ? [resolve(ARGS.appPath, "..")] : []),
  ];

  if (ZIG_EXE.includes("/") || ZIG_EXE.includes("\\")) {
    // An explicit path was given (ZIG_EXE): check it, so a typo fails here
    // rather than as an opaque spawn error. A bare "zig" is PATH-resolved
    // and cannot be checked this way.
    if (!existsSync(ZIG_EXE)) {
      console.error(`zig not found at ${ZIG_EXE} (set ZIG_EXE to override)`);
      cleanupRoster();
      process.exit(1);
    }
  }
  for (const src of sources) {
    if (!existsSync(src)) {
      console.error(`source not found: ${src}`);
      cleanupRoster();
      process.exit(1);
    }
  }
  mkdirSync(resolve(outPath, ".."), { recursive: true });

  const args = [
    "cc",
    "-target",
    "wasm32-freestanding",
    "-O2",
    // The roster lives in a unique temp directory so concurrent builds
    // cannot collide, but zig records that path in wasm debug metadata.
    // Map only that random prefix to a stable virtual path, so identical
    // sources emit byte-identical wasm across consecutive builds - which
    // is what this pack's content-hashed filenames and site/build.ts's own
    // idempotency check both depend on.
    ...(generatedRosterDir ? [`-ffile-prefix-map=${generatedRosterDir}=puck-web-roster`] : []),
    // The generated device header, ahead of every translation unit: the
    // guards in runtime/gfx.h and wasm/emu_shim.c are what it displaces,
    // and it has to displace them everywhere at once or the framebuffer
    // and the app would disagree about how wide the panel is.
    ...(deviceHeader ? ["-include", deviceHeader] : []),
    "-nostdlib",
    "-Wl,--no-entry",
    // Undefined externs (js_log, the math imports) become real wasm
    // imports instead of a hard link error. `-Wl,--allow-undefined` is
    // rejected outright by zig cc; this is the flag that works for this
    // target, found by the sibling pack the same way, by building.
    "-Wl,--import-symbols",
    ...EMU_EXPORTS.map((name) => `-Wl,--export=${name}`),
    ...includes.flatMap((dir) => ["-I", dir]),
    ...sources,
    "-o",
    outPath,
  ];

  console.log(`${ZIG_EXE} ${args.join(" ")}`);

  // zig cc crashes inside its own linker roughly one run in three with
  // this many -Wl,--export= flags: exit code 5, no diagnostic, and the
  // very next attempt with identical arguments succeeds. It is a compiler
  // bug, not anything wrong with the tree. Retried rather than merely
  // documented, because the person most likely to hit it is somebody
  // running this for the first time. The pause matters as much as the
  // retry: the failure rate is far worse under a concurrent build, so this
  // is contention, not a coin flip.
  //
  // THE TIMEOUT IS NOT DECORATION, and it is the one thing this loop has
  // that both sibling packs' loops do not. The same bug also HANGS, not
  // just crashes: observed twice on 2026-08-19, a zig process sitting at
  // 0.02 seconds of CPU for thirteen minutes on arguments that then
  // succeeded immediately on a manual retry. A retry loop that only
  // catches a non-zero exit waits forever for that one, which is a far
  // worse failure than a crash: a build that never returns looks like a
  // build that is working. Two minutes is many times the ~5s a real
  // compile of these five files takes, even under a saturated machine.
  // The retry/verdict mechanics live in tools/zigSpawn.ts now (one shared
  // implementation across every pack and every test build script - see
  // that file's header comment for the measurement this loop used to
  // guess at blind: piped stdio means a genuine compile error is captured
  // and reported immediately instead of retried, and the artifact at
  // outPath is checked directly rather than trusted to zig's own exit
  // code).
  const result = runZigCc(args, outPath, { isWasm: true });

  cleanupRoster();

  if (!result.ok) {
    console.error(
      result.stderr.trim().length > 0
        ? `zig cc failed (exit ${result.exitCode}), so this is a real build failure - see diagnostics above`
        : `zig cc exited ${result.exitCode} on all ${result.attempts} attempts with no diagnostic text and wrote nothing, so this is a real build failure`
    );
    process.exit(result.exitCode ?? 1);
  }
}

// ---- host mode -----------------------------------------------------------

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 10);
}

async function buildHost(outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. the module, named by its own content hash
  const stagedModule = join(outDir, "emu.wasm");
  compileModule(stagedModule);
  const moduleHash = hashOf(stagedModule);
  const moduleName = `emu.${moduleHash}.wasm`;
  copyFileSync(stagedModule, join(outDir, moduleName));
  rmSync(stagedModule);

  // 2. the host bundle, likewise
  const hostBuild = await Bun.build({
    entrypoints: [join(HOST_DIR, "host.ts")],
    outdir: outDir,
    naming: "host.js",
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!hostBuild.success) {
    for (const log of hostBuild.logs) console.error(log);
    throw new Error("packs/web/wasm/build.ts: failed to bundle host/host.ts");
  }
  const hostHash = hashOf(join(outDir, "host.js"));
  const hostName = `host.${hostHash}.js`;
  copyFileSync(join(outDir, "host.js"), join(outDir, hostName));
  rmSync(join(outDir, "host.js"));

  // 3. icons and manifest
  writeFileSync(join(outDir, "icon.svg"), iconSvg());
  writeFileSync(join(outDir, "icon-192.png"), iconPng(192));
  writeFileSync(join(outDir, "icon-512.png"), iconPng(512));
  const manifest = {
    name: `puck: ${TITLE}`,
    short_name: TITLE,
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "any",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  writeFileSync(join(outDir, "manifest.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 4. index.html, from the template next to host.ts
  const template = readFileSync(join(HOST_DIR, "index.html"), "utf8");
  const html = template
    .replaceAll("__TITLE__", `${TITLE}: puck on the web`)
    .replaceAll("__SHORT_TITLE__", TITLE)
    .replaceAll("__DESCRIPTION__", `${TITLE}, the real firmware compiled to WebAssembly, running on the browser as a target device.`)
    .replaceAll("__MODULE__", moduleName)
    // The same --landscape that set the app_t's own flag, forwarded to the
    // page so the host presents a landscape app landscape (host/host.ts's
    // Panel). One flag, one meaning, set once at build time.
    .replaceAll("__LANDSCAPE__", ARGS.landscape ? "1" : "0")
    .replaceAll("__HOST_JS__", hostName)
    .replaceAll("__MANIFEST__", "manifest.webmanifest")
    .replaceAll("__ICON_SVG__", "icon.svg")
    .replaceAll("__ICON_PNG__", "icon-192.png")
    .replaceAll("__GALLERY__", ARGS.gallery);
  writeFileSync(join(outDir, "index.html"), html);

  // 5. the service worker, its cache name derived from what it caches.
  // index.html is precached under BOTH "./" and "index.html": a visitor
  // who installed from the bare directory URL and one who bookmarked the
  // file name are the same app, and a worker that only knows one of them
  // is an app that works offline for half its users.
  const precache = ["./", "index.html", moduleName, hostName, "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
  const cacheVersion = createHash("sha256")
    .update(`${moduleHash}:${hostHash}:${hashOf(join(outDir, "index.html"))}`)
    .digest("hex")
    .slice(0, 10);
  const swBuild = await Bun.build({
    entrypoints: [join(HOST_DIR, "sw.ts")],
    outdir: outDir,
    naming: "sw.js",
    target: "browser",
    format: "esm",
    minify: false,
    define: {
      __CACHE_VERSION__: JSON.stringify(cacheVersion),
      __PRECACHE__: JSON.stringify(precache),
    },
  });
  if (!swBuild.success) {
    for (const log of swBuild.logs) console.error(log);
    throw new Error("packs/web/wasm/build.ts: failed to bundle host/sw.ts");
  }

  console.log(`built host -> ${outDir} (module ${moduleName}, host ${hostName}, cache puck-web-${cacheVersion})`);
}

// ---- run -----------------------------------------------------------------

if (ARGS.host) {
  // A --device build writes under dist/silhouettes/<device>/<app>/, its own
  // path, so nothing that already exists moves: site/build.ts's own
  // /web/<app>/ pages keep coming out of dist/<app>/ exactly as before.
  const outDir =
    ARGS.outDir ??
    (ARGS.devicePath && ARGS.deviceLabel
      ? join(PACK_ROOT, "dist", "silhouettes", ARGS.deviceLabel, APP_NAME)
      : join(PACK_ROOT, "dist", APP_NAME));
  await buildHost(outDir);
} else {
  compileModule(MODULE_OUT);
  console.log(`built ${MODULE_OUT} (${statSync(MODULE_OUT).size} bytes)`);
}
