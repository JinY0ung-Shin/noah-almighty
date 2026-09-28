import crypto from "node:crypto";
import type { PersonalAgent, PersonalAgentInput } from "../types.js";
import {
  parsePersonalAgentRef,
  personalAgentAvatarId,
} from "../personalAgents.js";
import { personalAgentMemoryDirName } from "../personalAgentSlug.js";
import {
  type Constructor,
  type PersonalAgentRow,
  type StoreBase,
  normalizeHashtags,
  now,
  parseHashtags,
  parseNameList,
} from "./internal.js";

/**
 * Hard cap on personal agents per owner. Enforced HERE alone (the PERSONAL_AGENT_LIMIT
 * throw below) so the HTTP route and the owner's `create_agent` MCP tool decode
 * ONE rule instead of each re-deriving it.
 */
export const MAX_PERSONAL_AGENTS = 20;

// The write shape lives in ../types.ts (the cross-lane contract); re-exported so
// callers may import it from either module.
export type { PersonalAgentInput };

export function withPersonalAgents<TBase extends Constructor<StoreBase>>(
  Base: TBase,
) {
  return class PersonalAgents extends Base {
    // ---- Personal agents (내 봇) --------------------------------------------
    // Several per owner (rows keyed by uuid, owner_user_id indexed), managed by
    // the owner via the personalAgents router. Not users rows; conversations
    // store the namespaced avatar id ("personal:<ownerUserId>:<agentId>").
    // deleteUser drops the rows (store/admin.ts) while the owner's bot threads
    // ride its owner_user_id conversation arm; deletePersonalAgent below
    // cascades ONE bot's conversations.

    private personalAgentRow(agentId: string): PersonalAgentRow | undefined {
      return this.db
        .prepare("SELECT * FROM personal_agents WHERE id = ?")
        .get(agentId) as PersonalAgentRow | undefined;
    }

    private toPersonalAgent(row: PersonalAgentRow): PersonalAgent {
      return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        displayName: row.display_name,
        alias: row.alias ?? "",
        bio: row.bio ?? "",
        intro: row.intro ?? "",
        persona: row.persona ?? "",
        hashtags: parseHashtags(row.hashtags),
        hasImage: Boolean(row.avatar_ext),
        enabled: row.enabled === 1,
        defaultModel: row.default_model ?? null,
        // Never NULL in practice: the INSERT sets it and migrate() backfills
        // older rows. The fallback recomputes exactly what that backfill would
        // have written, so a row bypassing both (raw SQL) still reads as a
        // usable segment instead of an empty path.
        memoryDir:
          row.memory_dir || personalAgentMemoryDirName(row.display_name, row.id),
        // NULL/[] both mean "no skills" — a bot's allowlist starts empty, so
        // there is no "null = load all" state to distinguish here.
        selectedSkills: parseNameList(row.selected_skills) ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? null,
      };
    }

    /**
     * Shape-normalize a skill allowlist for storage: strings only, trimmed,
     * blanks dropped, order-preserving dedupe. The CAP and the slug-character
     * rule live in ../personalAgents.ts (normalizePersonalAgentSkills), which
     * both writers — the settings route and the bot's own MCP tools — run
     * BEFORE getting here; this is the last-line shape guard, not a second
     * validation policy.
     */
    private normalizeSelectedSkills(input: string[]): string[] {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const entry of input) {
        if (typeof entry !== "string") continue;
        const slug = entry.trim();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        out.push(slug);
      }
      return out;
    }

    getPersonalAgentById(agentId: string): PersonalAgent | null {
      const row = this.personalAgentRow(agentId);
      return row ? this.toPersonalAgent(row) : null;
    }

    /**
     * One owner's bots — ENABLED only by default (discovery), `includeDisabled`
     * for the settings list, where the owner must see a disabled bot to
     * re-enable it.
     */
    listPersonalAgents(
      ownerUserId: string,
      opts: { includeDisabled?: boolean } = {},
    ): PersonalAgent[] {
      const rows = this.db
        .prepare(
          `SELECT * FROM personal_agents WHERE owner_user_id = ?${
            opts.includeDisabled ? "" : " AND enabled = 1"
          } ORDER BY display_name COLLATE NOCASE ASC, created_at ASC`,
        )
        .all(ownerUserId) as PersonalAgentRow[];
      return rows.map((row) => this.toPersonalAgent(row));
    }

    /** Bots counted against MAX_PERSONAL_AGENTS — a DISABLED bot still holds its slot. */
    countPersonalAgents(ownerUserId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM personal_agents WHERE owner_user_id = ?",
        ownerUserId,
      );
    }

    /**
     * Create a NEW bot for `ownerUserId` (the route/tool gates on the owner's
     * admin role). Throws INVALID_PERSONAL_AGENT_NAME on an empty trimmed name
     * and PERSONAL_AGENT_LIMIT at the cap — both decoded by every caller.
     */
    createPersonalAgent(
      ownerUserId: string,
      input: PersonalAgentInput,
    ): PersonalAgent {
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("INVALID_PERSONAL_AGENT_NAME");
      }
      if (this.countPersonalAgents(ownerUserId) >= MAX_PERSONAL_AGENTS) {
        throw new Error("PERSONAL_AGENT_LIMIT");
      }
      const timestamp = now();
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO personal_agents (id, owner_user_id, display_name, alias, bio, intro, persona, hashtags, enabled, default_model, memory_dir, selected_skills, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ownerUserId,
          displayName,
          (input.alias ?? "").trim(),
          (input.bio ?? "").trim(),
          (input.intro ?? "").trim(),
          input.persona ?? "",
          JSON.stringify(normalizeHashtags(input.hashtags ?? [])),
          (input.enabled ?? true) ? 1 : 0,
          input.defaultModel ?? null,
          // The bot's memory folder is decided HERE, once: the name the row is
          // born with is the one it keeps (updatePersonalAgent never writes it).
          personalAgentMemoryDirName(displayName, id),
          JSON.stringify(
            this.normalizeSelectedSkills(input.selectedSkills ?? []),
          ),
          timestamp,
          timestamp,
        );
      return this.toPersonalAgent(this.personalAgentRow(id)!);
    }

    /**
     * Patch one bot (fields omitted stay; displayName must stay non-empty when
     * provided). `defaultModel` distinguishes undefined (keep) from null
     * (clear); `selectedSkills` is a FULL REPLACE when present. created_at and
     * memory_dir never change — the memory folder is insert-only, so a rename
     * leaves the bot's existing memory tree exactly where it is. Null when the
     * bot is gone.
     */
    updatePersonalAgent(
      agentId: string,
      patch: Partial<PersonalAgentInput>,
    ): PersonalAgent | null {
      const existing = this.personalAgentRow(agentId);
      if (!existing) {
        return null;
      }
      const displayName = (patch.displayName ?? existing.display_name).trim();
      if (!displayName) {
        throw new Error("INVALID_PERSONAL_AGENT_NAME");
      }
      this.db
        .prepare(
          `UPDATE personal_agents SET
             display_name = ?, alias = ?, bio = ?, intro = ?, persona = ?,
             hashtags = ?, enabled = ?, default_model = ?, selected_skills = ?,
             updated_at = ?
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
          patch.defaultModel !== undefined
            ? patch.defaultModel
            : existing.default_model,
          patch.selectedSkills !== undefined
            ? JSON.stringify(
                this.normalizeSelectedSkills(patch.selectedSkills),
              )
            : (existing.selected_skills ?? null),
          now(),
          agentId,
        );
      return this.toPersonalAgent(this.personalAgentRow(agentId)!);
    }

    /**
     * Delete ONE bot and cascade its conversations (messages + canvases), its
     * delegated tasks and its 봇 루틴 rows — manual cascade, mirroring
     * deleteGroupAgent. The bot_tasks sweep goes by agent_id, not by the
     * conversation list, so a task whose thread was already deleted still dies
     * with the bot; the routine_jobs sweep goes by personal_agent_id for the
     * same reason (a bot routine's THREAD already dies through the composite
     * avatar_user_id arm above, but the schedule row itself would otherwise
     * survive and keep firing at a bot that no longer exists). The route
     * snapshots conversation ids BEFORE calling this (disk sweep) and removes
     * on-disk artifacts. Disabling (updatePersonalAgent enabled:false) remains
     * the thread-preserving alternative — a disabled bot's routines stay put and
     * fail closed per firing until it is re-enabled.
     */
    deletePersonalAgent(agentId: string): boolean {
      const row = this.personalAgentRow(agentId);
      if (!row) {
        return false;
      }
      const avatarId = personalAgentAvatarId(row.owner_user_id, row.id);
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
        this.db.prepare("DELETE FROM bot_tasks WHERE agent_id = ?").run(agentId);
        this.db
          .prepare("DELETE FROM routine_jobs WHERE personal_agent_id = ?")
          .run(agentId);
        this.db.prepare("DELETE FROM personal_agents WHERE id = ?").run(agentId);
      });
      tx();
      return true;
    }

    /** Record the profile-image extension (bytes live on disk, users.avatar_ext pattern). */
    setPersonalAgentImageExt(agentId: string, ext: string | null): void {
      this.db
        .prepare("UPDATE personal_agents SET avatar_ext = ? WHERE id = ?")
        .run(ext, agentId);
    }

    /** Image-ext lookup by PUBLIC avatar id ("personal:<owner>:<aid>") for the image route chain. */
    getPersonalAgentImageExtByAvatarId(avatarId: string): string | null {
      const ref = parsePersonalAgentRef(avatarId);
      if (!ref) return null;
      const row = this.db
        .prepare(
          "SELECT avatar_ext FROM personal_agents WHERE id = ? AND owner_user_id = ?",
        )
        .get(ref.agentId, ref.ownerUserId) as
        | { avatar_ext: string | null }
        | undefined;
      return row?.avatar_ext ?? null;
    }
  };
}
