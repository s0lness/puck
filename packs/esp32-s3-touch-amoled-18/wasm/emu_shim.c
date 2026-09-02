/*
 * emu_shim: the browser side of this pack, and nothing else. Three jobs,
 * mirroring the RP2350 sibling's own emu_shim.c (see its header comment for
 * the fuller argument):
 *
 * 1. Implements wasm/emu_abi.h: lifecycle (emu_init/emu_tick), the panel
 *    (emu_fb, the emu_push_* window recorder), input (emu_touch,
 *    emu_button[_verdict], emu_sensor_event) and emu_device()'s JSON.
 *
 * 2. Implements runtime_core.h's platform seam (rt_log, rt_halt,
 *    plat_acquire_band, plat_flush_band), fed by (1), so runtime_core.c and
 *    apps/demo.c run as the real, unmodified firmware - decision
 *    0003-emulator-runs-the-real-apps.md's argument, extended to this pack.
 *
 * 3. Owns a shadow framebuffer THAT DOES NOT EXIST ON THE REAL CHIP. See
 *    "the shadow framebuffer" below for why the emulator host needs one
 *    even though the whole point of this pack is that the board never keeps
 *    one.
 *
 * Depends on emu_abi.h, runtime_core.h, app.h and freestanding headers
 * only. No malloc, no libc, no printf: every buffer here is a plain static
 * array, same as example/firmware/main.c.
 */
#include "emu_abi.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"
#include "runtime_core.h"

/* ---- what this module imports from the host ------------------------------
 * Exactly emu_abi.h's js_log; this pack's C uses no math functions at all. */
extern void js_log(const char *ptr, int len);

static int str_len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

void rt_log(const char *msg) {
    js_log(msg, str_len(msg));
}

// No watchdog to feed and no way to block a call without hanging the tab
// (same reasoning the sibling's rt_halt() gives) - log, then trap the
// module via an illegal instruction, which WebAssembly.instantiate's caller
// sees as a thrown RuntimeError.
void rt_halt(void) {
    rt_log("FATAL: rt_halt() - see the preceding log line for why");
    __builtin_trap();
}

/* ===========================================================================
 * The shadow framebuffer. DOES NOT EXIST ON THE REAL CHIP - that is the
 * entire point of this pack (see AGENTS.md and app.h's header comment): the
 * board never holds more than two 20KB band buffers at once. The emulator
 * host, though, reads emu_fb() once and blits from it every frame (see
 * emu_abi.h and src/panel.ts), so SOMETHING in linear memory has to hold the
 * full 368x448 picture for the page to show, even though nothing on real
 * silicon ever does. plat_flush_band() below is what keeps it honest: it
 * copies each band into this buffer at the moment the real board would be
 * DMA'ing that same band out to the panel, never earlier, so a bug that only
 * shows up because a band was drawn out of order or skipped is exactly as
 * visible here as it would be on a real panel with persistence.
 * ======================================================================= */
static uint16_t g_fb[PANEL_W * PANEL_H];

// One reusable band buffer. The real board double-buffers so the CPU can
// draw band N+1 while band N is still in flight over QSPI (gotchas.md, "the
 // band DMA pipeline"); wasm has no DMA and nothing runs concurrently with
// emu_tick(), so a single buffer is enough - plat_flush_band() below copies
// out of it into g_fb synchronously, before draw_band() is ever asked to
// fill it again. This is a real, deliberate simplification, not an
// oversight: the double-buffering itself is a timing property (see
// emu_abi.h's "What is not real" section), and this emulator never claims
// to reproduce timing.
static uint16_t g_bandBuf[PANEL_W * BAND_ROWS];

uint16_t *plat_acquire_band(int band) {
    (void)band;
    return g_bandBuf;
}

/* ---- what the last tick pushed: one window per flushed band -------------- */
#define MAX_PUSHES BAND_COUNT

static int g_pushX[MAX_PUSHES];
static int g_pushY[MAX_PUSHES];
static int g_pushW[MAX_PUSHES];
static int g_pushH[MAX_PUSHES];
static int g_pushCount = 0;

void plat_flush_band(int band, const uint16_t *buf) {
    int y0 = band * BAND_ROWS;
    for (int row = 0; row < BAND_ROWS; row++) {
        for (int col = 0; col < PANEL_W; col++) {
            g_fb[(y0 + row) * PANEL_W + col] = buf[row * PANEL_W + col];
        }
    }
    if (g_pushCount < MAX_PUSHES) {
        g_pushX[g_pushCount] = 0;
        g_pushY[g_pushCount] = y0;
        g_pushW[g_pushCount] = PANEL_W;
        g_pushH[g_pushCount] = BAND_ROWS;
        g_pushCount++;
    }
}

/* ===========================================================================
 * emu_abi.h
 * ======================================================================= */

int emu_init(void) {
    rtcore_init();
    return 1;
}

void emu_tick(uint32_t nowMs) {
    g_pushCount = 0;
    rtcore_tick(nowMs);
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { return g_pushX[i]; }
int emu_push_y(int i) { return g_pushY[i]; }
int emu_push_w(int i) { return g_pushW[i]; }
int emu_push_h(int i) { return g_pushH[i]; }

void emu_touch(int down, int x, int y) {
    rtcore_set_touch(down, x, y);
}

void emu_button(int index, int down) {
    rtcore_set_button(index, down);
}

void emu_button_verdict(int index, int isLong) {
    rtcore_set_button_verdict(index, isLong);
}

void emu_sensor_event(int index) {
    rtcore_sensor_event(index);
}

// OPTIONAL (emu_abi.h). device.json declares one "kind": "stream" sensor
// ("accel", index 0 by construction - this pack has exactly one), so this
// is exported unconditionally rather than guarded on anything: an app that
// never drains app_accel_read() simply lets the ring fill and wrap (see
// runtime_core.c), the same "costs nothing to leave unread" property a
// real sensor's own overflow would have.
void emu_accel_sample(int index, uint32_t tMs, float ax, float ay, float az) {
    (void)index;
    rtcore_accel_sample(tMs, ax, ay, az);
}

/* ---- emu_device(): a fixed string is enough, same reasoning
 * example/firmware/main.c gives - nothing about this device's shape changes
 * at runtime (no "apps" array, no gestures, no tunables). MUST match
 * device.json's ABI-relevant fields (name/panel/buttons/touch/sensors) - see
 * this pack's AGENTS.md for the sync rule and why device.json also carries
 * "convention" and "memory", which are pack metadata, not part of the wire
 * ABI, and so do not appear here. */
static const char g_deviceJson[] =
    "{"
    "\"name\":\"ESP32-S3-Touch-AMOLED-1.8\","
    "\"panel\":{\"w\":368,\"h\":448,\"format\":\"rgb565be\"},"
    "\"buttons\":["
    "{\"id\":\"boot\",\"label\":\"BOOT\",\"edge\":\"right\",\"at\":0.38,\"role\":\"click\"},"
    "{\"id\":\"pwr\",\"label\":\"PWR\",\"edge\":\"right\",\"at\":0.62,\"role\":\"key\",\"longPressMs\":1500}"
    "],"
    "\"touch\":{\"points\":1},"
    "\"sensors\":["
    "{\"id\":\"shake\",\"kind\":\"event\"},"
    "{\"id\":\"accel\",\"kind\":\"stream\",\"rateHz\":200,\"unit\":\"g\"}"
    "]"
    "}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }

/* EMU_HOST_NATIVE: see packs/rp2350-touch-amoled-18/wasm/emu_shim.c's own
 * copy of this comment for the full reasoning (emu_fb()/emu_device() truncate
 * a pointer to `int` for wasm32's benefit; a native host's static/heap data
 * commonly sits above 4GB, so harness/host/driver.c needs a full-width
 * accessor instead). Dead code for the real wasm build: wasm/build.ts never
 * defines EMU_HOST_NATIVE. */
#ifdef EMU_HOST_NATIVE
void *emu_fb_native(void) {
    return (void *)g_fb;
}
const char *emu_device_json_native(void) {
    return g_deviceJson;
}
#endif
