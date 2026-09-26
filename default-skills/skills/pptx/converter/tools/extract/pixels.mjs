// Pixel sizes read from image HEADERS, never by decoding: the router refuses an image whose decoded bitmap would be
// too large before Chromium ever sees it. The renderer's V8 heap cap does not cover decoded bitmaps, and a small,
// highly compressible file can decode to gigabytes (a 1.2 MB 12000x12000 PNG added ~0.7 GiB to a build's peak memory
// on the dev box), so the served-file byte cap alone bounds nothing. Covers every raster format Chromium decodes:
// PNG (and APNG), JPEG, GIF, WebP, BMP, ICO/CUR and AVIF (docs/CONTRACT.md "Isolation").
//
//   imageSize(buf) -> {format, width, height}   a raster image and its (largest) pixel size
//                  -> {format, width: null, height: null}   a raster image whose size cannot be read (refused: fail closed)
//                  -> null                      not a raster image (text, fonts, SVG, anything else)
//   dataImages(text) -> [{format, width, height, key}]   the base64 data: images inside an HTML/CSS/SVG text
import crypto from 'node:crypto';

const u16be = (b, o) => b.readUInt16BE(o);
const u16le = (b, o) => b.readUInt16LE(o);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => b.readUInt32BE(o);
const u32le = (b, o) => b.readUInt32LE(o);
const ascii = (b, o, n) => b.toString('latin1', o, o + n);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sized(format, width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { format, width, height }
    : { format, width: null, height: null };
}

function pngSize(b) {
  // IHDR must be the first chunk: length(4) "IHDR" width(4) height(4)
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return sized('png', null, null);
  return sized('png', u32be(b, 16), u32be(b, 20));
}

function jpegSize(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return sized('jpeg', null, null);
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }                      // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // TEM, RSTn, SOI: no length
    if (m === 0xd9 || m === 0xda) break;                       // EOI / SOS before any SOF: no frame header
    const len = u16be(b, i + 2);
    if (len < 2) break;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC): precision(1) height(2) width(2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) break;
      return sized('jpeg', u16be(b, i + 7), u16be(b, i + 5));  // height 0 (DNL) is unreadable: refused
    }
    i += 2 + len;
  }
  return sized('jpeg', null, null);
}

function gifSize(b) {
  if (b.length < 13) return sized('gif', null, null);
  let w = u16le(b, 6), h = u16le(b, 8);
  const flags = b[10];
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const skipSubBlocks = () => {
    while (i < b.length) {
      const n = b[i];
      i += 1 + n;
      if (n === 0) return true;
    }
    return false;
  };
  // every frame's extent, not just the logical screen (a frame larger than the screen enlarges the decoded image)
  while (i < b.length) {
    const t = b[i];
    if (t === 0x3b) break;                                     // trailer
    if (t === 0x21) {                                          // extension: label, sub-blocks
      i += 2;
      if (!skipSubBlocks()) break;
    } else if (t === 0x2c) {                                   // image descriptor
      if (i + 10 > b.length) break;
      w = Math.max(w, u16le(b, i + 1) + u16le(b, i + 5));
      h = Math.max(h, u16le(b, i + 3) + u16le(b, i + 7));
      const f = b[i + 9];
      i += 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1; // local colour table, LZW minimum code size
      if (!skipSubBlocks()) break;
    } else {
      break;
    }
  }
  return sized('gif', w, h);
}

function webpSize(b) {
  if (b.length < 30) return sized('webp', null, null);
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return sized('webp', u24le(b, 24) + 1, u24le(b, 27) + 1);            // the canvas
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = u32le(b, 21);
    return sized('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return sized('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return sized('webp', null, null);
}

/**
 * A BMP / DIB header at `o`: BITMAPCOREHEADER (12 bytes) or BITMAPINFOHEADER and later (>= 16). In an ICO the DIB
 * height counts the AND mask too, i.e. twice the image height.
 */
function dibSize(b, o, format, icoHalfHeight = false) {
  if (o + 12 > b.length) return sized(format, null, null);
  const hs = u32le(b, o);
  let w, h;
  if (hs === 12) {
    w = u16le(b, o + 4);
    h = u16le(b, o + 6);
  } else if (hs >= 16) {
    w = Math.abs(b.readInt32LE(o + 4));
    h = Math.abs(b.readInt32LE(o + 8));                        // negative = top-down rows
  } else {
    return sized(format, null, null);
  }
  return sized(format, w, icoHalfHeight ? Math.ceil(h / 2) : h);
}

function icoSize(b) {
  const n = u16le(b, 4);
  if (!n || b.length < 6 + 16 * n) return sized('ico', null, null);
  let w = 0, h = 0;
  for (let k = 0; k < n; k++) {
    const e = 6 + 16 * k;
    let ew = b[e] || 256, eh = b[e + 1] || 256;                // the directory says 0 for >= 256
    const size = u32le(b, e + 8), off = u32le(b, e + 12);
    if (size >= 12 && off + 12 <= b.length) {
      // the embedded image decides: a PNG (any size) or a DIB
      const s = b.subarray(off, off + 8).equals(PNG_SIG) ? pngSize(b.subarray(off)) : dibSize(b, off, 'ico', true);
      if (s.width === null) return sized('ico', null, null);
      ew = Math.max(ew, s.width);
      eh = Math.max(eh, s.height);
    }
    w = Math.max(w, ew);
    h = Math.max(h, eh);
  }
  return sized('ico', w, h);
}

const AVIF_CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);

function avifSize(b) {
  let w = 0, h = 0;
  let boxes = 0;
  const walk = (start, end, depth) => {
    let i = start;
    while (i + 8 <= end && boxes++ < 100000) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let head = 8;
      if (size === 1) {
        if (i + 16 > end) return;
        size = Number(b.readBigUInt64BE(i + 8));
        head = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < head || i + size > end) return;
      const p = i + head;
      if (type === 'ispe' && p + 12 <= i + size) {             // FullBox, then width(4) height(4)
        w = Math.max(w, u32be(b, p + 4));
        h = Math.max(h, u32be(b, p + 8));
      } else if (type === 'av01' && p + 28 <= i + size) {      // VisualSampleEntry: width/height at +24/+26
        w = Math.max(w, u16be(b, p + 24));
        h = Math.max(h, u16be(b, p + 26));
      } else if (AVIF_CONTAINERS.has(type) && depth < 8) {
        const skip = type === 'meta' ? 4 : type === 'stsd' ? 8 : 0; // FullBox header / + entry count
        walk(p + skip, i + size, depth + 1);
      }
      i += size;
    }
  };
  walk(0, b.length, 0);
  return w && h ? sized('avif', w, h) : sized('avif', null, null);
}

function isAvif(b) {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return false;
  const size = Math.min(u32be(b, 0), b.length);
  for (let o = 8; o + 4 <= size; o += 4) {
    if (o === 12) continue;                                    // minor_version
    const brand = ascii(b, o, 4);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

export function imageSize(b) {
  if (!Buffer.isBuffer(b) || b.length < 4) return null;
  if (b.subarray(0, 8).equals(PNG_SIG)) return pngSize(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  const sig6 = ascii(b, 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return gifSize(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpSize(b);
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26) return dibSize(b, 14, 'bmp');
  if (u16le(b, 0) === 0 && (u16le(b, 2) === 1 || u16le(b, 2) === 2) && b.length >= 6) return icoSize(b);
  if (isAvif(b)) return avifSize(b);
  return null;
}

// base64 data: images, e.g. src="data:image/png;base64,iVBOR…" or url(data:image/jpeg;base64,/9j/…); whitespace
// inside the payload is allowed (the URL parser drops it)
const DATA_IMAGE_RE = /data:image\/([a-z0-9.+-]+)(?:;[^,;"'()<>\s]*)*;base64,([A-Za-z0-9+/\s]+=*)/gi;

/**
 * The base64 data: images inside a served text (HTML, CSS, SVG), nested SVG data: images included (depth <= 3), and
 * — when the text percent-encodes base64 characters — those inside a percent-encoded data: SVG. A payload whose size
 * cannot be read is left out (the scan is best effort: a pattern it cannot see, the router cannot refuse).
 * -> [{format, width, height, key}], one entry per distinct payload (key = its sha256).
 */
export function dataImages(text) {
  const out = new Map();
  const scan = (t, depth) => {
    for (const m of t.matchAll(DATA_IMAGE_RE)) {
      const payload = m[2].replace(/\s+/g, '');
      const key = crypto.createHash('sha256').update(payload).digest('hex');
      if (out.has(key)) continue;
      const buf = Buffer.from(payload, 'base64');
      out.set(key, null);
      if (/^svg/i.test(m[1])) {
        if (depth < 3) scan(buf.toString('utf8'), depth + 1);
        continue;
      }
      const s = imageSize(buf);
      if (s && s.width !== null) out.set(key, { ...s, key });
    }
    if (/%2[bBfF]|%3[dD]/.test(t)) {
      const decoded = t.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (decoded !== t && depth < 3) scan(decoded, depth + 1);
    }
  };
  scan(String(text), 0);
  return [...out.values()].filter(Boolean);
}
