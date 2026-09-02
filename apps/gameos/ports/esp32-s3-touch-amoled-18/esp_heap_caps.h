/*
 * esp_heap_caps.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/gfx.c (`#include "esp_heap_caps.h"`, one of
 * the two headers gfx.c pulls in only OUTSIDE its GOS_HOST_SIM branch,
 * beside "gos_hal.h" - see gfx.c's own `#ifndef GOS_HOST_SIM` guard) and
 * (new with this port's shell vendoring) ../../reference/esp32-gameos/
 * shell.c and apps.c.
 *
 * TWO independent call sites now share this one header, checked by grep,
 * not guessed:
 *
 * 1. `gos_gfx_fb565()` (gfx.c): GOLF's own full-resolution direct-mode
 *    framebuffer, `heap_caps_calloc(GOS_PANEL_W * GOS_PANEL_H, 2,
 *    MALLOC_CAP_8BIT)` = 368*448*2 = 329728 bytes, allocated ONCE, lazily,
 *    on GOLF's first launch, and never freed (gfx.c's own `static
 *    uint16_t *fb565` persists for the module's lifetime - checked by grep,
 *    no caller ever frees it).
 * 2. `launch()`/`quit_game()` (shell.c, new with this task's shell
 *    vendoring): a game's own state, `heap_caps_calloc(1, g->state_size,
 *    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)`, allocated fresh on every
 *    launch and `heap_caps_free()`'d in `quit_game()` before the next one -
 *    at most ONE such allocation is ever live at a time (`quit_game()`
 *    always frees before `launch()` allocates again, whether from the grid
 *    or from the pause overlay's RESTART, which itself calls `quit_game()`
 *    then `launch()` in sequence - checked by grep across shell.c).
 *
 * This is not a general allocator (this port has no PSRAM, no free list, no
 * fragmentation to model) - it is two purpose-built static arenas, one per
 * call site's own real shape, distinguished by requested byte count (the
 * two shapes never collide: 329728 bytes exactly identifies call site 1;
 * this bundle's own five game states - aimtest_t, diag_t, gs_t (gunship),
 * slots_t, golf_t - are all far from that exact figure, largest being
 * golf_t at ~3.8MB, see this port's README, "GOLF's memory budget").
 * `heap_caps_get_free_size()` (shell.c's debug overlay, apps.c's DIAG
 * screen) has no real heap to report on and returns a stated, honest 0
 * rather than a fabricated plausible-looking number - see NOTICE.md.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_
#define _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_

#include <stddef.h>
#include <stdint.h>

#define MALLOC_CAP_8BIT     (1u << 0)
#define MALLOC_CAP_INTERNAL (1u << 1)
#define MALLOC_CAP_SPIRAM   (1u << 2)

/* THE ARENAS BELOW ARE ALIGNED, AND THE REASON IS A REAL BUG THE HOST MARK
 * CAUGHT (docs/harness.md's three marks). The real heap_caps_calloc() these
 * stand in for returns memory suitably aligned for ANY object, the same
 * promise malloc() makes; a plain `static uint8_t[]` promises alignment 1,
 * and the compiler is free to place it at any address at all. Every caller
 * here immediately stores a struct through that pointer - shell.c's
 * launch() hands it to a game as `ctx->state` and gunship.c's gun_init()
 * does `gs_t *g = ctx->state; g->rng = &ctx->rng;` on the very next line -
 * so an odd address makes every one of those member accesses undefined.
 *
 * wasm32 hid this completely: unaligned loads and stores are legal there
 * (the ISA has an alignment HINT, not a requirement), so the emulator mark
 * ran this port for its whole 6,184-event trace without a murmur. The
 * sanitized native build did not: `bun run hostdiff gameos
 * esp32-s3-touch-amoled-18` reported, from inside the replay,
 *
 *   member access within misaligned address 0x7ff7de46a64d for type
 *   'gs_t', which requires 8 byte alignment
 *     gunship.c:1428 in gun_init  <- shell.c:126 in launch
 *
 * an address ending 0x4d, i.e. not even 2-aligned. On the ESP32-S3 this
 * port is written for, an unaligned 32-bit load is not free either: the
 * Xtensa core takes an alignment exception the IDF handler has to fix up,
 * or - for the wider accesses a struct copy compiles into - simply loads
 * the wrong bytes. So this is a defect that would have reached silicon,
 * found with no board attached.
 *
 * 16, not 8: `long double` and any vector type the compiler may use to copy
 * a large struct want it, and this is a one-time cost of at most fifteen
 * bytes of padding in a 4MiB arena. _Alignas is C11, which every compiler
 * this port is built by (zig cc for both puck targets, xtensa-gcc for the
 * real IDF build) has had for years. */
#define _GAMEOS_ARENA_ALIGN 16u

// GOS_PANEL_W * GOS_PANEL_H * 2 (gos.h), spelled as a literal rather than
// pulled from gos.h here: this header is included by gfx.c BEFORE gos.h's
// own macros would be back in scope from this translation unit's point of
// view is not guaranteed, and a mismatch would rather fail loudly (a
// too-small buffer overrun caught by inspection/review) than silently via
// a macro that quietly changed meaning. Cross-checked against gos.h's
// GOS_PANEL_W=368/GOS_PANEL_H=448 by grep, not guessed.
#define _GAMEOS_FB565_BYTES (368u * 448u * 2u)
static _Alignas(_GAMEOS_ARENA_ALIGN) uint8_t s_fb565Backing[_GAMEOS_FB565_BYTES];
static int s_fb565Taken;

// 4 MiB: generous, documented headroom over golf_t's own measured ~3.8MB
// (this port's README, "GOLF's memory budget" - the largest of this
// bundle's five game states by a wide margin), sized as a round number
// rather than golf_t's exact byte count because golf_int.h's type is not
// visible from this header (included long before any game header, same
// reasoning this file already gives the fb565 literal above). This port's
// own build already reserves real wasm linear memory for it explicitly
// (packs/esp32-s3-touch-amoled-18/wasm/build.ts --wasm-memory-mb 8, see
// this port's README).
#define _GAMEOS_GAMESTATE_BYTES (4u * 1024u * 1024u)
static _Alignas(_GAMEOS_ARENA_ALIGN) uint8_t s_gameStateBacking[_GAMEOS_GAMESTATE_BYTES];
static int s_gameStateTaken;

// calloc semantics (zeroed): the fb565 slot relies on a plain static array
// being zero-initialized once, for its one-and-only allocation (never
// freed, so never reused - no explicit memset needed there). The
// game-state slot IS reused across launches, so it is zeroed by hand on
// every successful allocation - a second launch after a free must not see
// the previous game's leftover bytes.
static inline void *heap_caps_calloc(size_t n, size_t size, uint32_t caps) {
    (void)caps;
    size_t bytes = n * size;
    if (bytes == _GAMEOS_FB565_BYTES) {
        if (s_fb565Taken) return (void *)0;
        s_fb565Taken = 1;
        return s_fb565Backing;
    }
    if (bytes > 0 && bytes <= _GAMEOS_GAMESTATE_BYTES) {
        if (s_gameStateTaken) return (void *)0;
        s_gameStateTaken = 1;
        for (size_t i = 0; i < bytes; i++) s_gameStateBacking[i] = 0;
        return s_gameStateBacking;
    }
    return (void *)0;
}

// Only ever called on a game-state pointer (shell.c's quit_game()) - the
// fb565 buffer is never freed by any vendored caller (checked by grep,
// matches gfx.c's own "single-buffered ... static uint16_t *fb565" shape,
// which persists for the module's lifetime on real silicon too).
static inline void heap_caps_free(void *p) {
    if (p == (void *)s_gameStateBacking) s_gameStateTaken = 0;
}

// No real heap to measure - a pair of purpose-built static arenas, not a
// general allocator (this file's own header comment). Both callers
// (shell.c's debug overlay, apps.c's DIAG screen) only ever print this as
// diagnostic text for a human to read; neither this bundle's demo nor its
// invariants read a heap-size number as a gameplay signal. A stated,
// honest 0 rather than a fabricated plausible-looking figure.
static inline size_t heap_caps_get_free_size(uint32_t caps) {
    (void)caps;
    return 0;
}

#endif
