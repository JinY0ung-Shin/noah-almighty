import crypto from "node:crypto";
import type {
  AdminGroupSummary,
  Group,
  GroupMember,
  GroupRole,
  UserGroupMembership,
} from "../types.js";
import {
  type Constructor,
  type GroupMemberRow,
  type GroupRow,
  type StoreBase,
  now,
  parseNameList,
} from "./internal.js";
import {
  normalizeMcpToolGroups,
  effectiveMcpToolGroups,
  type McpToolGroupId,
} from "../../shared/mcpToolGroups.js";
import { groupAgentAvatarId } from "../groupAgents.js";

/**
 * Stored group tool policy → typed allowlist. NULL/blank/malformed = no
 * restriction (`null`). Unknown ids are dropped on read, so a policy of only
 * retired ids degrades to `[]` — blocking everything rather than failing open.
 */
function parseAllowedMcpToolGroups(raw: string | null): McpToolGroupId[] | null {
  const parsed = parseNameList(raw);
  return parsed ? normalizeMcpToolGroups(parsed) : null;
}

export function withGroups<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Groups extends Base {
    // ---- Groups -----------------------------------------------------------
    // A group is created by a SYSTEM admin. Members of a group auto-trust each
    // other (via `shareAnyGroup` → `isTrustedFor`) and share one knowledge repo
    // that only group admins (role='admin') may edit. Group admins manage their
    // own group's membership; the system admin manages all groups.

    private toGroup(row: GroupRow): Group {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? "",
        knowledgeRepo: row.knowledge_repo ?? null,
        knowledgeBranch: row.knowledge_branch ?? null,
        knowledgeSelected: parseNameList(row.knowledge_selected),
        allowedMcpToolGroups: parseAllowedMcpToolGroups(row.allowed_mcp_tool_groups),
        // Off only when explicitly 0 (NULL = pre-policy rows = on) — mirrors the
        // SQL SHARING_TEAMMATES gate in store/avatars.ts.
        avatarSharing: row.avatar_sharing !== 0,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
      };
    }

    /** Create a group (system-admin action). `createdBy` is the acting admin. */
    createGroup(input: { name: string; description?: string; createdBy?: string | null }): Group {
      const name = input.name.trim();
      if (!name) {
        throw new Error("INVALID_GROUP_NAME");
      }
      const id = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, name, (input.description ?? "").trim(), input.createdBy ?? null, now());
      return this.toGroup(this.groupRowById(id)!);
    }

    getGroup(id: string): Group | null {
      const row = this.groupRowById(id);
      return row ? this.toGroup(row) : null;
    }

    /** All groups with member/admin counts + shared-agent state, for the admin dashboard. */
    listGroups(): AdminGroupSummary[] {
      const rows = this.db
        .prepare("SELECT * FROM groups ORDER BY name COLLATE NOCASE ASC")
        .all() as GroupRow[];
      return rows.map((row) => {
        return {
          ...this.toGroup(row),
          memberCount: this.count("SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?", row.id),
          adminCount: this.count(
            "SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND role = 'admin'",
            row.id,
          ),
          agentCount: this.count(
            "SELECT COUNT(*) AS c FROM group_agents WHERE group_id = ?",
            row.id,
          ),
          enabledAgentCount: this.count(
            "SELECT COUNT(*) AS c FROM group_agents WHERE group_id = ? AND enabled = 1",
            row.id,
          ),
        };
      });
    }

    updateGroup(id: string, patch: { name?: string; description?: string }): Group | null {
      const row = this.groupRowById(id);
      if (!row) {
        return null;
      }
      const name = patch.name !== undefined ? patch.name.trim() || row.name : row.name;
      const description =
        patch.description !== undefined ? patch.description.trim() : (row.description ?? "");
      this.db.prepare("UPDATE groups SET name = ?, description = ? WHERE id = ?").run(name, description, id);
      return this.toGroup(this.groupRowById(id)!);
    }

    /**
     * SYSTEM-ADMIN-ONLY tool policy: which MCP tool groups this group's members
     * may use in chats they drive. `null` clears the policy (no restriction);
     * `[]` blocks every optional MCP tool group. Ids are normalized against the
     * shared catalog. Enforcement is the run-time intersection in
     * `allowedMcpToolGroupsForUser` — claudeAgent clamps every run with it.
     */
    setGroupAllowedMcpToolGroups(id: string, allowed: McpToolGroupId[] | null): Group | null {
      if (!this.groupRowById(id)) {
        return null;
      }
      this.db
        .prepare("UPDATE groups SET allowed_mcp_tool_groups = ? WHERE id = ?")
        .run(allowed ? JSON.stringify(normalizeMcpToolGroups(allowed)) : null, id);
      return this.toGroup(this.groupRowById(id)!);
    }

    /**
     * GROUP-ADMIN policy: whether this group's co-membership shares avatars
     * (mutual visibility AND mutual trust/elevation ride the same SQL fragment —
     * see SHARING_TEAMMATES in store/avatars.ts). Off makes the group
     * knowledge-sharing-only; group repo/brain access and the admin tool policy
     * are unaffected. Managed via PUT /api/me/groups/:id/avatar-sharing
     * (canManageGroup), unlike the system-admin-only tool policy above.
     */
    setGroupAvatarSharing(id: string, enabled: boolean): Group | null {
      if (!this.groupRowById(id)) {
        return null;
      }
      this.db
        .prepare("UPDATE groups SET avatar_sharing = ? WHERE id = ?")
        .run(enabled ? 1 : 0, id);
      return this.toGroup(this.groupRowById(id)!);
    }

    /**
     * Delete a group, its memberships, its shared-skill channel blocks, and its
     * shared agent (row + every member's conversations with it — manual
     * cascade, no ON DELETE CASCADE).
     * On-disk leftovers (group-knowledge clone, agent image, workspaces) are
     * the route's job: see cleanupGroupDataDirs in ../groupAgents.ts.
     * Returns false if it didn't exist.
     */
    deleteGroup(id: string): boolean {
      if (!this.groupRowById(id)) {
        return false;
      }
      // EVERY shared agent's avatar id (a group may have several).
      const agentAvatarIds = (
        this.db
          .prepare("SELECT id FROM group_agents WHERE group_id = ?")
          .all(id) as { id: string }[]
      ).map((row) => groupAgentAvatarId(id, row.id));
      const tx = this.db.transaction(() => {
        const convStmt = this.db.prepare(
          "SELECT id FROM conversations WHERE avatar_user_id = ?",
        );
        const delMsgs = this.db.prepare(
          "DELETE FROM messages WHERE conversation_id = ?",
        );
        const delConvs = this.db.prepare(
          "DELETE FROM conversations WHERE avatar_user_id = ?",
        );
        for (const agentAvatarId of agentAvatarIds) {
          const convRows = convStmt.all(agentAvatarId) as { id: string }[];
          for (const c of convRows) {
            this.deleteCanvasArtifactsForConversation(c.id);
            this.deleteShareLinksForConversation(c.id);
            delMsgs.run(c.id);
          }
          delConvs.run(agentAvatarId);
        }
        this.db.prepare("DELETE FROM group_agents WHERE group_id = ?").run(id);
        this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
        // This group's shared-skill channel blocks: they only ever meant
        // "not through THIS group", so they die with it (a surviving row would
        // also match a recycled group id).
        this.db
          .prepare("DELETE FROM shared_skill_group_blocks WHERE group_id = ?")
          .run(id);
        this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
      });
      tx();
      return true;
    }

    // ---- Group membership -------------------------------------------------

    private toGroupMember(row: GroupMemberRow): GroupMember {
      return {
        userId: row.id,
        username: row.username,
        displayName: row.display_name,
        hasImage: Boolean(row.avatar_ext),
        role: this.normalizeRole(row.role),
        visibility: this.rowVisibility(row),
        joinedAt: row.created_at,
      };
    }

    /**
     * Add a user to a group (or update their role if already a member). Returns
     * the member, or null if the group/user doesn't exist.
     */
    addGroupMember(groupId: string, userId: string, role: GroupRole = "member"): GroupMember | null {
      if (!this.groupRowById(groupId) || !this.userRowById(userId)) {
        return null;
      }
      this.db
        .prepare(
          "INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role",
        )
        .run(groupId, userId, this.normalizeRole(role), now());
      return this.getGroupMember(groupId, userId);
    }

    /** Add a member by username. Returns null if the user/group doesn't exist. */
    addGroupMemberByUsername(
      groupId: string,
      username: string,
      role: GroupRole = "member",
    ): GroupMember | null {
      const target = this.userRowByUsername(username.trim());
      if (!target) {
        return null;
      }
      return this.addGroupMember(groupId, target.id, role);
    }

    /** Change a member's role within a group. Null if they aren't a member. */
    setGroupMemberRole(groupId: string, userId: string, role: GroupRole): GroupMember | null {
      if (!this.getGroupMember(groupId, userId)) {
        return null;
      }
      this.db
        .prepare("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?")
        .run(this.normalizeRole(role), groupId, userId);
      return this.getGroupMember(groupId, userId);
    }

    /** Remove a member from a group. Returns true if a row was removed. */
    removeGroupMember(groupId: string, userId: string): boolean {
      const res = this.db
        .prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
        .run(groupId, userId);
      return res.changes > 0;
    }

    getGroupMember(groupId: string, userId: string): GroupMember | null {
      const row = this.db
        .prepare(
          `SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
                  u.avatar_ext AS avatar_ext, u.visibility AS visibility,
                  m.role AS role, m.created_at AS created_at
           FROM group_members m JOIN users u ON u.id = m.user_id
           WHERE m.group_id = ? AND m.user_id = ?`,
        )
        .get(groupId, userId) as GroupMemberRow | undefined;
      return row ? this.toGroupMember(row) : null;
    }

    /** Members of a group (admins first, then by display name), for the roster UI. */
    listGroupMembers(groupId: string): GroupMember[] {
      const rows = this.db
        .prepare(
          `SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
                  u.avatar_ext AS avatar_ext, u.visibility AS visibility,
                  m.role AS role, m.created_at AS created_at
           FROM group_members m JOIN users u ON u.id = m.user_id
           WHERE m.group_id = ?
           ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END,
                    u.display_name COLLATE NOCASE ASC`,
        )
        .all(groupId) as GroupMemberRow[];
      return rows.map((r) => this.toGroupMember(r));
    }

    /** A user's role within a group, or null if they aren't a member. */
    groupRoleFor(userId: string, groupId: string): GroupRole | null {
      const row = this.db
        .prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
        .get(groupId, userId) as { role: string } | undefined;
      return row ? this.normalizeRole(row.role) : null;
    }

    isGroupAdmin(userId: string, groupId: string): boolean {
      return this.groupRoleFor(userId, groupId) === "admin";
    }

    /** Groups a user belongs to, with role + repo-configured flag (for `User`/roster). */
    listUserGroups(userId: string): UserGroupMembership[] {
      const rows = this.db
        .prepare(
          `SELECT g.id AS id, g.name AS name, m.role AS role, g.knowledge_repo AS knowledge_repo,
                  g.allowed_mcp_tool_groups AS allowed_mcp_tool_groups,
                  g.avatar_sharing AS avatar_sharing
           FROM group_members m JOIN groups g ON g.id = m.group_id
           WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE ASC`,
        )
        .all(userId) as {
        id: string;
        name: string;
        role: string;
        knowledge_repo: string | null;
        allowed_mcp_tool_groups: string | null;
        avatar_sharing: number | null;
      }[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: this.normalizeRole(r.role),
        knowledgeRepoConfigured: Boolean(r.knowledge_repo),
        allowedMcpToolGroups: parseAllowedMcpToolGroups(r.allowed_mcp_tool_groups),
        avatarSharing: r.avatar_sharing !== 0,
      }));
    }

    /**
     * EFFECTIVE admin tool policy for a user: the INTERSECTION of
     * `allowedMcpToolGroups` across every policy-bearing group they belong to.
     * `null` = unrestricted (no group of theirs sets a policy). Groups WITHOUT
     * a policy never narrow the result — membership alone doesn't restrict —
     * and conflicting policies fail CLOSED (only ids every policy allows
     * survive). Consumed by claudeAgent (run clamp), toUser (composer state),
     * and the chat/scheduler git-repo gating.
     */
    allowedMcpToolGroupsForUser(userId: string): McpToolGroupId[] | null {
      let allowed: McpToolGroupId[] | null = null;
      for (const group of this.listUserGroups(userId)) {
        const policy = group.allowedMcpToolGroups;
        if (!policy) continue;
        allowed =
          allowed === null
            ? [...policy]
            : allowed.filter((id) => policy.includes(id));
      }
      // Existing stored policies need no migration: system is always available.
      return allowed === null ? null : effectiveMcpToolGroups(allowed);
    }

    // ---- Group knowledge repo --------------------------------------------

    /** The group's shared knowledge repo + branch + plugin selection. */
    getGroupKnowledgeRepo(groupId: string): {
      repo: string | null;
      branch: string | null;
      selected: string[] | null;
    } {
      const row = this.groupRowById(groupId);
      return {
        repo: row?.knowledge_repo ?? null,
        branch: row?.knowledge_branch ?? null,
        selected: parseNameList(row?.knowledge_selected ?? null),
      };
    }

    /** Connect/clear the group's shared knowledge repo (clears selection, like the user one). */
    setGroupKnowledgeRepo(groupId: string, repo: string | null, branch: string | null): Group | null {
      if (!this.groupRowById(groupId)) {
        return null;
      }
      this.db
        .prepare(
          "UPDATE groups SET knowledge_repo = ?, knowledge_branch = ?, knowledge_selected = NULL WHERE id = ?",
        )
        .run(repo?.trim() || null, branch?.trim() || null, groupId);
      return this.toGroup(this.groupRowById(groupId)!);
    }

    /** Set which group-repo plugins members' avatars load; `null` = load all. */
    setGroupKnowledgeSelected(groupId: string, selected: string[] | null): Group | null {
      if (!this.groupRowById(groupId)) {
        return null;
      }
      this.db
        .prepare("UPDATE groups SET knowledge_selected = ? WHERE id = ?")
        .run(selected ? JSON.stringify(selected) : null, groupId);
      return this.toGroup(this.groupRowById(groupId)!);
    }

    /**
     * Group knowledge repos to load as plugin roots for a user's avatar chats:
     * every group the user is in that has a repo connected. Members read these
     * skills; group admins edit them. Excludes groups with no repo.
     */
    listGroupKnowledgeReposForUser(userId: string): {
      groupId: string;
      groupName: string;
      repo: string;
      branch: string | null;
      selected: string[] | null;
    }[] {
      const rows = this.db
        .prepare(
          `SELECT g.id AS id, g.name AS name, g.knowledge_repo AS repo,
                  g.knowledge_branch AS branch, g.knowledge_selected AS selected
           FROM group_members m JOIN groups g ON g.id = m.group_id
           WHERE m.user_id = ? AND g.knowledge_repo IS NOT NULL
           ORDER BY g.name COLLATE NOCASE ASC`,
        )
        .all(userId) as {
        id: string;
        name: string;
        repo: string;
        branch: string | null;
        selected: string | null;
      }[];
      return rows.map((r) => ({
        groupId: r.id,
        groupName: r.name,
        repo: r.repo,
        branch: r.branch,
        selected: parseNameList(r.selected),
      }));
    }
  };
}
