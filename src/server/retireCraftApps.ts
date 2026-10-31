import path from "node:path";
import logger from "./logger.js";
import { openRetirementSweep, quarantineRetired } from "./retiredFiles.js";
import type { AppConfig } from "./types.js";

/**
 * Boot-time cleanup after the removed Craft apps feature (the craft-runner
 * sidecar, removed 2026-10-29). Its only server-side disk state outside the
 * conversation trees was the retry queue of session purges a runner outage
 * left behind (`<dataDir>/runtime/craft-purge/`, one marker file per session);
 * with no runner to purge against it is dead weight. It is QUARANTINED — moved
 * to `<dataDir>/retired/<boot stamp>/runtime/craft-purge` (a link moved as a
 * link), never deleted — and skipped whole on a boot whose pre-retirement DB
 * backup failed (`store/retirementBackup.ts`). Nothing writes the folder any
 * more, so after the first move this is a no-op — harmless when absent. The
 * app_config switch is dropped by the store migration; existing workspace
 * `craft/` folders are left as ordinary workspace files (they cannot be told
 * apart from an agent's own folder of that name) and go with their tree.
 * Best effort: never throws.
 */
export function retireCraftApps(deps: {
  config: Pick<AppConfig, "dataDir">;
  store: { retirementGate(): { allowed: boolean; stamp: string } };
}): void {
  const { config } = deps;
  const dir = path.join(config.dataDir, "runtime", "craft-purge");
  try {
    const sweep = openRetirementSweep(config.dataDir, deps.store.retirementGate(), "Craft apps");
    if (!sweep) return;
    if (!quarantineRetired(dir, sweep)) {
      logger.warn({ paths: sweep.sample }, "could not quarantine the retired Craft apps purge queue; left in place");
    }
  } catch (err) {
    logger.warn({ err }, "could not quarantine the retired Craft apps purge queue");
  }
}
