/*
 * test/host/fixtures/clean.c: the negative control's control - a tiny,
 * correct firmware implementing exactly wasm/emu_abi.h's minimum (same
 * shape as example/firmware/main.c, smaller still: an 8x8 panel, one
 * flat-fill tick, no input handling at all - nothing here is meant to be
 * interesting, only CORRECT). test/host/run.ts builds this to wasm AND to
 * a native sanitized executable and asserts the two MATCH pixel-for-pixel:
 * proof that a firmware with no bug in it produces the SAME clean result
 * on both the emulator mark and the host mark, before this test suite ever
 * trusts a SANITIZER verdict from oob.c or overflow.c to mean anything.
 *
 * EMU_HOST_NATIVE accessors at the bottom: see
 * packs/rp2350-touch-amoled-18/wasm/emu_shim.c's own copy of this comment
 * for why a native host build needs full-width pointer accessors
 * alongside emu_fb()/emu_device()'s wasm-safe truncated ones.
 */
#include "emu_abi.h"

#include <stdint.h>

extern void js_log(const char *ptr, int len);

#define PANEL_W 8
#define PANEL_H 8

static uint16_t g_fb[PANEL_W * PANEL_H];

static uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)((v >> 8) | (v << 8));
}

static int g_pushX, g_pushY, g_pushW, g_pushH, g_pushCount;

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = rgb565be(0xf5, 0xf1, 0xe8);
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_pushCount = 1;
    g_pushX = 0;
    g_pushY = 0;
    g_pushW = PANEL_W;
    g_pushH = PANEL_H;
    /* One deterministic, correct write: paint the top-left pixel a fixed
     * ink color every tick. Nothing input-dependent, nothing
     * time-dependent - the point of this fixture is having NOTHING for a
     * sanitizer to legitimately object to. */
    g_fb[0] = rgb565be(0x20, 0x20, 0x20);
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }
int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { (void)i; return g_pushX; }
int emu_push_y(int i) { (void)i; return g_pushY; }
int emu_push_w(int i) { (void)i; return g_pushW; }
int emu_push_h(int i) { (void)i; return g_pushH; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"puck-host-fixture-clean\","
    "\"panel\":{\"w\":8,\"h\":8,\"format\":\"rgb565be\"},"
    "\"buttons\":[],\"touch\":{\"points\":1},\"sensors\":[]}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }

#ifdef EMU_HOST_NATIVE
void *emu_fb_native(void) { return (void *)g_fb; }
const char *emu_device_json_native(void) { return g_deviceJson; }
#endif
