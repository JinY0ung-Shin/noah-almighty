import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig, MessageAttachment } from "./types.js";
import {
  MIME_EXT,
  SAFE_ID,
  detectImageMediaType,
  isInside,
  safeConversationDir,
  saveHiddenChatImage,
  keepIfContained,
  workspaceSubdirForWrite,
} from "./chatImages.js";

/**
 * Chat file attachments (agent-GENERATED documents handed to the user as
 * download cards — pptx decks, pdf exports, …). Mirrors the chat-image store
 * (`chatImages.ts`): bytes on disk under `dataDir/chat-files/<conversationId>/`,
 * only {@link MessageAttachment} metadata (kind:"file") on the message row,
 * swept with the conversation. There is deliberately NO upload path — files
 * only flow OUT of the agent workspace into this store (`publishWorkspaceFile`),
 * never in. The one write the other way is {@link saveBrowserCapture}: a
 * screenshot's bytes land in the workspace's `captures/` folder (not in this
 * store) so the avatar can place them into what it produces.
 * See `routes/chat.ts` for the share wiring + download endpoint.
 */

/** Per-file byte cap. Documents run bigger than chat images (decks with media). */
export const MAX_CHAT_FILE_BYTES = 30 * 1024 * 1024;
/**
 * Max download-card files the agent may share per assistant turn. Counts
 * `share_file` calls ONLY — the screenshot auto-share writes the same kind of
 * card but rides {@link MAX_SHARED_SCREENSHOTS_PER_MESSAGE} instead.
 */
export const MAX_CHAT_FILES_PER_MESSAGE = 3;
/**
 * Max browser screenshots auto-shared to the user per assistant turn. Its own
 * budget — a browsing loop must not exhaust the share_file cap, and vice
 * versa. Past the cap the model still receives the image; only the user-facing
 * card is skipped (the tool result says so).
 */
export const MAX_SHARED_SCREENSHOTS_PER_MESSAGE = 12;
/**
 * Max browser screenshots SAVED as files into the conversation scratch
 * workspace (`captures/`, {@link saveBrowserCapture}) per RUN: one chat run,
 * including its steer follow-up turns and background wake-ups, like the share
 * cap above. Its own budget, independent of that one. The workspace copy is
 * what lets the avatar place a capture into a deck or document, so it outlasts
 * the card budget, but a runaway capture loop still must not fill the disk.
 * Past it the model still receives the image; the tool result says no file was
 * saved.
 */
export const MAX_SAVED_CAPTURES_PER_TURN = 30;
/**
 * Max HIDDEN image publishes per turn (slide previews embedded in a canvas).
 * Separate from the visible-image cap: hidden files never crowd the bubble,
 * they only cost disk, so a whole deck fits in one turn.
 */
export const MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE = 30;

/**
 * Media type of shared .drawio attachments — the marker the client's
 * FileTab (and the share_file result note) key their diagram
 * rendering on. `src/client/src/lib/drawioViewer.ts` hand-mirrors the value.
 */
export const DRAWIO_MEDIA_TYPE = "application/vnd.jgraph.mxfile";

/**
 * Downloadable document types the agent may share. Extension is the lookup key
 * (from the SOURCE file's basename); `magic` is a byte-prefix check applied to
 * the actual content where the format has one (OOXML containers are zip, pdf is
 * `%PDF`) so a mislabeled file can't ride an innocuous extension.
 */
const FILE_TYPES: Record<string, { mediaType: string; magic?: Buffer[] }> = {
  pptx: {
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    magic: [Buffer.from("PK")],
  },
  docx: {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: [Buffer.from("PK")],
  },
  xlsx: {
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: [Buffer.from("PK")],
  },
  zip: { mediaType: "application/zip", magic: [Buffer.from("PK")] },
  pdf: { mediaType: "application/pdf", magic: [Buffer.from("%PDF")] },
  csv: { mediaType: "text/csv" },
  md: { mediaType: "text/markdown" },
  txt: { mediaType: "text/plain" },
  // draw.io diagram (mxfile XML, possibly with deflate-compressed <diagram>
  // payloads — still a text file, so no magic prefix like csv/md/txt). This
  // mediaType is what FileTab keys on to render the diagram client-side.
  drawio: { mediaType: DRAWIO_MEDIA_TYPE },
};

/**
 * Image extensions the DOWNLOAD route may serve, written ONLY by the
 * browser-screenshot auto-share (`publishBrowserScreenshot`). Deliberately NOT
 * in {@link FILE_TYPES}: share_file keeps routing images through show_file
 * (inline bubble), never a download card.
 */
const SERVED_IMAGE_TYPES: Record<string, { mediaType: string }> = {
  png: { mediaType: "image/png" },
  jpg: { mediaType: "image/jpeg" },
  webp: { mediaType: "image/webp" },
  gif: { mediaType: "image/gif" },
};

export function chatFilesDir(config: AppConfig, conversationId: string): string {
  return path.join(config.dataDir, "chat-files", safeConversationDir(conversationId));
}

/** Human list of shareable extensions, for agent-facing error text. */
export const SHAREABLE_EXTENSIONS = Object.keys(FILE_TYPES);

/**
 * The longest download name stored or served, in UTF-16 units — the same unit
 * and number as share_file's `name` schema cap.
 */
export const MAX_DOWNLOAD_NAME_LENGTH = 200;

/** A trailing extension worth keeping when a name is shortened: short, ASCII alphanumeric. */
const KEPT_EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/;

/**
 * `text` cut to at most `max` UTF-16 units, trailing whitespace dropped. Never
 * splits a surrogate pair: a lone surrogate makes `encodeURIComponent` — and so
 * the download's Content-Disposition — throw.
 */
function cutDownloadName(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * Strip anything filename-hostile from a user-facing download name: path
 * separators, control and Unicode format characters (a bidi override such as
 * U+202E makes "…raj.pptx" DISPLAY as if it ended in .pptx), line/paragraph
 * separators, lone surrogates, leading dots (hidden files). An overlong name is
 * shortened to {@link MAX_DOWNLOAD_NAME_LENGTH} while KEEPING its last
 * extension — cutting the tail would drop exactly the extension a caller forced
 * on ({@link withDownloadExtension}). Idempotent, so re-sanitizing a stored
 * name changes nothing. Falls back to `null` when nothing safe remains.
 */
export function sanitizeDownloadName(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]+/gu, "")
    // Format controls go (bidi overrides could disguise the extension), except the joiners Persian/Indic names
    // and emoji sequences need (ZWNJ, ZWJ) and the emoji tag characters.
    .replace(/(?![\u200c\u200d\u{e0020}-\u{e007f}])\p{Cf}/gu, "")
    .replace(/^[\s.]+/, "")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_DOWNLOAD_NAME_LENGTH) return cleaned;
  const ext = KEPT_EXTENSION_RE.exec(cleaned)?.[0] ?? "";
  const stem = cutDownloadName(cleaned.slice(0, cleaned.length - ext.length), MAX_DOWNLOAD_NAME_LENGTH - ext.length);
  return `${stem}${ext}`;
}

/**
 * A sanitized `name` that ends in `.<ext>` (any case) within
 * {@link MAX_DOWNLOAD_NAME_LENGTH}: kept as is when it already does, else the
 * stem is shortened as far as needed and `.<ext>` appended. Whatever a name
 * claims, the saved file carries the extension of the bytes actually served.
 */
export function withDownloadExtension(name: string, ext: string): string {
  const suffix = `.${ext}`;
  if (name.length <= MAX_DOWNLOAD_NAME_LENGTH && name.toLowerCase().endsWith(suffix.toLowerCase())) {
    return name;
  }
  return `${cutDownloadName(name, MAX_DOWNLOAD_NAME_LENGTH - suffix.length).trim() || "file"}${suffix}`;
}

export type PublishWorkspaceFileResult =
  | {
      attachment: MessageAttachment;
      /**
       * Realpath of the workspace file that was read (server-side only — the
       * browser never receives it). share_file looks for the deck converter's
       * preview sidecar next to THIS path, so sharing through a symlink still
       * finds the renders beside the real file.
       */
      sourcePath: string;
      /**
       * Lowercase hex SHA-256 of the SAME buffer written to the store — what a
       * deck preview sidecar's `pptxSha256` must equal (no re-read, no TOCTOU).
       */
      sha256: string;
    }
  | {
      error:
        | "OUTSIDE_WORKSPACE"
        | "NOT_FOUND"
        | "NOT_FILE"
        | "EMPTY"
        | "TOO_LARGE"
        | "UNSUPPORTED"
        | "READ_FAILED";
    };

/**
 * Copy a generated document from one of this run's explicit working roots into
 * the owner-scoped conversation file store, returning the download-card
 * attachment metadata plus the resolved source path and the stored bytes'
 * SHA-256 (the deck-preview sidecar binding, `deckPreview.ts`). Same
 * containment discipline as `publishWorkspaceImage`: realpath + root
 * membership, byte caps, and a content check where the format has magic bytes.
 * The browser never receives the source path.
 */
export function publishWorkspaceFile(
  config: AppConfig,
  conversationId: string,
  inputPath: string,
  allowedRoots: string[],
  requestedName?: string,
): PublishWorkspaceFileResult {
  const roots = allowedRoots.flatMap((root) => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
  if (!roots.length) return { error: "OUTSIDE_WORKSPACE" };

  const unresolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(roots[0], inputPath);
  let source: string;
  try {
    source = fs.realpathSync(unresolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" ? "NOT_FOUND" : "READ_FAILED" };
  }
  if (!roots.some((root) => isInside(root, source))) {
    return { error: "OUTSIDE_WORKSPACE" };
  }

  const ext = path.extname(source).slice(1).toLowerCase();
  const fileType = FILE_TYPES[ext];
  if (!fileType) return { error: "UNSUPPORTED" };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return { error: "READ_FAILED" };
  }
  if (!stat.isFile()) return { error: "NOT_FILE" };
  if (stat.size === 0) return { error: "EMPTY" };
  if (stat.size > MAX_CHAT_FILE_BYTES) return { error: "TOO_LARGE" };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(source);
  } catch {
    return { error: "READ_FAILED" };
  }
  if (buffer.length === 0) return { error: "EMPTY" };
  if (buffer.length > MAX_CHAT_FILE_BYTES) return { error: "TOO_LARGE" };
  if (fileType.magic && !fileType.magic.some((prefix) => buffer.subarray(0, prefix.length).equals(prefix))) {
    return { error: "UNSUPPORTED" };
  }

  const id = crypto.randomUUID();
  const dir = chatFilesDir(config, conversationId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${ext}`), buffer, { flag: "wx" });
  } catch {
    return { error: "READ_FAILED" };
  }
  const name =
    sanitizeDownloadName(requestedName) ?? sanitizeDownloadName(path.basename(source)) ?? `file.${ext}`;
  return {
    attachment: {
      id,
      kind: "file",
      mediaType: fileType.mediaType,
      // The real extension, inside the name cap: a 200-char name + ".pptx"
      // would otherwise lose that extension to the next sanitize's cut.
      name: withDownloadExtension(name, ext),
      size: buffer.length,
    },
    sourcePath: source,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Persist a browser screenshot (relayed from the user's own browser as raw
 * bytes) as the SAME card+slides pair the document share path produces: a
 * visible download card in the chat-files store plus a hidden preview copy in
 * the chat-images store that the file-preview panel renders when the card is
 * clicked. MIME comes from the actual bytes — never from the semi-trusted
 * extension's claim.
 */
export type PublishBrowserScreenshotResult =
  | { file: MessageAttachment; slide: MessageAttachment }
  | { error: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "WRITE_FAILED" };

export function publishBrowserScreenshot(
  config: AppConfig,
  conversationId: string,
  buffer: Buffer,
  pageTitle?: string,
): PublishBrowserScreenshotResult {
  if (buffer.length === 0) return { error: "EMPTY" };
  if (buffer.length > MAX_CHAT_FILE_BYTES) return { error: "TOO_LARGE" };
  const mediaType = detectImageMediaType(buffer);
  if (!mediaType) return { error: "UNSUPPORTED" };
  const ext = MIME_EXT[mediaType];

  const id = crypto.randomUUID();
  const dir = chatFilesDir(config, conversationId);
  const filePath = path.join(dir, `${id}.${ext}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer, { flag: "wx" });
  } catch {
    return { error: "WRITE_FAILED" };
  }
  // Card label (user-facing → Korean): the page title is what tells several
  // captures in one turn apart.
  const cleanTitle = sanitizeDownloadName(pageTitle);
  const title = cleanTitle ? cutDownloadName(cleanTitle, 80) : undefined;
  const name = `${title ? `스크린샷 - ${title}` : "스크린샷"}.${ext}`;
  let slide: MessageAttachment;
  try {
    slide = saveHiddenChatImage(config, conversationId, buffer, mediaType, name, id);
  } catch {
    fs.rmSync(filePath, { force: true });
    return { error: "WRITE_FAILED" };
  }
  return {
    file: { id, kind: "file", mediaType, name, size: buffer.length },
    slide,
  };
}

/** "20260930-181005": the KST wall clock (UTC+9, no DST) of `nowMs`, for capture file names. */
function kstFileStamp(nowMs: number): string {
  const iso = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

export type SaveBrowserCaptureResult =
  | { path: string }
  | { error: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "WRITE_FAILED" };

/**
 * Save a browser screenshot (the SAME bytes the model receives) as a FILE in the
 * conversation scratch workspace, `<workspaceDir>/captures/<YYYYMMDD-HHMMSS>-<6
 * hex>.<ext>`: the KST wall clock plus a random suffix, and the extension from
 * the sniffed bytes, exactly as {@link publishBrowserScreenshot} derives it.
 * This is the copy the avatar can place into something it produces (e.g. a
 * deck's `assets/`), independent of the user-facing card. The workspace is
 * agent-writable, so the folder must be a real directory
 * (`workspaceSubdirForWrite`), the file is created exclusively (`wx`), never
 * through a link, and must still resolve inside the folder afterwards
 * (`keepIfContained`, which removes it otherwise); a name collision draws a
 * fresh suffix and a write that fails part-way removes its partial file.
 * Returns the absolute path the model is told. The errors separate "not an
 * image" (EMPTY/UNSUPPORTED) from a save that failed (TOO_LARGE, WRITE_FAILED)
 * so the tool result can name the real reason.
 */
export function saveBrowserCapture(
  workspaceDir: string,
  buffer: Buffer,
  nowMs: number = Date.now(),
): SaveBrowserCaptureResult {
  if (buffer.length === 0) return { error: "EMPTY" };
  if (buffer.length > MAX_CHAT_FILE_BYTES) return { error: "TOO_LARGE" };
  const mediaType = detectImageMediaType(buffer);
  if (!mediaType) return { error: "UNSUPPORTED" };
  const dir = workspaceSubdirForWrite(workspaceDir, "captures");
  if (!dir) return { error: "WRITE_FAILED" };
  const stamp = kstFileStamp(nowMs);
  for (let attempt = 0; attempt < 5; attempt++) {
    const file = path.join(dir, `${stamp}-${crypto.randomBytes(3).toString("hex")}.${MIME_EXT[mediaType]}`);
    try {
      fs.writeFileSync(file, buffer, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; // taken: draw another suffix
      // The exclusive create makes any file at this name OURS, so a write that
      // failed part-way (ENOSPC) must not leave a truncated capture behind.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
      return { error: "WRITE_FAILED" };
    }
    // The folder was real when checked; a link swapped in since would have
    // taken the write elsewhere, so the saved path must resolve to itself.
    if (!keepIfContained(workspaceDir, "captures", file)) return { error: "WRITE_FAILED" };
    return { path: file };
  }
  return { error: "WRITE_FAILED" };
}

/**
 * Locate a stored file by id within a conversation (for the download endpoint).
 * Scans the dir for `<id>.<ext>` so the caller needn't know the extension.
 */
export function resolveStoredFile(
  config: AppConfig,
  conversationId: string,
  fileId: string,
): { path: string; mediaType: string; ext: string } | null {
  if (!SAFE_ID.test(fileId)) return null;
  const dir = chatFilesDir(config, conversationId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const file = entries.find((name) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 && name.slice(0, dot) === fileId;
  });
  if (!file) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const fileType = FILE_TYPES[ext] ?? SERVED_IMAGE_TYPES[ext];
  if (!fileType) return null;
  return { path: path.join(dir, file), mediaType: fileType.mediaType, ext };
}

/** Delete selected conversation file attachments, ignoring already-missing entries. */
export function deleteChatFileAttachments(
  config: AppConfig,
  conversationId: string,
  attachments: MessageAttachment[] | undefined,
): void {
  if (!attachments?.length) return;
  for (const attachment of attachments) {
    if (attachment.kind !== "file") continue;
    const resolved = resolveStoredFile(config, conversationId, attachment.id);
    if (!resolved) continue;
    try {
      fs.rmSync(resolved.path, { force: true });
    } catch {
      // Best effort: the entire directory is swept when the conversation is deleted.
    }
  }
}

/** Remove a conversation's entire file directory (on conversation delete). */
export function deleteConversationFiles(config: AppConfig, conversationId: string): void {
  fs.rmSync(chatFilesDir(config, conversationId), { recursive: true, force: true });
}
