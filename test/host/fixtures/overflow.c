/*
 * test/host/fixtures/overflow.c: a NEGATIVE CONTROL, not a bug to fix -
 * see test/host/fixtures/oob.c's header comment for the full reasoning
 * (this repository's own docs/harness.md "three marks" argument). This
 * fixture's deliberate defect is a signed integer overflow on
 * emu_tick(), which wraps silently in wasm's own (also UB-but-unchecked)
 * i32 arithmetic and would run clean forever on the emulator mark alone.
 *
 * See test/host/fixtures/clean.c for the correct version of this shape.
 */
#include "emu_abi.h"

#include <stdint.h>
#include <limits.h>

extern void js_log(const char *ptr, int len);

#define PANEL_W 8
#define PANEL_H 8

static uint16_t g_fb[PANEL_W * PANEL_H];

static uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)((v >> 8) | (v << 8));
}

static int g_pushCount;

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = rgb565be(0xf5, 0xf1, 0xe8);
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_pushCount = 1;
    /* THE DELIBERATE BUG: INT_MAX + 1 is signed overflow, undefined
     * behaviour in C. -fsanitize=signed-integer-overflow (part of
     * harness/hostSide.ts's default UBSan group) traps this at runtime
     * and reports it naming this exact file and line - the whole point of
     * this fixture (see this file's header comment). */
    int x = INT_MAX;
    x = x + 1;
    g_fb[0] = (uint16_t)x;
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }
int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { (void)i; return 0; }
int emu_push_y(int i) { (void)i; return 0; }
int emu_push_w(int i) { (void)i; return PANEL_W; }
int emu_push_h(int i) { (void)i; return PANEL_H; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"puck-host-fixture-overflow\","
    "\"panel\":{\"w\":8,\"h\":8,\"format\":\"rgb565be\"},"
    "\"buttons\":[],\"touch\":{\"points\":1},\"sensors\":[]}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }

#ifdef EMU_HOST_NATIVE
void *emu_fb_native(void) { return (void *)g_fb; }
const char *emu_device_json_native(void) { return g_deviceJson; }
#endif
