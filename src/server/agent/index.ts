import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import { runLocalAgentStream } from "./localRunner.js";
import type { AgentEvents } from "./events.js";
import { runPiAgent } from "./pi/runPiAgent.js";

export { isRetryableModelError } from "./runErrors.js";

/**
 * Streaming agent run. `local` runtime → the deterministic stub (echo, or a
 * scripted `demo` scenario); `pi` (the only agent runtime) → pi-gateway, for EVERY run class, in
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
    // The scripted demo runtime (localRunner.ts): the default is still the echo,
    // `demo <name>` replays a scenario through the same events a real run uses.
    return runLocalAgentStream(request, events, abortController);
  }
  return runPiAgent(request, pluginRoots, config, store, events, abortController);
}
