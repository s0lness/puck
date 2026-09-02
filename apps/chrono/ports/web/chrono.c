// PORT: chrono on packs/web (Web-Touch). See README.md in this directory
// for the verdict and for the exact diff against the reference.
//
// This file is apps/chrono/reference/rp2350-touch-amoled-18/chrono.c with
// TWO edits, and no third:
//
//   1. its `const app_t g_chronoApp = {...}` initializer is replaced by
//      the two-line port_enter/port_tick adapter at the bottom, because
//      the web pack's --app build generates the app_t itself (the same
//      contract the rp2350 pack's own --app flag uses, adopted unchanged -
//      see packs/web/wasm/build.ts);
//   2. the layout block below states the reference layout as PROPORTIONS
//      of LAND_W/LAND_H (gfx.h) instead of as the eleven numbers the
//      reference writes out, so this port can be compiled against a device
//      whose panel is not 368x448 (packs/web/wasm/build.ts's --device, and
//      docs/convention/device-pack.md's silhouette packs). Every one of
//      those expressions evaluates to the reference's own number on a
//      368x448 panel, which is why chrono's recorded frames still match at
//      tolerance 0: see that block's own comment for the arithmetic.
//
// Everything else is byte-for-byte the reference: the same include lines,
// the same state struct, the same arithmetic, the same
// redraw-only-what-changed loop. Nothing was retargeted, not even an
// include path, because the web pack vendors app.h, gfx.h, digits.h and
// sensors.h under those exact names.
//
// chrono: a stopwatch, now an app inside the single-binary runtime rather
// than its own flash slot. Ported from apps/chrono/main.c, which was proven
// on real hardware; the digit renderer, the layout constants and the
// elapsed-time bookkeeping below are that file's, carried over rather than
// re-derived. What is gone is everything the runtime now owns outright:
// panel init, the framebuffer, the push, the button chips and the menu
// gesture. See this app's git history (apps/chrono/main.c) for the fuller
// standalone version this was cut from.
//
// Display: "MM:SS:CC", minutes, seconds, centiseconds, colon throughout
// (always ":", never a locale-flavoured comma; the owner asked for this
// specifically, see digits.h).
#include <stdio.h>

#include "app.h"
#include "digits.h"
#include "gfx.h"
#include "sensors.h"

/* ---------------------------------------------------------------------
 * Layout, in LANDSCAPE coordinates (LAND_W wide x LAND_H tall, gfx.h: the
 * panel's own dimensions swapped). 6 digits + 2 colons, sized to
 * comfortably fill the landscape width with an even margin on both sides,
 * vertically centred in the landscape height.
 *
 * DERIVED FROM THE PANEL, NOT WRITTEN DOWN. The reference layout is the
 * one the descriptor states (448 x 368: digits 48 x 120, separators 24
 * wide, 12px gaps, 14px margins, y 124), and every number below is the
 * PROPORTION that layout is, so the same face comes out of a 240x135
 * panel. The row is eight elements wide - six digits, two separators at
 * half a digit each - with a gap of a quarter digit between each pair and
 * a margin of 14/48 of a digit at both ends:
 *
 *   6 D + 2 (D/2) + 7 (D/4) + 2 (14D/48) = 28D/3 = LAND_W
 *
 * so DIGIT_W is 3 * LAND_W / 28, which is exactly 48 at 448 and 25 at 240.
 * The margin is then whatever is left over, halved, which keeps the row
 * centred at any width instead of trusting the division to come out even.
 *
 * DIGIT_H is the digit's landscape *height* (its long axis, since digits
 * stand upright), and it is the dimension that becomes the panel push's
 * row length after rotation (gfx_land_rect swaps w and h). It is kept a
 * multiple of 8 for exactly the reason gfx_push rounds row length up to a
 * multiple of 8: so that rounding never has anything to do, and every
 * digit push is exactly its drawn size with no padding. 120/368 reduces to
 * 15/46, and rounding that DOWN to a multiple of 8 is a no-op at 368
 * (120 already is one) and gives 40 at 135.
 *
 *   layout, left to right (element widths in brackets, all landscape x):
 *   [D][D] [D/2 :] [D][D] [D/2 :] [D][D]
 *    MM tens/units   SS tens/units   CC tens/units
 * ------------------------------------------------------------------- */
#define DIGIT_W (3 * LAND_W / 28)
#define DIGIT_H (((LAND_H * 15 / 46)) & ~7)
#define SEG_T   (DIGIT_W * 3 / 8)
#define SEP_W   (DIGIT_W / 2)
#define GAP_W   (DIGIT_W / 4)
#define ROW_W   (6 * DIGIT_W + 2 * SEP_W + 7 * GAP_W)
#define MARGIN  ((LAND_W - ROW_W) / 2)
#define Y0      ((LAND_H - DIGIT_H) / 2)

#define X_MM_TENS  MARGIN
#define X_MM_UNITS (X_MM_TENS + DIGIT_W + GAP_W)
#define X_COLON1   (X_MM_UNITS + DIGIT_W + GAP_W)
#define X_SS_TENS  (X_COLON1 + SEP_W + GAP_W)
#define X_SS_UNITS (X_SS_TENS + DIGIT_W + GAP_W)
#define X_COLON2   (X_SS_UNITS + DIGIT_W + GAP_W)
#define X_CS_TENS  (X_COLON2 + SEP_W + GAP_W)
#define X_CS_UNITS (X_CS_TENS + DIGIT_W + GAP_W)

static const int DIGIT_X[6] = { X_MM_TENS, X_MM_UNITS, X_SS_TENS, X_SS_UNITS, X_CS_TENS, X_CS_UNITS };

/* ---------------------------------------------------------------------
 * State. One struct, allocated from the arena in enter() (see app.h's
 * arena section: file-scope statics are not acceptable once every app
 * shares one image). s_state is a pointer to that allocation, not the
 * state itself: it has to live somewhere for tick() to find it again, and a
 * few bytes for a pointer is not the budget the arena rule is guarding
 * against.
 * ------------------------------------------------------------------- */
typedef struct {
    bool     running;
    // Elapsed time in milliseconds rather than microseconds: app_frame_t
    // only ever hands out f->nowMs, and a centisecond-resolution display has
    // no use for finer precision than that, so the arithmetic below is the
    // original us-based version with every unit relabelled ms and the
    // us-per-centisecond divisor (10000) replaced with the ms-per-centisecond
    // one (10).
    uint32_t elapsedMs;   // accumulated across all completed run segments
    uint32_t runStartMs;  // f->nowMs at the start of the current segment
    int      lastDigit[6];
} chrono_state_t;

static chrono_state_t *s_state;

/* ---------------------------------------------------------------------
 * enter(): draws the full face, zeroed, into the white framebuffer the
 * runtime has just cleared. Does not push: the runtime pushes the whole
 * panel once after this returns.
 * ------------------------------------------------------------------- */
static void chrono_enter(void) {
    s_state = APP_STATE(chrono_state_t);

    // Separators never change once drawn, so they are drawn once here and
    // never touched (and never pushed) again.
    digits_draw_colon(X_COLON1, Y0, SEP_W, DIGIT_H, SEG_T, PX_BLACK);
    digits_draw_colon(X_COLON2, Y0, SEP_W, DIGIT_H, SEG_T, PX_BLACK);

    for (int i = 0; i < 6; i++) {
        digits_draw(DIGIT_X[i], Y0, DIGIT_W, DIGIT_H, SEG_T, 0, PX_BLACK);
        // s_state->lastDigit[i] is already 0: APP_STATE zeroes the
        // allocation, and 0 is exactly the value just drawn.
    }

    printf("chrono: entered, stopped at 00:00:00\r\n");
}

/* ---------------------------------------------------------------------
 * tick(): updates and pushes only the digit cells that changed.
 * ------------------------------------------------------------------- */
static void chrono_tick(const app_frame_t *f) {
    chrono_state_t *s = s_state;

    if (f->bootClicked) {
        s->running = false;
        s->elapsedMs = 0;
        printf("chrono: BOOT click, reset to 00:00:00\r\n");
    }

    if (f->key & KEY_SHORT) {
        // Toggle immediately on the short-press event the runtime hands us,
        // and do the elapsed-time arithmetic right here, before the digit
        // redraw below runs in this SAME tick. That is the whole fix for
        // the responsiveness complaint ("the chronometer is too slow when
        // stopping"): the old standalone app was already careful to toggle
        // on the press edge rather than waiting for a release verdict, and
        // to do so before any drawing that tick, so the frozen time appears
        // at once rather than on the next timer update. Nothing here defers
        // to a later tick.
        if (s->running) {
            s->elapsedMs += f->nowMs - s->runStartMs;
            s->running = false;
        } else {
            s->runStartMs = f->nowMs;
            s->running = true;
        }
    }

    uint32_t shownMs = s->running ? s->elapsedMs + (f->nowMs - s->runStartMs) : s->elapsedMs;
    uint32_t totalCs = shownMs / 10; // 1 centisecond = 10ms
    // Minutes wrap at 100 so the layout stays fixed at 2 digits; a
    // stopwatch running past 99:59:99 is not a case this puck's use needs
    // to handle cleanly.
    uint32_t mm = (totalCs / 6000) % 100;
    uint32_t ss = (totalCs / 100) % 60;
    uint32_t cs = totalCs % 100;
    int digits[6] = {
        (int)(mm / 10), (int)(mm % 10),
        (int)(ss / 10), (int)(ss % 10),
        (int)(cs / 10), (int)(cs % 10),
    };

    // Only repaint digits that actually changed, in this same tick. Each
    // push here covers exactly one DIGIT_W x DIGIT_H landscape digit cell,
    // and DIGIT_H is a multiple of 8 by construction (see the layout block
    // above: 120 on this panel), so gfx_push_land never has to pad
    // the pushed window's row length (the panel-space width, which is this
    // cell's landscape height after rotation).
    for (int i = 0; i < 6; i++) {
        if (digits[i] == s->lastDigit[i]) continue;
        digits_clear(DIGIT_X[i], Y0, DIGIT_W, DIGIT_H, PX_WHITE);
        digits_draw(DIGIT_X[i], Y0, DIGIT_W, DIGIT_H, SEG_T, digits[i], PX_BLACK);
        gfx_push_land(DIGIT_X[i], Y0, DIGIT_W, DIGIT_H);
        s->lastDigit[i] = digits[i];
    }
}

// THE ONLY EDIT AGAINST THE REFERENCE. The reference ends with a named
// `const app_t g_chronoApp` carrying name/enter/tick/leave/landscape/
// wantsShake; on this pack those six fields are the build's, not the
// file's (packs/web/wasm/build.ts generates the app_t from --app plus
// --landscape/--shake), so the file supplies the two callbacks and nothing
// else. The port is built with --landscape and WITHOUT --shake, which sets
// exactly the two flags the reference set here.
//
// wantsShake stays false, and the reference's reason carries over word for
// word onto a phone: shake is the Etch-A-Sketch gesture and belongs only
// where erasing IS the app's identity. A stopwatch that resets when its
// owner runs with the phone in a pocket is a broken stopwatch. If anything
// a phone makes this MORE important than the puck did, since a phone is
// carried all day and the web pack's shake detector fires off the same
// accelerometer a walk shakes.
void port_enter(void) {
    chrono_enter();
}

void port_tick(const app_frame_t *f) {
    chrono_tick(f);
}
