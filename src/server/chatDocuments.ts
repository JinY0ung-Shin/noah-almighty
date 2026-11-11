import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentDocumentInput, AppConfig, MessageAttachment } from "./types.js";
import { SAFE_ID } from "./chatImages.js";
import { chatFilesDir, resolveStoredFile } from "./chatFiles.js";
import logger from "./logger.js";
import {
  CHAT_DOCUMENT_MEDIA_TYPES,
  MAX_CHAT_ATTACHMENTS_ENCODED_BYTES,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENTS_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_BYTES,
  base64EncodedLength,
  chatDocumentExtension,
  chatDocumentName,
  chatDocumentNameProblem,
  uniqueChatDocumentNames,
  type ChatDocumentExtension,
  type ChatDocumentProblem,
} from "../shared/chatDocuments.js";

/**
 * Chat DOCUMENT attachments: files the USER attaches to a message so the avatar
 * can read them (pdf/docx/xlsx/pptx/csv/txt/md/json — the contract is
 * `src/shared/chatDocuments.ts`). Two copies exist:
 *
 * - NOAH's copy, written here into the conversation's chat-files store
 *   (`dataDir/chat-files/<conversation>/<id>.<ext>`) with a `kind:"file"`,
 *   `uploaded: true` attachment on the USER message. It is what the bubble
 *   re-downloads, what a regenerate/edit re-sends, and it dies with the
 *   message through the file store's existing cascades (rewind sweep,
 *   conversation delete, 비우기, user delete).
 * - The SANDBOX copy, `/workspace/uploads/<name>`, written by pi-gateway from
 *   the turn's `input_file` part — in the per-USER workspace, kept between
 *   conversations, replaced by a later upload of the same name. Noah never
 *   writes or deletes it (it is the user's workspace file, like anything the
 *   avatar makes there).
 *
 * The bytes are NEVER trusted to be what the name says: each type is checked
 * against its content before anything is stored or sent.
 */

/** A decoded, validated document ready to be stored and sent. */
export interface DecodedChatDocument {
  id: string;
  /** The plain file name (unique within the message) pi stores it under. */
  name: string;
  ext: ChatDocumentExtension;
  mediaType: string;
  buffer: Buffer;
}

/** `PK\x03\x04` — a ZIP local file header (every OOXML document starts with one). */
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_HEADER = Buffer.from("%PDF-");
/** Adobe readers accept the header anywhere in the first 1024 bytes; so do pypdf and this check. */
const PDF_HEADER_WINDOW = 1024;
const CONTENT_TYPES_PART = Buffer.from("[Content_Types].xml");
/** The part folder that tells the three OOXML kinds apart (file names are stored uncompressed in a ZIP). */
const OOXML_PART_PREFIX: Record<"docx" | "xlsx" | "pptx", Buffer> = {
  docx: Buffer.from("word/"),
  xlsx: Buffer.from("xl/"),
  pptx: Buffer.from("ppt/"),
};
/** How much of a text document is checked for a NUL byte (the mark of a binary file). */
const TEXT_SNIFF_BYTES = 8192;

/**
 * Whether `buffer` is what a `.ext` file must be: `%PDF-` for a pdf, a ZIP that
 * holds the OOXML parts of THAT kind for docx/xlsx/pptx (a renamed .doc, a
 * password-protected file — an OLE container — or a .xlsx named .docx all
 * fail). The text types (csv/txt/md/json) take ANY text encoding — the fleet's
 * Excel exports are very often CP949/EUC-KR, and the avatar is told to try
 * that — so only what is clearly binary is refused: a NUL byte in the first
 * chunk — except UTF-16 text that announces itself with a byte-order mark. A json
 * file need not parse.
 */
export function chatDocumentContentMatches(ext: ChatDocumentExtension, buffer: Buffer): boolean {
  switch (ext) {
    case "pdf":
      return buffer.subarray(0, PDF_HEADER_WINDOW).includes(PDF_HEADER);
    case "docx":
    case "xlsx":
    case "pptx":
      return (
        buffer.subarray(0, ZIP_LOCAL_HEADER.length).equals(ZIP_LOCAL_HEADER) &&
        buffer.includes(CONTENT_TYPES_PART) &&
        buffer.includes(OOXML_PART_PREFIX[ext])
      );
    case "csv":
    case "txt":
    case "md":
    case "json":
      // UTF-16 text (Excel's "Unicode text" export) is full of NUL bytes and is
      // still text: its byte-order mark says so.
      if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) return true;
      return !buffer.subarray(0, TEXT_SNIFF_BYTES).includes(0);
  }
}

/** The base64 payload of a `data:…;base64,…` URL (any declared MIME — it is never used), else null. */
function base64PayloadOf(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || comma > 256) return null;
  const header = dataUrl.slice(0, comma);
  if (!header.startsWith("data:") || !header.endsWith(";base64")) return null;
  return dataUrl.slice(comma + 1);
}

/**
 * Validate + decode the raw `files` payload of a chat POST: an array of
 * `{ id?, name, data }` where `data` is a base64 `data:` URL. Returns the
 * decoded documents (names made unique within the message) or the FIRST
 * problem, so the caller can refuse before switching the response to SSE.
 * `encodedImageBytes` is the base64 size of the same message's images: images
 * and documents share one request to pi-gateway, so they share one budget
 * (`MAX_CHAT_ATTACHMENTS_ENCODED_BYTES`). An empty/absent list returns `[]`.
 */
export function decodeChatDocuments(
  raw: unknown,
  options: { encodedImageBytes?: number } = {},
): { documents: DecodedChatDocument[] } | { error: ChatDocumentProblem } {
  if (raw == null) return { documents: [] };
  if (!Array.isArray(raw)) return { error: "BAD_FORMAT" };
  if (raw.length === 0) return { documents: [] };
  if (raw.length > MAX_CHAT_DOCUMENTS_PER_MESSAGE) return { error: "TOO_MANY" };

  const decoded: Omit<DecodedChatDocument, "name">[] = [];
  const names: string[] = [];
  let totalBytes = 0;
  let encodedBytes = options.encodedImageBytes ?? 0;
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") return { error: "BAD_FORMAT" };
    const { id: rawId, name: rawName, data } = entry as { id?: unknown; name?: unknown; data?: unknown };
    if (typeof rawName !== "string" || typeof data !== "string") return { error: "BAD_FORMAT" };
    const name = chatDocumentName(rawName);
    if (name === null) return { error: chatDocumentNameProblem(rawName) ?? "NAME" };
    const ext = chatDocumentExtension(name)!;
    const payload = base64PayloadOf(data);
    if (payload === null) return { error: "BAD_FORMAT" };
    if (payload.length === 0) return { error: "EMPTY" };
    // Refuse an oversized payload BEFORE decoding it (the request may be tens of MB).
    if (payload.length > base64EncodedLength(MAX_CHAT_DOCUMENT_BYTES)) return { error: "TOO_LARGE" };
    const buffer = Buffer.from(payload, "base64");
    // Buffer.from skips what is not base64 instead of failing: a payload that
    // does not decode to the length its text promises was not base64.
    const unpadded = payload.replace(/=+$/, "");
    if (buffer.length !== Math.floor((unpadded.length * 3) / 4)) return { error: "BAD_FORMAT" };
    if (buffer.length === 0) return { error: "EMPTY" };
    if (buffer.length > MAX_CHAT_DOCUMENT_BYTES) return { error: "TOO_LARGE" };
    totalBytes += buffer.length;
    if (totalBytes > MAX_CHAT_DOCUMENTS_TOTAL_BYTES) return { error: "TOTAL_TOO_LARGE" };
    encodedBytes += base64EncodedLength(buffer.length);
    if (encodedBytes > MAX_CHAT_ATTACHMENTS_ENCODED_BYTES) return { error: "TOTAL_TOO_LARGE" };
    // Trust the BYTES, never the name or the client's MIME.
    if (!chatDocumentContentMatches(ext, buffer)) return { error: "BAD_FORMAT" };
    decoded.push({
      id: typeof rawId === "string" && SAFE_ID.test(rawId) ? rawId : crypto.randomUUID(),
      ext,
      mediaType: CHAT_DOCUMENT_MEDIA_TYPES[ext],
      buffer,
    });
    names.push(name);
  }
  const unique = uniqueChatDocumentNames(names);
  return { documents: decoded.map((document, index) => ({ ...document, name: unique[index] })) };
}

/** The model-facing form of a document's bytes. */
function documentInput(name: string, mediaType: string, buffer: Buffer): AgentDocumentInput {
  return { name, mediaType, data: buffer.toString("base64"), size: buffer.length };
}

/**
 * Persist decoded documents into the conversation's chat-files store and return
 * the attachment metadata (for the USER message) plus the model-facing inputs.
 * An id is never reused: not within the batch, and not against ANY stored file
 * of the conversation with that id (an avatar-published card included, whatever
 * its extension — `resolveStoredFile` finds a file by its id alone).
 */
export function saveChatDocuments(
  config: AppConfig,
  conversationId: string,
  decoded: DecodedChatDocument[],
): { attachments: MessageAttachment[]; documents: AgentDocumentInput[] } {
  if (decoded.length === 0) return { attachments: [], documents: [] };
  const dir = chatFilesDir(config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const attachments: MessageAttachment[] = [];
  const documents: AgentDocumentInput[] = [];
  const seen = new Set<string>();
  for (const document of decoded) {
    let id = document.id;
    for (;;) {
      while (seen.has(id) || resolveStoredFile(config, conversationId, id)) id = crypto.randomUUID();
      seen.add(id);
      try {
        fs.writeFileSync(path.join(dir, `${id}.${document.ext}`), document.buffer, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        id = crypto.randomUUID();
      }
    }
    attachments.push({
      id,
      kind: "file",
      mediaType: document.mediaType,
      name: document.name,
      size: document.buffer.length,
      uploaded: true,
    });
    documents.push(documentInput(document.name, document.mediaType, document.buffer));
  }
  return { attachments, documents };
}

/** A user-attached document on a message row (never an avatar-published file card). */
export function isUploadedDocument(attachment: MessageAttachment): boolean {
  return attachment.kind === "file" && attachment.uploaded === true;
}

/**
 * Read a message's stored documents back into model-facing inputs — a
 * regenerate or an edit re-sends its anchor row's documents (pi then rewrites
 * `/workspace/uploads/<name>` with the stored bytes). Only `uploaded` file
 * attachments whose stored name is still a valid document name qualify; a
 * missing or unreadable file is skipped (and logged), like `readChatImages`.
 */
export function readChatDocuments(
  config: AppConfig,
  conversationId: string,
  attachments: MessageAttachment[] | undefined,
): AgentDocumentInput[] {
  const out: AgentDocumentInput[] = [];
  for (const attachment of attachments ?? []) {
    if (!isUploadedDocument(attachment)) continue;
    const name = chatDocumentName(attachment.name ?? "");
    const stored = name ? resolveStoredFile(config, conversationId, attachment.id) : null;
    // The stored extension must be the name's: the id alone picks the file.
    if (!name || !stored || stored.ext !== chatDocumentExtension(name)) {
      logger.warn({ conversationId, attachmentId: attachment.id }, "chat document: stored copy missing; not re-sent");
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(stored.path);
    } catch {
      buffer = Buffer.alloc(0);
    }
    if (buffer.length === 0 || buffer.length > MAX_CHAT_DOCUMENT_BYTES) {
      logger.warn({ conversationId, attachmentId: attachment.id }, "chat document: stored copy unreadable; not re-sent");
      continue;
    }
    out.push(documentInput(name, CHAT_DOCUMENT_MEDIA_TYPES[stored.ext as ChatDocumentExtension], buffer));
  }
  return out;
}
