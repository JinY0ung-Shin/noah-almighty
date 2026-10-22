import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { webFetchProxyState } from "../agent/webFetchTools.js";
import logger from "../logger.js";
import { checkServerAgent, cleanupServerRemote, localCliInfo, serverAgentTarget, type ServerCleanupResult } from "../serverAgents/installer.js";
import { isServerAgentError } from "../serverAgents/errors.js";
import { activeServerAgentRunIds, markServerAgentDeleting } from "../serverAgents/limits.js";
import { inspectHostKey, isHostTrusted, trustHostWithFingerprint } from "../sshTrust.js";
import {
  MAX_SERVER_AGENTS,
  SERVER_AGENT_ERROR_KO,
  serverAgentHostToken,
  serverAgentInputErrorKo,
  validateServerAgentInput,
  type ServerAgent,
  type ServerAgentErrorCode,
  type ServerAgentHostKeyResponse,
  type ServerAgentInput,
  type ServerAgentInstallState,
  type ServerAgentListResponse,
  type ServerAgentView,
} from "../../shared/serverAgents.js";
import { apiError, type RouterDeps } from "./_shared.js";

// 권한·연결 → 서버 에이전트: the owner's SSH servers. Session auth only; the
// owner is the logged-in user (their own avatar id IS their user id), so every
// store call is scoped by req.user.id and a foreign id is a plain 404.
// Registration stays a settings-screen action (D9) because host-key trust needs
// a human to read the fingerprint.

const NOT_FOUND = "서버를 찾을 수 없습니다.";
const DUPLICATE_NAME = "같은 이름의 서버가 이미 있습니다.";
const CLEANUP_SKIPPED_KO: Record<Extract<ServerCleanupResult, { status: "skipped" }>["reason"], string> = {
  shared_account: "같은 서버 계정(호스트·포트·사용자)을 쓰는 다른 서버 등록이 있어 서버의 에이전트 파일은 남겨 두었습니다.",
  active_runs: "이 서버 계정에서 아직 실행 중인 에이전트 작업이 있어 서버의 에이전트 파일은 남겨 두었습니다.",
};
// `SHA256:` + 43 chars of unpadded base64 — the only fingerprint form sshTrust emits.
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

function errorCodeOf(error: unknown, fallback: ServerAgentErrorCode): ServerAgentErrorCode {
  return isServerAgentError(error) ? error.code : fallback;
}

/** `name user@host:port tier` — the audit identity of a server row (never notes or secrets). */
function auditIdentity(server: Pick<ServerAgent, "name" | "username" | "host" | "port" | "access">): string {
  return `${server.name} ${server.username}@${server.host}:${server.port} ${server.access}`;
}

export function createServerAgentsRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();
  // Server ids with a check in flight: a second click while the first is still
  // uploading the CLI would race two uploads into the same remote directory.
  const checking = new Set<string>();

  async function toView(ownerUserId: string, server: ServerAgent): Promise<ServerAgentView> {
    let hostTrusted = false;
    try {
      hostTrusted = await isHostTrusted(ownerUserId, config, server.host, server.port);
    } catch (err) {
      logger.warn({ err, serverAgentId: server.id }, "server agent host-trust lookup failed");
    }
    return { ...server, hostTrusted };
  }

  function cliVersion(): string {
    try {
      return localCliInfo().version;
    } catch (err) {
      logger.warn({ err }, "local CLI info unavailable");
      return "";
    }
  }

  function ownServer(req: AuthenticatedRequest, res: Response): ServerAgent | null {
    const server = store.getServerAgent(req.user!.id, req.params.id);
    if (!server) apiError(res, 404, NOT_FOUND);
    return server;
  }

  router.get("/api/me/server-agents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    try {
      const ownerUserId = req.user!.id;
      const servers = await Promise.all(store.listServerAgents(ownerUserId).map((server) => toView(ownerUserId, server)));
      const body: ServerAgentListResponse = {
        servers,
        sshKeySet: store.listUserSecretNames(ownerUserId).includes("SSH_PRIVATE_KEY"),
        egressBlocked: webFetchProxyState().egressPolicy === "domain-proxy",
        cliVersion: cliVersion(),
        adminEnabled: store.isServerAgentsEnabled(),
      };
      res.json(body);
    } catch (err) {
      logger.error({ err }, "server agent list failed");
      apiError(res, 500, "서버 목록을 불러오지 못했습니다.");
    }
  });

  router.post("/api/me/server-agents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const parsed = validateServerAgentInput(req.body, { partial: false });
    if (!parsed.ok) {
      apiError(res, 400, serverAgentInputErrorKo(parsed.error));
      return;
    }
    const result = store.createServerAgent(req.user!.id, parsed.value as ServerAgentInput);
    if (!result.ok) {
      apiError(res, 409, result.error === "LIMIT" ? `서버는 최대 ${MAX_SERVER_AGENTS}개까지 등록할 수 있습니다.` : DUPLICATE_NAME);
      return;
    }
    auditAs(req, "server_agent_create", auditIdentity(result.server));
    res.status(201).json(await toView(req.user!.id, result.server));
  });

  router.patch("/api/me/server-agents/:id", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const parsed = validateServerAgentInput(req.body, { partial: true });
    if (!parsed.ok) {
      apiError(res, 400, serverAgentInputErrorKo(parsed.error));
      return;
    }
    if (!Object.keys(parsed.value).length) {
      apiError(res, 400, "변경할 내용이 없습니다.");
      return;
    }
    const result = store.updateServerAgent(req.user!.id, req.params.id, parsed.value);
    if (!result.ok) {
      if (result.error === "NOT_FOUND") apiError(res, 404, NOT_FOUND);
      else apiError(res, 409, DUPLICATE_NAME);
      return;
    }
    auditAs(req, "server_agent_update", auditIdentity(result.server));
    res.json(await toView(req.user!.id, result.server));
  });

  router.delete("/api/me/server-agents/:id", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const server = ownServer(req, res);
    if (!server) return;
    // Claimed FIRST, so no delegation or check can start on the row while the
    // (awaited) remote cleanup runs — it would `rm -rf` under a fresh CLI and
    // leave an orphan session row behind.
    const releaseDeleting = markServerAgentDeleting(server.id);
    if (!releaseDeleting) {
      apiError(res, 409, "이 서버를 이미 삭제하고 있습니다.");
      return;
    }
    try {
      // A live delegation still holds this row; removing it (or the remote CLI
      // under it) mid-run would orphan the session it is about to record.
      if (activeServerAgentRunIds(server.id).size > 0 || checking.has(server.id)) {
        apiError(res, 409, "이 서버에서 실행 중인 위임 작업이나 점검이 있습니다. 끝난 뒤 다시 시도해 주세요.");
        return;
      }
      // Remote cleanup runs BEFORE the row delete (it needs the row's target) and
      // is best-effort: an unreachable server must never block removing it here.
      let cleanup: "skipped" | "done" | "failed" = "skipped";
      let cleanupError: string | undefined;
      let cleanupReason: string | undefined;
      if (req.query.cleanupRemote === "1") {
        try {
          const result = await cleanupServerRemote({ store, config }, req.user!.id, server);
          if (result.status === "done") cleanup = "done";
          else cleanupReason = CLEANUP_SKIPPED_KO[result.reason];
        } catch (err) {
          cleanup = "failed";
          cleanupError = SERVER_AGENT_ERROR_KO[errorCodeOf(err, "UNKNOWN")];
          logger.warn({ err, serverAgentId: server.id }, "server agent remote cleanup failed");
        }
      }
      if (!store.deleteServerAgent(req.user!.id, server.id)) {
        apiError(res, 404, NOT_FOUND);
        return;
      }
      auditAs(req, "server_agent_delete", `${auditIdentity(server)} cleanup=${cleanup}`);
      res.json({ ok: true, cleanup, ...(cleanupError ? { cleanupError } : {}), ...(cleanupReason ? { cleanupReason } : {}) });
    } finally {
      releaseDeleting();
    }
  });

  router.post("/api/me/server-agents/:id/host-key", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const server = ownServer(req, res);
    if (!server) return;
    if (webFetchProxyState().egressPolicy === "domain-proxy") {
      apiError(res, 409, SERVER_AGENT_ERROR_KO.EGRESS_BLOCKED);
      return;
    }
    try {
      const seen = await inspectHostKey(req.user!.id, config, server.host, server.port);
      const body: ServerAgentHostKeyResponse = {
        fingerprint: seen.fingerprint,
        keyType: seen.keyType,
        trusted: seen.trusted,
        mismatch: seen.mismatch,
      };
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    } catch (err) {
      logger.warn({ err, serverAgentId: server.id }, "server agent host-key fetch failed");
      apiError(res, 502, SERVER_AGENT_ERROR_KO[errorCodeOf(err, "UNREACHABLE")]);
    }
  });

  router.post("/api/me/server-agents/:id/trust-host", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const server = ownServer(req, res);
    if (!server) return;
    const fingerprint = req.body?.fingerprint;
    if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
      apiError(res, 400, "호스트 키 지문 형식이 올바르지 않습니다. 호스트 키를 다시 확인해 주세요.");
      return;
    }
    if (webFetchProxyState().egressPolicy === "domain-proxy") {
      apiError(res, 409, SERVER_AGENT_ERROR_KO.EGRESS_BLOCKED);
      return;
    }
    try {
      // Re-fetches and trusts ONLY if the live key still has the fingerprint
      // the owner just read (the TOCTOU-safe half of the trust flow).
      const { entry, changed } = await trustHostWithFingerprint(req.user!.id, config, server.host, server.port, fingerprint);
      auditAs(req, "server_agent_trust_host", `${server.name} ${serverAgentHostToken(server.host, server.port)} ${entry.fingerprint}`);
      res.json({ server: await toView(req.user!.id, server), fingerprint: entry.fingerprint, keyType: entry.keyType, changed });
    } catch (err) {
      const code = errorCodeOf(err, "UNREACHABLE");
      if (code === "HOST_KEY_MISMATCH") {
        auditAs(req, "server_agent_trust_host", `${server.name} ${serverAgentHostToken(server.host, server.port)} ${fingerprint} mismatch`, "error");
        apiError(res, 409, `${SERVER_AGENT_ERROR_KO.HOST_KEY_MISMATCH} 화면에 표시된 뒤 서버 키가 바뀌었으니 다시 확인해 주세요.`);
        return;
      }
      logger.warn({ err, serverAgentId: server.id }, "server agent trust-host failed");
      apiError(res, 502, SERVER_AGENT_ERROR_KO[code]);
    }
  });

  router.post("/api/me/server-agents/:id/check", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const server = ownServer(req, res);
    if (!server) return;
    // A check hands the deployment's model credentials to the server: refused
    // until a system admin enables the feature (registration/trust stay open).
    if (!store.isServerAgentsEnabled()) {
      apiError(res, 409, SERVER_AGENT_ERROR_KO.ADMIN_DISABLED);
      return;
    }
    if (checking.has(server.id)) {
      apiError(res, 409, "이 서버를 이미 점검하고 있습니다. 끝날 때까지 기다려 주세요.");
      return;
    }
    checking.add(server.id);
    let state: ServerAgentInstallState;
    try {
      state = await checkServerAgent({ store, config }, req.user!.id, server);
    } catch (err) {
      // checkServerAgent classifies every expected failure itself; reaching here
      // is a bug, so persist a generic state rather than a raw message.
      logger.error({ err, serverAgentId: server.id }, "server agent check threw");
      state = {
        ok: false,
        version: server.installState?.version ?? null,
        error: errorCodeOf(err, "UNKNOWN"),
        detail: isServerAgentError(err) ? err.detail || null : "unexpected error during check",
        checkedAt: new Date().toISOString(),
      };
      store.setServerAgentInstallState(req.user!.id, server.id, state, serverAgentTarget(server));
    } finally {
      checking.delete(server.id);
    }
    auditAs(
      req,
      "server_agent_check",
      `${server.name} ok=${state.ok} code=${state.error ?? "-"} version=${state.version ?? "-"}`,
      state.ok ? "success" : "error",
    );
    res.json(state);
  });

  return router;
}
