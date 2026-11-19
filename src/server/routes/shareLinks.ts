import { Router, type RequestHandler, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { getActiveRunForConversation } from "../agent/runRegistry.js";
import { isShareFileExtension, resolveStoredFile } from "../chatFiles.js";
import { createRateLimiter } from "../rateLimit.js";
import {
  createOrReuseConversationShareLink,
  createOrReuseShareLink,
  createOrReuseWorkspaceShareLink,
  listShareLinkSummaries,
  openShareLink,
  resolveShareConversationFile,
  resolveShareConversationImage,
  resolveShareSlide,
  resolveTicketLink,
  revokeShareLink,
  shareableThread,
  shareDownloadName,
  sweepShareLinkCopies,
} from "../shareLinks.js";
import { parseWorkspacePath } from "../../shared/workspaceFiles.js";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  isShareableFileCard,
  isShareLinkExpiryDays,
  isShareLinkKind,
  MAX_ACTIVE_SHARE_LINKS,
  SHAREABLE_FILE_EXTENSIONS,
  SHARE_LINK_GONE_MESSAGE,
  type ShareLinkExpiryDays,
} from "../../shared/shareLinks.js";
import {
  apiError,
  attachmentContentDisposition,
  requestOrigin,
  safeString,
  type RouterDeps,
} from "./_shared.js";

/**
 * Share links over HTTP (the service is ../shareLinks.ts; the contract is
 * src/shared/shareLinks.ts).
 *
 * - Owner routes (create a file link / a conversation link / a link to a file
 *   of their own workspace; list; revoke): session only (`requireAuth`), the
 *   owner acts; foreign or missing resources are one 404 with no existence
 *   leak. A workspace file is addressed by its path in the CALLER's own
 *   sandbox — there is no id that selects another user's files.
 * - Recipient routes: ANY signed-in user holding the link. The token never
 *   rides a URL path — the viewer posts it to `/api/share/open` — and every
 *   asset URL (a deck's slides and download; a conversation's images and
 *   files) carries a short-lived ticket bound to the viewer. Every
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
  // Boot: the copies of workspace-file links that ended while the server was
  // down (expired, or their rows removed) are not kept.
  sweepShareLinkCopies(deps);

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

  const CAP_MESSAGE = `공유 링크는 최대 ${MAX_ACTIVE_SHARE_LINKS}개까지 만들 수 있습니다. 내 아바타 → 권한·연결 → 공유 링크에서 쓰지 않는 링크를 해제한 뒤 다시 시도해 주세요.`;

  /** The body's `expiresInDays` (absent = the default), or null after answering 400. */
  const expiryOf = (req: AuthenticatedRequest, res: Response): ShareLinkExpiryDays | null => {
    const rawDays = req.body?.expiresInDays;
    const expiresInDays = rawDays === undefined || rawDays === null ? DEFAULT_SHARE_LINK_EXPIRY_DAYS : rawDays;
    if (!isShareLinkExpiryDays(expiresInDays)) {
      apiError(res, 400, "유효 기간은 1일, 7일, 30일 중에서 선택해 주세요.");
      return null;
    }
    return expiresInDays;
  };

  // ---- Owner --------------------------------------------------------------

  // A link to the CONVERSATION itself, read-only, as it stands now: its anchor
  // is the last stored message, so what is said later never shows. Only this
  // route makes one — a human's press; the avatar has no tool for it.
  router.post(
    "/api/conversations/:conversationId/share-links",
    noStore,
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ownerUserId = req.user!.id;
      const { conversationId } = req.params;
      const expiresInDays = expiryOf(req, res);
      if (!expiresInDays) return;
      const includeFiles = req.body?.includeFiles;
      if (includeFiles !== undefined && typeof includeFiles !== "boolean") {
        apiError(res, 400, "파일 포함 여부가 올바르지 않습니다.");
        return;
      }
      // Not the owner, no such conversation, or a thread that cannot share — the SAME 404.
      if (!shareableThread(store, ownerUserId, conversationId)) {
        apiError(res, 404, "대화를 찾을 수 없습니다.");
        return;
      }
      // A running turn's rows are stored only when it ends: a link made now
      // would stop in the middle of an exchange.
      if (getActiveRunForConversation(ownerUserId, conversationId)) {
        apiError(res, 409, "응답이 끝난 뒤에 공유 링크를 만들 수 있습니다.");
        return;
      }
      const outcome = createOrReuseConversationShareLink(deps, {
        ownerUserId,
        conversationId,
        includeFiles: includeFiles === true,
        expiresInDays,
        origin: requestOrigin(req),
      });
      if (outcome.kind === "unavailable") {
        apiError(res, 404, "대화를 찾을 수 없습니다.");
        return;
      }
      if (outcome.kind === "empty") {
        apiError(res, 400, "아직 공유할 메시지가 없습니다.");
        return;
      }
      if (outcome.kind === "cap") {
        apiError(res, 409, CAP_MESSAGE);
        return;
      }
      const created = outcome.kind === "created";
      if (created) {
        // Ids and counts only — a conversation's title is its owner's words.
        auditAs(
          req,
          "share_link_create",
          `link ${outcome.link.id} conversation ${conversationId} ${outcome.link.messageCount} messages${outcome.link.includesFiles ? " with files" : ""} ${expiresInDays}d`,
        );
      }
      res.status(created ? 201 : 200).json({ link: outcome.link, created });
    },
  );

  router.post(
    "/api/conversations/:conversationId/files/:fileId/share-links",
    noStore,
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ownerUserId = req.user!.id;
      const { conversationId, fileId } = req.params;
      const expiresInDays = expiryOf(req, res);
      if (!expiresInDays) return;
      // Not the owner, no such conversation, or a thread that cannot share (a
      // colleague thread whose avatar is out of reach) — all the SAME 404.
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
      if (card.uploaded) {
        apiError(res, 400, "직접 첨부한 파일은 공유 링크를 만들 수 없습니다.");
        return;
      }
      const stored = resolveStoredFile(config, conversationId, fileId);
      if (!stored) {
        // A card whose bytes are gone.
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      // A screenshot card, or stored bytes of a type share_file does not
      // publish (a legacy card): the file exists, but a link never serves it.
      if (!isShareableFileCard(card) || !isShareFileExtension(stored.ext)) {
        apiError(res, 400, "이 파일은 공유 링크를 만들 수 없습니다.");
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
        apiError(res, 409, CAP_MESSAGE);
        return;
      }
      const created = outcome.kind === "created";
      if (created) {
        auditAs(req, "share_link_create", `link ${outcome.link.id} "${outcome.link.fileName}" ${expiresInDays}d`);
      }
      res.status(created ? 201 : 200).json({ link: outcome.link, created });
    },
  );

  // A link to ONE file of the caller's own sandbox workspace (the 파일 tab's
  // 공유 링크). Noah copies the bytes as they are now and the link serves that
  // copy — the workspace is never written, and a link never reads it again.
  const WORKSPACE_REFUSALS: Record<string, [number, string]> = {
    UNAVAILABLE: [404, "이 서버에서는 작업 폴더를 볼 수 없습니다."],
    NOT_FOUND: [404, "파일을 찾을 수 없습니다."],
    EMPTY: [400, "빈 파일은 공유할 수 없습니다."],
    TOO_LARGE: [413, "공유하기에는 너무 큰 파일입니다. 30MB 이하의 파일만 공유할 수 있습니다."],
    UPLOADED: [400, "직접 첨부한 파일은 공유 링크를 만들 수 없습니다."],
    UNSUPPORTED: [
      400,
      `이 형식의 파일은 공유 링크를 만들 수 없습니다. 공유할 수 있는 형식: ${SHAREABLE_FILE_EXTENSIONS.join(", ")}`,
    ],
    READ_FAILED: [500, "파일을 읽지 못했습니다. 잠시 후 다시 시도해 주세요."],
  };
  router.post("/api/me/share-links/workspace", noStore, requireAuth(store), (req: AuthenticatedRequest, res) => {
    const expiresInDays = expiryOf(req, res);
    if (!expiresInDays) return;
    const segments = parseWorkspacePath(req.body?.path);
    if (!segments || segments.length === 0) {
      apiError(res, 400, "경로가 올바르지 않습니다.");
      return;
    }
    const outcome = createOrReuseWorkspaceShareLink(deps, {
      ownerUserId: req.user!.id,
      segments,
      expiresInDays,
      origin: requestOrigin(req),
    });
    if (outcome.kind === "refused") {
      const [status, message] = WORKSPACE_REFUSALS[outcome.reason];
      apiError(res, status, message);
      return;
    }
    if (outcome.kind === "cap") {
      apiError(res, 409, CAP_MESSAGE);
      return;
    }
    const created = outcome.kind === "created";
    if (created) {
      auditAs(req, "share_link_create", `link ${outcome.link.id} workspace "${outcome.link.fileName}" ${expiresInDays}d`);
    }
    res.status(created ? 201 : 200).json({ link: outcome.link, created });
  });

  router.get("/api/me/share-links", noStore, requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    const fileId = safeString(req.query.fileId);
    // `kind` narrows to one kind of link (a conversation link has no file id to
    // filter on); `path` to the link of one workspace file.
    const kind = safeString(req.query.kind);
    const sourcePath = (parseWorkspacePath(req.query.path) ?? []).join("/");
    res.json(
      listShareLinkSummaries(
        deps,
        req.user!.id,
        {
          ...(conversationId ? { conversationId } : {}),
          ...(fileId ? { fileId } : {}),
          ...(isShareLinkKind(kind) ? { kind } : {}),
          ...(sourcePath ? { sourcePath } : {}),
        },
        requestOrigin(req),
      ),
    );
  });

  router.delete("/api/me/share-links/:id", noStore, requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = revokeShareLink(deps, req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "공유 링크를 찾을 수 없습니다.");
      return;
    }
    auditAs(
      req,
      "share_link_revoke",
      removed.kind === "conversation"
        ? `link ${removed.id} conversation ${removed.conversationId}`
        : removed.kind === "workspace_file"
          ? `link ${removed.id} workspace "${removed.fileName}"`
          : `link ${removed.id} "${removed.fileName}"`,
    );
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
      // A conversation link has no download of its own.
      if (!valid || valid.kind !== "file") {
        gone(res);
        return;
      }
      const { file, link } = valid;
      sendShareFile(res, file.path, {
        "Content-Type": file.mediaType,
        // Always a download, never inline — like the owner's own download
        // route. Re-normalized (stored so already): the saved file ends in the
        // extension of the bytes served, whatever the row holds.
        "Content-Disposition": attachmentContentDisposition(
          shareDownloadName(link.fileName, file.ext),
          `file.${file.ext}`,
        ),
      });
    },
  );

  // One image of a shared conversation: a visible image of a message in the
  // link's range (or a hidden one that message's own text places).
  router.get(
    "/api/share/t/:ticket/images/:imageId",
    noStore,
    requireAuth(store),
    shareLimiter,
    (req: AuthenticatedRequest, res) => {
      const valid = resolveTicketLink(deps, req.params.ticket, req.user!.id);
      const image = valid ? resolveShareConversationImage(deps, valid, req.params.imageId) : null;
      if (!image) {
        gone(res);
        return;
      }
      sendShareFile(res, image.path, { "Content-Type": image.mediaType });
    },
  );

  // One file of a shared conversation — only on a link its owner shared WITH
  // the files, only a card the avatar delivered. Always a download.
  router.get(
    "/api/share/t/:ticket/files/:fileId",
    noStore,
    requireAuth(store),
    shareLimiter,
    (req: AuthenticatedRequest, res) => {
      const valid = resolveTicketLink(deps, req.params.ticket, req.user!.id);
      const served = valid ? resolveShareConversationFile(deps, valid, req.params.fileId) : null;
      if (!served) {
        gone(res);
        return;
      }
      sendShareFile(res, served.file.path, {
        "Content-Type": served.file.mediaType,
        "Content-Disposition": attachmentContentDisposition(served.name, `file.${served.file.ext}`),
      });
    },
  );

  return router;
}
