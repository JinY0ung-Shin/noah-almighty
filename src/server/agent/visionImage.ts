/**
 * Claude's server-side image resize, ported from Anthropic's vision docs
 * (platform.claude.com/docs/en/build-with-claude/vision and
 * /vision-coordinates, read 2026-09-02), plus a header-only JPEG size reader.
 *
 * WHY this exists (#66): Claude answers a "click at these pixels" question in
 * the pixel space of the image it SEES — that is, AFTER the API downscales an
 * upload to the serving model's native vision size. A browser screenshot that
 * arrives BIGGER than that size therefore comes back with every coordinate off
 * by one constant factor (the field report: a menu item hit one row too high;
 * pure scale, zero offset). Keeping pixel-mode click_at honest means knowing
 * that native size, so the extension pre-fits a viewport capture to it and the
 * server warns when an older extension build did not. Both sides compute it
 * from the same rules — keep this file in sync with extension/axtree.js's
 * vision* helpers.
 *
 * The target is always the STANDARD tier. Noah cannot know the serving model's
 * resolution tier (model ids are whatever pi-gateway names them), and standard is the
 * size every Claude model sees at least: a high-resolution-tier model handed a
 * standard-fitted image merely gets a smaller one, never wrong coordinates.
 */

/** One visual token is one 28×28 patch of the (padded) image. */
export const VISION_PATCH_PX = 28;

/** Standard tier (every Claude model before 4.7): longest edge in pixels. */
export const VISION_STANDARD_MAX_EDGE = 1568;

/** Standard tier: total visual tokens, i.e. 28×28 patches. */
export const VISION_STANDARD_MAX_TOKENS = 1568;

/** A resolution tier's two ceilings. */
export type VisionLimits = { maxEdge: number; maxTokens: number };

const STANDARD_LIMITS: VisionLimits = {
  maxEdge: VISION_STANDARD_MAX_EDGE,
  maxTokens: VISION_STANDARD_MAX_TOKENS,
};

/** Visual-token cost of a w×h image: patch counts, rounded UP on both axes. */
export function visionTokens(width: number, height: number): number {
  return Math.ceil(width / VISION_PATCH_PX) * Math.ceil(height / VISION_PATCH_PX);
}

/**
 * Whether an image reaches the model at its own size, untouched. Both edges are
 * measured PADDED to the next whole patch, because the patch grid is what the
 * model holds — that padding is added on the bottom/right only and never shifts
 * a coordinate.
 */
export function visionFits(
  width: number,
  height: number,
  limits: VisionLimits = STANDARD_LIMITS,
): boolean {
  return (
    Math.ceil(width / VISION_PATCH_PX) * VISION_PATCH_PX <= limits.maxEdge &&
    Math.ceil(height / VISION_PATCH_PX) * VISION_PATCH_PX <= limits.maxEdge &&
    visionTokens(width, height) <= limits.maxTokens
  );
}

/**
 * Round half to EVEN. The docs' reference implementation derives the short edge
 * with Python's round(), which the API itself runs; JS Math.round is half-UP,
 * so a ".5" short edge would predict a size one pixel off the real one.
 */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size the API resizes a w×h upload to: the largest aspect-preserving size
 * that `visionFits`. Faithful port of the docs' reference implementation —
 * binary search on the LONG edge with the short edge derived by
 * round-half-to-even — so the answer matches the server's to the pixel.
 * Returns the input unchanged when it already fits.
 */
export function visionFitSize(
  width: number,
  height: number,
  limits: VisionLimits = STANDARD_LIMITS,
): [number, number] {
  if (visionFits(width, height, limits)) return [width, height];
  // Portrait: solve in landscape and swap back, so the search always runs on
  // the long edge (the one the max-edge ceiling actually binds).
  if (height > width) {
    const [fittedHeight, fittedWidth] = visionFitSize(height, width, limits);
    return [fittedWidth, fittedHeight];
  }
  const aspectRatio = width / height;
  let lo = 1; // always fits
  let hi = width; // never fits — the whole-image check above already failed
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (visionFits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1), limits)) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)];
}

/**
 * SOF (start-of-frame) markers carry the frame's real dimensions: 0xC0–0xCF are
 * SOF0–SOF15 EXCEPT three squatters sharing that range — 0xC4 DHT, 0xC8 JPG,
 * 0xCC DAC.
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Width/height of a JPEG read from its header alone — no decode, no dependency.
 *
 * WHY (#66): the only trustworthy statement about a screenshot's coordinate
 * space is the bitmap the browser ACTUALLY produced. The capture's theoretical
 * scale factor is a prediction — #66's measured ≈×1.145 skew is consistent with
 * it being off by 8/7 — so every layer reasoning about screenshot pixels
 * measures the bytes instead of trusting the formula. Returns null for anything that is not a
 * parseable JPEG (a PNG, a truncated buffer, garbage) — callers must read that
 * as "size unknown" and say nothing, never as an error.
 */
export function jpegDimensions(
  bytes: Buffer | Uint8Array,
): { width: number; height: number } | null {
  // SOI. Anything else is not a JPEG at all, so there is nothing to salvage.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let index = 2;
  while (index < bytes.length) {
    // Every segment is 0xFF <marker>; a run of 0xFF fill bytes ahead of the
    // marker is legal padding, so consume the whole run.
    if (bytes[index] !== 0xff) return null;
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    if (index >= bytes.length) return null;
    const marker = bytes[index];
    index += 1;
    // 0xFF00 is a stuffed data byte, never a segment: seeing one here means we
    // are no longer aligned to the segment stream.
    if (marker === 0x00) return null;
    // Standalone markers carry no length word: SOI, TEM, RST0–RST7.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // SOS starts entropy-coded data and EOI ends the file. Either way no SOF
    // was found, and walking compressed bytes as if they were segments would
    // invent a size out of noise.
    if (marker === 0xda || marker === 0xd9) return null;
    if (index + 1 >= bytes.length) return null;
    const length = (bytes[index] << 8) | bytes[index + 1];
    // The length word counts itself, so anything under 2 — or a segment running
    // past the buffer — means corrupt or truncated input.
    if (length < 2 || index + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      // Payload layout: length(2) precision(1) height(2) width(2) …
      if (length < 7) return null;
      const height = (bytes[index + 3] << 8) | bytes[index + 4];
      const width = (bytes[index + 5] << 8) | bytes[index + 6];
      if (!width || !height) return null;
      return { width, height };
    }
    index += length;
  }
  return null;
}
