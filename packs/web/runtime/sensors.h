/*
 * sensors: the signals a port is allowed to read, browser edition.
 *
 * VENDORED IN SHAPE, NOT IN LENGTH, from
 * packs/rp2350-touch-amoled-18/firmware/runtime/sensors.h (MIT, same
 * repository). Every declaration below has the sibling's exact name,
 * signature and semantics, and the four KEY_* bit VALUES are its values,
 * because a port compiled against one header and linked against the other
 * has to mean the same thing by `f->key & KEY_SHORT`. See NOTICE.md.
 *
 * What is NOT carried over: roughly 380 lines describing an FT3168 touch
 * controller on i2c1, a QMI8658 IMU, an AXP2101 PMIC's register 0x49, the
 * BOOT button's flash-chip-select borrow, the devlink injection surface,
 * and the per-subsystem timeout counters. None of it exists in a browser,
 * and a header that declared it would be describing a device this pack is
 * not. This is the one file where "vendor a copy" would have been
 * dishonest rather than careful, and it is the reason this pack has a
 * NOTICE.md that distinguishes the two.
 *
 * THE RULE THE SIBLING STATES AND THIS PACK KEEPS: apps read signals,
 * never chips. Here the "chip" is a DOM event, which is if anything a
 * stronger reason for the rule - a pointer event's coordinate space, a
 * devicemotion event's sign convention and an iOS permission prompt are
 * exactly the kind of platform detail that must never reach an app.
 * host/host.ts owns all of it and feeds the same four signals below.
 */
#ifndef SENSORS_H
#define SENSORS_H

#include <stdbool.h>
#include <stdint.h>

#include "app.h" // for app_tilt_t (sensors_tilt() below)

/* ---- touch -------------------------------------------------------------
 *
 * One sample as it comes off the digitizer, queued and drained once per
 * frame by the runtime. Same struct as the sibling's, field for field,
 * including tMs, which a browser fills from the same nowMs the frame is
 * ticked with.
 */
typedef struct {
    uint32_t tMs;
    uint8_t  fingers;
    uint16_t x, y;   // raw, unclamped; the consumer clamps
} touch_sample_t;

// Pops one queued sample. Returns false when the queue is empty. The
// runtime drains the whole backlog each frame, exactly as on the board:
// a browser routinely delivers several pointermove events between two
// animation frames.
bool sensors_touch_next(touch_sample_t *out);

// Whether a finger is currently on the glass. Set by the runtime once per
// frame from the drained samples, read by the shake path, which must not
// fire while a hand is resting on the panel - the sibling's rule, kept
// because the physical situation it guards against (holding the device to
// draw on it) is if anything more common on a phone.
void sensors_set_finger_down(bool down);

/* ---- the PWR key -------------------------------------------------------
 *
 * Bit VALUES are the sibling's, unchanged, because a port's `f->key &
 * KEY_SHORT` has to mean the same thing on both targets. On the board
 * these are an AXP2101 PMIC's register 0x49 bits; here they are edges the
 * host resolves from pointer events on an on-screen button and hands over
 * through emu_button()/emu_button_verdict() (wasm/emu_abi.h).
 *
 * KEY_LONG is declared and delivered, even though this pack's runtime has
 * no menu chord to consume it with (see runtime_core.c): a port written
 * for the sibling may test for it, and a bit that silently cannot appear
 * is the trap the sibling's own header spends a page regretting.
 */
#define KEY_PRESS   0x02
#define KEY_LONG    0x04
#define KEY_SHORT   0x08
#define KEY_RELEASE 0x01

// Reads and clears the pending key bits. Exactly one caller per loop
// iteration, or events are lost: a read-and-clear, not a queue. The
// runtime is that caller.
uint8_t sensors_key_take(void);

/* ---- the BOOT button ---------------------------------------------------
 *
 * On the board, reading BOOT means borrowing the flash chip select with
 * interrupts off, which is why the sibling samples it at 20Hz and never
 * faster. Here it is a second on-screen button and costs nothing, so the
 * rate limit is gone; the SEMANTICS are not. A click is still called on
 * the RELEASE edge, which is the only part an app can observe.
 */
bool sensors_boot_clicked(void);
bool sensors_boot_down(void);

/* ---- every OTHER declared click/key button -----------------------------
 *
 * BOOT and PWR above are app.h's app_frame_t's own two signals
 * (bootClicked, key), which every existing port already reads and which
 * this pack's contract does not get to grow past two on (app.h is vendored
 * byte-for-byte from the RP2350 sibling - see that file's own note). A
 * device compiled against here through wasm/build.ts's --device flag may
 * declare MORE than two usable buttons (a Watchy declares four clicks and
 * no key at all, docs/convention/device-pack.md's silhouette section), and
 * host/host.ts already draws a ghost button and sends emu_button() for
 * every one of them, by its own true index. These two calls are where a
 * port that needs more than the primary click and key reads the rest, by
 * that same index - wasm/buttonWiring.ts (compiled into wasm/emu_shim.c's
 * BTN_CLICK[]/BTN_KEY[] arrays) is what decides which index is which.
 *
 * No existing port in this repository calls either function: chrono and
 * fluidbox both ask for exactly one click and one key
 * (docs/convention/app-bundle.md's demands examples), which BOOT/PWR above
 * already deliver in full. They exist so a board's other buttons are real
 * rather than silently dropped, and so a future port CAN read a second
 * click distinctly instead of it only ever being merged into bootClicked.
 */
// Read-and-clear: true on the frame a bystander click-role button (any
// declared click OTHER than the one BOOT already reports) was released.
bool sensors_extra_click_take(int index);

// Read-and-clear PRESS/RELEASE/SHORT/LONG bits (the same KEY_* values
// above) for a bystander key-role button, or for a click-role button
// substituting for a missing key demand (tools/verdict.ts's buttonCheck):
// SHORT/LONG never arrive for a substitute, since a click declares no
// longPressMs to time against - PRESS/RELEASE do, which is the whole
// difference between "silently dropped" and "really receives the click's
// signal".
uint8_t sensors_extra_key_take(int index);

/* ---- shake -------------------------------------------------------------
 *
 * A monotonic counter, bumped once per accepted shake and suppressed while
 * a finger is down. The runtime diffs it every frame and delivers
 * f->shaken only to an app that asked for shake (app.h's wantsShake).
 *
 * The DETECTOR is the host's (host/host.ts, a high-pass over devicemotion),
 * which is a real difference from the board's IMU and is stated in
 * gotchas.md rather than hidden: a phone in a hand shakes differently from
 * a puck in a fist, and this pack does not pretend the two thresholds were
 * derived from the same measurement.
 */
uint32_t sensors_erase_seq(void);

/* ---- tilt ----------------------------------------------------------------
 *
 * The gravity-direction reading, browser edition. The sibling has a
 * dedicated tilt.c (a real filter over a real QMI8658 sample, portable to
 * both its targets); this pack has neither the chip nor that file, so
 * there is nothing to vendor here in the way sensors.c's touch/key/shake
 * plumbing was vendored above. What plays the same role: the host's
 * "tilt" vector sensor (packs/web/wasm/emu_abi.h's emu_sensor_vector),
 * already low-pass filtered upstream in JS before it ever reaches this
 * module (src/motion.ts's PhoneMotion, or the desktop drag/rotate stand-in
 * - see that file's own header comment), converted straight into
 * app_tilt_t by packs/web/wasm/emu_shim.c's own "tilt" section.
 *
 * Called once per frame by the runtime, the same "read the published
 * signal" shape sensors_key_take()/sensors_erase_seq() already use above.
 */
void sensors_tilt(app_tilt_t *out);

#endif // SENSORS_H
