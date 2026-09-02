// gfx: the framebuffer and the panel push, owned by the runtime.
//
// See gfx.h's header comment for why this exists. Everything below is lifted
// from the three places that used to each carry their own copy:
// firmware/main.c (gfx_init, gfx_push), apps/chrono/main.c (gfx_fill_rect)
// and firmware/rot.h (gfx_land_rect, gfx_fill_rect_land, gfx_push_land).
// Comments that carry the hard-won reasoning (the 8-pixel rule especially)
// are kept, not summarised.
#include "gfx.h"

#include <stdlib.h>
#include <stdio.h>

uint16_t *gfx_fb = NULL;

bool gfx_init(void) {
    gfx_fb = (uint16_t *)malloc((size_t)PANEL_W * PANEL_H * 2);
    if (gfx_fb == NULL) {
        printf("framebuffer allocation failed\r\n");
        return false;
    }
    for (int i = 0; i < PANEL_W * PANEL_H; i++) gfx_fb[i] = 0xFFFF;
    // The boot test pattern (grey ramp plus four capsules at the pen's radii)
    // did its job: it proved the panel renders neutral greys correctly and put
    // the corruption on the partial-refresh path rather than the pixel format.
    AMOLED_1IN8_Display(gfx_fb);
    return true;
}

/* ---- drawing, panel (portrait) coordinates ----------------------------- */

// Lifted from apps/chrono/main.c's fill_rect(), which already clips to the
// panel so callers may pass rectangles that run off the edge without
// checking first.
void gfx_fill_rect(int x, int y, int w, int h, uint16_t colorPx) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;
    for (int j = 0; j < h; j++) {
        uint16_t *row = gfx_fb + (size_t)(y + j) * PANEL_W + x;
        for (int i = 0; i < w; i++) row[i] = colorPx;
    }
}

/* ---- pushing to the panel ---------------------------------------------
 *
 * Row length granularity, in pixels. Bisected on hardware: a window whose row
 * length is not a multiple of 8 pixels (16 bytes) comes out corrupted, and
 * that is the whole rule. An earlier fix also forced a 64 pixel minimum width,
 * which worked but was pure overhead: the narrow columns in the bisect were
 * clean as long as their row length was a multiple of 8. See
 * docs/decisions/0001-push-min-width.md for the bisect that settled this.
 */
#define PUSH_GRAN_W 8
#define PUSH_MIN_W  8

// Push-load telemetry (gfx.h's own header comment says what these answer
// and why). Plain globals, not atomics: both are only ever touched from
// core0 (gfx_push/gfx_push_all are core0-only, same as every other drawing
// call in this file, and devlink_send_shot()'s reset call runs on core0
// too - core1 never touches gfx at all, see sensors.h's ownership rule).
static uint32_t g_pushCount = 0;
static uint32_t g_pushPixels = 0;

void gfx_push_stats_reset(void) {
    g_pushCount = 0;
    g_pushPixels = 0;
}

void gfx_push_stats_get(uint32_t *pushes, uint32_t *pixels) {
    if (pushes) *pushes = g_pushCount;
    if (pixels) *pixels = g_pushPixels;
}

// Pushes the accumulated dirty rect. AMOLED_1IN8_DisplayWindows takes an
// exclusive end and the panel wants even alignment, so round start down
// and exclusive end up to even, then clamp to the panel.
void gfx_push(int minX, int minY, int maxX, int maxY) {
    if (minX > maxX || minY > maxY) return;
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > PANEL_W - 1) maxX = PANEL_W - 1;
    if (maxY > PANEL_H - 1) maxY = PANEL_H - 1;

    // Windows are aligned to 8 pixels and never narrower than PUSH_MIN_W.
    //
    // Why: a vertical stroke makes a tall, narrow dirty rect, and the driver
    // pushes one row per DMA, so a narrow window means hundreds of transfers
    // of a few dozen bytes each. Those came out shredded into horizontal ticks
    // while the horizontal parts of the very same stroke were clean, and
    // full-screen refreshes (the widest case) were always perfect. The defect
    // tracked window width, not anything in the touch or stroke code.
    //
    // Padding costs a little more data per push and buys back correctness. It
    // is deliberately two changes at once, alignment and minimum width; which
    // of the two actually matters still has to be bisected.
    // x0 is only aligned to 2, not to 8. The bisect showed an unaligned start
    // with a rounded row length is clean, so aligning the start is not part of
    // the fix and would only widen the window for nothing.
    int x0 = minX & ~1;
    int w = maxX + 1 - x0;
    w = (w + PUSH_GRAN_W - 1) & ~(PUSH_GRAN_W - 1);
    if (w < PUSH_MIN_W) w = PUSH_MIN_W;
    int x1 = x0 + w;
    if (x1 > PANEL_W) {
        // Slide the window left rather than clipping its width, since
        // shortening the row is exactly what corrupts it. The panel is 368
        // wide, a multiple of 8, so a left-slid window stays aligned.
        x0 = PANEL_W - w;
        if (x0 < 0) { x0 = 0; w = PANEL_W; }
        x0 &= ~1;
        x1 = x0 + w;
        if (x1 > PANEL_W) { x0 = PANEL_W - w; x1 = PANEL_W; }
    }

    int y0 = minY & ~1;
    int y1 = maxY + 1;
    if (y1 & 1) y1++;
    if (y1 > PANEL_H) y1 = PANEL_H;
    if (y1 <= y0) y1 = y0 + 2;

    g_pushCount++;
    g_pushPixels += (uint32_t)(x1 - x0) * (uint32_t)(y1 - y0);

    AMOLED_1IN8_DisplayWindows(x0, y0, x1, y1, gfx_fb);
}

// Pushes the whole panel. Used on app switch and on the full-refresh
// gesture. Costs about 12ms, so it is not a per-frame operation.
void gfx_push_all(void) {
    g_pushCount++;
    g_pushPixels += (uint32_t)PANEL_W * (uint32_t)PANEL_H;
    AMOLED_1IN8_Display(gfx_fb);
}

/* ---- landscape helpers --------------------------------------------------
 *
 * Lifted unchanged from firmware/rot.h's land_to_panel_rect() /
 * fill_rect_land() / push_dirty_land(). Mapping: landscape (lx, ly), lx in
 * [0, LAND_W), ly in [0, LAND_H), maps to panel (px, py) =
 * (PANEL_W - 1 - ly, lx). Rotated so the wanted orientation, buttons along
 * the top edge, comes out right; see apps/chrono/main.c's git history for
 * the (rejected) 90-degrees-the-other-way mapping that came out upside down
 * on real hardware.
 *
 * Corners of a landscape rectangle (lx, ly, w, h) under that map:
 *   (lx,     ly    ) -> (PANEL_W-1-ly,       lx      )
 *   (lx+w-1, ly    ) -> (PANEL_W-1-ly,       lx+w-1  )
 *   (lx,     ly+h-1) -> (PANEL_W-1-(ly+h-1), lx      )
 *   (lx+w-1, ly+h-1) -> (PANEL_W-1-(ly+h-1), lx+w-1  )
 * px spans [PANEL_W-(ly+h), PANEL_W-1-ly], a run of length h.
 * py spans [lx, lx+w-1], a run of length w.
 * So the panel rectangle is (px = PANEL_W-(ly+h), py = lx, width = h,
 * height = w): width and height swap, as any 90 degree rotation must.
 */
void gfx_land_rect(int lx, int ly, int w, int h,
                   int *px, int *py, int *pw, int *ph) {
    *px = PANEL_W - (ly + h);
    *py = lx;
    *pw = h;
    *ph = w;
}

void gfx_fill_rect_land(int lx, int ly, int w, int h, uint16_t colorPx) {
    int px, py, pw, ph;
    gfx_land_rect(lx, ly, w, h, &px, &py, &pw, &ph);
    gfx_fill_rect(px, py, pw, ph, colorPx);
}

// Landscape (lx, ly, w, h), NOT inclusive corners, unlike gfx_push (see
// gfx.h). Converted to a panel rectangle via gfx_land_rect(), then to the
// inclusive corners gfx_push wants, so the 8-pixel row-length rule still
// applies, now to the rotated (panel-space) width.
void gfx_push_land(int lx, int ly, int w, int h) {
    int px, py, pw, ph;
    gfx_land_rect(lx, ly, w, h, &px, &py, &pw, &ph);
    gfx_push(px, py, px + pw - 1, py + ph - 1);
}
