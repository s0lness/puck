/*
 * gfx: the framebuffer and the panel push, owned by the runtime.
 *
 * This exists because the three rules below were, until this file, copied
 * into four places (firmware/main.c, apps/chrono/main.c, firmware/menu.c and
 * firmware/rot.h's contract) and every copy was one edit away from drifting
 * out of sync with the others:
 *
 *   1. every pushed window's row length must be a multiple of 8 pixels,
 *      or AMOLED_1IN8_DisplayWindows corrupts the transfer
 *      (docs/decisions/0001-push-min-width.md - this one cost days);
 *   2. the framebuffer is byte-swapped RGB565, because it is DMA'd out raw;
 *   3. landscape apps draw through a rotation, portrait apps do not.
 *
 * An app never calls AMOLED_1IN8_DisplayWindows itself. It draws into the
 * framebuffer and names a dirty rectangle; gfx is what makes that rectangle
 * legal. That is the whole point of centralising it: an app cannot violate
 * the 8-pixel rule because an app is never in a position to.
 */
#ifndef GFX_H
#define GFX_H

#include <stdbool.h>
#include <stdint.h>

// DEV_Config.h first, and not by accident: the vendor's AMOLED_1in8.h uses
// UWORD and UBYTE without including whatever defines them, so it only
// compiles in a translation unit that already pulled DEV_Config.h in. Every
// vendor demo happens to satisfy that by ordering its includes a particular
// way in main.c, which is why upstream never noticed. Including it here
// makes gfx.h self-contained instead of leaving the trap for the next file
// that includes it first.
#include "DEV_Config.h"
#include "AMOLED_1in8.h"

// Panel (native, portrait) dimensions. 368 wide x 448 tall.
#define PANEL_W AMOLED_1IN8_WIDTH
#define PANEL_H AMOLED_1IN8_HEIGHT

// How many pixels, along EVERY edge, the physical case hides. The
// framebuffer is the panel's full 368x448 and the firmware addresses all
// of it - this is not a drawing bug, it is the visible area being smaller
// than the glass. Found 2026-08-14 from a photograph of the real device
// (the owner's own sketchpad palette had its outer row and columns
// running under the case): "l'ecran est legerement plus tronque que
// prevu... je pense que tu peux shave quelques pixels sur les bords".
//
// THE NUMBER IS DELIBERATELY ROUGH. A photograph taken at an angle cannot
// measure a bezel to the pixel, and this is not trying to: 10 is an
// order-of-magnitude guess, conservative (a little too much margin costs
// a little less canvas; a little too little leaves the exact defect this
// exists to fix). Tunable in this ONE place on purpose, so the owner can
// judge the real device and either of us can correct it in one edit
// without hunting down every app that used it.
//
// EVERY APP THAT DRAWS EDGE TO EDGE NEEDS THIS, not just the one that
// found it - the sketchpad's own colour palette was the first (see
// firmware/apps/sketch.c's own use of it), and Connect Four's board is
// the next, already in flight in another agent's own change. The rule
// this constant exists to enforce, for every app from now on: nothing a
// child needs to actually see - a button's own edge, a rounded corner, a
// piece of text - belongs inside PANEL_BEZEL_MARGIN_PX of the panel's own
// boundary. A shape clipped by a straight framebuffer edge is invisible
// in the emulator, which has no bezel to hide anything behind by
// definition (decision 0003) - a human looking at the real device is the
// only test that will ever catch this, which is exactly why the margin
// gets a name and a shared home instead of staying a fact only one app's
// own code happened to know.
#define PANEL_BEZEL_MARGIN_PX 10

// Landscape canvas: the panel's dimensions swapped. Landscape apps work in
// this space and gfx rotates for them, so the buttons end up along the top
// edge when the device is held sideways (see gfx_land_rect).
#define LAND_W PANEL_H
#define LAND_H PANEL_W

/* ---- pixel format ------------------------------------------------------
 *
 * The panel wants RGB565 with the opposite byte order to how the CPU stores
 * a uint16_t. Pure black and pure white are byte-palindromes and look right
 * either way, which is why this stayed invisible until anti-aliasing put
 * mid-greys on the screen and stroke edges turned into colour speckle.
 */
static inline uint16_t px_swap(uint16_t v) {
    return (uint16_t)((v >> 8) | (v << 8));
}

// The panel is used as monochrome (white paper, black ink), so the 6-bit
// green channel doubles as an 8-bit ink/coverage value and no separate alpha
// buffer is needed.
static inline uint8_t px_to_gray(uint16_t px) {
    uint16_t v = px_swap(px);
    return (uint8_t)(((v >> 5) & 0x3F) << 2);
}

static inline uint16_t gray_to_px(uint8_t g) {
    uint16_t v = (uint16_t)(((g >> 3) << 11) | ((g >> 2) << 5) | (g >> 3));
    return px_swap(v);
}

#define PX_WHITE 0xFFFF
#define PX_BLACK 0x0000

/* ---- the framebuffer ---------------------------------------------------
 *
 * One full 368*448*2 = 330KB buffer, allocated once at startup and never
 * freed. It fits in the 520KB SRAM, which is what lets this device push
 * dirty rectangles instead of rendering in bands like its ESP32-S3 sibling
 * has to. Apps draw into it directly; it survives an app switch, which is
 * why the runtime clears it on switch rather than trusting the next app to.
 */
extern uint16_t *gfx_fb;

// Allocates the framebuffer, fills it white and shows it. Call once, on
// core0, before core1 is launched. Returns false if the allocation failed,
// which on this board means something else has already eaten the SRAM.
bool gfx_init(void);

/* ---- drawing, panel (portrait) coordinates ----------------------------- */

// Clipped to the panel, so a caller may pass a rectangle that runs off the
// edge without checking first.
void gfx_fill_rect(int x, int y, int w, int h, uint16_t colorPx);

/* ---- pushing to the panel ---------------------------------------------
 *
 * gfx_push takes an INCLUSIVE dirty rectangle in panel coordinates and is
 * where rule 1 lives: it widens the window to a multiple of 8 pixels and,
 * at the right-hand edge, slides the window LEFT rather than clipping its
 * width, because a clipped width is exactly the corruption case. Passing a
 * one-pixel-wide rectangle is fine and normal.
 *
 * Callers pass the rectangle they actually dirtied. They must not
 * pre-round it: rounding twice is not idempotent at the panel edge.
 */
void gfx_push(int minX, int minY, int maxX, int maxY);

// Pushes the whole panel. Used on app switch and on the full-refresh
// gesture. Costs about 12ms, so it is not a per-frame operation.
void gfx_push_all(void);

/* ---- landscape helpers -------------------------------------------------
 *
 * Mapping: landscape (lx, ly) -> panel (PANEL_W - 1 - ly, lx). A landscape
 * rectangle (lx, ly, w, h) becomes the panel rectangle
 * (PANEL_W - (ly + h), lx, h, w): width and height swap, as any 90 degree
 * rotation must. Lifted unchanged from firmware/rot.h, which this replaces;
 * see its git history for the other-way-round mapping that came out upside
 * down on real hardware.
 *
 * Note what this does NOT do: it rotates rectangles, not pixels. An app
 * drawing individual pixels in landscape must map its own coordinates. The
 * two landscape apps (chrono, timer) draw only rectangles, by construction:
 * their digits are seven filled bars.
 */
void gfx_land_rect(int lx, int ly, int w, int h,
                   int *px, int *py, int *pw, int *ph);

void gfx_fill_rect_land(int lx, int ly, int w, int h, uint16_t colorPx);

// Landscape (x, y, w, h), NOT inclusive corners, unlike gfx_push. The
// asymmetry is deliberate: landscape callers are always filling and pushing
// the same rectangle, and having both take (w, h) removes the off-by-one
// that an inclusive form invites at every call site.
void gfx_push_land(int lx, int ly, int w, int h);

/* ---- push-load telemetry ------------------------------------------------
 *
 * How many gfx_push()/gfx_push_all() calls have actually reached the panel,
 * and how many pixels they touched, since the counters were last reset.
 * This is the on-device answer to the same question
 * harness/invariantTypes.ts's PushLoadStats asks of the emulator (via
 * emu_push_count()/emu_push_w()/emu_push_h(), replayed from a trace):
 * apps/fluidbox/invariants.ts's panel-push invariant bounds the worst tick's
 * push load, and a board has no trace to replay it against, only its own
 * running counters.
 *
 * Wired to devlink's PUSHSTATS command (see ../devlink.h's push_stats_get/
 * push_stats_reset hooks and tools/README-devlink.md): devlink_send_shot()
 * resets these at the start of every SHOT, so a PUSHSTATS reply answers
 * "since the last screenshot" - the window a harness can bracket by asking
 * for stats right before it asks for the next frame.
 */
void gfx_push_stats_reset(void);
void gfx_push_stats_get(uint32_t *pushes, uint32_t *pixels);

#endif // GFX_H
