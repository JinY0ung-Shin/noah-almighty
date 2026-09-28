import { Router, type RequestHandler, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { getActiveRunForConversation } from "../agent/runRegistry.js";
import { resolveStoredFile } from "../chatFiles.js";
import { createRateLimiter } from "../rateLimit.js";
import {
  createOrReuseShareLink,
  listShareLinkSummaries,
  openShareLink,
  resolveShareableDeck,
  resolveShareSlide,
  resolveTicketLink,
  shareableThread,
  shareDownloadName,
} from "../shareLinks.js";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  isPptxCard,
  isShareLinkExpiryDays,
  MAX_ACTIVE_SHARE_LINKS,
  PPTX_MEDIA_TYPE,
  SHARE_LINK_GONE_MESSAGE,
} from "../../shared/shareLinks.js";
import {
  apiError,
  attachmentContentDisposition,
  requestOrigin,
  safeString,
  type RouterDeps,
} from "./_shared.js";

/**
 * PPT share links over HTTP (the service is ../shareLinks.ts; the contract is
 * src/shared/shareLinks.ts).
 *
 * - Owner routes (create / list / revoke): session only (`requireAuth`), the
 *   conversation owner acts; foreign or missing resources are one 404 with no
 *   existence leak.
 * - Recipient routes: ANY signed-in user holding the link. The token never
 *   rides a URL path — the viewer posts it to `/api/share/open` — and the
 *   slide/download URLs carry a short-lived ticket bound to the viewer. Every
 *   invalid state answers 404 `SHARE_LINK_GONE_MESSAGE`, never 401: the client
 *   logs a signed-in user out on any 401.
 *
 * Every JSON answer is `Cache-Control: no-store`; the bytes are
 * `private, no-cache`, so each reuse revalidates (ETag) and re-runs the link
 * validity — a revoked link stops serving at once. Nothing here logs a token.
 */
export function createShareLinksRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();
  const deps = { config, store };

  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
  // Per signed-in user, AFTER requireAuth (an anonymous per-IP bucket would be
  // the reverse proxy's, shared by everyone behind it). Bypassed under test.
  const shareLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 240,
    keyFn: (req) => `share:${(req as AuthenticatedRequest).user?.id ?? ""}`,
  });

  /**
   * Headers a send may already have set when it fails LATE: sendFile's
   * `headers` option lands on send's `headers` event, and send then adds the
   * validators and range headers — all BEFORE its 412/416 checks and the
   * stream open. Only these are removed, never what earlier middleware set.
   */
  const FILE_HEADERS = [
    "Content-Type",
    "Content-Disposition",
    "Content-Length",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "Accept-Ranges",
  ];
  const clearFileHeaders = (res: Response): void => {
    for (const name of FILE_HEADERS) res.removeHeader(name);
  };

  /** The single recipient failure: 404, dead-link message, never cached, none of a file's headers. */
  const gone = (res: Response): void => {
    clearFileHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    apiError(res, 404, SHARE_LINK_GONE_MESSAGE);
  };

  /**
   * Stream one validated file. The headers ride sendFile's `headers` option,
   * set on send's `headers` event — which fires before send's precondition and
   * range checks and before the file is opened, so a failure after it finds the
   * file's headers already on the response; the callback strips them before
   * answering. A 416 (a resumed download past the end) or 412 (a failed
   * If-Match) concerns a link that is still VALID, so it keeps its own status
   * (a 416 keeps send's `Content-Range` naming the size); every other late failure (the
   * file vanished or cannot be opened after the validity check) is the same 404
   * — never the app's error handler, whose log line would carry the ticket
   * path. Once bytes are out there is nothing left to answer.
   */
  const sendShareFile = (res: Response, filePath: string, headers: Record<string, string>): void => {
    res.sendFile(
      filePath,
      {
        headers: {
          ...headers,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-cache",
        },
      },
      (err) => {
        if (!err) return;
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        const status = (err as { status?: unknown }).status;
        if (status === 416 || status === 412) {
          const contentRange = status === 416 ? res.getHeader("Content-Range") : undefined;
          clearFileHeaders(res);
          if (contentRange !== undefined) res.setHeader("Content-Range", contentRange);
          res.setHeader("Cache-Control", "no-store");
          apiError(
            res,
            status,
            status === 416 ? "요청한 범위를 보낼 수 없습니다." : "요청 조건이 파일과 맞지 않습니다.",
          );
          return;
        }
        gone(res);
      },
    );
  };

  // ---- Owner --------------------------------------------------------------

  router.post(
    "/api/conversations/:conversationId/files/:fileId/share-links",
    noStore,
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ownerUserId = req.user!.id;
      const { conversationId, fileId } = req.params;
      const rawDays = req.body?.expiresInDays;
      const expiresInDays = rawDays === undefined || rawDays === null ? DEFAULT_SHARE_LINK_EXPIRY_DAYS : rawDays;
      if (!isShareLinkExpiryDays(expiresInDays)) {
        apiError(res, 400, "유효 기간은 1일, 7일, 30일 중에서 선택해 주세요.");
        return;
      }
      // Not the owner, no such conversation, or a thread that cannot share
      // (group-agent member threads; a colleague thread whose avatar is out of
      // reach) — all the SAME 404.
      if (!shareableThread(store, ownerUserId, conversationId)) {
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      const attachments = store.findCardMessageAttachments(ownerUserId, conversationId, fileId);
      if (!attachments) {
        // Bytes on disk but no persisted card: the turn that shared it is
        // still running (attachments persist only at a turn boundary).
        if (
          resolveStoredFile(config, conversationId, fileId) &&
          getActiveRunForConversation(ownerUserId, conversationId)
        ) {
          apiError(res, 409, "응답이 끝난 뒤에 공유 링크를 만들 수 있습니다.");
          return;
        }
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      const card = attachments.find((att) => att.id === fileId && att.kind === "file")!;
      if (!isPptxCard(card)) {
        apiError(res, 400, "PPTX 파일만 공유 링크를 만들 수 있습니다.");
        return;
      }
      if (!resolveShareableDeck(config, conversationId, fileId)) {
        // A pptx card whose bytes are gone (or were never a .pptx on disk).
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      const outcome = createOrReuseShareLink(deps, {
        ownerUserId,
        conversationId,
        card,
        attachments,
        expiresInDays,
        origin: requestOrigin(req),
      });
      if (outcome.kind === "unavailable") {
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      if (outcome.kind === "cap") {
        apiError(
          res,
          409,
          `공유 링크는 최대 ${MAX_ACTIVE_SHARE_LINKS}개까지 만들 수 있습니다. 내 아바타 → 권한·연결 → 공유 링크에서 쓰지 않는 링크를 해제한 뒤 다시 시도해 주세요.`,
        );
        return;
      }
      const created = outcome.kind === "created";
      if (created) {
        auditAs(req, "share_link_create", `link ${outcome.link.id} "${outcome.link.fileName}" ${expiresInDays}d`);
      }
      res.status(created ? 201 : 200).json({ link: outcome.link, created });
    },
  );

  router.get("/api/me/share-links", noStore, requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    const fileId = safeString(req.query.fileId);
    res.json(
      listShareLinkSummaries(
        deps,
        req.user!.id,
        { ...(conversationId ? { conversationId } : {}), ...(fileId ? { fileId } : {}) },
        requestOrigin(req),
      ),
    );
  });

  router.delete("/api/me/share-links/:id", noStore, requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.revokeShareLink(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "공유 링크를 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "share_link_revoke", `link ${removed.id} "${removed.fileName}"`);
    res.status(204).end();
  });

  // ---- Recipient ----------------------------------------------------------

  router.post("/api/share/open", noStore, requireAuth(store), shareLimiter, (req: AuthenticatedRequest, res) => {
    const payload = openShareLink(deps, req.body?.token, req.user!.id, { refresh: req.body?.refresh === true });
    if (!payload) {
      gone(res);
      return;
    }
    res.json(payload);
  });

  router.get(
    "/api/share/t/:ticket/slides/:index",
    noStore,
    requireAuth(store),
    shareLimiter,
    (req: AuthenticatedRequest, res) => {
      const valid = resolveTicketLink(deps, req.params.ticket, req.user!.id);
      const slide = valid ? resolveShareSlide(config, valid, req.params.index) : null;
      if (!slide) {
        gone(res);
        return;
      }
      sendShareFile(res, slide.path, { "Content-Type": slide.mediaType });
    },
  );

  router.get(
    "/api/share/t/:ticket/download",
    noStore,
    requireAuth(store),
    shareLimiter,
    (req: AuthenticatedRequest, res) => {
      const valid = resolveTicketLink(deps, req.params.ticket, req.user!.id);
      if (!valid) {
        gone(res);
        return;
      }
      sendShareFile(res, valid.deck.path, {
        "Content-Type": PPTX_MEDIA_TYPE,
        // Re-normalized (stored so already): the saved file ends in .pptx whatever the row holds.
        "Content-Disposition": attachmentContentDisposition(shareDownloadName(valid.link.fileName), "file.pptx"),
      });
    },
  );

  return router;
}
