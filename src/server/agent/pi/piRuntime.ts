/**
 * Process-level pieces of the pi runtime (`AGENT_RUNTIME=pi`,
 * docs/architecture/pi-runtime.md): which runs go to pi, and the run-token
 * registry + gateway client both the runner and the `/mcp` router share.
 */
import type { AgentRequest, AppConfig } from "../../types.js";
import type { Store } from "../../store.js";
import { McpRunRegistry } from "../../mcpHttp/endpoint.js";
import { deriveAgentToolAccess } from "../runCapabilities.js";
import { PI_USER_ID_PATTERN, createPiResponsesClient, type PiResponsesClient } from "./responsesClient.js";

/**
 * The request header pi forwards to its MCP broker, which renders it into each
 * Noah server's `Authorization: Bearer {{ctx.header:x-noah-run-token}}`
 * (`scripts/pi-register-mcp.mjs` writes that broker config).
 */
export const PI_RUN_TOKEN_HEADER = "x-noah-run-token";

export type PiRuntimeDecision = { supported: true; principal: string } | { supported: false; reason: string };

/**
 * Whether THIS run executes on pi (one decision, unit-pinned). pi has no
 * per-request tool allowlist yet (design P1), so a run class that must stay
 * READ-ONLY keeps the SDK runner, whose PreToolUse hook denies the write
 * built-ins: avatar consultations, an untrusted colleague, and the restricted
 * headless generators (intro/hashtags). Owner chat, trusted-colleague chat,
 * owner routines and task-API turns run on pi. A run with no conversation also
 * stays on the SDK: the frozen pi prompt and sessions are per conversation.
 */
export function piRuntimeSupports(request: AgentRequest): PiRuntimeDecision {
  if (request.avatarConsultation) {
    return { supported: false, reason: "avatar consultation (read-only; pi has no per-request tool allowlist)" };
  }
  const access = deriveAgentToolAccess(request);
  if (access.headless && !access.allowHeadlessTools) {
    return { supported: false, reason: "restricted headless task (read-only; pi has no per-request tool allowlist)" };
  }
  if (!access.elevatedToolAccess) {
    return { supported: false, reason: "untrusted colleague (read-only; pi has no per-request tool allowlist)" };
  }
  if (!request.conversationId) {
    return { supported: false, reason: "no conversation (pi sessions and the frozen prompt are per conversation)" };
  }
  // The sandbox principal is whoever the run executes AS (design U4).
  const principal = request.viewerUserId ?? request.avatar.id;
  if (!PI_USER_ID_PATTERN.test(principal)) {
    return { supported: false, reason: "user id not accepted by pi-gateway" };
  }
  return { supported: true, principal };
}

export interface PiServices {
  registry: McpRunRegistry;
  /** Null when the runtime is not configured (any runtime but `pi`). */
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
