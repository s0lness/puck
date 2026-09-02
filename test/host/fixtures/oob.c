/*
 * test/host/fixtures/oob.c: a NEGATIVE CONTROL, not a bug to fix. This
 * fixture is deliberately broken - a real out-of-bounds write on
 * emu_tick() - so that test/host/run.ts can prove harness/hostSide.ts's
 * native, sanitizer-instrumented build actually catches the compiler class
 * of defect wasm hides (docs/harness.md's "three marks": wasm32 is
 * memory-safe by construction, so THIS SAME C compiles clean and runs
 * clean forever on the emulator mark - see this file's own emu_tick(),
 * which never crashes when built to wasm). Never removed to "fix" the OOB
 * write: doing so would delete the thing this test is testing.
 *
 * See test/host/fixtures/clean.c for what a CORRECT version of this same
 * shape looks like, including the EMU_HOST_NATIVE accessors' own comment.
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

static int g_pushCount;

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = rgb565be(0xf5, 0xf1, 0xe8);
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_pushCount = 1;
    /* THE DELIBERATE BUG: g_fb has exactly PANEL_W*PANEL_H elements
     * (index 0..63); this writes five past the end. -fsanitize=array-
     * bounds (part of harness/hostSide.ts's default UBSan group)
     * instruments this subscript because g_fb's size is known at compile
     * time, and reports it naming this exact file and line - which is the
     * whole point of this fixture (see this file's header comment). */
    int oobIndex = PANEL_W * PANEL_H + 5;
    g_fb[oobIndex] = rgb565be(0xff, 0x00, 0x00);
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
    "{\"name\":\"puck-host-fixture-oob\","
    "\"panel\":{\"w\":8,\"h\":8,\"format\":\"rgb565be\"},"
    "\"buttons\":[],\"touch\":{\"points\":1},\"sensors\":[]}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }

#ifdef EMU_HOST_NATIVE
void *emu_fb_native(void) { return (void *)g_fb; }
const char *emu_device_json_native(void) { return g_deviceJson; }
#endif
