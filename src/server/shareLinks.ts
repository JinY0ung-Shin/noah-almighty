import crypto from "node:crypto";
import { hashToken } from "./auth.js";
import { resolveStoredFile, sanitizeDownloadName, withDownloadExtension } from "./chatFiles.js";
import { resolveStoredImage, SAFE_ID } from "./chatImages.js";
import { GROUP_AGENT_AVATAR_PREFIX } from "./groupAgents.js";
import { parsePersonalAgentRef } from "./personalAgents.js";
import type { Store } from "./store.js";
import type { ShareLinkLookup, ShareLinkRecord } from "./store/shareLinks.js";
import type { AppConfig, ImageMediaType, MessageAttachment } from "./types.js";
import {
  isPptxCard,
  isShareToken,
  MAX_ACTIVE_SHARE_LINKS,
  MAX_SHARE_LINK_SLIDES,
  SHARE_TICKET_TTL_MINUTES,
  shareLinkPath,
  shareSlideAttachments,
  type ShareLinkExpiryDays,
  type ShareLinkSummary,
  type ShareViewPayload,
} from "../shared/shareLinks.js";

/**
 * PPT share links — the ONE service behind both creation paths (the share
 * router's owner routes and the chat route's `onShareLink` host callback) and
 * every recipient call, so they cannot drift on:
 * - token + viewer-ticket derivation (HMAC under SESSION_SECRET over the link
 *   id AND the row's random salt; only the token's SHA-256 is stored, and
 *   re-display recomputes it — no scrypt here);
 * - the name a link stores and serves (always a `.pptx`: {@link shareDownloadName});
 * - which threads may share at all ({@link shareableThread});
 * - create-or-reuse (one active link per owner/conversation/file);
 * - recipient validity, re-run on EVERY call so revocation is immediate.
 *
 * A link is NOT a trust source: it never touches `isTrustedFor`, avatar
 * visibility or tool access — it authorises reading ONE card's bytes, a
 * human-initiated export equivalent to download-and-forward.
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
 * The name a link stores and serves: sanitized, and ALWAYS ending in `.pptx`
 * within the name cap. The bytes are served as a PPTX; a name that lost the
 * extension (a cut of a card name share_file had already extended) or never had
 * it would make every recipient save the deck under another file type.
 */
export function shareDownloadName(name: string | undefined): string {
  return withDownloadExtension(sanitizeDownloadName(name) ?? "file.pptx", "pptx");
}

/**
 * Whether `conversationId` is a thread whose decks its owner may share by link
 * — checked at creation AND on every recipient call:
 * - the owner's own-avatar threads (external-task-API threads included) and
 *   their own bots' threads: yes;
 * - group-agent member threads: NO (phase 1 — member threads are private and
 *   the team shares through the group second brain);
 * - a colleague's own thread with someone else's avatar: only while that
 *   avatar is still reachable for them (`resolveChatAvatar`: not suspended,
 *   still visible through a shared group) — a link must not outlive the reach
 *   the thread was built on;
 * - anything else (external avatars carry no file cards): no.
 */
export function shareableThread(store: Store, ownerUserId: string, conversationId: string): boolean {
  if (store.conversationOwner(conversationId) !== ownerUserId) return false;
  const avatarId = store.getConversationAvatarId(ownerUserId, conversationId);
  if (!avatarId) return false;
  if (avatarId === ownerUserId) return true;
  if (avatarId.startsWith(GROUP_AGENT_AVATAR_PREFIX)) return false;
  const bot = parsePersonalAgentRef(avatarId);
  if (bot) return bot.ownerUserId === ownerUserId;
  // Every other namespaced id (external:, malformed personal:/group:) fails
  // closed; user ids never contain a colon.
  if (avatarId.includes(":")) return false;
  return store.resolveChatAvatar(ownerUserId, avatarId) !== null;
}

/** The stored bytes of a PPTX card, or null (gone, or not a .pptx on disk). */
export function resolveShareableDeck(
  config: AppConfig,
  conversationId: string,
  fileId: string,
): { path: string; mediaType: string; ext: string } | null {
  const stored = resolveStoredFile(config, conversationId, fileId);
  return stored?.ext === "pptx" ? stored : null;
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
    conversationId: link.conversationId,
    conversationTitle: link.conversationTitle,
    fileId: link.fileId,
    fileName: link.fileName,
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
  /** A visible PPTX download card (`isPptxCard`). */
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
  /** The thread cannot share, or the card is not a PPTX deck on disk. */
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
  if (
    !isPptxCard(input.card) ||
    !shareableThread(store, input.ownerUserId, input.conversationId) ||
    !resolveShareableDeck(config, input.conversationId, input.card.id)
  ) {
    return { kind: "unavailable" };
  }
  const id = crypto.randomUUID();
  const tokenSalt = newShareTokenSalt();
  const result = store.createShareLink({
    id,
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
    fileId: input.card.id,
    fileName: shareDownloadName(input.card.name),
    slideIds: shareSlideAttachments(input.attachments, input.card.id).map((slide) => slide.id),
    tokenHash: hashToken(deriveShareToken(config.sessionSecret, id, tokenSalt)),
    tokenSalt,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + input.expiresInDays * DAY_MS).toISOString(),
  });
  if (result.status === "cap") return { kind: "cap" };
  return { kind: result.status, link: toShareLinkSummary(config.sessionSecret, result.link, input.origin, nowMs) };
}

export function listShareLinkSummaries(
  deps: ShareLinkDeps,
  ownerUserId: string,
  filter: { conversationId?: string; fileId?: string },
  origin: string | null,
  nowMs = Date.now(),
): ShareLinkSummary[] {
  return deps.store
    .listShareLinks(ownerUserId, filter)
    .map((link) => toShareLinkSummary(deps.config.sessionSecret, link, origin, nowMs));
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
    .listShareLinks(ownerUserId, { conversationId })
    .filter((link) => link.fileId !== fileId && Date.parse(link.expiresAt) > nowMs)
    .map((link) => ({ fileName: link.fileName, expiresAt: link.expiresAt }));
}

export interface ValidShareLink {
  link: ShareLinkLookup;
  deck: { path: string; mediaType: string; ext: string };
}

/**
 * The full recipient validity, run on every recipient call: the row exists and
 * is unexpired, its creator is not suspended, the thread can still share
 * ({@link shareableThread}: still owned by the creator, not a group-agent
 * thread, a colleague's avatar still reachable) and the card's bytes are still
 * a .pptx on disk. Null = the one 404 (`SHARE_LINK_GONE_MESSAGE`).
 */
export function validateShareLink(
  deps: ShareLinkDeps,
  link: ShareLinkLookup | null,
  nowMs = Date.now(),
): ValidShareLink | null {
  if (!link || Date.parse(link.expiresAt) <= nowMs || link.ownerSuspended) return null;
  if (!shareableThread(deps.store, link.ownerUserId, link.conversationId)) return null;
  const deck = resolveShareableDeck(deps.config, link.conversationId, link.fileId);
  return deck ? { link, deck } : null;
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
    // Stored normalized already; re-applied so the viewer's download name
    // cannot lose `.pptx` whatever a row holds.
    fileName: shareDownloadName(link.fileName),
    ownerName: link.ownerDisplayName,
    ownerUsername: link.ownerUsername,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
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

// ---- The avatar's path (create_share_link → the chat route's onShareLink) ----
// Model-facing English, like every other tool result.

/**
 * A background / wake-up segment that no message from the user started (a task
 * settled): nobody may be watching. A segment driven by the owner's own
 * mid-turn message is allowed (the chat route's `ownerSteeredSinceBoundary`).
 */
export const SHARE_LINK_UNWATCHED_ERROR =
  "No message from the user started this background segment, so they may not be watching; tell them to use the 공유 링크 button next to the deck's file card, or to ask you for the link again.";
/** Reuse of an active link whose token can no longer be recomputed (SESSION_SECRET changed). */
export const SHARE_LINK_UNSHOWABLE_ERROR =
  "An active link for this deck exists but can no longer be shown; ask the user to revoke it (내 아바타 → 권한·연결 → 공유 링크), then create a new one.";
export const SHARE_LINK_CAP_ERROR = `The user already has the maximum of ${MAX_ACTIVE_SHARE_LINKS} active share links. Ask them to revoke links they no longer need (내 아바타 → 권한·연결 → 공유 링크), then try again.`;
export const SHARE_LINK_UNAVAILABLE_ERROR =
  "Share links cannot be created in this run; if the user wants a link other people can open, point them to the 공유 링크 button next to the deck's file card.";

export interface ShareCardChoice {
  card: MessageAttachment;
  /** The batch the card was found in — slides are selected from it. */
  attachments: readonly MessageAttachment[];
}

/** Up to ten decks, newest first, deduplicated — the menu an error hands the model. */
function deckMenu(batches: readonly (readonly MessageAttachment[])[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const batch of batches) {
    for (const att of [...batch].reverse()) {
      if (!isPptxCard(att) || seen.has(att.id)) continue;
      seen.add(att.id);
      lines.push(`- "${att.name ?? "deck.pptx"}" (attachment id: ${att.id})`);
    }
  }
  return lines.slice(0, 10).join("\n");
}

/**
 * The PPTX card a `create_share_link` call means. `batches` run NEWEST first:
 * the running turn's attachments, then each persisted message's. With
 * `attachmentId`, the first batch holding that `kind:"file"` card wins (this
 * turn first); it must be a visible PPTX card. Without it, the most recent
 * batch that holds any deck decides: one deck (however many times re-shared
 * in it) → its latest card; several different decks → an error listing them,
 * so the model asks or picks by name instead of guessing.
 */
export function pickShareLinkCard(
  batches: readonly (readonly MessageAttachment[])[],
  attachmentId?: string,
): ShareCardChoice | { error: string } {
  const menu = deckMenu(batches);
  const menuTail = menu ? `\nDecks in this conversation:\n${menu}` : "";
  if (attachmentId !== undefined) {
    if (!SAFE_ID.test(attachmentId)) {
      return {
        error: `attachmentId is not a valid attachment id. Pass the id share_file reported, or omit it to use the conversation's most recent deck.${menuTail}`,
      };
    }
    for (const batch of batches) {
      const card = batch.find((att) => att.id === attachmentId && att.kind === "file");
      if (!card) continue;
      if (!isPptxCard(card)) {
        return {
          error: `Share links can only be created for PPTX decks, and "${card.name ?? attachmentId}" is not one.${menuTail}`,
        };
      }
      return { card, attachments: batch };
    }
    return { error: `No file card with attachment id ${attachmentId} exists in this conversation.${menuTail}` };
  }
  for (const batch of batches) {
    const decks = batch.filter((att) => isPptxCard(att));
    if (decks.length === 0) continue;
    if (new Set(decks.map((deck) => deck.name ?? deck.id)).size > 1) {
      return {
        error: `Several different decks were shared most recently; pass attachmentId for the one the user means (ask them if it is unclear).\n${deckMenu([batch])}`,
      };
    }
    return { card: decks[decks.length - 1], attachments: batch };
  }
  return {
    error:
      "This conversation has no PPTX deck to share yet. Build the deck and deliver it with share_file first, then create the link.",
  };
}
