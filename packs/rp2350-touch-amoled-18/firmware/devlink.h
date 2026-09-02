/*
 * devlink: a tiny line-oriented command protocol over the same USB CDC port
 * the runtime already prints debug output to, so an agent can see and drive
 * the device without a human touching it.
 *
 * Integration contract:
 *   - Call devlink_init() once, after the framebuffer and every hook
 *     function below exist (typically right after gfx_init() succeeds,
 *     before the main loop starts). See runtime.c's "devlink wiring"
 *     section for the actual hook implementations.
 *   - Call devlink_poll() once per main-loop iteration. It never blocks
 *     waiting for input: it drains whatever bytes are already queued on
 *     stdin and returns. It only spends non-trivial time when a full SHOT
 *     command has been received, while it writes the screenshot out.
 *
 * See tools/README-devlink.md for the wire protocol.
 */
#ifndef DEVLINK_H
#define DEVLINK_H

#include <stdbool.h>
#include <stdint.h>

// Symbolic PMIC key gesture names, for the KEY command. Deliberately not the
// raw sensors.h KEY_PRESS/KEY_LONG/KEY_SHORT/KEY_RELEASE bit values:
// devlink.c stays hardware-blind (it does not include sensors.h and does not
// know a PMIC register from a GPIO), so it speaks in names and leaves the
// mapping to whichever bit each name means to the runtime's own hook
// implementation (see runtime.c's "devlink wiring" section). This is also,
// separately, why the wire protocol spells these out as words rather than
// taking a raw hex mask: see tools/README-devlink.md's KEY section for that
// reasoning.
//
// DEVLINK_KEY_RELEASE added alongside the PWR-held-alone power-off gesture
// (runtime_core.c): that gesture needs to know when a hold ENDS, which
// KEY_PRESS/KEY_LONG/KEY_SHORT cannot express on their own, and there was no
// way to complete (or cancel) an injected hold without it - see
// tools/README-devlink.md's KEY section for how this gap was found.
typedef enum {
    DEVLINK_KEY_PRESS,
    DEVLINK_KEY_LONG,
    DEVLINK_KEY_SHORT,
    DEVLINK_KEY_RELEASE,
} devlink_key_t;

typedef struct {
    uint16_t *fb;   // framebuffer, RGB565, byte-swapped (panel wants the
                     // opposite byte order to a CPU uint16_t; see gfx.h's
                     // px_swap for why). devlink reads this, never writes it.
    int w, h;        // framebuffer dimensions in pixels

    // Touch injection and erase. Owned by the caller (runtime.c); devlink
    // calls them synchronously from inside devlink_poll() and never on its
    // own, same as before. What runs underneath changed with the
    // single-binary runtime: these used to call straight into the
    // sketchpad's own stroke functions, and now they feed
    // sensors_inject_touch()/sensors_inject_erase() instead, so every app
    // sees an injected touch, not just the one app that used to own this
    // hook. devlink itself does not know or care about that change.
    void (*inject_down)(int x, int y);
    void (*inject_move)(int x, int y);
    void (*inject_up)(void);
    void (*erase)(void);

    // Button injection, added alongside touch so an agent can drive the
    // BOOT+PWR menu chord, the stopwatch's KEY_SHORT start/stop and the
    // timer's KEY_SHORT pause without a human touching a physical contact.
    // Feeds sensors_inject_key()/sensors_inject_boot()/
    // sensors_inject_boot_click() underneath (runtime.c); see sensors.h's
    // comments on those three for what this can and cannot prove (it never
    // touches the PMIC's i2c1 register read or the flash-chip-select borrow,
    // only the runtime and app code downstream of them).
    void (*inject_key)(devlink_key_t which);
    void (*inject_boot)(bool down);
    void (*inject_boot_click)(void);

    // App navigation: added so an agent that can only screenshot whichever
    // app happens to be running is not stuck verifying one screen forever.
    int (*app_current)(void);           // the running app's index. Opaque as
                                         // far as devlink is concerned (it
                                         // only ever prints it back).
    const char *(*app_name)(int index); // name for an index, or NULL if
                                         // there isn't one at that index.
    bool (*app_switch)(int index);      // requests a switch to index;
                                         // returns false, and changes
                                         // nothing, if index is out of range.

    // Live tuning (TUNE command). devlink stays hardware- and app-blind, so
    // these are generic name/value hooks, not "sketch" or "lift" anywhere in
    // this file - runtime.c wires them straight to sketch.c's sketch_tune_*
    // functions (sensors.h), the same indirection app_current/app_name/
    // app_switch already use for apps in general. NULL is a valid value for
    // every one of these four (a build with nothing tunable, or one that
    // never wired this section up): devlink.c checks before calling any of
    // them and answers "ERR no tunables" rather than crashing, the same
    // policy g_hooks.erase being NULL already gets away with today.
    int (*tune_count)(void);
    bool (*tune_describe)(int index, const char **name, float *min, float *max, float *def);
    // The #define a tunable freezes back into, for the FREEZE subcommand
    // (e.g. "LIFT_DEBOUNCE_MS" for protoName "lift") - not derivable from
    // protoName by a fixed rule (devlink.c stays blind to what the name
    // even means), so it is its own hook rather than a string transform.
    const char *(*tune_define_name)(int index);
    // TILT: the orientation readback, and the ONLY way to run the axis
    // ritual firmware/runtime/tilt.h describes. Which way the QMI8658 is
    // rotated on this PCB is not recorded in any document in this
    // repository, no software oracle can check it (nothing in software
    // knows which way is up), and a spirit level built on a flipped axis
    // passes every automated test this project can ever write. So the one
    // instrument that can settle it is a human holding the board in five
    // known poses and reading these numbers back.
    //
    // devlink stays blind to what they mean, as it does for every other
    // hook here: raw3 is the accelerometer's own three axes, g3 is the
    // same reading after the runtime has mapped and filtered it into the
    // space an app sees, and up is a small integer the caller prints. Both
    // arrays are three floats. Returns false if this build has no
    // orientation signal at all, which devlink answers as "ERR no tilt"
    // rather than crashing, the same policy the tune hooks get.
    bool (*tilt_read)(float *raw3, float *g3, float *tiltDeg, int *up, int *valid);

    bool (*tune_get)(const char *name, float *out);
    // outApplied receives the value actually applied after clamping, so a
    // client can be told what really took effect, not just echo back what
    // it asked for.
    bool (*tune_set)(const char *name, float value, float *outApplied);

    // PUSHSTATS: how many gfx_push()/gfx_push_all() calls have reached the
    // panel, and how many pixels they touched, since the last SHOT (see
    // devlink_send_shot(), which resets these before it does anything
    // else). This is what lets apps/fluidbox/invariants.ts's panel-push
    // invariant be answered from a real board instead of only from the
    // emulator's own emu_push_count()/emu_push_w()/emu_push_h() replay -
    // see gfx.h's own header comment on gfx_push_stats_get/reset for the
    // full argument. Wired straight to those two functions by runtime.c;
    // their signatures already match, the same reason tune_get/tune_set
    // above need no adapter either. NULL on a build that never wires this
    // (an older tree, or a pack whose gfx does not track pushes at all),
    // in which case PUSHSTATS answers "ERR unknown PUSHSTATS" rather than
    // crashing - the same policy every other optional hook here gets.
    void (*push_stats_get)(uint32_t *pushes, uint32_t *pixels);
    void (*push_stats_reset)(void);
} devlink_hooks_t;

// Copies *hooks by value. Call once, after hooks->fb has been allocated and
// every function pointer above points at a working function.
void devlink_init(const devlink_hooks_t *hooks);

// Call once per main-loop iteration. Non-blocking: reads whatever is already
// buffered on stdin with getchar_timeout_us(0) and returns as soon as
// nothing more is waiting. The one exception is emitting a SHOT reply: it is
// bounded in SIZE (at most w*h RLE pairs, base64-encoded) but that alone does
// not bound it in TIME against a host that opened the port and is not
// draining it - every one of the many thousand putchar() calls a full
// screenshot makes falls through pico-sdk's own per-write timeout
// individually, and their sum blew well past runtime.c's 4-second watchdog
// on real hardware before devlink.c's DEVLINK_SHOT_BUDGET_US existed. That
// budget is the actual bound now: past it, the rest of the reply's body is
// dropped (counted by devlink_dropped_shots() below) rather than attempted,
// so devlink_poll() always returns.
//
// CHORD (see tools/README-devlink.md) needs BOOT to still read "held" on the
// next call to rtcore_tick(), then released after. Since devlink_poll() must
// not block waiting for that tick to happen, CHORD instead sets a one-shot
// pending flag and returns immediately; the release itself is applied at the
// very start of the NEXT devlink_poll() call, which the caller's main loop
// (runtime.c) always runs after rtcore_tick(), so the release is guaranteed
// to land after, not during, the tick that consumed the held state. No sleep
// anywhere in this file.
void devlink_poll(void);

// How many SHOT replies have had their body cut short because the host
// stopped draining the port mid-transfer (see devlink_poll()'s comment
// above and devlink.c's DEVLINK_SHOT_BUDGET_US). runtime.c's profiler line
// reports this once a second so a truncated screenshot is never silently
// mistaken for a dead device: a climbing counter next to an otherwise-stalled
// exchange means output is being dropped on purpose, not that nothing is
// running.
uint32_t devlink_dropped_shots(void);

#endif // DEVLINK_H
