import { type Constructor, type StoreBase } from "./internal.js";

/**
 * RETIREMENT of the removed 내 봇 (personal agents) feature — the store half of
 * `src/server/retirePersonalAgents.ts`, which boot runs before the server
 * listens or the routine scheduler starts, on every boot until ONE clean pass
 * stamps the completion marker.
 *
 * A deployment that ran the feature still holds its data: the
 * `personal_agents` / `bot_tasks` tables, every bot thread (conversations whose
 * avatar id is `personal:<ownerUserId>:<agentId>`, bot routine threads
 * included) with its messages, canvases, share links and SDK session ids, and
 * bot-bound routines (`routine_jobs.personal_agent_id`). No surviving code can
 * create any of that, so the predicates below only ever match legacy rows —
 * and they must keep it that way: the two TABLE NAMES, the `personal:` avatar
 * prefix (and the `personal-` folder prefix it becomes on disk) and the
 * routine column are reserved FOREVER. A marked boot still checks that
 * neither table exists, because an older release booted after the stamp
 * re-creates both (and with them bots and bot-bound routines), and finding one
 * re-runs the full retirement, which deletes everything under those names.
 * The bots' memory folders (`agents/<dir>/` in the owners' knowledge repos)
 * are the users' own git content and are never touched.
 *
 * The marker is an `app_config` row written through the ordinary writer (its
 * encrypted value is just the stamp time) but read by EXISTENCE only, so a
 * SESSION_SECRET rotation can never un-mark a finished deployment. A second
 * row holds the PENDING retries — files only the rows could name, which a
 * failed sweep must still be able to find after the purge drops those rows.
 *
 * A bot-bound routine row MUST be gone before the scheduler's first tick: the
 * scheduler no longer knows the column, so it would fire the row as the
 * OWNER's main avatar.
 */

/** The public avatar-id namespace of the retired bots. */
const BOT_AVATAR_PREFIX = "personal:";

/** `app_config` key of the one-time completion marker. */
const RETIREMENT_MARKER_KEY = "retired:personal_agents";
/** `app_config` key of the pending retries (a JSON document only the disk half reads). */
const RETIREMENT_PENDING_KEY = "retired:personal_agents:pending";

/**
 * An exact, case-sensitive prefix test on an avatar-id column. LIKE would be
 * case-insensitive and treat `_` as a wildcard; ids are server-minted UUIDs or
 * namespaced (`external:`, `group:`), so only a bot id can start with this.
 */
function botAvatarSql(column: string): string {
  return `substr(${column}, 1, ${BOT_AVATAR_PREFIX.length}) = '${BOT_AVATAR_PREFIX}'`;
}

/**
 * What the disk half sweeps BEFORE the rows that name the files are purged.
 * Bot avatar images and workspace trees are found by NAME prefix instead, never
 * through row fields.
 */
export interface RetiredPersonalAgentSnapshot {
  /** Every conversation bound to a bot avatar id — chats and routine threads. */
  conversationIds: string[];
  /**
   * Every SDK session id those threads recorded — the conversation's own plus
   * each message's (rewind and /compact forks mint new ones). Raw DB values:
   * the disk half validates their shape before building any path from them.
   */
  sessionIds: string[];
}

/** What the purge removed (for the boot log). */
export interface RetiredPersonalAgentPurge {
  bots: number;
  tasks: number;
  conversations: number;
  messages: number;
  routines: number;
  notifications: number;
}

export function withRetiredPersonalAgents<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class RetiredPersonalAgents extends Base {
    private retiredTableExists(table: string): boolean {
      return Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table),
      );
    }

    /** Old DBs carry `routine_jobs.personal_agent_id`; a fresh DB never had it. */
    private routineBotColumnExists(): boolean {
      const cols = this.db.prepare("PRAGMA table_info(routine_jobs)").all() as {
        name: string;
      }[];
      return cols.some((c) => c.name === "personal_agent_id");
    }

    /**
     * Whether a clean retirement pass already ran here. Existence only — the
     * value is encrypted under SESSION_SECRET, and a rotation must not un-mark.
     */
    personalAgentsRetired(): boolean {
      return Boolean(
        this.db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(RETIREMENT_MARKER_KEY),
      );
    }

    /**
     * Finish: clear the pending retries and stamp the completion marker in ONE
     * transaction, so a stamped marker never sits next to a pending list. The
     * marker's value only records when, for operators.
     */
    completePersonalAgentRetirement(at: string): void {
      this.db.transaction(() => {
        this.deleteAppSecret(RETIREMENT_PENDING_KEY);
        this.setAppSecret(RETIREMENT_MARKER_KEY, at);
      })();
    }

    /** Either retired table exists — on a marked DB, an older release re-created it. */
    retiredPersonalAgentTablesExist(): boolean {
      return this.retiredTableExists("personal_agents") || this.retiredTableExists("bot_tasks");
    }

    /** Whether pending retries are stored — existence only, like the marker. */
    retiredPersonalAgentPendingExists(): boolean {
      return Boolean(
        this.db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(RETIREMENT_PENDING_KEY),
      );
    }

    /** The pending-retry document as stored (missing, unreadable, or its text). */
    retiredPersonalAgentPendingState():
      | { status: "missing" }
      | { status: "unreadable" }
      | { status: "ok"; value: string } {
      return this.getAppSecretState(RETIREMENT_PENDING_KEY);
    }

    /** Store the pending-retry document; null removes the row. */
    saveRetiredPersonalAgentPending(value: string | null): void {
      if (value === null) {
        this.deleteAppSecret(RETIREMENT_PENDING_KEY);
      } else {
        this.setAppSecret(RETIREMENT_PENDING_KEY, value);
      }
    }

    /**
     * Read-only snapshot of the rows left to retire, or null when there are
     * none (a fresh DB, or one whose purge already ran).
     */
    snapshotRetiredPersonalAgents(): RetiredPersonalAgentSnapshot | null {
      const hasAgents = this.retiredTableExists("personal_agents");
      const hasTasks = this.retiredTableExists("bot_tasks");
      const boundRoutines = this.routineBotColumnExists()
        ? this.count("SELECT COUNT(*) AS c FROM routine_jobs WHERE personal_agent_id IS NOT NULL")
        : 0;
      const threads = this.db
        .prepare(`SELECT id FROM conversations WHERE ${botAvatarSql("avatar_user_id")}`)
        .all() as { id: string }[];
      if (!hasAgents && !hasTasks && boundRoutines === 0 && threads.length === 0) {
        return null;
      }
      const sessions = this.db
        .prepare(
          `SELECT agent_session_id AS id FROM conversations
             WHERE ${botAvatarSql("avatar_user_id")} AND agent_session_id IS NOT NULL
           UNION
           SELECT m.sdk_session_id AS id FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE ${botAvatarSql("c.avatar_user_id")} AND m.sdk_session_id IS NOT NULL`,
        )
        .all() as { id: string }[];
      return {
        conversationIds: threads.map((thread) => thread.id),
        sessionIds: sessions.map((session) => session.id),
      };
    }

    /**
     * Delete every retired row and drop the two bot tables in ONE transaction:
     * each bot thread gets `deleteConversation`'s cascade (canvases, share links,
     * messages, task-API rows, the conversation) plus the notifications and
     * routines pointing into it; then the bot-bound routines, anything else
     * keyed by a bot avatar id, and the tables. The same transaction stores
     * `pendingDocument` (null clears it) — the files this sweep failed to remove
     * are named only by the rows deleted here, so the two commit together or
     * not at all — and drops the completion marker, which a re-retirement after
     * a rollback must not keep: only the caller's clean finish stamps it again.
     * Throws on failure, so the caller can fail the boot instead of serving
     * half-retired data.
     */
    purgeRetiredPersonalAgents(pendingDocument: string | null): RetiredPersonalAgentPurge {
      const hasAgents = this.retiredTableExists("personal_agents");
      const hasTasks = this.retiredTableExists("bot_tasks");
      const hasRoutineColumn = this.routineBotColumnExists();
      const tx = this.db.transaction((): RetiredPersonalAgentPurge => {
        const purge: RetiredPersonalAgentPurge = {
          bots: hasAgents ? this.count("SELECT COUNT(*) AS c FROM personal_agents") : 0,
          tasks: hasTasks ? this.count("SELECT COUNT(*) AS c FROM bot_tasks") : 0,
          conversations: 0,
          messages: 0,
          routines: 0,
          notifications: 0,
        };
        const threadIds = (
          this.db
            .prepare(`SELECT id FROM conversations WHERE ${botAvatarSql("avatar_user_id")}`)
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
        if (hasRoutineColumn) {
          purge.routines += this.db
            .prepare("DELETE FROM routine_jobs WHERE personal_agent_id IS NOT NULL")
            .run().changes;
        }
        // Rows keyed by a bot avatar id rather than a bot thread. A bot run used
        // the OWNER's avatar row, so none should exist — swept anyway so the
        // namespace leaves nothing behind.
        purge.routines += this.db
          .prepare(`DELETE FROM routine_jobs WHERE ${botAvatarSql("avatar_user_id")}`)
          .run().changes;
        purge.notifications += this.db
          .prepare(`DELETE FROM avatar_notifications WHERE ${botAvatarSql("avatar_user_id")}`)
          .run().changes;
        this.db
          .prepare(`DELETE FROM knowledge_requests WHERE ${botAvatarSql("avatar_user_id")}`)
          .run();
        this.db.exec("DROP TABLE IF EXISTS bot_tasks");
        this.db.exec("DROP TABLE IF EXISTS personal_agents");
        this.saveRetiredPersonalAgentPending(pendingDocument);
        this.deleteAppSecret(RETIREMENT_MARKER_KEY);
        return purge;
      });
      return tx();
    }
  };
}
