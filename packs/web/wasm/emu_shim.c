/*
 * emu_shim: everything the browser side needs that is NOT the app or the
 * runtime. Same four jobs the sibling pack's shim has
 * (packs/rp2350-touch-amoled-18/wasm/emu_shim.c, MIT, same repository),
 * and this file's STRUCTURE is deliberately its structure - same section
 * order, same ring shapes, same emu_device() string builder including its
 * apps-array dedup - so the two can be read side by side and the
 * differences are the only thing that stands out:
 *
 * 1. Implements wasm/emu_abi.h: the lifecycle (emu_init/emu_tick), the
 *    panel (emu_fb, the emu_push_* window recorder), input (emu_touch,
 *    emu_button[_verdict], emu_sensor_event, emu_sensor_vector) and
 *    emu_device()'s JSON.
 *
 * 2. Implements ../runtime/sensors.h in full, so runtime_core.c and every
 *    app get a real touch queue, real key bits, real BOOT state and a real
 *    shake counter, fed by the functions in (1). The browser supplies a
 *    touch digitizer, two on-screen buttons, an accelerometer and a clock;
 *    this file is where they become the four signals an app may read.
 *
 * 3. Stands in for the libc pieces a freestanding, -nostdlib wasm build
 *    does not get for free and that real port sources call anyway:
 *    printf() (a small local formatter, apps/chrono's reference source
 *    calls it) and malloc() (a bump allocator, for a port that includes
 *    <stdlib.h>; this pack's own runtime no longer needs one, since
 *    runtime/gfx.c's framebuffer is static). Neither is a wasm import.
 *
 * 4. Implements runtime/gfx.c's panel_push() seam, recording the pushed
 *    rectangle for the host to blit.
 *
 * WHAT IS NOT HERE, and is in the sibling: sound (this pack declares no
 * speaker; a browser has WebAudio, but adding a sound surface with no app
 * on this pack that makes a sound would be inventing an ABI to prove
 * nothing), and the live tunables panel (a sketchpad-specific knob
 * surface, and this pack ships no sketchpad).
 *
 * Depends on emu_abi.h, runtime_core.h, app.h, gfx.h, sensors.h and
 * freestanding headers only. This file is the "host" side, so unlike
 * runtime_core.c it is allowed to know it is running in wasm.
 */
#include "emu_abi.h"

#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "runtime_core.h"
#include "sensors.h"

/* ===========================================================================
 * What the module imports from the host (env.*). Exactly emu_abi.h's list:
 * js_log, plus the math functions declared extern in shim/math.h and left
 * undefined there on purpose (see wasm/build.ts). js_log is the only one
 * this file calls directly.
 * ======================================================================= */
extern void js_log(const char *ptr, int len);

static int str_len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

/* ===========================================================================
 * malloc: a static bump allocator, not a real one.
 *
 * The sibling needs this because its gfx_init() malloc's the framebuffer.
 * This pack's runtime/gfx.c does not (static array, see its header), so
 * nothing in the default build calls this at all. It is here anyway,
 * small, so a PORT that includes <stdlib.h> and allocates links instead
 * of failing with an undefined symbol from inside zig's linker - a
 * failure mode that reads as "the pack is broken", not as "your app
 * allocates". 64KB, matching the arena's own order of magnitude; a port
 * needing more than that on the chip would not fit APP_ARENA_BYTES either.
 * ======================================================================= */
#define HEAP_BYTES (64 * 1024)

static uint8_t g_heap[HEAP_BYTES] __attribute__((aligned(8)));
static size_t g_heapUsed = 0;

void *malloc(size_t size) {
    size_t aligned = (g_heapUsed + 7u) & ~(size_t)7u;
    if (size > HEAP_BYTES || aligned > HEAP_BYTES - size) {
        rt_log("FATAL: emu_shim malloc: bump heap exhausted");
        rt_halt();
        return NULL; // unreachable if rt_halt()'s contract is honoured
    }
    void *p = &g_heap[aligned];
    g_heapUsed = aligned + size;
    return p;
}

/* ===========================================================================
 * printf: a small, real (format-subset) implementation, not an import.
 *
 * Copied from the sibling's shim for the reason shim/stdio.h states:
 * adding env.printf would silently widen the ABI the JS side is written
 * against. Supports the specifiers this pack's compiled sources actually
 * use (%s, %d with an optional zero-padded width, %u, %c, %%), grepped
 * rather than guessed; anything else is copied through literally.
 * ======================================================================= */
static void out_char(char **p, char *end, char c) {
    if (*p < end) {
        **p = c;
        (*p)++;
    }
}

static void out_str(char **p, char *end, const char *s) {
    if (!s) s = "(null)";
    while (*s) out_char(p, end, *s++);
}

static void out_uint(char **p, char *end, unsigned long v, int width, bool zeroPad) {
    char tmp[24];
    int n = 0;
    if (v == 0) tmp[n++] = '0';
    while (v > 0) {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    for (int pad = width - n; pad > 0; pad--) out_char(p, end, zeroPad ? '0' : ' ');
    while (n > 0) out_char(p, end, tmp[--n]);
}

static void out_int(char **p, char *end, long v, int width, bool zeroPad) {
    if (v < 0) {
        out_char(p, end, '-');
        out_uint(p, end, (unsigned long)(-v), width > 0 ? width - 1 : 0, zeroPad);
    } else {
        out_uint(p, end, (unsigned long)v, width, zeroPad);
    }
}

int printf(const char *fmt, ...) {
    char buf[256];
    char *p = buf;
    char *end = buf + sizeof(buf) - 1;

    va_list ap;
    va_start(ap, fmt);
    for (const char *f = fmt; *f; f++) {
        if (*f != '%') {
            out_char(&p, end, *f);
            continue;
        }
        f++;
        bool zeroPad = false;
        if (*f == '0') {
            zeroPad = true;
            f++;
        }
        int width = 0;
        while (*f >= '0' && *f <= '9') {
            width = width * 10 + (*f - '0');
            f++;
        }
        bool isLong = false;
        if (*f == 'l') {
            isLong = true;
            f++;
        }
        switch (*f) {
            case 's':
                out_str(&p, end, va_arg(ap, const char *));
                break;
            case 'd':
                out_int(&p, end, isLong ? va_arg(ap, long) : (long)va_arg(ap, int), width, zeroPad);
                break;
            case 'u':
                out_uint(&p, end, isLong ? va_arg(ap, unsigned long) : (unsigned long)va_arg(ap, unsigned int), width, zeroPad);
                break;
            case 'c':
                out_char(&p, end, (char)va_arg(ap, int));
                break;
            case '%':
                out_char(&p, end, '%');
                break;
            case '\0':
                f--; // do not step past the terminator below
                break;
            default:
                out_char(&p, end, '%');
                out_char(&p, end, *f);
                break;
        }
    }
    va_end(ap);
    *p = '\0';
    rt_log(buf);
    return 0;
}

/* ===========================================================================
 * runtime_core.h's two host hooks.
 * ======================================================================= */

void rt_log(const char *msg) {
    js_log(msg, str_len(msg));
}

// Cannot literally hold forever the way a board can: a blocking loop
// inside one exported call would hang the tab, and wasm has no preemption
// to yield through. Logs, then traps the module outright via an illegal
// instruction, which the host sees as a thrown RuntimeError. Unreachable
// by any shipped app, so this divergence is never observed - but the
// framebuffer arena_overflow_trap() painted red is still sitting in
// memory when it fires, and the host's last blit already showed it.
void rt_halt(void) {
    rt_log("FATAL: rt_halt() - see the preceding log line for why");
    __builtin_trap();
}

/* ===========================================================================
 * The panel: runtime/gfx.c's panel_push() seam. Record the pushed
 * rectangle; the framebuffer itself already holds the pixels (emu_fb()),
 * so there is nothing to draw here.
 * ======================================================================= */
#define MAX_PUSHES 128

static int g_pushX[MAX_PUSHES];
static int g_pushY[MAX_PUSHES];
static int g_pushW[MAX_PUSHES];
static int g_pushH[MAX_PUSHES];
static int g_pushCount = 0;

void panel_push(int x, int y, int w, int h) {
    if (g_pushCount >= MAX_PUSHES) return; // drop, same policy the touch
                                            // ring below uses when full
    g_pushX[g_pushCount] = x;
    g_pushY[g_pushCount] = y;
    g_pushW[g_pushCount] = w;
    g_pushH[g_pushCount] = h;
    g_pushCount++;
}

/* ===========================================================================
 * sensors.h, in full. See this file's header comment, job (2).
 * ======================================================================= */

/* ---- touch: a small ring, fed by emu_touch(), drained by
 * sensors_touch_next(). A browser can deliver a burst of pointermove
 * events between two animation frames, which is exactly the case the ring
 * exists for. */
#define TOUCH_Q_CAP 16
static touch_sample_t g_touchQ[TOUCH_Q_CAP];
static uint32_t g_touchHead = 0, g_touchTail = 0;

// Cached from the most recent emu_tick(), so a queued sample carries the
// same timestamp the frame it lands in was ticked with.
static uint32_t g_nowMs = 0;

bool sensors_touch_next(touch_sample_t *out) {
    if (g_touchHead == g_touchTail) return false;
    *out = g_touchQ[g_touchHead];
    g_touchHead = (g_touchHead + 1) % TOUCH_Q_CAP;
    return true;
}

static void touch_q_push(uint8_t fingers, uint16_t x, uint16_t y) {
    uint32_t next = (g_touchTail + 1) % TOUCH_Q_CAP;
    if (next == g_touchHead) return; // full: drop, the host can send again
    g_touchQ[g_touchTail] = (touch_sample_t){ g_nowMs, fingers, x, y };
    g_touchTail = next;
}

static bool g_fingerDown = false;

void sensors_set_finger_down(bool down) {
    g_fingerDown = down;
}

/* ---- PWR key: bits latched the way the board's PMIC latches register
 * 0x49, fed by emu_button()/emu_button_verdict() for button index BTN_PWR.
 * sensors_key_take() is read-and-clear, once per tick, same contract. */
#define BTN_BOOT 0
#define BTN_PWR  1

static uint8_t g_keyEvent = 0;

uint8_t sensors_key_take(void) {
    uint8_t ev = g_keyEvent;
    g_keyEvent = 0;
    return ev;
}

/* ---- BOOT: level tracked directly, click derived on the release edge,
 * the same moment the board calls a click. No chip-select borrow to
 * protect and no 20Hz rate limit: an on-screen button costs nothing to
 * read. */
static bool g_bootLevel = false;
static bool g_bootClickedPending = false;

bool sensors_boot_clicked(void) {
    bool v = g_bootClickedPending;
    g_bootClickedPending = false;
    return v;
}

bool sensors_boot_down(void) {
    return g_bootLevel;
}

/* ---- tilt: a continuous gravity-direction reading, fed by
 * emu_sensor_vector() for the "tilt" sensor declared in emu_device()
 * below. Convention: x right, y down the panel, z into the screen, units
 * of g - wasm/emu_abi.h's emu_sensor_vector doc is the authoritative text
 * this must match, and host/host.ts is what maps a devicemotion event's
 * two different sign conventions onto it.
 *
 * Default (0, 0, 0) until the host sends a first vector: deliberately a
 * zero vector, not a unit one, because a magnitude of zero is what the
 * headless harness (which never drives a DOM, so never calls
 * emu_sensor_vector at all) reads, and every consumer's own near-zero
 * fallback (apps/fluidbox/ports/web/fluid.c's TILT_MIN_G, for instance)
 * recognises it and uses fixed straight-down gravity. That is what keeps
 * a trace recorded before this pack existed replaying identically here.
 *
 * sensors_tilt() below (../runtime/sensors.h's declaration) is what turns
 * this raw ABI vector into the app_tilt_t every port actually reads
 * (app_frame_t.tilt, ../runtime/app.h) - the same field name and shape as
 * the rp2350 sibling's, so a port written against one compiles against
 * the other unchanged (apps/fluidbox/ports/web/fluid.c is the proof: see
 * that port's own README, "Zero-diff"). There used to be a private,
 * non-ABI accessor here with the sibling's own private-accessor name,
 * which is gone now that both packs feed app_frame_t.tilt directly - see
 * the sibling's own wasm/emu_shim.c "orientation" section for the same
 * change on that side.
 * ======================================================================= */
static float g_tiltX = 0.0f, g_tiltY = 0.0f, g_tiltZ = 0.0f;

// Index into emu_device()'s "sensors" array below, which must stay in
// sync: 0 is "shake", 1 is "tilt". Any other index is a host bug; ignored
// rather than trapped, same policy emu_button() uses for a bad index.
#define SENSOR_IDX_SHAKE 0
#define SENSOR_IDX_TILT  1

void emu_sensor_vector(int index, float x, float y, float z) {
    if (index != SENSOR_IDX_TILT) return;
    g_tiltX = x;
    g_tiltY = y;
    g_tiltZ = z;
}

// ../runtime/sensors.h's sensors_tilt(): converts the raw ABI vector above
// into app_tilt_t. Only ONE conversion is needed, not tilt.c's whole
// filter-plus-axis-map pipeline: the ABI's own documented convention (x
// right, y down the panel, units of g - wasm/emu_abi.h's emu_sensor_vector
// doc) already matches app_tilt_t's x/y exactly (app.h: "+x is the
// direction its x grows (right), +y the direction its y grows (down the
// screen)"), so no swap is needed there, the way the sibling's real
// QMI8658 mounting needs one (tilt.c's device_to_panel(), a correction for
// THAT chip's physical orientation on THAT board - this pack has no chip
// to be mounted at all). The one real difference is z: the ABI documents
// SPECIFIC FORCE (flat, screen up, reads ~(0,0,-1) - the reaction pushing
// back through the glass), while app_tilt_t documents GRAVITY'S OWN
// direction (flat, screen up, is (0,0,1) - gravity pulls INTO the glass).
// That is the same "accelerometer-vs-gravity flip" tilt.c's own header
// comment names, and it lives in exactly one place here too: negate z on
// the way in, nowhere else.
//
// No filtering, no up-edge hysteresis, no magnitude trust gate: this
// pack's incoming vector is already low-pass filtered upstream, in JS
// (src/motion.ts's PhoneMotion, FILTER_TAU_MS), before it ever reaches
// emu_sensor_vector() - see sensors.h's own comment on why that is enough
// and tilt.c's heavier machinery (a raw, unfiltered accelerometer sample
// arriving at 200Hz+ with real shake/drop noise on it) does not apply to a
// signal a browser already smoothed.
void sensors_tilt(app_tilt_t *out) {
    const float gx = g_tiltX;
    const float gy = g_tiltY;
    const float gz = -g_tiltZ;

    out->gx = gx;
    out->gy = gy;
    out->gz = gz;

    const float inPlane = sqrtf(gx * gx + gy * gy);
    out->tiltDeg = atan2f(inPlane, gz) * 57.29577951308232f;

    // Simplified up-edge decision: instantaneous, no hysteresis band (see
    // this function's own header comment on why tilt.c's fuller machinery
    // is not carried over). Holds the LAST decision only while there is
    // truly nothing to go on (in-plane gravity ~0g), the same "do not
    // flicker while flat" intent as the sibling's, just without the
    // dominance band around the diagonals.
    static uint8_t s_up = TILT_UP_TOP;
    if (inPlane >= 0.35f) {
        s_up = (fabsf(gy) >= fabsf(gx))
            ? ((gy > 0.0f) ? TILT_UP_TOP : TILT_UP_BOTTOM)
            : ((gx > 0.0f) ? TILT_UP_LEFT : TILT_UP_RIGHT);
    }
    out->up = s_up;

    out->valid = true;   // always some reading, even if it is the zero
                          // default - see this section's own header comment
    out->coasting = false; // no trust gate on this pack - see app_tilt_t's
                            // own comment in app.h
}

/* ---- shake: one monotonic counter, bumped by emu_sensor_event() for the
 * declared "shake" sensor, suppressed while a finger is down - the same
 * rule sensors.h documents. The host decides when a shake happened (it is
 * the only side that sees the accelerometer); this file only enforces the
 * same gate the board does. */
static uint32_t g_eraseSeq = 0;

uint32_t sensors_erase_seq(void) {
    return g_eraseSeq;
}

/* ===========================================================================
 * emu_abi.h
 * ======================================================================= */

int emu_init(void) {
    if (!gfx_init()) {
        rt_log("FATAL: emu_init: gfx_init() failed");
        return 0;
    }
    rtcore_init();
    return 1;
}

void emu_tick(uint32_t nowMs) {
    g_nowMs = nowMs;
    g_pushCount = 0;
    rtcore_tick(nowMs);
}

int emu_fb(void) {
    return (int)(intptr_t)gfx_fb;
}

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { return g_pushX[i]; }
int emu_push_y(int i) { return g_pushY[i]; }
int emu_push_w(int i) { return g_pushW[i]; }
int emu_push_h(int i) { return g_pushH[i]; }

void emu_touch(int down, int x, int y) {
    touch_q_push(down ? 1 : 0, (uint16_t)x, (uint16_t)y);
}

void emu_button(int index, int down) {
    if (index == BTN_BOOT) {
        bool wasDown = g_bootLevel;
        g_bootLevel = (down != 0);
        if (wasDown && !g_bootLevel) g_bootClickedPending = true; // click on release
    } else if (index == BTN_PWR) {
        if (down) g_keyEvent |= KEY_PRESS;
        else g_keyEvent |= KEY_RELEASE;
    }
    // Any other index: emu_device() declares two buttons, so this is a
    // host bug; ignored rather than trapped.
}

void emu_button_verdict(int index, int isLong) {
    // Only PWR declares longPressMs in emu_device(), so this is the only
    // index the host should ever call this for (emu_abi.h).
    if (index == BTN_PWR) {
        g_keyEvent |= isLong ? KEY_LONG : KEY_SHORT;
    }
}

void emu_sensor_event(int index) {
    if (index != SENSOR_IDX_SHAKE) return;
    if (!g_fingerDown) g_eraseSeq++;
}

int emu_app_current(void) {
    return app_current();
}

void emu_app_switch(int index) {
    app_switch_to(index);
}

/* ---- emu_device(): built from what this "device" actually is.
 *
 * The panel matches the AMOLED siblings exactly (368x448 rgb565be) so a
 * faithful port EXISTS at all: a browser could have declared any panel
 * size it liked, and declaring a different one would have made every
 * cross-pack pixel diff meaningless. The buttons carry the siblings' ids
 * and longPressMs so a recorded trace's button index 1 still means PWR
 * here. App names come from g_apps[]/g_appCount (app.h), not hardcoded.
 */
static char g_deviceJson[512];

static char *json_append(char *p, const char *s) {
    while (*s) *p++ = *s++;
    return p;
}

// Plain char-by-char equality, not strcmp: this target is freestanding and
// carries no libc, so a comparison this small is a loop, not an import.
static int str_eq(const char *a, const char *b) {
    while (*a && *b) {
        if (*a != *b) return 0;
        a++;
        b++;
    }
    return *a == *b;
}

int emu_device(void) {
    char *p = g_deviceJson;
    p = json_append(p, "{\"name\":\"Web-Touch\",");
    p = json_append(p, "\"panel\":{\"w\":368,\"h\":448,\"format\":\"rgb565be\"},");
    p = json_append(p, "\"buttons\":[");
    p = json_append(p, "{\"id\":\"boot\",\"label\":\"BOOT\",\"edge\":\"right\",\"at\":0.38},");
    p = json_append(p, "{\"id\":\"pwr\",\"label\":\"PWR\",\"edge\":\"right\",\"at\":0.62,\"longPressMs\":1500}");
    p = json_append(p, "],");
    p = json_append(p, "\"touch\":{\"points\":1},");
    p = json_append(p, "\"sensors\":[{\"id\":\"shake\",\"kind\":\"event\"},");
    p = json_append(p, "{\"id\":\"tilt\",\"kind\":\"vector\"}],");
    p = json_append(p, "\"apps\":[");
    // Deduplicated by name, kept from the sibling's shim even though this
    // pack's table holds exactly one app: the loop is the sibling's, and
    // a table that grows past one slot here should not have to rediscover
    // that two identical names in a picker are nonsense.
    int wroteApp = 0;
    for (int i = 0; i < g_appCount; i++) {
        int dup = 0;
        for (int j = 0; j < i; j++) {
            if (str_eq(g_apps[j]->name, g_apps[i]->name)) { dup = 1; break; }
        }
        if (dup) continue;
        if (wroteApp) p = json_append(p, ",");
        wroteApp = 1;
        p = json_append(p, "\"");
        p = json_append(p, g_apps[i]->name);
        p = json_append(p, "\"");
    }
    p = json_append(p, "]");
    // No "gestures": the sibling declares the BOOT+PWR menu chord because
    // its runtime recognises one. This runtime recognises none (see
    // runtime/runtime_core.h), and declaring a gesture nothing implements
    // would be exactly the kind of claim emu_abi.h tells a firmware not to
    // make.
    p = json_append(p, "}");
    *p = '\0';
    return (int)(intptr_t)g_deviceJson;
}

/* EMU_HOST_NATIVE: see packs/rp2350-touch-amoled-18/wasm/emu_shim.c's own
 * copy of this comment for the full reasoning (emu_fb()/emu_device() truncate
 * a pointer to `int` for wasm32's benefit; a native host's static/heap data
 * commonly sits above 4GB, so harness/host/driver.c needs a full-width
 * accessor instead). Dead code for the real wasm build: wasm/build.ts never
 * defines EMU_HOST_NATIVE. */
#ifdef EMU_HOST_NATIVE
void *emu_fb_native(void) {
    return (void *)gfx_fb;
}
const char *emu_device_json_native(void) {
    return g_deviceJson;
}
#endif
