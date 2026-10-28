import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import { runClaudeAgent } from "./claudeAgent.js";
import { runLocalAgent } from "./localRunner.js";
import type { AgentEvents } from "./events.js";
import logger from "../logger.js";
import { piRuntimeSupports } from "./pi/piRuntime.js";
import { runPiAgent } from "./pi/runPiAgent.js";

export { isRetryableModelError } from "./claudeAgent.js";

const LOCAL_CHUNK_SIZE = 40;

/** Chunk text into ~40-codepoint slices and emit each via onDelta. */
function streamLocalText(text: string, events: AgentEvents): void {
  if (!events.onDelta || !text) {
    return;
  }
  const codePoints = Array.from(text);
  for (let index = 0; index < codePoints.length; index += LOCAL_CHUNK_SIZE) {
    events.onDelta(codePoints.slice(index, index + LOCAL_CHUNK_SIZE).join(""));
  }
}

/**
 * Streaming agent run. local runtime → replay the deterministic stub through
 * onDelta; claude runtime → forward the events sink to the SDK for token-level
 * streaming; pi runtime → pi-gateway for the run classes it supports
 * (`piRuntimeSupports`), the SDK runner for the read-only rest.
 */
export async function runAgentStream(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  if (config.agentRuntime === "local") {
    events.onStatus?.("응답 생성 중…");
    const response = runLocalAgent(request);
    streamLocalText(response.text, events);
    return response;
  }
  if (config.agentRuntime === "pi") {
    const decision = piRuntimeSupports(request);
    if (decision.supported) {
      return runPiAgent(request, pluginRoots, config, store, events, abortController);
    }
    logger.info(
      { module: "agent", avatarId: request.avatar.id, conversationId: request.conversationId ?? null, reason: decision.reason },
      "pi runtime: this run stays on the Claude Agent SDK runner",
    );
  }
  return runClaudeAgent(request, pluginRoots, config, store, events, abortController);
}
