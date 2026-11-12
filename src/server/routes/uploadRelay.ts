import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import type { UploadRelayConfig } from "../types.js";
import {
  UploadRelayError,
  ackUploadRelayFile,
  auditFileName,
  fetchUploadRelayFile,
  judgeUploadRelayFile,
  listUploadRelayFiles,
  mintUploadRelayTicket,
  verifyOwnUploadRelayTicket,
  type RelayFetch,
  type UploadRelayFileInfo,
  type UploadRelayTicketPayload,
} from "../uploadRelay.js";
import { UPLOAD_RELAY_MAX_FILE_BYTES, UPLOAD_RELAY_MESSAGES, type UploadRelayProblem } from "../../shared/uploadRelay.js";
import { apiError, type RouterDeps } from "./_shared.js";

const RELAY_OFF_MESSAGE = "이 서버에는 업로드 중계가 설정되어 있지 않습니다.";
const RELAY_UNREACHABLE_MESSAGE = "업로드 중계 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const TICKET_INVALID_MESSAGE = "업로드 창이 만료되었습니다. 첨부 버튼을 다시 눌러 주세요.";
const FILE_GONE_MESSAGE = "파일을 찾을 수 없습니다. 이미 받았거나 보관 시간이 지났습니다. 다시 올려 주세요.";
const BUSY_MESSAGE = "파일을 받는 중입니다. 잠시 후 다시 시도해 주세요.";

/** Relayed files one user may be fetching at the same moment (each holds up to 20 MiB in memory). */
const MAX_CONCURRENT_FETCHES_PER_USER = 2;
/** How long a file that was sent waits for the browser's confirmation before it is forgotten. */
const CONFIRM_WINDOW_MS = 15 * 60_000;
/** Bound of the confirmation table (oldest dropped first). */
const MAX_AWAITING_CONFIRMATION = 2000;

/** A judged file whose bytes were sent and whose arrival the browser has not confirmed yet. */
interface AwaitingConfirmation {
  file: UploadRelayFileInfo;
  bytes: number;
  sentAt: number;
}

/** The audit action of every file this server took from (or refused at) the relay. */
export const UPLOAD_RELAY_AUDIT_ACTION = "upload_relay_receive";

/** One audit line: what the file was, who put it on the relay, which ticket it rode. */
function auditDetail(file: UploadRelayFileInfo, bytes: number, tid: string, problem: UploadRelayProblem | null): string {
  const uploader = file.uploader ? auditFileName(file.uploader) : "알 수 없음";
  const outcome = problem ? `거절(${problem})` : "수신";
  return `업로드 중계 ${outcome}: "${auditFileName(file.name)}" (${bytes} bytes, sha256 ${file.sha256}), 중계 서버 업로더 ${uploader}, 티켓 ${tid}`;
}

// ---- Upload relay (the attach button on a fleet with a DRM agent) --------
// Session-only and self-scoped: a ticket is collected by the user it was
// minted for (the ticket id carries a keyed tag of that user's id), and a file
// id is honoured only when the relay lists it under THAT ticket.
//
// Handing a file over takes TWO requests on purpose. `fetch` sends the bytes;
// `confirm` is the browser saying it HAS them. Only the confirmation writes
// the "received" audit row and tells the relay to drop its copy: a response
// that left this server is not a file that arrived (a closed tab, a proxy
// buffer), and a trail that says "received" for a file nobody got — with the
// relay's copy already deleted — is the one thing this path must never do.
export function createUploadRelayRouter({ config, store, auditAs }: RouterDeps, options: { fetchImpl?: RelayFetch } = {}): Router {
  const router = Router();
  const fetchImpl = options.fetchImpl;
  // Router-scoped state (one per app): what was sent and awaits confirmation,
  // and how many fetches each user has in flight.
  const awaiting = new Map<string, AwaitingConfirmation>();
  const inFlight = new Map<string, number>();
  const awaitingKey = (userId: string, tid: string, fileId: string) => `${userId}\n${tid}\n${fileId}`;

  function rememberSent(key: string, entry: AwaitingConfirmation): void {
    for (const [existing, value] of awaiting) {
      if (entry.sentAt - value.sentAt <= CONFIRM_WINDOW_MS && awaiting.size < MAX_AWAITING_CONFIRMATION) break;
      awaiting.delete(existing);
    }
    // Re-inserted so the table stays ordered by `sentAt`.
    awaiting.delete(key);
    awaiting.set(key, entry);
  }

  router.use("/api/chat/upload-relay", requireAuth(store), (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  /** The relay block, or a 404 already sent (off = the route does not exist for this deployment). */
  function relayOr404(res: Response): UploadRelayConfig | null {
    if (config.uploadRelay) return config.uploadRelay;
    apiError(res, 404, RELAY_OFF_MESSAGE);
    return null;
  }

  /** The caller's own, still collectable ticket, or a 400 already sent. */
  function ticketOr400(relay: UploadRelayConfig, req: AuthenticatedRequest, res: Response): UploadRelayTicketPayload | null {
    const payload = verifyOwnUploadRelayTicket(relay, (req.body as { ticket?: unknown } | undefined)?.ticket, req.user!.id);
    if (!payload) apiError(res, 400, TICKET_INVALID_MESSAGE);
    return payload;
  }

  function relayFailure(res: Response, error: unknown, what: string): void {
    logger.warn(
      { err: error instanceof UploadRelayError ? error.message : String(error), what },
      "upload relay: the relay could not be used",
    );
    apiError(res, 502, RELAY_UNREACHABLE_MESSAGE);
  }

  function logFieldsOf(req: AuthenticatedRequest, file: UploadRelayFileInfo, bytes: number, tid: string) {
    return {
      userId: req.user!.id,
      username: req.user!.username,
      file: auditFileName(file.name),
      bytes,
      sha256: file.sha256,
      relayUploader: file.uploader,
      ticketId: tid,
    };
  }

  /** Tell the relay (with retries) what became of a file; a failure is logged, never thrown. */
  async function acknowledge(
    relay: UploadRelayConfig,
    fileId: string,
    outcome: "delivered" | "refused",
    reason: string | undefined,
    logFields: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ackUploadRelayFile(relay, fileId, outcome, reason, { fetchImpl });
    } catch (error) {
      // The relay drops the copy on its own when its keep time runs out, and
      // its trail then says the file was collected but never acknowledged.
      logger.warn({ ...logFields, outcome, err: String(error) }, "upload relay: acknowledging the file failed");
    }
  }

  // A ticket for one press of the attach button. `documents` is the pane's own
  // rule (documents only in a pane of the viewer's own avatar); the composer's
  // intake applies it again when the file arrives.
  router.post("/api/chat/upload-relay/tickets", (req: AuthenticatedRequest, res) => {
    const relay = relayOr404(res);
    if (!relay) return;
    const documents = (req.body as { documents?: unknown } | undefined)?.documents === true;
    const minted = mintUploadRelayTicket(relay, req.user!, { documents });
    res.json({ ticket: minted.ticket, url: minted.url, expiresAt: minted.expiresAt, ttlSeconds: minted.ttlSeconds });
  });

  // What is waiting on the relay for this ticket.
  router.post("/api/chat/upload-relay/poll", async (req: AuthenticatedRequest, res) => {
    const relay = relayOr404(res);
    if (!relay) return;
    const ticket = ticketOr400(relay, req, res);
    if (!ticket) return;
    try {
      const files = await listUploadRelayFiles(relay, ticket.tid, { fetchImpl });
      res.json({ files: files.map((file) => ({ id: file.id, name: file.name, size: file.size })) });
    } catch (error) {
      relayFailure(res, error, "list");
    }
  });

  // One file's bytes, for the browser that holds the ticket. The bytes are
  // judged before a byte is sent. A refusal is final here: audited and
  // acknowledged to the relay as refused. A file that passes is only SENT —
  // nothing is audited or acknowledged until `confirm`.
  router.post("/api/chat/upload-relay/fetch", async (req: AuthenticatedRequest, res) => {
    const relay = relayOr404(res);
    if (!relay) return;
    const ticket = ticketOr400(relay, req, res);
    if (!ticket) return;
    const fileId = (req.body as { fileId?: unknown } | undefined)?.fileId;
    if (typeof fileId !== "string") {
      apiError(res, 400, FILE_GONE_MESSAGE);
      return;
    }
    const userId = req.user!.id;
    const running = inFlight.get(userId) ?? 0;
    if (running >= MAX_CONCURRENT_FETCHES_PER_USER) {
      apiError(res, 429, BUSY_MESSAGE);
      return;
    }
    inFlight.set(userId, running + 1);
    try {
      let file: UploadRelayFileInfo | undefined;
      let buffer: Buffer | null;
      try {
        // The id is honoured only as one of THIS ticket's files.
        file = (await listUploadRelayFiles(relay, ticket.tid, { fetchImpl })).find((entry) => entry.id === fileId);
        if (!file) {
          apiError(res, 404, FILE_GONE_MESSAGE);
          return;
        }
        buffer = await fetchUploadRelayFile(relay, file.id, UPLOAD_RELAY_MAX_FILE_BYTES, { fetchImpl });
      } catch (error) {
        relayFailure(res, error, "fetch");
        return;
      }
      if (!buffer) {
        apiError(res, 404, FILE_GONE_MESSAGE);
        return;
      }
      const logFields = logFieldsOf(req, file, buffer.length, ticket.tid);
      const problem = judgeUploadRelayFile(file, buffer, ticket.accept);
      if (problem) {
        auditAs(req, UPLOAD_RELAY_AUDIT_ACTION, auditDetail(file, buffer.length, ticket.tid, problem), "error");
        logger.warn({ ...logFields, problem }, "upload relay: refused a relayed file");
        void acknowledge(relay, file.id, "refused", problem, logFields);
        res.status(422).json({ error: UPLOAD_RELAY_MESSAGES[problem], problem });
        return;
      }
      rememberSent(awaitingKey(userId, ticket.tid, file.id), { file, bytes: buffer.length, sentAt: Date.now() });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Content-Length", String(buffer.length));
      res.end(buffer);
    } finally {
      const left = (inFlight.get(userId) ?? 1) - 1;
      if (left > 0) inFlight.set(userId, left);
      else inFlight.delete(userId);
    }
  });

  // The browser has the bytes of a file `fetch` sent it. THIS is the hand-over:
  // the "received" audit row is written here, and the relay is told to drop
  // its copy. A file that was never sent (or whose confirmation window ran
  // out, or a restart in between) is a 404 — the browser fetches it again.
  router.post("/api/chat/upload-relay/confirm", async (req: AuthenticatedRequest, res) => {
    const relay = relayOr404(res);
    if (!relay) return;
    const ticket = ticketOr400(relay, req, res);
    if (!ticket) return;
    const fileId = (req.body as { fileId?: unknown } | undefined)?.fileId;
    const key = typeof fileId === "string" ? awaitingKey(req.user!.id, ticket.tid, fileId) : "";
    const sent = key ? awaiting.get(key) : undefined;
    if (!sent || Date.now() - sent.sentAt > CONFIRM_WINDOW_MS) {
      if (key) awaiting.delete(key);
      apiError(res, 404, FILE_GONE_MESSAGE);
      return;
    }
    // Deleted first: a repeated confirmation is a 404, never a second row.
    awaiting.delete(key);
    const logFields = logFieldsOf(req, sent.file, sent.bytes, ticket.tid);
    auditAs(req, UPLOAD_RELAY_AUDIT_ACTION, auditDetail(sent.file, sent.bytes, ticket.tid, null));
    logger.info(logFields, "upload relay: handed a relayed file to its owner");
    res.json({ ok: true });
    await acknowledge(relay, sent.file.id, "delivered", undefined, logFields);
  });

  return router;
}
