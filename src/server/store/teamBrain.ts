import crypto from "node:crypto";
import {
  TEAM_BRAIN_DRAFT_TTL_MS,
  TEAM_BRAIN_MAX_OPEN_PROPOSALS,
  isTeamBrainOp,
  isTeamBrainProposalKind,
  isTeamBrainProposalStatus,
  type TeamBrainDecision,
  type TeamBrainOp,
  type TeamBrainProposal,
  type TeamBrainProposalKind,
  type TeamBrainProposalStatus,
} from "../../shared/teamBrain.js";
import { type Constructor, type StoreBase, now } from "./internal.js";

// Team brain proposals (see the team_brain_proposals table comment in internal.ts).
// Input is validated BEFORE it gets here (teamBrain.ts / the tool layer); this
// mixin owns the per-user open cap (checked inside the write transaction), the
// lazy draft expiry and the compare-and-set status transitions every button
// press goes through.

interface ProposalRow {
  id: string;
  kind: string;
  status: string;
  proposer_user_id: string;
  proposer_name: string | null;
  conversation_id: string | null;
  path: string;
  op: string;
  title: string;
  summary: string;
  content: string;
  base_blob: string | null;
  target_id: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

// The source conversation is surfaced only while it still exists (todo_items precedent).
const PROPOSAL_SELECT = `SELECT p.id, p.kind, p.status, p.proposer_user_id,
    COALESCE(NULLIF(pu.display_name, ''), pu.username) AS proposer_name,
    CASE WHEN c.id IS NULL THEN NULL ELSE p.conversation_id END AS conversation_id,
    p.path, p.op, p.title, p.summary, p.content, p.base_blob, p.target_id, p.decision,
    p.decision_reason, p.decided_by,
    COALESCE(NULLIF(du.display_name, ''), du.username) AS decided_by_name,
    p.decided_at, p.created_at, p.updated_at
  FROM team_brain_proposals p
  LEFT JOIN users pu ON pu.id = p.proposer_user_id
  LEFT JOIN users du ON du.id = p.decided_by
  LEFT JOIN conversations c ON c.id = p.conversation_id`;

function toProposal(row: ProposalRow): TeamBrainProposal {
  return {
    id: row.id,
    kind: isTeamBrainProposalKind(row.kind) ? row.kind : "propose",
    // An unknown status (a newer build's) reads as a closed one, never as actionable.
    status: isTeamBrainProposalStatus(row.status) ? row.status : "cancelled",
    proposerUserId: row.proposer_user_id,
    proposerName: row.proposer_name ?? "",
    conversationId: row.conversation_id,
    path: row.path,
    op: isTeamBrainOp(row.op) ? row.op : "update",
    title: row.title,
    summary: row.summary,
    content: row.content,
    baseBlob: row.base_blob,
    targetId: row.target_id,
    decision: row.decision === "approve" || row.decision === "reject" ? row.decision : null,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewTeamBrainProposal {
  kind: TeamBrainProposalKind;
  proposerUserId: string;
  conversationId: string | null;
  path: string;
  op: TeamBrainOp;
  title: string;
  summary: string;
  content: string;
  baseBlob: string | null;
  targetId?: string | null;
  decision?: TeamBrainDecision | null;
  decisionReason?: string | null;
}

export type TeamBrainCreateResult =
  | { ok: true; proposal: TeamBrainProposal }
  | { ok: false; error: "LIMIT" };

/** Fields a transition may stamp alongside the new status. */
export interface TeamBrainTransitionFields {
  decidedBy?: string;
  decisionReason?: string | null;
  /** Stamp decided_at = now. */
  decided?: boolean;
}

export function withTeamBrain<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class TeamBrain extends Base {
    /**
     * Drafts nobody pressed within the TTL — or whose conversation (and so their
     * card) is gone — become `expired` (lazy — run before reads that count/act).
     * The join stands in for a cascade on every conversation-deleting path.
     */
    expireTeamBrainDrafts(): number {
      const cutoff = new Date(Date.now() - TEAM_BRAIN_DRAFT_TTL_MS).toISOString();
      return this.db
        .prepare(
          `UPDATE team_brain_proposals SET status = 'expired', updated_at = ?
           WHERE status = 'draft' AND (created_at < ? OR (conversation_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = team_brain_proposals.conversation_id)))`,
        )
        .run(now(), cutoff).changes;
    }

    /**
     * Create a draft. The open cap (draft + pending of THIS proposer, every kind)
     * is checked inside the transaction so two concurrent tool calls can't both
     * squeeze past it.
     */
    createTeamBrainProposal(input: NewTeamBrainProposal): TeamBrainCreateResult {
      this.expireTeamBrainDrafts();
      const id = crypto.randomUUID();
      const stamp = now();
      const tx = this.db.transaction((): TeamBrainCreateResult => {
        const open = (
          this.db
            .prepare(
              "SELECT COUNT(*) AS c FROM team_brain_proposals WHERE proposer_user_id = ? AND status IN ('draft', 'pending')",
            )
            .get(input.proposerUserId) as { c: number }
        ).c;
        if (open >= TEAM_BRAIN_MAX_OPEN_PROPOSALS) {
          return { ok: false, error: "LIMIT" };
        }
        this.db
          .prepare(
            `INSERT INTO team_brain_proposals (id, kind, status, proposer_user_id, conversation_id, path, op, title,
               summary, content, base_blob, target_id, decision, decision_reason, created_at, updated_at)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.kind,
            input.proposerUserId,
            input.conversationId,
            input.path,
            input.op,
            input.title,
            input.summary,
            input.content,
            input.baseBlob,
            input.targetId ?? null,
            input.decision ?? null,
            input.decisionReason ?? null,
            stamp,
            stamp,
          );
        return { ok: true, proposal: this.getTeamBrainProposal(id)! };
      });
      return tx();
    }

    getTeamBrainProposal(id: string): TeamBrainProposal | null {
      const row = this.db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ?`).get(id) as ProposalRow | undefined;
      return row ? toProposal(row) : null;
    }

    /** Newest first. `proposerUserId` narrows to one user's rows. */
    listTeamBrainProposals(filter: {
      kind?: TeamBrainProposalKind;
      statuses?: readonly TeamBrainProposalStatus[];
      proposerUserId?: string;
      limit?: number;
    }): TeamBrainProposal[] {
      this.expireTeamBrainDrafts();
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.kind) {
        where.push("p.kind = ?");
        params.push(filter.kind);
      }
      if (filter.statuses && filter.statuses.length > 0) {
        where.push(`p.status IN (${filter.statuses.map(() => "?").join(", ")})`);
        params.push(...filter.statuses);
      }
      if (filter.proposerUserId) {
        where.push("p.proposer_user_id = ?");
        params.push(filter.proposerUserId);
      }
      const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
      const sql = `${PROPOSAL_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC, p.id LIMIT ${limit}`;
      return (this.db.prepare(sql).all(...params) as ProposalRow[]).map(toProposal);
    }

    /** Submitted teammate proposals awaiting an admin (the admin badge + describe_system). */
    countPendingTeamBrainProposals(): number {
      return (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM team_brain_proposals WHERE kind = 'propose' AND status = 'pending'")
          .get() as { c: number }
      ).c;
    }

    /** My decided proposals I have not looked at yet (the proposer badge). */
    countUnseenTeamBrainResults(userId: string): number {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM team_brain_proposals
             WHERE proposer_user_id = ? AND kind = 'propose' AND status IN ('approved', 'rejected') AND result_seen_at IS NULL`,
          )
          .get(userId) as { c: number }
      ).c;
    }

    /** Mark my decided proposals seen — all of them, or only `ids`. */
    markTeamBrainResultsSeen(userId: string, ids?: readonly string[]): number {
      const base = `UPDATE team_brain_proposals SET result_seen_at = ?
        WHERE proposer_user_id = ? AND kind = 'propose' AND status IN ('approved', 'rejected') AND result_seen_at IS NULL`;
      if (ids === undefined) {
        return this.db.prepare(base).run(now(), userId).changes;
      }
      if (ids.length === 0) return 0;
      return this.db
        .prepare(`${base} AND id IN (${ids.map(() => "?").join(", ")})`)
        .run(now(), userId, ...ids).changes;
    }

    /**
     * Compare-and-set: move `id` to `to` only while its status is one of `from`.
     * Returns false when another press (or an expiry) got there first — the ONE
     * way two admins pressing at once still decide a proposal only once.
     */
    transitionTeamBrainProposal(
      id: string,
      from: readonly TeamBrainProposalStatus[],
      to: TeamBrainProposalStatus,
      fields: TeamBrainTransitionFields = {},
    ): boolean {
      const stamp = now();
      const sets = ["status = ?", "updated_at = ?"];
      const params: unknown[] = [to, stamp];
      if (fields.decidedBy !== undefined) {
        sets.push("decided_by = ?");
        params.push(fields.decidedBy);
      }
      if (fields.decisionReason !== undefined) {
        sets.push("decision_reason = ?");
        params.push(fields.decisionReason);
      }
      if (fields.decided) {
        sets.push("decided_at = ?");
        params.push(stamp);
      }
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
          )
          .run(...params, id, ...from).changes > 0
      );
    }

    /** Run `fn` in ONE db transaction (a review press moves two rows together). */
    teamBrainTransaction<T>(fn: () => T): T {
      return this.db.transaction(fn)();
    }

    /**
     * The rewind cascade: drafts whose card lived in the discarded messages are
     * withdrawn (a submitted or applied one stays — a rewind never undoes the world).
     */
    withdrawTeamBrainDrafts(ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      return this.db
        .prepare(
          `UPDATE team_brain_proposals SET status = CASE WHEN kind = 'propose' THEN 'withdrawn' ELSE 'cancelled' END,
             updated_at = ? WHERE status = 'draft' AND id IN (${ids.map(() => "?").join(", ")})`,
        )
        .run(now(), ...ids).changes;
    }

    /**
     * Admin power over the team brain, judged LIVE on a person (the viewer /
     * the presser — never an avatar owner): an existing, non-suspended admin.
     */
    isActiveAdmin(userId: string): boolean {
      const row = this.db.prepare("SELECT suspended FROM users WHERE id = ?").get(userId) as
        | { suspended: number }
        | undefined;
      return Boolean(row && row.suspended === 0 && this.rolesFor(userId).includes("admin"));
    }

    /** Is this an existing, non-suspended user (a proposer pressing their own card)? */
    isActiveUser(userId: string): boolean {
      const row = this.db.prepare("SELECT suspended FROM users WHERE id = ?").get(userId) as
        | { suspended: number }
        | undefined;
      return Boolean(row && row.suspended === 0);
    }

    /** deleteUser cascade: the user's own rows (approved content stays in git). */
    deleteTeamBrainProposalsForUser(userId: string): void {
      this.db.prepare("DELETE FROM team_brain_proposals WHERE proposer_user_id = ?").run(userId);
    }
  };
}
