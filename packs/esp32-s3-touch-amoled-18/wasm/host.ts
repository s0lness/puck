// host.ts: what harness/hostSide.ts needs to build THIS pack's firmware as
// a native host executable instead of a wasm32-freestanding module. See
// packs/rp2350-touch-amoled-18/wasm/host.ts's header comment for the full
// reasoning shared by every pack's copy of this file. This pack's own
// build.ts already notes it "needs no shim/ directory at all" (no vendor
// headers, no libc headers), which makes this the simplest of the three:
// no roster generation either, since this pack's app slot is a single
// `extern const app_t g_demoApp` a port's .c file defines directly (see
// build.ts's own --app comment).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WASM_DIR = import.meta.dir; // packs/esp32-s3-touch-amoled-18/wasm
const DEVICE_ROOT = resolve(WASM_DIR, ".."); // packs/esp32-s3-touch-amoled-18/
const REPO_ROOT = resolve(DEVICE_ROOT, "..", ".."); // the puck repo root
const FIRMWARE = join(DEVICE_ROOT, "firmware");
const ABI_DIR = join(REPO_ROOT, "wasm");

// Mirrors wasm/build.ts's own EMU_EXPORTS. This pack's only export beyond
// the mandatory baseline (emu_device, emu_init, emu_tick, emu_fb,
// emu_push_*, emu_touch, emu_button, emu_button_verdict, emu_sensor_event)
// is the sample-stream sensor.
const OPTIONAL_EXPORTS = ["emu_accel_sample"];

export interface HostAppArgs {
  // No landscape/shake flags on this pack's build.ts (its app.h contract
  // has neither) - kept out of this interface rather than accepted and
  // silently ignored, per the "unimplemented means uncalled" spirit the
  // sibling packs' own optional exports already follow.
  appPath: string | null;
}

export interface HostBuildFiles {
  sources: string[];
  includes: string[];
  defines: string[];
  cleanup: () => void;
}

export function hostBuildFiles(args: HostAppArgs): HostBuildFiles {
  const appSource = args.appPath ?? join(FIRMWARE, "apps", "demo.c");

  const sources = [join(WASM_DIR, "emu_shim.c"), join(FIRMWARE, "runtime", "runtime_core.c"), join(FIRMWARE, "runtime", "gfx_band.c"), appSource];

  const includes = [dirname(appSource), join(FIRMWARE, "runtime"), join(FIRMWARE, "apps"), ABI_DIR];

  const defines = ["-DEMU_HOST_NATIVE=1", ...OPTIONAL_EXPORTS.map((name) => `-DEMU_HAS_${name.toUpperCase()}=1`)];

  for (const src of sources) {
    if (!existsSync(src)) throw new Error(`packs/esp32-s3-touch-amoled-18/wasm/host.ts: source not found: ${src}`);
  }

  return { sources, includes, defines, cleanup: () => {} };
}
