import { jpegDimensions, walkJpegSegments } from "./agent/visionImage.js";
import { detectImageMediaType } from "./imageFormat.js";
import type { ImageMediaType } from "./types.js";

/**
 * Pixel size of a stored image, read from its HEADER alone — never a decode,
 * never a dependency — so the chat can give an `<img>` its box before the bytes
 * arrive (a picture that loads into a zero-height box pushes everything below it
 * and fights the transcript's stick-to-bottom).
 *
 * Covers the formats Noah stores (`ImageMediaType`: PNG, JPEG, GIF, WebP).
 * Anything else, truncated or implausible returns null, and every caller reads
 * that as "size unknown" (the client then reserves a placeholder), never as an
 * error. The size is the one a browser DRAWS: a JPEG whose Exif orientation
 * turns it a quarter (5–8) has its edges swapped, as `image-orientation:
 * from-image` (every browser's default) shows it.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Larger than any image Noah accepts (5 MB caps); anything beyond is noise, not a size. */
const MAX_EDGE = 100_000;

function plausible(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) return null;
  return { width, height };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

function pngDimensions(b: Uint8Array): ImageDimensions | null {
  // Signature(8) + IHDR length(4) + "IHDR"(4) + width(4) + height(4): IHDR is always the first chunk.
  if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
  return plausible(u32be(b, 16), u32be(b, 20));
}

function gifDimensions(b: Uint8Array): ImageDimensions | null {
  // The logical screen descriptor right after the 6-byte signature.
  if (b.length < 10) return null;
  return plausible(u16le(b, 6), u16le(b, 8));
}

function webpDimensions(b: Uint8Array): ImageDimensions | null {
  // RIFF <size> WEBP, then the first chunk's fourcc at 12 and its payload at 20.
  if (b.length < 16) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") {
    // flags(4), canvas width-1 (24 bit LE), canvas height-1 (24 bit LE)
    if (b.length < 30) return null;
    return plausible(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  if (chunk === "VP8L") {
    // signature 0x2f, then 14 bits width-1 and 14 bits height-1 (LE bit order).
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return plausible((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    // frame tag(3), start code 9d 01 2a, then 14-bit width and height (top 2 bits = scale).
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return plausible(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return null;
}

/**
 * The Exif orientation (1–8) of a JPEG, or 0 when there is none to read. Walks
 * the segments up to the image data and reads tag 0x0112 of IFD0; every offset
 * is bounds-checked, and anything malformed is simply "no orientation".
 */
export function jpegExifOrientation(b: Uint8Array): number {
  const orientation = walkJpegSegments(b, (marker, i, length) =>
    marker === 0xe1 && length >= 8 && ascii(b, i + 2, i + 8) === "Exif\0\0"
      ? tiffOrientation(b, i + 8, i + length)
      : undefined,
  );
  return orientation ?? 0;
}

function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  if (start + 8 > end) return 0;
  const order = ascii(b, start, start + 2);
  if (order !== "II" && order !== "MM") return 0;
  const little = order === "II";
  const u16 = (at: number) => (little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
  const u32 = (at: number) =>
    little
      ? ((b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) >>> 0) + ((b[at + 3] << 24) >>> 0)
      : ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
  if (u16(start + 2) !== 42) return 0;
  const ifd = start + u32(start + 4);
  if (ifd < start + 8 || ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let n = 0; n < count; n += 1) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return 0;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

function jpegDisplayDimensions(b: Uint8Array): ImageDimensions | null {
  const frame = jpegDimensions(b);
  if (!frame) return null;
  const turned = jpegExifOrientation(b) >= 5;
  return plausible(turned ? frame.height : frame.width, turned ? frame.width : frame.height);
}

/**
 * Width/height of a PNG, JPEG, GIF or WebP from its header; null for anything
 * else or anything broken. `mediaType` is the type a caller ALREADY sniffed
 * from these same bytes (`detectImageMediaType`), so they are not sniffed twice.
 */
export function imageDimensions(
  bytes: Uint8Array,
  mediaType: ImageMediaType | null = detectImageMediaType(bytes),
): ImageDimensions | null {
  try {
    if (mediaType === "image/png") return pngDimensions(bytes);
    if (mediaType === "image/jpeg") return jpegDisplayDimensions(bytes);
    if (mediaType === "image/gif") return gifDimensions(bytes);
    if (mediaType === "image/webp") return webpDimensions(bytes);
  } catch {
    // Header reading is index arithmetic over a buffer; nothing here should
    // throw, but a size is never worth failing an upload over.
  }
  return null;
}

/** The `{ width, height }` fields to spread onto an image attachment — empty when the size cannot be read. */
export function imageDimensionFields(bytes: Uint8Array, mediaType?: ImageMediaType): Partial<ImageDimensions> {
  const size = imageDimensions(bytes, mediaType);
  return size ? { width: size.width, height: size.height } : {};
}
