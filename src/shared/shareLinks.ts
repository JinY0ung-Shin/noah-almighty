// Share links: a login-required, expiring, revocable link to ONE thing its
// owner chose to export:
// - "file": a file the avatar delivered — a chat download card (any type
//   share_file publishes); a PPTX deck also shows the slide renders stamped
//   with its id;
// - "conversation": a conversation, READ-ONLY, up to the last message stored
//   when the link was made (later messages never show) — the text of both
//   sides and the visible images; never the tool activity, the reasoning, a
//   file the user attached, or anything hidden. The avatar-delivered file
//   cards in that range are downloadable only when the owner said so.
// - "workspace_file": a file of the owner's own sandbox workspace, shared from
//   the chat's 파일 tab — a COPY Noah took at that moment (a workspace file
//   keeps changing; the link never does). To whoever opens it, it is a file.
// This module is the contract the server routes, the client (dialog, settings list,
// viewer) and the avatar's `create_share_link` tool share. Import-free leaf: it
// is bundled into the browser, so it must not import anything.

/** What a link exports. */
export const SHARE_LINK_KINDS = ["file", "conversation", "workspace_file"] as const;
export type ShareLinkKind = (typeof SHARE_LINK_KINDS)[number];

export function isShareLinkKind(value: unknown): value is ShareLinkKind {
  return (SHARE_LINK_KINDS as readonly unknown[]).includes(value);
}

/**
 * The file types a link serves — what share_file publishes, minus an HTML page
 * ({@link HTML_MEDIA_TYPE}). The server keeps the table (`chatFiles.ts`
 * FILE_TYPES / `LINK_SHAREABLE_EXTENSIONS`; a test holds the two equal). The
 * 파일 tab offers 공유 링크 only for these.
 */
export const SHAREABLE_FILE_EXTENSIONS = ["pptx", "docx", "xlsx", "zip", "pdf", "csv", "md", "txt", "drawio"] as const;

/** Whether a file of this name is a type a link serves (by its extension, any case). */
export function isShareableFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && (SHAREABLE_FILE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

/**
 * The workspace folder pi writes a user's ATTACHED documents into
 * (`/workspace/uploads/<name>`, `src/shared/chatDocuments.ts`). A link never
 * exports what the user sent in — the same rule as an `uploaded` card — so
 * nothing below it is shareable from the 파일 tab.
 */
export const WORKSPACE_UPLOADS_FOLDER = "uploads";

/**
 * Whether the 파일 tab may offer 공유 링크 for the file at `path` (its own
 * path grammar: plain segments joined by "/"): a type a link serves, and not a
 * document the user attached. The server applies the same rule.
 */
export function isShareableWorkspacePath(path: string): boolean {
  const segments = path.split("/");
  return segments[0] !== WORKSPACE_UPLOADS_FOLDER && isShareableFileName(segments[segments.length - 1] ?? "");
}

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

/**
 * A page the avatar delivered as a `.html` file (share_file). Its owner reads
 * it in the chat's 파일 tab, drawn script-less in a sandboxed frame. It is the
 * one share_file type a link NEVER exports: a link hands the recipient the
 * bytes as a download, and a downloaded page opens in their browser with its
 * scripts running — nothing the owner saw would tell them so.
 */
export const HTML_MEDIA_TYPE = "text/html";

/** Whether a card is an HTML page ({@link HTML_MEDIA_TYPE}). */
export function isHtmlCard(att: { kind?: string; mediaType?: string }): boolean {
  return att.kind === "file" && att.mediaType === HTML_MEDIA_TYPE;
}

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

/** The attachment fields the card rules read. */
export interface ShareCardLike {
  kind: string;
  mediaType: string;
  hidden?: boolean;
  uploaded?: boolean;
}

/**
 * A visible download card the AVATAR delivered with share_file — what a share
 * link may export. Never a hidden render, never a file the user attached to
 * their own message (`uploaded`, see `src/shared/chatDocuments.ts`: a link
 * exports what the avatar made, not something the user sent in — on a DRM
 * fleet that is a decrypted copy), and never an image card (a browser
 * screenshot the bridge auto-shared; share_file itself never makes one), and
 * never an HTML page ({@link HTML_MEDIA_TYPE}). The server additionally
 * requires the stored bytes to be a type a link serves.
 */
export function isShareableFileCard(att: ShareCardLike): boolean {
  // A stored row is not shape-checked: a card without a media type is not linkable, never a throw.
  return (
    att.kind === "file" &&
    !att.hidden &&
    !att.uploaded &&
    typeof att.mediaType === "string" &&
    !att.mediaType.startsWith("image/") &&
    att.mediaType !== HTML_MEDIA_TYPE
  );
}

/**
 * A shareable card that is a PPTX deck — the one kind whose link also shows
 * slide renders (and whose side-panel tab is the deck tab).
 */
export function isPptxCard(att: ShareCardLike): boolean {
  return isShareableFileCard(att) && att.mediaType === PPTX_MEDIA_TYPE;
}

/** What the owner sees for one of their links (settings list, the file card's dialog). */
export interface ShareLinkSummary {
  id: string;
  /** Absent on a response from before conversation links = "file". */
  kind: ShareLinkKind;
  /** "" on a workspace-file link (it belongs to no conversation). */
  conversationId: string;
  /** The conversation's title at list time (null when it has none) — where the file came from. */
  conversationTitle: string | null;
  /** The card's id; "" on a conversation or workspace-file link. */
  fileId: string;
  /** Workspace-file links: where the file sat in the owner's workspace when the copy was taken ("" otherwise). */
  sourcePath: string;
  /** The file's name; on a conversation link the conversation's title when the link was made. */
  fileName: string;
  /** Conversation links: messages (both sides) the link shows now. 0 on a file link. */
  messageCount: number;
  /** Conversation links: whether the files the avatar delivered in that range can be downloaded. */
  includesFiles: boolean;
  /** Slide renders the link shows (0 = download-only: not a deck, or a deck with no stamped previews). */
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

/** `POST …/share-links`: `created` is false when an active link for that target already existed. */
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

/** One attachment of a shared conversation's message, as the recipient's viewer draws it. */
export interface ShareViewAttachment {
  id: string;
  /** A visible image, or a file card. Nothing else is ever sent. */
  kind: "image" | "file";
  name: string;
  mediaType: string;
  /** File cards: size in bytes. */
  size?: number;
  caption?: string;
  /** Images: the stored pixel size (a layout hint). */
  width?: number;
  height?: number;
  /** Offset into the message text where the card sits; absent = after the text. */
  anchor?: number;
  /**
   * Same-origin URL bound to the viewer for a short time: the image, or the
   * file's download. Absent on a file the link does not serve — a file the
   * user attached, a screenshot card, or any file when the owner shared the
   * conversation without its files: the card then shows the name only.
   */
  url?: string;
}

/** One message of a shared conversation. */
export interface ShareViewMessage {
  id: string;
  role: "user" | "assistant";
  /** "steer": sent while the avatar was answering. "consultation": a teammate avatar's answer (`speaker`). */
  kind?: "steer" | "consultation";
  /** Consultation rows: the consulted avatar's display name. */
  speaker?: string;
  /** The message text — an answer's Markdown (inline UI tags included), a user's plain text. */
  content: string;
  createdAt: string;
  /** True when the answer is a stored run error. */
  errored?: boolean;
  attachments: ShareViewAttachment[];
}

/** The conversation a `kind: "conversation"` link shows. */
export interface ShareViewConversation {
  /**
   * The conversation's id — only so the viewer can tell which image addresses
   * in an answer's inline UI are this conversation's own (it re-points those to
   * the link's ticket URLs). It opens nothing: every conversation route is the
   * owner's alone.
   */
  conversationId: string;
  /**
   * `/api/share/t/<ticket>/images/` — an image of this conversation by its id,
   * for the images an answer's own text places (the server serves exactly
   * those, and the visible ones).
   */
  imageBase: string;
  /** Display name of the avatar that answered. */
  avatarName: string;
  messages: ShareViewMessage[];
  /** Whether the avatar-delivered files in range carry a download `url`. */
  includesFiles: boolean;
}

/**
 * What a signed-in recipient's viewer receives for a valid link
 * (`POST /api/share/open`). ONE flat shape for both kinds: a conversation link
 * fills `fileName` with the conversation's title, sends no slides and no
 * download, and adds `conversation`.
 */
export interface ShareViewPayload {
  /**
   * What the recipient is looking at: a file (a card's or a workspace copy's —
   * the same to them) or a conversation. Absent on a response from before
   * conversation links = "file".
   */
  kind: "file" | "conversation";
  /** The shared conversation — on a `kind: "conversation"` link only. */
  conversation?: ShareViewConversation;
  fileName: string;
  /** Display name of the person who created the link. */
  ownerName: string;
  /** Their username (display names are free text; the username is the stable handle). */
  ownerUsername: string;
  createdAt: string;
  expiresAt: string;
  /** Empty = download-only (not a deck, or a deck with no stamped previews). */
  slides: ShareViewSlide[];
  /** Same-origin download URL of the file, bound to the viewer for a short time. */
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

/** The document types the server renders page previews for (`deckRender.ts` `PREVIEWABLE_EXTENSIONS`). */
const PAGE_RENDER_MEDIA_TYPES: readonly string[] = [
  PPTX_MEDIA_TYPE,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
];

/**
 * Whether a card is of a kind that HAS renders of its own: a document the
 * server rasterizes into pages, or a screenshot card (its copy). A Markdown,
 * CSV, text, HTML, zip or draw.io card never has any — a hidden image in its
 * message is something else (an image the answer's text places by address).
 */
export function cardHasRenders(card: { mediaType?: string }): boolean {
  const type = typeof card.mediaType === "string" ? card.mediaType : "";
  return type.startsWith("image/") || PAGE_RENDER_MEDIA_TYPES.includes(type);
}

/**
 * The slide renders the OWNER's file-preview panel shows for a card: the
 * renders stamped with its id when there are any; otherwise (messages from
 * before `parentId` existed) every unstamped hidden image of the message —
 * only with `legacy`, which the caller sets for a card that can have renders
 * at all ({@link cardHasRenders}).
 */
export function cardSlideAttachments<
  T extends { kind: string; hidden?: boolean; parentId?: string },
>(attachments: readonly T[] | undefined, cardId: string, legacy = true): T[] {
  const hidden = (attachments ?? []).filter((att) => att.kind === "image" && Boolean(att.hidden));
  const stamped = hidden.filter((att) => att.parentId === cardId);
  if (stamped.length > 0) return stamped;
  return legacy ? hidden.filter((att) => !att.parentId) : [];
}
