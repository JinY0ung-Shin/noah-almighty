// Client side of share links (`src/shared/shareLinks.ts` is the contract):
// the recipient viewer's status-aware open call, the owner's list / create /
// revoke calls, and the display rules the link dialog, the settings list and
// the viewer share. No component code here, so tests/client-share-links.test.ts
// pins it directly.
import { api, ApiError } from "./api";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  isShareToken,
  SHARE_TICKET_TTL_MINUTES,
  type ShareOpenRequest,
  type ShareLinkCreateResult,
  type ShareLinkExpiryDays,
  type ShareLinkKind,
  type ShareLinkSummary,
  type ShareViewAttachment,
  type ShareViewConversation,
  type ShareViewMessage,
  type ShareViewPayload,
  type ShareViewSlide,
} from "../../../shared/shareLinks";

/** What opening a link came to: the file, a dead link, or a failure worth retrying. */
export type ShareOpenResult =
  | { status: "ok"; payload: ShareViewPayload }
  | { status: "gone" }
  | { status: "error"; message: string };

/**
 * `POST /api/share/open` — the token rides in the request BODY, never a URL,
 * and a malformed one never leaves the browser (a decoded hash arg could
 * otherwise steer the request anywhere). Only a 404 means the link is dead: a
 * timeout, a 5xx or a rate limit must not tell a recipient that a live link
 * expired, or they give up on it.
 */
export async function openShareLink(
  token: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ShareOpenResult> {
  if (!isShareToken(token)) return { status: "gone" };
  // `refresh`: an open viewer renewing its tickets, which the owner's view
  // count must not count as another open.
  const body: ShareOpenRequest = refresh ? { token, refresh: true } : { token };
  try {
    const payload = await api<ShareViewPayload>("/api/share/open", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: "ok", payload: sanitizeSharePayload(payload) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { status: "gone" };
    return { status: "error", message: (err as Error).message };
  }
}

const URL_BASE = "https://noah.invalid";

/**
 * A slide render or download the viewer may point at: a same-origin
 * `/api/share/…` path even AFTER normalization (so `/api/share/../me` or a
 * backslash trick cannot reach another API route).
 */
export function isShareAssetUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith("/api/share/")) return false;
  try {
    const parsed = new URL(url, URL_BASE);
    return parsed.origin === URL_BASE && parsed.pathname.startsWith("/api/share/");
  } catch {
    return false;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One attachment of a shared message: an image needs a share asset URL; a file may have none (name only). */
function sanitizeShareAttachment(raw: ShareViewAttachment | null | undefined): ShareViewAttachment | null {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const url = isShareAssetUrl(raw.url) ? raw.url : undefined;
  if (raw.kind !== "image" && raw.kind !== "file") return null;
  if (raw.kind === "image" && !url) return null;
  const width = optionalNumber(raw.width);
  const height = optionalNumber(raw.height);
  const anchor = optionalNumber(raw.anchor);
  const size = optionalNumber(raw.size);
  return {
    id: raw.id,
    kind: raw.kind,
    name: text(raw.name),
    mediaType: text(raw.mediaType),
    ...(size !== undefined ? { size } : {}),
    ...(text(raw.caption) ? { caption: text(raw.caption) } : {}),
    ...(width && height ? { width, height } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
    ...(url ? { url } : {}),
  };
}

function sanitizeShareMessage(raw: ShareViewMessage | null | undefined, position: number): ShareViewMessage | null {
  if (!raw || typeof raw !== "object" || (raw.role !== "user" && raw.role !== "assistant")) return null;
  const kind = raw.kind === "steer" || raw.kind === "consultation" ? raw.kind : undefined;
  return {
    id: text(raw.id) || `message-${position}`,
    role: raw.role,
    ...(kind ? { kind } : {}),
    ...(kind === "consultation" ? { speaker: text(raw.speaker) } : {}),
    content: text(raw.content),
    createdAt: text(raw.createdAt),
    ...(raw.errored === true ? { errored: true } : {}),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .map(sanitizeShareAttachment)
      .filter((att): att is ShareViewAttachment => att !== null),
  };
}

/** A shared conversation as the viewer uses it; null when the payload carries none. */
function sanitizeShareConversation(raw: ShareViewConversation | null | undefined): ShareViewConversation | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    conversationId: text(raw.conversationId),
    imageBase: isShareAssetUrl(raw.imageBase) ? raw.imageBase : "",
    avatarName: text(raw.avatarName),
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .map(sanitizeShareMessage)
      .filter((message): message is ShareViewMessage => message !== null),
    includesFiles: raw.includesFiles === true,
  };
}

/**
 * The payload as the viewer uses it: renders, images and downloads only from
 * share asset URLs (anything else is dropped), every display string coerced to
 * text. A file link's strings are the file author's (file name, slide titles)
 * and are rendered as plain text only. A conversation link's message text is
 * drawn by the chat's own renderer — the same sanitized Markdown and inline UI
 * interpreter the owner's transcript uses — never as raw HTML.
 */
export function sanitizeSharePayload(raw: ShareViewPayload | null | undefined): ShareViewPayload {
  const conversation = raw?.kind === "conversation" ? sanitizeShareConversation(raw.conversation) : null;
  if (conversation) {
    return {
      kind: "conversation",
      conversation,
      fileName: text(raw?.fileName) || "공유된 대화",
      ownerName: text(raw?.ownerName),
      ownerUsername: text(raw?.ownerUsername),
      createdAt: text(raw?.createdAt),
      expiresAt: text(raw?.expiresAt),
      slides: [],
      downloadUrl: "",
      previewCapped: false,
    };
  }
  const slides: ShareViewSlide[] = (Array.isArray(raw?.slides) ? raw.slides : [])
    .filter((slide) => slide && isShareAssetUrl(slide.url))
    .map((slide, position) => {
      const index = Number.isInteger(slide.index) && slide.index > 0 ? slide.index : position + 1;
      return { index, url: slide.url, alt: text(slide.alt) || `슬라이드 ${index}` };
    });
  const downloadUrl = raw?.downloadUrl;
  return {
    kind: "file",
    fileName: text(raw?.fileName) || "공유된 파일",
    ownerName: text(raw?.ownerName),
    ownerUsername: text(raw?.ownerUsername),
    createdAt: text(raw?.createdAt),
    expiresAt: text(raw?.expiresAt),
    slides,
    downloadUrl: isShareAssetUrl(downloadUrl) ? downloadUrl : "",
    previewCapped: Boolean(raw?.previewCapped),
  };
}

/**
 * The render/download URLs carry a viewer-bound ticket the server honours for
 * SHARE_TICKET_TTL_MINUTES (30). A viewer left open longer re-opens the link
 * before presenting, downloading or retrying a render — five minutes early, so
 * a click never races the expiry.
 */
export const SHARE_TICKET_REFRESH_MS = (SHARE_TICKET_TTL_MINUTES - 5) * 60 * 1000;

/** How soon an open conversation tries again after a ticket renewal that failed (a network blip). */
export const SHARE_TICKET_RETRY_MS = 30 * 1000;

export function shareTicketsStale(loadedAt: number, now: number = Date.now()): boolean {
  return now - loadedAt >= SHARE_TICKET_REFRESH_MS;
}

/** What a link dialog is about: one file card, the conversation itself, or a file of the viewer's workspace. */
export type ShareLinkFilter =
  | { conversationId: string; fileId: string }
  | { conversationId: string; kind: "conversation" }
  | { kind: "workspace_file"; sourcePath: string };

/** A summary from any server version: a row without `kind` is a file link. */
function normalizeShareLink(link: ShareLinkSummary): ShareLinkSummary {
  const kind: ShareLinkKind = link.kind === "conversation" || link.kind === "workspace_file" ? link.kind : "file";
  return {
    ...link,
    kind,
    sourcePath: typeof link.sourcePath === "string" ? link.sourcePath : "",
    messageCount: typeof link.messageCount === "number" ? link.messageCount : 0,
    includesFiles: link.includesFiles === true,
  };
}

function shareLinkQuery(filter: ShareLinkFilter): Record<string, string> {
  if ("sourcePath" in filter) return { kind: filter.kind, path: filter.sourcePath };
  return "fileId" in filter
    ? { conversationId: filter.conversationId, fileId: filter.fileId }
    : { conversationId: filter.conversationId, kind: filter.kind };
}

/** `GET /api/me/share-links` — the owner's links, active first, newest first. */
export async function listShareLinks(filter?: ShareLinkFilter): Promise<ShareLinkSummary[]> {
  const query = filter ? `?${new URLSearchParams(shareLinkQuery(filter))}` : "";
  const body = await api<unknown>(`/api/me/share-links${query}`);
  // The contract is a bare array; a `{ links }` envelope is accepted too, so a
  // wrapped response can never blank the owner's list.
  const links = Array.isArray(body) ? body : (body as { links?: unknown } | null)?.links;
  return Array.isArray(links) ? (links as ShareLinkSummary[]).map(normalizeShareLink) : [];
}

/** Whether `link` is the link of `filter`'s target (the dialog re-checks what the server narrowed). */
export function shareLinkMatches(link: ShareLinkSummary, filter: ShareLinkFilter): boolean {
  if ("sourcePath" in filter) return link.kind === "workspace_file" && link.sourcePath === filter.sourcePath;
  if (link.conversationId !== filter.conversationId) return false;
  return "fileId" in filter ? link.kind === "file" && link.fileId === filter.fileId : link.kind === "conversation";
}

/** `POST …/files/:fileId/share-links` — `created: false` hands back the link that already exists. */
export function createShareLink(
  conversationId: string,
  fileId: string,
  expiresInDays: ShareLinkExpiryDays = DEFAULT_SHARE_LINK_EXPIRY_DAYS,
): Promise<ShareLinkCreateResult> {
  return api<ShareLinkCreateResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/share-links`,
    { method: "POST", body: JSON.stringify({ expiresInDays }) },
  );
}

/**
 * `POST /api/conversations/:id/share-links` — a read-only link to the
 * conversation as it stands now. `created: false` hands back the link it
 * already has, with the range and file choice that one was made with.
 */
export async function createConversationShareLink(
  conversationId: string,
  options: { expiresInDays?: ShareLinkExpiryDays; includeFiles?: boolean } = {},
): Promise<ShareLinkCreateResult> {
  const result = await api<ShareLinkCreateResult>(`/api/conversations/${encodeURIComponent(conversationId)}/share-links`, {
    method: "POST",
    body: JSON.stringify({
      expiresInDays: options.expiresInDays ?? DEFAULT_SHARE_LINK_EXPIRY_DAYS,
      includeFiles: options.includeFiles === true,
    }),
  });
  return { ...result, link: normalizeShareLink(result.link) };
}

/**
 * `POST /api/me/share-links/workspace` — a link to one file of the viewer's own
 * workspace (the 파일 tab), as it is NOW: the server takes a copy and the link
 * serves that. `created: false` hands back the link this path already has,
 * with the copy taken then.
 */
export async function createWorkspaceShareLink(
  path: string,
  expiresInDays: ShareLinkExpiryDays = DEFAULT_SHARE_LINK_EXPIRY_DAYS,
): Promise<ShareLinkCreateResult> {
  const result = await api<ShareLinkCreateResult>("/api/me/share-links/workspace", {
    method: "POST",
    body: JSON.stringify({ path, expiresInDays }),
  });
  return { ...result, link: normalizeShareLink(result.link) };
}

/** `DELETE /api/me/share-links/:id`. A link that is already gone counts as revoked. */
export async function revokeShareLink(id: string): Promise<void> {
  try {
    await api(`/api/me/share-links/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

/** The card's live link, if any (the server lists active links first). */
export function activeShareLink(links: readonly ShareLinkSummary[]): ShareLinkSummary | null {
  return links.find((link) => !link.expired) ?? null;
}

/** The card's most recently lapsed link, for the "이전 링크는 … 만료되었습니다" note. */
export function latestExpiredShareLink(links: readonly ShareLinkSummary[]): ShareLinkSummary | null {
  let latest: ShareLinkSummary | null = null;
  for (const link of links) {
    if (!link.expired) continue;
    if (!latest || Date.parse(link.expiresAt) > Date.parse(latest.expiresAt)) latest = link;
  }
  return latest;
}

/**
 * The address the owner copies: THIS page's origin plus the link's path and
 * hash. The server makes links absolute from the request origin when it knows
 * one, and behind a proxy that need not be the address people actually use.
 */
export function absoluteShareUrl(url: string | null | undefined, origin: string = location.origin): string {
  if (!url) return "";
  try {
    const parsed = new URL(url, origin);
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "";
  }
}

/**
 * The viewer's provenance line: "김민수 (@minsu)님이 공유 · 10월 5일 09:30까지".
 * Display names are free text anyone can set, so the username rides along as
 * the handle a recipient can actually check.
 */
export function shareOwnerLine(payload: Pick<ShareViewPayload, "ownerName" | "ownerUsername" | "expiresAt">): string {
  const handle = payload.ownerUsername ? `@${payload.ownerUsername}` : "";
  const who = payload.ownerName && handle ? `${payload.ownerName} (${handle})` : payload.ownerName || handle || "알 수 없는 사용자";
  const until = shareDateTimeLabel(payload.expiresAt);
  return until ? `${who}님이 공유 · ${until}까지` : `${who}님이 공유`;
}

/**
 * Who can open a FILE link — the same sentence in the dialog and the settings
 * list. Only an approved (logged-in) user can: open sign-up was retired with
 * groups, so there is no "anyone can sign up" case any more.
 */
export const SHARE_AUDIENCE_NOTE =
  "링크를 받은 Noah 사용자는 누구나 로그인하면 파일을 내려받을 수 있습니다. PPT 파일은 슬라이드도 볼 수 있고, 파일에 발표자 노트가 포함됩니다.";

/** The settings list holds both kinds: who can open any of them. */
export const SHARE_LIST_AUDIENCE_NOTE =
  "링크를 받은 Noah 사용자는 누구나 로그인하면 공유한 파일을 내려받거나 공유한 대화를 읽을 수 있습니다. PPT 파일에는 발표자 노트가 포함됩니다.";

/** What a link is called where both kinds are listed (settings, confirmations). */
export function shareLinkLabel(link: Pick<ShareLinkSummary, "kind" | "fileName" | "conversationTitle">): string {
  return link.kind === "conversation" ? link.conversationTitle || link.fileName || "제목 없는 대화" : link.fileName;
}

/** What a workspace-file link serves — said BEFORE the owner presses. */
export const SHARE_WORKSPACE_SCOPE_NOTE =
  "지금 이 파일의 사본이 공유됩니다. 이후에 작업 폴더의 파일이 바뀌거나 지워져도 링크의 파일은 그대로입니다.";

/** Who can open a CONVERSATION link, and that it is read-only. */
export const SHARE_CONVERSATION_AUDIENCE_NOTE =
  "링크를 받은 Noah 사용자는 누구나 로그인하면 이 대화를 읽을 수 있습니다. 읽기만 할 수 있고, 이어서 대화할 수는 없습니다.";

/** What a conversation link shows and what it leaves out — said BEFORE the owner presses. */
export const SHARE_CONVERSATION_SCOPE_NOTE =
  "지금까지의 대화만 공유됩니다. 이후에 이어지는 대화는 포함되지 않습니다. 도구 실행 기록과 생각 과정은 공유되지 않습니다. 직접 첨부한 문서와 아바타가 만든 HTML 페이지는 이름만 보이고 내려받을 수 없으며, 첨부한 이미지는 대화와 함께 보입니다.";

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "10월 5일" in the viewer's time zone. */
export function shareDateLabel(iso: string | null | undefined): string {
  const date = validDate(iso);
  return date ? `${date.getMonth() + 1}월 ${date.getDate()}일` : "";
}

/** "10월 5일 09:30" in the viewer's time zone — a 1-day link needs the time too. */
export function shareDateTimeLabel(iso: string | null | undefined): string {
  const date = validDate(iso);
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shareDateLabel(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
