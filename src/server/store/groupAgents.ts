import crypto from "node:crypto";
import type {
  GroupAgent,
  GroupAgentCaptureScope,
  GroupRole,
} from "../types.js";
import { groupAgentAvatarId, parseGroupAgentRef } from "../groupAgents.js";
import {
  type Constructor,
  type GroupAgentRow,
  type StoreBase,
  normalizeHashtags,
  now,
  parseHashtags,
} from "./internal.js";

/** Stored capture_scope → typed value; anything unknown reads as 'members'. */
function normalizeCaptureScope(raw: string | null): GroupAgentCaptureScope {
  return raw === "admins" ? "admins" : "members";
}

export interface GroupAgentInput {
  displayName: string;
  alias?: string;
  bio?: string;
  intro?: string;
  persona?: string;
  hashtags?: string[];
  captureScope?: GroupAgentCaptureScope;
  enabled?: boolean;
  createdBy?: string | null;
}

export function withGroupAgents<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class GroupAgents extends Base {
    // ---- Group shared agents ----------------------------------------------
    // Several per group allowed (rows keyed by uuid, group_id indexed), managed
    // by group admins via the groups router. Not users rows; conversations
    // store the namespaced avatar id ("group:<groupId>:<agentId>").
    // deleteGroup cascades every agent + its conversations (store/groups.ts);
    // deleteGroupAgent below cascades ONE agent's conversations.

    private groupAgentRow(agentId: string): GroupAgentRow | undefined {
      return this.db
        .prepare("SELECT * FROM group_agents WHERE id = ?")
        .get(agentId) as GroupAgentRow | undefined;
    }

    private toGroupAgent(row: GroupAgentRow): GroupAgent {
      return {
        id: row.id,
        groupId: row.group_id,
        displayName: row.display_name,
        alias: row.alias ?? "",
        bio: row.bio ?? "",
        intro: row.intro ?? "",
        persona: row.persona ?? "",
        hashtags: parseHashtags(row.hashtags),
        hasImage: Boolean(row.avatar_ext),
        enabled: row.enabled === 1,
        captureScope: normalizeCaptureScope(row.capture_scope),
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? null,
      };
    }

    getGroupAgentById(agentId: string): GroupAgent | null {
      const row = this.groupAgentRow(agentId);
      return row ? this.toGroupAgent(row) : null;
    }

    /** Every agent of one group (disabled included — managers re-enable here). */
    listGroupAgents(groupId: string): GroupAgent[] {
      const rows = this.db
        .prepare(
          "SELECT * FROM group_agents WHERE group_id = ? ORDER BY display_name COLLATE NOCASE ASC, created_at ASC",
        )
        .all(groupId) as GroupAgentRow[];
      return rows.map((row) => this.toGroupAgent(row));
    }

    /** Every agent of every group — startup disk-artifact sweeps only. */
    listAllGroupAgents(): GroupAgent[] {
      const rows = this.db
        .prepare("SELECT * FROM group_agents ORDER BY created_at ASC")
        .all() as GroupAgentRow[];
      return rows.map((row) => this.toGroupAgent(row));
    }

    /**
     * Create a NEW shared agent for the group (group-admin action; the route
     * gates). Returns null when the group itself doesn't exist (fail closed).
     */
    createGroupAgent(groupId: string, input: GroupAgentInput): GroupAgent | null {
      if (!this.groupRowById(groupId)) {
        return null;
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("INVALID_GROUP_AGENT_NAME");
      }
      const timestamp = now();
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO group_agents (id, group_id, display_name, alias, bio, intro, persona, hashtags, enabled, capture_scope, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          groupId,
          displayName,
          (input.alias ?? "").trim(),
          (input.bio ?? "").trim(),
          (input.intro ?? "").trim(),
          input.persona ?? "",
          JSON.stringify(normalizeHashtags(input.hashtags ?? [])),
          (input.enabled ?? true) ? 1 : 0,
          normalizeCaptureScope(input.captureScope ?? null),
          input.createdBy ?? null,
          timestamp,
          timestamp,
        );
      return this.toGroupAgent(this.groupAgentRow(id)!);
    }

    /**
     * Patch one agent (fields omitted stay; displayName must stay non-empty
     * when provided). created_* never change. Null when the agent is gone.
     */
    updateGroupAgent(
      agentId: string,
      patch: Partial<GroupAgentInput>,
    ): GroupAgent | null {
      const existing = this.groupAgentRow(agentId);
      if (!existing) {
        return null;
      }
      const displayName = (patch.displayName ?? existing.display_name).trim();
      if (!displayName) {
        throw new Error("INVALID_GROUP_AGENT_NAME");
      }
      this.db
        .prepare(
          `UPDATE group_agents SET
             display_name = ?, alias = ?, bio = ?, intro = ?, persona = ?,
             hashtags = ?, enabled = ?, capture_scope = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          displayName,
          (patch.alias ?? existing.alias ?? "").trim(),
          (patch.bio ?? existing.bio ?? "").trim(),
          (patch.intro ?? existing.intro ?? "").trim(),
          patch.persona ?? existing.persona ?? "",
          patch.hashtags !== undefined
            ? JSON.stringify(normalizeHashtags(patch.hashtags))
            : (existing.hashtags ?? null),
          (patch.enabled ?? existing.enabled === 1) ? 1 : 0,
          normalizeCaptureScope(patch.captureScope ?? existing.capture_scope),
          now(),
          agentId,
        );
      return this.toGroupAgent(this.groupAgentRow(agentId)!);
    }

    /**
     * Delete ONE agent and cascade its conversations (messages + canvases) for
     * every member — manual cascade, mirroring deleteGroup's per-agent slice.
     * The route snapshots conversation ids BEFORE calling this (disk sweep)
     * and removes on-disk artifacts. Disabling (updateGroupAgent enabled:false)
     * remains the thread-preserving alternative.
     */
    deleteGroupAgent(agentId: string): boolean {
      const row = this.groupAgentRow(agentId);
      if (!row) {
        return false;
      }
      const avatarId = groupAgentAvatarId(row.group_id, row.id);
      const tx = this.db.transaction(() => {
        const convRows = this.db
          .prepare("SELECT id FROM conversations WHERE avatar_user_id = ?")
          .all(avatarId) as { id: string }[];
        const delMsgs = this.db.prepare(
          "DELETE FROM messages WHERE conversation_id = ?",
        );
        for (const c of convRows) {
          this.deleteCanvasArtifactsForConversation(c.id);
          this.deleteShareLinksForConversation(c.id);
          delMsgs.run(c.id);
        }
        this.db
          .prepare("DELETE FROM conversations WHERE avatar_user_id = ?")
          .run(avatarId);
        this.db.prepare("DELETE FROM group_agents WHERE id = ?").run(agentId);
      });
      tx();
      return true;
    }

    /** Record the profile-image extension (bytes live on disk, users.avatar_ext pattern). */
    setGroupAgentImageExt(agentId: string, ext: string | null): void {
      this.db
        .prepare("UPDATE group_agents SET avatar_ext = ? WHERE id = ?")
        .run(ext, agentId);
    }

    /** Image-ext lookup by PUBLIC avatar id ("group:<gid>:<aid>") for the image route chain. */
    getGroupAgentImageExtByAvatarId(avatarId: string): string | null {
      const ref = parseGroupAgentRef(avatarId);
      if (!ref) return null;
      const row = this.db
        .prepare(
          "SELECT avatar_ext FROM group_agents WHERE id = ? AND group_id = ?",
        )
        .get(ref.agentId, ref.groupId) as
        | { avatar_ext: string | null }
        | undefined;
      return row?.avatar_ext ?? null;
    }

    /**
     * ENABLED group agents of the viewer's groups, for discovery concatenation
     * (GET /api/avatars). Settings reads per-group via listGroupAgents instead
     * (managers must see a disabled agent to re-enable it).
     */
    listGroupAgentsForUser(
      userId: string,
    ): { agent: GroupAgent; groupName: string; viewerRole: GroupRole }[] {
      const rows = this.db
        .prepare(
          `SELECT ga.*, g.name AS group_name, m.role AS viewer_role
           FROM group_agents ga
           JOIN groups g ON g.id = ga.group_id
           JOIN group_members m ON m.group_id = ga.group_id
           WHERE m.user_id = ? AND ga.enabled = 1
           ORDER BY ga.display_name COLLATE NOCASE ASC`,
        )
        .all(userId) as (GroupAgentRow & {
        group_name: string;
        viewer_role: string;
      })[];
      return rows.map((row) => ({
        agent: this.toGroupAgent(row),
        groupName: row.group_name,
        viewerRole: this.normalizeRole(row.viewer_role),
      }));
    }
  };
}
