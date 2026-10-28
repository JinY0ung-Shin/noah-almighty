import fs from "node:fs";
import path from "node:path";
import logger from "./logger.js";
import type { AppConfig } from "./types.js";

/**
 * Boot-time cleanup after the removed Craft apps feature (the craft-runner
 * sidecar, removed 2026-10-29). Its only server-side disk state outside the
 * conversation trees was the retry queue of session purges a runner outage
 * left behind (`<dataDir>/runtime/craft-purge/`, one marker file per session);
 * with no runner to purge against it is dead weight. Nothing writes the folder
 * any more, so after the first boot this is a no-op — harmless when absent.
 * The app_config switch is dropped by the store migration; existing workspace
 * `craft/` folders are left as ordinary workspace files (they cannot be told
 * apart from an agent's own folder of that name) and go with their tree.
 * Best effort: never throws.
 */
export function retireCraftApps(config: Pick<AppConfig, "dataDir">): void {
  const dir = path.join(config.dataDir, "runtime", "craft-purge");
  try {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return;
    // rm never follows a symlink: a link here is unlinked, not recursed into.
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info("removed the retired Craft apps purge queue");
  } catch (err) {
    logger.warn({ err }, "could not remove the retired Craft apps purge queue");
  }
}
