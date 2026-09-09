import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { apiError, type RouterDeps } from "./_shared.js";

export function createDirectMessagesRouter({ store }: RouterDeps): Router {
  const router = Router();
  router.use("/api/dm", requireAuth(store), (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/api/dm", (req: AuthenticatedRequest, res) => {
    res.json(store.directMessageInbox(req.user!.id));
  });
  router.get("/api/dm/:peerId", (req: AuthenticatedRequest, res) => {
    if (!store.directMessagePeerExists(req.user!.id, req.params.peerId)) {
      apiError(res, 404, "대화 상대를 찾을 수 없습니다."); return;
    }
    const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (!Number.isSafeInteger(before) || before <= 0) {
      apiError(res, 400, "메시지 위치가 올바르지 않습니다."); return;
    }
    res.json(store.directMessageHistory(req.user!.id, req.params.peerId, before));
  });
  router.post("/api/dm/:peerId", (req: AuthenticatedRequest, res) => {
    const { text, nonce } = req.body ?? {};
    if (typeof text !== "string" || !text.trim() || text.length > 4000 ||
        typeof nonce !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(nonce)) {
      apiError(res, 400, "메시지는 1~4000자이며 유효한 전송 식별자가 필요합니다."); return;
    }
    const result = store.sendDirectMessage(req.user!.id, req.params.peerId, text.trim(), nonce);
    if ("error" in result) {
      const errors = { unavailable: [404, "메시지를 받을 수 없는 사용자입니다."],
        rate: [429, "메시지는 분당 60개까지 보낼 수 있습니다. 잠시 후 다시 시도해 주세요."],
        conflict: [409, "전송 식별자가 다른 메시지에 사용되었습니다."] } as const;
      const [status, message] = errors[result.error];
      apiError(res, status, message); return;
    }
    res.status(result.replay ? 200 : 201).json({ message: result.message });
  });
  router.post("/api/dm/:peerId/read", (req: AuthenticatedRequest, res) => {
    const throughId = req.body?.throughId;
    if (!Number.isSafeInteger(throughId) || throughId <= 0) {
      apiError(res, 400, "메시지 위치가 올바르지 않습니다."); return;
    }
    store.readDirectMessages(req.user!.id, req.params.peerId, throughId);
    res.json({ ok: true });
  });
  return router;
}
