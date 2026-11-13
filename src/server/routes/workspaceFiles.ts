import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import {
  listWorkspaceFolder,
  openWorkspaceFile,
  workspaceConversationPath,
} from "../workspaceBrowser.js";
import { WorkspaceDocumentPreviews } from "../workspacePreviews.js";
import {
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  parseWorkspacePath,
  workspaceImageMediaType,
} from "../../shared/workspaceFiles.js";
import { apiError, attachmentContentDisposition, type RouterDeps } from "./_shared.js";

const UNAVAILABLE_MESSAGE = "이 서버에서는 작업 폴더를 볼 수 없습니다.";
const BAD_PATH_MESSAGE = "경로가 올바르지 않습니다.";
const FOLDER_NOT_FOUND_MESSAGE = "폴더를 찾을 수 없습니다.";
const FILE_NOT_FOUND_MESSAGE = "파일을 찾을 수 없습니다.";
const NOT_DOCUMENT_MESSAGE = "미리보기로 변환할 수 있는 문서가 아닙니다.";
const PAGE_NOT_FOUND_MESSAGE = "미리보기 페이지를 찾을 수 없습니다. 파일을 다시 열어 주세요.";
const PREVIEW_TOO_LARGE_MESSAGE = "미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.";

/** A conversation id as the `conversation` query may carry it (only ever hashed or used as one folder name). */
const CONVERSATION_ID = /^[\x21-\x7e]{1,200}$/;

// ---- 파일 tab (the signed-in user's own sandbox workspace, read-only) ------
// Session-only and strictly self-scoped: the workspace is the caller's own
// (`req.user.id` is the principal every run of theirs executes as), so there is
// no id to pass and no cross-user read to gate. GETs only — this surface never
// writes, renames or deletes anything in the workspace. (A document preview
// renders into Noah's own expiring cache: `workspacePreviews.ts`.)
export function createWorkspaceFilesRouter({ config, store }: RouterDeps): Router {
  const router = Router();
  // The document converter's jobs and cache belong to this app instance.
  const documentPreviews = new WorkspaceDocumentPreviews(config);
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
