import logger from "./logger.js";
import { openRetirementSweep, quarantineRetired } from "./retiredFiles.js";
import type { AppConfig } from "./types.js";

/** `app_config` key of the one-time completion marker (its value records when, for operators). */
export const AGENT_SESSIONS_RETIRED_KEY = "retired:agent_sessions";

/**
 * Boot-time retirement of `<dataDir>/agent-sessions` (2026-10-29): the removed
 * Claude Agent SDK runner's `CLAUDE_CONFIG_DIR` — every CLI session transcript,
 * its debug logs and todos. pi-gateway keeps its own sessions, and an old SDK
 * session id is simply ignored (the next turn starts a pi session from the
 * stored text history), so nothing reads the folder any more. It is
 * QUARANTINED — moved whole to `<dataDir>/retired/<boot stamp>/agent-sessions`
 * (one no-follow rename, a link moved as a link), never deleted — and skipped
 * on a boot whose pre-retirement DB backup failed. Runs AFTER the other
 * retirements, which quarantine their own transcripts from inside it first.
 * A clean pass (moved, or nothing there) stamps the marker, so later boots skip
 * the step even if an older release recreated the folder; a refused move is
 * logged and retried next boot. Best effort: never throws.
 */
export function retireAgentSessions(deps: {
  config: Pick<AppConfig, "agentSessionsDir" | "dataDir">;
  store: {
    retirementGate(): { allowed: boolean; stamp: string };
    getAppSecret(key: string): string | null;
    setAppSecret(key: string, value: string): void;
  };
}): void {
  const { config, store } = deps;
  try {
    if (store.getAppSecret(AGENT_SESSIONS_RETIRED_KEY)) return;
    const sweep = openRetirementSweep(config.dataDir, store.retirementGate(), "CLI session transcript");
    if (!sweep) return;
    if (!quarantineRetired(config.agentSessionsDir, sweep)) {
      logger.warn(
        { paths: sweep.sample },
        "could not quarantine the retired CLI session transcripts (agent-sessions); left in place, retried next boot",
      );
      return;
    }
    store.setAppSecret(AGENT_SESSIONS_RETIRED_KEY, new Date().toISOString());
  } catch (err) {
    logger.warn({ err }, "could not quarantine the retired CLI session transcripts (agent-sessions)");
  }
}
