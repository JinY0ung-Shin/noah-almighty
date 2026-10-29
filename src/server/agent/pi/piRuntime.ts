/**
 * Process-level pieces of the pi runtime (`AGENT_RUNTIME=pi`,
 * docs/architecture/pi-runtime.md): whose sandbox a run uses, and the run-token
 * registry + gateway client both the runner and the `/mcp` router share.
 */
import path from "node:path";
import type { AgentRequest, AppConfig } from "../../types.js";
import type { Store } from "../../store.js";
import { McpRunRegistry } from "../../mcpHttp/endpoint.js";
import { PI_USER_ID_PATTERN, createPiResponsesClient, type PiResponsesClient } from "./responsesClient.js";
import {
  ensurePiConversationDir,
  moveLegacyConversationWorkspace,
  piWorkspaceFor,
  type PiWorkspace,
} from "./piWorkspace.js";
import logger from "../../logger.js";

/**
 * The request header pi forwards to its MCP broker, which renders it into each
 * Noah server's `Authorization: Bearer {{ctx.header:x-noah-run-token}}`
 * (`scripts/pi-register-mcp.mjs` writes that broker config).
 */
export const PI_RUN_TOKEN_HEADER = "x-noah-run-token";

/** The request fields the principal and work-folder decision reads (callers decide before the full request exists). */
export type PiRunClass = Pick<AgentRequest, "viewerUserId" | "conversationId"> & { avatar: Pick<AgentRequest["avatar"], "id"> };

/**
 * The sandbox principal: whoever the run executes AS (design U4/U8) — the
 * owner on their own chat, routine, task-API turn and profile generators, the
 * VIEWER on a colleague chat (trusted or not), the ASKER on an avatar
 * consultation (`avatarAsk.ts` sets `viewerUserId` to the asking user). Every
 * class runs with pi's full built-in tool set in THAT user's sandbox; the
 * owner's data is reachable only through the self-gating Noah MCP tools.
 * Throws for an id pi-gateway does not accept (Noah's ids always are).
 */
export function piRunPrincipal(request: PiRunClass): string {
  const principal = request.viewerUserId ?? request.avatar.id;
  if (!PI_USER_ID_PATTERN.test(principal)) {
    throw new Error("pi runtime: this user id is not accepted by pi-gateway");
  }
  return principal;
}

/**
 * The work-folder key of a run WITHOUT a conversation: `run-ask-<target
 * avatar>` for an avatar consultation (in the ASKER's sandbox), else
 * `run-<scratch folder name>` (the intro/hashtag generators: `run-intro`,
 * `run-hashtags`), so repeated runs of one kind reuse ONE folder in the
 * principal's sandbox instead of piling up.
 */
export function piEphemeralRunKey(request: Pick<AgentRequest, "cwd" | "avatarConsultation" | "avatar">): string {
  if (request.avatarConsultation) return `run-ask-${request.avatar.id}`;
  return `run-${(request.cwd && path.basename(request.cwd)) || "headless"}`;
}

/**
 * The sandbox workspace a CONVERSATION run will use, decided before the
 * request is built: the chat route and the routine scheduler point every
 * server-written copy (attachment staging, browser captures, Confluence saves,
 * the file-output roots) at it. Null on the `local` stub, without a
 * conversation, or when Noah cannot reach the workspaces (no
 * `PI_WORKSPACES_DIR`).
 */
export function piRunWorkspace(config: AppConfig, run: PiRunClass): PiWorkspace | null {
  const conversationId = run.conversationId;
  if (config.agentRuntime !== "pi" || !conversationId) return null;
  const workspace = piWorkspaceFor(config, piRunPrincipal(run), conversationId);
  return workspace.hostConversationDir ? workspace : null;
}

/**
 * {@link piRunWorkspace} plus its preparation: the conversation folder exists
 * (0700) and, on the conversation's first pi turn, its SDK-era scratch files
 * moved in (design D3, `moveLegacyConversationWorkspace` — idempotent via a
 * marker in the old folder). Null when the folder cannot be made, so callers
 * keep the host scratch path and the run still has a place to stage.
 */
export function preparePiRunWorkspace(
  config: AppConfig,
  run: PiRunClass,
  legacyWorkspaceDir: string,
): PiWorkspace | null {
  const workspace = piRunWorkspace(config, run);
  if (!workspace || !ensurePiConversationDir(workspace)) return null;
  const moved = moveLegacyConversationWorkspace(legacyWorkspaceDir, workspace);
  if (!moved.alreadyDone) {
    logger.info(
      { module: "agent", conversationId: run.conversationId, moved: moved.moved, skipped: moved.skipped },
      "pi runtime: moved the conversation's earlier workspace files into the sandbox folder",
    );
  }
  return workspace;
}

export interface PiServices {
  registry: McpRunRegistry;
  /** Null when the runtime is not configured (the `local` stub). */
  client: PiResponsesClient | null;
}

const services = new WeakMap<Store, PiServices>();

/**
 * The run-token registry and gateway client for one app instance, keyed by its
 * Store (one per `createServices`): `createApp` mounts the `/mcp` router on the
 * same registry the runner registers tokens in, without threading it through
 * every `runAgentStream` caller.
 */
export function piServicesFor(store: Store, config: AppConfig): PiServices {
  let entry = services.get(store);
  if (!entry) {
    entry = {
      registry: new McpRunRegistry(),
      client: config.pi ? createPiResponsesClient({ baseUrl: config.pi.gatewayUrl, serviceKey: config.pi.apiKey }) : null,
    };
    services.set(store, entry);
  }
  return entry;
}
