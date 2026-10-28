// Generates the app icon set into src/client/public/ (icon-192/512, maskable,
// apple-touch-icon, favicon PNGs + .ico). Dependency-free: hand-rolled PNG
// encoder (zlib deflate + CRC32) drawing the "N" mark on a teal tile.
// Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "public");

/* ---------------- PNG encoder ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- Mark renderer ---------------- */
// Supersampled (4x) render of: teal tile (optional rounded corners) + white "N".
function drawIcon(size, { fullBleed = false } = {}) {
  const S = 4;
  const big = size * S;
  const radius = fullBleed ? 0 : big * 0.21;
  // glyph geometry (fractions of the tile)
  const gTop = 0.28 * big;
  const gBottom = 0.72 * big;
  const barW = 0.115 * big;
  const leftX = 0.3 * big;
  const rightX = 0.7 * big - barW;
  const diagHalf = barW / 2 + big * 0.004;

  const px = new Float64Array(big * big * 4);
  for (let y = 0; y < big; y++) {
    const t = y / big;
    // subtle vertical gradient: #12867d → #0b5f59
    const bg = [0x12 + (0x0b - 0x12) * t, 0x86 + (0x5f - 0x86) * t, 0x7d + (0x59 - 0x7d) * t];
    for (let x = 0; x < big; x++) {
      // rounded-rect coverage
      let alpha = 255;
      if (radius > 0) {
        const cx = Math.min(Math.max(x, radius), big - radius);
        const cy = Math.min(Math.max(y, radius), big - radius);
        const d = Math.hypot(x - cx, y - cy);
        alpha = Math.max(0, Math.min(1, radius - d + 0.5)) * 255;
      }
      let [r, g, b] = bg;
      // "N": two uprights + diagonal
      const inLeft = x >= leftX && x < leftX + barW && y >= gTop && y < gBottom;
      const inRight = x >= rightX && x < rightX + barW && y >= gTop && y < gBottom;
      let inDiag = false;
      if (y >= gTop && y < gBottom) {
        const ty = (y - gTop) / (gBottom - gTop);
        const cxDiag = leftX + barW / 2 + ty * (rightX + barW / 2 - (leftX + barW / 2));
        inDiag = Math.abs(x - cxDiag) <= diagHalf;
      }
      if (inLeft || inRight || inDiag) {
        r = 255;
        g = 255;
        b = 255;
      }
      const i = (y * big + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = alpha;
    }
  }
  // box-downsample S×S → final RGBA
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const i = ((y * S + dy) * big + (x * S + dx)) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

/* ---------------- ICO (PNG-compressed entries) ---------------- */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(dir);
    blobs.push(png);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

/* ---------------- Emit ---------------- */
mkdirSync(OUT, { recursive: true });
const files = {
  "icon-192.png": drawIcon(192),
  "icon-512.png": drawIcon(512),
  "icon-maskable.png": drawIcon(512, { fullBleed: true }),
  "apple-touch-icon.png": drawIcon(180, { fullBleed: true }),
  "favicon-32.png": drawIcon(32),
  "favicon-16.png": drawIcon(16),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(OUT, name), buf);
writeFileSync(
  join(OUT, "favicon.ico"),
  encodeIco([
    { size: 16, png: files["favicon-16.png"] },
    { size: 32, png: files["favicon-32.png"] },
  ]),
);
console.log(`wrote ${Object.keys(files).length + 1} icons to ${OUT}`);
