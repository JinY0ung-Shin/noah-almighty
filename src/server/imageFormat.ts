import type { ImageMediaType } from "./types.js";

/**
 * The ONE image-format sniffer of the server: which of the formats Noah stores
 * (`ImageMediaType`: PNG, JPEG, GIF, WebP) the BYTES are, from their magic
 * numbers alone — never the name or a client-declared type. Every path that
 * judges image bytes (chat uploads, workspace images, the upload relay, the
 * header-only size reader) asks this, so they cannot disagree on what a PNG is.
 * Import-free on purpose: `chatImages.ts` re-exports it, and `imageDimensions.ts`
 * (which `chatImages.ts` imports) uses it without a cycle.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Do the bytes at `start` spell `text` (ASCII), exactly? */
function bytesAre(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The format of `bytes` from its magic number, or null for anything Noah does not store. */
export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytesAre(bytes, 0, "GIF87a") || bytesAre(bytes, 0, "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytesAre(bytes, 0, "RIFF") && bytesAre(bytes, 8, "WEBP")) return "image/webp";
  return null;
}
