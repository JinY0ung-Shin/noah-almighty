// Share links: a login-required, expiring, revocable link to ONE generated PPTX
// deck — a chat download card plus the slide renders stamped with its id. This
// module is the contract the server routes, the client (dialog, settings list,
// viewer) and the avatar's `create_share_link` tool share. Import-free leaf: it
// is bundled into the browser, so it must not import anything.

/** Expiry choices offered when a link is created (days). */
export const SHARE_LINK_EXPIRY_DAYS = [1, 7, 30] as const;
export type ShareLinkExpiryDays = (typeof SHARE_LINK_EXPIRY_DAYS)[number];
export const DEFAULT_SHARE_LINK_EXPIRY_DAYS: ShareLinkExpiryDays = 7;

/** Active (unexpired) links one user may hold at once. */
export const MAX_ACTIVE_SHARE_LINKS = 50;
/** An expired link stays in the owner's list this long (so they see what lapsed), then is pruned. */
export const EXPIRED_SHARE_LINK_RETENTION_DAYS = 30;
/** Slide renders one link shows at most (the server's preview cap). */
export const MAX_SHARE_LINK_SLIDES = 30;
/**
 * Lifetime of the viewer-bound ticket in a slide/download URL. The server signs
 * tickets for this long; the viewer re-opens the link for fresh ones a few
 * minutes before it runs out — one constant, so the two cannot drift apart.
 */
export const SHARE_TICKET_TTL_MINUTES = 30;

/**
 * A link token is 32 bytes in base64url (43 characters, URL-safe, dot-free),
 * derived server-side as an HMAC of the link id and a per-link random salt —
 * only its hash is stored.
 */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** One message shared by the server's 404 and the viewer's dead-link state. */
export const SHARE_LINK_GONE_MESSAGE = "공유 링크가 만료되었거나 삭제되었습니다.";

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_RE.test(value);
}

export function isShareLinkExpiryDays(value: unknown): value is ShareLinkExpiryDays {
  return (SHARE_LINK_EXPIRY_DAYS as readonly unknown[]).includes(value);
}

/**
 * The link a recipient opens, relative to the app origin. The token rides in
 * the URL FRAGMENT, which browsers never send to a server — it stays out of
 * proxy access logs and Referer headers, and the hash route survives the login
 * screen. The viewer then posts the token in a request BODY.
 */
export function shareLinkPath(token: string): string {
  return `/${shareHashRoute(token)}`;
}

/** The SPA route of the viewer. */
export function shareHashRoute(token: string): string {
  return `#/share/${token}`;
}

/** A visible PPTX download card (never a hidden render, never a screenshot card). */
export function isPptxCard(att: { kind: string; mediaType: string; hidden?: boolean }): boolean {
  return att.kind === "file" && !att.hidden && att.mediaType === PPTX_MEDIA_TYPE;
}

/** What the owner sees for one of their links (settings list, the file card's dialog). */
export interface ShareLinkSummary {
  id: string;
  conversationId: string;
  /** The conversation's title at list time (null when it has none) — where the deck came from. */
  conversationTitle: string | null;
  fileId: string;
  fileName: string;
  /** Slide renders the link shows (0 = download-only: the deck had no stamped previews). */
  slideCount: number;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  /**
   * The link ({@link shareLinkPath}; absolute when the server knew its origin),
   * or null when it can no longer be shown again (expired, or the server secret
   * changed) — an active one still opens for recipients; to send it again the
   * owner revokes it and creates a new one.
   */
  url: string | null;
}

/** `POST …/share-links`: `created` is false when an active link for that file already existed. */
export interface ShareLinkCreateResult {
  link: ShareLinkSummary;
  created: boolean;
}

export interface ShareViewSlide {
  /** 1-based slide number. */
  index: number;
  /** Same-origin URL of the render, bound to the viewer for a short time. */
  url: string;
  /** Korean alt text, e.g. "슬라이드 3 – 매출 추이". */
  alt: string;
}

/** The body of `POST /api/share/open` — the token rides here, never in a URL. */
export interface ShareOpenRequest {
  token: string;
  /**
   * True when an ALREADY-OPEN viewer re-opens the link only for fresh tickets
   * (they last {@link SHARE_TICKET_TTL_MINUTES}): the owner's view count counts
   * people opening the link, not a long-open page renewing its tickets.
   */
  refresh?: boolean;
}

/** What a signed-in recipient's viewer receives for a valid link (`POST /api/share/open`). */
export interface ShareViewPayload {
  fileName: string;
  /** Display name of the person who created the link. */
  ownerName: string;
  /** Their username (display names are free text; the username is the stable handle). */
  ownerUsername: string;
  createdAt: string;
  expiresAt: string;
  /** Empty = download-only (the deck had no stamped previews). */
  slides: ShareViewSlide[];
  /** Same-origin download URL of the .pptx, bound to the viewer for a short time. */
  downloadUrl: string;
  /** Previews are capped at {@link MAX_SHARE_LINK_SLIDES}; true when the cap was reached. */
  previewCapped: boolean;
}

/**
 * The slide renders a SHARE LINK may serve: hidden images stamped with this
 * card's id, and nothing else. Unstamped hidden images (canvas embeds, review
 * renders, legacy previews) are never shared — a legacy deck gets a
 * download-only link.
 */
export function shareSlideAttachments<
  T extends { kind: string; hidden?: boolean; parentId?: string },
>(attachments: readonly T[] | undefined, cardId: string): T[] {
  return (attachments ?? [])
    .filter((att) => att.kind === "image" && Boolean(att.hidden) && att.parentId === cardId)
    .slice(0, MAX_SHARE_LINK_SLIDES);
}

/**
 * The slide renders the OWNER's file-preview panel shows for a card: the
 * renders stamped with its id when there are any; otherwise (messages from
 * before `parentId` existed) every unstamped hidden image of the message.
 */
export function cardSlideAttachments<
  T extends { kind: string; hidden?: boolean; parentId?: string },
>(attachments: readonly T[] | undefined, cardId: string): T[] {
  const hidden = (attachments ?? []).filter((att) => att.kind === "image" && Boolean(att.hidden));
  const stamped = hidden.filter((att) => att.parentId === cardId);
  return stamped.length > 0 ? stamped : hidden.filter((att) => !att.parentId);
}
