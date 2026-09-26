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
} from "./chatImages.js";

/**
 * Chat file attachments (agent-GENERATED documents handed to the user as
 * download cards — pptx decks, pdf exports, …). Mirrors the chat-image store
 * (`chatImages.ts`): bytes on disk under `dataDir/chat-files/<conversationId>/`,
 * only {@link MessageAttachment} metadata (kind:"file") on the message row,
 * swept with the conversation. There is deliberately NO upload path — files
 * only flow OUT of the agent workspace (`publishWorkspaceFile`), never in.
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
 * Max HIDDEN image publishes per turn (slide previews embedded in a canvas).
 * Separate from the visible-image cap: hidden files never crowd the bubble,
 * they only cost disk, so a whole deck fits in one turn.
 */
export const MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE = 30;

/**
 * Media type of shared .drawio attachments — the marker the client's
 * FilePreviewPanel (and the share_file result note) key their diagram
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
  // mediaType is what FilePreviewPanel keys on to render the diagram client-side.
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
 * Strip anything filename-hostile from a user-facing download name: path
 * separators, control chars, leading dots (hidden files), overlong tails.
 * Falls back to `null` when nothing safe remains.
 */
export function sanitizeDownloadName(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 200)
    .trim();
  return cleaned || null;
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
      name: name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`,
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
  const title = sanitizeDownloadName(pageTitle)?.slice(0, 80).trim();
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
