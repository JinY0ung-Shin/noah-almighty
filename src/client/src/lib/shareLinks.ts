// Client side of PPTX share links (`src/shared/shareLinks.ts` is the contract):
// the recipient viewer's status-aware open call, the owner's list / create /
// revoke calls, and the display rules the link dialog, the settings list and
// the viewer share. No Svelte here, so tests/client-share-links.test.ts pins it
// directly.
import { api, ApiError } from "./api";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  isShareToken,
  SHARE_TICKET_TTL_MINUTES,
  type ShareOpenRequest,
  type ShareLinkCreateResult,
  type ShareLinkExpiryDays,
  type ShareLinkSummary,
  type ShareViewPayload,
  type ShareViewSlide,
} from "../../../shared/shareLinks";

/** What opening a link came to: the deck, a dead link, or a failure worth retrying. */
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

/**
 * The payload as the viewer uses it: renders and the download only from share
 * asset URLs (anything else is dropped), every display string coerced to text.
 * The strings are the deck author's (file name, slide titles) and are rendered
 * as plain text only — never markdown or HTML.
 */
export function sanitizeSharePayload(raw: ShareViewPayload | null | undefined): ShareViewPayload {
  const slides: ShareViewSlide[] = (Array.isArray(raw?.slides) ? raw.slides : [])
    .filter((slide) => slide && isShareAssetUrl(slide.url))
    .map((slide, position) => {
      const index = Number.isInteger(slide.index) && slide.index > 0 ? slide.index : position + 1;
      return { index, url: slide.url, alt: text(slide.alt) || `슬라이드 ${index}` };
    });
  const downloadUrl = raw?.downloadUrl;
  return {
    fileName: text(raw?.fileName) || "공유된 PPT",
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

export function shareTicketsStale(loadedAt: number, now: number = Date.now()): boolean {
  return now - loadedAt >= SHARE_TICKET_REFRESH_MS;
}

/** `GET /api/me/share-links` — the owner's links, active first, newest first. */
export async function listShareLinks(filter?: { conversationId: string; fileId: string }): Promise<ShareLinkSummary[]> {
  const query = filter ? `?${new URLSearchParams({ conversationId: filter.conversationId, fileId: filter.fileId })}` : "";
  const body = await api<unknown>(`/api/me/share-links${query}`);
  // The contract is a bare array; a `{ links }` envelope is accepted too, so a
  // wrapped response can never blank the owner's list.
  if (Array.isArray(body)) return body as ShareLinkSummary[];
  const links = (body as { links?: unknown } | null)?.links;
  return Array.isArray(links) ? (links as ShareLinkSummary[]) : [];
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

/** Who can open a link — the same sentence in the dialog and the settings list. */
export function shareAudienceNote(signupMode: string | null | undefined): string {
  return signupMode === "open"
    ? "링크를 받은 사람은 누구나 Noah에 가입·로그인해 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다."
    : "링크를 받은 Noah 사용자는 누구나 로그인하면 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다.";
}

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
