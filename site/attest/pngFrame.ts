// The browser half of harness/png.ts's decoder: a bundle's recorded frame,
// read back to the exact bytes it was written from, inside a page.
//
// Everything but the inflate call comes from harness/png.ts, which is the
// point: parseRGBPNG() and unfilterRGBScanlines() are shared, and only the
// decompressor differs, because Bun.inflateSync does not exist here and the
// browser's own inflate (DecompressionStream) is async. One parser, two
// callers - the same arrangement harness/links/devlinkProtocol.ts has for
// the wire protocol, for the same reason.
//
// WHY NOT JUST DRAW IT ON A CANVAS. An <img> into a canvas and getImageData
// is three lines and would be wrong: canvas readback goes through the
// browser's colour management, so a reference frame can come back a value
// or two off from what was recorded. A comparison run at tolerance zero
// (which is what a pixel-exact port's verification means) would then report
// a divergence that is in the DIFF and not in the FIRMWARE, which is the
// exact shape of instrument failure this repository refuses elsewhere. This
// path decodes the file's own bytes and touches no colour space.

import { parseRGBPNG, unfilterRGBScanlines } from "../../harness/png";
import type { CapturedFrame } from "../../src/frame";

/** Inflates a raw DEFLATE stream with the browser's own decompressor. */
async function inflateRaw(deflated: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser has no DecompressionStream, so a recorded reference frame cannot be read back");
  }
  const stream = new Blob([deflated as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A bundle's recorded frame PNG -> the same CapturedFrame shape a board's SHOT decodes to. */
export async function decodeFramePNG(bytes: Uint8Array): Promise<CapturedFrame> {
  const { width, height, deflated } = parseRGBPNG(bytes);
  const raw = await inflateRaw(deflated);
  return { width, height, rgb: unfilterRGBScanlines(raw, width, height) };
}

/** Fetches and decodes one recorded frame, same-origin, by the URL site/build.ts emitted. */
export async function fetchFramePNG(url: string): Promise<CapturedFrame> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`could not fetch the recorded reference frame ${url}: HTTP ${resp.status}`);
  return decodeFramePNG(new Uint8Array(await resp.arrayBuffer()));
}
