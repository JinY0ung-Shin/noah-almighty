import crypto from "node:crypto";
import {
  TEAM_BRAIN_CLOSED_BY_UPGRADE,
  TEAM_BRAIN_DRAFT_TTL_MS,
  TEAM_BRAIN_MAX_OPEN_PROPOSALS,
  TEAM_BRAIN_MAX_PERSONAL_NOTES,
  isTeamBrainOp,
  isTeamBrainProposalKind,
  isTeamBrainDecision,
  isTeamBrainProposalStatus,
  isTeamIntakeSlot,
  isTeamPageType,
  type TeamBrainChangeset,
  type TeamBrainIntake,
  type TeamBrainLiveKind,
  type TeamBrainLiveStatus,
  type TeamBrainOp,
  type TeamBrainProposal,
  type TeamBrainProposalKind,
  type TeamBrainProposalStatus,
  type TeamPersonalNoteLink,
} from "../../shared/teamBrain.js";
import { TeamBrainCardPressLog, type TeamBrainCardPressReport } from "../teamBrainCardPress.js";
import { type Constructor, type StoreBase, now } from "./internal.js";
import { OPEN_TEAM_BRAIN_QUEUE_ROWS_SQL } from "./retirementBackup.js";

// Team brain cards (see the team_brain_proposals table comment in internal.ts).
// Input is validated BEFORE it gets here (teamBrain.ts / the tool layer); this
// mixin owns the per-user draft cap (checked inside the write transaction), the
// lazy draft expiry and the compare-and-set status transitions every button
// press goes through. Rows of the retired review queue (kinds propose / review)
// are only READ here — and closed once by `retireTeamBrainReviewQueue`.

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
  intake_json: string | null;
  changes_json: string | null;
  personal_notes_json: string | null;
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
    p.path, p.op, p.title, p.summary, p.content, p.base_blob, p.intake_json, p.changes_json, p.personal_notes_json, p.target_id, p.decision,
    p.decision_reason, p.decided_by,
    COALESCE(NULLIF(du.display_name, ''), du.username) AS decided_by_name,
    p.decided_at, p.created_at, p.updated_at
  FROM team_brain_proposals p
  LEFT JOIN users pu ON pu.id = p.proposer_user_id
  LEFT JOIN users du ON du.id = p.decided_by
  LEFT JOIN conversations c ON c.id = p.conversation_id`;

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Defensive decode: anything malformed reads as null (a legacy row), never throws. */
function decodeIntake(raw: string | null): TeamBrainIntake | null {
  const v = parseJson(raw) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const answers: TeamBrainIntake["answers"] = {};
  if (v.answers && typeof v.answers === "object" && !Array.isArray(v.answers)) {
    for (const [k, a] of Object.entries(v.answers as Record<string, unknown>)) {
      if (isTeamIntakeSlot(k) && typeof a === "string") answers[k] = a;
    }
  }
  return {
    type: isTeamPageType(v.type) ? v.type : null,
    answers,
    gaps: Array.isArray(v.gaps) ? (v.gaps as unknown[]).filter(isTeamIntakeSlot) : [],
  };
}

function decodeChangeset(raw: string | null): TeamBrainChangeset | null {
  const v = parseJson(raw) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.changes)) return null;
  const changes = (v.changes as unknown[])
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .filter((c) => typeof c.path === "string" && isTeamBrainOp(c.op) && typeof c.content === "string")
    .map((c) => ({
      path: c.path as string,
      op: c.op as TeamBrainOp,
      content: c.content as string,
      baseBlob: typeof c.baseBlob === "string" ? c.baseBlob : null,
    }));
  const conflicts = Array.isArray(v.conflicts) ? (v.conflicts as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { changes, conflicts };
}

function decodePersonalNotes(raw: string | null): TeamPersonalNoteLink[] {
  const v = parseJson(raw);
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === "object")
    .filter((n) => typeof n.path === "string" && typeof n.blob === "string")
    .map((n) => ({ path: n.path as string, blob: n.blob as string }))
    .slice(0, TEAM_BRAIN_MAX_PERSONAL_NOTES);
}

function toProposal(row: ProposalRow): TeamBrainProposal {
  return {
    id: row.id,
    // An unknown kind (a newer build's) reads as a legacy one: shown, never actionable.
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
    intake: decodeIntake(row.intake_json),
    changeset: decodeChangeset(row.changes_json),
    personalNotes: decodePersonalNotes(row.personal_notes_json),
    targetId: row.target_id,
    decision: isTeamBrainDecision(row.decision) ? row.decision : null,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewTeamBrainProposal {
  /** Optional caller-minted id (a UUID); the store mints one when omitted. */
  id?: string;
  /** Only the live kinds are ever minted (`propose` / `review` are history). */
  kind: TeamBrainLiveKind;
  proposerUserId: string;
  conversationId: string | null;
  /**
   * The row's path, or a function of the id + created_at the store mints —
   * the raw source path of a card with a source is `teamRawPath(createdAt, id)`.
   */
  path: string | ((id: string, createdAt: string) => string);
  op: TeamBrainOp;
  title: string;
  summary: string;
  content: string;
  baseBlob: string | null;
  intake?: TeamBrainIntake | null;
  changeset?: TeamBrainChangeset | null;
  /** The drafter's personal notes the card came from. */
  personalNotes?: TeamPersonalNoteLink[] | null;
}

/** The team-policy limits the store applies (POLICY.md knobs; built-ins until a provider is set). */
export interface TeamBrainStoreLimits {
  draftTtlMs: number;
  maxOpenProposals: number;
}

const DEFAULT_LIMITS: TeamBrainStoreLimits = {
  draftTtlMs: TEAM_BRAIN_DRAFT_TTL_MS,
  maxOpenProposals: TEAM_BRAIN_MAX_OPEN_PROPOSALS,
};

/** An applied card's link from the owner's personal notes to the team pages (brainTools' read-time marks). */
export interface TeamBrainPersonalLink {
  proposalId: string;
  title: string;
  /** When the card was applied (the decision stamp). */
  approvedAt: string | null;
  notes: TeamPersonalNoteLink[];
  /** The team wiki pages the committed changeset created or updated (the canonical versions). */
  teamPages: string[];
  /**
   * The notes are where the card's SOURCE came from. False = a card without a
   * source recorded them as stating the same fact: the pages were compiled
   * from other sources, so the note may say things the team page does not.
   */
  fromSource: boolean;
}

export type TeamBrainCreateResult =
  | { ok: true; proposal: TeamBrainProposal }
  | { ok: false; error: "LIMIT" };

/** Fields a transition may stamp alongside the new status. */
export interface TeamBrainTransitionFields {
  decidedBy?: string;
  /** Stamp decided_at = now. */
  decided?: boolean;
  /** Clear decided_by + decided_at (a released claim decided nothing). Wins over decidedBy/decided. */
  clearDecision?: boolean;
}

/**
 * A review-queue approval that was mid-commit when its process died: the
 * approve card is claimed (`applied`) and its submission still `pending`.
 */
export interface TeamBrainInFlightApproval {
  reviewId: string;
  targetId: string;
  /** When the card was claimed. */
  decidedAt: string | null;
}

export function withTeamBrain<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class TeamBrain extends Base {
    /** Where POLICY.md's limits come from (app.ts wires the vault reader; tests may set one). */
    teamBrainLimitsProvider: (() => TeamBrainStoreLimits) | null = null;

    /** Read POLICY.md's knobs through `fn` from now on (null = the built-in limits). */
    setTeamBrainLimitsProvider(fn: (() => TeamBrainStoreLimits) | null): void {
      this.teamBrainLimitsProvider = fn;
    }

    /** The limits in force right now (a failing provider falls back to the built-ins). */
    teamBrainLimits(): TeamBrainStoreLimits {
      if (!this.teamBrainLimitsProvider) return DEFAULT_LIMITS;
      try {
        return this.teamBrainLimitsProvider();
      } catch {
        return DEFAULT_LIMITS;
      }
    }

    /**
     * Card presses waiting to be told to the avatar (`teamBrainCardPress.ts`):
     * process memory, one report per (presser, card), collected once.
     */
    private readonly teamBrainCardPressLog = new TeamBrainCardPressLog();

    /** A card's confirm button was pressed (done or refused): keep its report for the presser's chat. */
    noteTeamBrainCardPress(report: TeamBrainCardPressReport): void {
      this.teamBrainCardPressLog.put(report);
    }

    /** The waiting report of `userId`'s press on a card, left in place. */
    peekTeamBrainCardPress(userId: string, proposalId: string): TeamBrainCardPressReport | null {
      return this.teamBrainCardPressLog.peek(userId, proposalId);
    }

    /** The waiting report, removed — the caller is handing it to the avatar (or gives it back below). */
    takeTeamBrainCardPress(userId: string, proposalId: string): TeamBrainCardPressReport | null {
      return this.teamBrainCardPressLog.take(userId, proposalId);
    }

    /** A taken report did not reach the avatar after all: it waits again (unless a newer press replaced it). */
    restoreTeamBrainCardPress(report: TeamBrainCardPressReport): void {
      this.teamBrainCardPressLog.restore(report);
    }

    /**
     * Drafts nobody pressed within the TTL (since their last update — a
     * provenance edit on the card restarts it) — or whose conversation (and so
     * their card) is gone — become `expired` (lazy — run before reads that
     * count/act). The join stands in for a cascade on every
     * conversation-deleting path. LIVE cards only: a draft of the retired review
     * queue is closed by the upgrade step alone (which may be held), so its
     * card always says the way changed — never "expired".
     */
    expireTeamBrainDrafts(): number {
      const cutoff = new Date(Date.now() - this.teamBrainLimits().draftTtlMs).toISOString();
      return this.db
        .prepare(
          `UPDATE team_brain_proposals SET status = 'expired', updated_at = ?
           WHERE status = 'draft' AND kind IN ('direct', 'policy') AND (updated_at < ? OR (conversation_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = team_brain_proposals.conversation_id)))`,
        )
        .run(now(), cutoff).changes;
    }

    /**
     * Create a draft. The cap (THIS drafter's unpressed drafts, every LIVE kind) is
     * checked inside the transaction so two concurrent tool calls can't both
     * squeeze past it.
     */
    createTeamBrainProposal(input: NewTeamBrainProposal): TeamBrainCreateResult {
      this.expireTeamBrainDrafts();
      const id = input.id ?? crypto.randomUUID();
      const stamp = now();
      const tx = this.db.transaction((): TeamBrainCreateResult => {
        const open = (
          this.db
            .prepare(
              "SELECT COUNT(*) AS c FROM team_brain_proposals WHERE proposer_user_id = ? AND status = 'draft' AND kind IN ('direct', 'policy')",
            )
            .get(input.proposerUserId) as { c: number }
        ).c;
        if (open >= this.teamBrainLimits().maxOpenProposals) {
          return { ok: false, error: "LIMIT" };
        }
        const rowPath = typeof input.path === "function" ? input.path(id, stamp) : input.path;
        this.db
          .prepare(
            `INSERT INTO team_brain_proposals (id, kind, status, proposer_user_id, conversation_id, path, op, title,
               summary, content, base_blob, intake_json, changes_json, personal_notes_json, created_at, updated_at)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.kind,
            input.proposerUserId,
            input.conversationId,
            rowPath,
            input.op,
            input.title,
            input.summary,
            input.content,
            input.baseBlob,
            input.intake ? JSON.stringify(input.intake) : null,
            input.changeset ? JSON.stringify(input.changeset) : null,
            input.personalNotes && input.personalNotes.length > 0
              ? JSON.stringify(input.personalNotes.slice(0, TEAM_BRAIN_MAX_PERSONAL_NOTES))
              : null,
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
      /** Only rows whose card lives in this conversation. */
      conversationId?: string;
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
      if (filter.conversationId) {
        where.push("p.conversation_id = ?");
        params.push(filter.conversationId);
      }
      const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
      const sql = `${PROPOSAL_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC, p.id LIMIT ${limit}`;
      return (this.db.prepare(sql).all(...params) as ProposalRow[]).map(toProposal);
    }

    /**
     * Compare-and-set: move `id` to `to` only while its status is one of `from`.
     * Returns false when another press (or an expiry) got there first — the ONE
     * way two presses at once still apply a card only once. `to` is a live
     * status: nothing moves a row into a retired one.
     */
    transitionTeamBrainProposal(
      id: string,
      from: readonly TeamBrainLiveStatus[],
      to: TeamBrainLiveStatus,
      fields: TeamBrainTransitionFields = {},
    ): boolean {
      const stamp = now();
      const assign: Array<[string, unknown]> = [
        ["status", to],
        ["updated_at", stamp],
      ];
      if (fields.clearDecision) {
        assign.push(["decided_by", null], ["decided_at", null]);
      } else {
        if (fields.decidedBy !== undefined) assign.push(["decided_by", fields.decidedBy]);
        if (fields.decided) assign.push(["decided_at", stamp]);
      }
      const sets = assign.map(([col]) => `${col} = ?`);
      const params = assign.map(([, v]) => v);
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
          )
          .run(...params, id, ...from).changes > 0
      );
    }

    /**
     * The drafter's provenance edit on their own card (compare-and-set on a
     * still-draft direct row). Bumps `updated_at`, so an edited draft restarts
     * its expiry clock.
     */
    updateTeamBrainDraftIntake(id: string, proposerUserId: string, intake: TeamBrainIntake): boolean {
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET intake_json = ?, updated_at = ?
             WHERE id = ? AND proposer_user_id = ? AND kind = 'direct' AND status = 'draft'`,
          )
          .run(JSON.stringify(intake), now(), id, proposerUserId).changes > 0
      );
    }

    /**
     * The rewind cascade of `conversationId`: draft cards whose message the
     * rewind discarded — and that live in THAT conversation — are cancelled. An
     * applied card stays (a rewind never undoes the world), and so does a draft
     * of the retired review queue (the upgrade step closes those, with its notice).
     */
    cancelTeamBrainDrafts(conversationId: string, ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      return this.db
        .prepare(
          `UPDATE team_brain_proposals SET status = 'cancelled', updated_at = ?
           WHERE status = 'draft' AND kind IN ('direct', 'policy') AND conversation_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
        )
        .run(now(), conversationId, ...ids).changes;
    }

    // ── The retired review queue (2026-11-13) ──────────────────────────────

    /** How many rows of the retired review queue are still open (0 on a fresh or already upgraded DB). */
    countOpenTeamBrainQueueRows(): number {
      return this.count(`SELECT COUNT(*) AS c FROM team_brain_proposals WHERE ${OPEN_TEAM_BRAIN_QUEUE_ROWS_SQL}`);
    }

    /** Approvals the previous process claimed but may not have committed (see `TeamBrainInFlightApproval`). */
    listTeamBrainInFlightApprovals(): TeamBrainInFlightApproval[] {
      return this.db
        .prepare(
          `SELECT r.id AS reviewId, r.target_id AS targetId, r.decided_at AS decidedAt
           FROM team_brain_proposals r JOIN team_brain_proposals t ON t.id = r.target_id
           WHERE r.kind = 'review' AND r.status = 'applied' AND r.decision = 'approve'
             AND t.kind = 'propose' AND t.status = 'pending'`,
        )
        .all() as TeamBrainInFlightApproval[];
    }

    /**
     * Close the review queue, in ONE transaction. First settle the approvals
     * that were mid-commit: a submission whose commit LANDED (`landed` holds
     * its id — the vault is the truth) becomes `approved`, stamped with the
     * admin who pressed; an approve card whose commit never landed decided
     * nothing and is closed. Then every still-open row (`pending`, `needs_info`
     * or draft submissions, draft review cards) becomes `cancelled` with
     * `TEAM_BRAIN_CLOSED_BY_UPGRADE` as its reason; the source text and every
     * other column stay. Idempotent: a second run finds nothing open.
     */
    retireTeamBrainReviewQueue(landed: ReadonlySet<string>): { approved: number; closed: number } {
      return this.db.transaction(() => {
        const stamp = now();
        const approve = this.db.prepare(
          `UPDATE team_brain_proposals
           SET status = 'approved', decision_reason = NULL, decided_at = ?, updated_at = ?,
               decided_by = (SELECT COALESCE(r.decided_by, r.proposer_user_id) FROM team_brain_proposals r WHERE r.id = ?)
           WHERE id = ? AND kind = 'propose' AND status = 'pending'`,
        );
        const voidCard = this.db.prepare(
          `UPDATE team_brain_proposals
           SET status = 'cancelled', decision_reason = ?, decided_by = NULL, decided_at = NULL, updated_at = ?
           WHERE id = ? AND kind = 'review' AND status = 'applied'`,
        );
        let approved = 0;
        let closed = 0;
        for (const flight of this.listTeamBrainInFlightApprovals()) {
          if (landed.has(flight.targetId)) approved += approve.run(stamp, stamp, flight.reviewId, flight.targetId).changes;
          else closed += voidCard.run(TEAM_BRAIN_CLOSED_BY_UPGRADE, stamp, flight.reviewId).changes;
        }
        closed += this.db
          .prepare(
            `UPDATE team_brain_proposals SET status = 'cancelled', decision_reason = ?, updated_at = ?
             WHERE ${OPEN_TEAM_BRAIN_QUEUE_ROWS_SQL}`,
          )
          .run(TEAM_BRAIN_CLOSED_BY_UPGRADE, stamp).changes;
        return { approved, closed };
      })();
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

    /** Is this an existing, non-suspended user (a teammate pressing their own card)? */
    isActiveUser(userId: string): boolean {
      const row = this.db.prepare("SELECT suspended FROM users WHERE id = ?").get(userId) as
        | { suspended: number }
        | undefined;
      return Boolean(row && row.suspended === 0);
    }

    /**
     * The owner's applied cards that recorded personal notes, newest first,
     * each with the team pages its changeset wrote. History counts too: a
     * submission approved through the retired review queue (kind `propose`,
     * pages from the applied approve review on it) keeps its notes marked.
     */
    listTeamBrainPersonalLinks(userId: string, limit = 200): TeamBrainPersonalLink[] {
      const rows = this.db
        .prepare(
          `SELECT id, kind, path, title, decided_at, personal_notes_json, changes_json FROM team_brain_proposals
           WHERE proposer_user_id = ? AND personal_notes_json IS NOT NULL
             AND ((kind = 'propose' AND status = 'approved') OR (kind = 'direct' AND status = 'applied'))
           ORDER BY decided_at DESC, id LIMIT ?`,
        )
        .all(userId, Math.min(Math.max(1, limit), 500)) as Array<{
        id: string;
        kind: string;
        path: string;
        title: string;
        decided_at: string | null;
        personal_notes_json: string | null;
        changes_json: string | null;
      }>;
      const review = this.db.prepare(
        `SELECT changes_json FROM team_brain_proposals
         WHERE kind = 'review' AND target_id = ? AND status = 'applied' AND decision = 'approve'
         ORDER BY decided_at DESC LIMIT 1`,
      );
      return rows
        .map((r) => {
          const changes =
            r.kind === "propose"
              ? ((review.get(r.id) as { changes_json: string | null } | undefined)?.changes_json ?? null)
              : r.changes_json;
          return {
            proposalId: r.id,
            title: r.title,
            approvedAt: r.decided_at,
            notes: decodePersonalNotes(r.personal_notes_json),
            teamPages: (decodeChangeset(changes)?.changes ?? []).map((c) => c.path),
            // A direct card without a source has no raw path (`path` = "").
            fromSource: r.kind === "propose" || Boolean(r.path),
          };
        })
        .filter((l) => l.notes.length > 0);
    }

    /** deleteUser cascade: the user's own rows (committed content stays in git). */
    deleteTeamBrainProposalsForUser(userId: string): void {
      this.db.prepare("DELETE FROM team_brain_proposals WHERE proposer_user_id = ?").run(userId);
      this.teamBrainCardPressLog.forgetUser(userId);
    }
  };
}
