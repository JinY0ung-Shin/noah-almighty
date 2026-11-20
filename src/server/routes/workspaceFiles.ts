import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import {
  listWorkspaceFolder,
  openWorkspaceFile,
  workspaceConversationPath,
} from "../workspaceBrowser.js";
import { WorkspaceDocumentPreviews } from "../workspacePreviews.js";
import {
  WORKSPACE_HTML_PAGE_SANDBOX,
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  decodeWorkspaceText,
  parseWorkspacePath,
  workspaceImageMediaType,
  workspacePreviewKind,
} from "../../shared/workspaceFiles.js";
import { apiError, attachmentContentDisposition, type RouterDeps } from "./_shared.js";

const UNAVAILABLE_MESSAGE = "이 서버에서는 작업 폴더를 볼 수 없습니다.";
const BAD_PATH_MESSAGE = "경로가 올바르지 않습니다.";
const FOLDER_NOT_FOUND_MESSAGE = "폴더를 찾을 수 없습니다.";
const FILE_NOT_FOUND_MESSAGE = "파일을 찾을 수 없습니다.";
const NOT_DOCUMENT_MESSAGE = "미리보기로 변환할 수 있는 문서가 아닙니다.";
const PAGE_NOT_FOUND_MESSAGE = "미리보기 페이지를 찾을 수 없습니다. 파일을 다시 열어 주세요.";
const PREVIEW_TOO_LARGE_MESSAGE = "미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.";
const HTML_PAGE_FRAME_ONLY_MESSAGE = "이 주소는 채팅의 파일 탭 안에서만 열립니다.";
const HTML_PAGE_NOT_SHOWN_MESSAGE = "이 파일은 페이지로 표시할 수 없습니다. 다운로드해서 확인해 주세요.";
const HTML_PAGE_TICKET_MESSAGE = "이 페이지는 파일 탭에서 다시 열어야 합니다. 새로고침을 눌러 주세요.";
const NOT_HTML_MESSAGE = "HTML 파일이 아닙니다.";

/** How long the tab has to load the frame it asked a ticket for. */
export const WORKSPACE_HTML_PAGE_TICKET_TTL_MS = 60_000;
/** Open tickets one user may hold at once (their oldest is dropped first): a tab or two of pages, reopened. */
export const WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER = 20;

/**
 * The page route's one-use tickets. A page runs only where the APP decided to
 * run it (WorkspaceHtmlFrame: after it checked what the page could reach in
 * this browser) — never because an address was opened: a link the avatar
 * wrote, a frame something else made, the page reloading itself. So the
 * address alone serves nothing; the app asks for a ticket (a session call the
 * page itself cannot make) and the frame's one request spends it.
 */
export class WorkspaceHtmlPageTickets {
  /** Insertion order is expiry order: every ticket lives the same time. */
  private readonly open = new Map<string, { userId: string; path: string; expires: number }>();

  issue(userId: string, path: string, now: number = Date.now()): string {
    // Expired ones go, from the front; then this user's oldest, down to the cap
    // — so nobody's tickets are pushed out by another user's.
    const own: string[] = [];
    for (const [id, ticket] of this.open) {
      if (ticket.expires <= now) this.open.delete(id);
      else if (ticket.userId === userId) own.push(id);
    }
    for (const id of own.slice(0, Math.max(0, own.length - WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER + 1))) {
      this.open.delete(id);
    }
    const id = crypto.randomBytes(32).toString("base64url");
    this.open.set(id, { userId, path, expires: now + WORKSPACE_HTML_PAGE_TICKET_TTL_MS });
    return id;
  }

  /** Spends `id` (whatever the answer) and says whether it was this user's live ticket for this file. */
  redeem(id: unknown, userId: string, path: string, now: number = Date.now()): boolean {
    if (typeof id !== "string") return false;
    const ticket = this.open.get(id);
    if (!ticket) return false;
    this.open.delete(id);
    return ticket.expires > now && ticket.userId === userId && ticket.path === path;
  }
}

/**
 * The policy an `.html` workspace file RUNS under (`/api/me/workspace/html`).
 * The page is the agent's — untrusted — so it may compute and draw anything
 * and reach NOTHING:
 * - `sandbox` without `allow-same-origin`: an opaque origin, whoever loads the
 *   response — no cookie, no storage, no reading the app around the frame;
 * - `default-src 'none'`: no fetch/XHR/WebSocket/beacon, no remote script,
 *   style, image, font, media or worker, and no child frame from an address
 *   (a `srcdoc` child runs under this same policy). Only what the file
 *   itself carries: inline script and style, `data:`/`blob:` pictures and media,
 *   `data:` fonts. (`'unsafe-eval'` adds nothing inline script lacks; a
 *   bundled library may need it.)
 * - `form-action 'none'` and `base-uri 'none'`: no form leaves the page;
 * - `frame-ancestors 'self'`: only Noah's own pages may frame it — and THEIR
 *   policy (`default-src 'self'`, app.ts) is what refuses the frame's every
 *   navigation to another site, which this policy cannot do for itself.
 * LOADING nothing is not SENDING nothing. No policy stops, in Chrome:
 * `<link rel=prerender>` (a real GET to any host), WebRTC (a STUN lookup),
 * the DNS and TCP of a refused navigation. So a page can send out what IT
 * holds — its own bytes and what the viewer types into it — never anything
 * of Noah's. Accepted by the user's decision (client.md "An .html file RUNS").
 */
export const WORKSPACE_HTML_PAGE_CSP = [
  `sandbox ${WORKSPACE_HTML_PAGE_SANDBOX}`,
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** The headers of every answer the page route gives a frame (they replace the app-wide `DENY`). */
function setFramedAnswerHeaders(res: Response, csp: string): void {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/** A refusal the frame can SHOW: plain text, nothing in it runs or loads. */
function framedNotice(res: Response, status: number, message: string): void {
  setFramedAnswerHeaders(res, "sandbox; default-src 'none'; frame-ancestors 'self'");
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

/** A conversation id as the `conversation` query may carry it (only ever hashed or used as one folder name). */
const CONVERSATION_ID = /^[\x21-\x7e]{1,200}$/;

// ---- 파일 tab (the signed-in user's own sandbox workspace, read-only) ------
// Session-only and strictly self-scoped: the workspace is the caller's own
// (`req.user.id` is the principal every run of theirs executes as), so there is
// no id to pass and no cross-user read to gate. GETs only — this surface never
// writes, renames or deletes anything in the workspace. (A document preview
// renders into Noah's own expiring cache: `workspacePreviews.ts`.) Every byte
// leaves as a download or an image — except an .html file, which one route
// serves as a page that runs, in an origin of its own (`WORKSPACE_HTML_PAGE_CSP`).
export function createWorkspaceFilesRouter({ config, store }: RouterDeps): Router {
  const router = Router();
  // The document converter's jobs and cache belong to this app instance.
  const documentPreviews = new WorkspaceDocumentPreviews(config);
  const htmlPageTickets = new WorkspaceHtmlPageTickets();
  router.use("/api/me/workspace", requireAuth(store), (_req, res, next) => {
    // A listing or a file is whatever the sandbox holds right now.
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  // One folder's entries. `conversation` (the pane's conversation) only adds
  // `current`, the folder that conversation works in.
  router.get("/api/me/workspace", (req: AuthenticatedRequest, res) => {
    const segments = parseWorkspacePath(req.query.path);
    if (!segments) {
      apiError(res, 400, BAD_PATH_MESSAGE);
      return;
    }
    const listing = listWorkspaceFolder(config, store, req.user!.id, segments);
    if (listing === "unavailable") {
      apiError(res, 404, UNAVAILABLE_MESSAGE);
      return;
    }
    if (listing === "not_found") {
      apiError(res, 404, FOLDER_NOT_FOUND_MESSAGE);
      return;
    }
    const conversation = req.query.conversation;
    res.json(
      typeof conversation === "string" && CONVERSATION_ID.test(conversation)
        ? { ...listing, current: workspaceConversationPath(conversation) }
        : listing,
    );
  });

  // One file's bytes. ALWAYS a download for a navigation (`attachment`), typed
  // as an image only for the image extensions the tab shows in an <img>, and
  // sandboxed with no fetches should anything render it as a document: the
  // bytes are the agent's, and an .html or .svg among them must never run in
  // this origin. `preview=1` (the tab reading a file to draw it) refuses a file
  // past the preview cap instead of streaming it.
  router.get("/api/me/workspace/file", (req: AuthenticatedRequest, res) => {
    const segments = parseWorkspacePath(req.query.path);
    if (!segments || segments.length === 0) {
      apiError(res, 400, BAD_PATH_MESSAGE);
      return;
    }
    const file = openWorkspaceFile(config, req.user!.id, segments);
    if (file === "unavailable") {
      apiError(res, 404, UNAVAILABLE_MESSAGE);
      return;
    }
    if (file === "not_found") {
      apiError(res, 404, FILE_NOT_FOUND_MESSAGE);
      return;
    }
    if (req.query.preview === "1" && file.size > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) {
      fs.closeSync(file.fd);
      apiError(res, 413, PREVIEW_TOO_LARGE_MESSAGE);
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", workspaceImageMediaType(file.name) ?? "application/octet-stream");
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", attachmentContentDisposition(file.name, "file"));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    // Express answers HEAD through this handler too: the headers are the answer.
    if (file.size === 0 || req.method === "HEAD") {
      fs.closeSync(file.fd);
      res.end();
      return;
    }
    // Exactly the bytes counted at the open: a file the agent is still
    // appending to ends at that size, and one it cut short BREAKS the transfer
    // (the connection is dropped) — a short body under the declared length
    // would otherwise hang until the keep-alive timeout, and padding it would
    // hand over bytes the file never held.
    const stream = fs.createReadStream("", { fd: file.fd, start: 0, end: file.size - 1, autoClose: true });
    let sent = 0;
    stream.on("data", (chunk: string | Buffer) => {
      sent += chunk.length;
    });
    stream.on("error", () => res.destroy());
    stream.on("end", () => {
      if (sent < file.size) res.destroy();
      else res.end();
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res, { end: false });
  });

  // An .html file as a PAGE THAT RUNS — the one route that serves the agent's
  // bytes as a document, so everything about the answer is the boundary
  // (`WORKSPACE_HTML_PAGE_CSP`). Meant as a frame's document only: opened as a
  // tab the page is its own top window, free to send itself to another site
  // with no app policy around it — so a request the browser marks as anything
  // but a frame's is refused. A browser sends that mark (`Sec-Fetch-Dest`) only
  // to an https or localhost origin: on a plain-HTTP deployment there is none,
  // and the page is served — still in an origin of its own, still loading
  // nothing; what a tab adds there is the page leaving with its OWN bytes.
  // The bytes go out as the text the tab's own reader makes of them, in UTF-8.
  //
  // And only for a TICKET (below): the address by itself serves nothing, on any
  // deployment, so a page runs where the app chose to run it and nowhere else.
  router.get("/api/me/workspace/html", (req: AuthenticatedRequest, res) => {
    const destination = req.headers["sec-fetch-dest"];
    if (destination !== undefined && destination !== "iframe") {
      apiError(res, 400, HTML_PAGE_FRAME_ONLY_MESSAGE);
      return;
    }
    const segments = parseWorkspacePath(req.query.path);
    if (!segments || segments.length === 0) {
      framedNotice(res, 400, BAD_PATH_MESSAGE);
      return;
    }
    if (!htmlPageTickets.redeem(req.query.ticket, req.user!.id, segments.join("/"))) {
      framedNotice(res, 403, HTML_PAGE_TICKET_MESSAGE);
      return;
    }
    const file = openWorkspaceFile(config, req.user!.id, segments);
    if (file === "unavailable") {
      framedNotice(res, 404, UNAVAILABLE_MESSAGE);
      return;
    }
    if (file === "not_found") {
      framedNotice(res, 404, FILE_NOT_FOUND_MESSAGE);
      return;
    }
    let text: string | null = null;
    try {
      // The same test the tab applies before it asks: an .html name within the text preview cap.
      if (workspacePreviewKind(file.name, file.size) === "html") {
        const bytes = Buffer.alloc(file.size);
        let read = 0;
        while (read < bytes.length) {
          const count = fs.readSync(file.fd, bytes, read, bytes.length - read, read);
          if (count === 0) break; // cut short since the open: what is there is the page
          read += count;
        }
        text = decodeWorkspaceText(bytes.subarray(0, read));
      }
    } catch {
      text = null;
    } finally {
      fs.closeSync(file.fd);
    }
    if (text === null) {
      framedNotice(res, 400, HTML_PAGE_NOT_SHOWN_MESSAGE);
      return;
    }
    setFramedAnswerHeaders(res, WORKSPACE_HTML_PAGE_CSP);
    res.status(200).type("text/html; charset=utf-8").send(Buffer.from(text, "utf8"));
  });

  // The ticket the page route spends: one load of one .html file by this user,
  // within a minute. A POST, so the app-wide cross-site refusal covers it, and
  // a call the page itself can never make (it holds no session and may fetch
  // nothing). Whether the file is there is the page route's answer, not this one's.
  router.post("/api/me/workspace/html-ticket", (req: AuthenticatedRequest, res) => {
    const segments = parseWorkspacePath((req.body as { path?: unknown } | undefined)?.path);
    if (!segments || segments.length === 0) {
      apiError(res, 400, BAD_PATH_MESSAGE);
      return;
    }
    if (workspacePreviewKind(segments[segments.length - 1]!, 0) !== "html") {
      apiError(res, 400, NOT_HTML_MESSAGE);
      return;
    }
    res.json({ ticket: htmlPageTickets.issue(req.user!.id, segments.join("/")) });
  });

  // A pdf, pptx or docx as page images, rendered server-side (the tab cannot
  // draw them). Never holds the request for a conversion: `rendering` means
  // "ask again". `retry=1` (the viewer pressed 새로고침) forgets a remembered failure.
  router.get("/api/me/workspace/preview", async (req: AuthenticatedRequest, res) => {
    const segments = parseWorkspacePath(req.query.path);
    if (!segments || segments.length === 0) {
      apiError(res, 400, BAD_PATH_MESSAGE);
      return;
    }
    const preview = await documentPreviews.request(req.user!.id, segments, { retry: req.query.retry === "1" });
    if (preview === "unavailable") {
      apiError(res, 404, UNAVAILABLE_MESSAGE);
      return;
    }
    if (preview === "not_found") {
      apiError(res, 404, FILE_NOT_FOUND_MESSAGE);
      return;
    }
    if (preview === "not_document") {
      apiError(res, 400, NOT_DOCUMENT_MESSAGE);
      return;
    }
    res.json(preview);
  });

  // One rendered page: an image Noah's own converter wrote, of the CALLER's own
  // document (the cache is keyed by the user), for an <img>. The id names one
  // version of the file, so the image under it never changes.
  router.get("/api/me/workspace/preview/page", (req: AuthenticatedRequest, res) => {
    const page = documentPreviews.page(req.user!.id, req.query.id, req.query.n);
    if (!page) {
      apiError(res, 404, PAGE_NOT_FOUND_MESSAGE);
      return;
    }
    res.type(page.mediaType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=21600, immutable");
    res.sendFile(path.resolve(page.path), { dotfiles: "allow" }, (error) => {
      // Expired between the lookup and the send. Not cacheable: the same id
      // names the same pages once they are rendered again.
      if (error && !res.headersSent) {
        res.setHeader("Cache-Control", "private, no-store");
        apiError(res, 404, PAGE_NOT_FOUND_MESSAGE);
      }
    });
  });

  return router;
}
