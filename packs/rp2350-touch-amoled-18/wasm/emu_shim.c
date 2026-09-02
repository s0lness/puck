/*
 * emu_shim: everything the browser side of the emulator needs that is NOT
 * the real firmware. Three jobs, per docs/decisions/0003 and emu_abi.h:
 *
 * 1. Implements emu_abi.h - the lifecycle (emu_init/emu_tick), the panel
 *    (emu_fb, the emu_push_* window recorder), input (emu_touch,
 *    emu_button[_verdict], emu_sensor_event) and emu_device()'s JSON.
 *
 * 2. Implements sensors.h in full, so runtime_core.c and every app get a
 *    real touch queue, real key bits, real BOOT state and a real shake
 *    counter - fed by the functions in (1) - instead of talking to i2c1.
 *    This is the "browser supplies a touch controller, two buttons, and a
 *    clock" half of decision 0003's THE ONE IDEA.
 *
 * 3. Stands in for a few libc pieces the real firmware sources (gfx.c,
 *    apps/sketch.c and friends) call directly and that a freestanding,
 *    -nostdlib wasm build does not get for free: malloc() (a static bump
 *    allocator - see "malloc" below), printf() (a small local formatter -
 *    see "printf" below), and DEV_Delay_ms() (a no-op - see shim/DEV_Config.h).
 *    None of these are wasm imports; they are ordinary C compiled into this
 *    module, same as any other function here.
 *
 * 4. Implements sound.h (sound_play/sound_stop, called by apps/timer.c's
 *    alarm and apps/tiltball.c's capture) by synthesising into a fixed
 *    buffer with sound_synth_alarm_sample()/sound_synth_capture_sample() -
 *    the SAME functions firmware/runtime/sound.c calls for the real board -
 *    and exposing it through emu_abi.h's sound section for the host to play
 *    via WebAudio. See that section for why this is genuine synthesis, not a
 *    JavaScript reimplementation, and what does not carry over (the timbre).
 *
 * Depends on emu_abi.h, runtime_core.h, app.h, gfx.h, sensors.h, sound.h,
 * sound_synth.h and freestanding headers only - this file is the "host", so
 * unlike runtime_core.c it is allowed to know it is running in wasm.
 */
#include "emu_abi.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "runtime_core.h"
#include "sensors.h"
#include "sound.h"
#include "sound_synth.h"
#include "storage.h"
#include "tune_registry.h"

/* ===========================================================================
 * What the module imports from the host (env.*). Exactly emu_abi.h's list:
 * js_log, plus the eight math functions declared extern in shim/math.h and
 * left undefined here on purpose (see build.ts and shim/math.h's header
 * comment). js_log is the only one this file calls directly.
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
 * The task brief's own framing: "gfx_init() uses malloc. Freestanding wasm
 * has no malloc: provide one, or better, provide a trivial bump allocator
 * over a static array, since the only allocation in the whole program is one
 * 330KB framebuffer." Grepping firmware/runtime/gfx.c confirms that: exactly
 * one malloc() call site in the entire codebase, in gfx_init(), for
 * PANEL_W*PANEL_H*2 bytes, never freed. A bump allocator over a static array
 * is simpler than a real allocator, costs nothing this program does not
 * already pay (the framebuffer has to live somewhere in linear memory
 * either way), and there is no second caller for a free-list to ever matter
 * to. HEAP_BYTES has a little slack over the exact framebuffer size so a
 * future second allocation does not need this constant revisited under
 * pressure.
 * ======================================================================= */
#define HEAP_BYTES (368 * 448 * 2 + 4096)

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
 * See shim/stdio.h's header comment for why this exists at all (printf is
 * not in emu_abi.h's import list, and adding env.printf would silently
 * widen the ABI the JS side is written against). Supports exactly the
 * specifiers the firmware sources this build actually compiles use -
 * grepped, not guessed: %s, %d (with an optional zero-padded width, e.g.
 * timer.c's "%02d"), %lu (sketch.c's uint32_t timestamps, cast to unsigned
 * long at every call site), and %%. Anything else is copied through
 * literally (the leading %% and the following character), which is wrong
 * general-purpose printf behaviour but never fires here and is safer than
 * silently eating an unrecognised specifier's argument.
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
 * runtime_core.h's three host hooks. See its header comment for why each
 * exists: none of the three pico-sdk calls they replace (printf's stdio
 * lock, time_us_32(), watchdog_update()+sleep_ms()) exist for this target.
 * ======================================================================= */

void rt_log(const char *msg) {
    js_log(msg, str_len(msg));
}

// nowMs is cached from the most recent emu_tick() call (see below); a
// switch's cost reads as 0us within that same tick, which is honest given
// wasm has no microsecond clock of its own - see runtime_core.h.
static uint32_t g_nowMs = 0;

uint32_t rt_time_us(void) {
    return g_nowMs * 1000u;
}

// Cannot literally hold forever the way the board does (a blocking loop
// inside one exported call would hang the browser tab - wasm has no
// preemption to yield through). Logs, then traps the module outright via an
// illegal instruction, which WebAssembly.instantiate's caller sees as a
// thrown RuntimeError. See runtime_core.h: this path is unreachable by any
// of today's shipped apps on either target, so the divergence from the
// board's "hold on a red screen" behaviour is never actually observed.
void rt_halt(void) {
    rt_log("FATAL: rt_halt() - see the preceding log line for why");
    __builtin_trap();
}

// See runtime_core.h for why this hook exists. No real panel to dim in a
// browser tab, and emu_abi.h's exported surface has no "set brightness"
// call the JS chrome could act on even if this file forwarded one - adding
// one is outside what this change touches. A documented no-op, not a
// simulated fade: the DECISION logic that drives this call
// (runtime_core.c's PWR-hold gesture - whether and when the ramp runs,
// whether the chord suppresses it, whether release restores it) is still
// fully exercised here, through the rt_log() lines that logic already
// writes at the moments that matter. Only the VISUAL result of dimming is
// untested in the emulator, the same category of gap emu_abi.h already
// documents for timing and input-device defects.
void rt_set_brightness(uint8_t percent) {
    (void)percent;
}

/* ===========================================================================
 * The panel: AMOLED_1IN8_Display / AMOLED_1IN8_DisplayWindows, per
 * shim/AMOLED_1in8.h. Record the pushed rectangle; the framebuffer itself
 * already holds the pixels (see emu_fb()), so there is nothing to draw here.
 * ======================================================================= */
#define MAX_PUSHES 128

static int g_pushX[MAX_PUSHES];
static int g_pushY[MAX_PUSHES];
static int g_pushW[MAX_PUSHES];
static int g_pushH[MAX_PUSHES];
static int g_pushCount = 0;

static void record_push(int x, int y, int w, int h) {
    if (g_pushCount >= MAX_PUSHES) return; // drop, same policy the real
                                            // touch/inject rings use when full
    g_pushX[g_pushCount] = x;
    g_pushY[g_pushCount] = y;
    g_pushW[g_pushCount] = w;
    g_pushH[g_pushCount] = h;
    g_pushCount++;
}

void AMOLED_1IN8_Display(UWORD *Image) {
    (void)Image; // already gfx_fb; see emu_fb()
    record_push(0, 0, AMOLED_1IN8_WIDTH, AMOLED_1IN8_HEIGHT);
}

void AMOLED_1IN8_DisplayWindows(uint32_t Xstart, uint32_t Ystart, uint32_t Xend, uint32_t Yend, UWORD *Image) {
    (void)Image;
    // Xend/Yend are exclusive (gfx.c's own comment on this call), so the
    // pushed window is [Xstart, Xend) x [Ystart, Yend).
    record_push((int)Xstart, (int)Ystart, (int)(Xend - Xstart), (int)(Yend - Ystart));
}

/* ===========================================================================
 * sensors.h, in full. See this file's header comment, job (2).
 * ======================================================================= */

/* ---- touch: a small ring, fed by emu_touch(), drained by
 * sensors_touch_next() - the same shape as the board's core1->core0 ring,
 * just single-threaded, so no barrier is needed. */
#define TOUCH_Q_CAP 16
static touch_sample_t g_touchQ[TOUCH_Q_CAP];
static uint32_t g_touchHead = 0, g_touchTail = 0;

bool sensors_touch_next(touch_sample_t *out) {
    if (g_touchHead == g_touchTail) return false;
    *out = g_touchQ[g_touchHead];
    g_touchHead = (g_touchHead + 1) % TOUCH_Q_CAP;
    return true;
}

static void touch_q_push(uint8_t fingers, uint16_t x, uint16_t y) {
    uint32_t next = (g_touchTail + 1) % TOUCH_Q_CAP;
    if (next == g_touchHead) return; // full: drop, agent/host can send it again
    g_touchQ[g_touchTail] = (touch_sample_t){ g_nowMs, fingers, x, y };
    g_touchTail = next;
}

// Declared by sensors.h for the board's devlink test link; nothing in the
// wasm-compiled sources calls it (devlink stays board-only, see
// docs/decisions/0003), but it is implemented anyway for API completeness -
// it is, after all, just another way to feed the same queue emu_touch() does.
void sensors_inject_touch(uint8_t fingers, uint16_t x, uint16_t y) {
    touch_q_push(fingers, x, y);
}

static bool g_fingerDown = false;

void sensors_set_finger_down(bool down) {
    g_fingerDown = down;
}

/* ---- PWR key: bits latched like the real AXP2101 register 0x49 (see
 * sensors.h), fed by emu_button()/emu_button_verdict() for button index
 * BTN_PWR. sensors_key_take() is read-and-clear, once per tick, same
 * contract as the board.
 *
 * KEY_RELEASE is now delivered on the down==0 edge, matching hardware: the
 * board used to mask this bit out (pmic_poll_core1(), firmware/runtime/
 * sensors.c) and this file matched that by never OR-ing it in, per
 * emu_abi.h's "keeping the emulator honest" rule (the worked example in
 * that file's header comment is literally this bit). The board's mask
 * widened once a real consumer needed the release edge - runtime_core.c's
 * PWR-held-alone power-off gesture has to know when a hold ENDS - so this file
 * changes to match, same rule, opposite direction: the emulator must not be
 * MORE generous than hardware, and now hardware itself delivers this, so
 * withholding it here would make the emulator LESS capable than the board
 * it stands in for, which is just as dishonest the other way. */
#define BTN_BOOT 0
#define BTN_PWR  1

static uint8_t g_keyEvent = 0;

uint8_t sensors_key_take(void) {
    uint8_t ev = g_keyEvent;
    g_keyEvent = 0;
    return ev;
}

// Declared by sensors.h for the board's power-off gesture
// (runtime_core.c). Nothing in wasm has a PMIC to actually cut power on,
// so this is a no-op, kept for the same "implemented anyway for API
// completeness" reason sensors_inject_touch()/sensors_inject_erase() above
// are: the DECISION to call this is still fully exercised in the emulator
// (runtime_core.c's rt_log() line right before this call fires either
// way), only the physical effect is out of scope here, same category of
// gap emu_abi.h already documents for timing and input-device defects.
void sensors_request_poweroff(void) {
}

/* ---- BOOT: level tracked directly (no chip-select borrowing here - see
 * bootbtn.h on the board for what THAT costs; none of it applies to a
 * browser button), click derived on the release edge, same moment the
 * board calls a click. */
static bool g_bootLevel = false;
static bool g_bootClickedPending = false;
// Mirrors bootbtn.c's g_swallowNextClick: sensors_boot_consume_click() is
// called from runtime_core.c's chord handling WHILE BOOT is still held (the
// chord has just fired, BOOT has not been released yet), so a plain "clear
// whatever is pending now" would be a no-op here - the click this needs to
// swallow has not happened yet. Arming a flag that the NEXT release checks,
// same as the board, is what makes the order-of-calls work regardless of
// whether BOOT is currently up or down at the moment it is called.
static bool g_bootSwallowNextClick = false;

bool sensors_boot_clicked(void) {
    bool v = g_bootClickedPending;
    g_bootClickedPending = false;
    return v;
}

bool sensors_boot_down(void) {
    return g_bootLevel;
}

// No chip-select borrow to protect here (see sensors.h's comment on why this
// exists at all) - just arm the same one-shot swallow the board's
// bootbtn_consume_next_click() does.
void sensors_boot_consume_click(void) {
    g_bootSwallowNextClick = true;
}

/* ---- shake: one monotonic counter, bumped by emu_sensor_event() for the
 * declared "shake" sensor, suppressed while a finger is down - the same
 * rule sensors.h documents for the real IMU path, so a resting hand while
 * drawing cannot erase here either, even though nothing in wasm actually
 * measures acceleration; the host decides when a shake "happened" and this
 * file only enforces the same gate the board does. */
static uint32_t g_eraseSeq = 0;

uint32_t sensors_erase_seq(void) {
    return g_eraseSeq;
}

// Declared by sensors.h for devlink's ERASE command; not called from the
// wasm-compiled sources (see sensors_inject_touch()'s comment above), kept
// for the same completeness reason, wired to the identical counter
// emu_sensor_event() bumps.
void sensors_inject_erase(void) {
    if (!g_fingerDown) g_eraseSeq++;
}

/* ---- orientation: the host's gravity vector, fed through the board's own
 * filter -------------------------------------------------------------------
 *
 * emu_sensor_vector() (emu_abi.h) sets the pose; emu_tick() submits it to
 * tilt_submit_device_g() (firmware/runtime/tilt.h) every frame, and
 * runtime_core.c reads the published result exactly as it does on the
 * board. Nothing here filters, maps axes or decides which edge is up: all
 * three live in tilt.c, which is compiled into this module unmodified, so
 * the emulator's orientation is the board's orientation. That is the same
 * "same object code, not a reimplementation" argument decision 0003 makes
 * for graphics and app logic and emu_abi.h extends to sound.
 *
 * SUBMITTED EVERY TICK, not once per emu_sensor_vector() call, and this is
 * not busywork: the filter is a function of elapsed time (tilt.h), so a
 * pose set once and held has to keep arriving for the filtered value to
 * converge on it, exactly the way the real part keeps reporting the same
 * gravity while the puck lies still on a table. A host that sets a pose and
 * then ticks sees it settle over tilt.h's 150ms time constant, same as a
 * hand holding the board still.
 *
 * The default is chosen to PUBLISH (0, 0, 1): lying flat on a table, screen
 * up. Chosen as the NEUTRAL pose - no in-plane gravity, so a ball does not
 * roll and a bubble sits centred until the host actually tilts something -
 * and it is a real pose a real device is in most of the time, not an
 * invented one.
 *
 * THESE ARE DEVICE AXES, THE SAME AS A REAL IMU SAMPLE - not panel ones,
 * whatever an earlier version of this comment said. emu_sensor_vector()
 * hands its argument straight to tilt_submit_device_g(), exactly like
 * sensors.c's imu_poll_core1() hands it a raw QMI8658 reading, so
 * firmware/runtime/tilt.c's device_to_panel() runs on it for real here too
 * - that mapping was the identity when this comment was first written,
 * which made "device axes" and "panel axes" the same numbers by accident,
 * not by any contract this file promised. Now that device_to_panel() is a
 * real, measured mapping (tilt.c's own header comment has the arithmetic),
 * this default has to be device_to_panel()'s own inverse of (0,0,1), which
 * is why it reads (0, 0, -1) below rather than (0, 0, 1): device_to_panel()
 * is currently a 180-degree turn (swap X/Y, negate Z) and therefore its own
 * inverse, so this repeats that formula rather than a separate one. Every
 * consumer, app or host UI, reads the result through app_frame_t.tilt /
 * emu_tilt() below - the published, filtered, axis-mapped signal - never
 * this raw vector directly; there used to be a second, private accessor
 * for exactly that raw reading (apps/fluidbox's own port called it), and it
 * is gone now that app_frame_t.tilt carries the real thing on both targets.
 *
 * QUANTISED AND CLAMPED ON THE WAY IN, which is emu_abi.h's honesty rule
 * doing real work rather than being cited. The board's QMI8658 is left at
 * +-8 g by QMI8658_init(), giving acc_lsb_div = 4096 counts per g, i.e.
 * 0.244 mg (0.000244 g) per count (firmware/runtime/sensors.c's own
 * QMI8658_ACC_LSB_DIV comment derives exactly this). A host handing over
 * 1.00037 g is handing over a reading no register on this part can hold,
 * and an app tuned against it would be tuned against fiction. So the value
 * goes through the same round trip the hardware imposes: clamp to the
 * range, quantise to the LSB, convert back - before it ever reaches
 * tilt.c's filter, the same way a real out-of-range or off-grid sample
 * never reaches it on the board either.
 *
 * PRE-COMPENSATED FOR device_to_panel(), on x/y only, and this is NOT the
 * same thing as the quantisation above. device_to_panel() is a REAL,
 * MEASURED correction for how THIS ONE PART is physically soldered onto
 * THIS ONE BOARD (tilt.c's own header comment has the ritual and the
 * numbers); there is no chip here to be mounted at any orientation at all,
 * so nothing about a browser's tilt reading is naturally expressed in
 * "this part's silicon axes". Instead, docs/abi.md's emu_sensor_vector
 * convention - and every host-side caller of it (src/rotate.ts's
 * gravityForQuickDeg, src/motion.ts's composePhoneVector) - documents and
 * derives its (x, y) directly in PANEL space (x right, y down), the same
 * space app_tilt_t's own gx/gy already promise an app. Handed to
 * tilt_submit_device_g() unchanged, device_to_panel()'s swap (px=-dy,
 * py=dx) would silently rotate (and, since 2026-08-20, also mirror) that
 * promise - caught empirically (bun run verify:tilt failed after wiring
 * app_frame_t.tilt into fluid.c, gravity landing on the wrong panel edge)
 * before being understood, not guessed in advance. So x and y are
 * transformed here, ONE TIME, before quantisation, by solving
 * device_to_panel(dx,dy,dz)=(x,y,z) for (dx,dy): with py=dx unchanged,
 * dx=y still; with px=-dy now (tilt.c's 2026-08-20 horizontal-axis fix,
 * see its own header comment), -dy=x, so dy=-x - the negation on x is NEW
 * here, in lockstep with that fix, and is what keeps this round-trip
 * exact: device_to_panel() was self-inverse on a plain swap before that
 * fix (px=dy, py=dx), so back then dy=x needed no sign change; it is no
 * longer self-inverse now that px carries an extra minus sign, and this is
 * that minus sign, moved to the other side of the equation. z is NOT
 * touched here - the specific-force-to-gravity flip device_to_panel() also
 * performs (pz=-dz, unchanged by the 2026-08-20 fix) is not a chip-mounting
 * artifact, it is the same physics on every accelerometer regardless of
 * mounting, and docs/abi.md's own convention (flat, screen up, reads
 * ~(0,0,-1)) already assumes that flip still happens once, downstream, in
 * tilt.c - exactly where it happens for real hardware too.
 */
#define QMI8658_RANGE_G   8.0f
#define QMI8658_G_PER_LSB (1.0f / 4096.0f)

static float accel_as_hardware_would(float g) {
    if (g > QMI8658_RANGE_G) g = QMI8658_RANGE_G;
    if (g < -QMI8658_RANGE_G) g = -QMI8658_RANGE_G;
    float counts = g / QMI8658_G_PER_LSB;
    counts = (float)(int)(counts >= 0.0f ? counts + 0.5f : counts - 0.5f);
    return counts * QMI8658_G_PER_LSB;
}

// (0, 0, -1): x=y=0 needs no swap to stay (0,0), and z is untouched here
// either way - see this section's own header comment - so this is simply
// docs/abi.md's own "flat, screen up" example value, unchanged.
static float g_gravX = 0.0f, g_gravY = 0.0f, g_gravZ = -1.0f;

void emu_sensor_vector(int index, float x, float y, float z) {
    (void)index; // emu_device() declares exactly one vector sensor
                 // ("gravity"); a host passing another index is a host bug,
                 // ignored rather than trapped, same policy emu_button()
                 // uses for a bad button index.
    // x/y transformed on the way in (dx=y, dy=x): device_to_panel() is a
    // plain self-inverse swap again (px=dy, py=dx) since the silicon
    // verdict of 2026-08-20 REVERTED the earlier px=-dy change (Sylve's
    // hands on the real puck: vertical fine, horizontal inverted with the
    // negation). See tilt.c's device_to_panel() comment.
    g_gravX = accel_as_hardware_would(y);
    g_gravY = accel_as_hardware_would(x);
    g_gravZ = accel_as_hardware_would(z);
}

float emu_tilt(int field) {
    app_tilt_t t;
    rtcore_last_tilt(&t);
    switch (field) {
        case 0: return t.gx;
        case 1: return t.gy;
        case 2: return t.gz;
        case 3: return t.tiltDeg;
        case 4: return (float)t.up;
        case 5: return t.valid ? 1.0f : 0.0f;
        case 6: return t.coasting ? 1.0f : 0.0f;
        default: return 0.0f;
    }
}

/* ---- the wall clock: a stand-in RTC that STARTS OUT NOT KNOWING ---------
 *
 * The board's version reads a PCF85063ATL on i2c1 once at boot and reports
 * whether its OS flag says the oscillator ever stopped (sensors.h's wall
 * clock section). There is no such part behind a browser tab.
 *
 * So this starts `known = false`, which is emu_abi.h's honesty rule applied
 * to a chip instead of to a button: the alternative - quietly seeding this
 * from the host's own Date.now(), which the JS side could trivially pass in -
 * would hand the firmware a working, correct, battery-backed clock that this
 * "device" does not have, and an app could then be built and shipped having
 * never once been seen in the state a real puck comes up in after a flat
 * battery. That state is the whole reason `known` exists. Here it is the
 * DEFAULT, so it cannot be forgotten.
 *
 * Everything after that is real: sensors_set_clock() is the same call the
 * board's, reached the same way (an app deciding the owner just set the
 * time), and the time then runs off emu_tick()'s clock exactly as the board
 * runs it off time_us_64() from its own single RTC read.
 */
static bool     g_clockKnown = false;
static uint32_t g_clockSecOfDay = 0;
static uint32_t g_clockSampledMs = 0;

void sensors_clock(sensors_clock_t *out) {
    // No seqlock here, and none needed: the board's exists because core1
    // publishes what core0 reads (see sensors.c), and there is exactly one
    // thread in a wasm module.
    out->known = g_clockKnown;
    out->secOfDay = g_clockSecOfDay;
    out->sampledAtMs = g_clockSampledMs;
}

void sensors_set_clock(uint32_t secOfDay) {
    g_clockKnown = true;
    g_clockSecOfDay = secOfDay % 86400u;
    g_clockSampledMs = g_nowMs;
}

/* ---- diagnostics: always zero. Nothing in wasm has i2c timeouts or queue
 * drops to count; see emu_abi.h's "What is not real" section. */
void sensors_stats(sensors_stats_t *out) {
    out->touchReads = 0;
    out->touchTimeouts = 0;
    out->touchQueueDrops = 0;
    out->touchRecoveries = 0;
    out->imuTimeouts = 0;
    out->pmicTimeouts = 0;
    out->rtcWriteFails = 0; // no i2c1 write to fail; see sensors_set_clock() above
    out->poweroffCmds = 0; // no PMIC to send a real command to; see
                            // sensors_request_poweroff() above
    out->poweroffRegBefore = 0xFFFFFFFFu; // no register 0x10 to read back either
    out->poweroffRegAfter = 0xFFFFFFFFu;
}

// sensors_init()/sensors_start() are deliberately NOT implemented here:
// nothing in the wasm build calls them (they are main()'s, board-only, and
// main() is not compiled for this target - see build.ts's source list), and
// there is no i2c1 to bring up in a browser regardless.

/* ===========================================================================
 * storage.h, as an in-RAM stand-in. See that header's own "HONESTY
 * REQUIREMENT" comment before trusting anything about this. It exists so
 * that firmware/apps/dino.c (the only caller today) compiles and behaves
 * sensibly here - a fresh high score every time the page (re)loads, an
 * instant "save" - without pretending to exercise flash_safe_execute(), a
 * sector erase, or core1's lockout. Only the board answers those
 * questions; see docs/decisions/0011 and firmware/runtime/storage.c.
 * ======================================================================= */
// 10, not 4 or 6: DINO_HISCORE (1), the retired TABLES_CALIB (2), the
// retired TABLES_CALIB_LO/_HI (3, 4) and the live TABLES_CALIB10_LO/_MID/_HI
// (5, 6, 7) - same bump storage.c's own real-flash implementation took, for
// the same reason (storage.h).
#define EMU_STORAGE_MAX_KINDS 10
static uint8_t  s_storageKind[EMU_STORAGE_MAX_KINDS];
static uint32_t s_storageValue[EMU_STORAGE_MAX_KINDS];
static uint8_t  s_storageTag[EMU_STORAGE_MAX_KINDS];
static bool     s_storageHave[EMU_STORAGE_MAX_KINDS];
static int      s_storageCount = 0;

// Called from emu_init() (below), the emulator's one "boot" moment - see
// that function's own call to this.
void storage_init(void) {
    s_storageCount = 0;
}

bool storage_get_u32(uint8_t kind, uint32_t *outValue) {
    uint8_t tag;
    return storage_get_u32_tagged(kind, outValue, &tag);
}

bool storage_get_u32_tagged(uint8_t kind, uint32_t *outValue, uint8_t *outTag) {
    for (int i = 0; i < s_storageCount; i++) {
        if (s_storageKind[i] == kind) {
            if (!s_storageHave[i]) return false;
            *outValue = s_storageValue[i];
            *outTag = s_storageTag[i];
            return true;
        }
    }
    return false;
}

void storage_save_u32(uint8_t kind, uint32_t value) {
    storage_save_u32_tagged(kind, value, 0);
}

void storage_save_u32_tagged(uint8_t kind, uint32_t value, uint8_t tag) {
    for (int i = 0; i < s_storageCount; i++) {
        if (s_storageKind[i] == kind) {
            s_storageValue[i] = value;
            s_storageTag[i] = tag;
            s_storageHave[i] = true;
            return;
        }
    }
    if (s_storageCount >= EMU_STORAGE_MAX_KINDS) return;
    int i = s_storageCount++;
    s_storageKind[i] = kind;
    s_storageValue[i] = value;
    s_storageTag[i] = tag;
    s_storageHave[i] = true;
}

/* ===========================================================================
 * sound.h, in full. See this file's header comment, job (4), and
 * emu_abi.h's "sound" section for the ABI this feeds.
 *
 * PREVIEW LENGTH. Real playback has no fixed duration here - it lasts until
 * either the timer's own 30-second self-limit (timer.c's ALARM_MAX_MS, which
 * this file does not know about, deliberately: that is the app's self-limit,
 * not the sound service's, see sound.h) or a dismissal calls sound_stop().
 * The browser cannot know either in advance, so sound_play() just generates
 * a fixed, generous number of phrase repeats up front and hands the whole
 * thing over; sound_stop() (a real dismissal) tells the host to cut it off
 * early via emu_sound_stop_seq() rather than the module trying to predict
 * when that will happen. See emu_abi.h for why a browser can afford to
 * generate this much PCM up front where the board's own sound.c pointedly
 * cannot.
 * ======================================================================= */
#define SOUND_PREVIEW_PHRASES 5 // a few repeats of the chime's own ~1.5s
                                // phrase (sound_synth.c) - enough to judge
                                // the pacing without generating minutes of
                                // audio nobody asked for.
#define SOUND_PREVIEW_SECONDS 8 // >= SOUND_PREVIEW_PHRASES * the phrase
                                // period; sound_synth.c owns the exact
                                // period, so this is rounded up generously
                                // rather than importing that constant here.
#define SOUND_PREVIEW_FRAMES (SOUND_SYNTH_SAMPLE_RATE_HZ * SOUND_PREVIEW_SECONDS)

static int16_t s_soundBuf[SOUND_PREVIEW_FRAMES];
static uint32_t s_soundPlaySeq = 0;
static uint32_t s_soundStopSeq = 0;

void sound_play(sound_id_t id) {
    // Two sounds now (sound.h): the timer's repeating alarm phrase and the
    // tilt-a-ball's one-shot capture plunk. Dispatched the same way sound.c
    // (the board) does, from the SAME sound_synth_* functions - see this
    // file's header comment, job (4).
    for (int i = 0; i < SOUND_PREVIEW_FRAMES; i++) {
        float tSec = (float)i / (float)SOUND_SYNTH_SAMPLE_RATE_HZ;
        s_soundBuf[i] = (id == SOUND_ID_BALL_CAPTURE)
            ? sound_synth_capture_sample(tSec)
            : sound_synth_alarm_sample(tSec);
    }
    s_soundPlaySeq++;
}

void sound_stop(void) {
    s_soundStopSeq++;
}

// sound_init()/sound_poll() are deliberately NOT implemented here, the same
// reasoning sensors_init()/sensors_start() already use above: nothing in the
// wasm build calls them (they are runtime.c's, board-only - see build.ts's
// source list), and there is no ES8311/PIO/DMA to bring up or refill in a
// browser regardless.

/* ===========================================================================
 * emu_abi.h
 * ======================================================================= */

int emu_init(void) {
    if (!gfx_init()) {
        rt_log("FATAL: emu_init: gfx_init() failed");
        return 0;
    }
    storage_init(); // the emulator's one "boot" moment - see storage.h's
                     // stand-in above; board order is storage_init() before
                     // sensors_start(), which has no equivalent here, so this
                     // just resets the in-RAM stand-in fresh every load.
    rtcore_init();
    return 1;
}

void emu_tick(uint32_t nowMs) {
    g_nowMs = nowMs;
    g_pushCount = 0;
    // Before rtcore_tick(), so this frame's app sees this frame's pose
    // rather than the previous one's: on the board core1 is publishing
    // continuously and asynchronously, so "the sample is already there when
    // core0 looks" is what the app actually experiences.
    tilt_submit_device_g(g_gravX, g_gravY, g_gravZ, nowMs);
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
        if (wasDown && !g_bootLevel) { // click on release
            if (g_bootSwallowNextClick) {
                g_bootSwallowNextClick = false;
            } else {
                g_bootClickedPending = true;
            }
        }
    } else if (index == BTN_PWR) {
        // Both edges now, matching the board's widened mask (see this
        // file's PWR key section above).
        if (down) g_keyEvent |= KEY_PRESS;
        else g_keyEvent |= KEY_RELEASE;
    }
    // Any other index: emu_device() only ever declares two buttons, so this
    // would be a host bug; ignored rather than trapped, same policy
    // devlink_hook_app_switch() uses for a bad index on the board.
}

void emu_button_verdict(int index, int isLong) {
    // Only PWR declares longPressMs in emu_device(), so this is the only
    // index the host should ever call this for (see emu_abi.h).
    if (index == BTN_PWR) {
        g_keyEvent |= isLong ? KEY_LONG : KEY_SHORT;
    }
}

/* ---- the declared sensors, by index into emu_device()'s "sensors" array.
 * There are two now ("shake" at 0, "gravity" at 1 - emu_shim's emu_device()
 * below), so emu_sensor_event() can no longer ignore its argument: a host
 * that fires sensor 1 must not bump the shake counter. emu_sensor_vector()
 * above does not need to switch on the index at all, since it declares only
 * one continuous sensor. */
#define SENSOR_SHAKE 0

void emu_sensor_event(int index) {
    if (index != SENSOR_SHAKE) return; // "gravity" is continuous, not an event
    if (!g_fingerDown) g_eraseSeq++;
}

int emu_app_current(void) {
    return app_current();
}

void emu_app_switch(int index) {
    app_switch_to(index);
}

// The menu's own roster (app.h's g_menuAppCount/g_menuAppIndex), read back
// rather than assumed - see emu_abi.h's comment on why this is a separate
// oracle from emu_device()'s "apps" list. app.h is already in this file's
// declared include set, so no new dependency is added to reach it.
int emu_menu_app_count(void) {
    return g_menuAppCount;
}

int emu_menu_app_index(int slot) {
    return g_menuAppIndex[slot];
}

// The arena oracle, per emu_abi.h: reads runtime_core.c's bump pointer at
// the app boundary. int, not size_t, because a wasm export hands back an
// i32 either way and APP_ARENA_BYTES (64KB) is nowhere near the sign bit.
int emu_arena_used(void) {
    return (int)rtcore_arena_used();
}

int emu_arena_capacity(void) {
    return (int)APP_ARENA_BYTES;
}

/* ===========================================================================
 * Live tunables. Thin index -> name adapters over tune_registry.h's
 * tune_registry_* (firmware/runtime/tune_registry.c), which this file
 * already includes. Used to call sketch.c's sketch_tune_* directly, back
 * when the sketchpad was the only app with tunables; the registry now
 * merges sketch.c's, clock.c's and tables.c's own sets behind one flat
 * index space, so this file does not need to know how many apps declare
 * tunables or grow a case for each one - see tune_registry.h's own header
 * comment and sensors.h's "DEVELOPMENT: live tuning" section.
 *
 * Compiled with SKETCH_LIVE_TUNE=1, CLOCK_LIVE_TUNE=1 and TABLES_LIVE_TUNE=1
 * for this target specifically (build.ts), unlike the board's default
 * build: the emulator IS a development tool end to end, so there is no
 * "shipped, must not carry a knob" state to protect here the way there is
 * on real firmware - see emu_abi.h's tunables section for the bigger
 * caveat (this panel is for iteration speed, not for finding the right
 * value; TouchSim is kinder than the real controller).
 * ======================================================================= */
float emu_tune_get(int index) {
    const char *name; float mn, mx, def;
    if (!tune_registry_describe(index, &name, &mn, &mx, &def)) return 0.0f;
    float v = def;
    tune_registry_get(name, &v);
    return v;
}

void emu_tune_set(int index, float value) {
    const char *name; float mn, mx, def;
    if (!tune_registry_describe(index, &name, &mn, &mx, &def)) return;
    tune_registry_set(name, value, NULL);
}

// Owner ask, 2026-08-14: "rajoute un moyen pour remettre chaque bouton a sa
// valeur par defaut" - a per-control way back to default, mirroring the
// real device's devlink TUNE RESET. NOT yet wired to a control in the
// page: emulator/src/ is owned by another agent right now, so this is the
// export ready for whoever next touches tunables.ts/main.ts to call,
// exactly the way emu_tune_get/emu_tune_set already were before this file
// had a caller for them either.
void emu_tune_reset(int index) {
    const char *name; float mn, mx, def;
    if (!tune_registry_describe(index, &name, &mn, &mx, &def)) return;
    tune_registry_set(name, def, NULL);
}

int emu_sound_sample_rate(void) { return SOUND_SYNTH_SAMPLE_RATE_HZ; }
uint32_t emu_sound_play_seq(void) { return s_soundPlaySeq; }
uint32_t emu_sound_stop_seq(void) { return s_soundStopSeq; }
int emu_sound_buffer(void) { return (int)(intptr_t)s_soundBuf; }
int emu_sound_frames(void) { return SOUND_PREVIEW_FRAMES; }

/* ---- emu_device(): built from what this board actually is, per
 * emu_abi.h's example JSON and AGENTS.md's "buttons, which the vendor
 * header describes wrongly" (PWR is the LOWER button). App names come from
 * g_apps[]/g_appCount (app.h), not hardcoded, so adding an app to the one
 * table in runtime_core.c makes it show up here too, same as decision
 * 0003's "adding an app means adding it to one table, and it appears in
 * both" promise. */
// 512 was tight even before "gestures" existed; the gesture's "how" prose
// alone is over 200 bytes. 1024 was tight again once "tunables" joined it
// (six entries, each with four numeric fields, when it was sketch.c's
// alone; ten now that clock.c's three and tables.c's one joined the same
// registry - tune_registry.h - and still comfortably under 2048 by
// measurement, not just by this estimate); 2048 leaves real headroom for
// any of these arrays to grow without this needing to be revisited every
// time.
static char g_deviceJson[2048];

static char *json_append(char *p, const char *s) {
    while (*s) *p++ = *s++;
    return p;
}

// Plain char-by-char equality, not strcmp: this target is freestanding and
// carries no libc (see this file's own header comment), so a comparison this
// small is a loop, not an import. Used only by emu_device()'s apps-array
// dedup below.
static int str_eq(const char *a, const char *b) {
    while (*a && *b) {
        if (*a != *b) return 0;
        a++;
        b++;
    }
    return *a == *b;
}

// Formats a non-negative float as a plain JSON number, at most two
// fractional digits, trailing zero fractional digits trimmed (250 prints as
// "250", 0.5 prints as "0.5"). Not a general float formatter - every
// tunable's min/max/default is a small, simple magnitude (see sketch.c's
// g_sketchTunables) - and deliberately not printf's "%f": this module's own
// printf (above) supports exactly the specifiers the real firmware sources
// use, grepped, and none of them is "%f". JSON accepts "250" and "250.0"
// interchangeably, so trimming is cosmetic, not a parsing requirement.
static char *json_append_num(char *p, float v) {
    if (v < 0) { *p++ = '-'; v = -v; }
    long whole = (long)v;
    long frac = (long)((v - (float)whole) * 100.0f + 0.5f);
    if (frac >= 100) { whole += 1; frac -= 100; }
    char tmp[16];
    int n = 0;
    if (whole == 0) tmp[n++] = '0';
    while (whole > 0) { tmp[n++] = (char)('0' + (whole % 10)); whole /= 10; }
    while (n > 0) *p++ = tmp[--n];
    if (frac > 0) {
        *p++ = '.';
        if (frac % 10 == 0) {
            *p++ = (char)('0' + frac / 10);
        } else {
            *p++ = (char)('0' + frac / 10);
            *p++ = (char)('0' + frac % 10);
        }
    }
    return p;
}

int emu_device(void) {
    char *p = g_deviceJson;
    p = json_append(p, "{\"name\":\"RP2350-Touch-AMOLED-1.8\",");
    p = json_append(p, "\"panel\":{\"w\":368,\"h\":448,\"format\":\"rgb565be\"},");
    p = json_append(p, "\"buttons\":[");
    p = json_append(p, "{\"id\":\"boot\",\"label\":\"BOOT\",\"edge\":\"right\",\"at\":0.38,\"role\":\"click\"},");
    p = json_append(p, "{\"id\":\"pwr\",\"label\":\"PWR\",\"edge\":\"right\",\"at\":0.62,\"role\":\"key\",\"longPressMs\":1500}");
    p = json_append(p, "],");
    p = json_append(p, "\"touch\":{\"points\":1},");
    // Two sensors, and the ORDER IS THE ABI: emu_sensor_event() and
    // emu_sensor_vector() both address them by their index in this array
    // (emu_abi.h), so "shake" stays at 0. "gravity" declares the axes and
    // unit tilt.h publishes: g, panel axes, +z into the glass, so flat on a
    // table is (0,0,1). No magnetometer is declared because this board has
    // none - the QMI8658 is a six-axis part, and no heading exists here to
    // hand a host or an app (see firmware/runtime/tilt.h). tiltball.c
    // (firmware/apps/tiltball.c) reads app_frame_t.tilt like every other
    // orientation-aware app and draws from this same sensor, not a private
    // one.
    p = json_append(p, "\"sensors\":[");
    p = json_append(p, "{\"id\":\"shake\",\"kind\":\"event\"},");
    p = json_append(p, "{\"id\":\"gravity\",\"kind\":\"vector\",\"label\":\"tilt\",\"unit\":\"g\"}");
    p = json_append(p, "],");
    p = json_append(p, "\"apps\":[");
    // Deduplicated by name, because a single-app build aliases every slot of
    // its generated roster (firmware/apps/app_roster.inc, written by
    // wasm/build.ts's --app flag) onto the SAME app, so g_apps[] can hold
    // repeated names there. Several identical "switch to fluid" buttons on the
    // page would be nonsense, so a name that already appeared earlier in this
    // array is skipped. A roster whose apps have distinct names - every real
    // firmware - makes this loop a no-op.
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
    p = json_append(p, "],");
    // The one compound gesture this runtime recognises (runtime_core.c,
    // "the BOOT+PWR long-press chord"): hold BOOT, then hold PWR until its
    // long-press verdict lands while BOOT is still down. Described in
    // device terms, not emulator terms, per emu_abi.h's note on
    // gestures[].how - the emulator supplies its own keyboard shortcuts for
    // "which key is BOOT" at render time.
    p = json_append(p, "\"gestures\":[{\"id\":\"menu\",\"label\":\"menu\",");
    p = json_append(p, "\"how\":\"Hold BOOT, then also hold PWR. Keep both held until PWR ");
    p = json_append(p, "registers a long press (about 1.5s): that opens the app menu. ");
    p = json_append(p, "Do the same chord again to close it and return to what was running.\"}],");
    // "tunables": every app's own LIVE_TUNE knobs, merged behind
    // tune_registry.h's tune_registry_* (see emu_abi.h's tunables section
    // and sensors.h's "DEVELOPMENT: live tuning" section). Declared the
    // same way buttons/sensors/apps already are above: the page builds its
    // controls from this, nothing here is hardcoded on the JS side, and
    // this file has no idea (nor needs one) which app a given entry
    // belongs to.
    p = json_append(p, "\"tunables\":[");
    {
        int n = tune_registry_count();
        for (int i = 0; i < n; i++) {
            const char *name; float mn, mx, def;
            if (!tune_registry_describe(i, &name, &mn, &mx, &def)) continue;
            if (i > 0) p = json_append(p, ",");
            p = json_append(p, "{\"id\":\"");
            p = json_append(p, name);
            p = json_append(p, "\",\"min\":");
            p = json_append_num(p, mn);
            p = json_append(p, ",\"max\":");
            p = json_append_num(p, mx);
            p = json_append(p, ",\"default\":");
            p = json_append_num(p, def);
            p = json_append(p, "}");
        }
    }
    p = json_append(p, "]");
    p = json_append(p, "}");
    *p = '\0';
    return (int)(intptr_t)g_deviceJson;
}

/* ===========================================================================
 * DEV_Delay_ms: see shim/DEV_Config.h's header comment. apps/sketch.c's
 * wipe_erase() calls this to pace the shake-to-erase wipe band by band on
 * real hardware; in wasm it is a no-op, so the wipe completes within the
 * same emu_tick() instead of over ~240ms of real time. Consistent with
 * emu_abi.h's "Timing... is not real": pacing a redraw for visual effect is
 * exactly the kind of thing that section already rules out of this
 * emulator's job, and a real sleep here is not just unfaithful, it would
 * block the one JS thread the whole page runs on.
 * ======================================================================= */
void DEV_Delay_ms(uint32_t xms) {
    (void)xms;
}
