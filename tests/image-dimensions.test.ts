import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { imageDimensionFields, imageDimensions, jpegExifOrientation } from "../src/server/imageDimensions.js";

// Coverage target: src/server/imageDimensions.ts — the header-only size reader
// behind image attachments' width/height (the chat's <img> holds its box before
// the bytes load). Every fixture is a HEADER only: the reader must never need
// pixel data, and anything broken must be "unknown" (null), never a throw.

const u16le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u16be = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function png(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13),
    Buffer.from("IHDR", "latin1"),
    u32be(width),
    u32be(height),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4), // CRC (not checked: a size is a layout hint)
  ]);
}

/** A JPEG segment: FF <marker> <length incl. itself> <payload>. */
const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
const sof = (marker: number, width: number, height: number) =>
  segment(marker, Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]));
const jfif = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));

/** An Exif APP1 whose IFD0 holds one Orientation (0x0112) entry, in either byte order. */
function exif(orientation: number, order: "II" | "MM" = "II", ifdOffset = 8): Buffer {
  const le = order === "II";
  const w16 = le ? u16le : u16be;
  const w32 = le ? u32le : u32be;
  const tiff = Buffer.concat([
    Buffer.from(order, "latin1"),
    w16(42),
    w32(ifdOffset),
    w16(1), // one entry
    w16(0x0112),
    w16(3), // SHORT
    w32(1),
    w16(orientation),
    Buffer.alloc(2),
    w32(0), // next IFD
  ]);
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
}

const jpeg = (...segments: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0, 2])]);

const gif = (width: number, height: number) => Buffer.concat([Buffer.from("GIF89a", "latin1"), u16le(width), u16le(height), Buffer.from([0xf7, 0, 0])]);

function riff(chunk: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), Buffer.from(chunk, "latin1"), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body]);
}

describe("imageDimensions", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageDimensions(png(1234, 567))).toEqual({ width: 1234, height: 567 });
  });

  it("reads a JPEG's frame header (baseline, progressive, behind APP0 and fill bytes)", () => {
    expect(imageDimensions(jpeg(jfif, sof(0xc0, 800, 600)))).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(jpeg(jfif, Buffer.from([0xff]), sof(0xc2, 1920, 1080)))).toEqual({ width: 1920, height: 1080 });
  });

  it("swaps a JPEG's edges when Exif turns it a quarter, as the browser draws it", () => {
    for (const order of ["II", "MM"] as const) {
      expect(imageDimensions(jpeg(exif(6, order), sof(0xc0, 4032, 3024))), `${order} 6`).toEqual({ width: 3024, height: 4032 });
      expect(imageDimensions(jpeg(exif(8, order), sof(0xc0, 4032, 3024))), `${order} 8`).toEqual({ width: 3024, height: 4032 });
      expect(imageDimensions(jpeg(exif(3, order), sof(0xc0, 4032, 3024))), `${order} 3`).toEqual({ width: 4032, height: 3024 });
    }
    expect(jpegExifOrientation(jpeg(exif(5, "MM"), sof(0xc0, 10, 20)))).toBe(5);
    // A broken Exif block is "no orientation", never a guess.
    expect(jpegExifOrientation(jpeg(exif(6, "II", 4000), sof(0xc0, 10, 20)))).toBe(0);
    expect(jpegExifOrientation(jpeg(exif(42), sof(0xc0, 10, 20)))).toBe(0);
    expect(imageDimensions(jpeg(exif(6, "II", 4000), sof(0xc0, 40, 30)))).toEqual({ width: 40, height: 30 });
    expect(jpegExifOrientation(png(1, 1))).toBe(0);
  });

  it("reads a GIF's logical screen", () => {
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(Buffer.concat([Buffer.from("GIF87a", "latin1"), u16le(5), u16le(7)]))).toEqual({ width: 5, height: 7 });
  });

  it("reads all three WebP flavours", () => {
    expect(imageDimensions(riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(7999), u24le(5999)])))).toEqual({ width: 8000, height: 6000 });
    expect(imageDimensions(riff("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(2999 | (1999 << 14)), Buffer.alloc(5)])))).toEqual({
      width: 3000,
      height: 2000,
    });
    expect(
      imageDimensions(riff("VP8 ", Buffer.concat([Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), u16le(4000), u16le(3000), Buffer.alloc(2)]))),
    ).toEqual({ width: 4000, height: 3000 });
  });

  it("answers null for truncated, implausible or foreign bytes", () => {
    const cases: [string, Buffer][] = [
      ["empty", Buffer.alloc(0)],
      ["truncated png", png(10, 10).subarray(0, 20)],
      ["png with a zero edge", png(0, 10)],
      ["png past any plausible edge", png(1_000_000, 10)],
      ["png whose first chunk is not IHDR", Buffer.concat([png(4, 4).subarray(0, 12), Buffer.from("IDAT", "latin1"), png(4, 4).subarray(16)])],
      ["jpeg without a frame header", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0])],
      ["jpeg cut inside its frame header", jpeg(jfif, sof(0xc0, 800, 600)).subarray(0, 26)],
      ["jpeg with a zero edge", jpeg(sof(0xc0, 0, 600))],
      ["truncated gif", gif(320, 200).subarray(0, 8)],
      ["webp VP8 without its start code", riff("VP8 ", Buffer.concat([Buffer.alloc(3), Buffer.from([0, 0, 0]), u16le(4), u16le(3), Buffer.alloc(2)]))],
      ["webp VP8L without its signature", riff("VP8L", Buffer.concat([Buffer.from([0x00]), u32le(10 | (10 << 14)), Buffer.alloc(5)]))],
      ["truncated webp", riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(10), u24le(10)])).subarray(0, 26)],
      ["webp of an unknown chunk", riff("ALPH", Buffer.alloc(16))],
      ["text", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>")],
      ["bmp", Buffer.concat([Buffer.from("BM", "latin1"), Buffer.alloc(40)])],
    ];
    for (const [label, bytes] of cases) expect(imageDimensions(bytes), label).toBeNull();
  });

  it("never throws on garbage behind a real signature", () => {
    const signatures = [png(1, 1).subarray(0, 8), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("GIF89a", "latin1"), Buffer.from("RIFF\0\0\0\0WEBPVP8X", "latin1")];
    for (let round = 0; round < 400; round += 1) {
      const head = signatures[round % signatures.length];
      const bytes = Buffer.concat([head, crypto.randomBytes(round % 64)]);
      const size = imageDimensions(bytes);
      if (size) {
        expect(Number.isInteger(size.width) && size.width > 0).toBe(true);
        expect(Number.isInteger(size.height) && size.height > 0).toBe(true);
      }
    }
  });

  it("gives an attachment the fields to spread, or none", () => {
    expect(imageDimensionFields(png(16, 9))).toEqual({ width: 16, height: 9 });
    expect(imageDimensionFields(Buffer.from("nope"))).toEqual({});
  });
});
