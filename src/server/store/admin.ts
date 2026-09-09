import { hashPassword } from "../auth.js";
import { INTERNAL_GIT_TOKEN_SECRET_NAME } from "../gitCredentials.js";
import {
  MANAGED_EXTERNAL_AGENTS_KEY,
  parseManagedExternalAgents,
  serializeManagedExternalAgents,
} from "../externalAgents.js";
import type {
  AdminPresence,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AvatarVisibility,
  ExternalAgentConfig,
  SignupMode,
  SttOverride,
} from "../types.js";
import {
  type Constructor,
  type StoreBase,
  type UserRow,
  MODEL_OVERRIDE_KEY,
  PRESENCE_WINDOW_MS,
  SIGNUP_MODE_KEY,
  STT_OVERRIDE_KEY,
  now,
} from "./internal.js";
import type { AppSecretState } from "./secrets.js";

export function withAdmin<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Admin extends Base {
    private managedExternalAgentsCache:
      | {
          source: AppSecretState;
          state: {
            agents: ExternalAgentConfig[];
            configError: "decrypt_failed" | "invalid" | null;
          };
      }
      | undefined;

    override close(): void {
      this.managedExternalAgentsCache = undefined;
      super.close();
    }

    // ---- Admin ------------------------------------------------------------

    private toAdminSummary(row: UserRow): AdminUserSummary {
      const current = now();
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        roles: this.rolesFor(row.id),
        visibility: this.rowVisibility(row),
        suspended: row.suspended === 1,
        hasImage: Boolean(row.avatar_ext),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        activeSessions: this.count(
          "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?",
          row.id,
          current,
        ),
      };
    }

    listUsers(): AdminUserSummary[] {
      const rows = this.db
        .prepare("SELECT * FROM users ORDER BY created_at ASC")
        .all() as UserRow[];
      return rows.map((row) => this.toAdminSummary(row));
    }

    /** True once more than one admin exists — used to block locking out the last one. */
    countAdmins(): number {
      return this.count(
        `SELECT COUNT(*) AS c FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'`,
      );
    }

    /** Deployment-wide counts for the admin dashboard. */
    adminStats(): AdminStats {
      const current = now();
      return {
        users: this.count("SELECT COUNT(*) AS c FROM users"),
        admins: this.countAdmins(),
        suspended: this.count("SELECT COUNT(*) AS c FROM users WHERE suspended = 1"),
        groupAvatars: this.count("SELECT COUNT(*) AS c FROM users WHERE visibility = 'group'"),
        conversations: this.count("SELECT COUNT(*) AS c FROM conversations"),
        messages: this.count("SELECT COUNT(*) AS c FROM messages"),
        openRequests: this.count("SELECT COUNT(*) AS c FROM knowledge_requests WHERE status = 'open'"),
        activeRoutines: this.count("SELECT COUNT(*) AS c FROM routine_jobs WHERE enabled = 1"),
        activeSessions: this.count("SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?", current),
        groups: this.count("SELECT COUNT(*) AS c FROM groups"),
      };
    }

    /**
     * Who is at the screen right now, freshest first. Suspended accounts are
     * excluded: suspending drops their sessions, so a stamp left behind from
     * just before the suspension is not presence.
     */
    adminPresence(): AdminPresence {
      const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();
      const rows = this.db
        .prepare(
          `SELECT id, username, display_name, avatar_ext, last_seen_at FROM users
           WHERE suspended = 0 AND last_seen_at IS NOT NULL AND last_seen_at > ?
           ORDER BY last_seen_at DESC`,
        )
        .all(since) as Pick<
        UserRow,
        "id" | "username" | "display_name" | "avatar_ext" | "last_seen_at"
      >[];
      return {
        windowMinutes: Math.round(PRESENCE_WINDOW_MS / 60_000),
        users: rows.map((row) => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          hasImage: Boolean(row.avatar_ext),
          lastSeenAt: row.last_seen_at!,
        })),
      };
    }

    /** Per-user breakdown for the expandable admin row. Null if the user is gone. */
    adminUserDetail(id: string): AdminUserDetail | null {
      const row = this.userRowById(id);
      if (!row) {
        return null;
      }
      return {
        ...this.toAdminSummary(row),
        conversationsStarted: this.count(
          "SELECT COUNT(*) AS c FROM conversations WHERE owner_user_id = ?",
          id,
        ),
        conversationsReceived: this.count(
          "SELECT COUNT(*) AS c FROM conversations WHERE avatar_user_id = ?",
          id,
        ),
        pluginCount: this.count("SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ?", id),
        secretCount: this.count("SELECT COUNT(*) AS c FROM user_secrets WHERE user_id = ?", id),
        routinesTotal: this.count("SELECT COUNT(*) AS c FROM routine_jobs WHERE avatar_user_id = ?", id),
        routinesActive: this.count(
          "SELECT COUNT(*) AS c FROM routine_jobs WHERE avatar_user_id = ? AND enabled = 1",
          id,
        ),
        openRequests: this.countOpenKnowledgeRequests(id),
        activeSessions: this.count(
          "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?",
          id,
          now(),
        ),
        gitTokenSet: this.listUserSecretNames(id).includes(INTERNAL_GIT_TOKEN_SECRET_NAME),
        knowledgeRepoSet: Boolean(row.knowledge_repo),
      };
    }

    /** Admin password reset. Returns false if the user doesn't exist. */
    setPassword(userId: string, password: string): boolean {
      if (!this.userRowById(userId)) {
        return false;
      }
      this.db
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(hashPassword(password), userId);
      return true;
    }

    /** Force-logout: drop every active session for a user. Returns count removed. */
    revokeAllSessions(userId: string): number {
      const info = this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      return info.changes;
    }

    /** Suspend/un-suspend an account. Suspending also kills the user's sessions so
     *  the lockout is immediate. Returns the updated summary, or null if not found. */
    setSuspended(userId: string, suspended: boolean): AdminUserSummary | null {
      if (!this.userRowById(userId)) {
        return null;
      }
      const tx = this.db.transaction(() => {
        this.db
          .prepare("UPDATE users SET suspended = ? WHERE id = ?")
          .run(suspended ? 1 : 0, userId);
        if (suspended) {
          this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        }
      });
      tx();
      return this.toAdminSummary(this.userRowById(userId)!);
    }

    /** Admin override of an avatar's visibility (content moderation). Null if not found. */
    setVisibilityByAdmin(userId: string, visibility: AvatarVisibility): AdminUserSummary | null {
      if (!this.userRowById(userId)) {
        return null;
      }
      this.db.prepare("UPDATE users SET visibility = ? WHERE id = ?").run(visibility, userId);
      return this.toAdminSummary(this.userRowById(userId)!);
    }

    // ---- App-wide settings (signup gating, model + stt override) ----------

    getSignupMode(): SignupMode {
      const raw = this.getAppSecret(SIGNUP_MODE_KEY);
      return raw === "closed" || raw === "approval" ? raw : "open";
    }

    setSignupMode(mode: SignupMode): void {
      this.setAppSecret(SIGNUP_MODE_KEY, mode);
    }

    /** Admin-selected agent model (UI), or null if unset. Env ANTHROPIC_MODEL wins. */
    getModelOverride(): string | null {
      const raw = this.getAppSecret(MODEL_OVERRIDE_KEY);
      return raw && raw.trim() ? raw.trim() : null;
    }

    setModelOverride(model: string): void {
      this.setAppSecret(MODEL_OVERRIDE_KEY, model.trim());
    }

    clearModelOverride(): void {
      this.deleteAppSecret(MODEL_OVERRIDE_KEY);
    }

    /**
     * Admin-managed speech-to-text endpoint, or null when none is stored (the
     * deployment then falls back to env `STT_URL`/`STT_MODEL`). Anything
     * unreadable — a SESSION_SECRET rotation, hand-edited JSON, a shape from a
     * future version — reads as null rather than throwing: a garbled override
     * degrades to the env fallback, exactly as the other app_config readers do.
     */
    getSttOverride(): SttOverride | null {
      const raw = this.getAppSecret(STT_OVERRIDE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { url?: unknown; model?: unknown; language?: unknown };
        const url = typeof parsed?.url === "string" ? parsed.url.trim() : "";
        if (!url) return null;
        const model = typeof parsed?.model === "string" ? parsed.model.trim() : "";
        // Rows written before the language field existed carry no `language` key
        // at all; a missing one reads as "inherit the env default", never as a
        // reason to discard an override the deployment is currently using.
        const language = typeof parsed?.language === "string" ? parsed.language.trim() : "";
        return { url, model: model || null, language: language || null };
      } catch {
        return null;
      }
    }

    /** Store the override. Values arrive already validated + normalized by the route. */
    setSttOverride(url: string, model: string | null, language: string | null): void {
      this.setAppSecret(STT_OVERRIDE_KEY, JSON.stringify({ url, model, language }));
    }

    clearSttOverride(): void {
      this.deleteAppSecret(STT_OVERRIDE_KEY);
    }

    /** UI-managed deployment-wide external avatars, encrypted as one versioned registry. */
    getManagedExternalAgentsState(): {
      agents: ExternalAgentConfig[];
      configError: "decrypt_failed" | "invalid" | null;
    } {
      const source = this.getAppSecretState(MANAGED_EXTERNAL_AGENTS_KEY);
      if (this.managedExternalAgentsCache?.source !== source) {
        let state: {
          agents: ExternalAgentConfig[];
          configError: "decrypt_failed" | "invalid" | null;
        };
        if (source.status === "missing") {
          state = { agents: [], configError: null };
        } else if (source.status === "unreadable") {
          state = { agents: [], configError: "decrypt_failed" };
        } else {
          try {
            state = {
              agents: parseManagedExternalAgents(source.value),
              configError: null,
            };
          } catch {
            state = { agents: [], configError: "invalid" };
          }
        }
        this.managedExternalAgentsCache = { source, state };
      }
      const cached = this.managedExternalAgentsCache!.state;
      return {
        configError: cached.configError,
        // Route code gets fresh mutable objects; cache-owned plaintext remains
        // immutable by convention and cannot be poisoned by a caller.
        agents: cached.agents.map((agent) => ({
          ...agent,
          hashtags: [...agent.hashtags],
          ...(agent.visibleToGroupIds
            ? { visibleToGroupIds: [...agent.visibleToGroupIds] }
            : {}),
        })),
      };
    }

    getManagedExternalAgents(): ExternalAgentConfig[] {
      return this.getManagedExternalAgentsState().agents;
    }

    /**
     * Admin-set profile image extension for an EXTERNAL avatar (keyed by the
     * public "external:<id>" avatar id), or null when none. The counterpart of
     * users.avatar_ext for agents that have no users row; bytes live on disk.
     */
    getExternalAvatarImageExt(externalAvatarId: string): string | null {
      const row = this.db
        .prepare(
          "SELECT ext FROM external_avatar_images WHERE external_avatar_id = ?",
        )
        .get(externalAvatarId) as { ext: string } | undefined;
      return row?.ext ?? null;
    }

    /** Set (or clear with null) an external avatar's stored image extension. */
    setExternalAvatarImageExt(externalAvatarId: string, ext: string | null): void {
      if (ext) {
        this.db
          .prepare(
            "INSERT INTO external_avatar_images (external_avatar_id, ext) VALUES (?, ?) " +
              "ON CONFLICT(external_avatar_id) DO UPDATE SET ext = excluded.ext",
          )
          .run(externalAvatarId, ext);
      } else {
        this.db
          .prepare("DELETE FROM external_avatar_images WHERE external_avatar_id = ?")
          .run(externalAvatarId);
      }
    }

    /** Avatar ids ("external:<id>") that currently have a stored image. */
    listExternalAvatarImageIds(): Set<string> {
      const rows = this.db
        .prepare("SELECT external_avatar_id FROM external_avatar_images")
        .all() as { external_avatar_id: string }[];
      return new Set(rows.map((row) => row.external_avatar_id));
    }

    setManagedExternalAgents(agents: readonly ExternalAgentConfig[]): void {
      if (!agents.length) {
        this.deleteAppSecret(MANAGED_EXTERNAL_AGENTS_KEY);
        this.managedExternalAgentsCache = undefined;
        return;
      }
      this.setAppSecret(
        MANAGED_EXTERNAL_AGENTS_KEY,
        serializeManagedExternalAgents(agents),
      );
      this.managedExternalAgentsCache = undefined;
    }

    /**
     * Compare-and-swap the managed registry and, when requested, move exact
     * conversation endpoint bindings in the same IMMEDIATE SQLite transaction.
     * This prevents a failed registry write or a concurrent admin process from
     * leaving stored transcripts bound to a different endpoint than the active
     * registry. NULL legacy rows are adopted only through the administrator's
     * explicit endpoint-change confirmation path.
     */
    replaceManagedExternalAgents(
      expectedAgents: readonly ExternalAgentConfig[],
      nextAgents: readonly ExternalAgentConfig[],
      rebind?: {
        avatarId: string;
        previousEndpoint: string;
        nextEndpoint: string;
      },
    ): boolean {
      const expected = serializeManagedExternalAgents(expectedAgents);
      const replace = this.db.transaction(() => {
        const current = this.getManagedExternalAgentsState();
        if (
          current.configError ||
          serializeManagedExternalAgents(current.agents) !== expected
        ) {
          return false;
        }
        if (rebind) {
          this.db
            .prepare(
              "UPDATE conversations SET external_endpoint = ? " +
                "WHERE avatar_user_id = ? AND (external_endpoint IS NULL OR external_endpoint = ?)",
            )
            .run(
              rebind.nextEndpoint,
              rebind.avatarId,
              rebind.previousEndpoint,
            );
        }
        this.setManagedExternalAgents(nextAgents);
        return true;
      });
      return replace.immediate();
    }

    deleteUser(id: string): boolean {
      if (!this.userRowById(id)) {
        return false;
      }
      const tx = this.db.transaction(() => {
        this.db.prepare("DELETE FROM direct_messages WHERE sender_id = ? OR recipient_id = ?").run(id, id);
        this.db.prepare("DELETE FROM avatar_tasks WHERE owner_user_id = ?").run(id);
        this.db.prepare("DELETE FROM avatar_api_keys WHERE owner_user_id = ?").run(id);
        // Delete conversations owned by or targeting this user (+ their messages).
        const convRows = this.db
          .prepare(
            "SELECT id FROM conversations WHERE owner_user_id = ? OR avatar_user_id = ?",
          )
          .all(id, id) as { id: string }[];
        const delMsgs = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
        for (const c of convRows) {
          this.deleteCanvasArtifactsForConversation(c.id);
          delMsgs.run(c.id);
        }
        this.db
          .prepare("DELETE FROM conversations WHERE owner_user_id = ? OR avatar_user_id = ?")
          .run(id, id);
        this.db.prepare("DELETE FROM avatar_plugins WHERE user_id = ?").run(id);
        this.db.prepare("DELETE FROM routine_jobs WHERE avatar_user_id = ?").run(id);
        this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
        this.db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(id);
        // Personal secret vault (AES-encrypted at rest) + logged knowledge gaps —
        // honour the UI's "permanently deleted" promise, leaving nothing behind.
        // Both directions: requests INTO this avatar's inbox AND requests this
        // user filed as the asker (their name would otherwise keep surfacing in
        // other owners' inboxes).
        this.db.prepare("DELETE FROM user_secrets WHERE user_id = ?").run(id);
        this.db
          .prepare("DELETE FROM knowledge_requests WHERE avatar_user_id = ? OR asker_user_id = ?")
          .run(id, id);
        // Group memberships (the group itself survives; created_by may dangle).
        this.db.prepare("DELETE FROM group_members WHERE user_id = ?").run(id);
        // Registered work repos + notifications in either direction — otherwise
        // these orphan rows outlive the "permanently deleted" account.
        this.db.prepare("DELETE FROM git_repositories WHERE user_id = ?").run(id);
        // Personal agents (내 봇) are owner-scoped rows; their threads are owned
        // by this same user, so the conversation sweep above already cascaded
        // the messages/canvases. Only the rows themselves are left. On-disk
        // artifacts (bot profile image, bot workspace trees) are the admin
        // route's half of the cascade.
        this.db.prepare("DELETE FROM personal_agents WHERE owner_user_id = ?").run(id);
        // Delegated bot tasks are owner-scoped bookkeeping over those same
        // threads — dropped by OWNER, not by conversation, so a task whose
        // thread is already gone can't outlive the account.
        this.db.prepare("DELETE FROM bot_tasks WHERE owner_user_id = ?").run(id);
        // Shared-skill listings are owner-scoped only (learned copies live as
        // FILES in each learner's repo, not as rows referencing this user).
        // Learn events go in BOTH directions: as the skill owner (their counts
        // die with the listing) and as the learner (the "permanently deleted"
        // promise — unlike audit, these rows are product data, not a trail).
        this.db.prepare("DELETE FROM shared_skills WHERE owner_user_id = ?").run(id);
        this.db
          .prepare("DELETE FROM skill_learn_events WHERE owner_user_id = ? OR learner_user_id = ?")
          .run(id, id);
        // Group-channel blocks ON this user's shares: their listings are gone,
        // so the blocks have nothing left to hide. Only the OWNER axis purges —
        // `blocked_by` is an actor column and DANGLES like groups.created_by and
        // audit.actor_user_id (a block by a since-deleted admin still stands;
        // dropping it would silently un-moderate another group's channel).
        this.db
          .prepare("DELETE FROM shared_skill_group_blocks WHERE owner_user_id = ?")
          .run(id);
        this.db
          .prepare("DELETE FROM avatar_notifications WHERE owner_user_id = ? OR avatar_user_id = ?")
          .run(id, id);
        // Canvas artifacts + their version history (owner-scoped; no ON DELETE
        // CASCADE in this DB, so cascade manually — versions first, then artifacts).
        this.db
          .prepare("DELETE FROM canvas_versions WHERE artifact_id IN (SELECT id FROM canvas_artifacts WHERE owner_user_id = ?)")
          .run(id);
        this.db.prepare("DELETE FROM canvas_artifacts WHERE owner_user_id = ?").run(id);
        // Audit rows are RETAINED by design: the trail must outlive the account
        // (actor_user_id/actor_name dangle, like groups.created_by and
        // group_agents.created_by).
        this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
      });
      tx();
      return true;
    }
  };
}
