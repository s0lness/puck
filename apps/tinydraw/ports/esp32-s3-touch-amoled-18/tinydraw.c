// tinydraw.c: an adaptation of aliceisjustplaying/tinydraw (MIT) onto this
// pack's --app contract (app.h's enter()/tick()/draw_band(); see
// apps/tinydraw/descriptor.md for the Essence/Interactions/Demands this was
// extracted from and this port's own README.md for the verdict).
//
// WHY THIS IS A FRESH FILE, NOT A COPY OF THE OTHER TWO PORTS. The rp2350
// and web ports (apps/tinydraw/ports/rp2350-touch-amoled-18/tinydraw.c,
// byte-identical to apps/tinydraw/ports/web/tinydraw.c) share ONE contract:
// a persistent full-panel framebuffer (gfx_fb[]), incremental gfx_push()
// calls after each stroke segment, and a 65536-byte app arena. Nothing
// about that compiles here. This pack's whole reason to exist next to the
// RP2350 sibling is that it has NO framebuffer anywhere (AGENTS.md, "THE
// MEMORY MODEL"): the panel is painted 28 rows at a time through
// draw_band(), called once per band, EVERY frame, for all 16 bands, with a
// band buffer's prior content UNDEFINED (app.h's header comment) - there is
// nothing to diff against and no "only push what changed" shortcut.
//
// So the port keeps the donor's stroke-storage IDEA (record world-space
// points and radii, replay them to a fresh panel on demand - see the
// sibling ports' own header comments) but restructures it around this
// pack's contract instead of adapting the sibling's incremental-push code:
//
//   - tick() ONLY updates state (recognises touch, appends stroke points,
//     handles BOOT/PWR) - app.h forbids drawing before every band is drawn,
//     and there is no framebuffer to draw into yet regardless.
//   - draw_band() replays the ENTIRE stroke history, reprojected at the
//     current zoom level, clipped to whichever 28-row band it was handed.
//     Because every frame already redraws every band from scratch (the
//     pack's own contract, not an optimisation this port chose), there is
//     no separate "repaint on this discrete action" path the sibling ports
//     need: BOOT and PWR just mutate state in tick(), and the very next
//     draw_band() pass reflects it for free.
//
// SMALLER CAPACITY, A REAL COST OF THIS PACK, NAMED RATHER THAN HIDDEN.
// APP_ARENA_BYTES here is 8192 (app.h), against the sibling packs' 65536:
// this board's whole app arena is smaller than the sibling's single stroke
// point array. TD_MAX_POINTS/TD_MAX_STROKES below are sized to fit inside
// that budget (checked at compile time by tinydraw_arena_budget_check), a
// tighter cap on the same already-bounded, already-degraded stroke history
// the sibling ports' own READMEs document - see this port's own README.md.
//
// NO MATH.H: this pack's own comments (AGENTS.md, wasm/build.ts's header,
// wasm/emu_shim.c's own note "this pack's C uses no math functions at all")
// say plainly that wasm32-freestanding is built with none of stdlib.h,
// stdio.h or math.h available - only the freestanding-guaranteed headers
// (stdbool.h, stddef.h, stdint.h) app.h and gfx_band.h already use. The
// sibling ports' <math.h> calls (sqrtf, sinf, floorf, ceilf) are therefore
// replaced below with small self-contained equivalents: rt_sqrtf() (a
// classic bit-hack seed plus three Newton-Raphson steps on 1/sqrt(x), then
// inverted), ifloorf()/iceilf() (integer truncation with a sign fixup), and
// an ease-out-QUADRATIC pressure curve (2t - t^2) in place of the donor's
// ease-out-sine, chosen specifically because it needs neither trig nor a
// square root: sinf(t*pi/2) has no cheap freestanding substitute here worth
// the code, and the invariants this port is checked against (a mid-band
// stroke reading visibly thicker than either end) only need a monotonic,
// concave easing curve, which 2t - t^2 already is.
//
// WHAT WAS CARRIED OVER FROM THE DESCRIBED ESSENCE (same as the sibling
// ports, restated briefly - see their own header comments for the fuller
// donor-vs-port accounting): ink is variable-width, antialiased, coverage-
// based capsules, width from touch SPEED (this controller family reports no
// real pressure - descriptor.md's own Demands section). Zoom is two levels
// (1x, 2x) about the panel's own centre, not the donor's continuous 25-400%
// pannable camera. Undo pops the single most recent STROKE and repaints
// from the remaining stroke geometry, not the donor's ten tile-based slots.
//
// WHAT WAS DELIBERATELY DROPPED (named, not silently missing - same list
// the sibling ports give, still true here): colour, pen size/eraser/tool
// selection, pan, "New" confirm dialog, autosave/journal, PNG/SVG export,
// USB mass storage, NTP/clock, battery status, curve fitting between touch
// samples, and end taper. All out of scope per descriptor.md's Demands, or
// (curve fitting, end taper) flagged as a natural next step, not attempted.
#include <stdbool.h>
#include <stdint.h>

#include "app.h"
#include "gfx_band.h"

/* ---------------------------------------------------------------------
 * Small freestanding math this pack does not provide (see this file's
 * header comment on why <math.h> is not an option here).
 * ------------------------------------------------------------------- */

// Classic fast inverse-square-root seed (the exact bit constant tinydraw's
// own donor family and countless others use) plus three Newton-Raphson
// refinements, then inverted back to sqrt(x) = x * (1/sqrt(x)). Accurate to
// a small fraction of a percent, which is far tighter than this port's
// antialiasing coverage math (a single 0-255 grey level) needs.
static float rt_sqrtf(float x) {
    if (x <= 0.0f) return 0.0f;
    union { float f; uint32_t u; } conv;
    conv.f = x;
    conv.u = 0x5f3759dfu - (conv.u >> 1);
    float y = conv.f;
    y = y * (1.5f - 0.5f * x * y * y);
    y = y * (1.5f - 0.5f * x * y * y);
    y = y * (1.5f - 0.5f * x * y * y);
    return x * y;
}

static int ifloorf(float v) {
    int i = (int)v;
    if ((float)i > v) i -= 1;
    return i;
}

static int iceilf(float v) {
    int i = (int)v;
    if ((float)i < v) i += 1;
    return i;
}

/* ---------------------------------------------------------------------
 * Pen shape. Screen-space (not world-space) radius bounds, so the pen
 * FEELS the same size under the finger regardless of the current zoom
 * level, the same reasoning the sibling ports give for storing a WORLD
 * radius per point (screen radius / zoom at the moment it was drawn) so a
 * later zoom change reprojects it consistently.
 * ------------------------------------------------------------------- */
#define MIN_RADIUS_PX     1.0f
#define MAX_RADIUS_PX     7.0f
#define SPEED_MAX_PXMS    3.0f   // screen px/ms at which the pen goes to its thinnest
#define PRESSURE_LERP     0.3f   // rate-limits width change so a noisy per-tick speed sample cannot make the line flicker
#define MIN_STEP_PX       0.4f   // screen-space dedupe: a touch report this close to the last one draws nothing

// Ease-out-quadratic: 2t - t^2. Monotonic, concave, f(0)=0, f(1)=1, needs
// neither trig nor a square root - see this file's header comment for why
// this replaces the donor/sibling ports' ease-out-sine here specifically.
static float ease_out_quad(float t) {
    float u = 1.0f - t;
    return 1.0f - u * u;
}

// Fast = light, slow = heavy (the same model the sibling ports use):
// pressure in [0,1] eases into a screen-space radius.
static float radius_from_pressure(float pressure) {
    float r = MIN_RADIUS_PX + (MAX_RADIUS_PX - MIN_RADIUS_PX) * ease_out_quad(pressure);
    if (r < MIN_RADIUS_PX) r = MIN_RADIUS_PX;
    if (r > MAX_RADIUS_PX) r = MAX_RADIUS_PX;
    return r;
}

/* ---------------------------------------------------------------------
 * Zoom. Two fixed levels about the panel's own center - see this file's
 * header comment on why not the donor's continuous, pannable camera.
 * ------------------------------------------------------------------- */
#define ZOOM_LEVELS 2
static const float kZoom[ZOOM_LEVELS] = {1.0f, 2.0f};

static void td_world_to_screen(float wx, float wy, float zoom, float *sx, float *sy) {
    const float cx = PANEL_W * 0.5f, cy = PANEL_H * 0.5f;
    *sx = cx + (wx - cx) * zoom;
    *sy = cy + (wy - cy) * zoom;
}

static void td_screen_to_world(float sx, float sy, float zoom, float *wx, float *wy) {
    const float cx = PANEL_W * 0.5f, cy = PANEL_H * 0.5f;
    *wx = cx + (sx - cx) / zoom;
    *wy = cy + (sy - cy) / zoom;
}

/* ---------------------------------------------------------------------
 * Grey <-> band-pixel round trip. gfx_band.h's rgb565be()/px_swap() pack a
 * grey value into this panel's byte-swapped RGB565 (using r=g=b=grey, same
 * as the sibling ports' gfx.h), but give no way back. draw_capsule_band
 * below needs one to MIN-composite (darkest wins) two capsules that land on
 * the same pixel within a single draw_band() pass, the same reasoning the
 * sibling ports' own capsule rasterizer comment gives: consecutive stroke
 * segments overlap along their shared edge, and alpha blending would
 * re-darken that overlap, turning a smooth antialiased line into a visibly
 * banded one. The green channel carries the most bits (6, against 5 for
 * red/blue), so it is what gets unpacked back to an 8-bit approximation.
 * ------------------------------------------------------------------- */
static uint8_t px_to_gray(uint16_t swapped) {
    uint16_t v = px_swap(swapped); // undo the byte swap: back to rrrrrggggggbbbbb
    uint16_t g6 = (uint16_t)((v >> 5) & 0x3F);
    return (uint8_t)((g6 << 2) | (g6 >> 4));
}

static uint16_t gray_to_px(uint8_t gray) {
    return rgb565be(gray, gray, gray);
}

/* ---------------------------------------------------------------------
 * Antialiased capsule rasterizer, banded: signed-distance-to-segment ->
 * coverage -> MIN composite (darkest wins), the same technique the sibling
 * ports use (see their own header comment), clipped to [y0, y0+rows) - this
 * pack's band, not the sibling ports' full panel - instead of to the whole
 * screen. Splitting a capsule's draw across up to two band calls changes
 * nothing about the per-pixel coverage math (it depends only on that
 * pixel's own distance to the segment), only which pixels get visited in
 * any one call.
 * ------------------------------------------------------------------- */
static void draw_capsule_band(uint16_t *buf, int y0, int rows,
                               float ax, float ay, float r0,
                               float bx, float by, float r1) {
    float maxR = (r0 > r1 ? r0 : r1) + 1.0f;
    int minX = ifloorf((ax < bx ? ax : bx) - maxR);
    int maxX = iceilf((ax > bx ? ax : bx) + maxR);
    int minY = ifloorf((ay < by ? ay : by) - maxR);
    int maxY = iceilf((ay > by ? ay : by) + maxR);
    if (minX < 0) minX = 0;
    if (maxX > PANEL_W - 1) maxX = PANEL_W - 1;
    if (minY < y0) minY = y0;
    if (maxY > y0 + rows - 1) maxY = y0 + rows - 1;
    if (minX > maxX || minY > maxY) return; // bounding box misses this band entirely

    float abx = bx - ax, aby = by - ay;
    float abLenSq = abx * abx + aby * aby;

    for (int iy = minY; iy <= maxY; iy++) {
        float py = (float)iy + 0.5f;
        for (int ix = minX; ix <= maxX; ix++) {
            float px = (float)ix + 0.5f;
            float t = 0.0f;
            if (abLenSq > 0.0001f) {
                t = ((px - ax) * abx + (py - ay) * aby) / abLenSq;
                if (t < 0.0f) t = 0.0f;
                else if (t > 1.0f) t = 1.0f;
            }
            float cx = ax + abx * t, cy = ay + aby * t;
            float dx = px - cx, dy = py - cy;
            float d = rt_sqrtf(dx * dx + dy * dy);
            float r = r0 + (r1 - r0) * t;
            float coverage = r + 0.5f - d;
            if (coverage <= 0.0f) continue;
            if (coverage > 1.0f) coverage = 1.0f;
            uint8_t ink = (uint8_t)((1.0f - coverage) * 255.0f + 0.5f);

            int idx = (iy - y0) * PANEL_W + ix;
            uint8_t cur = px_to_gray(buf[idx]);
            if (ink < cur) buf[idx] = gray_to_px(ink);
        }
    }
}

/* ---------------------------------------------------------------------
 * Stroke history, in the zoom-invariant world frame (see td_screen_to_
 * world above). This IS the document: undo pops the last stroke and the
 * next draw_band() pass replays what remains onto a fresh white band -
 * "keep what was drawn, not a copy of the pixels", same idea the sibling
 * ports use, here mandatory rather than a choice (app.h: every band is
 * repainted from scratch every frame, there is nothing to diff against).
 *
 * TD_MAX_POINTS/TD_MAX_STROKES are far smaller than the sibling ports'
 * (900 points / 64 strokes against a 65536-byte arena): this pack's whole
 * arena is 8192 bytes (app.h's APP_ARENA_BYTES). The build-time check below
 * proves the fit rather than trusting a comment, same technique the sibling
 * ports use for their own arena budget.
 * ------------------------------------------------------------------- */
#define TD_MAX_POINTS  600
#define TD_MAX_STROKES 48

typedef struct { float x, y, r; } td_point_t;
typedef struct { uint16_t startIdx, count; } td_stroke_t;

typedef struct {
    int strokeCount, pointCount;
    td_stroke_t strokes[TD_MAX_STROKES];
    td_point_t  points[TD_MAX_POINTS];

    bool  touchWasDown;
    float lastWorldX, lastWorldY, lastWorldR;
    float pressure;
    int   zoomIndex;
} td_state_t;

typedef char tinydraw_arena_budget_check[(sizeof(td_state_t) <= APP_ARENA_BYTES) ? 1 : -1];

static td_state_t *st;

static void stroke_pool_begin(void) {
    if (st->strokeCount >= TD_MAX_STROKES) return; // full: this stroke silently isn't recorded (documented, not hidden - see this file's header comment)
    st->strokes[st->strokeCount].startIdx = (uint16_t)st->pointCount;
    st->strokes[st->strokeCount].count = 0;
    st->strokeCount++;
}

static void stroke_pool_append(float x, float y, float r) {
    if (st->strokeCount == 0) return;
    if (st->pointCount >= TD_MAX_POINTS) return; // pool full: current stroke stops recording, live drawing is unaffected
    td_point_t *p = &st->points[st->pointCount];
    p->x = x; p->y = y; p->r = r;
    st->pointCount++;
    st->strokes[st->strokeCount - 1].count++;
}

/* ---- app.h contract ---------------------------------------------------- */

void port_enter_impl(void) {
    st = APP_STATE(td_state_t);
    st->zoomIndex = 0;
    // A fresh band always starts from gfxb_fill(PX_WHITE) in draw_band()
    // below - nothing to draw yet on an empty document, so enter() does
    // nothing further.
}

void port_tick_impl(const app_frame_t *f) {
    // BOOT click: undo the most recent stroke. Deliberately a different
    // control from the zoom toggle below - see descriptor.md's own intent
    // note: a destructive action belongs on a control that cannot be hit by
    // accident while doing something else.
    if (f->bootClicked) {
        if (st->strokeCount > 0) {
            st->strokeCount--;
            st->pointCount = st->strokes[st->strokeCount].startIdx;
        }
        return; // the next draw_band() pass repaints from the shrunk history
    }

    // PWR short press: cycle the zoom level. Reprojection happens for free
    // in draw_band() below, reading st->zoomIndex - no explicit repaint
    // call needed on this pack, unlike the sibling ports.
    if (f->key & KEY_SHORT) {
        st->zoomIndex = (st->zoomIndex + 1) % ZOOM_LEVELS;
        return;
    }

    if (!f->touchDown) {
        st->touchWasDown = false;
        return;
    }

    const float zoom = kZoom[st->zoomIndex];
    float wx, wy;
    td_screen_to_world((float)f->touchX, (float)f->touchY, zoom, &wx, &wy);

    if (!st->touchWasDown) {
        // Stroke start: begin recording at the resting (mid) pressure - the
        // same "arc==0" starting radius idea the sibling ports use.
        stroke_pool_begin();
        st->pressure = 0.5f;
        float rScreen = radius_from_pressure(st->pressure);
        float rWorld = rScreen / zoom;
        stroke_pool_append(wx, wy, rWorld);

        st->lastWorldX = wx; st->lastWorldY = wy; st->lastWorldR = rWorld;
        st->touchWasDown = true;
        return;
    }

    // Mid-stroke: derive speed from how far the touch moved on SCREEN since
    // the last sample (a finger's felt speed is a screen quantity, not a
    // world one - the same reason the pen's radius bounds above are
    // screen-space too), then rate-limit pressure toward the speed-implied
    // target and record one more stroke point.
    float prevSX, prevSY;
    td_world_to_screen(st->lastWorldX, st->lastWorldY, zoom, &prevSX, &prevSY);
    float curSX, curSY;
    td_world_to_screen(wx, wy, zoom, &curSX, &curSY);
    float dx = curSX - prevSX, dy = curSY - prevSY;
    float distScreen = rt_sqrtf(dx * dx + dy * dy);
    if (distScreen < MIN_STEP_PX) return; // dedupe: jitter too small to be a real move

    uint32_t dt = f->dtMs > 0 ? f->dtMs : 1;
    float speed = distScreen / (float)dt;
    float target = 1.0f - speed / SPEED_MAX_PXMS;
    if (target < 0.15f) target = 0.15f;
    if (target > 1.0f) target = 1.0f;
    st->pressure += (target - st->pressure) * PRESSURE_LERP;

    float rScreen = radius_from_pressure(st->pressure);
    float rWorld = rScreen / zoom;

    stroke_pool_append(wx, wy, rWorld);

    st->lastWorldX = wx; st->lastWorldY = wy; st->lastWorldR = rWorld;
}

// Repaints one band from the stored stroke history at the CURRENT zoom
// level. Called 16 times a frame (once per band, app.h) - every call fills
// its own band white first (a band buffer's prior content is UNDEFINED,
// app.h's header comment) and then replays every stroke, clipped to this
// band by draw_capsule_band's own bounding-box check.
void port_draw_band_impl(int band, uint16_t *buf, int y0, int rows) {
    (void)band;
    gfxb_fill(buf, rows, PX_WHITE);

    const float zoom = kZoom[st->zoomIndex];
    for (int s = 0; s < st->strokeCount; s++) {
        int start = st->strokes[s].startIdx, count = st->strokes[s].count;
        if (count == 0) continue;

        float sx, sy;
        td_world_to_screen(st->points[start].x, st->points[start].y, zoom, &sx, &sy);
        float sr = st->points[start].r * zoom;
        draw_capsule_band(buf, y0, rows, sx, sy, sr, sx, sy, sr); // starting dot

        float psx = sx, psy = sy, pr = sr;
        for (int i = 1; i < count; i++) {
            const td_point_t *p = &st->points[start + i];
            float csx, csy;
            td_world_to_screen(p->x, p->y, zoom, &csx, &csy);
            float cr = p->r * zoom;
            draw_capsule_band(buf, y0, rows, psx, psy, pr, csx, csy, cr);
            psx = csx; psy = csy; pr = cr;
        }
    }
}

const app_t g_demoApp = {
    .name = "tinydraw",
    .enter = port_enter_impl,
    .tick = port_tick_impl,
    .draw_band = port_draw_band_impl,
    .leave = NULL,
};
