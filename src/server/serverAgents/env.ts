import { DEFAULT_MODEL_TIER } from "../modelTiers.js";
import { GIT_CREDENTIAL_ENV_NAMES, SERVER_ONLY_SECRET_ENV_NAMES } from "../secretPolicy.js";
import type { Store } from "../store.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../store.js";
import type { AppConfig } from "../types.js";

// Mirrors runPlan's agentSubprocessEnv + subscription-auth block WITHOUT
// importing runPlan (it would import this module back through the agent tools).
// Both strip the same SERVER_ONLY_SECRET_ENV_NAMES list (secretPolicy.ts).

/**
 * The env a remote server-agent run starts from, built the SAME way runPlan
 * builds the local CLI's auth env (process.env minus git creds/SESSION_SECRET;
 * ANTHROPIC_API_KEY from .env wins, else the admin-stored subscription token as
 * CLAUDE_CODE_OAUTH_TOKEN). Never includes shell-exposed vault secrets.
 * remoteProcess.isForwardableRemoteEnv still filters what actually leaves Noah.
 */
export function serverAgentBaseEnv(store: Store, config: AppConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [...GIT_CREDENTIAL_ENV_NAMES, ...SERVER_ONLY_SECRET_ENV_NAMES]) {
    delete env[name];
  }
  if (!config.anthropicApiKey) {
    const oauthToken = store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    if (oauthToken) {
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  return env;
}

/** The model alias a run with no per-conversation pick uses (config pin > admin override > default tier). */
export function serverAgentDefaultModel(store: Store, config: AppConfig): string {
  return config.anthropicModel ?? store.getModelOverride() ?? DEFAULT_MODEL_TIER;
}
