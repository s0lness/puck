// gos_runtime.c -- a from-scratch implementation of esp32-gameos's gos.h
// contract (../../reference/esp32-gameos/gos.h, vendored unchanged) against
// this pack's own app.h/gfx.h ABI. This is NOT a port of gos_core/gos_hal
// (those are ESP-IDF/FreeRTOS-specific: NVS, an I2S mixer, a QMI8658
// register map, an AXP2101 PMIC - see ../../reference/esp32-gameos/README.md).
// It is a new engine that speaks the same contract, so the donor's own
// gunship.c and slots.c (included verbatim by gameos_port.c) compile and run
// unmodified. See ports/rp2350-touch-amoled-18/NOTICE.md for exactly which
// pieces are vendored almost verbatim (the font table, the RNG, the spatial
// grid - all pure data/math with no HAL dependency) versus reimplemented
// (the indexed framebuffer's present path, the input snapshot, timing).
//
// SHOW PHASE: audio (GOS_CAP_AUDIO) and save (GOS_CAP_SAVE) are stubbed
// (silent / always-empty) rather than wired to this pack's sound_synth.c or
// storage.c - see the port README's Demands table for why that is an
// honest, stated gap rather than a silent one. Everything that reaches the
// panel is real.
#include "app.h"
#include "gfx.h"
#include "../../reference/esp32-gameos/gos.h"
#include <math.h>
#include <string.h>
#include <stdarg.h>

// memset()/memcpy(): this pack's freestanding wasm32 target ships no
// <string.h> at all, so the "string.h" resolved above is this port's own
// stand-in (string.h beside this file) declaring exactly the two functions
// gos_runtime.c and the vendored game sources actually call. Defined here,
// a plain byte loop each - see that header's own comment for why this is a
// safe reimplementation rather than a numerically-risky one.
void *memset(void *dst, int c, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    for (size_t i = 0; i < n; i++) d[i] = (unsigned char)c;
    return dst;
}
void *memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    for (size_t i = 0; i < n; i++) d[i] = s[i];
    return dst;
}

// ===========================================================================
// Indexed framebuffer (184x224, one byte per pixel: a palette index), the
// same resolution and pixel format esp32-gameos's own gos_core/gfx.c draws
// into. Single-buffered (no present-time swap needed: this pack pushes the
// whole panel once per tick, after every game has already finished drawing
// this tick's frame into it).
// ===========================================================================
#define W GOS_SCREEN_W
#define H GOS_SCREEN_H

static uint8_t s_ifb[W * H];
static gos_rect_t s_clip = { 0, 0, W, H };
static uint16_t s_lut[256];      // panel byte order (px_swap already applied)
static uint16_t s_lut_dim[256];  // 25% darker, for scanlines
static bool s_scanlines;

// ---- palette ---------------------------------------------------------------

static uint16_t dim565(uint16_t c) {
    // 25% darker, on normal-order RGB565 (matches gos_core/gfx.c's dim565).
    uint16_t r = (uint16_t)((c >> 11) & 31), g = (uint16_t)((c >> 5) & 63), b = (uint16_t)(c & 31);
    return (uint16_t)(((r * 3 / 4) << 11) | ((g * 3 / 4) << 5) | (b * 3 / 4));
}

void gos_gfx_set_palette(const uint16_t *rgb565, int count, int offset) {
    for (int i = 0; i < count; i++) {
        int d = offset + i;
        if (d < 0 || d > 255) continue;
        s_lut[d] = px_swap(rgb565[i]);
        s_lut_dim[d] = px_swap(dim565(rgb565[i]));
    }
}

#define C565(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))

void gos_gfx_set_default_palette(void) {
    static const uint16_t named[16] = {
        C565(0, 0, 0),       C565(60, 60, 68),    C565(128, 128, 136),
        C565(190, 190, 196), C565(255, 255, 255), C565(230, 50, 40),
        C565(240, 140, 30),  C565(245, 215, 60),  C565(70, 200, 90),
        C565(70, 200, 220),  C565(70, 110, 240),  C565(170, 90, 220),
        C565(20, 100, 50),   C565(20, 40, 90),    C565(140, 90, 50),
        C565(220, 170, 40),
    };
    gos_gfx_set_palette(named, 16, 0);
    uint16_t ramp[64];
    for (int i = 0; i < 64; i++) {
        int v = i * 255 / 63;
        ramp[i] = C565(v, v, v);
    }
    gos_gfx_set_palette(ramp, 64, 16);
    uint16_t mag = C565(255, 0, 255); // a bad index shows up loudly, not subtly
    for (int i = 80; i < 256; i++) gos_gfx_set_palette(&mag, 1, i);
}

void gos_gfx_scanlines(bool on) { s_scanlines = on; }
uint8_t *gos_gfx_fb(void) { return s_ifb; }

// GOS_CAP_FB565 (full-res direct mode): neither gunship nor slots declares
// this cap (only golf does - see the port README for why golf was not one
// of the two games picked). Declared to satisfy gos.h's link surface, never
// exercised: a call from a game that didn't ask for the cap would be a bug
// in that game, not something this runtime needs to make useful.
static uint16_t s_fb565_unused[1];
uint16_t *gos_gfx_fb565(void) { return s_fb565_unused; }
void gos_gfx_direct565(bool on) { (void)on; }

// ---- clip + primitives (line for line from esp32-gameos's gos_core/gfx.c:
// this is pure rasterization math with no HAL dependency, so it is copied
// rather than reinvented - a differently-rounded circle or a differently-
// clipped hline would be a silent behavioural fork of the donor's own
// visual language) -----------------------------------------------------------

void gos_gfx_set_clip(gos_rect_t r) {
    int x0 = r.x < 0 ? 0 : r.x, y0 = r.y < 0 ? 0 : r.y;
    int x1 = r.x + r.w > W ? W : r.x + r.w;
    int y1 = r.y + r.h > H ? H : r.y + r.h;
    s_clip = (gos_rect_t){ (int16_t)x0, (int16_t)y0,
                            (int16_t)(x1 > x0 ? x1 - x0 : 0),
                            (int16_t)(y1 > y0 ? y1 - y0 : 0) };
}

void gos_gfx_clear_clip(void) { s_clip = (gos_rect_t){ 0, 0, W, H }; }

void gos_gfx_clear(gos_color_t c) { memset(s_ifb, c, (size_t)(W * H)); }

void gos_gfx_pixel(int x, int y, gos_color_t c) {
    if (x < s_clip.x || y < s_clip.y || x >= s_clip.x + s_clip.w || y >= s_clip.y + s_clip.h) return;
    s_ifb[y * W + x] = c;
}

void gos_gfx_hline(int x0, int x1, int y, gos_color_t c) {
    if (y < s_clip.y || y >= s_clip.y + s_clip.h) return;
    if (x0 > x1) { int t = x0; x0 = x1; x1 = t; }
    if (x0 < s_clip.x) x0 = s_clip.x;
    if (x1 >= s_clip.x + s_clip.w) x1 = s_clip.x + s_clip.w - 1;
    if (x0 > x1) return;
    memset(s_ifb + y * W + x0, c, (size_t)(x1 - x0 + 1));
}

void gos_gfx_vline(int x, int y0, int y1, gos_color_t c) {
    if (x < s_clip.x || x >= s_clip.x + s_clip.w) return;
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; }
    if (y0 < s_clip.y) y0 = s_clip.y;
    if (y1 >= s_clip.y + s_clip.h) y1 = s_clip.y + s_clip.h - 1;
    uint8_t *p = s_ifb + y0 * W + x;
    for (int y = y0; y <= y1; y++, p += W) *p = c;
}

void gos_gfx_line(int x0, int y0, int x1, int y1, gos_color_t c) {
    int dx = x1 > x0 ? x1 - x0 : x0 - x1;
    int dy = y1 > y0 ? y1 - y0 : y0 - y1;
    int sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    int err = dx - dy;
    for (;;) {
        gos_gfx_pixel(x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx)  { err += dx; y0 += sy; }
    }
}

void gos_gfx_rect(gos_rect_t r, gos_color_t c) {
    gos_gfx_hline(r.x, r.x + r.w - 1, r.y, c);
    gos_gfx_hline(r.x, r.x + r.w - 1, r.y + r.h - 1, c);
    gos_gfx_vline(r.x, r.y, r.y + r.h - 1, c);
    gos_gfx_vline(r.x + r.w - 1, r.y, r.y + r.h - 1, c);
}

void gos_gfx_rect_fill(gos_rect_t r, gos_color_t c) {
    for (int y = r.y; y < r.y + r.h; y++) gos_gfx_hline(r.x, r.x + r.w - 1, y, c);
}

void gos_gfx_circle(int cx, int cy, int r, gos_color_t c) {
    int x = r, y = 0, err = 1 - r;
    while (x >= y) {
        gos_gfx_pixel(cx + x, cy + y, c); gos_gfx_pixel(cx - x, cy + y, c);
        gos_gfx_pixel(cx + x, cy - y, c); gos_gfx_pixel(cx - x, cy - y, c);
        gos_gfx_pixel(cx + y, cy + x, c); gos_gfx_pixel(cx - y, cy + x, c);
        gos_gfx_pixel(cx + y, cy - x, c); gos_gfx_pixel(cx - y, cy - x, c);
        y++;
        if (err < 0) err += 2 * y + 1;
        else { x--; err += 2 * (y - x) + 1; }
    }
}

void gos_gfx_circle_fill(int cx, int cy, int r, gos_color_t c) {
    for (int dy = -r; dy <= r; dy++) {
        int w2 = r * r - dy * dy;
        int hw = 0;
        while ((hw + 1) * (hw + 1) <= w2) hw++;
        gos_gfx_hline(cx - hw, cx + hw, cy + dy, c);
    }
}

static uint8_t isqrt_small(int v) {
    int r = 0;
    while ((r + 1) * (r + 1) <= v) r++;
    return (uint8_t)r;
}

void gos_gfx_circle_soft(int cx, int cy, int r, uint8_t hot, uint8_t base) {
    if (r < 1) r = 1;
    if (r > 16) r = 16;
    int span = hot - base;
    for (int dy = -r; dy <= r; dy++) {
        int y = cy + dy;
        if (y < s_clip.y || y >= s_clip.y + s_clip.h) continue;
        uint8_t *row = s_ifb + y * W;
        for (int dx = -r; dx <= r; dx++) {
            int x = cx + dx;
            if (x < s_clip.x || x >= s_clip.x + s_clip.w) continue;
            int d2 = dx * dx + dy * dy;
            if (d2 > r * r) continue;
            int level = hot - span * isqrt_small(d2) / r;
            if (level > row[x]) row[x] = (uint8_t)level;
        }
    }
}

void gos_gfx_quad_fill(const gos_pt_t p[4], gos_color_t c) {
    int ymin = p[0].y, ymax = p[0].y;
    for (int i = 1; i < 4; i++) {
        if (p[i].y < ymin) ymin = p[i].y;
        if (p[i].y > ymax) ymax = p[i].y;
    }
    if (ymin < s_clip.y) ymin = s_clip.y;
    if (ymax >= s_clip.y + s_clip.h) ymax = s_clip.y + s_clip.h - 1;
    for (int y = ymin; y <= ymax; y++) {
        int xl = 32767, xr = -32768;
        for (int i = 0; i < 4; i++) {
            gos_pt_t a = p[i], b = p[(i + 1) & 3];
            if (a.y == b.y) {
                if (y == a.y) {
                    if (a.x < xl) xl = a.x;
                    if (b.x < xl) xl = b.x;
                    if (a.x > xr) xr = a.x;
                    if (b.x > xr) xr = b.x;
                }
                continue;
            }
            int y0 = a.y, y1 = b.y;
            if (y0 > y1) { gos_pt_t t = a; a = b; b = t; y0 = a.y; y1 = b.y; }
            if (y < y0 || y > y1) continue;
            int x = a.x + (int)(b.x - a.x) * (y - y0) / (y1 - y0);
            if (x < xl) xl = x;
            if (x > xr) xr = x;
        }
        if (xl <= xr) gos_gfx_hline(xl, xr, y, c);
    }
}

void gos_gfx_blit(const gos_sprite_t *s, int x, int y) {
    for (int sy = 0; sy < s->h; sy++) {
        int dy = y + sy;
        if (dy < s_clip.y || dy >= s_clip.y + s_clip.h) continue;
        const uint8_t *src = s->px + sy * s->w;
        uint8_t *row = s_ifb + dy * W;
        for (int sx = 0; sx < s->w; sx++) {
            uint8_t v = src[sx];
            if (v == 0xFF) continue;
            int dx = x + sx;
            if (dx < s_clip.x || dx >= s_clip.x + s_clip.w) continue;
            row[dx] = v;
        }
    }
}

static int16_t s_sin_tab[256];
int16_t gos_sin256(uint8_t a) { return s_sin_tab[a]; }
int16_t gos_cos256(uint8_t a) { return s_sin_tab[(uint8_t)(a + 64)]; }

void gos_gfx_blit_rot(const gos_sprite_t *s, int x, int y, uint8_t angle256) {
    int32_t c = gos_cos256(angle256), n = gos_sin256(angle256);
    int hw = s->w / 2, hh = s->h / 2;
    int rad = (hw > hh ? hw : hh) * 3 / 2 + 1;
    for (int dy = -rad; dy <= rad; dy++) {
        int py = y + dy;
        if (py < s_clip.y || py >= s_clip.y + s_clip.h) continue;
        uint8_t *row = s_ifb + py * W;
        for (int dx = -rad; dx <= rad; dx++) {
            int px = x + dx;
            if (px < s_clip.x || px >= s_clip.x + s_clip.w) continue;
            int sx = (int)((c * dx + n * dy) >> 14) + hw;
            int sy = (int)((-n * dx + c * dy) >> 14) + hh;
            if (sx < 0 || sy < 0 || sx >= s->w || sy >= s->h) continue;
            uint8_t v = s->px[sy * s->w + sx];
            if (v != 0xFF) row[px] = v;
        }
    }
}

// ---- text: public-domain 5x7 font, from esp32-gameos's gos_core/font.c
// (ASCII 32..126, column-major, bit 0 = top row) - vendored verbatim, see
// NOTICE.md. -----------------------------------------------------------------
static const uint8_t s_font5x7[95][5] = {
    {0x00,0x00,0x00,0x00,0x00},{0x00,0x00,0x5F,0x00,0x00},{0x00,0x07,0x00,0x07,0x00},
    {0x14,0x7F,0x14,0x7F,0x14},{0x24,0x2A,0x7F,0x2A,0x12},{0x23,0x13,0x08,0x64,0x62},
    {0x36,0x49,0x55,0x22,0x50},{0x00,0x05,0x03,0x00,0x00},{0x00,0x1C,0x22,0x41,0x00},
    {0x00,0x41,0x22,0x1C,0x00},{0x08,0x2A,0x1C,0x2A,0x08},{0x08,0x08,0x3E,0x08,0x08},
    {0x00,0x50,0x30,0x00,0x00},{0x08,0x08,0x08,0x08,0x08},{0x00,0x60,0x60,0x00,0x00},
    {0x20,0x10,0x08,0x04,0x02},{0x3E,0x51,0x49,0x45,0x3E},{0x00,0x42,0x7F,0x40,0x00},
    {0x42,0x61,0x51,0x49,0x46},{0x21,0x41,0x45,0x4B,0x31},{0x18,0x14,0x12,0x7F,0x10},
    {0x27,0x45,0x45,0x45,0x39},{0x3C,0x4A,0x49,0x49,0x30},{0x01,0x71,0x09,0x05,0x03},
    {0x36,0x49,0x49,0x49,0x36},{0x06,0x49,0x49,0x29,0x1E},{0x00,0x36,0x36,0x00,0x00},
    {0x00,0x56,0x36,0x00,0x00},{0x00,0x08,0x14,0x22,0x41},{0x14,0x14,0x14,0x14,0x14},
    {0x41,0x22,0x14,0x08,0x00},{0x02,0x01,0x51,0x09,0x06},{0x32,0x49,0x79,0x41,0x3E},
    {0x7E,0x11,0x11,0x11,0x7E},{0x7F,0x49,0x49,0x49,0x36},{0x3E,0x41,0x41,0x41,0x22},
    {0x7F,0x41,0x41,0x22,0x1C},{0x7F,0x49,0x49,0x49,0x41},{0x7F,0x09,0x09,0x09,0x01},
    {0x3E,0x41,0x41,0x51,0x32},{0x7F,0x08,0x08,0x08,0x7F},{0x00,0x41,0x7F,0x41,0x00},
    {0x20,0x40,0x41,0x3F,0x01},{0x7F,0x08,0x14,0x22,0x41},{0x7F,0x40,0x40,0x40,0x40},
    {0x7F,0x02,0x0C,0x02,0x7F},{0x7F,0x04,0x08,0x10,0x7F},{0x3E,0x41,0x41,0x41,0x3E},
    {0x7F,0x09,0x09,0x09,0x06},{0x3E,0x41,0x51,0x21,0x5E},{0x7F,0x09,0x19,0x29,0x46},
    {0x46,0x49,0x49,0x49,0x31},{0x01,0x01,0x7F,0x01,0x01},{0x3F,0x40,0x40,0x40,0x3F},
    {0x1F,0x20,0x40,0x20,0x1F},{0x3F,0x40,0x38,0x40,0x3F},{0x63,0x14,0x08,0x14,0x63},
    {0x07,0x08,0x70,0x08,0x07},{0x61,0x51,0x49,0x45,0x43},{0x00,0x7F,0x41,0x41,0x00},
    {0x02,0x04,0x08,0x10,0x20},{0x00,0x41,0x41,0x7F,0x00},{0x04,0x02,0x01,0x02,0x04},
    {0x40,0x40,0x40,0x40,0x40},{0x00,0x01,0x02,0x04,0x00},{0x20,0x54,0x54,0x54,0x78},
    {0x7F,0x48,0x44,0x44,0x38},{0x38,0x44,0x44,0x44,0x20},{0x38,0x44,0x44,0x48,0x7F},
    {0x38,0x54,0x54,0x54,0x18},{0x08,0x7E,0x09,0x01,0x02},{0x0C,0x52,0x52,0x52,0x3E},
    {0x7F,0x08,0x04,0x04,0x78},{0x00,0x44,0x7D,0x40,0x00},{0x20,0x40,0x44,0x3D,0x00},
    {0x7F,0x10,0x28,0x44,0x00},{0x00,0x41,0x7F,0x40,0x00},{0x7C,0x04,0x18,0x04,0x78},
    {0x7C,0x08,0x04,0x04,0x78},{0x38,0x44,0x44,0x44,0x38},{0x7C,0x14,0x14,0x14,0x08},
    {0x08,0x14,0x14,0x18,0x7C},{0x7C,0x08,0x04,0x04,0x08},{0x48,0x54,0x54,0x54,0x20},
    {0x04,0x3F,0x44,0x40,0x20},{0x3C,0x40,0x40,0x20,0x7C},{0x1C,0x20,0x40,0x20,0x1C},
    {0x3C,0x40,0x30,0x40,0x3C},{0x44,0x28,0x10,0x28,0x44},{0x0C,0x50,0x50,0x50,0x3C},
    {0x44,0x64,0x54,0x4C,0x44},{0x00,0x08,0x36,0x41,0x00},{0x00,0x00,0x7F,0x00,0x00},
    {0x00,0x41,0x36,0x08,0x00},{0x08,0x04,0x08,0x10,0x08},
};

// A minimal printf-subset formatter, covering exactly what gunship.c and
// slots.c's format strings use (checked by grep over both files, not
// guessed): %d, %ld, %+ld (force sign), %s, %%, plain text. Neither this
// pack's own wasm shim/stdio.h (printf only) nor the freestanding
// wasm32 target's libc offers vsnprintf, so this is a from-scratch
// implementation, not a vendored one.
static int gosrt_vformat(char *buf, int cap, const char *fmt, va_list ap) {
    int n = 0;
    for (const char *s = fmt; *s && n < cap - 1; s++) {
        if (*s != '%') { buf[n++] = *s; continue; }
        s++;
        bool forceSign = false;
        if (*s == '+') { forceSign = true; s++; }
        bool isLong = false;
        if (*s == 'l') { isLong = true; s++; }
        char tmp[24];
        if (*s == 'd') {
            long v = isLong ? va_arg(ap, long) : va_arg(ap, int);
            int t = 0;
            bool neg = v < 0;
            unsigned long uv = neg ? (unsigned long)(-v) : (unsigned long)v;
            do { tmp[t++] = (char)('0' + uv % 10); uv /= 10; } while (uv && t < (int)sizeof tmp);
            if (neg) tmp[t++] = '-';
            else if (forceSign) tmp[t++] = '+';
            while (t > 0 && n < cap - 1) buf[n++] = tmp[--t];
        } else if (*s == 's') {
            const char *sv = va_arg(ap, const char *);
            if (sv) while (*sv && n < cap - 1) buf[n++] = *sv++;
        } else if (*s == '%') {
            buf[n++] = '%';
        } else if (*s == 0) {
            break;
        }
    }
    buf[n] = 0;
    return n;
}

static void draw_glyph(int x, int y, char ch, gos_color_t c, int scale) {
    if (ch < 32 || ch > 126) ch = '?';
    const uint8_t *g = s_font5x7[ch - 32];
    for (int col = 0; col < 5; col++) {
        uint8_t bits = g[col];
        for (int row = 0; row < 7; row++) {
            if (!(bits & (1 << row))) continue;
            if (scale == 1) gos_gfx_pixel(x + col, y + row, c);
            else gos_gfx_rect_fill((gos_rect_t){ (int16_t)(x + col * 2), (int16_t)(y + row * 2), 2, 2 }, c);
        }
    }
}

void gos_gfx_text(int font, int x, int y, gos_color_t c, const char *fmt, ...) {
    char buf[128];
    va_list ap;
    va_start(ap, fmt);
    gosrt_vformat(buf, (int)sizeof buf, fmt, ap);
    va_end(ap);
    int scale = font ? 2 : 1;
    int adv = 6 * scale;
    for (const char *s = buf; *s; s++) {
        draw_glyph(x, y, *s, c, scale);
        x += adv;
    }
}

int gos_gfx_text_w(int font, const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n ? n * 6 * (font ? 2 : 1) - (font ? 2 : 1) : 0;
}

void gos_gfx_text565(int px, int x, int y, uint16_t rgb565, const char *fmt, ...) {
    // Unused: neither picked game declares GOS_CAP_FB565 (see gos_gfx_fb565
    // above). Present only so the link surface matches gos.h exactly.
    (void)px; (void)x; (void)y; (void)rgb565; (void)fmt;
}
int gos_gfx_text565_w(int px, const char *s) { (void)px; (void)s; return 0; }
int gos_gfx_text565_h(int px) { (void)px; return 0; }

// Local snprintf/abs: this pack's wasm32-freestanding libc shims
// (packs/rp2350-touch-amoled-18/wasm/shim/{stdio,stdlib}.h) declare only
// `printf`/`malloc` - see that directory's own header comments for why
// stdlib.h/stdio.h/math.h are hosted-only headers zig's freestanding target
// does not ship a full implementation of. slots.c (vendored unmodified,
// ../../reference/esp32-gameos/slots.c) calls snprintf() and abs(), so
// gameos_port.c #defines both to these before including it - see that
// file's own comment at the include site.
int gosrt_snprintf(char *buf, unsigned long cap, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = gosrt_vformat(buf, (int)cap, fmt, ap);
    va_end(ap);
    return n;
}
int gosrt_abs(int x) { return x < 0 ? -x : x; }

// ===========================================================================
// Spatial hash grid - vendored verbatim from esp32-gameos's gos_core/core.c
// (pure data structure, no HAL dependency).
// ===========================================================================
#define GRID_MAX_CELLS (80 * 80)
#define GRID_MAX_NODES 512

static struct {
    int cell, cols, rows;
    int16_t head[GRID_MAX_CELLS];
    struct { int16_t next; uint16_t id; int16_t x, y; } node[GRID_MAX_NODES];
    int nnodes;
} s_grid;

void gos_grid_init(int cell_size, int world_w, int world_h) {
    s_grid.cell = cell_size > 0 ? cell_size : 16;
    s_grid.cols = (world_w + s_grid.cell - 1) / s_grid.cell;
    s_grid.rows = (world_h + s_grid.cell - 1) / s_grid.cell;
    if (s_grid.cols > 80) s_grid.cols = 80;
    if (s_grid.rows > 80) s_grid.rows = 80;
    gos_grid_clear();
}

void gos_grid_clear(void) {
    memset(s_grid.head, 0xFF, sizeof(int16_t) * (size_t)(s_grid.cols * s_grid.rows));
    s_grid.nnodes = 0;
}

void gos_grid_insert(uint16_t id, int16_t x, int16_t y) {
    if (s_grid.nnodes >= GRID_MAX_NODES) return;
    int cx = x / s_grid.cell, cy = y / s_grid.cell;
    if (cx < 0 || cy < 0 || cx >= s_grid.cols || cy >= s_grid.rows) return;
    int c = cy * s_grid.cols + cx;
    int n = s_grid.nnodes++;
    s_grid.node[n].next = s_grid.head[c];
    s_grid.node[n].id = id;
    s_grid.node[n].x = x;
    s_grid.node[n].y = y;
    s_grid.head[c] = (int16_t)n;
}

int gos_grid_query(int16_t x, int16_t y, int16_t r, uint16_t *out, int max) {
    int n = 0;
    int cx0 = (x - r) / s_grid.cell, cy0 = (y - r) / s_grid.cell;
    int cx1 = (x + r) / s_grid.cell, cy1 = (y + r) / s_grid.cell;
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= s_grid.cols) cx1 = s_grid.cols - 1;
    if (cy1 >= s_grid.rows) cy1 = s_grid.rows - 1;
    int r2 = r * r;
    for (int cy = cy0; cy <= cy1; cy++)
        for (int cx = cx0; cx <= cx1; cx++)
            for (int16_t i = s_grid.head[cy * s_grid.cols + cx]; i >= 0; i = s_grid.node[i].next) {
                int dx = s_grid.node[i].x - x, dy = s_grid.node[i].y - y;
                if (dx * dx + dy * dy > r2) continue;
                if (n >= max) return n;
                out[n++] = s_grid.node[i].id;
            }
    return n;
}

// ===========================================================================
// RNG - vendored verbatim from gos_core/core.c (xorshift32, pure math).
// ===========================================================================
uint32_t gos_rand(gos_rng_t *r) {
    uint32_t x = r->s ? r->s : 0x9E3779B9u;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    r->s = x;
    return x;
}
int gos_rand_range(gos_rng_t *r, int lo, int hi) {
    if (hi <= lo) return lo;
    return lo + (int)(gos_rand(r) % (uint32_t)(hi - lo + 1));
}
float gos_randf(gos_rng_t *r) { return (float)(gos_rand(r) >> 8) / 16777216.0f; }

// ===========================================================================
// Time - this ABI's only clock is the tick's own nowMs/dtMs (app_frame_t,
// app.h), fed by the trace or the live page. No wall clock exists on a
// freestanding wasm32 target, and none is needed: gunship/slots only use
// gos_time_ms()/gos_time_us() for elapsed-time math relative to their own
// stored timestamps, which stays correct under this deterministic clock the
// same way it would under a real one.
// ===========================================================================
static uint32_t s_now_ms;
uint32_t gos_time_ms(void) { return s_now_ms; }
int64_t gos_time_us(void) { return (int64_t)s_now_ms * 1000; }

// ===========================================================================
// Save / audio / raw-accel-ring: stubbed for this show-phase port (see the
// port README's Demands table). Both games already handle "no save data" /
// "silent" / "no samples" gracefully - they were WRITTEN to run on hardware
// that might have neither an available NVS partition nor IMU, per gos.h's
// own doc ("-1 if the IMU is absent").
// ===========================================================================
bool gos_save_write(gos_ctx_t *ctx, const void *blob, size_t len) { (void)ctx; (void)blob; (void)len; return false; }
int gos_save_read(gos_ctx_t *ctx, void *out, size_t max) { (void)ctx; (void)out; (void)max; return -1; }

int gos_audio_play(const gos_sfx_t *s, uint8_t vol) { (void)s; (void)vol; return -1; }
int gos_audio_loop(const gos_sfx_t *s, uint8_t vol) { (void)s; (void)vol; return -1; }
void gos_audio_stop(int handle) { (void)handle; }
void gos_audio_set_vol(int handle, uint8_t vol) { (void)handle; (void)vol; }
void gos_audio_stop_all(void) {}
void gos_audio_master(int level) { (void)level; }
int gos_audio_master_get(void) { return 0; }

// GOS_AIM_TILT_ABS only (see the port README): the puck ABI publishes a
// filtered gravity vector (app_tilt_t), matching gos.h's own DEFAULT aim
// mode exactly, but no gyro-rate signal at all, so GYRO_RATE is not offered.
static gos_aim_mode_t s_aim_mode = GOS_AIM_TILT_ABS;
gos_aim_mode_t gos_input_get_aim_mode(void) { return s_aim_mode; }
void gos_input_set_aim_mode(gos_aim_mode_t m) { (void)m; /* fixed: TILT_ABS only */ }
void gos_input_calibrate_neutral(void) { /* no-op: neither picked game calls this */ }
static gos_aim_cfg_t s_aim_cfg = {
    .range_deg = 25.f, .curve_pow = 1.4f, .deadzone = 0.04f,
    .min_cutoff = 1.0f, .beta = 0.007f, .d_cutoff = 1.0f, .gyro_gain = 1.0f,
};
void gos_input_set_aim_config(const gos_aim_cfg_t *c) { s_aim_cfg = *c; }
gos_aim_cfg_t *gos_input_aim_config(void) { return &s_aim_cfg; }

// No raw accel ring on this ABI (app_frame_t publishes a filtered gravity
// vector, not a 200Hz sample stream): 0 "no samples this call", matching
// gos.h's own doc for a device that has SOME motion sensing but not this
// specific one, distinct from -1 ("IMU absent"). slots.c's pull_detector()
// already handles 0 samples by returning immediately every call, so the
// donor's touch-drag fallback (fully wired, see gameos_port.c) is the only
// way to spin the reels on this port - a stated, deliberate narrowing of
// the interaction surface, not a silent gap.
int gos_imu_accel_read(gos_accel_sample_t *out, int max) { (void)out; (void)max; return 0; }

void gos_request_exit(void) { /* neither picked game's own EXIT chip is wired
    in this show-phase port: exit-to-launcher is the top-edge swipe-down
    gesture, gosrt_swipe_exit() below, matching input-and-ux.md's own
    "Escape routes" doc. */ }

// ===========================================================================
// The bridge: not part of gos.h, this is gameos_port.c's own API onto this
// runtime (input snapshot construction, the panel present pass, and the
// palette reset the shell would normally do between games).
// ===========================================================================
static gos_input_t s_in;

void gosrt_boot(void) {
    for (int i = 0; i < 256; i++)
        s_sin_tab[i] = (int16_t)(sinf((float)i * (float)M_PI / 128.f) * 16384.f);
    gos_gfx_set_default_palette();
    memset(s_ifb, 0, sizeof s_ifb);
}

void gosrt_reset_shell_palette(void) {
    gos_gfx_set_default_palette();
    gos_gfx_scanlines(false);
    gos_gfx_clear_clip();
}

// One-euro filter + the pow-1.4 response curve, reimplemented from
// esp32-gameos's gos_core/input.c (GOS_AIM_TILT_ABS branch): pure math, no
// HAL dependency, so the constants and shape are kept exactly (see
// s_aim_cfg above) even though the pose source below is this port's own.
typedef struct { float x_prev, dx_prev; bool init; } euro_t;
static euro_t s_fx, s_fy;
static float euro_lowpass(float x, float prev, float alpha) { return alpha * x + (1 - alpha) * prev; }
static float euro_alpha(float cutoff, float dt) {
    float tau = 1.0f / (2.0f * (float)M_PI * cutoff);
    return 1.0f / (1.0f + tau / dt);
}
static float euro_filter(euro_t *f, float x, float dt) {
    if (!f->init) { f->x_prev = x; f->dx_prev = 0; f->init = true; return x; }
    float dx = (x - f->x_prev) / dt;
    float edx = euro_lowpass(dx, f->dx_prev, euro_alpha(s_aim_cfg.d_cutoff, dt));
    f->dx_prev = edx;
    float cutoff = s_aim_cfg.min_cutoff + s_aim_cfg.beta * fabsf(edx);
    float ex = euro_lowpass(x, f->x_prev, euro_alpha(cutoff, dt));
    f->x_prev = ex;
    return ex;
}
static float aim_shape(float a) {
    float sgn = a < 0 ? -1.f : 1.f;
    float m = fabsf(a);
    if (m > 1.f) m = 1.f;
    m = powf(m, s_aim_cfg.curve_pow);
    if (m < s_aim_cfg.deadzone) return 0.f;
    m = (m - s_aim_cfg.deadzone) / (1.f - s_aim_cfg.deadzone);
    return sgn * m;
}

void gosrt_reset_aim_filters(void) { s_fx.init = s_fy.init = false; }

// Builds this tick's gos_input_t from the puck ABI's app_frame_t. `caps` is
// the CURRENTLY ACTIVE screen's gos_game_t.caps (0 for the launcher, which
// reads .touching/.touch directly and needs neither FIRE nor aim), since
// GOS_CAP_TOUCH_FIRE's "touch in the lower 2/3 sets FIRE" rule is only
// meaningful for a game that asked for it (docs/input-and-ux.md).
const gos_input_t *gosrt_build_input(const app_frame_t *f, float dt, uint32_t caps) {
    s_now_ms = f->nowMs;

    s_in.touch.x = (int16_t)(f->touchX / 2);
    s_in.touch.y = (int16_t)(f->touchY / 2);
    s_in.touching = f->touchDown;

    uint32_t btn = 0;
    // BOOT has no held-level signal on this ABI, only a release-edge pulse
    // (app.h's bootClicked: "true on the frame BOOT was released") - unlike
    // the donor's own hal_button_down() (a live level). This port fires
    // pressed+released together on that one tick, which is correct for
    // every edge-triggered use (a menu tap, an EXIT chip) and cannot
    // reproduce a true HELD duration (the donor's dev-only 600ms overlay
    // toggle) - a stated, real gap, not a silent one.
    if (f->bootClicked) btn |= GOS_BTN_A;
    if ((caps & GOS_CAP_TOUCH_FIRE) && s_in.touching && s_in.touch.y > GOS_SCREEN_H / 3) btn |= GOS_BTN_FIRE;
    uint32_t prev = s_in.buttons;
    s_in.buttons = btn;
    s_in.pressed = btn & ~prev;
    s_in.released = prev & ~btn;
    if (f->bootClicked) s_in.pressed |= GOS_BTN_A; // single-tick edge, see above

    s_in.shake = 0.f; // no raw motion stream on this ABI - see gos_imu_accel_read

    // GOS_AIM_TILT_ABS: reconstruct pitch/roll from the filtered gravity
    // vector app.h already publishes (app_tilt_t.gx/gy/gz, +x right, +y
    // down, +z into the glass - the SAME axis convention hal_imu.c's own
    // atan2f(ax, sqrt(ay^2+az^2)) formula assumes of its accelerometer
    // reading, gz standing in for az as the "flat" reference axis).
    float roll = atan2f(f->tilt.gx, f->tilt.gz) * (180.f / (float)M_PI);
    float pitch = atan2f(f->tilt.gy, f->tilt.gz) * (180.f / (float)M_PI);
    float ax = aim_shape(roll / s_aim_cfg.range_deg);
    float ay = aim_shape(pitch / s_aim_cfg.range_deg);
    if (s_aim_cfg.invert_x) ax = -ax;
    if (s_aim_cfg.invert_y) ay = -ay;
    s_in.aim_x = euro_filter(&s_fx, ax, dt > 0.f ? dt : (1.f / 60.f));
    s_in.aim_y = euro_filter(&s_fy, ay, dt > 0.f ? dt : (1.f / 60.f));
    s_in.aim_active = f->tilt.valid;
    s_in.pitch = pitch;
    s_in.roll = roll;
    s_in.gx = f->tilt.gx; s_in.gy = f->tilt.gy; s_in.gz = f->tilt.gz;

    return &s_in;
}

// The "swipe down from the top edge" escape (input-and-ux.md: press y<14,
// drag >40, render space) - the donor's own OS-level pause gesture,
// repurposed here as this show-phase port's only way back to the launcher
// (see gameos_port.c). Real touch data drives it exactly the way the donor
// itself specifies; nothing is invented, only the destination (launcher
// instead of a pause overlay this port does not implement).
static bool s_swipeArmed;
static int s_swipeStartY;
static bool s_swipeWasDown;

bool gosrt_swipe_exit(const app_frame_t *f) {
    int ry = f->touchY / 2;
    bool exitNow = false;
    if (f->touchDown) {
        if (!s_swipeWasDown) {
            s_swipeArmed = ry < 14;
            s_swipeStartY = ry;
        } else if (s_swipeArmed && ry - s_swipeStartY > 40) {
            exitNow = true;
            s_swipeArmed = false;
        }
    } else {
        s_swipeArmed = false;
    }
    s_swipeWasDown = f->touchDown;
    return exitNow;
}

// Present: nearest-neighbour fit of the 184x224 indexed buffer (W x H,
// fixed - GOS_SCREEN_W/H, the donor's own resolution, gos.h) into the
// panel's own PANEL_W x PANEL_H RGB565 framebuffer through the current
// palette LUT (every 3rd output row darkened when scanlines are on, exactly
// gos_core/gfx.c's own hal_display_present() row rule), then one gfx_push
// over exactly the region written - this matches the Demands section's
// "full-screen redraw every frame" honestly: there is no dirty-rectangle
// tracking here because gos.h's own contract is immediate-mode full redraw,
// same as the donor.
//
// SCALED, NOT HARDCODED. This used to be a literal "2x nearest upscale into
// a 368x448 write" (this pack's own reference panel, and the only panel a
// --app build ever compiled against before silhouette packs existed,
// docs/convention/device-pack.md). PANEL_W/PANEL_H are already guarded,
// build-time constants everywhere else in this pack (runtime/gfx.h) -
// this function is the one place that used to spell the reference panel's
// numbers out anyway, so a silhouette build with a smaller PANEL_W/PANEL_H
// (packs/web/wasm/build.ts --silhouette, tools/ledger.ts's silhouette
// source picking this file, docs/convention/device-pack.md) either wrote
// past the actual (correctly-sized) gfx_fb allocation - a trap - or wrote
// inside it at the wrong rows/columns - a blank frame. See
// docs/roadmap.md's workstream 3 for the three boards this was caught on.
//
// The fit: the largest DW x DH that preserves the 184x224 canvas's own
// aspect ratio and stays inside PANEL_W x PANEL_H (scaled UP when the panel
// is bigger, DOWN when it is smaller - a Watchy's 200x200 needs both axes
// shrunk), centred with letterbox bars on whichever axis has slack left
// over. Every destination pixel this loop touches is inside
// [ox0, ox0+dw) x [oy0, oy0+dh), which is itself inside [0, PANEL_W) x
// [0, PANEL_H) by construction, so there is no bounds check needed and no
// way to write outside the framebuffer.
//
// IDENTITY AT THE REFERENCE PANEL. At PANEL_W=368, PANEL_H=448: dw=368,
// dh=368*224/184=448 (exactly, no rounding), so ox0=oy0=0 and every
// destination pixel's nearest-neighbour source index (oy*224/448,
// ox*184/368) reduces to floor(oy/2), floor(ox/2) - the same source row/
// column the old 2x-nearest code read for output rows/cols {2k, 2k+1}. The
// scanline dimming decision is made per ABSOLUTE output row exactly as
// before (oy%3==2, oy0 being 0 here). So this port's own two targets
// (rp2350-touch-amoled-18, and this file included unmodified by
// gameos_port.c) render byte-identical frames to what this function always
// produced - proven by re-running bun run verify-bundle apps/gameos, not
// by this comment.
void gosrt_present(void) {
    int dw = PANEL_W;
    int dh = (PANEL_W * H) / W;
    if (dh > PANEL_H) {
        dh = PANEL_H;
        dw = (PANEL_H * W) / H;
    }
    if (dw < 1) dw = 1;
    if (dh < 1) dh = 1;
    const int ox0 = (PANEL_W - dw) / 2;
    const int oy0 = (PANEL_H - dh) / 2;

    for (int oy = 0; oy < dh; oy++) {
        int sy = (oy * H) / dh;
        if (sy >= H) sy = H - 1;
        bool dim = s_scanlines && (((oy0 + oy) % 3) == 2);
        const uint16_t *lut = dim ? s_lut_dim : s_lut;
        const uint8_t *srow = s_ifb + sy * W;
        uint16_t *row = gfx_fb + (oy0 + oy) * PANEL_W + ox0;
        for (int ox = 0; ox < dw; ox++) {
            int sx = (ox * W) / dw;
            if (sx >= W) sx = W - 1;
            row[ox] = lut[srow[sx]];
        }
    }
    gfx_push(ox0, oy0, ox0 + dw - 1, oy0 + dh - 1);
}
