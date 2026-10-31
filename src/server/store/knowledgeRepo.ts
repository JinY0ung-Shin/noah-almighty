import crypto from "node:crypto";
import type {
  AvatarNotification,
  GitRepository,
  KnowledgeRequest,
  Plugin,
  User,
} from "../types.js";
import {
  type AvatarNotificationRow,
  type Constructor,
  type GitRepositoryRow,
  type KnowledgeRequestRow,
  type PluginRow,
  type StoreBase,
  now,
  parseNameList,
} from "./internal.js";

export function withKnowledgeRepo<TBase extends Constructor<StoreBase>>(
  Base: TBase,
) {
  return class KnowledgeRepo extends Base {
    /**
     * Point the user at a personal knowledge repo (`null` repo clears it).
     * Clears any plugin selection too: the old subset names don't apply to a
     * different repo, and a fresh repo should default to "load all".
     */
    setKnowledgeRepo(
      userId: string,
      repo: string | null,
      branch: string | null,
    ): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      this.db
        .prepare(
          "UPDATE users SET knowledge_repo = ?, knowledge_branch = ?, knowledge_selected = NULL WHERE id = ?",
        )
        .run(repo?.trim() || null, branch?.trim() || null, userId);
      return this.toUser(this.userRowById(userId)!);
    }

    /** Set which knowledge-repo plugins the avatar loads; `null` = load all. */
    setKnowledgeSelected(userId: string, selected: string[] | null): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      this.db
        .prepare("UPDATE users SET knowledge_selected = ? WHERE id = ?")
        .run(selected ? JSON.stringify(selected) : null, userId);
      return this.toUser(this.userRowById(userId)!);
    }

    /** The configured knowledge repo + branch + plugin selection for a user. */
    getKnowledgeRepo(userId: string): {
      repo: string | null;
      branch: string | null;
      selected: string[] | null;
    } {
      const row = this.userRowById(userId);
      return {
        repo: row?.knowledge_repo ?? null,
        branch: row?.knowledge_branch ?? null,
        selected: parseNameList(row?.knowledge_selected ?? null),
      };
    }

    // ---- General git repositories ----------------------------------------

    private toGitRepository(row: GitRepositoryRow): GitRepository {
      return {
        userId: row.user_id,
        name: row.name,
        repo: row.repo,
        branch: row.branch ?? null,
        lastSyncedAt: row.last_synced_at ?? null,
        createdAt: row.created_at,
      };
    }

    /** Register or update a user-scoped general git repo by short name. */
    upsertGitRepo(
      userId: string,
      name: string,
      repo: string,
      branch: string | null,
    ): GitRepository {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      const cleanName = name.trim();
      const cleanRepo = repo.trim();
      if (!cleanName || !cleanRepo) {
        throw new Error("INVALID_GIT_REPO");
      }
      const createdAt = now();
      this.db
        .prepare(
          "INSERT INTO git_repositories (user_id, name, repo, branch, last_synced_at, created_at) VALUES (?, ?, ?, ?, NULL, ?) " +
            "ON CONFLICT(user_id, name) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, last_synced_at = NULL",
        )
        .run(userId, cleanName, cleanRepo, branch?.trim() || null, createdAt);
      return this.getGitRepo(userId, cleanName)!;
    }

    listGitRepos(userId: string): GitRepository[] {
      const rows = this.db
        .prepare(
          "SELECT * FROM git_repositories WHERE user_id = ? ORDER BY name",
        )
        .all(userId) as GitRepositoryRow[];
      return rows.map((row) => this.toGitRepository(row));
    }

    getGitRepo(userId: string, name: string): GitRepository | null {
      const row = this.db
        .prepare(
          "SELECT * FROM git_repositories WHERE user_id = ? AND name = ?",
        )
        .get(userId, name.trim()) as GitRepositoryRow | undefined;
      return row ? this.toGitRepository(row) : null;
    }

    deleteGitRepo(userId: string, name: string): boolean {
      const result = this.db
        .prepare("DELETE FROM git_repositories WHERE user_id = ? AND name = ?")
        .run(userId, name.trim());
      return result.changes > 0;
    }

    markGitRepoSynced(userId: string, name: string): GitRepository | null {
      this.db
        .prepare(
          "UPDATE git_repositories SET last_synced_at = ? WHERE user_id = ? AND name = ?",
        )
        .run(now(), userId, name.trim());
      return this.getGitRepo(userId, name);
    }

    // ---- Plugins ----------------------------------------------------------

    private toPlugin(row: PluginRow): Plugin {
      return {
        id: row.id,
        repo: row.repo,
        ref: row.ref,
        label: row.label,
        enabled: row.enabled === 1,
        selected: parseNameList(row.selected),
        lastSyncedAt: row.last_synced_at ?? null,
        createdAt: row.created_at,
      };
    }

    listPlugins(userId: string): Plugin[] {
      const rows = this.db
        .prepare(
          "SELECT * FROM avatar_plugins WHERE user_id = ? ORDER BY created_at ASC",
        )
        .all(userId) as PluginRow[];
      return rows.map((r) => this.toPlugin(r));
    }

    listEnabledPlugins(userId: string): Plugin[] {
      return this.listPlugins(userId).filter((p) => p.enabled);
    }

    addPlugin(
      userId: string,
      input: { repo: string; ref?: string; label?: string },
    ): Plugin {
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO avatar_plugins (id, user_id, repo, ref, label, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          id,
          userId,
          input.repo.trim(),
          input.ref?.trim() || null,
          input.label?.trim() || null,
          now(),
        );
      return this.toPlugin(
        this.db
          .prepare("SELECT * FROM avatar_plugins WHERE id = ?")
          .get(id) as PluginRow,
      );
    }

    deletePlugin(userId: string, id: string): boolean {
      const result = this.db
        .prepare("DELETE FROM avatar_plugins WHERE id = ? AND user_id = ?")
        .run(id, userId);
      return result.changes > 0;
    }

    getPlugin(userId: string, id: string): Plugin | null {
      const row = this.db
        .prepare("SELECT * FROM avatar_plugins WHERE id = ? AND user_id = ?")
        .get(id, userId) as PluginRow | undefined;
      return row ? this.toPlugin(row) : null;
    }

    setPluginEnabled(
      userId: string,
      id: string,
      enabled: boolean,
    ): Plugin | null {
      const result = this.db
        .prepare(
          "UPDATE avatar_plugins SET enabled = ? WHERE id = ? AND user_id = ?",
        )
        .run(enabled ? 1 : 0, id, userId);
      if (result.changes === 0) {
        return null;
      }
      return this.getPlugin(userId, id);
    }

    /** Update which marketplace plugins are loaded; `null` means "load all". */
    setPluginSelected(
      userId: string,
      id: string,
      selected: string[] | null,
    ): Plugin | null {
      const result = this.db
        .prepare(
          "UPDATE avatar_plugins SET selected = ? WHERE id = ? AND user_id = ?",
        )
        .run(selected ? JSON.stringify(selected) : null, id, userId);
      if (result.changes === 0) {
        return null;
      }
      return this.getPlugin(userId, id);
    }

    /** Update the ref (branch/tag/commit) a plugin tracks. */
    setPluginRef(
      userId: string,
      id: string,
      ref: string | null,
    ): Plugin | null {
      const result = this.db
        .prepare(
          "UPDATE avatar_plugins SET ref = ? WHERE id = ? AND user_id = ?",
        )
        .run(ref, id, userId);
      if (result.changes === 0) {
        return null;
      }
      return this.getPlugin(userId, id);
    }

    /** Stamp the last successful git sync time. */
    markPluginSynced(userId: string, id: string): Plugin | null {
      const result = this.db
        .prepare(
          "UPDATE avatar_plugins SET last_synced_at = ? WHERE id = ? AND user_id = ?",
        )
        .run(now(), id, userId);
      if (result.changes === 0) {
        return null;
      }
      return this.getPlugin(userId, id);
    }

    // ---- Knowledge: the owner's gap inbox (colleague questions) ----------

    private toKnowledgeRequest(row: KnowledgeRequestRow): KnowledgeRequest {
      return {
        id: row.id,
        avatarUserId: row.avatar_user_id,
        askerUserId: row.asker_user_id,
        askerName: row.asker_name,
        question: row.question,
        status: row.status as KnowledgeRequest["status"],
        createdAt: row.created_at,
      };
    }

    /**
     * Queue a knowledge gap for the avatar's owner. If an identical question is
     * already open we return that one instead of duplicating it.
     */
    addKnowledgeRequest(
      avatarUserId: string,
      input: {
        question: string;
        askerUserId?: string | null;
        askerName?: string | null;
      },
    ): KnowledgeRequest {
      const question = input.question.trim();
      const existing = this.db
        .prepare(
          "SELECT * FROM knowledge_requests WHERE avatar_user_id = ? AND status = 'open' AND question = ?",
        )
        .get(avatarUserId, question) as KnowledgeRequestRow | undefined;
      if (existing) {
        return this.toKnowledgeRequest(existing);
      }
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO knowledge_requests (id, avatar_user_id, asker_user_id, asker_name, question, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          avatarUserId,
          input.askerUserId ?? null,
          input.askerName ?? null,
          question,
          now(),
        );
      return this.toKnowledgeRequest(
        this.db
          .prepare("SELECT * FROM knowledge_requests WHERE id = ?")
          .get(id) as KnowledgeRequestRow,
      );
    }

    listKnowledgeRequests(
      avatarUserId: string,
      status?: KnowledgeRequest["status"],
    ): KnowledgeRequest[] {
      const rows = (
        status
          ? this.db
              .prepare(
                "SELECT * FROM knowledge_requests WHERE avatar_user_id = ? AND status = ? ORDER BY created_at DESC",
              )
              .all(avatarUserId, status)
          : this.db
              .prepare(
                "SELECT * FROM knowledge_requests WHERE avatar_user_id = ? ORDER BY created_at DESC",
              )
              .all(avatarUserId)
      ) as KnowledgeRequestRow[];
      return rows.map((r) => this.toKnowledgeRequest(r));
    }

    countOpenKnowledgeRequests(avatarUserId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM knowledge_requests WHERE avatar_user_id = ? AND status = 'open'",
        avatarUserId,
      );
    }

    /**
     * Resolve (close) an open request. There is no stored answer: the avatar's
     * persistent knowledge lives in plugins, so the owner just clears the gap
     * from the inbox once handled. Returns false if it isn't an open request of
     * this avatar's.
     */
    resolveKnowledgeRequest(avatarUserId: string, id: string): boolean {
      const result = this.db
        .prepare(
          "UPDATE knowledge_requests SET status = 'resolved' WHERE id = ? AND avatar_user_id = ? AND status = 'open'",
        )
        .run(id, avatarUserId);
      return result.changes > 0;
    }

    // ---- Avatar notifications (in-app alarms for the owner) --------------

    private toAvatarNotification(
      row: AvatarNotificationRow,
    ): AvatarNotification {
      return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        avatarUserId: row.avatar_user_id,
        avatarDisplayName: row.avatar_display_name ?? "(삭제된 아바타)",
        title: row.title,
        message: row.message,
        conversationId: row.conversation_id,
        readAt: row.read_at,
        createdAt: row.created_at,
      };
    }

    addAvatarNotification(
      ownerUserId: string,
      input: {
        avatarUserId: string;
        title?: string | null;
        message: string;
        conversationId?: string | null;
      },
    ): AvatarNotification {
      const message = input.message.trim();
      if (!message) {
        throw new Error("EMPTY_NOTIFICATION");
      }
      const title = (input.title || "").trim().slice(0, 80) || "아바타 알림";
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO avatar_notifications (id, owner_user_id, avatar_user_id, title, message, conversation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ownerUserId,
          input.avatarUserId,
          title,
          message.slice(0, 4000),
          input.conversationId ?? null,
          now(),
        );
      const row = this.db
        .prepare(
          `SELECT n.*, u.display_name AS avatar_display_name
           FROM avatar_notifications n LEFT JOIN users u ON u.id = n.avatar_user_id
           WHERE n.id = ?`,
        )
        .get(id) as AvatarNotificationRow;
      return this.toAvatarNotification(row);
    }

    listAvatarNotifications(
      ownerUserId: string,
      unreadOnly = false,
    ): AvatarNotification[] {
      const rows = this.db
        .prepare(
          `SELECT n.*, u.display_name AS avatar_display_name
           FROM avatar_notifications n LEFT JOIN users u ON u.id = n.avatar_user_id
           WHERE n.owner_user_id = ? ${unreadOnly ? "AND n.read_at IS NULL" : ""}
           ORDER BY n.created_at DESC
           LIMIT 100`,
        )
        .all(ownerUserId) as AvatarNotificationRow[];
      return rows.map((r) => this.toAvatarNotification(r));
    }

    markAvatarNotificationRead(ownerUserId: string, id: string): boolean {
      const result = this.db
        .prepare(
          "UPDATE avatar_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND owner_user_id = ?",
        )
        .run(now(), id, ownerUserId);
      return result.changes > 0;
    }

    markAllAvatarNotificationsRead(ownerUserId: string): number {
      const result = this.db
        .prepare(
          "UPDATE avatar_notifications SET read_at = COALESCE(read_at, ?) WHERE owner_user_id = ? AND read_at IS NULL",
        )
        .run(now(), ownerUserId);
      return result.changes;
    }

    deleteAvatarNotification(ownerUserId: string, id: string): boolean {
      const result = this.db
        .prepare(
          "DELETE FROM avatar_notifications WHERE id = ? AND owner_user_id = ?",
        )
        .run(id, ownerUserId);
      return result.changes > 0;
    }

    deleteAllAvatarNotifications(ownerUserId: string): number {
      const result = this.db
        .prepare("DELETE FROM avatar_notifications WHERE owner_user_id = ?")
        .run(ownerUserId);
      return result.changes;
    }
  };
}
