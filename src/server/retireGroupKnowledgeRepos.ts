import path from "node:path";
import logger from "./logger.js";
import { openRetirementSweep, quarantineRetired } from "./retiredFiles.js";
import type { AppConfig } from "./types.js";

/** `app_config` key of the one-time completion marker (its value records when, for operators). */
export const GROUP_KNOWLEDGE_REPOS_RETIRED_KEY = "retired:group_knowledge_repos";

/**
 * The clone folder of the retired group knowledge repositories. Reserved
 * FOREVER: nothing may write `<dataDir>/group-knowledge` again.
 */
export const RETIRED_GROUP_KNOWLEDGE_DIR = "group-knowledge";

/**
 * Boot-time retirement of the group knowledge repositories (removed
 * 2026-10-30, user decision: groups stay only as the avatar-sharing / trust /
 * skill-sharing unit). Their server-side state was Noah's working clones,
 * `<dataDir>/group-knowledge/<groupId>`, one per connected group — possibly a
 * private repository's full clone, with commits a failed push left unpushed.
 * The whole folder is QUARANTINED — moved to
 * `<dataDir>/retired/<boot stamp>/group-knowledge` (one no-follow rename, a
 * link moved as a link), never deleted — and skipped on a boot whose
 * pre-retirement DB backup failed. The remote repositories are never touched;
 * the DB columns (`groups.knowledge_*` and the group-knowledge OFF-sets) are
 * dropped by the store migration behind the same gate (`RETIRED_COLUMNS`).
 * A clean pass (moved, or nothing there) stamps the marker, so later boots
 * skip the step; a refused move (EXDEV included) is logged and retried next
 * boot. Best effort: never throws.
 */
export function retireGroupKnowledgeRepos(deps: {
  config: Pick<AppConfig, "dataDir">;
  store: {
    retirementGate(): { allowed: boolean; stamp: string };
    getAppSecret(key: string): string | null;
    setAppSecret(key: string, value: string): void;
  };
}): void {
  const { config, store } = deps;
  try {
    if (store.getAppSecret(GROUP_KNOWLEDGE_REPOS_RETIRED_KEY)) return;
    const sweep = openRetirementSweep(config.dataDir, store.retirementGate(), "group knowledge repository");
    if (!sweep) return;
    if (!quarantineRetired(path.join(config.dataDir, RETIRED_GROUP_KNOWLEDGE_DIR), sweep)) {
      logger.warn(
        { paths: sweep.sample },
        "could not quarantine the retired group knowledge repository clones (group-knowledge); left in place, retried next boot",
      );
      return;
    }
    store.setAppSecret(GROUP_KNOWLEDGE_REPOS_RETIRED_KEY, new Date().toISOString());
  } catch (err) {
    logger.warn({ err }, "could not quarantine the retired group knowledge repository clones (group-knowledge)");
  }
}
