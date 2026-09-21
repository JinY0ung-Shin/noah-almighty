import crypto from "node:crypto";
import logger from "../logger.js";
import type {
  AgentResponse,
  AuditEvent,
  CanvasArtifact,
  CanvasControl,
  CanvasVersion,
  ConversationSummary,
  MessageAttachment,
  StoredMessage,
} from "../types.js";
import { type Constructor, type StoreBase, now, parseNameList } from "./internal.js";
import { allMcpToolGroupsSelected, normalizeMcpToolGroups, type McpToolGroupId } from "../../shared/mcpToolGroups.js";

/** Keep at most this many versions per canvas artifact (oldest pruned on overflow). */
const MAX_CANVAS_VERSIONS = 20;

/**
 * Keep at most this many routine-run records in a routine's thread (one run leaves a
 * user+assistant message pair); the oldest messages are pruned on overflow so a long-lived
 * routine doesn't grow its conversation without bound.
 */
const MAX_ROUTINE_RUN_RECORDS = 100;

interface CanvasArtifactRow {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  title: string | null;
  content_type: string;
  current_version: number;
  created_at: string | null;
  updated_at: string | null;
}

interface ConversationSummaryRow {
  id: string;
  avatar_user_id: string;
  title: string;
  updated_at: string;
  is_routine: number;
  avatar_display_name: string | null;
  routine_id: string | null;
  routine_prompt: string | null;
}

interface CanvasVersionRow {
  artifact_id: string;
  version: number;
  title: string | null;
  content: string | null;
  content_type: string;
  controls_json: string | null;
  submitted_values_json: string | null;
  interaction: string | null;
  editable: number;
  created_at: string | null;
}

export function withConversations<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Conversations extends Base {
    // ---- Conversations & messages ----------------------------------------

    listConversations(
      ownerId: string,
      avatarId?: string,
      kind: "chat" | "routine" | "all" = "chat",
    ): ConversationSummary[] {
      const params: string[] = [ownerId];
      const where = ["c.owner_user_id = ?"];
      if (avatarId) {
        where.push("c.avatar_user_id = ?");
        params.push(avatarId);
      }
      if (kind === "chat") {
        where.push("c.is_routine = 0");
      } else if (kind === "routine") {
        where.push("c.is_routine = 1");
      }
      const rows = this.db
        .prepare(
          `SELECT c.id, c.avatar_user_id, c.title, c.updated_at, c.is_routine,
                  COALESCE(u.display_name, ga.display_name, pa.display_name) AS avatar_display_name,
                  r.id AS routine_id, r.prompt AS routine_prompt
           FROM conversations c
           LEFT JOIN users u ON u.id = c.avatar_user_id
           -- the concat mirrors groupAgentAvatarId() (../groupAgents.ts); keep in lockstep
           LEFT JOIN group_agents ga ON c.avatar_user_id = 'group:' || ga.group_id || ':' || ga.id
           -- the concat mirrors personalAgentAvatarId() (../personalAgents.ts); keep in lockstep
           LEFT JOIN personal_agents pa ON c.avatar_user_id = 'personal:' || pa.owner_user_id || ':' || pa.id
           LEFT JOIN routine_jobs r ON r.conversation_id = c.id
           WHERE ${where.join(" AND ")}
           ORDER BY c.updated_at DESC`,
        )
        .all(...params) as ConversationSummaryRow[];
      return rows.map((r) => this.toConversationSummary(r));
    }

    /** Deployment-wide history count used to guard external-avatar deletion/repointing. */
    countConversationsForAvatar(avatarId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM conversations WHERE avatar_user_id = ?",
        avatarId,
      );
    }

    /**
     * Every conversation id bound to an avatar id, across ALL owners. Snapshot
     * input for pre-cascade disk sweeps (group deletion removes the rows the
     * per-conversation chat-image/file dirs are keyed by).
     */
    listConversationIdsForAvatar(avatarId: string): string[] {
      const rows = this.db
        .prepare("SELECT id FROM conversations WHERE avatar_user_id = ?")
        .all(avatarId) as { id: string }[];
      return rows.map((r) => r.id);
    }

    /** Map a conversation join row (see listConversations / conversationSummaryById) to a summary. */
    private toConversationSummary(r: ConversationSummaryRow): ConversationSummary {
      return {
        id: r.id,
        avatarUserId: r.avatar_user_id,
        avatarDisplayName: r.avatar_display_name ?? "(삭제된 아바타)",
        title: r.title,
        updatedAt: r.updated_at,
        // The durable flag (is_routine) must win even when the routine_jobs link
        // is gone — classification doesn't depend on the link still existing.
        isRoutine: Boolean(r.routine_id) || r.is_routine === 1,
        routineId: r.routine_id,
        routinePrompt: r.routine_prompt,
      };
    }

    /** A single conversation summary (owner-scoped) using the same join as listConversations. */
    private conversationSummaryById(ownerId: string, id: string): ConversationSummary | null {
      const row = this.db
        .prepare(
          `SELECT c.id, c.avatar_user_id, c.title, c.updated_at, c.is_routine,
                  COALESCE(u.display_name, ga.display_name, pa.display_name) AS avatar_display_name,
                  r.id AS routine_id, r.prompt AS routine_prompt
           FROM conversations c
           LEFT JOIN users u ON u.id = c.avatar_user_id
           -- the concat mirrors groupAgentAvatarId() (../groupAgents.ts); keep in lockstep
           LEFT JOIN group_agents ga ON c.avatar_user_id = 'group:' || ga.group_id || ':' || ga.id
           -- the concat mirrors personalAgentAvatarId() (../personalAgents.ts); keep in lockstep
           LEFT JOIN personal_agents pa ON c.avatar_user_id = 'personal:' || pa.owner_user_id || ':' || pa.id
           LEFT JOIN routine_jobs r ON r.conversation_id = c.id
           WHERE c.owner_user_id = ? AND c.id = ?
           LIMIT 1`,
        )
        .get(ownerId, id) as ConversationSummaryRow | undefined;
      return row ? this.toConversationSummary(row) : null;
    }

    private ownsConversation(ownerId: string, conversationId: string): boolean {
      const row = this.db
        .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
        .get(conversationId) as { owner_user_id: string } | undefined;
      return Boolean(row && row.owner_user_id === ownerId);
    }

    getConversationAvatarId(ownerId: string, conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT avatar_user_id FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { avatar_user_id: string } | undefined;
      return row?.avatar_user_id ?? null;
    }

    /**
     * The owner's newest ORDINARY thread with one avatar — where a 봇 간 위임
     * hand-off lands, so a delegated request joins the conversation the owner
     * already has with that bot instead of minting a thread per hand-off.
     * Routine threads are excluded: `[예약 작업]` conversations are the
     * scheduler's own, pruned on its terms, and a hand-off dropped in one would
     * be swept away with them. Null when the owner has never chatted with this
     * avatar — the caller mints a fresh conversation id.
     */
    latestChatConversationIdForAvatar(
      ownerUserId: string,
      avatarUserId: string,
    ): string | null {
      const row = this.db
        .prepare(
          `SELECT id FROM conversations
           WHERE owner_user_id = ? AND avatar_user_id = ? AND is_routine = 0
           ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .get(ownerUserId, avatarUserId) as { id: string } | undefined;
      return row?.id ?? null;
    }

    /** Exact Gateway endpoint bound to an external conversation, if established. */
    getConversationExternalEndpoint(
      ownerId: string,
      conversationId: string,
    ): string | null {
      const row = this.db
        .prepare(
          "SELECT external_endpoint FROM conversations WHERE id = ? AND owner_user_id = ?",
        )
        .get(conversationId, ownerId) as
        | { external_endpoint: string | null }
        | undefined;
      return row?.external_endpoint ?? null;
    }

    /** The owner of a conversation regardless of caller (null if it doesn't exist). */
    conversationOwner(conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
        .get(conversationId) as { owner_user_id: string } | undefined;
      return row?.owner_user_id ?? null;
    }

    touchConversation(
      ownerId: string,
      conversationId: string,
      avatarUserId: string,
      firstUserText: string,
      opts: { isRoutine?: boolean; externalEndpoint?: string } = {},
    ): void {
      const timestamp = now();
      // Look up by id ALONE so a conversation id that already exists under a
      // DIFFERENT owner is detected here, rather than falling through to the INSERT
      // below and hitting the PRIMARY KEY constraint (which would throw and, on
      // Express 4, escape the async handler as an unhandled rejection). The chat
      // route also rejects a foreign supplied id up front with a 409.
      const existing = this.db
        .prepare(
          "SELECT owner_user_id, external_endpoint FROM conversations WHERE id = ?",
        )
        .get(conversationId) as
        | { owner_user_id: string; external_endpoint: string | null }
        | undefined;
      if (existing) {
        if (existing.owner_user_id !== ownerId) {
          throw new Error("CONVERSATION_OWNER_MISMATCH");
        }
        if (
          opts.externalEndpoint &&
          existing.external_endpoint !== opts.externalEndpoint
        ) {
          throw new Error(
            existing.external_endpoint
              ? "EXTERNAL_ENDPOINT_MISMATCH"
              : "EXTERNAL_ENDPOINT_UNBOUND",
          );
        }
        // Promote to routine-tagged if asked (idempotent); never clears the flag.
        // Existing external rows must already be endpoint-bound. In particular,
        // legacy NULL rows may contain a transcript from before this column existed;
        // silently adopting the current endpoint could disclose that history after
        // an env/config change.
        this.db
          .prepare(
            `UPDATE conversations SET updated_at = ?${opts.isRoutine ? ", is_routine = 1" : ""} WHERE id = ?`,
          )
          .run(
            timestamp,
            conversationId,
          );
        return;
      }
      const rawTitle = firstUserText.trim().replace(/\s+/g, " ");
      const title = rawTitle.length > 0 ? rawTitle.slice(0, 40) : "새 대화";
      this.db
        .prepare(
          `INSERT INTO conversations (id, owner_user_id, avatar_user_id, title, is_routine, external_endpoint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          ownerId,
          avatarUserId,
          title,
          opts.isRoutine ? 1 : 0,
          opts.externalEndpoint ?? null,
          timestamp,
          timestamp,
        );
    }

    /** The SDK session to resume for this conversation's next turn (null if none). */
    getAgentSessionId(ownerId: string, conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT agent_session_id FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { agent_session_id: string | null } | undefined;
      return row?.agent_session_id ?? null;
    }

    /**
     * Record (or clear, when sessionId is null) the SDK session id produced by this
     * conversation's latest turn. Owner-scoped so a guessed conversation id can't
     * point another owner's conversation at a different session.
     */
    setAgentSessionId(ownerId: string, conversationId: string, sessionId: string | null): void {
      this.db
        .prepare("UPDATE conversations SET agent_session_id = ? WHERE id = ? AND owner_user_id = ?")
        .run(sessionId, conversationId, ownerId);
    }

    /**
     * The registered git-repo NAME opened as this conversation's working directory
     * (via `mcp__git_repo__open_repo`), or null when none is open. Durable home of
     * the per-conversation working surface (repoWorkspace.ts) so routine runs —
     * spaced out and across restarts — keep their repo. Keyed by conversation id
     * alone, matching the prior in-memory selection (its owner IS the avatar owner).
     */
    getConversationWorkingRepo(conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT working_repo FROM conversations WHERE id = ?")
        .get(conversationId) as { working_repo: string | null } | undefined;
      return row?.working_repo ?? null;
    }

    /**
     * Set (repoName) or clear (null) this conversation's working repo. In practice
     * the row always exists when this runs (chat touches it pre-run; routines create
     * it eagerly), so a 0-row UPDATE means a broken invariant — log it rather than
     * silently dropping the selection (which would look like a phantom open).
     */
    setConversationWorkingRepo(conversationId: string, repoName: string | null): void {
      const info = this.db
        .prepare("UPDATE conversations SET working_repo = ? WHERE id = ?")
        .run(repoName, conversationId);
      if (info.changes === 0) {
        logger.warn(
          { conversationId },
          "setConversationWorkingRepo: no conversation row — working-repo selection dropped",
        );
      }
    }

    /**
     * Group ids whose shared knowledge is toggled OFF for this conversation
     * (owner-only). Empty array = every group enabled (the default). Owner-scoped
     * so a guessed conversation id can't read another owner's setting.
     */
    getConversationGroupKnowledgeOff(ownerId: string, conversationId: string): string[] {
      const row = this.db
        .prepare("SELECT group_knowledge_off FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { group_knowledge_off: string | null } | undefined;
      return parseNameList(row?.group_knowledge_off ?? null) ?? [];
    }

    /**
     * Replace the conversation's group-knowledge OFF set (the group ids whose shared
     * knowledge is disabled). Empty array clears it (every group ON). Stores the OFF
     * set so groups default ON. No-op when the conversation isn't the owner's.
     */
    setConversationGroupKnowledgeOff(ownerId: string, conversationId: string, offGroupIds: string[]): void {
      const unique = [...new Set(offGroupIds.filter(Boolean))];
      const next = unique.length > 0 ? JSON.stringify(unique) : null;
      this.db
        .prepare("UPDATE conversations SET group_knowledge_off = ? WHERE id = ? AND owner_user_id = ?")
        .run(next, conversationId, ownerId);
    }

    /**
     * The user-chosen model TIER (alias) for this conversation, or null when none
     * was picked (use the server default resolution). Owner-scoped so a guessed
     * conversation id can't read another owner's setting.
     */
    getConversationModel(ownerId: string, conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT selected_model FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { selected_model: string | null } | undefined;
      const value = row?.selected_model?.trim();
      return value ? value : null;
    }

    /**
     * Set (or clear, when `tier` is null/empty) the conversation's chosen model tier.
     * No-op when the conversation isn't the owner's. Callers validate the tier
     * against the registry (`isModelTier`) before persisting.
     */
    setConversationModel(ownerId: string, conversationId: string, tier: string | null): void {
      const next = tier && tier.trim() ? tier.trim() : null;
      this.db
        .prepare("UPDATE conversations SET selected_model = ? WHERE id = ? AND owner_user_id = ?")
        .run(next, conversationId, ownerId);
    }

    /**
     * The user-chosen reasoning EFFORT level for this conversation, or null when
     * none was picked (use the SDK default). Owner-scoped, mirroring the model
     * tier above.
     */
    getConversationEffort(ownerId: string, conversationId: string): string | null {
      const row = this.db
        .prepare("SELECT selected_effort FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { selected_effort: string | null } | undefined;
      const value = row?.selected_effort?.trim();
      return value ? value : null;
    }

    /**
     * Set (or clear, when null/empty) the conversation's chosen effort level.
     * No-op when the conversation isn't the owner's. Callers validate the level
     * against the registry (`isEffortLevel`) before persisting.
     */
    setConversationEffort(ownerId: string, conversationId: string, effort: string | null): void {
      const next = effort && effort.trim() ? effort.trim() : null;
      this.db
        .prepare("UPDATE conversations SET selected_effort = ? WHERE id = ? AND owner_user_id = ?")
        .run(next, conversationId, ownerId);
    }

    /**
     * The MCP tool groups enabled for this conversation. null means the default
     * "all groups" behavior; [] is a real explicit choice (no optional MCP
     * groups). Owner-scoped like model/effort.
     */
    getConversationMcpToolGroups(ownerId: string, conversationId: string): McpToolGroupId[] | null {
      const row = this.db
        .prepare("SELECT selected_mcp_tool_groups FROM conversations WHERE id = ? AND owner_user_id = ?")
        .get(conversationId, ownerId) as { selected_mcp_tool_groups: string | null } | undefined;
      const parsed = parseNameList(row?.selected_mcp_tool_groups ?? null);
      return parsed ? normalizeMcpToolGroups(parsed) : null;
    }

    /**
     * Persist a conversation's MCP tool-group selection. null or the full default
     * set clears the column back to default-all; an empty array stores "[]".
     */
    setConversationMcpToolGroups(
      ownerId: string,
      conversationId: string,
      groups: readonly McpToolGroupId[] | null,
    ): void {
      const normalized = groups ? normalizeMcpToolGroups([...groups]) : null;
      const next =
        normalized && !allMcpToolGroupsSelected(normalized)
          ? JSON.stringify(normalized)
          : null;
      this.db
        .prepare("UPDATE conversations SET selected_mcp_tool_groups = ? WHERE id = ? AND owner_user_id = ?")
        .run(next, conversationId, ownerId);
    }

    /**
     * Parse a persisted response_json column, tolerating corruption: a single bad
     * row must not throw and brick listMessages for an entire conversation.
     */
    private parseResponseJson(json: string | null): AgentResponse | null {
      if (!json) {
        return null;
      }
      try {
        return JSON.parse(json) as AgentResponse;
      } catch {
        logger.warn("skipping corrupt response_json on a stored message");
        return null;
      }
    }

    /** Parse the message attachments column, tolerating corruption (see above). */
    private parseAttachmentsJson(json: string | null): MessageAttachment[] | undefined {
      if (!json) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(json) as MessageAttachment[];
        return Array.isArray(parsed) && parsed.length ? parsed : undefined;
      } catch {
        logger.warn("skipping corrupt attachments_json on a stored message");
        return undefined;
      }
    }

    listMessages(ownerId: string, conversationId: string): StoredMessage[] {
      if (!this.ownsConversation(ownerId, conversationId)) {
        return [];
      }
      const rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC",
        )
        .all(conversationId) as {
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        response_json: string | null;
        attachments_json: string | null;
        kind: string | null;
        created_at: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role as StoredMessage["role"],
        content: r.content,
        attachments: this.parseAttachmentsJson(r.attachments_json),
        // Spread CONDITIONALLY: an ordinary row keeps the exact shape it had
        // before the column existed (no `kind` key at all), so nothing that
        // compares stored messages has to learn about it.
        ...(r.kind === "steer" ? { kind: "steer" as const } : {}),
        response: this.parseResponseJson(r.response_json),
        createdAt: r.created_at,
      }));
    }

    addMessage(
      conversationId: string,
      input: {
        role: "user" | "assistant" | "system";
        content: string;
        response?: AgentResponse | null;
        attachments?: MessageAttachment[];
        /**
         * `"steer"` for a USER row the viewer sent mid-turn (see
         * StoredMessage.kind). Only ever set at DELIVERY time — a mid-turn
         * message the model never received must not appear in history at all.
         */
        kind?: "steer";
      },
    ): StoredMessage {
      const id = crypto.randomUUID();
      const createdAt = now();
      const attachments = input.attachments?.length ? input.attachments : undefined;
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, response_json, attachments_json, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          conversationId,
          input.role,
          input.content,
          input.response ? JSON.stringify(input.response) : null,
          attachments ? JSON.stringify(attachments) : null,
          input.kind ?? null,
          createdAt,
        );
      return {
        id,
        conversationId,
        role: input.role,
        content: input.content,
        attachments,
        ...(input.kind ? { kind: input.kind } : {}),
        response: input.response ?? null,
        createdAt,
      };
    }

    /**
     * Cap a routine thread to the most recent MAX_ROUTINE_RUN_RECORDS runs (a run = one
     * user+assistant pair), deleting the oldest messages on overflow. Called after a routine
     * run records its messages so headless runs don't accumulate unbounded history. Ordered by
     * rowid (insertion order), which is stable even when createdAt timestamps collide.
     */
    pruneRoutineMessages(conversationId: string): void {
      this.db
        .prepare(
          "DELETE FROM messages WHERE conversation_id = ? AND id NOT IN " +
            "(SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?)",
        )
        .run(conversationId, conversationId, MAX_ROUTINE_RUN_RECORDS * 2);
    }

    /**
     * Attach (or clear) an activity-tree snapshot on a persisted assistant message
     * so the completed bubble keeps showing the tool/agent runs after reload. The
     * client owns the humanized labels, so we just merge the given activity into the
     * stored response JSON. Returns false if the message isn't owned / has no response.
     */
    setMessageActivity(ownerId: string, messageId: string, activity: AgentResponse["activity"] | null): boolean {
      const row = this.db
        .prepare("SELECT conversation_id as cid, response_json as rj FROM messages WHERE id = ?")
        .get(messageId) as { cid: string; rj: string | null } | undefined;
      if (!row || !this.ownsConversation(ownerId, row.cid)) {
        return false;
      }
      const response = this.parseResponseJson(row.rj);
      if (!response) {
        return false;
      }
      if (activity && (activity.tools.length || activity.tasks?.length)) {
        response.activity = activity;
      } else {
        delete response.activity;
      }
      this.db.prepare("UPDATE messages SET response_json = ? WHERE id = ?").run(JSON.stringify(response), messageId);
      return true;
    }

    // ---- Visual-canvas artifacts + version history (#50) ------------------

    /** Build a CanvasArtifact (current state) from an artifact row + its current version row. */
    private buildCanvasArtifact(row: CanvasArtifactRow, version: CanvasVersionRow, versionCount: number): CanvasArtifact {
      return {
        id: row.id,
        title: version.title ?? "",
        content: version.content ?? "",
        contentType: (version.content_type as CanvasArtifact["contentType"]) ?? "markdown",
        controls: version.controls_json ? (this.parseCanvasJson<CanvasControl[]>(version.controls_json) ?? undefined) : undefined,
        submittedValues: version.submitted_values_json
          ? (this.parseCanvasJson<Record<string, unknown>>(version.submitted_values_json) ?? undefined)
          : undefined,
        interaction: (version.interaction as CanvasArtifact["interaction"]) ?? undefined,
        editable: Boolean(version.editable),
        currentVersion: row.current_version,
        versionCount,
      };
    }

    /** Parse-tolerant JSON read for canvas columns (a bad row must not throw). */
    private parseCanvasJson<T>(json: string): T | null {
      try {
        return JSON.parse(json) as T;
      } catch {
        logger.warn("skipping corrupt canvas JSON column");
        return null;
      }
    }

    private currentCanvasVersion(artifactId: string, version: number): CanvasVersionRow | undefined {
      return this.db
        .prepare("SELECT * FROM canvas_versions WHERE artifact_id = ? AND version = ?")
        .get(artifactId, version) as CanvasVersionRow | undefined;
    }

    private canvasVersionCount(artifactId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM canvas_versions WHERE artifact_id = ?",
        artifactId,
      );
    }

    /** Delete every version + artifact row for one conversation (manual cascade). */
    deleteCanvasArtifactsForConversation(conversationId: string): void {
      this.db
        .prepare("DELETE FROM canvas_versions WHERE artifact_id IN (SELECT id FROM canvas_artifacts WHERE conversation_id = ?)")
        .run(conversationId);
      this.db.prepare("DELETE FROM canvas_artifacts WHERE conversation_id = ?").run(conversationId);
    }

    /** Drop the oldest versions beyond MAX_CANVAS_VERSIONS so heavy refinement can't grow unbounded. */
    private pruneCanvasVersions(artifactId: string): void {
      this.db
        .prepare(
          "DELETE FROM canvas_versions WHERE artifact_id = ? AND version NOT IN " +
            "(SELECT version FROM canvas_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT ?)",
        )
        .run(artifactId, artifactId, MAX_CANVAS_VERSIONS);
    }

    /**
     * Persist a shown/refined canvas artifact. New id → version 1. Existing id with
     * CHANGED content/title/type/controls → append a new version (refine-in-place
     * history). Existing id with IDENTICAL body → just update the current version's
     * submitted values / interaction / editable (so a blocking submit or a no-op
     * re-show doesn't create a phantom version). Owner-gated via the conversation.
     */
    upsertCanvasArtifact(
      ownerId: string,
      conversationId: string,
      artifact: {
        artifactId: string;
        title: string;
        content: string;
        contentType: string;
        controls?: CanvasControl[];
        submittedValues?: Record<string, unknown>;
        interaction?: "blocking" | "async";
        editable?: boolean;
      },
    ): CanvasArtifact | null {
      if (!this.ownsConversation(ownerId, conversationId)) {
        return null;
      }
      const ts = now();
      const controlsJson = artifact.controls ? JSON.stringify(artifact.controls) : null;
      const valuesJson = artifact.submittedValues ? JSON.stringify(artifact.submittedValues) : null;
      const interaction = artifact.interaction ?? null;
      const editable = artifact.editable ? 1 : 0;
      const existing = this.db
        .prepare("SELECT * FROM canvas_artifacts WHERE id = ?")
        .get(artifact.artifactId) as CanvasArtifactRow | undefined;
      if (existing && (existing.owner_user_id !== ownerId || existing.conversation_id !== conversationId)) {
        logger.warn(
          {
            artifactId: artifact.artifactId,
            ownerId,
            conversationId,
            existingOwnerId: existing.owner_user_id,
            existingConversationId: existing.conversation_id,
          },
          "refusing canvas artifact upsert across owner/conversation boundary",
        );
        return null;
      }

      const tx = this.db.transaction(() => {
        if (!existing) {
          this.db
            .prepare(
              "INSERT INTO canvas_artifacts (id, conversation_id, owner_user_id, title, content_type, current_version, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
            )
            .run(artifact.artifactId, conversationId, ownerId, artifact.title, artifact.contentType, ts, ts);
          this.db
            .prepare(
              "INSERT INTO canvas_versions (artifact_id, version, title, content, content_type, controls_json, submitted_values_json, interaction, editable, created_at) " +
                "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(artifact.artifactId, artifact.title, artifact.content, artifact.contentType, controlsJson, valuesJson, interaction, editable, ts);
          return;
        }
        const cur = this.currentCanvasVersion(artifact.artifactId, existing.current_version);
        const bodyUnchanged =
          cur &&
          cur.title === artifact.title &&
          cur.content === artifact.content &&
          cur.content_type === artifact.contentType &&
          (cur.controls_json ?? null) === controlsJson;
        if (bodyUnchanged) {
          // No content change — just refresh submission/interaction/editable on the current version.
          this.db
            .prepare(
              "UPDATE canvas_versions SET submitted_values_json = ?, interaction = ?, editable = ? WHERE artifact_id = ? AND version = ?",
            )
            .run(valuesJson, interaction, editable, artifact.artifactId, existing.current_version);
          this.db.prepare("UPDATE canvas_artifacts SET updated_at = ? WHERE id = ?").run(ts, artifact.artifactId);
          return;
        }
        const nextVersion = existing.current_version + 1;
        this.db
          .prepare(
            "INSERT INTO canvas_versions (artifact_id, version, title, content, content_type, controls_json, submitted_values_json, interaction, editable, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(artifact.artifactId, nextVersion, artifact.title, artifact.content, artifact.contentType, controlsJson, valuesJson, interaction, editable, ts);
        this.db
          .prepare("UPDATE canvas_artifacts SET title = ?, content_type = ?, current_version = ?, updated_at = ? WHERE id = ?")
          .run(artifact.title, artifact.contentType, nextVersion, ts, artifact.artifactId);
        this.pruneCanvasVersions(artifact.artifactId);
      });
      tx();
      return this.getCanvasArtifact(ownerId, artifact.artifactId);
    }

    /** The current state of one artifact (owner-gated). */
    getCanvasArtifact(ownerId: string, artifactId: string): CanvasArtifact | null {
      const row = this.db
        .prepare("SELECT * FROM canvas_artifacts WHERE id = ? AND owner_user_id = ?")
        .get(artifactId, ownerId) as CanvasArtifactRow | undefined;
      if (!row) return null;
      const version = this.currentCanvasVersion(artifactId, row.current_version);
      if (!version) return null;
      return this.buildCanvasArtifact(row, version, this.canvasVersionCount(artifactId));
    }

    /** All artifacts for a conversation, in show order — for rebuilding the panel on reload. */
    listCanvasArtifacts(ownerId: string, conversationId: string): CanvasArtifact[] {
      if (!this.ownsConversation(ownerId, conversationId)) {
        return [];
      }
      const rows = this.db
        .prepare("SELECT * FROM canvas_artifacts WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(conversationId) as CanvasArtifactRow[];
      const out: CanvasArtifact[] = [];
      for (const row of rows) {
        const version = this.currentCanvasVersion(row.id, row.current_version);
        if (version) out.push(this.buildCanvasArtifact(row, version, this.canvasVersionCount(row.id)));
      }
      return out;
    }

    /** Version history (newest first) for the rollback UI (owner-gated). */
    listCanvasVersions(ownerId: string, artifactId: string): CanvasVersion[] {
      const row = this.db
        .prepare("SELECT owner_user_id FROM canvas_artifacts WHERE id = ?")
        .get(artifactId) as { owner_user_id: string } | undefined;
      if (!row || row.owner_user_id !== ownerId) {
        return [];
      }
      const versions = this.db
        .prepare("SELECT version, created_at FROM canvas_versions WHERE artifact_id = ? ORDER BY version DESC")
        .all(artifactId) as { version: number; created_at: string | null }[];
      return versions.map((v) => ({ version: v.version, createdAt: v.created_at ?? "" }));
    }

    /**
     * Roll back to an earlier version by APPENDING its body as a new current
     * version (non-destructive). Returns the updated artifact, or null if not
     * owned / version missing.
     */
    rollbackCanvasArtifact(ownerId: string, artifactId: string, version: number): CanvasArtifact | null {
      const row = this.db
        .prepare("SELECT * FROM canvas_artifacts WHERE id = ? AND owner_user_id = ?")
        .get(artifactId, ownerId) as CanvasArtifactRow | undefined;
      if (!row) return null;
      const target = this.currentCanvasVersion(artifactId, version);
      if (!target) return null;
      const ts = now();
      const nextVersion = row.current_version + 1;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO canvas_versions (artifact_id, version, title, content, content_type, controls_json, submitted_values_json, interaction, editable, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            artifactId,
            nextVersion,
            target.title,
            target.content,
            target.content_type,
            target.controls_json,
            target.submitted_values_json,
            target.interaction,
            target.editable,
            ts,
          );
        this.db
          .prepare("UPDATE canvas_artifacts SET title = ?, content_type = ?, current_version = ?, updated_at = ? WHERE id = ?")
          .run(target.title, target.content_type, nextVersion, ts, artifactId);
        this.pruneCanvasVersions(artifactId);
      });
      tx();
      return this.getCanvasArtifact(ownerId, artifactId);
    }

    /** Hard-delete an artifact and all its versions (owner-gated). */
    deleteCanvasArtifact(ownerId: string, artifactId: string): boolean {
      const row = this.db
        .prepare("SELECT owner_user_id FROM canvas_artifacts WHERE id = ?")
        .get(artifactId) as { owner_user_id: string } | undefined;
      if (!row || row.owner_user_id !== ownerId) {
        return false;
      }
      const tx = this.db.transaction(() => {
        this.db.prepare("DELETE FROM canvas_versions WHERE artifact_id = ?").run(artifactId);
        this.db.prepare("DELETE FROM canvas_artifacts WHERE id = ?").run(artifactId);
      });
      tx();
      return true;
    }

    renameConversation(ownerId: string, id: string, title: string): ConversationSummary | null {
      if (!this.ownsConversation(ownerId, id)) {
        return null;
      }
      const trimmed = title.trim().slice(0, 80);
      const finalTitle = trimmed.length > 0 ? trimmed : "새 대화";
      this.db
        .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .run(finalTitle, now(), id);
      return this.conversationSummaryById(ownerId, id);
    }

    deleteConversation(ownerId: string, id: string): boolean {
      if (!this.ownsConversation(ownerId, id)) {
        return false;
      }
      const tx = this.db.transaction(() => {
        this.deleteCanvasArtifactsForConversation(id);
        this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
        // Delegated bot tasks are per-thread bookkeeping (내 봇 threads only) —
        // manual cascade, since bot_tasks has no FK onto conversations.
        this.db.prepare("DELETE FROM bot_tasks WHERE conversation_id = ?").run(id);
        // Same story for personal task-API rows (avatar_tasks): no FK onto
        // conversations, so the thread's tasks would outlive it.
        this.db.prepare("DELETE FROM avatar_tasks WHERE conversation_id = ?").run(id);
        this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      });
      tx();
      return true;
    }

    deleteChatConversations(ownerId: string): string[] {
      const rows = this.db
        .prepare("SELECT id FROM conversations WHERE owner_user_id = ? AND is_routine = 0")
        .all(ownerId) as { id: string }[];
      const ids = rows.map((row) => row.id);
      if (!ids.length) {
        return [];
      }
      const tx = this.db.transaction((conversationIds: string[]) => {
        const deleteMessages = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
        const deleteTasks = this.db.prepare("DELETE FROM bot_tasks WHERE conversation_id = ?");
        const deleteAvatarTasks = this.db.prepare("DELETE FROM avatar_tasks WHERE conversation_id = ?");
        const deleteConversation = this.db.prepare("DELETE FROM conversations WHERE id = ? AND owner_user_id = ? AND is_routine = 0");
        for (const conversationId of conversationIds) {
          this.deleteCanvasArtifactsForConversation(conversationId);
          deleteMessages.run(conversationId);
          deleteTasks.run(conversationId);
          deleteAvatarTasks.run(conversationId);
          deleteConversation.run(conversationId, ownerId);
        }
      });
      tx(ids);
      return ids;
    }

    /** Remove the trailing assistant reply so a regenerate can replace it. */
    dropLastAssistant(ownerId: string, conversationId: string): boolean {
      if (!this.ownsConversation(ownerId, conversationId)) {
        return false;
      }
      const last = this.db
        .prepare(
          "SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(conversationId) as { id: string; role: string } | undefined;
      if (last && last.role === "assistant") {
        this.db.prepare("DELETE FROM messages WHERE id = ?").run(last.id);
        return true;
      }
      return false;
    }

    // ---- Audit ------------------------------------------------------------

    audit(event: { actorUserId?: string | null; actorName?: string | null; action: string; status: string; detail: string }): void {
      this.db
        .prepare(
          `INSERT INTO audit (id, actor_user_id, actor_name, action, status, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          event.actorUserId ?? null,
          event.actorName ?? null,
          event.action,
          event.status,
          event.detail,
          now(),
        );
    }

    listAudit(userId: string, isAdmin: boolean, limit = 200): AuditEvent[] {
      const rows = (
        isAdmin
          ? this.db
              .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT ?")
              .all(limit)
          : this.db
              .prepare(
                "SELECT * FROM audit WHERE actor_user_id = ? ORDER BY created_at DESC LIMIT ?",
              )
              .all(userId, limit)
      ) as {
        id: string;
        actor_user_id: string | null;
        actor_name: string | null;
        action: string;
        status: string;
        detail: string;
        created_at: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorName: r.actor_name,
        action: r.action,
        status: r.status,
        detail: r.detail,
        createdAt: r.created_at,
      }));
    }
  };
}
