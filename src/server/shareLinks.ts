import crypto from "node:crypto";
import { hashToken } from "./auth.js";
import {
  isShareFileExtension,
  resolveStoredFile,
  sanitizeDownloadName,
  withDownloadExtension,
} from "./chatFiles.js";
import { resolveStoredImage, SAFE_ID } from "./chatImages.js";
import {
  type WorkspaceShareRefusal,
  readWorkspaceShareSource,
  removeShareFileCopy,
  resolveShareFileCopy,
  sweepShareFileCopies,
  writeShareFileCopy,
} from "./shareFiles.js";
import type { Store } from "./store.js";
import type { ShareLinkLookup, ShareLinkRecord } from "./store/shareLinks.js";
import type { AppConfig, ImageMediaType, MessageAttachment, StoredMessage } from "./types.js";
import {
  isShareableFileCard,
  isShareToken,
  MAX_ACTIVE_SHARE_LINKS,
  MAX_SHARE_LINK_SLIDES,
  SHARE_TICKET_TTL_MINUTES,
  shareLinkPath,
  shareSlideAttachments,
  type ShareLinkExpiryDays,
  type ShareLinkKind,
  type ShareLinkSummary,
  type ShareViewAttachment,
  type ShareViewMessage,
  type ShareViewPayload,
} from "../shared/shareLinks.js";

/**
 * Share links — the ONE service behind both creation paths (the share
 * router's owner routes and the chat route's `onShareLink` host callback) and
 * every recipient call, so they cannot drift on:
 * - token + viewer-ticket derivation (HMAC under SESSION_SECRET over the link
 *   id AND the row's random salt; only the token's SHA-256 is stored, and
 *   re-display recomputes it — no scrypt here);
 * - the name a link stores and serves (always ending in the extension of the
 *   bytes served: {@link shareDownloadName});
 * - which threads may share at all ({@link shareableThread});
 * - create-or-reuse (one active link per owner/conversation/file);
 * - recipient validity, re-run on EVERY call so revocation is immediate.
 *
 * A link is NOT a trust source: it never touches `isTrustedFor`, avatar
 * visibility or tool access — it authorises reading ONE thing its owner chose
 * to export, a human-initiated export equivalent to download-and-forward:
 * - a "file" link: ONE card's bytes (and a deck's stamped renders);
 * - a "conversation" link: the conversation's messages up to the row that was
 *   last when the owner pressed ({@link sharedConversationMessages} is the ONE
 *   place that decides what of a message a recipient gets), its visible images,
 *   and — only when the owner said so — the avatar-delivered files in range.
 *   Nothing is copied: the link dies with the conversation or its anchor row;
 * - a "workspace_file" link: Noah's own COPY of one file of the owner's
 *   sandbox workspace, taken when they pressed (`shareFiles.ts`) — never the
 *   workspace path itself. To a recipient it is a file link.
 */

export interface ShareLinkDeps {
  config: AppConfig;
  store: Store;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a viewer-bound slide/download ticket stays valid (the viewer refreshes before it lapses). */
export const SHARE_TICKET_TTL_MS = SHARE_TICKET_TTL_MINUTES * 60 * 1000;

/**
 * `<linkId>~<expUnix>~<sig>`: a lowercase uuid, a unix time without leading
 * zeros (so the signed string round-trips exactly), a 43-char base64url MAC.
 */
const TICKET_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})~([1-9]\d{0,11})~([A-Za-z0-9_-]{43})$/;
/** A slide number in a ticket URL: 1-99, no leading zero, nothing else. */
const SLIDE_INDEX_RE = /^[1-9]\d?$/;

function hmac(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("base64url");
}

/**
 * A fresh per-row `token_salt` (16 random bytes, base64url). It lives ONLY in
 * the DB — never logged, never on the wire — and both the token and every
 * viewer ticket are MACed over it, so SESSION_SECRET plus a link id (which
 * ticket paths and audit details do log) is never enough to mint either.
 */
export function newShareTokenSalt(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * The link token: 32 bytes of HMAC over the link id and the row's salt,
 * base64url (43 chars — `SHARE_TOKEN_RE`). Deterministic, so the owner's list
 * can show the link again without storing it; a rotated SESSION_SECRET makes
 * the recomputed token miss the stored hash (the owner then sees `url: null`),
 * while recipients holding the old token keep working because they are looked
 * up by that hash.
 */
export function deriveShareToken(secret: string, linkId: string, tokenSalt: string): string {
  return hmac(secret, `noah-share-link:v2:${linkId}:${tokenSalt}`);
}

/** The row fields a viewer ticket is bound to (a `ShareLinkRecord` fits). */
export type ShareTicketLink = Pick<ShareLinkRecord, "id" | "tokenSalt">;

/** Sign a slide/download ticket for one viewer of one link row, valid until `expUnix` (seconds). */
export function signShareTicket(
  secret: string,
  link: ShareTicketLink,
  viewerUserId: string,
  expUnix: number,
): string {
  return `${link.id}~${expUnix}~${hmac(secret, `noah-share-ticket:v2:${link.id}:${link.tokenSalt}:${viewerUserId}:${expUnix}`)}`;
}

export function issueShareTicket(
  secret: string,
  link: ShareTicketLink,
  viewerUserId: string,
  nowMs = Date.now(),
): string {
  return signShareTicket(secret, link, viewerUserId, Math.floor((nowMs + SHARE_TICKET_TTL_MS) / 1000));
}

/**
 * The link id a ticket names when it parses strictly and is inside its
 * lifetime (unexpired, not issued further ahead than one TTL) — BEFORE its MAC
 * is checked: that needs the row's salt, so the caller loads the row by this
 * id, then calls {@link verifyShareTicket}.
 */
export function shareTicketLinkId(ticket: string, nowMs = Date.now()): string | null {
  const match = TICKET_RE.exec(ticket);
  if (!match) return null;
  const exp = Number(match[2]);
  const nowUnix = nowMs / 1000;
  return exp > nowUnix && exp <= nowUnix + SHARE_TICKET_TTL_MS / 1000 + 60 ? match[1] : null;
}

/**
 * Whether `ticket` grants THIS viewer the link row `link`: it names the row, is
 * inside its lifetime, and its MAC — recomputed over the row's id and salt and
 * the requesting user's id — matches in constant time. The caller still runs
 * the full link validity: a ticket never outlives a revocation.
 */
export function verifyShareTicket(
  secret: string,
  ticket: string,
  link: ShareTicketLink,
  viewerUserId: string,
  nowMs = Date.now(),
): boolean {
  if (shareTicketLinkId(ticket, nowMs) !== link.id) return false;
  const [, , expRaw, sig] = TICKET_RE.exec(ticket)!;
  const expected = Buffer.from(signShareTicket(secret, link, viewerUserId, Number(expRaw)).slice(-43));
  const presented = Buffer.from(sig);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

/**
 * The name a link stores and serves: sanitized, and ALWAYS ending in `.<ext>`
 * — the extension of the stored bytes — within the name cap. The bytes are
 * served as that type; a name that lost the extension (a cut of a card name
 * share_file had already extended) or never had it would make every recipient
 * save the file under another file type.
 */
export function shareDownloadName(name: string | undefined, ext: string): string {
  return withDownloadExtension(sanitizeDownloadName(name) ?? `file.${ext}`, ext);
}

/**
 * Whether `conversationId` is a thread whose files its owner may share by link
 * — checked at creation AND on every recipient call:
 * - the owner's own-avatar threads (external-task-API threads included): yes;
 * - a colleague's own thread with someone else's avatar: only while that
 *   avatar is still reachable for them (`resolveChatAvatar`: not suspended,
 *   still visible to them as a teammate) — a link must not outlive the reach
 *   the thread was built on;
 * - anything else: no.
 */
export function shareableThread(store: Store, ownerUserId: string, conversationId: string): boolean {
  if (store.conversationOwner(conversationId) !== ownerUserId) return false;
  const avatarId = store.getConversationAvatarId(ownerUserId, conversationId);
  if (!avatarId) return false;
  if (avatarId === ownerUserId) return true;
  // Every namespaced id (a retired external:/personal:/group: thread) fails
  // closed; user ids never contain a colon.
  if (avatarId.includes(":")) return false;
  return store.resolveChatAvatar(ownerUserId, avatarId) !== null;
}

/** The stored bytes a link serves: where they are, their media type and extension. */
export interface ShareableFile {
  path: string;
  mediaType: string;
  ext: string;
}

/**
 * The stored bytes of a file card, or null: gone, or not a type share_file
 * publishes (`isShareFileExtension` — so a screenshot card, a legacy Craft-app
 * card or a user-only attachment type is never served by a link, whatever a
 * row names).
 */
export function resolveShareableFile(
  config: AppConfig,
  conversationId: string,
  fileId: string,
): ShareableFile | null {
  const stored = resolveStoredFile(config, conversationId, fileId);
  return stored && isShareFileExtension(stored.ext) ? stored : null;
}

/**
 * The owner-facing shape of a row. `url` is recomputed from the id, and null
 * once the link expired or when the recomputed token misses the stored hash
 * (SESSION_SECRET changed) — an active link then still opens, but cannot be
 * shown again.
 */
export function toShareLinkSummary(
  secret: string,
  link: ShareLinkRecord,
  origin: string | null,
  nowMs = Date.now(),
): ShareLinkSummary {
  const expired = Date.parse(link.expiresAt) <= nowMs;
  let url: string | null = null;
  if (!expired) {
    const token = deriveShareToken(secret, link.id, link.tokenSalt);
    if (hashToken(token) === link.tokenHash) url = `${origin ?? ""}${shareLinkPath(token)}`;
  }
  return {
    id: link.id,
    kind: link.kind,
    conversationId: link.conversationId,
    conversationTitle: link.conversationTitle,
    fileId: link.fileId,
    fileName: link.fileName,
    sourcePath: link.kind === "workspace_file" ? link.sourcePath : "",
    messageCount: link.messageCount,
    includesFiles: link.kind === "conversation" && link.includeFiles,
    slideCount: link.slideIds.length,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    expired,
    viewCount: link.viewCount,
    lastViewedAt: link.lastViewedAt,
    url,
  };
}

export interface CreateShareLinkInput {
  ownerUserId: string;
  conversationId: string;
  /** A visible download card the avatar delivered (`isShareableFileCard`). */
  card: MessageAttachment;
  /**
   * The collection the card came from — its persisted message, or the running
   * turn's attachments. Slides are chosen from THIS list, strictly
   * (`shareSlideAttachments`).
   */
  attachments: readonly MessageAttachment[];
  expiresInDays: ShareLinkExpiryDays;
  /** Makes the returned url absolute (`requestOrigin` / the run's `appOrigin`). */
  origin: string | null;
}

export type CreateShareLinkOutcome =
  | { kind: "created" | "reused"; link: ShareLinkSummary }
  | { kind: "cap" }
  /** The thread cannot share, or the card is not a shareable file on disk. */
  | { kind: "unavailable" };

/**
 * Create a link for one card, or return the active one it already has
 * (`reused`). Re-checks the thread and the bytes itself, so neither caller can
 * mint a link its own pre-checks would have refused.
 */
export function createOrReuseShareLink(
  deps: ShareLinkDeps,
  input: CreateShareLinkInput,
  nowMs = Date.now(),
): CreateShareLinkOutcome {
  const { config, store } = deps;
  const file =
    isShareableFileCard(input.card) && shareableThread(store, input.ownerUserId, input.conversationId)
      ? resolveShareableFile(config, input.conversationId, input.card.id)
      : null;
  if (!file) {
    return { kind: "unavailable" };
  }
  const id = crypto.randomUUID();
  const tokenSalt = newShareTokenSalt();
  const result = store.createShareLink({
    id,
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
    fileId: input.card.id,
    fileName: shareDownloadName(input.card.name, file.ext),
    slideIds: shareSlideAttachments(input.attachments, input.card.id).map((slide) => slide.id),
    tokenHash: hashToken(deriveShareToken(config.sessionSecret, id, tokenSalt)),
    tokenSalt,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + input.expiresInDays * DAY_MS).toISOString(),
  });
  if (result.status === "cap") return { kind: "cap" };
  return { kind: result.status, link: toShareLinkSummary(config.sessionSecret, result.link, input.origin, nowMs) };
}

/** What a conversation link is named: the conversation's title when it was made (one line, capped). */
export const SHARE_CONVERSATION_FALLBACK_TITLE = "대화";
function shareConversationTitle(title: string | null): string {
  const cleaned = (title ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return Array.from(cleaned).slice(0, 200).join("") || SHARE_CONVERSATION_FALLBACK_TITLE;
}

export interface CreateConversationShareLinkInput {
  ownerUserId: string;
  conversationId: string;
  /** Let the link also download the files the avatar delivered in the shared range. */
  includeFiles: boolean;
  expiresInDays: ShareLinkExpiryDays;
  origin: string | null;
}

export type CreateConversationShareLinkOutcome =
  | { kind: "created" | "reused"; link: ShareLinkSummary }
  | { kind: "cap" }
  /** Not the owner's conversation, or a thread that cannot share. */
  | { kind: "unavailable" }
  /** Nothing is stored in the conversation yet. */
  | { kind: "empty" };

/**
 * Create a link to a conversation as it stands NOW — its anchor is the last
 * stored message, so nothing said later ever shows — or return the active one
 * it already has (`reused`, with the range and file choice it was made with:
 * changing either means revoke, then create). The caller refuses while a turn
 * is running (its rows are not stored yet).
 */
export function createOrReuseConversationShareLink(
  deps: ShareLinkDeps,
  input: CreateConversationShareLinkInput,
  nowMs = Date.now(),
): CreateConversationShareLinkOutcome {
  const { config, store } = deps;
  if (!shareableThread(store, input.ownerUserId, input.conversationId)) {
    return { kind: "unavailable" };
  }
  // A link whose anchor is gone is dead, not "active": never hand it back.
  store.deleteConversationShareLinksWithoutAnchor(input.conversationId);
  const throughMessageId = store.lastMessageId(input.ownerUserId, input.conversationId);
  if (!throughMessageId) {
    return { kind: "empty" };
  }
  const id = crypto.randomUUID();
  const tokenSalt = newShareTokenSalt();
  const result = store.createShareLink({
    id,
    kind: "conversation",
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
    fileId: "",
    fileName: shareConversationTitle(store.getConversationTitle(input.ownerUserId, input.conversationId)),
    slideIds: [],
    throughMessageId,
    includeFiles: input.includeFiles,
    tokenHash: hashToken(deriveShareToken(config.sessionSecret, id, tokenSalt)),
    tokenSalt,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + input.expiresInDays * DAY_MS).toISOString(),
  });
  if (result.status === "cap") return { kind: "cap" };
  return { kind: result.status, link: toShareLinkSummary(config.sessionSecret, result.link, input.origin, nowMs) };
}

export interface CreateWorkspaceShareLinkInput {
  ownerUserId: string;
  /** The file's path in the owner's own workspace, as parsed segments (`parseWorkspacePath`). */
  segments: readonly string[];
  expiresInDays: ShareLinkExpiryDays;
  origin: string | null;
}

export type CreateWorkspaceShareLinkOutcome =
  | { kind: "created" | "reused"; link: ShareLinkSummary }
  | { kind: "cap" }
  /** Why the file could not be shared (`readWorkspaceShareSource`), or the copy could not be written. */
  | { kind: "refused"; reason: WorkspaceShareRefusal };

/**
 * Share one file of the owner's OWN workspace: Noah copies its bytes as they
 * are now and the link serves that copy — or returns the active link this path
 * already has (`reused`: the copy taken THEN; a newer version means revoke,
 * then create). The row is written before the copy, so the sweep never sees a
 * copy without its row; a copy that cannot be written takes its row back.
 */
export function createOrReuseWorkspaceShareLink(
  deps: ShareLinkDeps,
  input: CreateWorkspaceShareLinkInput,
  nowMs = Date.now(),
): CreateWorkspaceShareLinkOutcome {
  const { config, store } = deps;
  const sourcePath = input.segments.join("/");
  const createdAt = new Date(nowMs).toISOString();
  // The listing below prunes rows: the copies of links that ended go first, so
  // an expired copy never waits for the owner to open their list.
  sweepShareLinkCopies(deps);
  // The cheap answers next: nothing is read for a link that already exists or cannot be made.
  const active = store
    .listShareLinks(input.ownerUserId, { kind: "workspace_file", sourcePath })
    .find((link) => Date.parse(link.expiresAt) > nowMs);
  if (active) {
    if (resolveShareFileCopy(config, active.id)) {
      return { kind: "reused", link: toShareLinkSummary(config.sessionSecret, active, input.origin, nowMs) };
    }
    // A live row whose copy is gone (a restored volume) opens for nobody: it is
    // not "the active link" — drop it and take the file again.
    store.deleteShareLinkRow(active.id);
  }
  if (store.countActiveShareLinks(input.ownerUserId, createdAt) >= MAX_ACTIVE_SHARE_LINKS) {
    return { kind: "cap" };
  }
  const source = readWorkspaceShareSource(config, input.ownerUserId, input.segments);
  if ("error" in source) return { kind: "refused", reason: source.error };

  const id = crypto.randomUUID();
  const tokenSalt = newShareTokenSalt();
  const result = store.createShareLink({
    id,
    kind: "workspace_file",
    ownerUserId: input.ownerUserId,
    conversationId: "",
    fileId: "",
    fileName: shareDownloadName(source.name, source.ext),
    slideIds: [],
    sourcePath,
    tokenHash: hashToken(deriveShareToken(config.sessionSecret, id, tokenSalt)),
    tokenSalt,
    createdAt,
    expiresAt: new Date(nowMs + input.expiresInDays * DAY_MS).toISOString(),
  });
  if (result.status === "cap") return { kind: "cap" };
  if (result.status === "created" && !writeShareFileCopy(config, id, source.ext, source.buffer)) {
    store.deleteShareLinkRow(id);
    return { kind: "refused", reason: "READ_FAILED" };
  }
  return { kind: result.status, link: toShareLinkSummary(config.sessionSecret, result.link, input.origin, nowMs) };
}

/**
 * Remove the copies of workspace-file links that are no longer live (revoked,
 * expired, pruned, or gone with their owner). Called wherever rows end: at boot,
 * after every owner listing, before a workspace-file link is made (both prune),
 * and after a deleted user; a revoke removes its own copy.
 */
export function sweepShareLinkCopies(deps: ShareLinkDeps): void {
  sweepShareFileCopies(deps.config, deps.store.listLiveWorkspaceShareLinkIds());
}

/** Revoke one of the owner's links (delete the row, and a workspace-file link's copy with it). */
export function revokeShareLink(deps: ShareLinkDeps, ownerUserId: string, id: string): ShareLinkRecord | null {
  const removed = deps.store.revokeShareLink(ownerUserId, id);
  if (removed?.kind === "workspace_file") removeShareFileCopy(deps.config, removed.id);
  return removed;
}

export function listShareLinkSummaries(
  deps: ShareLinkDeps,
  ownerUserId: string,
  filter: { conversationId?: string; fileId?: string; kind?: ShareLinkKind; sourcePath?: string },
  origin: string | null,
  nowMs = Date.now(),
): ShareLinkSummary[] {
  const links = deps.store
    .listShareLinks(ownerUserId, filter)
    .map((link) => toShareLinkSummary(deps.config.sessionSecret, link, origin, nowMs));
  // The listing pruned rows past their retention: their copies go with them.
  sweepShareLinkCopies(deps);
  return links;
}

/**
 * The owner's OTHER unexpired links in one conversation — every card but
 * `fileId`, newest first. A link never follows a rebuild (each share_file makes
 * a new card), so these keep serving the files they were made for; the avatar's
 * result names them (`ShareLinkResult.otherActiveLinks`). Names and expiry
 * only: another link's URL is a bearer credential.
 */
export function otherActiveShareLinks(
  store: Store,
  ownerUserId: string,
  conversationId: string,
  fileId: string,
  nowMs = Date.now(),
): { fileName: string; expiresAt: string }[] {
  return store
    .listShareLinks(ownerUserId, { conversationId, kind: "file" })
    .filter((link) => link.fileId !== fileId && Date.parse(link.expiresAt) > nowMs)
    .map((link) => ({ fileName: link.fileName, expiresAt: link.expiresAt }));
}

/** A link that passed the full validity, with what its kind serves. */
export type ValidShareLink =
  | { kind: "file"; link: ShareLinkLookup; file: ShareableFile }
  | { kind: "conversation"; link: ShareLinkLookup; throughMessageId: string };

/**
 * The full recipient validity, run on every recipient call: the row exists and
 * is unexpired, its creator is not suspended, the thread can still share
 * ({@link shareableThread}: still owned by the creator, a colleague's
 * avatar still reachable) and what the link exports is still there — a file
 * link's bytes are still a shareable file on disk; a conversation link's
 * anchor row is still in the conversation (a rewind that cut it away ends the
 * link); a workspace-file link's copy is still in Noah's copy store (it has no
 * thread to check). Null = the one 404 (`SHARE_LINK_GONE_MESSAGE`).
 */
export function validateShareLink(
  deps: ShareLinkDeps,
  link: ShareLinkLookup | null,
  nowMs = Date.now(),
): ValidShareLink | null {
  if (!link || Date.parse(link.expiresAt) <= nowMs || link.ownerSuspended) return null;
  if (link.kind === "workspace_file") {
    // No conversation behind it: the copy Noah took is all there is to check.
    const copy = resolveShareFileCopy(deps.config, link.id);
    return copy ? { kind: "file", link, file: copy } : null;
  }
  if (!shareableThread(deps.store, link.ownerUserId, link.conversationId)) return null;
  if (link.kind === "conversation") {
    // messageCount counts the rows at or before the anchor: 0 = the anchor is gone.
    return link.throughMessageId && link.messageCount > 0
      ? { kind: "conversation", link, throughMessageId: link.throughMessageId }
      : null;
  }
  const file = resolveShareableFile(deps.config, link.conversationId, link.fileId);
  return file ? { kind: "file", link, file } : null;
}

/**
 * Recipient alt text: `슬라이드 N – <title>` from a converter render's name
 * (already `슬라이드 N – <title>`, sanitized by deckPreview.ts), else
 * `슬라이드 N` (LibreOffice pages are named `slide-N.png`). N is the position.
 */
function slideAlt(index: number, name: string | undefined): string {
  const title = /^슬라이드 \d+ – (.+)$/u.exec(name ?? "")?.[1]?.trim();
  return title ? Array.from(`슬라이드 ${index} – ${title}`).slice(0, 200).join("") : `슬라이드 ${index}`;
}

/**
 * `POST /api/share/open`: the viewer payload for a token, or null (→ 404). The
 * token regex runs before any DB access. Counts the view unless the viewer is
 * the creator or the call is an open viewer's ticket `refresh`
 * (`ShareOpenRequest.refresh` — advisory, like the count itself), and mints ONE
 * fresh viewer-bound ticket for every slide and the download URL.
 */
export function openShareLink(
  deps: ShareLinkDeps,
  token: unknown,
  viewerUserId: string,
  { refresh = false }: { refresh?: boolean } = {},
  nowMs = Date.now(),
): ShareViewPayload | null {
  if (!isShareToken(token)) return null;
  const valid = validateShareLink(deps, deps.store.getShareLinkByTokenHash(hashToken(token)), nowMs);
  if (!valid) return null;
  const { link } = valid;
  if (!refresh && viewerUserId !== link.ownerUserId) deps.store.recordShareLinkView(link.id);
  const base = `/api/share/t/${issueShareTicket(deps.config.sessionSecret, link, viewerUserId, nowMs)}`;
  const provenance = {
    ownerName: link.ownerDisplayName,
    ownerUsername: link.ownerUsername,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
  };
  if (valid.kind === "conversation") {
    const messages = sharedConversationMessages(deps, valid, base);
    if (!messages) return null;
    const avatarId = deps.store.getConversationAvatarId(link.ownerUserId, link.conversationId);
    const avatar = avatarId ? deps.store.resolveChatAvatar(link.ownerUserId, avatarId) : null;
    return {
      kind: "conversation",
      fileName: link.fileName || SHARE_CONVERSATION_FALLBACK_TITLE,
      ...provenance,
      slides: [],
      downloadUrl: "",
      previewCapped: false,
      conversation: {
        conversationId: link.conversationId,
        imageBase: `${base}/images/`,
        avatarName: avatar ? avatar.alias || avatar.displayName : "",
        messages,
        includesFiles: link.includeFiles,
      },
    };
  }
  const { file } = valid;
  // Names ride the persisted card message; a link the avatar made mid-turn
  // (card not persisted yet) falls back to plain numbering until the turn ends.
  const names = new Map(
    (deps.store.findCardMessageAttachments(link.ownerUserId, link.conversationId, link.fileId) ?? []).map(
      (att) => [att.id, att.name] as const,
    ),
  );
  const slides = link.slideIds.map((slideId, offset) => ({
    index: offset + 1,
    url: `${base}/slides/${offset + 1}`,
    alt: slideAlt(offset + 1, names.get(slideId)),
  }));
  return {
    kind: "file",
    // Stored normalized already; re-applied so the viewer's download name
    // cannot lose the extension of the bytes served, whatever a row holds.
    fileName: shareDownloadName(link.fileName, file.ext),
    ...provenance,
    slides,
    downloadUrl: `${base}/download`,
    previewCapped: slides.length >= MAX_SHARE_LINK_SLIDES,
  };
}

/**
 * The valid link a ticket grants THIS viewer, or null: strict parse and
 * lifetime first, then the row by id (its salt is part of the MAC), the MAC,
 * and the full validity.
 */
export function resolveTicketLink(
  deps: ShareLinkDeps,
  ticket: string,
  viewerUserId: string,
  nowMs = Date.now(),
): ValidShareLink | null {
  const linkId = shareTicketLinkId(ticket, nowMs);
  const link = linkId ? deps.store.getShareLink(linkId) : null;
  if (!link || !verifyShareTicket(deps.config.sessionSecret, ticket, link, viewerUserId, nowMs)) return null;
  return validateShareLink(deps, link, nowMs);
}

/**
 * One slide of a valid link: the index is strict (`1`-`99`, no leading zero)
 * and bounded by the creation snapshot, and the render must still resolve —
 * only ids in `slide_ids_json` are ever servable.
 */
export function resolveShareSlide(
  config: AppConfig,
  valid: ValidShareLink,
  index: string,
): { path: string; mediaType: ImageMediaType } | null {
  if (!SLIDE_INDEX_RE.test(index)) return null;
  const slideId = valid.link.slideIds[Number(index) - 1];
  return slideId ? resolveStoredImage(config, valid.link.conversationId, slideId) : null;
}

// ---- A shared conversation: what a recipient gets of it -------------------

/** The address an answer's text uses for one of its conversation's images. */
function conversationImagePath(conversationId: string, imageId: string): string {
  return `/api/conversations/${conversationId}/images/${imageId}`;
}

/**
 * Whether a conversation link may serve image `att` of a message whose text is
 * `text`: every VISIBLE image; a HIDDEN one (published for URL use only) only
 * when that message's own text places it by its address (inline UI's
 * `<image>`). A deck card's slide renders are hidden and never placed, so a
 * link shared without its files does not show them either.
 */
function conversationImageShown(att: MessageAttachment, conversationId: string, text: string): boolean {
  if (att.kind !== "image") return false;
  return !att.hidden || text.includes(conversationImagePath(conversationId, att.id));
}

/** Whether a conversation link serves file card `att` as a download. */
function conversationFileServed(deps: ShareLinkDeps, link: ShareLinkLookup, att: MessageAttachment): ShareableFile | null {
  if (!link.includeFiles || !isShareableFileCard(att)) return null;
  return resolveShareableFile(deps.config, link.conversationId, att.id);
}

/** What a stored message shows as its text (the client's `messageText`). */
function shownText(message: StoredMessage): string {
  return message.role === "assistant"
    ? message.response?.text || message.response?.summary || message.content || ""
    : message.content || "";
}

/**
 * The messages a conversation link shows, as the recipient's viewer gets them
 * — THE one place that decides what of a stored message leaves the owner's
 * account: its text, when it was sent, who spoke, its visible images and its
 * visible file cards. NEVER `response` beyond the answer text (the tool
 * activity, the reasoning, a stored plan, run metadata), never a hidden
 * attachment, a team-brain card or a system row. A file card carries a
 * download `url` only when the owner shared the files AND it is one the avatar
 * delivered; a file the user attached is always a name. Null = the anchor row
 * is gone.
 */
export function sharedConversationMessages(
  deps: ShareLinkDeps,
  valid: Extract<ValidShareLink, { kind: "conversation" }>,
  ticketBase: string,
): ShareViewMessage[] | null {
  const { link } = valid;
  const stored = deps.store.listMessagesThrough(link.ownerUserId, link.conversationId, valid.throughMessageId);
  if (!stored) return null;
  const messages: ShareViewMessage[] = [];
  for (const message of stored) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = shownText(message);
    const attachments: ShareViewAttachment[] = [];
    for (const att of message.attachments ?? []) {
      if (!att || typeof att !== "object" || att.hidden) continue;
      const common = {
        id: att.id,
        name: att.name ?? "",
        mediaType: att.mediaType,
        ...(typeof att.anchor === "number" ? { anchor: att.anchor } : {}),
      };
      if (att.kind === "image") {
        attachments.push({
          ...common,
          kind: "image",
          ...(att.caption ? { caption: att.caption } : {}),
          ...(att.width && att.height ? { width: att.width, height: att.height } : {}),
          url: `${ticketBase}/images/${att.id}`,
        });
      } else if (att.kind === "file") {
        attachments.push({
          ...common,
          kind: "file",
          ...(typeof att.size === "number" ? { size: att.size } : {}),
          ...(conversationFileServed(deps, link, att) ? { url: `${ticketBase}/files/${att.id}` } : {}),
        });
      }
    }
    const consultation = message.role === "user" && message.kind === "consultation";
    messages.push({
      id: message.id,
      role: message.role,
      ...(message.role === "user" && message.kind === "steer" ? { kind: "steer" as const } : {}),
      ...(consultation
        ? {
            kind: "consultation" as const,
            speaker: message.consultation?.displayName || message.consultation?.username || "",
          }
        : {}),
      content: text,
      createdAt: message.createdAt,
      ...(message.role === "assistant" && message.response?.summary === "오류" ? { errored: true } : {}),
      attachments,
    });
  }
  return messages;
}

/**
 * One image of a valid CONVERSATION link, by attachment id: an image of a
 * message in the shared range that the conversation shows — visible, or a
 * hidden one that a message IN THE RANGE places by its address (usually the
 * message that published it; a later answer may place an image an earlier
 * turn published, and that text is shared too) — still on disk.
 */
export function resolveShareConversationImage(
  deps: ShareLinkDeps,
  valid: ValidShareLink,
  imageId: string,
): { path: string; mediaType: ImageMediaType } | null {
  if (valid.kind !== "conversation" || !SAFE_ID.test(imageId)) return null;
  const { link } = valid;
  const found = deps.store.findAttachmentThrough(link.conversationId, valid.throughMessageId, imageId);
  if (!found || found.attachment.kind !== "image") return null;
  if (!conversationImageShown(found.attachment, link.conversationId, found.text)) {
    // Hidden and not placed by its own message: placed by another one in the range?
    const address = conversationImagePath(link.conversationId, imageId);
    const placed = (deps.store.listMessagesThrough(link.ownerUserId, link.conversationId, valid.throughMessageId) ?? []).some(
      (message) => message.role === "assistant" && shownText(message).includes(address),
    );
    if (!placed) return null;
  }
  return resolveStoredImage(deps.config, link.conversationId, imageId);
}

/**
 * One file of a valid CONVERSATION link, by attachment id: an avatar-delivered
 * card of a message in the shared range, only on a link shared WITH its files,
 * still a shareable file on disk. `name` ends in the extension of the bytes.
 */
export function resolveShareConversationFile(
  deps: ShareLinkDeps,
  valid: ValidShareLink,
  fileId: string,
): { file: ShareableFile; name: string } | null {
  if (valid.kind !== "conversation" || !SAFE_ID.test(fileId)) return null;
  const { link } = valid;
  const found = deps.store.findAttachmentThrough(link.conversationId, valid.throughMessageId, fileId);
  if (!found || found.attachment.kind !== "file" || found.attachment.hidden) return null;
  const file = conversationFileServed(deps, link, found.attachment);
  return file ? { file, name: shareDownloadName(found.attachment.name, file.ext) } : null;
}

// ---- The avatar's path (create_share_link → the chat route's onShareLink) ----
// Model-facing English, like every other tool result.

/** Reuse of an active link whose token can no longer be recomputed (SESSION_SECRET changed). */
export const SHARE_LINK_UNSHOWABLE_ERROR =
  "An active link for this file exists but can no longer be shown; ask the user to revoke it (내 아바타 → 권한·연결 → 공유 링크), then create a new one.";
export const SHARE_LINK_CAP_ERROR = `The user already has the maximum of ${MAX_ACTIVE_SHARE_LINKS} active share links. Ask them to revoke links they no longer need (내 아바타 → 권한·연결 → 공유 링크), then try again.`;
export const SHARE_LINK_UNAVAILABLE_ERROR =
  "Share links cannot be created in this run; if the user wants a link other people can open, point them to the 공유 링크 button next to the file's card.";

export interface ShareCardChoice {
  card: MessageAttachment;
  /** The batch the card was found in — slides are selected from it. */
  attachments: readonly MessageAttachment[];
}

/** Up to ten shareable files, newest first, deduplicated — the menu an error hands the model. */
function fileMenu(batches: readonly (readonly MessageAttachment[])[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const batch of batches) {
    for (const att of [...batch].reverse()) {
      if (!isShareableFileCard(att) || seen.has(att.id)) continue;
      seen.add(att.id);
      lines.push(`- "${att.name ?? "file"}" (attachment id: ${att.id})`);
    }
  }
  return lines.slice(0, 10).join("\n");
}

/**
 * The file card a `create_share_link` call means. `batches` run NEWEST first:
 * the running turn's attachments, then each persisted message's. With
 * `attachmentId`, the first batch holding that `kind:"file"` card wins (this
 * turn first); it must be a card a link may export (`isShareableFileCard`).
 * Without it, the most recent batch that holds any such card decides: one file
 * (however many times re-shared in it) → its latest card; several different
 * files → an error listing them, so the model asks or picks by name instead of
 * guessing.
 */
export function pickShareLinkCard(
  batches: readonly (readonly MessageAttachment[])[],
  attachmentId?: string,
): ShareCardChoice | { error: string } {
  const menu = fileMenu(batches);
  const menuTail = menu ? `\nFiles in this conversation a link can be made for:\n${menu}` : "";
  if (attachmentId !== undefined) {
    if (!SAFE_ID.test(attachmentId)) {
      return {
        error: `attachmentId is not a valid attachment id. Pass the id share_file reported, or omit it to use the conversation's most recent shared file.${menuTail}`,
      };
    }
    for (const batch of batches) {
      const card = batch.find((att) => att.id === attachmentId && att.kind === "file");
      if (!card) continue;
      if (!isShareableFileCard(card)) {
        return {
          error: `Share links can only be created for files you delivered with share_file, and "${card.name ?? attachmentId}" is not one (a file the user attached and a screenshot card cannot be linked).${menuTail}`,
        };
      }
      return { card, attachments: batch };
    }
    return { error: `No file card with attachment id ${attachmentId} exists in this conversation.${menuTail}` };
  }
  for (const batch of batches) {
    const files = batch.filter((att) => isShareableFileCard(att));
    if (files.length === 0) continue;
    if (new Set(files.map((file) => file.name ?? file.id)).size > 1) {
      return {
        error: `Several different files were shared most recently; pass attachmentId for the one the user means (ask them if it is unclear).\n${fileMenu([batch])}`,
      };
    }
    return { card: files[files.length - 1], attachments: batch };
  }
  return {
    error:
      "This conversation has no file a link can be made for yet. Deliver the file with share_file first, then create the link.",
  };
}
