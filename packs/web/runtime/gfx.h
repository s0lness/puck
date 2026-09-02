/*
 * VENDORED from packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h (MIT,
 * same repository). This is the ONE vendored header that is not
 * byte-for-byte: the sibling's copy includes two Waveshare vendor headers
 * (DEV_Config.h, AMOLED_1in8.h) purely to reach AMOLED_1IN8_WIDTH/HEIGHT,
 * and a browser has no vendor driver to include. The two #includes are
 * gone and PANEL_W/PANEL_H are the same two numbers written out. Nothing
 * else changed: every declaration, every constant, and every comment
 * below is the sibling's, deliberately including the SH8601's 8-pixel
 * row-length rule, which no browser has.
 *
 * WHY KEEP A RULE THE BROWSER DOES NOT HAVE. gfx_push()'s widening is
 * observable to an app only through what lands on the panel, and on the
 * board it is load-bearing (docs/decisions/0001-push-min-width.md, days
 * of debugging). Dropping it here would make this pack's gfx_push() a
 * DIFFERENT function from the sibling's, so a port that happens to depend
 * on the widened rectangle would diverge between the two targets - and
 * this pack exists to prove the same source behaves the same way. A
 * browser paying eight pixels of alignment it does not need costs
 * nothing; a browser that quietly disagrees with the board costs the
 * whole claim.
 *
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

// Panel (native, portrait) dimensions. 368 wide x 448 tall.
//
// Literal here, where the sibling reads them from the vendor's
// AMOLED_1in8.h (see this file's vendoring note). They must match
// device.json's "panel" and emu_shim.c's emu_device() JSON: three copies,
// one number, and gate/device-agrees.ts is what checks they agree.
//
// GUARDED, so a --device build (wasm/build.ts) can compile this pack's
// runtime and an app's own C against ANOTHER device's panel size, the way
// a silhouette pack needs (docs/convention/device-pack.md). The numbers
// below stay this device's own and stay checked against its device.json;
// -D on the command line is the only thing that ever displaces them, and
// it displaces them for every translation unit at once, which is what
// keeps the framebuffer, the clip rectangles and the app agreeing.
#ifndef PANEL_W
#define PANEL_W 368
#endif
#ifndef PANEL_H
#define PANEL_H 448
#endif

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

#endif // GFX_H
