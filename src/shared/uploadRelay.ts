// Upload relay: on a fleet whose DRM agent decrypts a file only when it is
// uploaded to a REGISTERED address, the composer's attach button opens a
// UniBridge page (the registered address) instead of this app's own file
// dialog; the file is uploaded there and Noah's server pulls it back
// (`src/server/uploadRelay.ts`). This module is what the composer and the
// server share: which files may travel that way and how big. Bundled into the
// browser, so it imports only the (import-free) document contract.

import { CHAT_DOCUMENT_EXTENSIONS, CHAT_DOCUMENT_MEDIA_TYPES, type ChatDocumentExtension } from "./chatDocuments.js";

/** Image extensions the relay takes → the media type the composer's image path expects. */
export const UPLOAD_RELAY_IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Per-file byte cap of the relay. Above the document cap on purpose: an image
 * is downscaled by the composer after it arrives, so a camera-sized picture
 * must get through; a document is still held to `MAX_CHAT_DOCUMENT_BYTES`.
 */
export const UPLOAD_RELAY_MAX_FILE_BYTES: number = 20 * 1024 * 1024;
/** Files one ticket (one press of the attach button) may carry. */
export const UPLOAD_RELAY_MAX_FILES: number = 10;
/** How long a ticket can be used to upload. */
export const UPLOAD_RELAY_TICKET_TTL_SECONDS: number = 600;
/**
 * How long after a ticket's expiry its files can still be collected: the relay
 * keeps an uploaded file for ten minutes, and one uploaded in the ticket's
 * last second must still arrive.
 */
export const UPLOAD_RELAY_COLLECT_GRACE_SECONDS: number = 900;

/** The lower-cased extension of `name` (no dot), or "" when it has none. */
export function uploadRelayExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The dotted, lower-cased extensions a ticket accepts: images always, documents where the pane takes them. */
export function uploadRelayAccept(documents: boolean): string[] {
  const images = Object.keys(UPLOAD_RELAY_IMAGE_MEDIA_TYPES).map((ext) => `.${ext}`);
  return documents ? [...images, ...CHAT_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`)] : images;
}

/** Which intake path a relayed file takes, judged by its name alone (the server checks the bytes). */
export function uploadRelayKind(name: string): "image" | "document" | null {
  const ext = uploadRelayExtension(name);
  if (Object.hasOwn(UPLOAD_RELAY_IMAGE_MEDIA_TYPES, ext)) return "image";
  if ((CHAT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) return "document";
  return null;
}

/** The media type a relayed file is handed to the composer with, or null for a type the relay does not take. */
export function uploadRelayMediaType(name: string): string | null {
  const ext = uploadRelayExtension(name);
  if (Object.hasOwn(UPLOAD_RELAY_IMAGE_MEDIA_TYPES, ext)) return UPLOAD_RELAY_IMAGE_MEDIA_TYPES[ext];
  if ((CHAT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) return CHAT_DOCUMENT_MEDIA_TYPES[ext as ChatDocumentExtension];
  return null;
}

/** Why the server did not hand a relayed file over. */
export type UploadRelayProblem = "TYPE" | "EMPTY" | "TOO_LARGE" | "BAD_FORMAT" | "CHECKSUM";

/** KOREAN, user-facing: the toast the composer shows for a relayed file that was refused. */
export const UPLOAD_RELAY_MESSAGES: Record<UploadRelayProblem, string> = {
  TYPE: "지원하지 않는 파일 형식이라 받지 않았습니다.",
  EMPTY: "빈 파일이라 받지 않았습니다.",
  TOO_LARGE: "파일이 너무 커서 받지 않았습니다.",
  BAD_FORMAT: "파일 내용이 확장자와 맞지 않아 받지 않았습니다. 암호화가 풀리지 않은 파일일 수 있습니다.",
  CHECKSUM: "전송 중 파일이 손상되어 받지 않았습니다. 다시 올려 주세요.",
};
