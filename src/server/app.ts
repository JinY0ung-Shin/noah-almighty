import { createDirectMessagesRouter } from "./routes/directMessages.js";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { type AuthenticatedRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import logger from "./logger.js";
import { Store } from "./store.js";
import type { AgentResponse, AppConfig } from "./types.js";
import { avatarDir, type AppServices, type ObservedModelHolder, type RouterDeps } from "./routes/_shared.js";
import { migrateGroupAgentDiskArtifacts } from "./groupAgents.js";
import { createAuthRouter } from "./routes/auth.js";
import { createProfileRouter } from "./routes/profile.js";
import { createPluginsRouter } from "./routes/plugins.js";
import { createKnowledgeRepoRouter } from "./routes/knowledgeRepo.js";
import { createGroupsRouter } from "./routes/groups.js";
import { createPersonalAgentsRouter } from "./routes/personalAgents.js";
import { createBotTasksRouter } from "./routes/botTasks.js";
import { maybeDispatchNextBotTask } from "./botTaskRunner.js";
import { createAvatarTasksRouter } from "./routes/avatarTasks.js";
import { createRoutinesRouter } from "./routes/routines.js";
import { createSkillShareRouter } from "./routes/skillShare.js";
import { createSttRouter } from "./routes/stt.js";
import { createChatRouter, conversationHistoryForPrompt, expandChatSlashCommand } from "./routes/chat.js";
import { createAdminRouter } from "./routes/admin.js";
import { createBrowserExtensionRouter } from "./routes/browserExtension.js";
import { createBrowserClipboardRouter } from "./browserClipboard.js";

export type { AppServices };
export { conversationHistoryForPrompt, expandChatSlashCommand };

export function createServices(configOverrides: Partial<AppConfig> = {}): AppServices {
  const config = loadConfig(configOverrides);
  // Group binding is required for external avatars to be visible; a legacy env
  // entry without one still parses (never break boot over it) but is dark until
  // the operator adds `visibleToGroupIds` to EXTERNAL_AGENTS_JSON.
  for (const agent of config.externalAgents ?? []) {
    if (!agent.visibleToGroupIds?.length) {
      logger.warn(
        { externalAgentId: agent.id },
        "external agent has no visibleToGroupIds and is visible to no one",
      );
    }
  }
  const store = new Store(config);
  // On-disk half of the multi-agent group_agents migration (the store rebuild
  // rewrote the DB bindings): rename legacy `group:<gid>`-named image files and
  // workspace trees to the canonical `group:<gid>:<aid>`. Idempotent, no-op
  // once the legacy names are gone; never break boot over a rename failure.
  try {
    migrateGroupAgentDiskArtifacts(store, config, avatarDir(config));
  } catch (err) {
    logger.warn({ err }, "group-agent disk artifact migration failed");
  }
  // The model the SDK last reported via its `init` event. Null until the first
  // Claude run reports one; the admin "system info" view surfaces it alongside
  // the configured model so an operator can confirm what actually ran. Held in a
  // small mutable box so every run path can write it and the admin router read it.
  let observedModelValue: string | null = null;
  const observedModel: ObservedModelHolder = {
    get: () => observedModelValue,
    set: (model) => {
      observedModelValue = model;
    },
  };
  return { config, store, observedModel };
}

export function createApp(services = createServices()) {
  const { config, store, observedModel } = services;

  // Audit the authenticated actor of `req`. Collapses the repeated
  // `store.audit({ actorUserId: req.user!.id, actorName: req.user!.username, ... })`
  // shape used across the group/admin/me routes into one call site.
  const auditAs = (
    req: AuthenticatedRequest,
    action: string,
    detail: string,
    status: "success" | "error" = "success",
  ): void => {
    store.audit({
      actorUserId: req.user!.id,
      actorName: req.user!.username,
      action,
      status,
      detail,
    });
  };

  const deps: RouterDeps = {
    services,
    config,
    store,
    observedModel,
    auditAs,
    // Delegated bot tasks: a 내 봇 turn that just ended frees its thread, so the
    // dispatcher can start whatever the owner queued behind it. Wired HERE
    // because `routes/chat.ts` must not import `botTaskRunner` — the runner
    // calls back into `executeChatTurn`.
    onBotTurnSettled: (ownerUserId, conversationId) => {
      void maybeDispatchNextBotTask(services, ownerUserId, conversationId);
    },
  };

  const app = express();
  // Limit bumped from 3mb to accommodate chat image attachments (base64-inflated,
  // up to MAX_CHAT_IMAGES_PER_MESSAGE × ~5MB; the client downscales before send).
  app.use(express.json({ limit: "50mb" }));

  // ---- Security headers ---------------------------------------------------
  // CSP locks scripts/connections/images to same-origin. The avatar renders
  // untrusted markdown (colleague turns, fetched pages, repo files): img-src
  // 'self' data: neutralizes the classic remote-image exfiltration beacon, and
  // script-src 'self' means a DOMPurify miss can't execute injected script.
  // Every asset is same-origin (vendored marked/dompurify, local fonts), so this
  // is low-friction. NOTE: it also blocks remote <img> in rendered markdown by
  // design — relax img-src if remote images are wanted.
  // 'wasm-unsafe-eval' is the one deliberate widening: it permits WebAssembly
  // COMPILATION only — the composer mic's end-of-speech detector (Silero VAD on
  // onnxruntime-web) — and does NOT enable JS eval or inline script; with
  // connect-src 'self' the wasm bytes can only come from this origin. Keep
  // 'unsafe-eval' and 'unsafe-inline' out of script-src.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  app.use(
    "/fonts/noto-sans-kr",
    express.static(path.join(process.cwd(), "node_modules", "@fontsource-variable", "noto-sans-kr")),
  );

  app.get("/vendor/marked.esm.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "marked", "lib", "marked.esm.js"));
  });
  app.get("/vendor/purify.es.mjs", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "node_modules", "dompurify", "dist", "purify.es.mjs"));
  });

  const builtClientRoot = path.join(process.cwd(), "dist", "client");
  const clientRoot = fs.existsSync(path.join(builtClientRoot, "index.html"))
    ? builtClientRoot
    : path.join(process.cwd(), "public");
  app.use(express.static(clientRoot));

  // ---- Request logging ----------------------------------------------------
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: duration,
          userId: (req as AuthenticatedRequest).user?.id ?? null,
        },
        "request",
      );
    });
    next();
  });

  // Per-domain routers (split from the original monolithic createApp closure).
  // Mounted in the SAME order the routes were registered before so relative
  // matching is unchanged; each router owns a disjoint set of paths.
  app.use(createAuthRouter(deps));
  app.use(createProfileRouter(deps));
  app.use(createDirectMessagesRouter(deps));
  app.use(createPluginsRouter(deps));
  app.use(createKnowledgeRepoRouter(deps));
  app.use(createGroupsRouter(deps));
  app.use(createPersonalAgentsRouter(deps));
  app.use(createBotTasksRouter(deps));
  app.use(createRoutinesRouter(deps));
  app.use(createAvatarTasksRouter(deps));
  app.use(createSkillShareRouter(deps));
  app.use(createSttRouter(deps));
  app.use(createChatRouter(deps));
  app.use(createBrowserExtensionRouter(deps));
  app.use(createBrowserClipboardRouter({ store }));
  app.use(createAdminRouter(deps));

  // Unknown API requests must stay API-shaped. Without this boundary, GET
  // /api/typo falls through to the SPA index with HTTP 200, hiding route drift
  // from clients, probes, and operators.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API 엔드포인트를 찾을 수 없습니다." });
  });

  // ---- SPA catch-all ---------------------------------------------------

  app.get("*", (_req, res) => {
    const indexPath = path.join(clientRoot, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.status(404).type("text/plain").send(
      "Frontend bundle not found. Run npm run dev and open the Vite dev server, or run npm run build first.",
    );
  });

  // ---- Error handler ------------------------------------------------------

  // Keep this last so errors from routers, the API boundary, static serving,
  // and the SPA fallback all receive the same scrubbed JSON response.
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path, userId: (req as AuthenticatedRequest).user?.id ?? null }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export type { AgentResponse };
