import { type Constructor, type StoreBase } from "./internal.js";

/**
 * RETIREMENT of the removed group shared agents (team avatars that were not
 * users rows, removed 2026-10-29) — the store half of
 * `src/server/retireGroupAgents.ts`, which boot runs before the server listens
 * or the routine scheduler starts, on every boot until ONE clean pass stamps
 * the completion marker.
 *
 * A deployment that ran the feature still holds its data: the `group_agents`
 * table (persona, profile, capture policy, image extension) and every
 * member's thread with an agent — conversations whose avatar id is
 * `group:<groupId>:<agentId>` (or the pre-multi `group:<groupId>` a very old
 * release wrote) with their messages, canvases, share links and SDK session
 * ids. The pi migration's decision (D4) is to delete ALL of it. No surviving
 * code can create any of that, so the predicates below only ever match legacy
 * rows — and they must keep it that way: the `group:` avatar prefix (and the
 * `group-` folder prefix it becomes on disk), the table names `group_agents` /
 * `group_agents_legacy` and the index `idx_group_agents_group` are reserved
 * FOREVER. A marked boot still checks that the table does not exist, because
 * an older release booted after the stamp re-creates it (and could then write
 * new agent threads), and finding it re-runs the full retirement. Groups
 * themselves, their members, knowledge repositories and audit rows
 * (`group_agent_*` actions) are untouched.
 *
 * The marker is an `app_config` row written through the ordinary writer (its
 * encrypted value is just the stamp time) but read by EXISTENCE only, so a
 * SESSION_SECRET rotation can never un-mark a finished deployment. A second
 * row holds the PENDING retries — files only the rows could name, which a
 * failed sweep must still be able to find after the purge drops those rows.
 */

/** The public avatar-id namespace of the retired group agents. */
const GROUP_AGENT_AVATAR_PREFIX = "group:";
/** The retired table (re-created by any older release's migrate). */
const GROUP_AGENT_TABLE = "group_agents";
/** The transient rebuild table an interrupted pre-multi migration could leave. */
const GROUP_AGENT_LEGACY_TABLE = "group_agents_legacy";

/** `app_config` key of the one-time completion marker. */
const RETIREMENT_MARKER_KEY = "retired:group_agents";
/** `app_config` key of the pending retries (a JSON document only the disk half reads). */
const RETIREMENT_PENDING_KEY = "retired:group_agents:pending";

/**
 * An exact, case-sensitive prefix test on an avatar-id column. LIKE would be
 * case-insensitive and treat `_` as a wildcard; ids are server-minted UUIDs or
 * namespaced (the retired `personal:` / `external:`), so only a group-agent id
 * can start with this.
 */
function groupAgentAvatarSql(column: string): string {
  return `substr(${column}, 1, ${GROUP_AGENT_AVATAR_PREFIX.length}) = '${GROUP_AGENT_AVATAR_PREFIX}'`;
}

/**
 * What the disk half sweeps BEFORE the rows that name the files are purged.
 * Agent avatar images and workspace trees are found by NAME prefix instead,
 * never through row fields.
 */
export interface RetiredGroupAgentSnapshot {
  /** Every conversation bound to a group-agent avatar id. */
  conversationIds: string[];
  /**
   * Every SDK session id those threads recorded — the conversation's own plus
   * each message's (rewind and /compact forks mint new ones). Raw DB values:
   * the disk half validates their shape before building any path from them.
   */
  sessionIds: string[];
}

/** What the purge removed (for the boot log). */
export interface RetiredGroupAgentPurge {
  agents: number;
  conversations: number;
  messages: number;
  routines: number;
  notifications: number;
}

export function withRetiredGroupAgents<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class RetiredGroupAgents extends Base {
    private groupAgentRetirementRowExists(key: string): boolean {
      return Boolean(this.db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(key));
    }

    private retiredGroupAgentTable(table: string): boolean {
      return Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table),
      );
    }

    /**
     * Whether a clean retirement pass already ran here. Existence only — the
     * value is encrypted under SESSION_SECRET, and a rotation must not un-mark.
     */
    groupAgentsRetired(): boolean {
      return this.groupAgentRetirementRowExists(RETIREMENT_MARKER_KEY);
    }

    /** A retired table exists — on a marked DB, an older release re-created it. */
    retiredGroupAgentTablesExist(): boolean {
      return (
        this.retiredGroupAgentTable(GROUP_AGENT_TABLE) ||
        this.retiredGroupAgentTable(GROUP_AGENT_LEGACY_TABLE)
      );
    }

    /** Whether pending retries are stored — existence only, like the marker. */
    retiredGroupAgentPendingExists(): boolean {
      return this.groupAgentRetirementRowExists(RETIREMENT_PENDING_KEY);
    }

    /** The pending-retry document as stored (missing, unreadable, or its text). */
    retiredGroupAgentPendingState():
      | { status: "missing" }
      | { status: "unreadable" }
      | { status: "ok"; value: string } {
      return this.getAppSecretState(RETIREMENT_PENDING_KEY);
    }

    /** Store the pending-retry document; null removes the row. */
    saveRetiredGroupAgentPending(value: string | null): void {
      if (value === null) {
        this.deleteAppSecret(RETIREMENT_PENDING_KEY);
      } else {
        this.setAppSecret(RETIREMENT_PENDING_KEY, value);
      }
    }

    /**
     * Finish: clear the pending retries and stamp the completion marker in ONE
     * transaction, so a stamped marker never sits next to a pending list. The
     * marker's value only records when, for operators.
     */
    completeGroupAgentRetirement(at: string): void {
      this.db.transaction(() => {
        this.deleteAppSecret(RETIREMENT_PENDING_KEY);
        this.setAppSecret(RETIREMENT_MARKER_KEY, at);
      })();
    }

    /**
     * Read-only snapshot of what is left to retire, or null when nothing is (a
     * fresh DB, or one whose purge already ran): agent threads, rows keyed by a
     * group-agent avatar id, the retired tables.
     */
    snapshotRetiredGroupAgents(): RetiredGroupAgentSnapshot | null {
      const threads = this.db
        .prepare(`SELECT id FROM conversations WHERE ${groupAgentAvatarSql("avatar_user_id")}`)
        .all() as { id: string }[];
      const keyedRows =
        this.count(`SELECT COUNT(*) AS c FROM routine_jobs WHERE ${groupAgentAvatarSql("avatar_user_id")}`) +
        this.count(`SELECT COUNT(*) AS c FROM avatar_notifications WHERE ${groupAgentAvatarSql("avatar_user_id")}`) +
        this.count(`SELECT COUNT(*) AS c FROM knowledge_requests WHERE ${groupAgentAvatarSql("avatar_user_id")}`);
      if (threads.length === 0 && keyedRows === 0 && !this.retiredGroupAgentTablesExist()) {
        return null;
      }
      const sessions = this.db
        .prepare(
          `SELECT agent_session_id AS id FROM conversations
             WHERE ${groupAgentAvatarSql("avatar_user_id")} AND agent_session_id IS NOT NULL
           UNION
           SELECT m.sdk_session_id AS id FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE ${groupAgentAvatarSql("c.avatar_user_id")} AND m.sdk_session_id IS NOT NULL`,
        )
        .all() as { id: string }[];
      return {
        conversationIds: threads.map((thread) => thread.id),
        sessionIds: sessions.map((session) => session.id),
      };
    }

    /**
     * Delete every retired row and drop the retired tables in ONE transaction:
     * each agent thread gets `deleteConversation`'s cascade (canvases, share
     * links, messages, task-API rows, the conversation) plus the notifications
     * and routines pointing into it; then anything else keyed by a group-agent
     * avatar id, and the tables (their index goes with them). The same
     * transaction stores `pendingDocument` (null clears it) — the files this
     * sweep failed to remove are named only by the rows deleted here, so the
     * two commit together or not at all — and drops the completion marker,
     * which a re-retirement must not keep: only the caller's clean finish
     * stamps it again. Throws on failure, so the caller can fail the boot
     * instead of serving half-retired data.
     */
    purgeRetiredGroupAgents(pendingDocument: string | null): RetiredGroupAgentPurge {
      const tx = this.db.transaction((): RetiredGroupAgentPurge => {
        const purge: RetiredGroupAgentPurge = {
          agents: this.retiredGroupAgentTable(GROUP_AGENT_TABLE)
            ? this.count(`SELECT COUNT(*) AS c FROM ${GROUP_AGENT_TABLE}`)
            : 0,
          conversations: 0,
          messages: 0,
          routines: 0,
          notifications: 0,
        };
        const threadIds = (
          this.db
            .prepare(`SELECT id FROM conversations WHERE ${groupAgentAvatarSql("avatar_user_id")}`)
            .all() as { id: string }[]
        ).map((row) => row.id);
        const deleteMessages = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
        const deleteAvatarTasks = this.db.prepare("DELETE FROM avatar_tasks WHERE conversation_id = ?");
        const deleteNotifications = this.db.prepare(
          "DELETE FROM avatar_notifications WHERE conversation_id = ?",
        );
        const deleteThreadRoutines = this.db.prepare("DELETE FROM routine_jobs WHERE conversation_id = ?");
        const deleteConversation = this.db.prepare("DELETE FROM conversations WHERE id = ?");
        for (const id of threadIds) {
          this.deleteCanvasArtifactsForConversation(id);
          this.deleteShareLinksForConversation(id);
          purge.messages += deleteMessages.run(id).changes;
          deleteAvatarTasks.run(id);
          purge.notifications += deleteNotifications.run(id).changes;
          purge.routines += deleteThreadRoutines.run(id).changes;
          purge.conversations += deleteConversation.run(id).changes;
        }
        // Rows keyed by a group-agent avatar id rather than an agent thread.
        // The feature never wrote any (routines, notifications and knowledge
        // requests target personal avatars) — swept anyway so the namespace
        // leaves nothing behind.
        purge.routines += this.db
          .prepare(`DELETE FROM routine_jobs WHERE ${groupAgentAvatarSql("avatar_user_id")}`)
          .run().changes;
        purge.notifications += this.db
          .prepare(`DELETE FROM avatar_notifications WHERE ${groupAgentAvatarSql("avatar_user_id")}`)
          .run().changes;
        this.db
          .prepare(`DELETE FROM knowledge_requests WHERE ${groupAgentAvatarSql("avatar_user_id")}`)
          .run();
        this.db.exec(`DROP TABLE IF EXISTS ${GROUP_AGENT_LEGACY_TABLE}`);
        this.db.exec(`DROP TABLE IF EXISTS ${GROUP_AGENT_TABLE}`);
        this.db.exec("DROP INDEX IF EXISTS idx_group_agents_group");
        this.saveRetiredGroupAgentPending(pendingDocument);
        this.deleteAppSecret(RETIREMENT_MARKER_KEY);
        return purge;
      });
      return tx();
    }
  };
}
