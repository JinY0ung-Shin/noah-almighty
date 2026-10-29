import path from "node:path";
import { safeConversationDir } from "./chatImages.js";
import logger from "./logger.js";
import { listEntries, openRetirementSweep } from "./retiredFiles.js";
import {
  isSessionId,
  quarantineConversationWorkspaceCopies,
  readRowKeyedPending,
  quarantineRowKeyed,
  serializePending,
  sweepNamedLeftovers,
  sweepSessionArtifacts,
  type PendingRetries,
} from "./retiredSessionFiles.js";
import type { Store } from "./store.js";
import type { RetiredPersonalAgentPurge } from "./store/retiredPersonalAgents.js";
import type { AppConfig } from "./types.js";

/**
 * Boot-time retirement of the removed 내 봇 (personal agents) feature: delete
 * every bot, bot thread, bot routine and everything they left on disk — the old
 * per-bot DELETE cascade applied to all bots at once, plus the bots' SDK
 * session transcripts. Boot calls it right after `createServices()`, before
 * the app is built, the server listens or the routine scheduler starts. The
 * users' `agents/<dir>/` memory folders live in their own knowledge repos and
 * are never touched.
 *
 * LIFECYCLE: it runs on every boot until ONE pass ends with nothing left
 * behind, which stamps the `retired:personal_agents` marker (`app_config`,
 * checked by existence). A boot returns at once only when the marker exists,
 * no pending retries are stored, and neither retired TABLE exists — an older
 * release booted after the stamp re-creates both, and with them bots and
 * bot-bound routines, so finding one runs the full retirement in that same
 * boot (its purge drops the marker; a clean finish stamps it again). That
 * re-run deletes everything under the `personal:` / `personal-` names, so
 * those prefixes, the two table names and `routine_jobs.personal_agent_id` stay
 * reserved FOREVER. A fresh install has nothing to do and is stamped silently
 * on its first boot.
 *
 * DISK FIRST, then the database — and the disk half QUARANTINES, never
 * deletes: every file is moved to `<dataDir>/retired/<boot stamp>/` at its
 * path relative to dataDir (`retiredFiles.ts`), and the DB is backed up to
 * `<dataDir>/backups/` before the first destructive step; a failed backup skips
 * this whole pass until a later boot (`store/retirementBackup.ts`).
 * Bot avatar images and workspace trees are
 * found by NAME prefix (never through row fields), on every boot that runs.
 * Files only the rows can name — each bot thread's chat media and SDK session
 * artifacts — are swept while those rows exist; whatever of them fails is kept
 * in a PENDING list (relative, exact-shape entries plus session ids whose
 * folders could not be listed), stored in the purge's own transaction and
 * retried on every later boot. The DB purge runs on EVERY pass that finds
 * rows, even when the sweep failed: a bot-bound routine must be gone before
 * the scheduler's first tick whatever the disk did. Any failure withholds the
 * marker (one warning per boot names the paths); the purge throws, failing
 * the boot loudly.
 */
export function retirePersonalAgents(deps: {
  config: AppConfig;
  store: Store;
}): RetiredPersonalAgentPurge | null {
  const { config, store } = deps;
  if (store.personalAgentsRetired()) {
    const tablesBack = store.retiredPersonalAgentTablesExist();
    if (!tablesBack && !store.retiredPersonalAgentPendingExists()) {
      return null;
    }
    if (tablesBack) {
      logger.warn("an older release recreated the retired personal-agent tables — retiring again");
    }
  }
  const sweep = openRetirementSweep(config.dataDir, store.retirementGate(), "personal-agent");
  if (!sweep) {
    return null;
  }
  const pending = readPending(config, store);
  const next: PendingRetries = { paths: new Set(), sessionIds: new Set() };
  for (const rel of pending.paths) {
    quarantineRowKeyed(config, rel, sweep, next);
  }
  const snapshot = store.snapshotRetiredPersonalAgents();
  const conversationIds = snapshot?.conversationIds ?? [];
  for (const conversationId of conversationIds) {
    const dir = safeConversationDir(conversationId);
    quarantineRowKeyed(config, `chat-images/${dir}`, sweep, next);
    quarantineRowKeyed(config, `chat-files/${dir}`, sweep, next);
  }
  const projectsRoot = path.join(config.agentSessionsDir, "projects");
  const projectEntries = listEntries(projectsRoot, sweep);
  const sessionIds = new Set([...(snapshot?.sessionIds ?? []).filter(isSessionId), ...pending.sessionIds]);
  sweepSessionArtifacts(config, [...sessionIds], projectEntries, sweep, next);
  sweepNamedLeftovers(
    config,
    { avatarPrefix: BOT_AVATAR_PREFIX, workspacePrefix: BOT_WORKSPACE_PREFIX },
    projectEntries,
    sweep,
  );
  // Server-written copies (attachments/captures/confluence), resolved by
  // thread id under EVERY avatar folder; best-effort, never throws. A thread's
  // own workspace went with its avatar's tree just above.
  quarantineConversationWorkspaceCopies(config, conversationIds, sweep);
  const pendingDocument = serializePending(next);
  const purge = snapshot ? store.purgeRetiredPersonalAgents(pendingDocument) : null;
  if (purge) {
    logger.warn({ ...purge }, "retired personal-agent data purged");
  }
  if (sweep.failures === 0) {
    guarded(
      "completion marker could not be stamped; the next boot repeats this (now cheap) pass",
      () => store.completePersonalAgentRetirement(new Date().toISOString()),
    );
    return purge;
  }
  if (!snapshot) {
    // Only rows a previous boot already purged can be pending here, so a
    // failed write leaves that boot's list — a superset of this one — in place.
    guarded(
      "pending retries could not be updated; the next boot retries the previous list",
      () => store.saveRetiredPersonalAgentPending(pendingDocument),
    );
  }
  logger.warn(
    { failures: sweep.failures, paths: sweep.sample },
    "retired personal-agent files could not be quarantined and were left in place; the retirement marker was NOT stamped, so the next boot retries — move these paths under retired/ by hand if this repeats",
  );
  return purge;
}

/**
 * A bot's avatar id always starts with this; so does its profile-image file.
 * Only a bot id carries these prefixes: user ids are UUIDs and every other
 * namespaced avatar uses its own (the retired `external:` / `group:`).
 */
const BOT_AVATAR_PREFIX = "personal:";
/** `workspaceDirFor` turns that id into a folder name starting with this. */
const BOT_WORKSPACE_PREFIX = "personal-";

/** A failed bookkeeping write only costs a cheap re-run; it never fails the boot. */
function guarded(consequence: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    logger.warn({ err }, `retired personal-agent ${consequence}`);
  }
}

/** The pending retries a previous boot stored (see `readRowKeyedPending`). */
function readPending(config: AppConfig, store: Store): { paths: string[]; sessionIds: string[] } {
  return readRowKeyedPending(config, () => store.retiredPersonalAgentPendingState(), "personal-agent");
}
