import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap (not replace) the async image reader so a test can prove which renders
// were — or were NOT — read. The real implementation still runs.
vi.mock("../src/server/chatImages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/chatImages.js")>();
  return { ...actual, readWorkspaceImageAsync: vi.fn(actual.readWorkspaceImageAsync) };
});

import { MAX_CHAT_IMAGE_BYTES, readWorkspaceImageAsync } from "../src/server/chatImages.js";
import {
  DECK_PREVIEW_FORMAT,
  DECK_PREVIEW_VERSION,
  MAX_DECK_PREVIEW_ENTRIES,
  MAX_DECK_PREVIEW_MANIFEST_BYTES,
  MAX_DECK_PREVIEW_TOTAL_BYTES,
  deckPreviewDirFor,
  loadConverterPreviews,
  type ConverterPreviewLoad,
} from "../src/server/deckPreview.js";
import { MAX_PREVIEW_PAGES } from "../src/server/deckRender.js";
import { buildFileOutputTools } from "../src/server/agent/fileOutputTools.js";
import type { FileOutputResult } from "../src/server/agent/events.js";
import { callTool, withTempDir } from "./helpers.js";

// Real 16×9 single-colour images, made with Pillow:
// Image.new("RGB", (16, 9), color).save(buf, "PNG", optimize=True) / .save(buf, "JPEG", quality=50).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAF0lEQVR42mNUTX7NQApgYiARjGqgiQYAjMcBhYrZEk0AAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAJABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBlFFFeCfSn/9k=",
  "base64",
);
/** Zip local-file-header magic + padding: what publishWorkspaceFile accepts as .pptx. */
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(96, 7)]);

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

interface SlideSpec {
  file: string;
  bytes?: Buffer;
  mediaType?: string;
  title?: string;
}
type Manifest = Record<string, unknown> & { slides: Record<string, unknown>[] };

const DEFAULT_SLIDES: SlideSpec[] = [
  { file: "slide-01.png", bytes: PNG, title: "2026년 3분기 사업 실적 보고" },
  { file: "slide-02.jpg", bytes: JPEG },
  { file: "slide-03.png", bytes: PNG, title: "사업부별 매출" },
];

interface Deck {
  root: string;
  pptx: string;
  sha256: string;
  previewDir: string;
}

/**
 * Write `<root>/<name>/<name>.pptx` plus its sidecar the way the converter
 * does (docs/architecture/pptx-converter.md): renders first, `manifest.json`
 * last. `edit` rewrites the manifest before it is written; `manifest: false`
 * leaves it out entirely.
 */
function writeDeck(
  root: string,
  opts: {
    name?: string;
    slides?: SlideSpec[];
    edit?: (manifest: Manifest) => unknown;
    manifest?: boolean;
  } = {},
): Deck {
  const name = opts.name ?? "q3-review";
  const deckDir = path.join(root, name);
  const previewDir = path.join(deckDir, `${name}.preview`);
  fs.mkdirSync(previewDir, { recursive: true });
  const pptx = path.join(deckDir, `${name}.pptx`);
  fs.writeFileSync(pptx, PPTX);
  fs.writeFileSync(path.join(previewDir, ".gitignore"), "*\n");
  const slides = opts.slides ?? DEFAULT_SLIDES;
  for (const slide of slides) {
    if (slide.bytes) fs.writeFileSync(path.join(previewDir, slide.file), slide.bytes);
  }
  const manifest: Manifest = {
    format: DECK_PREVIEW_FORMAT,
    version: DECK_PREVIEW_VERSION,
    generator: "noah-pptx-converter/1.0.0",
    pptx: `${name}.pptx`,
    pptxSha256: sha256(PPTX),
    profile: "embedded",
    createdAt: "2026-09-26T03:00:00Z",
    slideCount: slides.length,
    slides: slides.map((slide, offset) => ({
      index: offset + 1,
      file: slide.file,
      mediaType: slide.mediaType ?? (slide.file.endsWith(".jpg") ? "image/jpeg" : "image/png"),
      sha256: sha256(slide.bytes ?? Buffer.alloc(0)),
      width: 1920,
      height: 1080,
      ...(slide.title !== undefined ? { title: slide.title } : {}),
    })),
  };
  if (opts.manifest !== false) {
    const body = opts.edit ? opts.edit(manifest) : manifest;
    fs.writeFileSync(path.join(previewDir, "manifest.json"), typeof body === "string" ? body : JSON.stringify(body));
  }
  return { root, pptx, sha256: sha256(PPTX), previewDir };
}

function load(deck: Deck, extra: Partial<Parameters<typeof loadConverterPreviews>[0]> = {}) {
  return loadConverterPreviews({
    sourcePath: deck.pptx,
    sha256: deck.sha256,
    allowedRoots: [deck.root],
    ...extra,
  });
}

function expectInvalid(result: ConverterPreviewLoad, detail: string | RegExp) {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBe("invalid");
  if (typeof detail === "string") expect(result.detail).toBe(detail);
  else expect(result.detail).toMatch(detail);
}

const readImage = vi.mocked(readWorkspaceImageAsync);

describe("loadConverterPreviews", () => {
  let root: string;
  const getTempDir = withTempDir("deck-preview", () => {
    // The loader compares realpaths; pin the fixture root to one as well.
    root = fs.realpathSync(getTempDir());
    readImage.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the sidecar next to the deck: <dir>/<stem>.preview", () => {
    expect(deckPreviewDirFor("/w/q3-review/q3-review.pptx")).toBe("/w/q3-review/q3-review.preview");
    expect(deckPreviewDirFor("/w/q3/deck.v2.pptx")).toBe("/w/q3/deck.v2.preview");
    expect(MAX_DECK_PREVIEW_MANIFEST_BYTES).toBe(128 * 1024);
    expect(MAX_DECK_PREVIEW_ENTRIES).toBe(200);
    expect(MAX_DECK_PREVIEW_TOTAL_BYTES).toBe(32 * 1024 * 1024);
  });

  describe("loaded", () => {
    it("loads every render in deck order with Korean alt text, media types and the profile", async () => {
      const deck = writeDeck(root);
      const result = await load(deck);
      expect(result.status).toBe("loaded");
      if (result.status !== "loaded") return;
      expect(result.total).toBe(3);
      expect(result.profile).toBe("embedded");
      expect(result.slides.map(({ index, mediaType, name }) => ({ index, mediaType, name }))).toEqual([
        { index: 1, mediaType: "image/png", name: "슬라이드 1 – 2026년 3분기 사업 실적 보고" },
        { index: 2, mediaType: "image/jpeg", name: "슬라이드 2" },
        { index: 3, mediaType: "image/png", name: "슬라이드 3 – 사업부별 매출" },
      ]);
      expect(result.slides[0].buffer.equals(PNG)).toBe(true);
      expect(result.slides[1].buffer.equals(JPEG)).toBe(true);
      expect(readImage).toHaveBeenCalledTimes(3);
    });

    it("reports the malgun profile", async () => {
      const deck = writeDeck(root, { edit: (m) => ({ ...m, profile: "malgun" }) });
      const result = await load(deck);
      expect(result).toMatchObject({ status: "loaded", profile: "malgun", total: 3 });
    });

    it("tolerates unknown manifest keys, extra files and a manifest without slideCount", async () => {
      const deck = writeDeck(root, {
        edit: (m) => {
          const { slideCount: _unused, ...rest } = m;
          return { ...rest, futureField: { nested: true }, slides: m.slides.map((s) => ({ ...s, extra: 1 })) };
        },
      });
      fs.writeFileSync(path.join(deck.previewDir, "notes.txt"), "not a render");
      const result = await load(deck);
      expect(result).toMatchObject({ status: "loaded", total: 3 });
    });

    it("drops roots that do not resolve and accepts the upper-case digest of the same bytes", async () => {
      const deck = writeDeck(root);
      const result = await loadConverterPreviews({
        sourcePath: deck.pptx,
        sha256: deck.sha256.toUpperCase(),
        allowedRoots: [path.join(root, "gone"), root],
      });
      expect(result.status).toBe("loaded");
    });

    it("sanitizes agent-written titles into one bounded line of alt text", async () => {
      const astral = "가".repeat(190) + "😀".repeat(5);
      const deck = writeDeck(root, {
        slides: [
          { file: "slide-01.png", bytes: PNG, title: "  1분기\n실적\t\u0007요약 \u202e역순\u202c\u2066끝\u2069  " },
          { file: "slide-02.png", bytes: PNG, title: " \n\t " },
          { file: "slide-03.png", bytes: PNG, title: "나".repeat(300) },
          { file: "slide-04.png", bytes: PNG, title: astral },
        ],
      });
      const result = await load(deck);
      expect(result.status).toBe("loaded");
      if (result.status !== "loaded") return;
      const [cleaned, blank, long, emoji] = result.slides.map((s) => s.name);
      expect(cleaned).toBe("슬라이드 1 – 1분기 실적 요약 역순끝");
      expect(blank).toBe("슬라이드 2");
      expect(Array.from(long)).toHaveLength(200);
      expect(long.startsWith("슬라이드 3 – 나나")).toBe(true);
      // Capped by code point: the cut never splits a surrogate pair.
      expect(Array.from(emoji)).toHaveLength(200);
      expect(emoji.endsWith("😀")).toBe(true);
      expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    });

    it("attaches the first MAX_PREVIEW_PAGES renders and counts the rest in total", async () => {
      const slides: SlideSpec[] = Array.from({ length: 40 }, (_, i) => ({
        file: `slide-${String(i + 1).padStart(2, "0")}.png`,
        // Past the attach cap the files need not even exist: they are never read.
        bytes: i < MAX_PREVIEW_PAGES ? PNG : undefined,
      }));
      const deck = writeDeck(root, {
        slides,
        edit: (m) => ({
          ...m,
          slides: m.slides.map((s, i) => (i < MAX_PREVIEW_PAGES ? s : { ...s, sha256: sha256(PNG) })),
        }),
      });
      const result = await load(deck);
      expect(result.status).toBe("loaded");
      if (result.status !== "loaded") return;
      expect(MAX_PREVIEW_PAGES).toBe(30);
      expect(result.slides).toHaveLength(30);
      expect(result.total).toBe(40);
      expect(result.slides.map((s) => s.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(readImage).toHaveBeenCalledTimes(30);
    });

    it("honors a smaller maxPages", async () => {
      const deck = writeDeck(root);
      const result = await load(deck, { maxPages: 2 });
      expect(result).toMatchObject({ status: "loaded", total: 3 });
      if (result.status === "loaded") expect(result.slides).toHaveLength(2);
    });

    it("follows a manifest symlink that stays inside the preview dir", async () => {
      const deck = writeDeck(root);
      fs.renameSync(path.join(deck.previewDir, "manifest.json"), path.join(deck.previewDir, "real.json"));
      fs.symlinkSync("real.json", path.join(deck.previewDir, "manifest.json"));
      expect((await load(deck)).status).toBe("loaded");
    });
  });

  describe("none", () => {
    it("is none without a preview dir, without a manifest, or behind a dangling link", async () => {
      const bare = path.join(root, "bare");
      fs.mkdirSync(bare);
      fs.writeFileSync(path.join(bare, "bare.pptx"), PPTX);
      expect(
        await loadConverterPreviews({ sourcePath: path.join(bare, "bare.pptx"), sha256: sha256(PPTX), allowedRoots: [root] }),
      ).toEqual({ status: "none" });

      // A build still in flight: renders written, manifest (written LAST) not yet.
      const inFlight = writeDeck(root, { name: "inflight", manifest: false });
      expect(await load(inFlight)).toEqual({ status: "none" });

      const dangling = path.join(root, "dangling");
      fs.mkdirSync(dangling);
      fs.writeFileSync(path.join(dangling, "dangling.pptx"), PPTX);
      fs.symlinkSync(path.join(root, "nowhere"), path.join(dangling, "dangling.preview"));
      expect(
        await loadConverterPreviews({
          sourcePath: path.join(dangling, "dangling.pptx"),
          sha256: sha256(PPTX),
          allowedRoots: [root],
        }),
      ).toEqual({ status: "none" });
      expect(readImage).not.toHaveBeenCalled();
    });
  });

  describe("stale", () => {
    /** Every path the fs layer was asked to open or read that names a render. */
    function spyImageReads(): () => string[] {
      const open = vi.spyOn(fs.promises, "open");
      const readFile = vi.spyOn(fs.promises, "readFile");
      return () =>
        [...open.mock.calls, ...readFile.mock.calls]
          .map(([file]) => String(file))
          .filter((file) => /\.(png|jpg)$/.test(file));
    }

    it("rejects renders of an earlier build BEFORE reading any image", async () => {
      const imageReads = spyImageReads();
      // The slide list is garbage too: the hash binding is checked first.
      const deck = writeDeck(root, {
        edit: (m) => ({ ...m, pptxSha256: sha256(Buffer.from("an earlier build")), slides: "garbage" }),
      });
      const result = await load(deck);
      expect(result).toEqual({
        status: "rejected",
        reason: "stale",
        detail: "the .pptx changed after the converter built it",
      });
      expect(readImage).not.toHaveBeenCalled();
      expect(imageReads()).toEqual([]);
    });

    it("binds to the bytes that were shared, not to the file name", async () => {
      const imageReads = spyImageReads();
      const deck = writeDeck(root);
      const result = await load({ ...deck, sha256: sha256(Buffer.concat([PPTX, Buffer.from("edit")])) });
      expect(result).toMatchObject({ status: "rejected", reason: "stale" });
      expect(readImage).not.toHaveBeenCalled();
      expect(imageReads()).toEqual([]);
      // Control: the same spies DO see the renders being read on a load.
      expect((await load(deck)).status).toBe("loaded");
      expect(imageReads()).toHaveLength(3);
    });
  });

  describe("invalid", () => {
    const schemaCases: [string, (m: Manifest) => unknown, string | RegExp][] = [
      ["wrong format", (m) => ({ ...m, format: "noah-deck-run" }), "manifest.json has an unsupported format or version"],
      ["wrong version", (m) => ({ ...m, version: 2 }), "manifest.json has an unsupported format or version"],
      ["string version", (m) => ({ ...m, version: "1" }), "manifest.json has an unsupported format or version"],
      ["missing pptxSha256", (m) => ({ ...m, pptxSha256: undefined }), "manifest.json has an invalid pptxSha256"],
      ["upper-case pptxSha256", (m) => ({ ...m, pptxSha256: sha256(PPTX).toUpperCase() }), "manifest.json has an invalid pptxSha256"],
      ["short pptxSha256", (m) => ({ ...m, pptxSha256: sha256(PPTX).slice(1) }), "manifest.json has an invalid pptxSha256"],
      ["unknown profile", (m) => ({ ...m, profile: "fancy" }), "manifest.json has an unknown font profile"],
      ["no slide list", (m) => ({ ...m, slides: undefined }), "manifest.json must list 1 to 200 slides"],
      ["slides not an array", (m) => ({ ...m, slides: { 0: m.slides[0] } }), "manifest.json must list 1 to 200 slides"],
      ["0 entries", (m) => ({ ...m, slides: [], slideCount: 0 }), "manifest.json must list 1 to 200 slides"],
      [
        "201 entries",
        (m) => ({ ...m, slides: Array.from({ length: 201 }, (_, i) => ({ ...m.slides[0], index: i + 1 })) }),
        "manifest.json must list 1 to 200 slides",
      ],
      ["slideCount mismatch", (m) => ({ ...m, slideCount: 4 }), "manifest.json slideCount does not match its slide list"],
      ["null entry", (m) => ({ ...m, slides: [null, ...m.slides.slice(1)] }), "slide entry 1 is not an object"],
      ["array entry", (m) => ({ ...m, slides: [m.slides[0], [], m.slides[2]] }), "slide entry 2 is not an object"],
      [
        "non-consecutive index",
        (m) => ({ ...m, slides: [m.slides[0], { ...m.slides[1], index: 3 }, { ...m.slides[2], index: 2 }] }),
        "slide indexes do not run 1..N in deck order",
      ],
      ["index from 0", (m) => ({ ...m, slides: m.slides.map((s, i) => ({ ...s, index: i })) }), "slide indexes do not run 1..N in deck order"],
      [
        "duplicate file",
        (m) => ({ ...m, slides: [m.slides[0], m.slides[1], { ...m.slides[0], index: 3 }] }),
        "slide entry 3 repeats a file name",
      ],
      [
        "unsupported media type",
        (m) => ({ ...m, slides: [{ ...m.slides[0], mediaType: "image/webp" }, ...m.slides.slice(1)] }),
        "slide entry 1 has an unsupported media type",
      ],
      [
        "extension/mediaType mismatch",
        (m) => ({ ...m, slides: [{ ...m.slides[0], mediaType: "image/jpeg" }, ...m.slides.slice(1)] }),
        "slide entry 1 has a media type that does not match its file extension",
      ],
      [
        "jpg declared png",
        (m) => ({ ...m, slides: [m.slides[0], { ...m.slides[1], mediaType: "image/png" }, m.slides[2]] }),
        "slide entry 2 has a media type that does not match its file extension",
      ],
      [
        "bad entry sha256",
        (m) => ({ ...m, slides: [m.slides[0], { ...m.slides[1], sha256: "abc" }, m.slides[2]] }),
        "slide entry 2 has an invalid sha256",
      ],
      [
        "upper-case entry sha256",
        (m) => ({ ...m, slides: [{ ...m.slides[0], sha256: String(m.slides[0].sha256).toUpperCase() }, ...m.slides.slice(1)] }),
        "slide entry 1 has an invalid sha256",
      ],
      ["zero width", (m) => ({ ...m, slides: [{ ...m.slides[0], width: 0 }, ...m.slides.slice(1)] }), "slide entry 1 has invalid dimensions"],
      ["huge height", (m) => ({ ...m, slides: [{ ...m.slides[0], height: 8193 }, ...m.slides.slice(1)] }), "slide entry 1 has invalid dimensions"],
      ["fractional width", (m) => ({ ...m, slides: [{ ...m.slides[0], width: 1919.5 }, ...m.slides.slice(1)] }), "slide entry 1 has invalid dimensions"],
      ["string width", (m) => ({ ...m, slides: [{ ...m.slides[0], width: "1920" }, ...m.slides.slice(1)] }), "slide entry 1 has invalid dimensions"],
      [
        "missing height",
        (m) => ({ ...m, slides: [{ ...m.slides[0], height: undefined }, ...m.slides.slice(1)] }),
        "slide entry 1 has invalid dimensions",
      ],
      ["numeric title", (m) => ({ ...m, slides: [{ ...m.slides[0], title: 42 }, ...m.slides.slice(1)] }), "slide entry 1 has an invalid title"],
      ["null title", (m) => ({ ...m, slides: [{ ...m.slides[0], title: null }, ...m.slides.slice(1)] }), "slide entry 1 has an invalid title"],
      [
        "301-char title",
        (m) => ({ ...m, slides: [{ ...m.slides[0], title: "가".repeat(301) }, ...m.slides.slice(1)] }),
        "slide entry 1 has an invalid title",
      ],
      ["array manifest", (m) => [m], "manifest.json is not a JSON object"],
      ["null manifest", () => null, "manifest.json is not a JSON object"],
      ["string manifest", () => JSON.stringify("noah-deck-preview"), "manifest.json is not a JSON object"],
      ["bad JSON", () => "{ not json", "manifest.json is not valid JSON"],
    ];

    it.each(schemaCases)("rejects a manifest with %s", async (_label, edit, detail) => {
      const deck = writeDeck(root, { edit });
      expectInvalid(await load(deck), detail);
      // Schema failures are decided before any render is read.
      expect(readImage).not.toHaveBeenCalled();
    });

    it.each([
      ["slide-1.png"],
      ["slide-0001.png"],
      ["Slide-01.png"],
      ["slide-01.PNG"],
      ["slide-01.gif"],
      ["slide-01.jpeg"],
      ["../slide-01.png"],
      ["sub/slide-01.png"],
      ["slide-01.png "],
      ["/etc/slide-01.png"],
    ])("rejects the illegal file name %j", async (file) => {
      const deck = writeDeck(root, {
        edit: (m) => ({ ...m, slides: [{ ...m.slides[0], file }, ...m.slides.slice(1)] }),
      });
      expectInvalid(await load(deck), "slide entry 1 has an invalid file name");
      expect(readImage).not.toHaveBeenCalled();
    });

    it("rejects a manifest over 128 KiB", async () => {
      const deck = writeDeck(root, {
        edit: (m) => ({ ...m, padding: "x".repeat(MAX_DECK_PREVIEW_MANIFEST_BYTES) }),
      });
      expectInvalid(await load(deck), "manifest.json is larger than 128 KiB");
    });

    it("rejects an empty manifest, a manifest directory and a preview path that is a file", async () => {
      const empty = writeDeck(root, { name: "empty", edit: () => "" });
      expectInvalid(await load(empty), "manifest.json is empty");

      const dir = writeDeck(root, { name: "dir", manifest: false });
      fs.mkdirSync(path.join(dir.previewDir, "manifest.json"));
      expectInvalid(await load(dir), "manifest.json is not a regular file");

      const file = path.join(root, "flat");
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, "flat.pptx"), PPTX);
      fs.writeFileSync(path.join(file, "flat.preview"), "not a directory");
      expectInvalid(
        await loadConverterPreviews({ sourcePath: path.join(file, "flat.pptx"), sha256: sha256(PPTX), allowedRoots: [root] }),
        "the preview path is not a directory",
      );
    });

    it.runIf(process.platform === "linux")("refuses a FIFO manifest without blocking on it", async () => {
      const deck = writeDeck(root, { manifest: false });
      execFileSync("mkfifo", [path.join(deck.previewDir, "manifest.json")]);
      expectInvalid(await load(deck), "manifest.json is not a regular file");
    });

    it("rejects a preview dir symlinked outside the roots", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "noah-deck-preview-outside-")));
      try {
        const real = writeDeck(outside, { name: "q3-review" });
        const deckDir = path.join(root, "q3-review");
        fs.mkdirSync(deckDir);
        fs.writeFileSync(path.join(deckDir, "q3-review.pptx"), PPTX);
        fs.symlinkSync(real.previewDir, path.join(deckDir, "q3-review.preview"));
        expectInvalid(
          await loadConverterPreviews({
            sourcePath: path.join(deckDir, "q3-review.pptx"),
            sha256: sha256(PPTX),
            allowedRoots: [root],
          }),
          "the preview directory is outside the working roots",
        );
        expect(readImage).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("rejects everything when no allowed root resolves", async () => {
      const deck = writeDeck(root);
      expectInvalid(
        await load(deck, { allowedRoots: [path.join(root, "missing-root")] }),
        "the preview directory is outside the working roots",
      );
    });

    it("rejects a manifest that resolves outside the preview dir", async () => {
      const deck = writeDeck(root);
      const elsewhere = path.join(root, "elsewhere.json");
      fs.renameSync(path.join(deck.previewDir, "manifest.json"), elsewhere);
      fs.symlinkSync(elsewhere, path.join(deck.previewDir, "manifest.json"));
      expectInvalid(await load(deck), "manifest.json resolves outside the preview directory");
    });

    it("rejects a preview dir that cannot be resolved (symlink loop)", async () => {
      const deckDir = path.join(root, "loop");
      fs.mkdirSync(deckDir);
      fs.writeFileSync(path.join(deckDir, "loop.pptx"), PPTX);
      fs.symlinkSync(path.join(deckDir, "b"), path.join(deckDir, "loop.preview"));
      fs.symlinkSync(path.join(deckDir, "loop.preview"), path.join(deckDir, "b"));
      expectInvalid(
        await loadConverterPreviews({ sourcePath: path.join(deckDir, "loop.pptx"), sha256: sha256(PPTX), allowedRoots: [root] }),
        "the preview directory could not be resolved",
      );

      const manifestLoop = writeDeck(root, { name: "manifest-loop", manifest: false });
      fs.symlinkSync(path.join(manifestLoop.previewDir, "b.json"), path.join(manifestLoop.previewDir, "manifest.json"));
      fs.symlinkSync(path.join(manifestLoop.previewDir, "manifest.json"), path.join(manifestLoop.previewDir, "b.json"));
      expectInvalid(await load(manifestLoop), "manifest.json could not be resolved");
    });

    it("rejects a render symlinked outside the roots", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "noah-deck-preview-img-")));
      try {
        fs.writeFileSync(path.join(outside, "leak.png"), PNG);
        const deck = writeDeck(root, { slides: [{ file: "slide-01.png", bytes: PNG }] });
        fs.rmSync(path.join(deck.previewDir, "slide-01.png"));
        fs.symlinkSync(path.join(outside, "leak.png"), path.join(deck.previewDir, "slide-01.png"));
        expectInvalid(await load(deck), "slide 1's render is outside the working roots");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("rejects a render that resolves elsewhere inside the roots", async () => {
      const deck = writeDeck(root, { slides: [{ file: "slide-01.png", bytes: PNG }] });
      fs.writeFileSync(path.join(root, "other.png"), PNG);
      fs.rmSync(path.join(deck.previewDir, "slide-01.png"));
      fs.symlinkSync(path.join(root, "other.png"), path.join(deck.previewDir, "slide-01.png"));
      expectInvalid(await load(deck), "slide 1's render resolves outside the preview directory");
    });

    it("rejects missing, empty, non-file and non-image renders", async () => {
      const missing = writeDeck(root, { name: "missing", slides: [{ file: "slide-01.png", bytes: PNG }, { file: "slide-02.png" }] });
      expectInvalid(await load(missing), "slide 2's render is missing");

      const empty = writeDeck(root, { name: "empty", slides: [{ file: "slide-01.png", bytes: Buffer.alloc(0) }] });
      expectInvalid(await load(empty), "slide 1's render is empty");

      const dir = writeDeck(root, { name: "dir", slides: [{ file: "slide-01.png" }] });
      fs.mkdirSync(path.join(dir.previewDir, "slide-01.png"));
      expectInvalid(await load(dir), "slide 1's render is not a regular file");

      const text = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
      const notImage = writeDeck(root, { name: "text", slides: [{ file: "slide-01.png", bytes: text }] });
      expectInvalid(await load(notImage), "slide 1's render is not an image");
    });

    it("rejects a render whose bytes are not the declared type", async () => {
      // A JPEG saved under a .png name and declared image/png.
      const deck = writeDeck(root, { slides: [{ file: "slide-01.png", bytes: JPEG, mediaType: "image/png" }] });
      expectInvalid(await load(deck), "slide 1's render is not the declared image/png");
    });

    it("rejects a render whose bytes do not match its sha256 (all or nothing)", async () => {
      const deck = writeDeck(root);
      // Slide 3 was overwritten after the manifest was written; slides 1-2 are fine.
      const tampered = Buffer.from(PNG);
      tampered[tampered.length - 5] ^= 0xff;
      fs.writeFileSync(path.join(deck.previewDir, "slide-03.png"), tampered);
      expectInvalid(await load(deck), "slide 3's render does not match its sha256");
    });

    it("rejects a render over the 5 MB image cap", async () => {
      const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 1)]);
      const deck = writeDeck(root, { slides: [{ file: "slide-01.png", bytes: big }] });
      expectInvalid(await load(deck), "slide 1's render is larger than 5 MB");
    });

    it("rejects renders that exceed the total byte budget", async () => {
      const deck = writeDeck(root);
      expectInvalid(
        await load(deck, { maxTotalBytes: PNG.length + 10 }),
        "the renders exceed the preview size budget",
      );
      expect(readImage).toHaveBeenCalledTimes(2);
    });
  });
});

describe("share_file — converter-aware description and result notes", () => {
  const LEGACY_DESCRIPTION =
    "Hand a generated document to the user as a DOWNLOAD CARD in the chat. " +
    "Use this whenever you finish producing a file the user should keep — a PPTX deck, PDF, DOCX, XLSX, ZIP, CSV, Markdown/text file, or draw.io diagram (.drawio). " +
    "For PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders page previews into the card's side panel — do NOT render or publish slide images yourself for delivery. " +
    "A shared .drawio file renders as an INTERACTIVE diagram in that same panel (client-side) — never export a diagram to PNG just to deliver it. " +
    "Pass the local file path from your working directory; never paste a local path or file:// URL into Markdown, because the browser cannot reach your filesystem and there is NO Bash workaround for delivering files. " +
    "The file must be inside the run's working directory or scratch workspace, at most 30 MB, and its content must match its extension. A turn can share at most 3 files.";
  const CONVERTER_SENTENCE =
    "For a PPTX built by the `pptx` skill's converter, pass the built file IN PLACE (use `name` for the user-facing filename; never copy, rename or edit it after building) — the card's side panel then shows the converter's exact slide renders; for any other PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders approximate page previews. Either way, do NOT render or publish slide images yourself for delivery.";
  const LEGACY_SENTENCE =
    "For PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders page previews into the card's side panel — do NOT render or publish slide images yourself for delivery.";

  const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const unusedShow = async (): Promise<FileOutputResult> => ({ behavior: "error", message: "unused" });

  function descriptionOf(deckConverterInstalled?: boolean): string {
    const tools = buildFileOutputTools({ showFile: unusedShow, shareFile: unusedShow, deckConverterInstalled });
    return tools.find((t) => t.name === "share_file")!.description;
  }

  async function shareText(
    facts: Partial<Extract<FileOutputResult, { behavior: "shown" }>>,
    deckConverterInstalled?: boolean,
  ): Promise<string> {
    const shareFile = async (): Promise<FileOutputResult> => ({
      behavior: "shown",
      attachment: { id: "deck-1", kind: "file", mediaType: PPTX_TYPE, name: "3분기 보고.pptx", size: 999 },
      url: "/api/conversations/c1/files/deck-1",
      ...facts,
    });
    const result = await callTool(
      buildFileOutputTools({ showFile: unusedShow, shareFile, deckConverterInstalled }),
      "share_file",
      { path: "q3-review/q3-review.pptx", name: "3분기 보고.pptx" },
    );
    expect(result.isError).toBeFalsy();
    return result.content[0].text!;
  }

  const CARD = 'The file "3분기 보고.pptx" is now available to the user as a download card (attachment id: deck-1).';
  const TAIL = " Do not also paste its local path; briefly tell the user the file is ready to download.";
  const LO_NOTE = "4 page preview(s) were rendered automatically into the card's side panel — do not publish slide images yourself.";

  it("carries the converter sentence only when the converter is installed", () => {
    const converter = descriptionOf(true);
    expect(converter).toContain(CONVERTER_SENTENCE);
    expect(converter).not.toContain(LEGACY_SENTENCE);
    expect(converter).toContain("IN PLACE");
    // Everything around the PPTX sentence is unchanged.
    expect(converter).toBe(LEGACY_DESCRIPTION.replace(LEGACY_SENTENCE, CONVERTER_SENTENCE));
  });

  it("keeps today's description byte-for-byte without the converter", () => {
    expect(descriptionOf()).toBe(LEGACY_DESCRIPTION);
    expect(descriptionOf(false)).toBe(LEGACY_DESCRIPTION);
  });

  it("reports the converter's exact renders", async () => {
    const text = await shareText(
      { previews: 6, previewSource: "converter", previewTotal: 6, deckSidecar: { status: "loaded", profile: "embedded" } },
      true,
    );
    expect(text).toBe(
      `${CARD} 6 exact slide render(s) from the deck converter were attached to the card's side panel — do not publish slide images yourself.${TAIL}`,
    );
    // A host that leaves the total out is read as "all of them".
    expect(await shareText({ previews: 6, previewSource: "converter" }, true)).toBe(text);
  });

  it("says when the converter renders were capped", async () => {
    const text = await shareText(
      { previews: 30, previewSource: "converter", previewTotal: 40, deckSidecar: { status: "loaded", profile: "embedded" } },
      true,
    );
    expect(text).toContain(
      "30 exact slide render(s) from the deck converter were attached to the card's side panel (the first 30 of 40 slides) — do not publish slide images yourself.",
    );
  });

  it("adds the stand-in font note for a malgun deck", async () => {
    const text = await shareText(
      { previews: 3, previewSource: "converter", previewTotal: 3, deckSidecar: { status: "loaded", profile: "malgun" } },
      true,
    );
    expect(text).toContain(
      "— do not publish slide images yourself. These renders use a metric-matched stand-in for 맑은 고딕; PowerPoint on Windows shows the real font.",
    );
    expect(text).not.toContain("rendered automatically");
  });

  it("explains a stale sidecar next to the LibreOffice previews", async () => {
    const text = await shareText(
      { previews: 4, previewSource: "libreoffice", deckSidecar: { status: "stale", detail: "the .pptx changed after the converter built it" } },
      true,
    );
    expect(text).toBe(
      `${CARD} ${LO_NOTE} The deck converter's renders next to this file were NOT used: the .pptx changed after the converter built it, so the panel shows approximate LibreOffice previews instead. To change a converted deck, edit its slide HTML and rebuild with the pptx skill's converter; never patch the built .pptx.${TAIL}`,
    );
  });

  it("explains an invalid sidecar with its detail", async () => {
    const text = await shareText(
      { previews: 4, previewSource: "libreoffice", deckSidecar: { status: "invalid", detail: "slide 3's render does not match its sha256" } },
      true,
    );
    expect(text).toBe(
      `${CARD} ${LO_NOTE} The deck converter's renders next to this file were NOT used (slide 3's render does not match its sha256); the panel shows approximate LibreOffice previews instead. Rebuild with the pptx skill's converter and share the built .pptx in place.${TAIL}`,
    );
    // A host that omits the detail still gets a readable sentence.
    const bare = await shareText({ previews: 0, deckSidecar: { status: "invalid" } }, true);
    expect(bare).toContain("were NOT used (the preview sidecar was rejected). Rebuild");
  });

  it("drops the LibreOffice clause when no previews were attached", async () => {
    const stale = await shareText({ previews: 0, deckSidecar: { status: "stale" } }, true);
    expect(stale).toContain("NOT used: the .pptx changed after the converter built it. To change a converted deck");
    expect(stale).not.toContain("rendered automatically");
    expect(stale).not.toContain("LibreOffice");
    const invalid = await shareText({ previews: 0, deckSidecar: { status: "invalid", detail: "manifest.json is not valid JSON" } }, true);
    expect(invalid).toContain("NOT used (manifest.json is not valid JSON). Rebuild with");
    expect(invalid).not.toContain("LibreOffice");
  });

  it("points a copied or renamed deck back to the built file when the converter is installed", async () => {
    const withLo = await shareText({ previews: 4, previewSource: "libreoffice", deckSidecar: { status: "none" } }, true);
    expect(withLo).toBe(
      `${CARD} ${LO_NOTE} No converter renders were found next to this file; the panel shows approximate LibreOffice previews. If this deck was built by the pptx skill's converter, share the built <stem>.pptx in place (not a copy or a renamed file) — or rebuild it — to get the exact slide renders.${TAIL}`,
    );
    const withoutLo = await shareText({ previews: 0, deckSidecar: { status: "none" } }, true);
    expect(withoutLo).toContain(
      "No converter renders were found next to this file. If this deck was built by the pptx skill's converter",
    );
  });

  it("adds no sidecar note for a missing sidecar without the converter", async () => {
    expect(await shareText({ previews: 4, previewSource: "libreoffice", deckSidecar: { status: "none" } })).toBe(
      `${CARD} ${LO_NOTE}${TAIL}`,
    );
    expect(await shareText({ previews: 0, deckSidecar: { status: "none" } })).toBe(`${CARD}${TAIL}`);
  });

  it("keeps the older previews-only result wording (no previewSource)", async () => {
    const text = await shareText({ previews: 5 }, true);
    expect(text).toContain("5 page preview(s) were rendered automatically");
    expect(text).toContain("do not publish slide images yourself");
    expect(text).not.toContain("converter");
  });

  it("says nothing extra when a loaded sidecar fell back to LibreOffice pages", async () => {
    const text = await shareText(
      { previews: 4, previewSource: "libreoffice", deckSidecar: { status: "loaded", profile: "embedded" } },
      true,
    );
    expect(text).toBe(`${CARD} ${LO_NOTE}${TAIL}`);
  });

  it("leaves the draw.io and plain-file results unchanged", async () => {
    const drawio = async (): Promise<FileOutputResult> => ({
      behavior: "shown",
      attachment: { id: "d-1", kind: "file", mediaType: "application/vnd.jgraph.mxfile", name: "flow.drawio", size: 10 },
      url: "/api/conversations/c1/files/d-1",
      previews: 0,
    });
    const diagram = await callTool(
      buildFileOutputTools({ showFile: unusedShow, shareFile: drawio, deckConverterInstalled: true }),
      "share_file",
      { path: "flow.drawio" },
    );
    expect(diagram.content[0].text).toBe(
      'The file "flow.drawio" is now available to the user as a download card (attachment id: d-1). The card\'s side panel renders the diagram interactively — do not publish separate preview images.' +
        TAIL,
    );
    const plain = async (): Promise<FileOutputResult> => ({
      behavior: "shown",
      attachment: { id: "n-1", kind: "file", mediaType: "text/markdown", name: "notes.md", size: 10 },
      url: "/api/conversations/c1/files/n-1",
      previews: 0,
    });
    const notes = await callTool(
      buildFileOutputTools({ showFile: unusedShow, shareFile: plain, deckConverterInstalled: true }),
      "share_file",
      { path: "notes.md" },
    );
    expect(notes.content[0].text).toBe(
      'The file "notes.md" is now available to the user as a download card (attachment id: n-1).' + TAIL,
    );
  });
});
