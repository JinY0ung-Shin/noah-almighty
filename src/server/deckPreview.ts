import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isInside,
  MAX_CHAT_IMAGE_BYTES,
  readRegularFileAsync,
  readWorkspaceImageAsync,
  type ReadRegularFileResult,
  type ReadWorkspaceImageResult,
} from "./chatImages.js";
import { MAX_PREVIEW_PAGES } from "./deckRender.js";

/**
 * share_file's EXACT deck previews. The bundled `pptx` skill's converter writes
 * a sidecar next to every deck it builds — `<stem>.preview/` beside
 * `<stem>.pptx`: one render per slide (1920×1080, PNG or JPEG) plus
 * `manifest.json`, written LAST, that names each image with its SHA-256 and
 * binds the whole set to the .pptx bytes through `pptxSha256` (the sidecar
 * contract: docs/architecture/pptx-converter.md). When the agent shares that
 * .pptx, `onShareFile` (routes/chat.ts) asks this loader for the renders and
 * attaches them instead of LibreOffice's approximation.
 *
 * Everything here was written from the agent's shell, so it is validated like
 * any workspace read, and the result is ALL-OR-NOTHING: one violation rejects
 * every render (the caller falls back to LibreOffice).
 * - The hash binding is checked BEFORE any image is read, against the SHA-256
 *   of the SAME buffer `publishWorkspaceFile` stored — an edited .pptx never
 *   rides its old renders, and there is no re-read (no TOCTOU).
 * - Containment uses the SAME roots as `publishWorkspaceFile` (realpath on both
 *   sides); the manifest and every image must also resolve inside the preview
 *   dir itself.
 * - Manifest ≤ 128 KiB with a strict schema; images through
 *   `readWorkspaceImageAsync` (magic sniff = declared type, ≤ 5 MB each), at
 *   most `maxPages` attached, ≤ 32 MiB in total, per-file SHA-256.
 * - Rejection details are fixed English templates: nothing read from the
 *   sidecar is echoed back into the tool result.
 * A forged sidecar grants nothing `show_file` with `hidden:true` doesn't
 * already allow. Pure async fs: no shell-out, never a browser.
 */

export const DECK_PREVIEW_FORMAT = "noah-deck-preview";
export const DECK_PREVIEW_VERSION = 1;
export const MAX_DECK_PREVIEW_MANIFEST_BYTES = 128 * 1024;
export const MAX_DECK_PREVIEW_ENTRIES = 200;
export const MAX_DECK_PREVIEW_TOTAL_BYTES = 32 * 1024 * 1024;

const MANIFEST_FILE = "manifest.json";
const SLIDE_FILE = /^slide-\d{2,3}\.(png|jpg)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_DIMENSION = 8192;
const MAX_TITLE_CHARS = 300;
/** Cap on the Korean alt text (the attachment `name`), in code points. */
const MAX_NAME_CHARS = 200;
const EXTENSION_MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg" } as const;

type PreviewMediaType = (typeof EXTENSION_MEDIA_TYPES)[keyof typeof EXTENSION_MEDIA_TYPES];
type DeckFontProfile = "embedded" | "malgun";

/** `<dir>/<stem>.preview` for `<dir>/<stem>.<ext>` — where the converter puts a deck's sidecar. */
export function deckPreviewDirFor(sourcePath: string): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(path.dirname(sourcePath), `${stem}.preview`);
}

export interface ConverterPreviewSlide {
  index: number;
  buffer: Buffer;
  mediaType: PreviewMediaType;
  /** User-facing alt text (Korean): `슬라이드 N – <title>`. */
  name: string;
}

export type ConverterPreviewLoad =
  | { status: "loaded"; slides: ConverterPreviewSlide[]; total: number; profile: DeckFontProfile }
  | { status: "none" }
  | { status: "rejected"; reason: "stale" | "invalid"; detail: string };

interface ManifestSlide {
  index: number;
  file: string;
  mediaType: PreviewMediaType;
  sha256: string;
  title?: string;
}

const MANIFEST_READ_FAILURES: Record<Extract<ReadRegularFileResult, { error: string }>["error"], string> = {
  NOT_FILE: "manifest.json is not a regular file",
  EMPTY: "manifest.json is empty",
  TOO_LARGE: `manifest.json is larger than ${MAX_DECK_PREVIEW_MANIFEST_BYTES / 1024} KiB`,
  READ_FAILED: "manifest.json could not be read",
};

const IMAGE_READ_FAILURES: Record<Extract<ReadWorkspaceImageResult, { error: string }>["error"], string> = {
  OUTSIDE_WORKSPACE: "is outside the working roots",
  NOT_FOUND: "is missing",
  NOT_FILE: "is not a regular file",
  EMPTY: "is empty",
  TOO_LARGE: `is larger than ${Math.round(MAX_CHAT_IMAGE_BYTES / (1024 * 1024))} MB`,
  UNSUPPORTED: "is not an image",
  READ_FAILED: "could not be read",
};

function invalid(detail: string): ConverterPreviewLoad {
  return { status: "rejected", reason: "invalid", detail };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDimension(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
}

/** One `slides[]` entry at 1-based `position` → its validated shape, or a short English reason. */
function parseSlideEntry(entry: unknown, position: number): ManifestSlide | string {
  const where = `slide entry ${position}`;
  if (!isPlainObject(entry)) return `${where} is not an object`;
  if (entry.index !== position) return "slide indexes do not run 1..N in deck order";
  if (typeof entry.file !== "string" || !SLIDE_FILE.test(entry.file)) {
    return `${where} has an invalid file name`;
  }
  if (entry.mediaType !== "image/png" && entry.mediaType !== "image/jpeg") {
    return `${where} has an unsupported media type`;
  }
  const mediaType = EXTENSION_MEDIA_TYPES[entry.file.endsWith(".png") ? "png" : "jpg"];
  if (entry.mediaType !== mediaType) return `${where} has a media type that does not match its file extension`;
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    return `${where} has an invalid sha256`;
  }
  if (!isDimension(entry.width) || !isDimension(entry.height)) return `${where} has invalid dimensions`;
  if (entry.title !== undefined && (typeof entry.title !== "string" || entry.title.length > MAX_TITLE_CHARS)) {
    return `${where} has an invalid title`;
  }
  return { index: position, file: entry.file, mediaType, sha256: entry.sha256, title: entry.title };
}

// C0/C1 controls become spaces (then collapse with the rest of the
// whitespace); bidi embedding/override/isolate controls and LRM/RLM are
// dropped, so an agent-authored title cannot reorder or hide the label.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** User-facing alt text for one render: `슬라이드 N` + ` – <title>` when the slide has one. */
function slideAltText(index: number, title: string | undefined): string {
  const clean = (title ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  const label = clean ? `슬라이드 ${index} – ${clean}` : `슬라이드 ${index}`;
  return Array.from(label).slice(0, MAX_NAME_CHARS).join("").trimEnd();
}

async function realRoots(allowedRoots: string[]): Promise<string[]> {
  const resolved = await Promise.all(
    allowedRoots.map((root) =>
      fs.promises.realpath(root).then(
        (real) => [real],
        () => [],
      ),
    ),
  );
  return resolved.flat();
}

/**
 * Load the converter's renders for a just-published deck, or say why not.
 * `sourcePath` is the realpath `publishWorkspaceFile` read and `sha256` the hex
 * digest of the bytes it stored; `allowedRoots` are the SAME roots it used.
 * Never throws: every failure is a `none` / `rejected` result.
 */
export async function loadConverterPreviews(input: {
  sourcePath: string;
  sha256: string;
  allowedRoots: string[];
  /** Renders to read and attach (default {@link MAX_PREVIEW_PAGES}); the rest are counted in `total`. */
  maxPages?: number;
  /** Cumulative byte budget for the attached renders (default {@link MAX_DECK_PREVIEW_TOTAL_BYTES}). */
  maxTotalBytes?: number;
}): Promise<ConverterPreviewLoad> {
  const maxPages = input.maxPages ?? MAX_PREVIEW_PAGES;
  const maxTotalBytes = input.maxTotalBytes ?? MAX_DECK_PREVIEW_TOTAL_BYTES;

  // 1. The preview dir next to the REAL file (sourcePath is already a
  //    realpath, so sharing through a symlink lands here too).
  let previewDir: string;
  try {
    previewDir = await fs.promises.realpath(deckPreviewDirFor(input.sourcePath));
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "none" }
      : invalid("the preview directory could not be resolved");
  }
  // 2. Inside the SAME roots publishWorkspaceFile resolved against.
  const roots = await realRoots(input.allowedRoots);
  if (!roots.some((root) => isInside(root, previewDir))) {
    return invalid("the preview directory is outside the working roots");
  }

  // 3. The manifest. The converter writes it LAST, so a preview dir without
  //    one is a build still in flight (or no sidecar at all) — not an error.
  let manifestPath: string;
  try {
    manifestPath = await fs.promises.realpath(path.join(previewDir, MANIFEST_FILE));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "none" };
    return invalid(
      code === "ENOTDIR" ? "the preview path is not a directory" : "manifest.json could not be resolved",
    );
  }
  if (!isInside(previewDir, manifestPath)) {
    return invalid("manifest.json resolves outside the preview directory");
  }
  const read = await readRegularFileAsync(manifestPath, MAX_DECK_PREVIEW_MANIFEST_BYTES);
  if ("error" in read) return invalid(MANIFEST_READ_FAILURES[read.error]);
  let manifest: unknown;
  try {
    manifest = JSON.parse(read.buffer.toString("utf8"));
  } catch {
    return invalid("manifest.json is not valid JSON");
  }
  if (!isPlainObject(manifest)) return invalid("manifest.json is not a JSON object");

  // 4. The contract this server speaks.
  if (manifest.format !== DECK_PREVIEW_FORMAT || manifest.version !== DECK_PREVIEW_VERSION) {
    return invalid("manifest.json has an unsupported format or version");
  }

  // 5. The hash binding — BEFORE any image is read.
  if (typeof manifest.pptxSha256 !== "string" || !SHA256_HEX.test(manifest.pptxSha256)) {
    return invalid("manifest.json has an invalid pptxSha256");
  }
  if (manifest.pptxSha256 !== input.sha256.toLowerCase()) {
    return { status: "rejected", reason: "stale", detail: "the .pptx changed after the converter built it" };
  }

  // 6. The slide list: complete, in deck order, one strict entry per slide.
  const profile = manifest.profile;
  if (profile !== "embedded" && profile !== "malgun") {
    return invalid("manifest.json has an unknown font profile");
  }
  const entries = manifest.slides;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_DECK_PREVIEW_ENTRIES) {
    return invalid(`manifest.json must list 1 to ${MAX_DECK_PREVIEW_ENTRIES} slides`);
  }
  if (manifest.slideCount !== undefined && manifest.slideCount !== entries.length) {
    return invalid("manifest.json slideCount does not match its slide list");
  }
  const slides: ManifestSlide[] = [];
  const files = new Set<string>();
  for (const [offset, entry] of entries.entries()) {
    const parsed = parseSlideEntry(entry, offset + 1);
    if (typeof parsed === "string") return invalid(parsed);
    if (files.has(parsed.file)) return invalid(`slide entry ${parsed.index} repeats a file name`);
    files.add(parsed.file);
    slides.push(parsed);
  }

  // 7. The renders to attach: exact type, exact bytes, bounded in total.
  const loaded: ConverterPreviewSlide[] = [];
  let totalBytes = 0;
  for (const slide of slides.slice(0, Math.max(0, maxPages))) {
    const image = await readWorkspaceImageAsync(input.allowedRoots, path.join(previewDir, slide.file));
    const render = `slide ${slide.index}'s render`;
    if ("error" in image) return invalid(`${render} ${IMAGE_READ_FAILURES[image.error]}`);
    if (!isInside(previewDir, image.sourcePath)) {
      return invalid(`${render} resolves outside the preview directory`);
    }
    if (image.mediaType !== slide.mediaType) return invalid(`${render} is not the declared ${slide.mediaType}`);
    if (crypto.createHash("sha256").update(image.buffer).digest("hex") !== slide.sha256) {
      return invalid(`${render} does not match its sha256`);
    }
    totalBytes += image.buffer.length;
    if (totalBytes > maxTotalBytes) return invalid("the renders exceed the preview size budget");
    loaded.push({
      index: slide.index,
      buffer: image.buffer,
      mediaType: slide.mediaType,
      name: slideAltText(slide.index, slide.title),
    });
  }
  return { status: "loaded", slides: loaded, total: slides.length, profile };
}
