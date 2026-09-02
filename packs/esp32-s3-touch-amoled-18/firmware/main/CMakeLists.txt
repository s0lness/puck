# The portable runtime (../runtime) and the app (../apps, or wherever
# PUCK_APP_SOURCE points) are pulled straight into this one component
# rather than split into their own idf_component - they compile identically
# for wasm (wasm/build.ts) and the board, and splitting them into a second
# ESP-IDF component would buy nothing this pack needs today.
#
# PUCK_APP_SOURCE is this build's equivalent of wasm/build.ts's --app flag,
# and exists for the same reason: this pack has one app SLOT, not one app.
# A port living outside the pack (apps/chrono/ports/esp32-s3-touch-amoled-18/
# chrono.c) fills that slot by defining the same `g_demoApp` symbol
# runtime_core.c declares. Keeping the two builds' app selection the same
# shape is what lets the emulator side and the board side of a differential
# run be the same app rather than two apps that look alike.
#
#   idf.py build
#   idf.py -DPUCK_APP_SOURCE=<absolute path to a .c> build
#
# CMake caches this, so switching apps needs the flag on the command line
# that changes it, not on every later build; `idf.py fullclean` resets it.
if(NOT PUCK_APP_SOURCE)
    set(PUCK_APP_SOURCE "${CMAKE_CURRENT_LIST_DIR}/../apps/demo.c")
endif()
get_filename_component(PUCK_APP_SOURCE "${PUCK_APP_SOURCE}" ABSOLUTE)
get_filename_component(PUCK_APP_DIR "${PUCK_APP_SOURCE}" DIRECTORY)
message(STATUS "puck app slot: ${PUCK_APP_SOURCE}")

idf_component_register(
    SRCS
        "main.c"
        "display.c"
        "touch.c"
        "button.c"
        "imu.c"
        "../devlink.c"
        "../runtime/runtime_core.c"
        "../runtime/gfx_band.c"
        "${PUCK_APP_SOURCE}"
    INCLUDE_DIRS
        "."
        ".."
        "../runtime"
        "../apps"
)

# PUCK_APP_DIR is deliberately NOT in INCLUDE_DIRS above: that list applies
# to every source this component compiles (main.c, display.c, touch.c,
# button.c, imu.c, devlink.c, runtime_core.c, gfx_band.c - none of them
# app-owned), and a port living outside this pack may carry a private
# header of its own with the same name as a real one. It does today:
# apps/gameos/ports/esp32-s3-touch-amoled-18/{stdio,stdlib,string,math}.h
# exist purely as wasm32-freestanding stand-ins (zig's freestanding target
# ships none of those four - each file's own header comment says so), and
# apps/gameos/ports/esp32-s3-touch-amoled-18/{esp_log,esp_system,esp_timer,
# esp_random,esp_heap_caps,nvs,nvs_flash}.h are compat stand-ins with the
# same names as real ESP-IDF headers, scoped to that port's own unity-build
# translation unit (see gameos_port.c). Added component-wide, the four libc
# stand-ins silently shadowed the real newlib headers for every OTHER file
# here too - main.c's own `#include <stdio.h>`/`<stdlib.h>` resolved to a
# shim declaring none of printf/fflush/stdout/abort, and the native build
# failed with "implicit declaration of function 'printf'" the first time an
# app bringing its own libc shims (gameos) was built natively rather than
# to wasm (where main.c is never compiled at all - it is the board's own
# entry point, see AGENTS.md's "Building the wasm half"). Scoping the
# directory to just the app's own translation unit, via that source file's
# own INCLUDE_DIRECTORIES property below, is what wasm/build.ts's --app
# already gets for free (one zig cc invocation per file, inherently unable
# to leak into another translation unit) - this makes the native build
# agree instead of being the first consumer to notice the gap. See
# packs/rp2350-touch-amoled-18/firmware/CMakeLists.txt's own
# PUCK_SINGLE_APP_DIR comment for the sibling pack's identical fix, found
# the same way.
#
# Same source-file scoping for -Werror, one property down: this project's
# CMake (ESP-IDF's own default component flags) builds with -Wall -Werror
# and a short, named allowlist of downgrades (unused-function,
# unused-variable, deprecated-declarations, ...). A macro REDEFINITION has
# no such named -W flag to add to that allowlist (GCC's own diagnostic for
# it is unconditional, not gated behind a separate -Wsomething this project
# could target the way it targets the others) - found by actually building,
# not assumed: apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c is a
# forced unity build of several independently-authored vendored files
# (../../reference/esp32-gameos/{gunship,slots,golf}.c - see that file's own
# header comment), each free to define its own local `SFX` sound-table
# macro in what was, upstream, always its own separate translation unit;
# glued into one TU here, the second and third definitions are real
# redefinitions, not a bug this port introduced. The exact same code
# produces the exact same "SFX redefined" diagnostic on the sibling
# packs/rp2350-touch-amoled-18 native build (plain arm-none-eabi-gcc, no
# -Werror there) and on the wasm build (zig cc) - a plain warning, never
# fatal, on both. Only THIS build's own -Werror default turns it fatal, so
# this is where it is downgraded back to a warning, and only for this one
# translation unit: every other file this component compiles (main.c,
# display.c, touch.c, button.c, imu.c, devlink.c, runtime_core.c,
# gfx_band.c - none of them app-owned or unity-built) keeps -Werror at full
# strength.
set_source_files_properties("${PUCK_APP_SOURCE}" PROPERTIES
    INCLUDE_DIRECTORIES "${PUCK_APP_DIR}"
    COMPILE_OPTIONS "-Wno-error")
