/**
 * Process-level pieces of the pi runtime (`AGENT_RUNTIME=pi`,
 * docs/architecture/pi-runtime.md): whose sandbox a run uses, and the run-token
 * registry + gateway client both the runner and the `/mcp` router share.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest, AppConfig } from "../../types.js";
import type { Store } from "../../store.js";
import { McpRunRegistry } from "../../mcpHttp/endpoint.js";
import { PI_USER_ID_PATTERN, createPiResponsesClient, type PiResponsesClient } from "./responsesClient.js";
import {
  deletePiUserWorkspace,
  ensurePiConversationDir,
  moveLegacyConversationWorkspace,
  piWorkspaceFor,
  type PiWorkspace,
} from "./piWorkspace.js";
import { piRepoCopyStateDir } from "./piRepoCopy.js";
import logger from "../../logger.js";

/**
 * The request header pi forwards to its MCP broker, which renders it into each
 * Noah server's `Authorization: Bearer {{ctx.header:x-noah-run-token}}`
 * (`scripts/pi-register-mcp.mjs` writes that broker config).
 */
export const PI_RUN_TOKEN_HEADER = "x-noah-run-token";

/** The request fields the principal and work-folder decision reads (callers decide before the full request exists). */
export type PiRunClass = Pick<AgentRequest, "viewerUserId" | "conversationId" | "avatarConsultation"> & {
  avatar: Pick<AgentRequest["avatar"], "id">;
};

/**
 * The sandbox principal: whoever the run executes AS (design U4/U8) — the
 * owner on their own chat, routine, task-API turn and profile generators, the
 * VIEWER on a colleague chat (trusted or not). Every class runs with pi's full
 * built-in tool set in THAT user's sandbox; the owner's data is reachable only
 * through the self-gating Noah MCP tools.
 *
 * An avatar CONSULTATION is nobody's run: the consulted avatar's persona,
 * knowledge-repo memory and recalled notes (another user's authored text, and
 * whatever third-party pages were captured into it) would otherwise drive a
 * shell over the ASKER's files, unattended. So it never runs in a user's
 * sandbox — `runPiAgent` gives each consultation a fresh, empty one of its
 * own ({@link beginPiConsultationSandbox}, user decision 2026-10-30) and this
 * function refuses the class, so no caller can quietly fall back to the asker.
 * Throws for an id pi-gateway does not accept (Noah's ids always are).
 */
export function piRunPrincipal(request: PiRunClass): string {
  if (request.avatarConsultation) {
    throw new Error("pi runtime: a consultation runs only in its own fresh sandbox (beginPiConsultationSandbox), never in a user's");
  }
  const principal = request.viewerUserId ?? request.avatar.id;
  if (!PI_USER_ID_PATTERN.test(principal)) {
    throw new Error("pi runtime: this user id is not accepted by pi-gateway");
  }
  return principal;
}

/** The principal form of a consultation's own sandbox: `consult-` + 24 random hex (no user id has this shape). */
export const PI_CONSULTATION_PRINCIPAL_PATTERN = /^consult-[0-9a-f]{24}$/;

/** Noah's own record of consultation sandboxes not yet removed (a crash leaves one; the boot sweeps it). */
function consultationRecordDir(config: AppConfig): string {
  return path.join(config.dataDir, "pi-consultation-sandboxes");
}

/**
 * A fresh, EMPTY sandbox for ONE avatar consultation: a principal no user has
 * (`consult-<random>`, accepted by pi's user-id pattern), so pi starts a new
 * sandbox container over a new `u-<key>` folder that holds neither the
 * asker's nor the consulted owner's files. The consulted avatar's knowledge
 * reaches it only through the Noah recall tools (gated by `viewerUserId` = the
 * asker and `avatar` = the target, exactly as before). Recorded under Noah's
 * data dir first, so a crash mid-run leaves something the boot can sweep.
 */
export function beginPiConsultationSandbox(config: AppConfig): string {
  const principal = `consult-${randomBytes(12).toString("hex")}`;
  try {
    fs.mkdirSync(consultationRecordDir(config), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(consultationRecordDir(config), principal), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn({ module: "agent", err: String(error) }, "pi runtime: could not record the consultation sandbox (it is still removed after the run)");
  }
  return principal;
}

/**
 * Remove a consultation's sandbox files once its run ended: the whole
 * `u-<key>` folder below `PI_WORKSPACES_DIR` (descriptor-pinned, never
 * following a link the sandbox planted), Noah's repo-copy records for it, then
 * the record. Best effort, never throws. pi's sandbox CONTAINER is not Noah's
 * to stop: sandboxd reaps it once idle (`SANDBOX_IDLE_SECONDS`, 15 min by
 * default), and nothing reuses the principal.
 */
export function endPiConsultationSandbox(config: AppConfig, principal: string): void {
  if (!PI_CONSULTATION_PRINCIPAL_PATTERN.test(principal)) return;
  try {
    deletePiUserWorkspace(config, principal);
    fs.rmSync(piRepoCopyStateDir(config, principal), { recursive: true, force: true });
    fs.rmSync(path.join(consultationRecordDir(config), principal), { force: true });
  } catch (error) {
    logger.warn({ module: "agent", err: String(error) }, "pi runtime: could not remove a consultation sandbox");
  }
}

/** Boot: remove every consultation sandbox a crash or restart left behind (its record survived). Best effort. */
export function sweepPiConsultationSandboxes(config: AppConfig): number {
  let names: string[];
  try {
    names = fs.readdirSync(consultationRecordDir(config));
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!PI_CONSULTATION_PRINCIPAL_PATTERN.test(name)) continue;
    endPiConsultationSandbox(config, name);
    swept += 1;
  }
  return swept;
}

/**
 * The work-folder key of a run WITHOUT a conversation: `run-ask` for an
 * avatar consultation (the only folder in its own fresh sandbox), else
 * `run-<scratch folder name>` (the intro/hashtag generators: `run-intro`,
 * `run-hashtags`), so repeated generator runs reuse ONE folder in the owner's
 * sandbox instead of piling up.
 */
export function piEphemeralRunKey(request: Pick<AgentRequest, "cwd" | "avatarConsultation">): string {
  if (request.avatarConsultation) return "run-ask";
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
