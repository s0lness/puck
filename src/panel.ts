// Blits the framebuffer to a canvas, one pushed rectangle at a time (never
// the whole panel per frame), so the emulator exercises the same
// partial-refresh path the firmware's own push function does. Which
// rectangles to draw comes from emu_push_* (see readPushes); this file only
// knows how to turn raw framebuffer bytes into pixels once it has a
// rectangle to read.
//
// Pixel format is whatever emu_device() declared (panel.format). Only
// "rgb565be" is implemented, because it is the only one this repo's own
// example firmware and reference device declare; an unrecognised format
// throws rather than silently misrendering, on the same "guess and hope is
// the wrong instinct" principle documented in docs/decisions/0002. Add a
// reader here for any other format your firmware declares.
//
// The pure pixel-reading functions (readFramebufferRGB) have no DOM
// dependency on purpose: harness/ (the differential test harness) reads a
// framebuffer the same way, headless, with no canvas or browser involved.

import type { EmuExports } from "./wasm";
import { validatePushCount, validatePushRect } from "./abiGuard";

export interface PushRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReadPushesResult {
  rects: PushRect[];
  // Human-readable notes about push data this emulator refused to trust
  // (an out-of-bounds rectangle, a count so large it looks like a bug in
  // emu_tick()'s own bookkeeping - see abiGuard.ts). Empty when nothing was
  // wrong. The caller decides where these go (the console pane, a freeze
  // bundle); this function's only job is not trusting raw ABI output.
  findings: string[];
}

// Bounded and validated at the boundary, per abiGuard.ts: emu_push_count()
// drives this loop, so an absurd count gets capped BEFORE the loop runs
// (not after a bad rectangle happens to throw), and every rectangle is
// checked against the panel's own declared bounds before it is ever handed
// to blitRect. A rectangle that fails validation is skipped, not clamped:
// clamping it into bounds would draw something that never actually
// happened and hide the exact geometry error a partial-refresh bug is made
// of (see wasm/emu_abi.h's push-window section).
export function readPushes(emu: EmuExports, panelW: number, panelH: number): ReadPushesResult {
  const findings: string[] = [];
  const { count, reason: countReason } = validatePushCount(emu.emu_push_count());
  if (countReason) findings.push(countReason);

  const rects: PushRect[] = [];
  for (let i = 0; i < count; i++) {
    const rect = { x: emu.emu_push_x(i), y: emu.emu_push_y(i), w: emu.emu_push_w(i), h: emu.emu_push_h(i) };
    const v = validatePushRect(rect, panelW, panelH);
    if (!v.ok) {
      findings.push(`push[${i}]: ${v.reason} -- not drawn`);
      continue;
    }
    rects.push(rect);
  }
  return { rects, findings };
}

// One pixel from raw framebuffer bytes to (r, g, b), 0..255 each.
export type PixelReader = (raw: number) => [number, number, number];

// Undoes the byte swap "rgb565be" declares: the framebuffer stores RGB565
// with its two bytes in the panel DMA's order, which on every real target
// (little-endian) is the opposite of how a uint16_t is stored. Reading it
// back through a Uint16Array gives the same swapped value the firmware
// computed (wasm linear memory and JS typed arrays are both little-endian),
// so this is the one place that swap gets undone, on purpose: what the page
// displays is the device's actual memory, not a tidied copy of it.
function rgb565be(raw: number): [number, number, number] {
  const v = ((raw & 0xff) << 8) | ((raw >> 8) & 0xff);
  const r5 = (v >> 11) & 0x1f;
  const g6 = (v >> 5) & 0x3f;
  const b5 = v & 0x1f;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

// A plain little-endian RGB565 reader, for a firmware whose framebuffer is
// NOT byte-swapped for a panel DMA (declare "rgb565" rather than
// "rgb565be" in emu_device() to select this).
function rgb565(raw: number): [number, number, number] {
  const r5 = (raw >> 11) & 0x1f;
  const g6 = (raw >> 5) & 0x3f;
  const b5 = raw & 0x1f;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

const PIXEL_READERS: Record<string, PixelReader> = {
  rgb565be,
  rgb565,
};

/**
 * Whether this emulator has a reader for a declared panel format, asked
 * WITHOUT throwing. pixelReaderFor() below refuses an unknown format loudly,
 * which is right when a module is already loading and wrong when a caller is
 * deciding whether to offer that module at all: site/build.ts asks this
 * before it emits a run page for a silhouette, so a board declaring a format
 * nothing here can present gets an honest sentence instead of a page that
 * would fail on open. The list is PIXEL_READERS' own keys, so a reader added
 * there is offered here with no second place to update.
 */
export function supportsPixelFormat(format: string): boolean {
  return Object.prototype.hasOwnProperty.call(PIXEL_READERS, format);
}

export function pixelReaderFor(format: string): PixelReader {
  const reader = PIXEL_READERS[format];
  if (!reader) {
    throw new Error(
      `unsupported panel pixel format "${format}" (this emulator implements: ${Object.keys(PIXEL_READERS).join(", ")}). ` +
        `Add a reader in src/panel.ts's PIXEL_READERS for your firmware's format.`
    );
  }
  return reader;
}

// Reads a rectangle of the framebuffer straight out of wasm linear memory
// as RGB triplets (3 bytes/pixel, row-major), no canvas involved. This is
// the pure function both the DOM blitter below and the headless
// differential harness (harness/) build on: the harness needs pixel data
// to hash and diff, and has no DOM to put a canvas in.
//
// Re-reads memory.buffer fresh on every call (not cached by the caller):
// WebAssembly.Memory.grow() can detach and replace the underlying
// ArrayBuffer, so a stale view would read garbage or throw.
export function readFramebufferRGB(
  memory: WebAssembly.Memory,
  fbPtr: number,
  panelW: number,
  reader: PixelReader,
  rect: { x: number; y: number; w: number; h: number }
): Uint8Array {
  const { x, y, w, h } = rect;
  const out = new Uint8Array(Math.max(0, w) * Math.max(0, h) * 3);
  if (w <= 0 || h <= 0) return out;
  const fb = new Uint16Array(memory.buffer, fbPtr, panelW * (y + h));
  let di = 0;
  for (let row = 0; row < h; row++) {
    const rowStart = (y + row) * panelW + x;
    for (let col = 0; col < w; col++) {
      const [r, g, b] = reader(fb[rowStart + col]!);
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      di += 3;
    }
  }
  return out;
}

// Blits one rectangle from the framebuffer onto a canvas, at its own (x, y)
// in panel space. A thin DOM-specific wrapper over readFramebufferRGB.
export function blitRect(
  ctx: CanvasRenderingContext2D,
  memory: WebAssembly.Memory,
  fbPtr: number,
  panelW: number,
  reader: PixelReader,
  rect: PushRect
): void {
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return;
  const rgb = readFramebufferRGB(memory, fbPtr, panelW, reader, rect);
  const img = ctx.createImageData(w, h);
  for (let i = 0, di = 0; i < rgb.length; i += 3, di += 4) {
    img.data[di] = rgb[i]!;
    img.data[di + 1] = rgb[i + 1]!;
    img.data[di + 2] = rgb[i + 2]!;
    img.data[di + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

export function blitAll(
  ctx: CanvasRenderingContext2D,
  memory: WebAssembly.Memory,
  fbPtr: number,
  panelW: number,
  panelH: number,
  reader: PixelReader
): void {
  blitRect(ctx, memory, fbPtr, panelW, reader, { x: 0, y: 0, w: panelW, h: panelH });
}
