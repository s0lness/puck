
set(PICO_BOARD pico2 CACHE STRING "Board type")
cmake_minimum_required(VERSION 3.27)

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(main C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

add_executable(main)

# THE WHOLE BINARY EXECUTES FROM SRAM, NOT XIP. This is the fix for the
# core1 freeze diagnosed in docs/decisions/0004: bootbtn.c samples the BOOT
# button by floating the flash chip select for ~100us at a time
# (read_cs_low()), which its own comment understands is fatal to any core
# fetching from flash at that moment - and it protects only the calling
# core. Core0 is covered (the function is __no_inline_not_in_flash_func and
# runs with its interrupts off); core1, which executed every sensor loop
# from flash via XIP, was not, so any XIP-cache miss on core1 during a
# borrow fetched garbage instructions through a deselected chip. The
# deleted pre-runtime main.c had already hit and documented this ("a
# periodic poll was in here briefly and the app hung with a white screen
# and no input"), and solved it by not polling; the runtime refactor
# deleted that file and reintroduced the periodic poll for bootClicked.
#
# copy_to_ram is the total form of the fix, chosen over per-function
# __not_in_flash_func annotation deliberately: annotating core1's call
# graph means auditing every callee forever (time_us_64, sleep_ms, libm's
# sqrtf, libgcc's 64-bit division helpers, the multicore launch trampoline,
# the vendor FT3168 reset - all were on core1's path and all live in
# flash), and one future refactor adding one innocent call silently
# reopens the hole, which is precisely how this bug returned the first
# time. With the entire image copied to SRAM at boot there is no XIP
# execution on either core, ever, so the chip-select borrow is safe by
# construction and stays safe. Cost, measured before the change: 65KB
# .text + 4KB .rodata against roughly 355KB of free SRAM, and a few ms of
# boot-time copy.
pico_set_binary_type(main copy_to_ram)

pico_generate_pio_header(main ${CMAKE_CURRENT_LIST_DIR}/lib/QSPI_PIO/qspi.pio
                        OUTPUT_DIR ${CMAKE_CURRENT_LIST_DIR}/lib/QSPI_PIO)

# I2S TX for the ES8311 speaker codec (firmware/runtime/sound.c). Same
# pico_generate_pio_header pattern as qspi.pio above, output alongside the
# .pio source rather than into lib/QSPI_PIO - this is the sound service's
# own PIO program, not the display's.
pico_generate_pio_header(main ${CMAKE_CURRENT_LIST_DIR}/runtime/sound_i2s.pio
                        OUTPUT_DIR ${CMAKE_CURRENT_LIST_DIR}/runtime)

# One binary holds every app, and switching between them is a function call
# rather than a reboot. See docs/decisions/0002-runtime-architecture.md: a
# reboot costs 182ms of which 150ms is the sleep-out the SH8601 physically
# requires, so no amount of tuning lets a reboot compete with a repaint.
#
# Adding an app is one file here plus one entry in g_apps[] in runtime.c.
target_sources(main PRIVATE
    # The runtime: owns the screen, the input and the main loop.
    # runtime_core.c is the portable half (docs/decisions/0003): the arena,
    # the app table, switching, and per-frame dispatch. It compiles for the
    # board here and for wasm32-freestanding in packs/rp2350-touch-amoled-18/wasm/build.ts, so
    # do not add anything to it that depends on pico-sdk or hardware/*.
    runtime/runtime_core.c
    runtime/runtime.c
    runtime/gfx.c
    runtime/sensors.c
    # tilt.c is the orientation signal, and it is portable for the same reason
    # sound_synth.c below is: it also compiles into emu.wasm unmodified, so
    # the emulator runs the board's own filter, axis mapping and hysteresis
    # rather than a browser-side second copy of them. sensors.c (core1) is the
    # only thing that ever feeds it a real reading; nothing in here touches
    # i2c1.
    runtime/tilt.c
    # tune_registry.c aggregates the live-tunable knobs that
    # firmware/apps/app_tunables.inc lists, behind one flat name/index
    # space for devlink's TUNE command and the emulator's panel.
    # Portable like runtime_core.c, so it compiles for wasm too.
    runtime/tune_registry.c
    # storage.c is the last-flash-sector key/value store. Board-only: the
    # emulator's stand-in lives in wasm/emu_shim.c instead, so nothing here
    # pretends to exercise flash_safe_execute(), a sector erase or core1's
    # lockout.
    runtime/storage.c
    # sound_synth.c is the portable half (no PIO/DMA/i2c/pico-sdk
    # dependency): it also compiles into emu.wasm unmodified (packs/rp2350-touch-amoled-18/wasm/
    # build.ts), so the emulator's WebAudio preview is genuinely this
    # firmware's own synthesis - see sound.c's header comment. sound.c is the
    # board half: the ES8311 bring-up and the PIO+DMA I2S path.
    runtime/sound_synth.c
    runtime/sound.c

    # BOOT is not a GPIO on this part: reading it borrows the flash chip
    # select with interrupts off, so it lives in its own file with the
    # explanation of what that costs.
    bootbtn.c

    # devlink: the USB screenshot / touch-injection / app-navigation link an
    # agent uses to see and drive the board without a human. Its old hooks
    # called straight into the sketchpad's own inject_down/move/up
    # functions, which stopped existing when touch moved onto core1's
    # lock-free queue; runtime.c now wires it to sensors_inject_touch() (a
    # second, core0-owned ring merged into that same queue by timestamp, so
    # devlink never becomes a second producer of core1's ring) instead, so
    # every app gets injected touches for free, not just the sketchpad. See
    # devlink.h, runtime.c's "devlink wiring" section and
    # tools/README-devlink.md for the full story.
    devlink.c
)

# The apps. Normally the pack's own four (menu, sketch, chrono, timer) plus
# their shared helpers (digits, shapes) - see AGENTS.md. A single-app NATIVE
# build (packs/rp2350-touch-amoled-18/tools/build-native.ts's --app flag, the
# native equivalent of wasm/build.ts's own --app) instead links exactly one
# ported app plus a GENERATED app_roster.inc.
#
# The app layer is declared by firmware/apps/app_roster.inc, which
# runtime_core.c includes; runtime_core.c is a pack firmware source a port may
# never edit (see AGENTS.md). So the generated roster is not a source at all -
# it is a file of the same name in the port's own build directory, put FIRST on
# the include path so it wins over the hand-written reference roster. That is
# the whole mechanism: no extra translation unit, no link-order question, and
# runtime_core.c untouched.
#
# PUCK_SINGLE_APP_ROSTER is the DIRECTORY holding that generated
# app_roster.inc. Neither variable is ever set by hand: build-native.ts writes
# the roster into its own out-of-tree build dir and passes both on the cmake
# command line, so the DEFAULT build below is unchanged unless that flag is
# given.
if(DEFINED PUCK_SINGLE_APP_ROSTER)
    if(NOT DEFINED PUCK_SINGLE_APP_SOURCE)
        message(FATAL_ERROR "PUCK_SINGLE_APP_ROSTER also needs PUCK_SINGLE_APP_SOURCE (the port's own .c file)")
    endif()
    target_sources(main PRIVATE
        ${PUCK_SINGLE_APP_SOURCE}
    )
    # BEFORE apps/, so runtime_core.c's #include "app_roster.inc" resolves to
    # the generated one. target_include_directories appends, and firmware/apps
    # is added further down this file, so this call lands first.
    target_include_directories(main BEFORE PRIVATE ${PUCK_SINGLE_APP_ROSTER})
    # So a port file outside firmware/apps/ can #include a private helper
    # header of its own - the same allowance wasm/build.ts's --app gives it.
    # SCOPED TO THE APP'S OWN TRANSLATION UNIT ONLY, via the source file's
    # own INCLUDE_DIRECTORIES property, not target_include_directories:
    # that call adds the directory to every source main compiles, and a
    # port's own helper header can carry the same name as a real one -
    # apps/gameos/ports/rp2350-touch-amoled-18/string.h exists purely as a
    # freestanding-wasm32 stand-in (that file's own header comment: zig's
    # wasm32-freestanding target ships no <string.h> at all), declaring only
    # memset()/memcpy(). Added target-wide, it silently shadowed the real
    # newlib <string.h> for devlink.c too - a PACK file, not app-owned,
    # unrelated to any single app and needing the real strchr/strlen/strcmp
    # PUSHSTATS and TUNE FREEZE both call - and broke the native build with
    # "implicit declaration of function 'strchr'" the first time an app
    # bringing its own string.h shim (gameos) was built natively rather than
    # to wasm (where devlink.c is never compiled at all - see AGENTS.md's
    # "WebAssembly" section - so the collision could not show up there).
    # Scoping the include to the app's own .c file is exactly what
    # wasm/build.ts's --app already does (one zig cc invocation per file,
    # inherently unable to leak into another translation unit); this makes
    # the native build agree instead of being the first consumer to notice
    # the gap.
    get_filename_component(PUCK_SINGLE_APP_DIR ${PUCK_SINGLE_APP_SOURCE} DIRECTORY)
    set_source_files_properties(${PUCK_SINGLE_APP_SOURCE} PROPERTIES
        INCLUDE_DIRECTORIES ${PUCK_SINGLE_APP_DIR})
else()
    target_sources(main PRIVATE
        apps/menu.c
        apps/sketch.c
        apps/chrono.c
        apps/timer.c
        apps/digits.c
        # Round-silhouette helpers (ring/wedge row math), used by menu.c's
        # stopwatch icon. See shapes.h for why it is not also wired into
        # timer.c yet.
        apps/shapes.c
    )
endif()

# appswitch.c and bootreq.h are deliberately NOT built any more. They existed
# to reboot into the other flash slot, which is what this architecture
# replaced; leaving a reboot-into-another-image path compiled into a binary
# that no longer has a second image to go to is a hazard, not dead weight.
# The partition table of that retired design stays (in the private repo this
# firmware came from, not here), repurposed as a golden fallback for
# crash recovery, and that path will bring its own entry point when it lands.

add_subdirectory(./lib/Config)
add_subdirectory(./lib/QSPI_PIO)
add_subdirectory(./lib/AMOLED)
add_subdirectory(./lib/Touch)
add_subdirectory(./lib/QMI8658)

include_directories(./lib/Config)
include_directories(./lib/QSPI_PIO)
include_directories(./lib/AMOLED)
include_directories(./lib/Touch)
include_directories(./lib/QMI8658)
include_directories(./runtime)
include_directories(./apps)
include_directories(.)

target_link_libraries(main PRIVATE
    Config
    QSPI_PIO
    AMOLED
    Touch
    QMI8658
    pico_stdlib
    hardware_pio
    hardware_pwm
    hardware_dma
    hardware_spi
    hardware_i2c
    hardware_gpio
    hardware_adc
    # The runtime feeds a hardware watchdog once per loop, so a hung app
    # reboots on its own. The manual recovery is a ten-second button ritual
    # that the owner knows and the child does not, and the owner will not be
    # in the room.
    hardware_watchdog
    # sensors.c runs touch, the IMU and the PMIC on core1 so core0 never
    # blocks on i2c1: the touch read alone was about 695us, roughly 98
    # percent of frame time.
    pico_multicore
    # __dmb(), for the lock-free single-producer/single-consumer touch queue
    # between the cores.
    hardware_sync
    # core1 fault capture (sensors.c's core1_install_fault_handlers()).
    # Originally added while investigating core1 dying about a second after
    # boot; kept permanently (both as a real safety net and because the
    # invariant checker's reachability graph hardcodes core1_fault_handler
    # as a root - see tools/invariants/rules/rp2350-amoled-1.8.ts).
    hardware_exception
)

pico_enable_stdio_usb(main 1)
pico_enable_stdio_uart(main 1)

# BOOTSEL WITHOUT THE BUTTON RITUAL, which is what the web flasher at
# puck.sylve.org reboots the board with (site/flasher/flash.ts's
# rebootToBootsel()).
#
# pico-sdk's pico_usb_reset puts a third USB interface next to the CDC pair
# this firmware already exposes: a VENDOR interface (class 0xFF, subclass
# RESET_INTERFACE_SUBCLASS 0x00, protocol RESET_INTERFACE_PROTOCOL 0x01, no
# endpoints, interface number 2 since CDC takes 0 and 1) whose
# RESET_REQUEST_BOOTSEL (0x01) control request calls
# rom_reset_usb_boot_extra() and never returns, so the board re-enumerates
# as 2E8A:000F, an RP2350 BOOTSEL device, with PICOBOOT and the mass
# storage volume both live. It is the same interface `picotool load -f`
# uses; the browser reaches it with a claimInterface + controlTransferOut
# instead of libusb.
#
# SDK 2.3.0 already turns every one of these on by default for an
# application that does not drive TinyUSB itself (see
# pico_usb_reset/include/pico/usb_reset_config.h: each default is 1 when
# neither LIB_TINYUSB_HOST nor LIB_TINYUSB_DEVICE is set), so this block
# changes no byte of today's image. It pins the behaviour rather than
# adding it. A default is not a contract: this firmware declaring its own
# TinyUSB descriptors one day would silently flip all of them to 0, and the
# damage would show up as a web page that can no longer flash, on somebody
# else's machine, not as a build error here. Both spellings are set because
# the config names changed in SDK 2.3.0 and the older ones are what an
# SDK <= 2.2.0 checkout reads (each new name is consulted first, so the old
# one is simply ignored on 2.3.0).
target_compile_definitions(main PRIVATE
    PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=1
    PICO_STDIO_USB_ENABLE_RESET_VIA_VENDOR_INTERFACE=1
    PICO_USB_RESET_SUPPORT_RESET_TO_BOOTSEL=1
    PICO_STDIO_USB_RESET_INTERFACE_SUPPORT_RESET_TO_BOOTSEL=1
    # bit 0 disables the mass storage volume, bit 1 disables PICOBOOT.
    # Neither may be disabled: PICOBOOT is what the flasher writes flash
    # with the moment the board comes back, and the mass storage volume is
    # the drag-and-drop fallback a human uses when the flasher is not an
    # option. The bootrom ORs this mask with the low two bits of the
    # control request's wValue, so a host sending wValue 0 (which the
    # flasher does) gets both interfaces.
    PICO_USB_RESET_BOOTSEL_INTERFACE_DISABLE_MASK=0
    # Windows hands a driverless interface to WinUSB (and therefore to
    # WebUSB) only when the device carries a Microsoft OS 2.0 descriptor
    # naming that interface, which also forces bcdUSB to 0x0210. Without
    # it the reset interface is reachable from Linux and macOS and simply
    # invisible to a browser on Windows.
    PICO_USB_RESET_SUPPORT_MS_OS_20_DESCRIPTOR=1
    PICO_USB_RESET_MS_OS_20_DESCRIPTOR_ITF=2
)

# The board must never look dead just because a host opened the USB serial
# port and is not reading it: pico-sdk's stdio_usb driver (stdio_usb.c,
# stdio_usb_out_chars()) already bounds any ONE blocked write to
# PICO_STDIO_USB_STDOUT_TIMEOUT_US before giving up and dropping it, default
# 500ms. That is fine for a single stall nobody notices, but this board also
# has a 4-second watchdog (runtime.c's RUNTIME_WATCHDOG_MS) and a once-a-
# second profiler tick, so 500ms is a visible stutter for no benefit: a host
# that IS draining sees a USB Full-Speed round trip in microseconds, not
# milliseconds, so shortening this changes nothing for the case that works
# today and removes the worst case for the one that does not.
target_compile_definitions(main PRIVATE PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000)

# Touch sensitivity sweep knob (firmware/runtime/sensors.c's
# FT3168_TOUCH_THRESHOLD comment: FocalTech FT5x06-family register 0x80,
# ID_G_THGROUP, lower = more sensitive). Optional and off by default -
# sensors.c's own #ifndef supplies the built-in starting value - so a
# candidate can be tried with no source edit:
#   cmake -S firmware -B firmware/build -DFT3168_TOUCH_THRESHOLD=20
if(DEFINED FT3168_TOUCH_THRESHOLD)
    target_compile_definitions(main PRIVATE FT3168_TOUCH_THRESHOLD=${FT3168_TOUCH_THRESHOLD})
endif()

# Touch pipeline diagnostics (sensors.h's TOUCH_POLL_SELFTEST comment).
# Optional, off by default. Previously this only had one way to turn on:
# hand-edit sensors.h's #define and remember to revert it before shipping -
# exactly the kind of change a diff review can miss. A cmake flag removes
# that risk entirely for the default build:
#   cmake -S firmware -B firmware/build-diag -DTOUCH_POLL_SELFTEST=1
if(DEFINED TOUCH_POLL_SELFTEST)
    target_compile_definitions(main PRIVATE TOUCH_POLL_SELFTEST=${TOUCH_POLL_SELFTEST})
endif()

# Sketchpad live tuning over devlink (firmware/apps/sketch.c's
# SKETCH_LIVE_TUNE comment, firmware/devlink.c's TUNE command). Optional,
# off by default, same reasoning and same pattern as TOUCH_POLL_SELFTEST
# just above: a shipped build carries the tunables as plain #define
# constants with no runtime variable and no way to leave a knob in a bad
# position, and turning this on is a build flag, not a source edit to
# remember to revert:
#   cmake -S firmware -B firmware/build-tune -DSKETCH_LIVE_TUNE=1
if(DEFINED SKETCH_LIVE_TUNE)
    target_compile_definitions(main PRIVATE SKETCH_LIVE_TUNE=${SKETCH_LIVE_TUNE})
endif()

pico_add_extra_outputs(main)

# Fail the build on a violation of tools/invariants (docs/decisions/0006):
# static checks over the just-linked .elf/.map that catch regressions of
# known hazards (decision 0005's flash/core1 collision, decision 0004's
# stdio-lock-on-core1 finding) at build time instead of on hardware, days
# later. Runs after pico_add_extra_outputs() above, which is what actually
# produces the .map file this reads.
find_program(BUN_EXECUTABLE bun)
if(BUN_EXECUTABLE)
    add_custom_command(TARGET main POST_BUILD
        COMMAND ${BUN_EXECUTABLE} run
                ${CMAKE_CURRENT_LIST_DIR}/../tools/invariants/runner.ts
                $<TARGET_FILE:main>
                $<TARGET_FILE:main>.map
        COMMENT "Checking firmware invariants (tools/invariants, docs/decisions/0006)"
        VERBATIM
    )
else()
    message(WARNING "bun not found on PATH: tools/invariants did not run - see docs/decisions/0006")
endif()
