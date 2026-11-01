import fs from "node:fs";
import path from "node:path";
import logger from "./logger.js";
import { PinnedDir, withPinnedDir } from "./pinnedFs.js";
import { listEntries, openRetirementSweep, quarantineRetired, recordFailure, errorCode, type SweepTally } from "./retiredFiles.js";
import { piUserKey } from "./agent/pi/piWorkspace.js";
import { piRepoCopyStateDir, piRepoOwnerSegment } from "./agent/pi/piRepoCopy.js";
import type { AppConfig } from "./types.js";

/** `app_config` key of the one-time completion marker (its value records when, for operators). */
export const PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY = "retired:pi_colleague_repo_copies";

/**
 * The quarantine folder for retired SANDBOX files, directly under
 * `PI_WORKSPACES_DIR`: on the sandbox volume (a rename, never a copy — the
 * data dir is another filesystem), yet never mounted into any sandbox, because
 * pi's sandboxd mounts only `u-<24 hex>` folders. Reserved FOREVER: no other
 * code writes or reads it, and Noah never prunes it (cleanup is the operator's).
 */
export const PI_WORKSPACES_QUARANTINE_DIR = ".noah-retired";

/**
 * Boot-time retirement of trusted colleagues' working-repo COPIES (review
 * #11, user decision 2026-11-01). Until then a trusted colleague's open_repo
 * (and their turn start) copied the avatar owner's whole repository — working
 * tree AND `.git`, history included — into the COLLEAGUE's persistent sandbox,
 * `u-<colleague>/repos/<owner-seg>/<name>`, where it outlived the trust that
 * made it (leaving the group, the owner's remove_repo, the owner's deletion).
 * Colleagues now read the owner's clone through the git_repo read tools and no
 * copy is made, so the existing ones go: every `repos/<seg>` folder of a
 * user's sandbox whose `<seg>` is not that user's own is MOVED (one no-follow
 * rename through pinned folders, never followed, never deleted) to
 * `<PI_WORKSPACES_DIR>/.noah-retired/<boot stamp>/u-<key>/repos/<seg>`, out of
 * every sandbox's reach, and the matching Noah-side records
 * (`<dataDir>/pi-repo-copies/u-<key>/<seg>--<name>.json`) go to the data dir's
 * own quarantine (`quarantineRetired`). The pass is skipped whole on a boot
 * whose pre-retirement DB backup failed (`retirementGate`); a clean pass
 * stamps the marker, a failed move is logged and retried next boot. Users'
 * own copies (`repos/<own seg>`) are never touched. Best effort: never throws.
 */
export function retirePiColleagueRepoCopies(deps: {
  config: Pick<AppConfig, "dataDir" | "pi">;
  store: {
    retirementGate(): { allowed: boolean; stamp: string };
    getAppSecret(key: string): string | null;
    setAppSecret(key: string, value: string): void;
    listUsers(): { id: string }[];
  };
}): void {
  const { config, store } = deps;
  const workspacesDir = config.pi?.workspacesDir;
  try {
    if (!workspacesDir || store.getAppSecret(PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY)) return;
    const sweep = openRetirementSweep(config.dataDir, store.retirementGate(), "colleague working-repo copy");
    if (!sweep) return;
    let moved = 0;
    withPinnedDir(PinnedDir.open(workspacesDir), (top) => {
      if (!top) return;
      for (const user of store.listUsers()) {
        moved += quarantineForeignCopies(top, piUserKey(user.id), piRepoOwnerSegment(user.id), sweep);
        quarantineForeignRecords(config, user.id, sweep);
      }
    });
    if (sweep.failures > 0) {
      logger.warn(
        { paths: sweep.sample, failures: sweep.failures },
        "could not quarantine every retired colleague working-repo copy; left in place, retried next boot",
      );
      return;
    }
    if (moved > 0) {
      logger.warn(
        { count: moved, quarantine: path.join(workspacesDir, PI_WORKSPACES_QUARANTINE_DIR, sweep.quarantine.stamp) },
        "moved trusted colleagues' copies of other users' repositories out of their sandboxes (Noah never deletes them; remove by hand once satisfied)",
      );
    }
    store.setAppSecret(PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY, new Date().toISOString());
  } catch (err) {
    logger.warn({ err }, "could not quarantine the retired colleague working-repo copies");
  }
}

/** Move every `repos/<seg>` folder of one user's sandbox that is not their own; returns how many moved. */
function quarantineForeignCopies(top: PinnedDir, key: string, ownSeg: string, sweep: SweepTally): number {
  return withPinnedDir(top.dir([key, "repos"]), (repos) => {
    if (!repos) return 0; // no sandbox, no repos/, or a link there (never followed)
    let entries: fs.Dirent[];
    try {
      entries = repos.list();
    } catch (err) {
      recordFailure(sweep, path.join(repos.hostPath), errorCode(err));
      return 0;
    }
    const foreign = entries.filter((entry) => entry.isDirectory() && entry.name !== ownSeg && !entry.name.startsWith("."));
    if (foreign.length === 0) return 0;
    return withPinnedDir(
      top.dir([PI_WORKSPACES_QUARANTINE_DIR, sweep.quarantine.stamp, key, "repos"], { create: true, mode: 0o700 }),
      (target) => {
        if (!target) {
          recordFailure(sweep, path.join(top.hostPath, PI_WORKSPACES_QUARANTINE_DIR), "QUARANTINE_PATH_NOT_A_FOLDER");
          return 0;
        }
        let count = 0;
        for (const entry of foreign) {
          let name = entry.name;
          for (let index = 2; target.kind(name) !== "missing" && index < 1000; index += 1) name = `${entry.name}-${index}`;
          try {
            // Both ends through pinned descriptors: one rename(2) on the sandbox volume, the entry itself never followed.
            fs.renameSync(repos.entry(entry.name), target.entry(name));
            count += 1;
          } catch (err) {
            recordFailure(sweep, repos.hostEntry(entry.name), errorCode(err));
          }
        }
        return count;
      },
    );
  });
}

/** Quarantine a user's Noah-side copy records of OTHER owners' repos (`<seg>--<name>.json`, `<seg>` not their own). */
function quarantineForeignRecords(config: Pick<AppConfig, "dataDir">, userId: string, sweep: SweepTally): void {
  const dir = piRepoCopyStateDir(config, userId);
  const entries = listEntries(dir, sweep);
  if (!entries) return;
  const ownPrefix = `${piRepoOwnerSegment(userId)}--`;
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && entry.name.includes("--") && !entry.name.startsWith(ownPrefix)) {
      quarantineRetired(path.join(dir, entry.name), sweep);
    }
  }
}
