import crypto from "node:crypto";
import type { UploadRelayConfig } from "./types.js";
import { chatDocumentContentMatches } from "./chatDocuments.js";
import { MAX_CHAT_DOCUMENT_BYTES, chatDocumentExtension } from "../shared/chatDocuments.js";
import {
  UPLOAD_RELAY_COLLECT_GRACE_SECONDS,
  UPLOAD_RELAY_MAX_FILES,
  UPLOAD_RELAY_MAX_FILE_BYTES,
  UPLOAD_RELAY_TICKET_TTL_SECONDS,
  uploadRelayAccept,
  uploadRelayExtension,
  uploadRelayKind,
  type UploadRelayProblem,
} from "../shared/uploadRelay.js";

/**
 * Upload relay — the server half (contract v1, shared with UniBridge's
 * `upload-relay` router).
 *
 * On the fleet a DRM agent decrypts a file only while it is uploaded to a
 * REGISTERED address, and Noah's is not one. So the composer's attach button
 * opens a page on the relay (UniBridge, a registered address) with a ticket
 * Noah signed; the user uploads there, the relay holds the decrypted file for
 * a few minutes, and Noah PULLS it — the relay cannot reach Noah.
 *
 * What keeps this narrow:
 * - Noah fetches from ONE origin, the operator's `UPLOAD_RELAY_URL`; no URL,
 *   host or path segment ever comes from a user (ids are pattern-checked
 *   before they enter a path, redirects are refused).
 * - The shared secret never leaves the two servers: the browser carries the
 *   TICKET (who may upload what, until when), and every server-to-server call
 *   is signed separately, so a leaked ticket cannot read a file back.
 * - A ticket is bound to the Noah user who minted it by a keyed tag inside
 *   its id — collecting takes that user's session AND the ticket.
 * - The bytes exist here only for the length of the request that hands them
 *   to the owner's browser, which then runs them through the ordinary attach
 *   intake; nothing is written to disk on this path.
 * - Every file handed over or refused is an audit row (the relay keeps its own).
 */

const TICKET_VERSION = "v1";
const TICKET_DOMAIN = "noah-upload-relay-ticket:";
const REQUEST_DOMAIN = "noah-upload-relay-request:v1";
const OWNER_DOMAIN = "noah-upload-relay-owner:";

/** Random part and owner tag of a ticket id, in base64url characters (16 and 12 bytes). */
const TID_RANDOM_CHARS = 22;
const TID_TAG_CHARS = 16;
const TID_PATTERN = /^[A-Za-z0-9_-]{38}$/;
/** A relay file id as it may enter a URL path. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const LIST_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 60_000;
const ACK_TIMEOUT_MS = 10_000;

export interface UploadRelayTicketPayload {
  tid: string;
  /** The Noah username the relay shows and logs. */
  user: string;
  /** The display name the relay page shows ("○○님의 Noah 대화로 전송됩니다"). */
  name: string;
  /** Unix seconds after which the relay refuses an upload. */
  exp: number;
  /** Dotted lower-case extensions. */
  accept: string[];
  maxBytes: number;
  maxFiles: number;
}

/** A file the relay holds for a ticket, as its list endpoint names it. */
export interface UploadRelayFileInfo {
  id: string;
  name: string;
  size: number;
  sha256: string;
  /** The relay's own (Keycloak) account that uploaded it. */
  uploader: string;
  uploadedAt: string;
}

function hmac(secret: string, message: string): Buffer {
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * `text` as a ticket field: no lone UTF-16 surrogate (a half pair cannot be
 * encoded as UTF-8, and the relay would refuse — or choke on — the ticket) and
 * at most `max` code points, never cut through a pair.
 */
export function ticketText(text: string, max: number): string {
  const wellFormed = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  return Array.from(wellFormed).slice(0, max).join("");
}

function ownerTag(secret: string, random: string, userId: string): string {
  return hmac(secret, `${OWNER_DOMAIN}${random}:${userId}`).subarray(0, 12).toString("base64url");
}

/** `v1.<payload>.<signature>` over `payload` (base64url JSON). */
function signTicket(secret: string, payload: UploadRelayTicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = hmac(secret, `${TICKET_DOMAIN}${TICKET_VERSION}.${body}`).toString("base64url");
  return `${TICKET_VERSION}.${body}.${signature}`;
}

export interface MintedUploadRelayTicket {
  ticket: string;
  /** Seconds the ticket can still be used to upload — a duration, so the browser never compares clocks. */
  ttlSeconds: number;
  /** The relay page to open, with the ticket in the FRAGMENT (never sent to a server, never in a Referer). */
  url: string;
  expiresAt: string;
  payload: UploadRelayTicketPayload;
}

/** Mint a ticket for `user`: images always, documents when the pane that asked takes them. */
export function mintUploadRelayTicket(
  relay: UploadRelayConfig,
  user: { id: string; username: string; displayName: string },
  options: { documents: boolean; now?: number },
): MintedUploadRelayTicket {
  const now = options.now ?? Date.now();
  const random = crypto.randomBytes(16).toString("base64url");
  const payload: UploadRelayTicketPayload = {
    tid: `${random}${ownerTag(relay.secret, random, user.id)}`,
    user: ticketText(user.username, 200),
    name: ticketText(user.displayName || user.username, 200),
    exp: Math.floor(now / 1000) + UPLOAD_RELAY_TICKET_TTL_SECONDS,
    accept: uploadRelayAccept(options.documents),
    maxBytes: UPLOAD_RELAY_MAX_FILE_BYTES,
    maxFiles: UPLOAD_RELAY_MAX_FILES,
  };
  const ticket = signTicket(relay.secret, payload);
  return {
    ticket,
    ttlSeconds: UPLOAD_RELAY_TICKET_TTL_SECONDS,
    url: `${relay.url}/upload-relay#t=${ticket}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload,
  };
}

/**
 * The payload of a ticket THIS server signed for THIS user that can still be
 * collected (its expiry plus the collect grace), else null. One answer for
 * every failure: a caller never learns which check a foreign ticket failed.
 */
export function verifyOwnUploadRelayTicket(
  relay: UploadRelayConfig,
  ticket: unknown,
  userId: string,
  now: number = Date.now(),
): UploadRelayTicketPayload | null {
  if (typeof ticket !== "string" || ticket.length > 4096) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) return null;
  const [, body, signature] = parts;
  const expected = hmac(relay.secret, `${TICKET_DOMAIN}${TICKET_VERSION}.${body}`);
  if (!safeEqual(Buffer.from(signature, "base64url"), expected)) return null;
  let payload: UploadRelayTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadRelayTicketPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.tid !== "string" || !TID_PATTERN.test(payload.tid)) return null;
  if (typeof payload.exp !== "number" || !Array.isArray(payload.accept)) return null;
  const random = payload.tid.slice(0, TID_RANDOM_CHARS);
  const tag = payload.tid.slice(TID_RANDOM_CHARS, TID_RANDOM_CHARS + TID_TAG_CHARS);
  if (!safeEqual(Buffer.from(tag, "utf8"), Buffer.from(ownerTag(relay.secret, random, userId), "utf8"))) return null;
  if (now / 1000 > payload.exp + UPLOAD_RELAY_COLLECT_GRACE_SECONDS) return null;
  return payload;
}

/** The signature of one server-to-server request (`path` as the relay's service sees it, no query). */
export function signUploadRelayRequest(secret: string, method: string, path: string, timestamp: number): string {
  return hmac(secret, `${REQUEST_DOMAIN}\n${method.toUpperCase()}\n${path}\n${timestamp}`).toString("hex");
}

/** The relay answered something this contract does not allow (or did not answer). */
export class UploadRelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UploadRelayError";
  }
}

export type RelayFetch = typeof fetch;

async function relayRequest(
  relay: UploadRelayConfig,
  method: "GET" | "POST",
  path: string,
  options: { timeoutMs: number; json?: unknown; fetchImpl?: RelayFetch; now?: number },
): Promise<Response> {
  const timestamp = Math.floor((options.now ?? Date.now()) / 1000);
  const headers: Record<string, string> = {
    "X-Noah-Relay-Timestamp": String(timestamp),
    "X-Noah-Relay-Signature": signUploadRelayRequest(relay.secret, method, path, timestamp),
  };
  if (options.json !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await (options.fetchImpl ?? fetch)(`${relay.apiUrl}${path}`, {
      method,
      headers,
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      // The relay is ONE configured origin: a redirect is never followed.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new UploadRelayError(`upload relay unreachable: ${(error as Error).name}`);
  }
}

function toFileInfo(raw: unknown): UploadRelayFileInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, size, sha256, uploader, uploadedAt } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !FILE_ID_PATTERN.test(id)) return null;
  if (typeof name !== "string" || !name || name.length > 1024) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  return {
    id,
    name,
    size,
    sha256,
    uploader: typeof uploader === "string" ? uploader.slice(0, 200) : "",
    uploadedAt: typeof uploadedAt === "string" ? uploadedAt.slice(0, 64) : "",
  };
}

/** The files the relay holds for a ticket (oldest first). Entries that are not well-formed are dropped. */
export async function listUploadRelayFiles(
  relay: UploadRelayConfig,
  tid: string,
  options: { fetchImpl?: RelayFetch; now?: number } = {},
): Promise<UploadRelayFileInfo[]> {
  if (!TID_PATTERN.test(tid)) throw new UploadRelayError("bad ticket id");
  const response = await relayRequest(relay, "GET", `/upload-relay/tickets/${tid}/files`, { timeoutMs: LIST_TIMEOUT_MS, ...options });
  if (!response.ok) throw new UploadRelayError(`upload relay list answered ${response.status}`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UploadRelayError("upload relay list was not JSON");
  }
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new UploadRelayError("upload relay list had no files array");
  return files
    .slice(0, UPLOAD_RELAY_MAX_FILES * 2)
    .map(toFileInfo)
    .filter((file): file is UploadRelayFileInfo => file !== null);
}

/**
 * One file's bytes, or null when the relay no longer has it. Reading stops at
 * `maxBytes + 1`: an answer longer than the cap comes back one byte over, so
 * the caller's size check refuses it without the whole body in memory.
 */
export async function fetchUploadRelayFile(
  relay: UploadRelayConfig,
  fileId: string,
  maxBytes: number,
  options: { fetchImpl?: RelayFetch; now?: number } = {},
): Promise<Buffer | null> {
  if (!FILE_ID_PATTERN.test(fileId)) throw new UploadRelayError("bad file id");
  const response = await relayRequest(relay, "GET", `/upload-relay/files/${fileId}`, { timeoutMs: FETCH_TIMEOUT_MS, ...options });
  if (response.status === 404) return null;
  if (!response.ok) throw new UploadRelayError(`upload relay file answered ${response.status}`, response.status);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    throw new UploadRelayError(`upload relay file read failed: ${(error as Error).name}`);
  }
  return Buffer.concat(chunks, total);
}

/** Pauses before the 2nd and 3rd attempt of an acknowledgement. */
const ACK_RETRY_DELAYS_MS = [300, 1500];

/**
 * {@link ackUploadRelayFileOnce}, tried up to three times: an acknowledgement
 * that is lost leaves the relay's trail saying the file was collected but
 * never confirmed, so a blip must not be enough to lose it.
 */
export async function ackUploadRelayFile(
  relay: UploadRelayConfig,
  fileId: string,
  outcome: "delivered" | "refused",
  reason: string | undefined,
  options: { fetchImpl?: RelayFetch; now?: number; retryDelaysMs?: readonly number[] } = {},
): Promise<void> {
  const delays = options.retryDelaysMs ?? ACK_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ackUploadRelayFileOnce(relay, fileId, outcome, reason, options);
      return;
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Tell the relay what became of a file; it deletes its copy and writes its own audit row. */
async function ackUploadRelayFileOnce(
  relay: UploadRelayConfig,
  fileId: string,
  outcome: "delivered" | "refused",
  reason: string | undefined,
  options: { fetchImpl?: RelayFetch; now?: number } = {},
): Promise<void> {
  if (!FILE_ID_PATTERN.test(fileId)) throw new UploadRelayError("bad file id");
  const response = await relayRequest(relay, "POST", `/upload-relay/files/${fileId}/ack`, {
    timeoutMs: ACK_TIMEOUT_MS,
    json: { outcome, ...(reason ? { reason: reason.slice(0, 200) } : {}) },
    ...options,
  });
  // 404: already acknowledged or expired — the copy is gone either way.
  if (!response.ok && response.status !== 404) {
    throw new UploadRelayError(`upload relay ack answered ${response.status}`, response.status);
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Is `buffer` an image of the kind its extension says? (The first bytes only — the browser decodes it.) */
function imageContentMatches(ext: string, buffer: Buffer): boolean {
  switch (ext) {
    case "png":
      return buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
    case "jpg":
    case "jpeg":
      return buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
    case "gif": {
      const head = buffer.subarray(0, 6).toString("latin1");
      return head === "GIF87a" || head === "GIF89a";
    }
    case "webp":
      return buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}

/**
 * Why a relayed file is not handed to the composer, or null when it is: its
 * type is one the TICKET accepted, it is not empty or over its kind's cap, it
 * is the file the relay listed (SHA-256), and its bytes are what the name
 * says. The last check is the one that matters on the fleet: a file the DRM
 * agent did NOT decrypt fails it, and that refusal is in the audit trail.
 */
export function judgeUploadRelayFile(
  file: Pick<UploadRelayFileInfo, "name" | "sha256">,
  buffer: Buffer,
  accept: readonly string[],
): UploadRelayProblem | null {
  const ext = uploadRelayExtension(file.name);
  const kind = uploadRelayKind(file.name);
  if (!kind || !accept.includes(`.${ext}`)) return "TYPE";
  if (buffer.length === 0) return "EMPTY";
  if (buffer.length > (kind === "document" ? MAX_CHAT_DOCUMENT_BYTES : UPLOAD_RELAY_MAX_FILE_BYTES)) return "TOO_LARGE";
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== file.sha256) return "CHECKSUM";
  if (kind === "document") {
    const documentExt = chatDocumentExtension(file.name);
    return documentExt && chatDocumentContentMatches(documentExt, buffer) ? null : "BAD_FORMAT";
  }
  return imageContentMatches(ext, buffer) ? null : "BAD_FORMAT";
}

/** A file name as an audit/log line carries it: no control characters, bounded. */
export function auditFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, 200);
}
