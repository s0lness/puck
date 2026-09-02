# 0010: No instruction-level emulator, until upstream models the peripherals

Date: 2026-09-02
Status: accepted

## Context

Decision 0002 accepts that the browser leg recompiles the firmware's C for
wasm and therefore proves app logic, not the shipped object code. The
roadmap's workstream 5 asked whether an instruction-level emulator could
close that gap by running the real `.bin`: real compiler, real SDK
startup, real memory layout, with the pack's hardware layer bridged to
this repository's own panel, touch and tilt instead of modelled
peripherals.

A time-boxed spike on 2026-09-02 tried it for the ESP32-S3 pack on
Espressif's QEMU fork (`qemu-develop-9.2.2-20260417`, the only Windows
asset, x86_64, which runs under Windows ARM64 emulation).

## What the spike found

- The fork's `esp32s3` machine models UART, SPI flash and PSRAM, the RGB
  parallel LCD, GDMA, crypto, TWAI, Ethernet, timers and RNG. It models
  no I2C, no generic or quad SPI, no USB Serial/JTAG, and no GPIO matrix.
- This pack's display sits on QSPI behind an I2C IO expander, its touch
  controller and IMU are on I2C, its buttons go through the GPIO matrix,
  and its console and devlink are on USB Serial/JTAG. Every peripheral
  the firmware initialises before reaching its main loop is unmodelled.
- Booting `site/flash-artifacts/esp32/esp32-demo.bin` under the fork
  starts a process and produces no serial output in twenty seconds: the
  console has nowhere to land, and `display_init()` cannot complete.
- Bridging the hardware layer on the puck side does not help: the
  functions that would be bridged never run, because the bus drivers
  under them fault first. Closing the gap means writing I2C, generic SPI
  and USB Serial/JTAG device models inside the QEMU fork itself, an
  upstream contribution measured in weeks.
- Mainline QEMU has no RP2350 at all.

## Decision

No instruction-level emulator in this repository for now. The marks a
port can hold stay at three, each honest about its reach:

- **emulator**: the wasm leg, app logic at source level;
- **host**: the same C built natively with sanitizers, replaying the same
  trace, for the compiler class of defects wasm hides;
- **silicon**: the differential harness against a real board over
  devlink, for everything under the app.

The ledger records the class of every defect found on silicon. If
compiler-class defects start to appear there, or if the QEMU fork gains
I2C and generic SPI for `esp32s3`, this decision is reopened with that
evidence.

## Consequences

- The site must never say a port "runs the exact binary" in the browser.
  Decision 0002 stands.
- The silicon mark is the only one that catches peripheral defects, so
  it has to be cheap and frequent: that is why the flash page itself
  runs the attestation (roadmap workstream 1).
- The host mark is the cheap answer to the compiler class; it is not a
  substitute for silicon and the docs must not present it as one.
