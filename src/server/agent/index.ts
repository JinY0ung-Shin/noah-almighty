import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import { runLocalAgent } from "./localRunner.js";
import type { AgentEvents } from "./events.js";
import { runPiAgent } from "./pi/runPiAgent.js";

export { isRetryableModelError } from "./runErrors.js";

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
 * Streaming agent run. `local` runtime → replay the deterministic stub through
 * onDelta; `pi` (the only agent runtime) → pi-gateway, for EVERY run class, in
 * the sandbox of the user the run executes as (`piRunPrincipal`).
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
  return runPiAgent(request, pluginRoots, config, store, events, abortController);
}
