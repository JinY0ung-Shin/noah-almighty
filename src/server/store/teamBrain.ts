import crypto from "node:crypto";
import {
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
  type TeamBrainDecision,
  type TeamBrainIntake,
  type TeamBrainOp,
  type TeamBrainProposal,
  type TeamBrainProposalKind,
  type TeamBrainProposalStatus,
  type TeamPersonalNoteLink,
} from "../../shared/teamBrain.js";
import type Database from "better-sqlite3";
import { TeamBrainCardPressLog, type TeamBrainCardPressReport } from "../teamBrainCardPress.js";
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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

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
  const followups = Array.isArray(v.followups)
    ? (v.followups as unknown[])
        .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
        .map((f) => ({ questions: str(f.questions), answer: str(f.answer), askedAt: str(f.askedAt), answeredAt: str(f.answeredAt) }))
    : [];
  return {
    type: isTeamPageType(v.type) ? v.type : null,
    answers,
    gaps: Array.isArray(v.gaps) ? (v.gaps as unknown[]).filter(isTeamIntakeSlot) : [],
    followups,
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
  kind: TeamBrainProposalKind;
  proposerUserId: string;
  conversationId: string | null;
  /**
   * The row's path, or a function of the id + created_at the store mints —
   * a propose row's raw source path is `teamRawPath(createdAt, id)`.
   */
  path: string | ((id: string, createdAt: string) => string);
  op: TeamBrainOp;
  title: string;
  summary: string;
  content: string;
  baseBlob: string | null;
  intake?: TeamBrainIntake | null;
  changeset?: TeamBrainChangeset | null;
  /** The owner's personal notes the source came from (propose / direct-with-source). */
  personalNotes?: TeamPersonalNoteLink[] | null;
  targetId?: string | null;
  decision?: TeamBrainDecision | null;
  decisionReason?: string | null;
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

/** An approved submission's link from the owner's personal notes to the team pages (brainTools' read-time marks). */
export interface TeamBrainPersonalLink {
  proposalId: string;
  title: string;
  /** When the source was approved (the decision stamp). */
  approvedAt: string | null;
  notes: TeamPersonalNoteLink[];
  /** The team wiki pages the approving changeset created or updated (the canonical versions). */
  teamPages: string[];
  /**
   * The notes are where the card's SOURCE came from (a submission, or an
   * admin's own knowledge). False = an admin's maintenance card recorded them
   * as stating the same fact: the pages were compiled from other sources, so
   * the note may say things the team page does not.
   */
  fromSource: boolean;
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
  /** Clear result_seen_at, so the proposer's badge counts this result (again). */
  resetSeen?: boolean;
  /** Clear decided_by + decided_at (a released claim decided nothing). Wins over decidedBy/decided. */
  clearDecision?: boolean;
}

/**
 * A propose DRAFT that was submitted before — an answered 보완 요청 put it back
 * to draft (decided_at is stamped by the ask) — never dies with a draft card:
 * it returns to `needs_info` (the admin's questions still stand) and the
 * unsent answer (the last follow-up, answered after the ask) is dropped, so the
 * proposer answers again. `where` narrows the candidates (SQL over the table).
 */
function reopenAnsweredDrafts(db: Database.Database, where: string, params: unknown[]): number {
  const rows = db
    .prepare(
      `SELECT id, intake_json, decided_at FROM team_brain_proposals
       WHERE kind = 'propose' AND status = 'draft' AND decided_at IS NOT NULL AND (${where})`,
    )
    .all(...params) as Array<{ id: string; intake_json: string | null; decided_at: string }>;
  const update = db.prepare(
    "UPDATE team_brain_proposals SET status = 'needs_info', intake_json = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
  );
  let changed = 0;
  for (const row of rows) {
    const intake = decodeIntake(row.intake_json);
    const last = intake?.followups.at(-1);
    if (intake && last && last.answeredAt >= row.decided_at) intake.followups.pop();
    changed += update.run(intake ? JSON.stringify(intake) : row.intake_json, now(), row.id).changes;
  }
  return changed;
}

/** Statuses that hold one of a user's open slots (the cap). */
const OPEN_STATUSES_SQL = "('draft', 'pending', 'needs_info')";
/** Decided statuses the proposer is badged about. */
const RESULT_STATUSES_SQL = "('approved', 'rejected', 'needs_info')";

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
     * Drafts nobody pressed within the TTL (since their last update — an
     * answered 보완 요청 goes back to draft with a fresh updated_at) — or whose
     * conversation (and so their card) is gone — become `expired` (lazy — run
     * before reads that count/act). The join stands in for a cascade on every
     * conversation-deleting path.
     */
    expireTeamBrainDrafts(): number {
      const cutoff = new Date(Date.now() - this.teamBrainLimits().draftTtlMs).toISOString();
      const due = `updated_at < ? OR (conversation_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = team_brain_proposals.conversation_id))`;
      return this.db.transaction(() => {
        // A once-submitted proposal falls back to needs_info, never expires.
        const reopened = reopenAnsweredDrafts(this.db, due, [cutoff]);
        const expired = this.db
          .prepare(`UPDATE team_brain_proposals SET status = 'expired', updated_at = ? WHERE status = 'draft' AND (${due})`)
          .run(now(), cutoff).changes;
        return reopened + expired;
      })();
    }

    /**
     * Create a draft. The open cap (draft + pending + needs_info of THIS proposer, every kind)
     * is checked inside the transaction so two concurrent tool calls can't both
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
              "SELECT COUNT(*) AS c FROM team_brain_proposals WHERE proposer_user_id = ? AND status IN " + OPEN_STATUSES_SQL,
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
               summary, content, base_blob, intake_json, changes_json, personal_notes_json, target_id, decision,
               decision_reason, created_at, updated_at)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    /** Submitted teammate proposals awaiting an admin (the admin badge + describe_system). */
    countPendingTeamBrainProposals(): number {
      return (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM team_brain_proposals WHERE kind = 'propose' AND status = 'pending'")
          .get() as { c: number }
      ).c;
    }

    /** My decided (approved / rejected / needs_info) proposals I have not looked at yet (the proposer badge). */
    countUnseenTeamBrainResults(userId: string): number {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM team_brain_proposals
             WHERE proposer_user_id = ? AND kind = 'propose' AND status IN ${RESULT_STATUSES_SQL} AND result_seen_at IS NULL`,
          )
          .get(userId) as { c: number }
      ).c;
    }

    /** Mark my decided proposals seen — all of them, or only `ids`. */
    markTeamBrainResultsSeen(userId: string, ids?: readonly string[]): number {
      const base = `UPDATE team_brain_proposals SET result_seen_at = ?
        WHERE proposer_user_id = ? AND kind = 'propose' AND status IN ${RESULT_STATUSES_SQL} AND result_seen_at IS NULL`;
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
      const assign: Array<[string, unknown]> = [
        ["status", to],
        ["updated_at", stamp],
      ];
      if (fields.decisionReason !== undefined) assign.push(["decision_reason", fields.decisionReason]);
      if (fields.clearDecision) {
        assign.push(["decided_by", null], ["decided_at", null]);
      } else {
        if (fields.decidedBy !== undefined) assign.push(["decided_by", fields.decidedBy]);
        if (fields.decided) assign.push(["decided_at", stamp]);
      }
      const sets = assign.map(([col]) => `${col} = ?`);
      const params = assign.map(([, v]) => v);
      if (fields.resetSeen) sets.push("result_seen_at = NULL");
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
          )
          .run(...params, id, ...from).changes > 0
      );
    }

    /**
     * The proposer answered a 보완 요청 (via their avatar): compare-and-set
     * `needs_info → draft` on THEIR OWN propose row, storing the new intake
     * (with the appended follow-up) and moving the card to the answering
     * conversation. created_at is kept (the raw path derives from it);
     * updated_at restarts the draft TTL. False = not theirs / not needs_info.
     */
    answerTeamBrainQuestions(
      id: string,
      proposerUserId: string,
      intake: TeamBrainIntake,
      conversationId: string | null,
    ): boolean {
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET status = 'draft', intake_json = ?, conversation_id = ?, updated_at = ?
             WHERE id = ? AND proposer_user_id = ? AND kind = 'propose' AND status = 'needs_info'`,
          )
          .run(JSON.stringify(intake), conversationId, now(), id, proposerUserId).changes > 0
      );
    }

    /**
     * The drafter's provenance edit on their own card (compare-and-set on a
     * still-draft propose / direct row). Bumps `updated_at`, so an edited draft
     * restarts its expiry clock like an answered 보완 요청.
     */
    updateTeamBrainDraftIntake(id: string, proposerUserId: string, intake: TeamBrainIntake): boolean {
      return (
        this.db
          .prepare(
            `UPDATE team_brain_proposals SET intake_json = ?, updated_at = ?
             WHERE id = ? AND proposer_user_id = ? AND kind IN ('propose', 'direct') AND status = 'draft'`,
          )
          .run(JSON.stringify(intake), now(), id, proposerUserId).changes > 0
      );
    }

    /** Run `fn` in ONE db transaction (a review press moves two rows together). */
    teamBrainTransaction<T>(fn: () => T): T {
      return this.db.transaction(fn)();
    }

    /**
     * The rewind cascade of `conversationId`: drafts whose card lived in the
     * discarded messages — and that still live in THAT conversation (an
     * answered 보완 요청 moves the card to the answering one) — are withdrawn; a
     * once-submitted proposal falls back to needs_info instead. A submitted or
     * applied card stays (a rewind never undoes the world).
     */
    withdrawTeamBrainDrafts(conversationId: string, ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      const inList = `conversation_id = ? AND id IN (${ids.map(() => "?").join(", ")})`;
      return this.db.transaction(() => {
        const reopened = reopenAnsweredDrafts(this.db, inList, [conversationId, ...ids]);
        const withdrawn = this.db
          .prepare(
            `UPDATE team_brain_proposals SET status = CASE WHEN kind = 'propose' THEN 'withdrawn' ELSE 'cancelled' END,
               updated_at = ? WHERE status = 'draft' AND ${inList}`,
          )
          .run(now(), conversationId, ...ids).changes;
        return reopened + withdrawn;
      })();
    }

    /**
     * Cancel every DRAFT review card on `targetId` except `exceptId` (one
     * decision per round: once a review is applied, or the target withdrawn,
     * the other drafted decisions on it are void — a changeset compiled before
     * a 보완 요청 answer must never commit after it). Returns the ids cancelled.
     */
    cancelTeamBrainReviewDrafts(targetId: string, exceptId?: string): string[] {
      const rows = this.db
        .prepare("SELECT id FROM team_brain_proposals WHERE kind = 'review' AND status = 'draft' AND target_id = ? AND id != ?")
        .all(targetId, exceptId ?? "") as Array<{ id: string }>;
      const cancel = this.db.prepare(
        "UPDATE team_brain_proposals SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'draft'",
      );
      return rows.filter((r) => cancel.run(now(), r.id).changes > 0).map((r) => r.id);
    }

    /** Undo cancelTeamBrainReviewDrafts after a failed apply (only rows still cancelled). */
    restoreTeamBrainReviewDrafts(ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      return this.db
        .prepare(
          `UPDATE team_brain_proposals SET status = 'draft', updated_at = ?
           WHERE kind = 'review' AND status = 'cancelled' AND id IN (${ids.map(() => "?").join(", ")})`,
        )
        .run(now(), ...ids).changes;
    }

    /** An approve card on `targetId` is claimed and its commit is in flight (the target is still pending). */
    teamBrainApplyInFlight(targetId: string): boolean {
      return Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM team_brain_proposals r JOIN team_brain_proposals t ON t.id = r.target_id
             WHERE r.target_id = ? AND r.kind = 'review' AND r.status = 'applied' AND r.decision = 'approve' AND t.status = 'pending'`,
          )
          .get(targetId),
      );
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

    /**
     * The owner's approved submissions that recorded personal notes, newest
     * first: each with the team pages its approving changeset wrote (a propose
     * row: the applied approve review on it; an admin's direct card: its own).
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
            // A maintenance direct card has no source, so no raw path (`path` = "").
            fromSource: r.kind === "propose" || Boolean(r.path),
          };
        })
        .filter((l) => l.notes.length > 0);
    }

    /** deleteUser cascade: the user's own rows (approved content stays in git). */
    deleteTeamBrainProposalsForUser(userId: string): void {
      this.db.prepare("DELETE FROM team_brain_proposals WHERE proposer_user_id = ?").run(userId);
      this.teamBrainCardPressLog.forgetUser(userId);
    }
  };
}
