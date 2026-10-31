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
import type { RetiredGroupAgentPurge } from "./store/retiredGroupAgents.js";
import type { AppConfig } from "./types.js";

/**
 * Boot-time retirement of the removed group shared agents (removed
 * 2026-10-29, pi migration decision D4: their history is deleted, not kept):
 * every member's thread with an agent (`group:<groupId>:<agentId>`, or the
 * pre-multi `group:<groupId>`) with its messages, canvases, share links,
 * chat media, workspace copies and SDK session artifacts, the agents' profile
 * images and workspace trees, and the `group_agents` table. Boot calls it
 * right after the external-avatar retirement, before the app is built, the
 * server listens or the routine scheduler starts. Groups themselves, their
 * members and knowledge repositories (what the agents' second brain was) are
 * never touched.
 *
 * LIFECYCLE: it runs on every boot until ONE pass ends with nothing left
 * behind, which stamps the `retired:group_agents` marker (`app_config`,
 * checked by existence). A boot returns at once only when the marker exists,
 * no pending retries are stored, and no retired TABLE exists — an older
 * release booted after the stamp re-creates `group_agents` (and could write
 * new agent threads), so finding it runs the full retirement in that same
 * boot. That re-run deletes everything under the `group:` / `group-` names,
 * so those prefixes and the table names stay reserved FOREVER. A fresh
 * install has nothing to do and is stamped silently on its first boot.
 *
 * DISK FIRST, then the database — the personal-agent retirement's shape
 * (`retiredSessionFiles.ts`), quarantining (moving under `retired/<boot
 * stamp>/`), never deleting, after a DB backup (`store/retirementBackup.ts`). Agent avatar images (`avatars/group:…`),
 * workspace trees (`workspaces/group-…`) and the SDK project folders of runs
 * whose cwd was one of those trees are found by NAME prefix, on every boot
 * that runs. Files only the rows can name — each thread's chat media and SDK
 * session artifacts — are swept while those rows exist; whatever of them fails
 * is kept in a PENDING list stored in the purge's own transaction and retried
 * on every later boot. The DB purge runs on every pass that finds rows, even
 * when the sweep failed: the history must go whatever the disk did. Any
 * failure withholds the marker (one warning per boot names the paths); the
 * purge throws, failing the boot loudly.
 */
export function retireGroupAgents(deps: {
  config: AppConfig;
  store: Store;
}): RetiredGroupAgentPurge | null {
  const { config, store } = deps;
  if (store.groupAgentsRetired()) {
    const tablesBack = store.retiredGroupAgentTablesExist();
    if (!tablesBack && !store.retiredGroupAgentPendingExists()) {
      return null;
    }
    if (tablesBack) {
      logger.warn("an older release recreated the retired group-agent table — retiring again");
    }
  }
  const sweep = openRetirementSweep(config.dataDir, store.retirementGate(), "group-agent");
  if (!sweep) {
    return null;
  }
  const pending = readRowKeyedPending(
    config,
    () => store.retiredGroupAgentPendingState(),
    "group-agent",
  );
  const next: PendingRetries = { paths: new Set(), sessionIds: new Set() };
  for (const rel of pending.paths) {
    quarantineRowKeyed(config, rel, sweep, next);
  }
  const snapshot = store.snapshotRetiredGroupAgents();
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
    { avatarPrefix: GROUP_AGENT_AVATAR_PREFIX, workspacePrefix: GROUP_AGENT_WORKSPACE_PREFIX },
    projectEntries,
    sweep,
  );
  // Server-written copies (attachments/captures/confluence), resolved by
  // thread id under EVERY avatar folder; best-effort, never throws. A thread's
  // own workspace went with its avatar's tree just above.
  quarantineConversationWorkspaceCopies(config, conversationIds, sweep);
  const pendingDocument = serializePending(next);
  const purge = snapshot ? store.purgeRetiredGroupAgents(pendingDocument) : null;
  if (purge) {
    logger.warn({ ...purge }, "retired group-agent data purged");
  }
  if (sweep.failures === 0) {
    guarded(
      "completion marker could not be stamped; the next boot repeats this (now cheap) pass",
      () => store.completeGroupAgentRetirement(new Date().toISOString()),
    );
    return purge;
  }
  if (!snapshot) {
    // Only rows a previous boot already purged can be pending here, so a
    // failed write leaves that boot's list — a superset of this one — in place.
    guarded(
      "pending retries could not be updated; the next boot retries the previous list",
      () => store.saveRetiredGroupAgentPending(pendingDocument),
    );
  }
  logger.warn(
    { failures: sweep.failures, paths: sweep.sample },
    "retired group-agent files could not be quarantined and were left in place; the retirement marker was NOT stamped, so the next boot retries — move these paths under retired/ by hand if this repeats",
  );
  return purge;
}

/**
 * A group agent's avatar id always starts with this; so does its
 * profile-image file. Only a group-agent id carries these prefixes: user ids
 * are UUIDs and every other namespaced avatar uses its own (the retired
 * `personal:` / `external:`).
 */
const GROUP_AGENT_AVATAR_PREFIX = "group:";
/** `workspaceDirFor` turns that id into a folder name starting with this. */
const GROUP_AGENT_WORKSPACE_PREFIX = "group-";

/** A failed bookkeeping write only costs a cheap re-run; it never fails the boot. */
function guarded(consequence: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    logger.warn({ err }, `retired group-agent ${consequence}`);
  }
}
