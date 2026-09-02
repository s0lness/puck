/*
 * devlink implementation. See devlink.h for the integration contract and
 * tools/README-devlink.md for the wire protocol this speaks.
 *
 * Kept dependency-light on purpose: stdio/stdint/stdlib/string/ctype (all
 * plain C, already linked into every pico-sdk app via pico_stdlib) plus
 * pico/stdlib.h for getchar_timeout_us(). No new pico-sdk libraries.
 */
#include "devlink.h"

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/time.h"

#define DEVLINK_VERSION   1

/*
 * THE BUILD IDENTITY, and why a device needs one.
 *
 * A differential harness once diffed three apps on the board against four
 * in the tree and reported a 28 percent divergence that read, convincingly,
 * as a rendering bug. It was not one. The board was simply older than the
 * checkout, and nothing it could say would have revealed that, because
 * nothing it said was about which code it was running.
 *
 * BUILD_FINGERPRINT is a hash of every firmware source that went into this
 * image, computed by tools/gate/fingerprint.ts and handed to the compiler
 * by firmware/CMakeLists.txt. The host computes the same hash from its own
 * tree and refuses to compare anything until the two agree
 * (assertDeviceMatchesTree, same file). ONE definition of the fingerprint,
 * in one language, used by both sides - a second implementation of it here
 * in C would be the exact drift decision 0003 spent an emulator rewrite
 * removing.
 *
 * The fallback matters as much as the value. A build that did not go
 * through CMake (or one whose fingerprint step failed) reports "unknown",
 * and the host treats that as "this cannot be compared" rather than as a
 * mismatch - because an unnamed build is not a different build, it is a
 * build nobody can say anything about, and those two deserve different
 * words.
 */
#if defined(__has_include)
#  if __has_include("build_fingerprint.h")
#    include "build_fingerprint.h"
#  endif
#endif
#ifndef BUILD_FINGERPRINT
#define BUILD_FINGERPRINT "unknown"
#endif

#define DEVLINK_LINE_MAX  96   // "MOVE -32768 -32768" style commands are
                                 // well under this; anything longer is
                                 // dropped and resynced on the next line.
#define DEVLINK_B64_WRAP  76   // chars per base64 line, per the spec

// A SHOT reply streams the whole framebuffer's base64 body through putchar()
// (devlink_b64_flush_group() below), one call per output character, tens of
// thousands of times for a full screenshot. pico-sdk's stdio_usb driver
// bounds any ONE of those calls (see CMakeLists.txt's
// PICO_STDIO_USB_STDOUT_TIMEOUT_US), but not their SUM: a host that asked
// for a screenshot and then stopped draining the port (closed its reader,
// crashed, or was never going to read at all) left every one of those calls
// falling straight through its own bound, and the walk that drives them
// never returns to devlink_poll(), never mind runtime.c's main loop -
// which is where the watchdog lives. Measured on real hardware: this is what
// actually rebooted the board when a client held the port open across a
// SHOT request without draining it (see this file's git history and
// tools/README-devlink.md); a bare idle open, with no SHOT in flight, does
// not reproduce it, because there is no loop like this one anywhere else in
// the firmware.
//
// The fix is a wall-clock budget on the reply as a whole, checked once per
// base64 group (every 3 input bytes) rather than every character: cheap
// enough that a draining host never notices it, and once it trips, the rest
// of the walk still runs (pure CPU against the framebuffer, no I/O) but
// produces no more output, so it finishes in microseconds instead of
// blocking through the timeout on every remaining character one at a time.
// 750ms is generous next to what a real, draining host actually needs
// (tools/README-devlink.md's own bring-up decoded a full screenshot with
// room to spare) and comfortably inside runtime.c's 4000ms watchdog even
// after everything else that loop iteration still has to do.
#define DEVLINK_SHOT_BUDGET_US 750000

static devlink_hooks_t g_hooks;
static char g_line[DEVLINK_LINE_MAX];
static int g_lineLen = 0;

// Bumped once per SHOT reply whose body was cut short by the budget above.
// Surfaced by runtime.c's profiler line (via devlink_dropped_shots()) so a
// truncated screenshot is never silently mistaken for a dead device: this
// counter keeps climbing, once a second, on the same port, whether or not
// anyone is actively driving devlink right now - see sensors_inject_key()'s
// "THE HONESTY REQUIREMENT" comment in sensors.h for the same principle
// applied elsewhere in this codebase: a dropped signal must say so, not go
// quiet.
static uint32_t g_droppedShots = 0;

uint32_t devlink_dropped_shots(void) {
    return g_droppedShots;
}

// Set by the CHORD command, serviced at the top of the NEXT devlink_poll()
// call. See devlink.h's devlink_poll() comment for why this cannot just
// release BOOT before returning from the CHORD command itself: the tick
// that has to see BOOT still held has not run yet at that point, and
// devlink_poll() must not block waiting for it to.
static bool g_chordReleasePending = false;

void devlink_init(const devlink_hooks_t *hooks) {
    g_hooks = *hooks;
    g_lineLen = 0;
}

/* ---------------------------------------------------------------------
 * Screenshot: greyscale + run-length encoding + base64.
 *
 * The panel is neutral grey throughout (white paper, black ink), so one
 * byte per pixel loses nothing that matters. Getting that byte out of a
 * stored RGB565 pixel needs the byte-swap undone first: the framebuffer is
 * kept byte-swapped relative to a CPU uint16_t because the panel wants the
 * opposite order and the buffer is DMA'd out raw (see gfx.h's px_swap).
 * ------------------------------------------------------------------- */
static inline uint8_t devlink_gray_at(int idx) {
    uint16_t px = g_hooks.fb[idx];
    uint16_t v = (uint16_t)((px >> 8) | (px << 8));
    return (uint8_t)(((v >> 5) & 0x3F) << 2);
}

// Walks the framebuffer as a stream of RLE (value, count) pairs, count
// clamped to 1..255, calling emit() for each pair. Used twice: once just to
// total the byte count (needed up front for the "SHOT w h count" header,
// before any base64 is written), once to actually stream it. Two full
// passes over the framebuffer are cheap; buffering the whole RLE stream
// would not be, next to a 330KB framebuffer in 520KB of SRAM.
typedef void (*devlink_rle_emit_fn)(uint8_t value, uint8_t count, void *ctx);

static void devlink_rle_walk(devlink_rle_emit_fn emit, void *ctx) {
    int n = g_hooks.w * g_hooks.h;
    if (n <= 0) return;
    uint8_t cur = devlink_gray_at(0);
    int runLen = 1;
    for (int i = 1; i < n; i++) {
        uint8_t g = devlink_gray_at(i);
        if (g == cur && runLen < 255) {
            runLen++;
        } else {
            emit(cur, (uint8_t)runLen, ctx);
            cur = g;
            runLen = 1;
        }
    }
    emit(cur, (uint8_t)runLen, ctx);
}

static void devlink_rle_count_cb(uint8_t value, uint8_t count, void *ctx) {
    (void)value;
    (void)count;
    uint32_t *total = (uint32_t *)ctx;
    *total += 2;
}

// Standard base64, streamed 3 input bytes -> 4 output chars at a time, with
// the padded final group handled the same way whether it is 1, 2 or 3 bytes
// long. Wraps output at DEVLINK_B64_WRAP chars/line as the protocol requires.
static const char devlink_b64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

typedef struct {
    uint8_t buf[3];
    int bufLen;
    int lineCol;
    uint64_t deadlineUs; // set once, at the start of devlink_send_shot()
    bool truncated;      // latched true the first time the deadline is missed
} devlink_b64_stream_t;

static void devlink_b64_flush_group(devlink_b64_stream_t *s) {
    if (s->bufLen == 0) return;
    if (s->truncated) {
        // Already dropping: skip the encode too, not just the write. The
        // RLE walk driving this keeps running (see devlink_rle_walk()) so it
        // can still finish and let devlink_send_shot() send its closing
        // "END", but nothing past this point costs more than a comparison.
        s->bufLen = 0;
        return;
    }
    if (time_us_64() > s->deadlineUs) {
        s->truncated = true;
        g_droppedShots++;
        s->bufLen = 0;
        return;
    }
    uint32_t n = ((uint32_t)s->buf[0] << 16) |
                 ((uint32_t)(s->bufLen > 1 ? s->buf[1] : 0) << 8) |
                 (uint32_t)(s->bufLen > 2 ? s->buf[2] : 0);
    char out[4];
    out[0] = devlink_b64_table[(n >> 18) & 0x3F];
    out[1] = devlink_b64_table[(n >> 12) & 0x3F];
    out[2] = s->bufLen > 1 ? devlink_b64_table[(n >> 6) & 0x3F] : '=';
    out[3] = s->bufLen > 2 ? devlink_b64_table[n & 0x3F] : '=';
    for (int i = 0; i < 4; i++) {
        putchar(out[i]);
        s->lineCol++;
        if (s->lineCol >= DEVLINK_B64_WRAP) {
            printf("\r\n");
            s->lineCol = 0;
        }
    }
    s->bufLen = 0;
}

static void devlink_b64_push_byte(devlink_b64_stream_t *s, uint8_t b) {
    s->buf[s->bufLen++] = b;
    if (s->bufLen == 3) devlink_b64_flush_group(s);
}

static void devlink_rle_emit_b64_cb(uint8_t value, uint8_t count, void *ctx) {
    devlink_b64_stream_t *s = (devlink_b64_stream_t *)ctx;
    devlink_b64_push_byte(s, value);
    devlink_b64_push_byte(s, count);
}

static void devlink_send_shot(void) {
    if (g_hooks.fb == NULL || g_hooks.w <= 0 || g_hooks.h <= 0) {
        printf("ERR no framebuffer\r\n");
        return;
    }

    // Marks the start of the next PUSHSTATS accounting window ("since the
    // last SHOT" - see devlink.h's push_stats_reset comment): reset here,
    // before anything else, so a push that happens to land while this
    // reply is still being written counts toward the NEXT window rather
    // than being lost or double-counted.
    if (g_hooks.push_stats_reset) g_hooks.push_stats_reset();

    uint32_t rleBytes = 0;
    devlink_rle_walk(devlink_rle_count_cb, &rleBytes);

    printf("SHOT %d %d %lu\r\n", g_hooks.w, g_hooks.h,
           (unsigned long)rleBytes);

    devlink_b64_stream_t s;
    s.bufLen = 0;
    s.lineCol = 0;
    s.deadlineUs = time_us_64() + DEVLINK_SHOT_BUDGET_US;
    s.truncated = false;
    devlink_rle_walk(devlink_rle_emit_b64_cb, &s);
    devlink_b64_flush_group(&s); // final partial group, if any
    if (s.lineCol != 0) printf("\r\n");
    // Still send END even when truncated: tools/dev.ts already treats a
    // short base64 body as a warning (decoded byte count vs. the header's
    // promised count), rather than a hang waiting for a terminator that
    // never comes. Nothing new to teach the host tool - see this file's
    // top-of-block comment for where the truncation itself is counted.
    printf("END\r\n");
}

/* ---------------------------------------------------------------------
 * Line protocol.
 * ------------------------------------------------------------------- */

// Parses two whitespace-separated ints from s. Returns how many it found
// (0, 1 or 2) so the caller can tell "DOWN" with no args from "DOWN 5" from
// "DOWN 5 6".
static int devlink_parse_two_ints(const char *s, int *a, int *b) {
    while (*s == ' ') s++;
    char *end;
    long va = strtol(s, &end, 10);
    if (end == s) return 0;
    s = end;
    while (*s == ' ') s++;
    long vb = strtol(s, &end, 10);
    if (end == s) return 1;
    *a = (int)va;
    *b = (int)vb;
    return 2;
}

// Parses one whitespace-separated int from s. Returns false if none found;
// used by SWITCH, which takes just an index rather than DOWN/MOVE's x/y pair.
static bool devlink_parse_one_int(const char *s, int *a) {
    while (*s == ' ') s++;
    char *end;
    long v = strtol(s, &end, 10);
    if (end == s) return false;
    *a = (int)v;
    return true;
}

// Case-insensitive match of a single leading word in s against word (which
// must already be uppercase). Used by KEY/BOOT's named subcommands instead
// of strcasecmp (not pulled in anywhere else in this file, and this needs
// the "must end at a word boundary" check regardless, so a real match cannot
// accept "SHORTISH" as "SHORT"). Leading spaces in s are skipped; trailing
// content after the matched word is not consumed or inspected here.
static bool devlink_word_is(const char *s, const char *word) {
    while (*s == ' ') s++;
    size_t i = 0;
    for (; word[i]; i++) {
        if (toupper((unsigned char)s[i]) != (unsigned char)word[i]) return false;
    }
    char after = s[i];
    return after == '\0' || after == ' ';
}

/* ---------------------------------------------------------------------
 * TUNE: get/set/reset/list/freeze the firmware's live-tunable constants -
 * today, sketch.c's dropout-tolerance knobs, clock.c's separator-pulse
 * shape and tables.c's numpad thumb bias, each gated behind its own
 * SKETCH_LIVE_TUNE / CLOCK_LIVE_TUNE / TABLES_LIVE_TUNE and merged behind
 * ONE registry (firmware/runtime/tune_registry.h - see sensors.h's
 * "DEVELOPMENT: live tuning" section for the full history). This file
 * never names "sketch", "lift", any other specific tunable, or even how
 * many apps declare any: it only knows the generic name/value shape
 * devlink_hooks_t's tune_* function pointers declare (wired to
 * tune_registry_* in runtime.c), the same indirection
 * app_current/app_name/app_switch already use so devlink.c stays hardware-
 * and app-blind. See tools/README-devlink.md for the wire grammar this
 * implements.
 * ------------------------------------------------------------------- */

// Prints a tunable value as a plain decimal with up to one fractional digit
// (the only fraction any declared tunable's range currently needs - see
// sketch.c's g_sketchTunables). Deliberately not printf's %f: nothing else
// in this codebase uses it, so whether this board's linked libc even
// supports float formatting is unverified, and guessing at linker behaviour
// is exactly the kind of assumption this project measures instead of
// trusting. All values in range are non-negative, so this does not need to
// handle a negative fractional part.
static void devlink_print_tune_value(float v) {
    long tenths = (long)(v * 10.0f + 0.5f);
    long whole = tenths / 10;
    long frac = tenths % 10;
    if (frac == 0) {
        printf("%ld", whole);
    } else {
        printf("%ld.%ld", whole, frac);
    }
}

/* ---- TILT: the orientation readback, for the axis ritual -----------------
 *
 * One line, nine fields:
 *
 *   TILT <rawX> <rawY> <rawZ> <gx> <gy> <gz> <deg> <up> <valid>
 *
 * raw* is the accelerometer's own three axes, straight off the part; g* is
 * the same reading after the runtime has mapped and filtered it into the
 * space an app actually sees; up is 0 top, 1 right, 2 bottom, 3 left of
 * that same space; valid is 0 or 1. Everything is in g except deg, which is
 * the angle from flat. This file does not know what any of that means (see
 * devlink.h's tilt_read hook); the host prints it in words.
 *
 * WHY THE RAW AXES ARE ON THIS LINE AT ALL. They are the whole point of the
 * command. firmware/runtime/tilt.h's device-to-panel mapping is a
 * HYPOTHESIS that no test can check, because nothing in software knows
 * which way is up, and the only way to settle it is to hold the board in
 * five known poses and compare what the part reported against what the
 * runtime published. Without raw, a wrong pose says "something is wrong"
 * and cannot say what.
 */
static void devlink_print_signed(float v) {
    // Three decimals, signed, because these values live in [-1, 1] and the
    // sign IS the measurement. Same reasoning as devlink_print_tune_value
    // above for not using %f: nothing else in this firmware asks its libc
    // to format a float, and this is not the place to find out whether it
    // can.
    if (v < 0.0f) { printf("-"); v = -v; }
    long thousandths = (long)(v * 1000.0f + 0.5f);
    printf("%ld.%03ld", thousandths / 1000, thousandths % 1000);
}

static void devlink_tilt(void) {
    float raw[3], g[3], deg = 0.0f;
    int up = 0, valid = 0;
    if (!g_hooks.tilt_read || !g_hooks.tilt_read(raw, g, &deg, &up, &valid)) {
        printf("ERR no tilt\r\n");
        return;
    }
    printf("TILT ");
    for (int i = 0; i < 3; i++) { devlink_print_signed(raw[i]); printf(" "); }
    for (int i = 0; i < 3; i++) { devlink_print_signed(g[i]); printf(" "); }
    devlink_print_signed(deg);
    printf(" %d %d\r\n", up, valid);
}

// Takes one whitespace-separated word from *s into out (truncated to
// outCap-1 if longer, with any overflow tail still consumed so parsing
// resyncs on the next word rather than the leftover characters). Advances
// *s past the word. Returns false if there was no word to take (immediate
// end of string). Separate from devlink_parse_two_ints/devlink_word_is
// above: TUNE's grammar needs to both MATCH a subcommand word and EXTRACT a
// name that is not one of a fixed set, which neither existing helper does.
static bool devlink_word_take(const char **s, char *out, size_t outCap) {
    while (**s == ' ') (*s)++;
    size_t i = 0;
    while (**s && **s != ' ') {
        if (i + 1 < outCap) out[i++] = **s;
        (*s)++;
    }
    out[i] = '\0';
    return i > 0;
}

static void devlink_tune_list(void) {
    int n = g_hooks.tune_count ? g_hooks.tune_count() : 0;
    for (int i = 0; i < n; i++) {
        const char *name; float mn, mx, def;
        if (!g_hooks.tune_describe || !g_hooks.tune_describe(i, &name, &mn, &mx, &def)) continue;
        float cur = def;
        if (g_hooks.tune_get) g_hooks.tune_get(name, &cur);
        printf("TUNE %s ", name);
        devlink_print_tune_value(cur);
        printf(" ");
        devlink_print_tune_value(mn);
        printf(" ");
        devlink_print_tune_value(mx);
        printf(" ");
        devlink_print_tune_value(def);
        printf("\r\n");
    }
    printf("END\r\n");
}

// Prints every tunable's CURRENT value as a `#define ..._DEFAULT` line,
// ready to paste over sketch.c's own _DEFAULT constants - see that file's
// SKETCH_LIVE_TUNE comment, "FREEZING is the end state". Prints the live
// value, not the shipped default: freezing is specifically how a value
// found by feel on the device gets promoted into source.
static void devlink_tune_freeze(void) {
    int n = g_hooks.tune_count ? g_hooks.tune_count() : 0;
    for (int i = 0; i < n; i++) {
        const char *name; float mn, mx, def;
        if (!g_hooks.tune_describe || !g_hooks.tune_describe(i, &name, &mn, &mx, &def)) continue;
        const char *defineName = g_hooks.tune_define_name ? g_hooks.tune_define_name(i) : NULL;
        if (!defineName) defineName = name;
        float cur = def;
        if (g_hooks.tune_get) g_hooks.tune_get(name, &cur);
        // A float literal, not a number with an f stapled on. The value
        // printer drops the decimal point on whole numbers, so appending "f"
        // produced "220f", which is not valid C: the one output whose entire
        // purpose is to be pasted into a source file did not compile.
        char buf[32];
        snprintf(buf, sizeof buf, "%g", (double)cur);
        if (!strchr(buf, '.') && !strchr(buf, 'e') && !strchr(buf, 'E')) {
            size_t len = strlen(buf);
            if (len + 3 < sizeof buf) { buf[len] = '.'; buf[len + 1] = '0'; buf[len + 2] = '\0'; }
        }
        printf("#define %s_DEFAULT %sf\r\n", defineName, buf);
    }
    printf("END\r\n");
}

// Finds the declared index whose protocol name matches `name`, by walking
// tune_describe() the same way devlink_tune_list()/devlink_tune_freeze() do
// - there is no name-indexed describe() hook, only tune_get/tune_set are
// name-based (see devlink.h), so RESET (which needs the declared default,
// not just the current value) has to look the name up the same way LIST
// and FREEZE already enumerate every tunable. Returns -1 if none matches or
// the gate is off.
static int devlink_tune_index_of(const char *name) {
    int n = g_hooks.tune_count ? g_hooks.tune_count() : 0;
    for (int i = 0; i < n; i++) {
        const char *nm; float mn, mx, def;
        if (!g_hooks.tune_describe || !g_hooks.tune_describe(i, &nm, &mn, &mx, &def)) continue;
        if (strcmp(nm, name) == 0) return i;
    }
    return -1;
}

// Restores tunable `idx` to its declared default, printing both what it is
// now and what it was a moment ago - owner feedback: "a reset that prints
// the value it restored, and ideally what it was before, is worth more than
// a silent one. He is going to be reading these lines while holding a
// finger on the panel." Composed from the existing tune_describe/tune_get/
// tune_set hooks, the same way CHORD above composes BOOT+KEY rather than
// getting its own dedicated hook: RESET needs no new state or capability
// devlink_hooks_t does not already expose.
static void devlink_tune_reset_index(int idx) {
    const char *nm; float mn, mx, def;
    g_hooks.tune_describe(idx, &nm, &mn, &mx, &def);
    float previous = def;
    if (g_hooks.tune_get) g_hooks.tune_get(nm, &previous);
    float applied = def;
    if (g_hooks.tune_set) g_hooks.tune_set(nm, def, &applied);
    printf("TUNE %s ", nm);
    devlink_print_tune_value(applied);
    printf(" ");
    devlink_print_tune_value(previous);
    printf("\r\n");
}

static void devlink_tune_reset_all(void) {
    int n = g_hooks.tune_count ? g_hooks.tune_count() : 0;
    if (n == 0) { printf("ERR no tunables\r\n"); return; }
    for (int i = 0; i < n; i++) devlink_tune_reset_index(i);
    printf("END\r\n");
}

static void devlink_dispatch_tune(const char *args) {
    while (*args == ' ') args++;
    if (*args == '\0') {
        devlink_tune_list();
        return;
    }

    char sub[16];
    const char *rest = args;
    if (!devlink_word_take(&rest, sub, sizeof(sub))) { printf("ERR args\r\n"); return; }
    for (char *c = sub; *c; c++) *c = (char)toupper((unsigned char)*c);

    if (strcmp(sub, "FREEZE") == 0) {
        devlink_tune_freeze();
    } else if (strcmp(sub, "GET") == 0) {
        char name[24];
        if (!devlink_word_take(&rest, name, sizeof(name))) { printf("ERR args\r\n"); return; }
        if (!g_hooks.tune_get) { printf("ERR no tunables\r\n"); return; }
        float v;
        if (!g_hooks.tune_get(name, &v)) { printf("ERR unknown %s\r\n", name); return; }
        printf("TUNE %s ", name);
        devlink_print_tune_value(v);
        printf("\r\n");
    } else if (strcmp(sub, "SET") == 0) {
        char name[24];
        if (!devlink_word_take(&rest, name, sizeof(name))) { printf("ERR args\r\n"); return; }
        while (*rest == ' ') rest++;
        if (*rest == '\0') { printf("ERR args\r\n"); return; }
        char *end;
        float v = strtof(rest, &end);
        if (end == rest) { printf("ERR args\r\n"); return; }
        if (!g_hooks.tune_set) { printf("ERR no tunables\r\n"); return; }
        float applied;
        if (!g_hooks.tune_set(name, v, &applied)) { printf("ERR unknown %s\r\n", name); return; }
        printf("TUNE %s ", name);
        devlink_print_tune_value(applied);
        printf("\r\n");
    } else if (strcmp(sub, "RESET") == 0) {
        char name[24];
        if (!devlink_word_take(&rest, name, sizeof(name))) {
            // No name given: reset every declared tunable, same "bare
            // command means all of them" shape TUNE itself already uses
            // for LIST.
            devlink_tune_reset_all();
            return;
        }
        if (!g_hooks.tune_describe) { printf("ERR no tunables\r\n"); return; }
        int idx = devlink_tune_index_of(name);
        if (idx < 0) { printf("ERR unknown %s\r\n", name); return; }
        devlink_tune_reset_index(idx);
    } else {
        printf("ERR args\r\n");
    }
}

static void devlink_dispatch(char *line) {
    char *p = line;
    while (*p == ' ') p++;
    char *cmdStart = p;
    while (*p && *p != ' ') p++;
    size_t cmdLen = (size_t)(p - cmdStart);

    char args_sep = *p;
    if (args_sep) *p++ = '\0'; // terminate the command token in place
    char *args = p;
    while (*args == ' ') args++;

    if (cmdLen == 0) return; // blank line: ignore silently

    // Uppercase a bounded copy for comparison; the original casing (still in
    // cmdStart) is echoed back in the "unknown command" error.
    char cmd[16];
    if (cmdLen >= sizeof(cmd)) {
        printf("ERR unknown %s\r\n", cmdStart);
        return;
    }
    for (size_t i = 0; i < cmdLen; i++) {
        cmd[i] = (char)toupper((unsigned char)cmdStart[i]);
    }
    cmd[cmdLen] = '\0';

    if (strcmp(cmd, "PING") == 0) {
        printf("OK devlink %d %d %d\r\n", DEVLINK_VERSION, g_hooks.w, g_hooks.h);
    } else if (strcmp(cmd, "FP") == 0) {
        // Deliberately its own command rather than another field on PING:
        // a host talking to a board that predates this gets "ERR unknown
        // FP", which is an unambiguous answer ("older than fingerprinting,
        // do not compare"), where a widened PING would just be a line with
        // fewer fields that an older parser happily accepts.
        printf("FP %s\r\n", BUILD_FINGERPRINT);
    } else if (strcmp(cmd, "SHOT") == 0) {
        devlink_send_shot();
    } else if (strcmp(cmd, "DOWN") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); return; }
        if (g_hooks.inject_down) g_hooks.inject_down(x, y);
        printf("OK\r\n");
    } else if (strcmp(cmd, "MOVE") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); return; }
        if (g_hooks.inject_move) g_hooks.inject_move(x, y);
        printf("OK\r\n");
    } else if (strcmp(cmd, "UP") == 0) {
        if (g_hooks.inject_up) g_hooks.inject_up();
        printf("OK\r\n");
    } else if (strcmp(cmd, "TAP") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); return; }
        if (g_hooks.inject_down) g_hooks.inject_down(x, y);
        if (g_hooks.inject_up) g_hooks.inject_up();
        printf("OK\r\n");
    } else if (strcmp(cmd, "ERASE") == 0) {
        if (g_hooks.erase) g_hooks.erase();
        printf("OK\r\n");
    } else if (strcmp(cmd, "KEY") == 0) {
        // Named forms only, no raw hex mask: see tools/README-devlink.md's
        // KEY section for why (a mistyped mask at a prompt silently injects
        // the wrong gesture; a misspelled name just fails).
        devlink_key_t which;
        if (devlink_word_is(args, "PRESS")) which = DEVLINK_KEY_PRESS;
        else if (devlink_word_is(args, "LONG")) which = DEVLINK_KEY_LONG;
        else if (devlink_word_is(args, "SHORT")) which = DEVLINK_KEY_SHORT;
        else if (devlink_word_is(args, "RELEASE")) which = DEVLINK_KEY_RELEASE;
        else { printf("ERR args\r\n"); return; }
        if (g_hooks.inject_key) g_hooks.inject_key(which);
        printf("OK\r\n");
    } else if (strcmp(cmd, "BOOT") == 0) {
        if (devlink_word_is(args, "DOWN")) {
            if (g_hooks.inject_boot) g_hooks.inject_boot(true);
        } else if (devlink_word_is(args, "UP")) {
            if (g_hooks.inject_boot) g_hooks.inject_boot(false);
        } else if (devlink_word_is(args, "CLICK")) {
            if (g_hooks.inject_boot_click) g_hooks.inject_boot_click();
        } else {
            printf("ERR args\r\n");
            return;
        }
        printf("OK\r\n");
    } else if (strcmp(cmd, "CHORD") == 0) {
        // The BOOT+PWR menu chord, composed from the same primitives as
        // BOOT/KEY above and no more: hold BOOT, deliver PWR's long-press
        // verdict, release BOOT. See runtime_core.c's chord comment for what
        // this reproduces at the firmware's input layer, and sensors.h's
        // sensors_inject_key()/sensors_inject_boot() for what it does NOT
        // reproduce (the PMIC register read and the flash-chip-select
        // borrow that a real press goes through first).
        if (g_hooks.inject_boot) g_hooks.inject_boot(true);
        if (g_hooks.inject_key) g_hooks.inject_key(DEVLINK_KEY_LONG);
        g_chordReleasePending = true;
        printf("OK\r\n");
    } else if (strcmp(cmd, "APP") == 0) {
        int idx = g_hooks.app_current ? g_hooks.app_current() : 0;
        const char *name = g_hooks.app_name ? g_hooks.app_name(idx) : NULL;
        printf("APP %d %s\r\n", idx, name ? name : "?");
    } else if (strcmp(cmd, "SWITCH") == 0) {
        int idx;
        if (!devlink_parse_one_int(args, &idx)) { printf("ERR args\r\n"); return; }
        bool ok = g_hooks.app_switch ? g_hooks.app_switch(idx) : false;
        printf(ok ? "OK\r\n" : "ERR range\r\n");
    } else if (strcmp(cmd, "TILT") == 0) {
        devlink_tilt();
    } else if (strcmp(cmd, "PUSHSTATS") == 0) {
        if (!g_hooks.push_stats_get) { printf("ERR unknown PUSHSTATS\r\n"); return; }
        uint32_t pushes = 0, pixels = 0;
        g_hooks.push_stats_get(&pushes, &pixels);
        printf("PUSHSTATS %lu %lu\r\n", (unsigned long)pushes, (unsigned long)pixels);
    } else if (strcmp(cmd, "TUNE") == 0) {
        devlink_dispatch_tune(args);
    } else {
        printf("ERR unknown %s\r\n", cmd);
    }
}

void devlink_poll(void) {
    // Release BOOT from a CHORD one tick after it was asserted (see
    // devlink.h's devlink_poll() comment and the CHORD case in
    // devlink_dispatch() above). This runs before anything is drained off
    // the wire, so it lands as early as possible in this iteration, strictly
    // after the caller's rtcore_tick() for this iteration has already run
    // (see runtime.c's main loop: rtcore_tick() then devlink_poll(), every
    // iteration) and strictly after the iteration where CHORD set the flag.
    if (g_chordReleasePending) {
        g_chordReleasePending = false;
        if (g_hooks.inject_boot) g_hooks.inject_boot(false);
    }

    for (;;) {
        int c = getchar_timeout_us(0);
        if (c == PICO_ERROR_TIMEOUT) return; // nothing queued right now

        if (c == '\n' || c == '\r') {
            if (g_lineLen > 0) {
                g_line[g_lineLen] = '\0';
                devlink_dispatch(g_line);
                g_lineLen = 0;
            }
            continue;
        }

        if (g_lineLen < DEVLINK_LINE_MAX - 1) {
            g_line[g_lineLen++] = (char)c;
        } else {
            // Overlong line: drop what we have and resync on the next
            // terminator rather than acting on a truncated command.
            g_lineLen = 0;
        }
    }
}
