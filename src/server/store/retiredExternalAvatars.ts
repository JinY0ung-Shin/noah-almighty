import { type Constructor, type StoreBase } from "./internal.js";

/**
 * RETIREMENT of the removed external avatars (oh-my-gateway-backed avatars,
 * removed 2026-10-29) — the store half of `src/server/retireExternalAvatars.ts`,
 * which boot runs before the server listens, on every boot until ONE clean pass
 * stamps the completion marker.
 *
 * A deployment that ran the feature still holds its data: every conversation
 * whose avatar id is `external:<registry id>` with its messages, canvases and
 * share links, the admin-managed registry (`app_config` row
 * `external_agents_registry_v1`, encrypted, with the gateway API keys) and the
 * `external_avatar_images` table. The user decision (pi migration D4) is to
 * delete ALL of that history — the old "revoking keeps the history" promise
 * went with the feature. No surviving code can create any of it, so the
 * predicates below only ever match legacy rows — and they must keep it that
 * way: the `external:` avatar prefix (and the `external-` workspace-folder
 * prefix it becomes on disk), the table name and the registry key are reserved
 * FOREVER. A marked boot still checks that the table does not exist, because
 * an older release booted after the stamp re-creates it (and could then write
 * new external threads), and finding it re-runs the full retirement.
 * `conversations.external_endpoint` stays as a dead column.
 *
 * The marker is an `app_config` row written through the ordinary writer (its
 * encrypted value is just the stamp time) but read by EXISTENCE only, so a
 * SESSION_SECRET rotation can never un-mark a finished deployment. A second
 * row holds the PENDING retries — the media folders of purged threads that a
 * failed sweep must still be able to find after the purge drops their rows.
 */

/** The public avatar-id namespace of the retired external avatars. */
const EXTERNAL_AVATAR_PREFIX = "external:";
/** The retired profile-image table (re-created by any older release's migrate). */
const EXTERNAL_IMAGE_TABLE = "external_avatar_images";
/** `app_config` key of the retired admin-managed registry. */
const EXTERNAL_REGISTRY_KEY = "external_agents_registry_v1";

/** `app_config` key of the one-time completion marker. */
const RETIREMENT_MARKER_KEY = "retired:external_avatars";
/** `app_config` key of the pending retries (a JSON document only the disk half reads). */
const RETIREMENT_PENDING_KEY = "retired:external_avatars:pending";

/**
 * An exact, case-sensitive prefix test on an avatar-id column. LIKE would be
 * case-insensitive and treat `_` as a wildcard; ids are server-minted UUIDs or
 * namespaced (the retired `group:` / `personal:`), so only an external id can
 * start with this.
 */
function externalAvatarSql(column: string): string {
  return `substr(${column}, 1, ${EXTERNAL_AVATAR_PREFIX.length}) = '${EXTERNAL_AVATAR_PREFIX}'`;
}

/** What the disk half sweeps BEFORE the rows that name the files are purged. */
export interface RetiredExternalAvatarSnapshot {
  /** Every conversation bound to an external avatar id. */
  conversationIds: string[];
}

/** What the purge removed (for the boot log). */
export interface RetiredExternalAvatarPurge {
  conversations: number;
  messages: number;
  routines: number;
  notifications: number;
  /** Whether the managed registry row existed (and was deleted). */
  registry: boolean;
  /** Rows of the dropped profile-image table. */
  images: number;
}

export function withRetiredExternalAvatars<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class RetiredExternalAvatars extends Base {
    private appConfigRowExists(key: string): boolean {
      return Boolean(this.db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(key));
    }

    /**
     * Whether a clean retirement pass already ran here. Existence only — the
     * value is encrypted under SESSION_SECRET, and a rotation must not un-mark.
     */
    externalAvatarsRetired(): boolean {
      return this.appConfigRowExists(RETIREMENT_MARKER_KEY);
    }

    /** The retired image table exists — on a marked DB, an older release re-created it. */
    retiredExternalAvatarTableExists(): boolean {
      return Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(EXTERNAL_IMAGE_TABLE),
      );
    }

    /** Whether pending retries are stored — existence only, like the marker. */
    retiredExternalAvatarPendingExists(): boolean {
      return this.appConfigRowExists(RETIREMENT_PENDING_KEY);
    }

    /** The pending-retry document as stored (missing, unreadable, or its text). */
    retiredExternalAvatarPendingState():
      | { status: "missing" }
      | { status: "unreadable" }
      | { status: "ok"; value: string } {
      return this.getAppSecretState(RETIREMENT_PENDING_KEY);
    }

    /** Store the pending-retry document; null removes the row. */
    saveRetiredExternalAvatarPending(value: string | null): void {
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
    completeExternalAvatarRetirement(at: string): void {
      this.db.transaction(() => {
        this.deleteAppSecret(RETIREMENT_PENDING_KEY);
        this.setAppSecret(RETIREMENT_MARKER_KEY, at);
      })();
    }

    /**
     * Read-only snapshot of what is left to retire, or null when nothing is (a
     * fresh DB, or one whose purge already ran): external threads, rows keyed
     * by an external avatar id, the registry row, the image table.
     */
    snapshotRetiredExternalAvatars(): RetiredExternalAvatarSnapshot | null {
      const threads = this.db
        .prepare(`SELECT id FROM conversations WHERE ${externalAvatarSql("avatar_user_id")}`)
        .all() as { id: string }[];
      const keyedRows =
        this.count(`SELECT COUNT(*) AS c FROM routine_jobs WHERE ${externalAvatarSql("avatar_user_id")}`) +
        this.count(`SELECT COUNT(*) AS c FROM avatar_notifications WHERE ${externalAvatarSql("avatar_user_id")}`) +
        this.count(`SELECT COUNT(*) AS c FROM knowledge_requests WHERE ${externalAvatarSql("avatar_user_id")}`);
      if (
        threads.length === 0 &&
        keyedRows === 0 &&
        !this.appConfigRowExists(EXTERNAL_REGISTRY_KEY) &&
        !this.retiredExternalAvatarTableExists()
      ) {
        return null;
      }
      return { conversationIds: threads.map((thread) => thread.id) };
    }

    /**
     * Delete every retired row in ONE transaction: each external thread gets
     * `deleteConversation`'s cascade (canvases, share links, messages,
     * task-API rows, the conversation) plus the notifications and routines
     * pointing into it; then anything else keyed by an external avatar id, the
     * registry row, and the image table is dropped. The same transaction stores
     * `pendingDocument` (null clears it) — the media folders this sweep failed
     * to remove are named only by the rows deleted here, so the two commit
     * together or not at all — and drops the completion marker, which a
     * re-retirement must not keep: only the caller's clean finish stamps it
     * again. Throws on failure, so the caller can fail the boot instead of
     * serving half-retired data.
     */
    purgeRetiredExternalAvatars(pendingDocument: string | null): RetiredExternalAvatarPurge {
      const tx = this.db.transaction((): RetiredExternalAvatarPurge => {
        const hasImages = this.retiredExternalAvatarTableExists();
        const purge: RetiredExternalAvatarPurge = {
          conversations: 0,
          messages: 0,
          routines: 0,
          notifications: 0,
          registry: this.appConfigRowExists(EXTERNAL_REGISTRY_KEY),
          images: hasImages ? this.count(`SELECT COUNT(*) AS c FROM ${EXTERNAL_IMAGE_TABLE}`) : 0,
        };
        const threadIds = (
          this.db
            .prepare(`SELECT id FROM conversations WHERE ${externalAvatarSql("avatar_user_id")}`)
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
        // Rows keyed by an external avatar id rather than an external thread.
        // The feature never wrote any (routines, notifications and knowledge
        // requests target local avatars) — swept anyway so the namespace
        // leaves nothing behind.
        purge.routines += this.db
          .prepare(`DELETE FROM routine_jobs WHERE ${externalAvatarSql("avatar_user_id")}`)
          .run().changes;
        purge.notifications += this.db
          .prepare(`DELETE FROM avatar_notifications WHERE ${externalAvatarSql("avatar_user_id")}`)
          .run().changes;
        this.db
          .prepare(`DELETE FROM knowledge_requests WHERE ${externalAvatarSql("avatar_user_id")}`)
          .run();
        this.deleteAppSecret(EXTERNAL_REGISTRY_KEY);
        this.db.exec(`DROP TABLE IF EXISTS ${EXTERNAL_IMAGE_TABLE}`);
        this.saveRetiredExternalAvatarPending(pendingDocument);
        this.deleteAppSecret(RETIREMENT_MARKER_KEY);
        return purge;
      });
      return tx();
    }
  };
}
