import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AppConfig,
  AgentImageFileInput,
  AgentImageInput,
  ImageMediaType,
  MessageAttachment,
} from "./types.js";

/**
 * Chat image attachments (user-uploaded images fed to the model + rendered in
 * the bubble). Mirrors the avatar-image storage pattern (base64 data URL in, a
 * file on disk out), but scoped per conversation under the data volume so it
 * survives restarts and is swept with the conversation. The bytes are NEVER
 * stored in SQLite — only the {@link MessageAttachment} metadata is, on the
 * message row. See `routes/chat.ts` for the upload + serving wiring.
 */

/** Per-image byte cap (after the client's downscale). */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max images per single user message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 6;

export const MIME_EXT: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const EXT_MIME: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// Accept only safe id segments (UUID-ish) so a client-supplied id can't escape
// the conversation's image directory or collide with another file kind.
// Shared with the sibling chat-files store (`chatFiles.ts`) so the two
// conversation-scoped attachment stores can't drift on path safety.
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CONVERSATION_DIR = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function detectImageMediaType(buffer: Buffer): ImageMediaType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const header = buffer.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function safeConversationDir(conversationId: string): string {
  if (SAFE_CONVERSATION_DIR.test(conversationId)) return conversationId;
  const hash = crypto.createHash("sha256").update(conversationId).digest("hex");
  return `conversation-${hash}`;
}

export function chatImagesDir(config: AppConfig, conversationId: string): string {
  return path.join(config.dataDir, "chat-images", safeConversationDir(conversationId));
}

/** A decoded, validated upload ready to be written + fed to the model. */
export interface DecodedChatImage {
  id: string;
  mediaType: ImageMediaType;
  ext: string;
  name?: string;
  buffer: Buffer;
}

export type DecodeError =
  | "TOO_MANY"
  | "BAD_FORMAT"
  | "EMPTY"
  | "TOO_LARGE";

/**
 * Validate + decode the raw image payloads from a chat POST. Each entry is
 * either a bare data URL string or `{ id?, name?, data }`. Returns the decoded
 * images or the first error encountered (so the caller can reject before
 * switching the response to SSE). An empty/absent list returns `[]`.
 */
export function decodeChatImages(raw: unknown): { images: DecodedChatImage[] } | { error: DecodeError } {
  if (raw == null) return { images: [] };
  if (!Array.isArray(raw)) return { error: "BAD_FORMAT" };
  if (raw.length === 0) return { images: [] };
  if (raw.length > MAX_CHAT_IMAGES_PER_MESSAGE) return { error: "TOO_MANY" };

  const images: DecodedChatImage[] = [];
  for (const entry of raw) {
    const dataUrl = typeof entry === "string" ? entry : typeof entry?.data === "string" ? entry.data : "";
    const rawId = typeof entry === "object" && entry && typeof entry.id === "string" ? entry.id : "";
    const rawName = typeof entry === "object" && entry && typeof entry.name === "string" ? entry.name : "";
    const match = DATA_URL.exec(dataUrl);
    if (!match) return { error: "BAD_FORMAT" };
    // Buffer.from never throws on malformed base64 (it stops at the first bad
    // char), so no decode-failure branch is reachable here.
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) return { error: "EMPTY" };
    if (buffer.length > MAX_CHAT_IMAGE_BYTES) return { error: "TOO_LARGE" };
    // Trust the BYTES, not the client-declared MIME — the sibling publish paths
    // (workspace/browser) already sniff, and a lying `image/png` on non-PNG
    // bytes would otherwise 400 the whole turn at the Claude API instead of
    // failing here with a clean message.
    const mediaType = detectImageMediaType(buffer);
    if (!mediaType) return { error: "BAD_FORMAT" };
    images.push({
      id: SAFE_ID.test(rawId) ? rawId : crypto.randomUUID(),
      mediaType,
      ext: MIME_EXT[mediaType],
      name: rawName ? rawName.slice(0, 200) : undefined,
      buffer,
    });
  }
  return { images };
}

/**
 * Persist decoded images to the conversation's image directory and return the
 * metadata (for the stored message) plus the model-facing blocks (base64). Ids
 * are de-duplicated so two uploads can't clobber one file: within the batch via
 * `seen`, and against a pre-existing file on disk via the `wx` open flag (a
 * re-POSTed client id from an earlier message gets a fresh UUID on EEXIST).
 */
export function saveChatImages(
  config: AppConfig,
  conversationId: string,
  decoded: DecodedChatImage[],
): { attachments: MessageAttachment[]; images: AgentImageInput[] } {
  if (decoded.length === 0) return { attachments: [], images: [] };
  const dir = chatImagesDir(config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const attachments: MessageAttachment[] = [];
  const images: AgentImageInput[] = [];
  const seen = new Set<string>();
  for (const img of decoded) {
    let id = img.id;
    while (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    for (;;) {
      try {
        fs.writeFileSync(path.join(dir, `${id}.${img.ext}`), img.buffer, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        id = crypto.randomUUID();
        seen.add(id);
      }
    }
    attachments.push({ id, kind: "image", mediaType: img.mediaType, name: img.name });
    images.push({ mediaType: img.mediaType, data: img.buffer.toString("base64") });
  }
  return { attachments, images };
}

export type PublishWorkspaceImageResult =
  | { attachment: MessageAttachment }
  | { error: "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "NOT_FILE" | "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "READ_FAILED" };

export type ReadWorkspaceImageResult =
  | { buffer: Buffer; mediaType: ImageMediaType; sourcePath: string }
  | { error: "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "NOT_FILE" | "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "READ_FAILED" };

// The PURE steps of the workspace-image read, shared by the sync and async
// readers below so the two cannot drift on path safety: only the fs calls
// between these steps differ (tests/chat-images.test.ts pins their parity).

/** The requested path before realpath: absolute as given, else under the FIRST root. */
function requestedImagePath(roots: string[], inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(roots[0], inputPath);
}

/** A failed realpath of the requested file: only a missing file reads as NOT_FOUND. */
function realpathFailure(error: unknown): "NOT_FOUND" | "READ_FAILED" {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "NOT_FOUND" : "READ_FAILED";
}

function insideAnyRoot(roots: string[], source: string): boolean {
  return roots.some((root) => isInside(root, source));
}

/** Type/size verdict on the stat of the RESOLVED file (null = acceptable). */
function imageStatFailure(stat: fs.Stats): "NOT_FILE" | "EMPTY" | "TOO_LARGE" | null {
  if (!stat.isFile()) return "NOT_FILE";
  if (stat.size === 0) return "EMPTY";
  if (stat.size > MAX_CHAT_IMAGE_BYTES) return "TOO_LARGE";
  return null;
}

/** Content verdict on the bytes actually read: MIME comes from the bytes, never the name. */
function imageFromBytes(buffer: Buffer, sourcePath: string): ReadWorkspaceImageResult {
  if (buffer.length === 0) return { error: "EMPTY" };
  if (buffer.length > MAX_CHAT_IMAGE_BYTES) return { error: "TOO_LARGE" };
  const mediaType = detectImageMediaType(buffer);
  if (!mediaType) return { error: "UNSUPPORTED" };
  return { buffer, mediaType, sourcePath };
}

/**
 * Resolve a run-supplied image path against its allowed working roots and read
 * its bytes, detecting MIME from CONTENT (never the caller-supplied extension).
 * The containment discipline (realpath both sides, `isInside`, size cap) is
 * shared with {@link publishWorkspaceImage} and the clipboard-staging wiring
 * (runPlan → browserClipboard) so they can't drift on path safety.
 */
export function readWorkspaceImage(
  allowedRoots: string[],
  inputPath: string,
): ReadWorkspaceImageResult {
  const roots = allowedRoots.flatMap((root) => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
  if (!roots.length) return { error: "OUTSIDE_WORKSPACE" };

  let source: string;
  try {
    source = fs.realpathSync(requestedImagePath(roots, inputPath));
  } catch (error) {
    return { error: realpathFailure(error) };
  }
  if (!insideAnyRoot(roots, source)) {
    return { error: "OUTSIDE_WORKSPACE" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return { error: "READ_FAILED" };
  }
  const statError = imageStatFailure(stat);
  if (statError) return { error: statError };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(source);
  } catch {
    return { error: "READ_FAILED" };
  }
  return imageFromBytes(buffer, source);
}

/**
 * {@link readWorkspaceImage} for callers that must not block the event loop
 * (the share_file deck-preview loader reads up to 30 renders per share). Same
 * steps, same results, same containment; the bytes come through
 * {@link readRegularFileAsync}, so a file swapped for a FIFO or a symlink after
 * the checks is refused instead of parking a threadpool thread or escaping.
 */
export async function readWorkspaceImageAsync(
  allowedRoots: string[],
  inputPath: string,
): Promise<ReadWorkspaceImageResult> {
  const roots = (
    await Promise.all(
      allowedRoots.map((root) =>
        fs.promises.realpath(root).then(
          (real) => [real],
          () => [],
        ),
      ),
    )
  ).flat();
  if (!roots.length) return { error: "OUTSIDE_WORKSPACE" };

  let source: string;
  try {
    source = await fs.promises.realpath(requestedImagePath(roots, inputPath));
  } catch (error) {
    return { error: realpathFailure(error) };
  }
  if (!insideAnyRoot(roots, source)) {
    return { error: "OUTSIDE_WORKSPACE" };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(source);
  } catch {
    return { error: "READ_FAILED" };
  }
  const statError = imageStatFailure(stat);
  if (statError) return { error: statError };

  const read = await readRegularFileAsync(source, MAX_CHAT_IMAGE_BYTES);
  if ("error" in read) return { error: read.error };
  return imageFromBytes(read.buffer, source);
}

// O_NONBLOCK: opening a FIFO never waits for a writer (a blocked open would
// hold a libuv threadpool thread forever). O_NOFOLLOW: the final component was
// just realpath'd, so a symlink there now means it was swapped in since — refuse
// it. Both are no-ops for the regular files these readers expect; 0 where the
// platform lacks the flag.
const SAFE_READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

export type ReadRegularFileResult =
  | { buffer: Buffer }
  | { error: "NOT_FILE" | "EMPTY" | "TOO_LARGE" | "READ_FAILED" };

/**
 * Read one REGULAR file by an already resolved (realpath'd, containment-checked)
 * path without trusting that it is still the file the caller checked: the
 * type/size checks run on the OPENED descriptor, and at most its stat size is
 * buffered (a file that grows mid-read is READ_FAILED, never a partial answer
 * past `maxBytes`). Shared by {@link readWorkspaceImageAsync} and the deck
 * preview manifest reader (`deckPreview.ts`).
 */
export async function readRegularFileAsync(
  realPath: string,
  maxBytes: number,
): Promise<ReadRegularFileResult> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(realPath, SAFE_READ_FLAGS);
  } catch {
    return { error: "READ_FAILED" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { error: "NOT_FILE" };
    if (stat.size === 0) return { error: "EMPTY" };
    if (stat.size > maxBytes) return { error: "TOO_LARGE" };
    // One spare byte: filling it means the file grew after the stat.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total === buffer.length) break;
    }
    if (total > stat.size) return { error: "READ_FAILED" };
    if (total === 0) return { error: "EMPTY" };
    return { buffer: buffer.subarray(0, total) };
  } catch {
    return { error: "READ_FAILED" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Copy a local image from one of this run's explicit working roots into the
 * owner-scoped conversation image store. The browser never receives the source
 * path. MIME is detected from file bytes, not from the extension supplied by a
 * repo or download.
 */
export function publishWorkspaceImage(
  config: AppConfig,
  conversationId: string,
  inputPath: string,
  allowedRoots: string[],
  caption?: string,
): PublishWorkspaceImageResult {
  const read = readWorkspaceImage(allowedRoots, inputPath);
  if ("error" in read) return read;
  const { buffer, mediaType, sourcePath: source } = read;

  const id = crypto.randomUUID();
  const dir = chatImagesDir(config, conversationId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${MIME_EXT[mediaType]}`), buffer, { flag: "wx" });
  } catch {
    return { error: "READ_FAILED" };
  }
  return {
    attachment: {
      id,
      kind: "image",
      mediaType,
      name: path.basename(source).slice(0, 200),
      caption: caption?.trim().slice(0, 300) || undefined,
    },
  };
}

/**
 * Persist one already-validated in-memory image as a HIDDEN attachment (a
 * file-preview-panel slide) in the conversation store, linked to the visible
 * download card it previews via `parentId`. The caller owns validation —
 * bytes here are either our own renderer's output or bytes it already sniffed.
 */
export function saveHiddenChatImage(
  config: AppConfig,
  conversationId: string,
  buffer: Buffer,
  mediaType: ImageMediaType,
  name: string,
  parentId?: string,
): MessageAttachment {
  const dir = chatImagesDir(config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${id}.${MIME_EXT[mediaType]}`), buffer, { flag: "wx" });
  return { id, kind: "image", mediaType, name, hidden: true, parentId };
}

/**
 * Persist SERVER-rendered preview pages (share_file's automatic slide
 * rasterization — see deckRender.ts) as HIDDEN image attachments in the
 * conversation store. Trusted input from our own renderer, so no MIME
 * sniffing or byte caps here; hidden keeps them out of the chat bubble while
 * the file-preview panel reads them off the same message (scoped to the
 * shared file's card via `parentId`).
 */
export function savePreviewImages(
  config: AppConfig,
  conversationId: string,
  buffers: Buffer[],
  parentId?: string,
): MessageAttachment[] {
  return buffers.map((buffer, index) =>
    saveHiddenChatImage(config, conversationId, buffer, "image/png", `slide-${index + 1}.png`, parentId),
  );
}

/** Delete selected conversation image files, ignoring already-missing entries. */
export function deleteChatImageAttachments(
  config: AppConfig,
  conversationId: string,
  attachments: MessageAttachment[] | undefined,
): void {
  if (!attachments?.length) return;
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    const resolved = resolveStoredImage(config, conversationId, attachment.id);
    if (!resolved) continue;
    try {
      fs.rmSync(resolved.path, { force: true });
    } catch {
      // Best effort: the entire directory is swept when the conversation is deleted.
    }
  }
}

/**
 * Read stored attachment files back into model-facing image blocks — used on
 * regenerate (a fresh SDK session that must re-feed the prior turn's images).
 * Silently skips any attachment whose file is missing.
 */
export function readChatImages(
  config: AppConfig,
  conversationId: string,
  attachments: MessageAttachment[] | undefined,
): AgentImageInput[] {
  if (!attachments?.length) return [];
  const dir = chatImagesDir(config, conversationId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Index the dir ONCE (id -> filename) so N attachments don't trigger N readdirs.
  const byId = new Map<string, string>();
  for (const name of entries) {
    const dot = name.lastIndexOf(".");
    if (dot > 0) byId.set(name.slice(0, dot), name);
  }
  const out: AgentImageInput[] = [];
  for (const att of attachments) {
    const file = byId.get(att.id);
    if (!file) continue;
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const mediaType = EXT_MIME[ext];
    if (!mediaType) continue;
    try {
      out.push({ mediaType, data: fs.readFileSync(path.join(dir, file)).toString("base64") });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Stage stored image attachments as FILES the agent can reach: copy each one
 * from the conversation image store into `<workspaceDir>/attachments/<id>.<ext>`
 * and return the model-facing file descriptors (absolute paths). Used for
 * text-only-model turns where image bytes must never enter model input but the
 * agent should still be able to act on the files (show_file / Bash / repo
 * tools). Missing or unreadable files are skipped silently (mirrors
 * readChatImages); hidden attachments (preview slides) are ignored.
 */
export function stageChatImageFilesFromAttachments(
  config: AppConfig,
  conversationId: string,
  workspaceDir: string,
  attachments: MessageAttachment[] | undefined,
): AgentImageFileInput[] {
  if (!attachments?.length) return [];
  const dir = path.join(workspaceDir, "attachments");
  let dirReady = false;
  const staged: AgentImageFileInput[] = [];
  for (const att of attachments) {
    if (att.kind !== "image" || att.hidden) continue;
    const resolved = resolveStoredImage(config, conversationId, att.id);
    if (!resolved) continue;
    const dest = path.join(dir, `${att.id}.${MIME_EXT[resolved.mediaType]}`);
    try {
      if (!dirReady) {
        fs.mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      fs.copyFileSync(resolved.path, dest);
    } catch {
      continue; // skip unreadable/uncopyable, like readChatImages
    }
    staged.push({ path: dest, mediaType: resolved.mediaType, name: att.name });
  }
  return staged;
}

/**
 * Locate a stored image by id within a conversation (for the serving endpoint).
 * Scans the dir for `<id>.<ext>` so the caller needn't know the extension.
 * Returns null on a bad id or when no file exists.
 */
export function resolveStoredImage(
  config: AppConfig,
  conversationId: string,
  imageId: string,
): { path: string; mediaType: ImageMediaType } | null {
  if (!SAFE_ID.test(imageId)) return null;
  const dir = chatImagesDir(config, conversationId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const file = entries.find((name) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 && name.slice(0, dot) === imageId;
  });
  if (!file) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const mediaType = EXT_MIME[ext];
  if (!mediaType) return null;
  return { path: path.join(dir, file), mediaType };
}

/** Remove a conversation's entire image directory (on conversation delete). */
export function deleteConversationImages(config: AppConfig, conversationId: string): void {
  fs.rmSync(chatImagesDir(config, conversationId), { recursive: true, force: true });
}
