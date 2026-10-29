import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { piProxyBaseEnv } from "../agent/pi/mcpProxies.js";
import {
  MAX_SHARED_MCP_SERVERS,
  isBindableSecretName,
  mcpHttpBridgeServerDef,
  parseSharedMcpServer,
  planSharedMcpRun,
  sharedMcpOrigin,
  toSharedMcpAdminView,
  toSharedMcpUserView,
} from "../sharedMcpServers.js";
import { now } from "../store/internal.js";
import type { SharedMcpBinding, SharedMcpServer } from "../types.js";
import { apiError, type RouterDeps } from "./_shared.js";

/** A check may not hang the admin panel: connect + tools/list must finish within this. */
const CHECK_TIMEOUT_MS = 20_000;

export interface SharedMcpCheckResult {
  ok: boolean;
  /** Tool names the server listed (ok only). */
  tools: string[];
  /** The CHECKING admin's own slots still unbound (labels), or bound secrets gone from their vault. */
  missingSecrets: string[];
  /** Korean summary for the panel when not ok (secret values scrubbed by the bridge). */
  error: string | null;
}

// ---- 공용 MCP 서버 ----------------------------------------------------
// Admin CRUD over the ONE app_config list (sharedMcpServers.ts) + a connection
// check, and each signed-in user's OWN slot bindings (the 시크릿 card): binding
// one of your secrets to a server's slot is the consent for it to be sent there,
// and it is tied to the server's current origin. Runs pick changes up from the
// next turn.
export function createSharedMcpRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  const userViews = (userId: string) => {
    const bindings = store.listSharedMcpBindings(userId);
    return store
      .getSharedMcpServers()
      .filter((server) => server.enabled)
      .map((server) => toSharedMcpUserView(server, bindings));
  };

  router.get("/api/me/shared-mcp-servers", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ servers: userViews(req.user!.id) });
  });

  // Bind one of MY secrets to a slot (body {secretName}) for the server's
  // CURRENT origin; the value never leaves the vault here.
  router.put(
    "/api/me/shared-mcp-servers/:name/slots/:slotId",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const userId = req.user!.id;
      const server = store.getSharedMcpServers().find((entry) => entry.name === req.params.name && entry.enabled);
      const slot = server?.secretSlots.find((entry) => entry.id === req.params.slotId);
      if (!server || !slot) {
        apiError(res, 404, "공용 MCP 서버 또는 인증 자리를 찾을 수 없습니다.");
        return;
      }
      const secretName = typeof req.body?.secretName === "string" ? req.body.secretName.trim() : "";
      if (!isBindableSecretName(secretName)) {
        apiError(res, 400, "연결할 수 없는 시크릿입니다. GIT·SSH 전용 시크릿은 공용 MCP 서버에 연결할 수 없습니다.");
        return;
      }
      if (!store.listUserSecretNames(userId).includes(secretName)) {
        apiError(res, 400, `${secretName} 시크릿이 없습니다. 먼저 시크릿을 저장해 주세요.`);
        return;
      }
      const binding: SharedMcpBinding = {
        serverName: server.name,
        slotId: slot.id,
        secretName,
        origin: sharedMcpOrigin(server),
      };
      store.setSharedMcpBinding(userId, binding);
      auditAs(req, "shared_mcp_bind", `shared mcp ${server.name}/${slot.id} ← ${secretName} (${binding.origin})`);
      res.json({ servers: userViews(userId) });
    },
  );

  router.delete(
    "/api/me/shared-mcp-servers/:name/slots/:slotId",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const userId = req.user!.id;
      if (store.deleteSharedMcpBinding(userId, req.params.name, req.params.slotId)) {
        auditAs(req, "shared_mcp_unbind", `shared mcp ${req.params.name}/${req.params.slotId}`);
      }
      res.json({ servers: userViews(userId) });
    },
  );

  router.get("/api/admin/shared-mcp-servers", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ servers: store.getSharedMcpServers().map(toSharedMcpAdminView) });
  });

  router.post("/api/admin/shared-mcp-servers", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    // A NEW server's slots always get fresh ids (a client-chosen id could
    // revive bindings orphaned by a server that vanished without the DELETE
    // route), and any leftover binding to the name is dropped.
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const slotsIn = Array.isArray(body.secretSlots)
      ? body.secretSlots.map((slot) => (slot && typeof slot === "object" ? { ...(slot as object), id: undefined } : slot))
      : body.secretSlots;
    const parsed = parseSharedMcpServer({ ...body, secretSlots: slotsIn, updatedAt: undefined }, now());
    if ("error" in parsed) {
      apiError(res, 400, parsed.error);
      return;
    }
    const servers = store.getSharedMcpServers();
    if (servers.some((server) => server.name === parsed.server.name)) {
      apiError(res, 409, `"${parsed.server.name}" 이름의 공용 MCP 서버가 이미 있습니다.`);
      return;
    }
    if (servers.length >= MAX_SHARED_MCP_SERVERS) {
      apiError(res, 400, `공용 MCP 서버는 최대 ${MAX_SHARED_MCP_SERVERS}개까지 등록할 수 있습니다.`);
      return;
    }
    store.pruneSharedMcpBindings(parsed.server.name);
    store.setSharedMcpServers([...servers, parsed.server]);
    auditAs(req, "shared_mcp_create", `shared mcp ${parsed.server.name} (${parsed.server.transport})`);
    logger.warn({ actorId: req.user!.id, server: parsed.server.name }, "shared mcp server created");
    res.json({ server: toSharedMcpAdminView(parsed.server) });
  });

  // Full replace of one server (the name is the id and stays fixed).
  router.put("/api/admin/shared-mcp-servers/:name", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const name = req.params.name;
    const servers = store.getSharedMcpServers();
    const index = servers.findIndex((server) => server.name === name);
    if (index === -1) {
      apiError(res, 404, "공용 MCP 서버를 찾을 수 없습니다.");
      return;
    }
    // Only ids the stored server already has are kept (bindings survive the
    // edit); an unknown id is a NEW slot and gets a fresh one, for the same
    // reason a created server's slots do.
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const knownIds = new Set(servers[index].secretSlots.map((slot) => slot.id));
    const slotsIn = Array.isArray(body.secretSlots)
      ? body.secretSlots.map((slot) =>
          slot && typeof slot === "object" && !knownIds.has(String((slot as { id?: unknown }).id))
            ? { ...(slot as object), id: undefined }
            : slot,
        )
      : body.secretSlots;
    const parsed = parseSharedMcpServer({ ...body, secretSlots: slotsIn, name, updatedAt: undefined }, now());
    if ("error" in parsed) {
      apiError(res, 400, parsed.error);
      return;
    }
    const next = servers.slice();
    next[index] = parsed.server;
    store.setSharedMcpServers(next);
    // A removed slot's bindings go; a moved origin keeps them (they read as
    // stale — "rebind needed" — and never apply to the new host).
    store.pruneSharedMcpBindings(name, parsed.server.secretSlots.map((slot) => slot.id));
    const action =
      servers[index].enabled !== parsed.server.enabled
        ? parsed.server.enabled
          ? "shared_mcp_enable"
          : "shared_mcp_disable"
        : "shared_mcp_update";
    auditAs(req, action, `shared mcp ${name}`);
    logger.warn({ actorId: req.user!.id, server: name, action }, "shared mcp server changed");
    res.json({ server: toSharedMcpAdminView(parsed.server) });
  });

  router.delete("/api/admin/shared-mcp-servers/:name", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const name = req.params.name;
    const servers = store.getSharedMcpServers();
    if (!servers.some((server) => server.name === name)) {
      apiError(res, 404, "공용 MCP 서버를 찾을 수 없습니다.");
      return;
    }
    store.setSharedMcpServers(servers.filter((server) => server.name !== name));
    store.pruneSharedMcpBindings(name);
    auditAs(req, "shared_mcp_delete", `shared mcp ${name}`);
    logger.warn({ actorId: req.user!.id, server: name }, "shared mcp server deleted");
    res.json({ ok: true });
  });

  // Connection check: connect through the SAME bridge a run uses (same CA flag,
  // same egress preload via the inherited env), with the CHECKING admin's own
  // secrets, and list the tools. Never stores anything.
  router.post(
    "/api/admin/shared-mcp-servers/:name/check",
    requireAuth(store),
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const server = store.getSharedMcpServers().find((entry) => entry.name === req.params.name);
      if (!server) {
        apiError(res, 404, "공용 MCP 서버를 찾을 수 없습니다.");
        return;
      }
      const result = await checkSharedMcpServer(
        { ...server, enabled: true },
        store.listSharedMcpBindings(req.user!.id),
        // The same input a run gets: the injectable vault, never git/SSH names.
        Object.fromEntries(
          Object.entries(store.getUserSecrets(req.user!.id)).filter(([secretName]) => isBindableSecretName(secretName)),
        ),
        config.dataDir,
      );
      auditAs(req, "shared_mcp_check", `shared mcp ${server.name}: ${result.ok ? "ok" : "failed"}`);
      res.json(result);
    },
  );

  return router;
}

/** Exported for tests. */
export async function checkSharedMcpServer(
  server: SharedMcpServer,
  bindings: SharedMcpBinding[],
  secrets: Record<string, string>,
  dataDir: string,
): Promise<SharedMcpCheckResult> {
  const plan = planSharedMcpRun([server], { bindings, secrets, secretsAllowed: true });
  const state = plan.states[0];
  if (state?.status === "needs_binding") {
    return {
      ok: false,
      tools: [],
      missingSecrets: state.unboundSlots,
      error: `확인하려면 내 아바타 → 권한·연결 → 시크릿에서 이 서버의 ${state.unboundSlots.join(", ")}에 내 시크릿을 먼저 연결해 주세요.`,
    };
  }
  if (state?.status === "missing_secrets") {
    return {
      ok: false,
      tools: [],
      missingSecrets: state.missingSecrets,
      error: `연결한 시크릿 ${state.missingSecrets.join(", ")}이(가) 없습니다. 시크릿을 다시 저장하고 연결해 주세요.`,
    };
  }
  const registration = plan.registrations[0];
  if (!registration) {
    return { ok: false, tools: [], missingSecrets: [], error: "확인할 수 없는 서버입니다." };
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const secretsDir = path.join(dataDir, "runtime", "mcp-secrets");
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(secretsDir, `check-${randomUUID()}.json`);
  const bridgeConfig =
    registration.kind === "bridge"
      ? registration.config
      : { url: registration.def.url, transport: registration.def.type, headers: {}, redact: [] };
  fs.writeFileSync(configFile, JSON.stringify(bridgeConfig), { mode: 0o600 });
  const def = mcpHttpBridgeServerDef(path.join(process.cwd(), "scripts", "mcp-http-bridge.mjs"), configFile);
  let stderr = "";
  // The same env a run's relayed child starts from (no git credentials, no
  // server-only secrets).
  const env = piProxyBaseEnv();
  const transport = new StdioClientTransport({ command: def.command, args: def.args, env, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += String(chunk);
  });
  const client = new Client({ name: "noah-shared-mcp-check", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport, { timeout: CHECK_TIMEOUT_MS });
        return client.listTools(undefined, { timeout: CHECK_TIMEOUT_MS });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("시간 초과")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, tools: listed.tools.map((tool) => tool.name), missingSecrets: [], error: null };
  } catch (error) {
    // The bridge already scrubbed what it wrote; the client-side message is
    // scrubbed again here in case a value rode an MCP SDK client error of its own.
    const bridgeLine = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    let detail = bridgeLine || (error instanceof Error ? error.message : String(error));
    for (const value of bridgeConfig.redact) {
      detail = detail.split(value).join("[REDACTED]");
    }
    return { ok: false, tools: [], missingSecrets: [], error: `연결 실패: ${detail.slice(0, 400)}` };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
    fs.rmSync(configFile, { force: true });
  }
}
