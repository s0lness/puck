// A minimal, dependency-free 24-bit RGB PNG encoder: one IDAT chunk, filter
// type None on every scanline, compressed with Bun's built-in deflate. No
// image library, because this repo's only other dependency is
// puppeteer-core (for the DOM-based headless check in scripts/verify.ts)
// and this is a small enough amount of bytes to just write directly.
//
// Bun.deflateSync produces raw DEFLATE (RFC 1951); PNG's IDAT chunk needs a
// zlib-wrapped stream (RFC 1950: a 2-byte header, then the deflate data,
// then a 4-byte Adler-32 trailer), so both are added by hand around the
// compressed bytes.

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// The decode half of the pair above: reads back exactly the shape
// encodeRGBPNG writes (8-bit RGB, one IDAT chunk, filter type None on every
// scanline), not a general PNG reader. Every frames/ PNG in this repository
// was written by encodeRGBPNG (harness/portdiff.ts's writePng), so this is
// a closed round trip, not a subset implementation of the PNG spec: tools/
// verify-bundle.ts's job is comparing a freshly captured frame against
// those recorded PNGs, which needs exactly this, and nothing a general
// decoder (interlacing, other bit depths, other filter types, palettes)
// would add is ever produced by this repository's own encoder.
export interface DecodedRGBPNG {
  width: number;
  height: number;
  rgb: Uint8Array;
}

function u32beAt(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Split into two halves, and it is worth saying why: the browser needs this
// decoder too. site/attest/ replays a bundle's trace against a real board
// from the gallery's own flash page and diffs the captured frames against
// that bundle's recorded PNGs, in a page, where Bun.inflateSync does not
// exist and the only inflate available is DecompressionStream, which is
// async. Everything EXCEPT the inflate call is identical between the two,
// so everything except the inflate call lives here once (parseRGBPNG,
// unfilterRGBScanlines) and each caller supplies its own decompressor.
// site/attest/pngFrame.ts is the browser half; it imports both of these.
//
// Decoding a frame through the browser's own image pipeline (an <img> into
// a canvas, getImageData) was the obvious alternative and is the wrong one:
// canvas readback goes through colour management, so a reference frame
// could come back a value or two off and turn a tolerance-zero comparison
// into a mystery divergence in the DIFF rather than one in the FIRMWARE.
// This path touches no colour space at all.
export interface ParsedRGBPNG {
  width: number;
  height: number;
  /**
   * The zlib stream from the IDAT chunk(s), header and Adler-32 trailer
   * already stripped: raw DEFLATE. Typed with an explicit ArrayBuffer
   * because Bun.inflateSync refuses a Uint8Array over an ArrayBufferLike
   * (which is what a subarray of the caller's own bytes would be); it is
   * copied into a fresh, non-shared buffer below for exactly that reason.
   */
  deflated: Uint8Array<ArrayBuffer>;
}

export function parseRGBPNG(bytes: Uint8Array): ParsedRGBPNG {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("decodeRGBPNG: not a PNG file (bad signature)");
  }

  let width = -1;
  let height = -1;
  let bitDepth = -1;
  let colorType = -1;
  const idatParts: Uint8Array[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    const length = u32beAt(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      width = u32beAt(data, 0);
      height = u32beAt(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // skip the trailing CRC
  }

  if (width < 0 || height < 0) throw new Error("decodeRGBPNG: no IHDR chunk found");
  if (bitDepth !== 8 || colorType !== 2) {
    throw new Error(`decodeRGBPNG: only 8-bit RGB (colour type 2) is supported, got bit depth ${bitDepth}, colour type ${colorType}`);
  }
  if (idatParts.length === 0) throw new Error("decodeRGBPNG: no IDAT chunk found");

  const zlibStream = idatParts.length === 1 ? idatParts[0]! : concat(idatParts);
  // Strip the 2-byte zlib header and 4-byte Adler-32 trailer encodeRGBPNG
  // wrote by hand around Bun.deflateSync's raw DEFLATE output.
  // Copied into a fresh, non-shared ArrayBuffer: Bun.inflateSync's types
  // want a Uint8Array<ArrayBuffer>, and a subarray view keeps whatever
  // buffer type the caller's original bytes happened to have.
  return { width, height, deflated: new Uint8Array(zlibStream.subarray(2, zlibStream.length - 4)) };
}

/** Inflated scanlines (one filter byte each, all of them type 0) -> flat RGB. */
export function unfilterRGBScanlines(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  const expectedRawLength = (stride + 1) * height;
  if (raw.length !== expectedRawLength) {
    throw new Error(`decodeRGBPNG: decompressed size ${raw.length} does not match the expected ${expectedRawLength} for ${width}x${height} RGB`);
  }

  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    if (filterType !== 0) {
      throw new Error(`decodeRGBPNG: scanline ${y} uses filter type ${filterType}, only filter type 0 (None) is supported`);
    }
    rgb.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return rgb;
}

export function decodeRGBPNG(bytes: Uint8Array): DecodedRGBPNG {
  const { width, height, deflated } = parseRGBPNG(bytes);
  return { width, height, rgb: unfilterRGBScanlines(Bun.inflateSync(deflated), width, height) };
}

// rgb: width * height * 3 bytes, row-major, top-left origin.
export function encodeRGBPNG(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  ihdrData.set(u32be(width), 0);
  ihdrData.set(u32be(height), 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  // Filter type None (0) prefixed to every scanline.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const deflated = Bun.deflateSync(raw, { level: 6 });
  const zlibStream = new Uint8Array(2 + deflated.length + 4);
  zlibStream[0] = 0x78; // CMF: deflate, 32K window
  zlibStream[1] = 0x9c; // FLG: default compression, checksum valid
  zlibStream.set(deflated, 2);
  zlibStream.set(u32be(adler32(raw)), 2 + deflated.length);
  const idat = chunk("IDAT", zlibStream);

  const iend = chunk("IEND", new Uint8Array(0));

  return concat([sig, ihdr, idat, iend]);
}
