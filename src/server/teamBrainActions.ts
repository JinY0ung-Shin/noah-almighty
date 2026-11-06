// Team brain — what a HUMAN press on a chat card does (routes/teamBrain.ts).
// The model can only draft rows (agent/teamBrainTools.ts); every state change
// lands here, re-checking everything live: the presser is the row's own
// drafter, still active, an admin where the action needs one, the row is in
// the status the button expects (compare-and-set — two admins pressing at once
// decide a proposal once), and the note is exactly what the draft saw (stale →
// refused, never overwritten). User-facing messages are Korean.

import { commitIdentityFor } from "./knowledgeRepo.js";
import {
  TeamNoteConflictError,
  applyTeamNote,
  teamNoteState,
} from "./teamBrain.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import type { TeamBrainCardView, TeamBrainProposal } from "../shared/teamBrain.js";

export interface TeamBrainActor {
  id: string;
  username: string;
  displayName: string;
}

export type TeamBrainActionResult =
  | { ok: true; view: TeamBrainCardView }
  | { ok: false; status: number; message: string };

export interface TeamBrainActionDeps {
  store: Store;
  config: AppConfig;
  /** A note was committed — the backup mirror schedules a push. */
  onCommitted?: () => void;
  audit?: (action: string, detail: string, status?: "success" | "error") => void;
}

const NOT_FOUND = { ok: false as const, status: 404, message: "카드를 찾을 수 없습니다." };

/** Does the note still match what the decision was drafted against? */
async function isStale(config: AppConfig, row: TeamBrainProposal): Promise<boolean> {
  if (row.kind === "review" && row.decision === "reject") return false;
  const state = await teamNoteState(config, row.path);
  return state.blob !== row.baseBlob;
}

/**
 * The card as `viewer` sees it, or null when they may not see it. Only the
 * row's drafter sees a card (it lives in THEIR conversation); a review card's
 * target is shown to that same admin drafter.
 */
export async function teamBrainCardView(
  deps: TeamBrainActionDeps,
  viewerId: string,
  id: string,
): Promise<TeamBrainCardView | null> {
  const { store, config } = deps;
  store.expireTeamBrainDrafts();
  const proposal = store.getTeamBrainProposal(id);
  if (!proposal || proposal.proposerUserId !== viewerId) return null;
  const target = proposal.targetId ? store.getTeamBrainProposal(proposal.targetId) : null;
  const state = await teamNoteState(config, proposal.path);
  const stale = proposal.status === "draft" ? await isStale(config, proposal) : false;
  const draft = proposal.status === "draft";
  const admin = store.isActiveAdmin(viewerId);
  // Seeing a decided proposal on its card counts as seeing the result (the badge clears).
  if (proposal.kind === "propose" && (proposal.status === "approved" || proposal.status === "rejected")) {
    store.markTeamBrainResultsSeen(viewerId, [proposal.id]);
  }
  return {
    proposal,
    target,
    stale,
    currentContent: state.content,
    actions: {
      submit: proposal.kind === "propose" && draft && !stale,
      withdraw: proposal.kind === "propose" && (draft || proposal.status === "pending"),
      apply:
        proposal.kind !== "propose" &&
        draft &&
        admin &&
        !stale &&
        (proposal.kind === "direct" || target?.status === "pending"),
      cancel: proposal.kind !== "propose" && draft,
    },
  };
}

async function viewOrGone(deps: TeamBrainActionDeps, viewerId: string, id: string): Promise<TeamBrainActionResult> {
  const view = await teamBrainCardView(deps, viewerId, id);
  return view ? { ok: true, view } : NOT_FOUND;
}

/** 관리자에게 제출: a teammate's draft goes to the review queue. */
export async function submitTeamBrainProposal(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store, config } = deps;
  store.expireTeamBrainDrafts();
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id || !store.isActiveUser(actor.id)) return NOT_FOUND;
  if (row.kind !== "propose" || row.status !== "draft") {
    return { ok: false, status: 409, message: "이미 처리된 카드입니다." };
  }
  if (await isStale(config, row)) {
    return { ok: false, status: 409, message: "그 사이 팀 브레인의 노트가 바뀌었습니다. 아바타에게 다시 제안을 요청하세요." };
  }
  if (!store.transitionTeamBrainProposal(id, ["draft"], "pending")) {
    return { ok: false, status: 409, message: "이미 처리된 카드입니다." };
  }
  deps.audit?.("team_brain_submit", `${row.id} ${row.op} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

/** 철회 / 취소: the drafter takes back a draft or a still-pending proposal, or cancels an admin card. */
export async function withdrawTeamBrainProposal(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id) return NOT_FOUND;
  const moved =
    row.kind === "propose"
      ? store.transitionTeamBrainProposal(id, ["draft", "pending"], "withdrawn")
      : store.transitionTeamBrainProposal(id, ["draft"], "cancelled");
  if (!moved) return { ok: false, status: 409, message: "이미 처리된 카드입니다." };
  deps.audit?.("team_brain_withdraw", `${row.id} ${row.kind} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

function conflictMessage(error: unknown): string | null {
  if (!(error instanceof TeamNoteConflictError)) return null;
  if (error.reason === "EXISTS") return "그 사이 같은 경로에 노트가 생겼습니다. 아바타에게 기존 노트와 합쳐 달라고 요청하세요.";
  if (error.reason === "MISSING") return "수정할 노트가 더 이상 없습니다.";
  return "그 사이 팀 브레인의 노트가 바뀌었습니다. 아바타에게 현재 노트에 맞춰 다시 정리해 달라고 요청하세요.";
}

/**
 * 팀 브레인에 반영 (direct) / 승인 반영 · 반려 확정 (review): admin only. The
 * card (and, for a review, its target) is CLAIMED first by compare-and-set in
 * one transaction; a failed write releases the claim so the card can be
 * pressed again.
 */
export async function applyTeamBrainCard(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store, config } = deps;
  store.expireTeamBrainDrafts();
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id) return NOT_FOUND;
  if (!store.isActiveAdmin(actor.id)) {
    return { ok: false, status: 403, message: "관리자만 팀 브레인에 반영할 수 있습니다." };
  }
  if (row.kind === "propose" || row.status !== "draft") {
    return { ok: false, status: 409, message: "이미 처리된 카드입니다." };
  }
  const target = row.kind === "review" && row.targetId ? store.getTeamBrainProposal(row.targetId) : null;
  if (row.kind === "review" && (!target || target.kind !== "propose" || target.status !== "pending")) {
    return { ok: false, status: 409, message: "이 제안은 이미 처리되었거나 철회되었습니다." };
  }
  const approve = row.kind === "direct" || row.decision === "approve";
  const targetTo = approve ? "approved" : "rejected";

  // Claim: the card (and its target) move together, or not at all.
  let claimed = false;
  try {
    claimed = store.teamBrainTransaction(() => {
    if (!store.transitionTeamBrainProposal(id, ["draft"], "applied", { decidedBy: actor.id, decided: true })) return false;
    if (target) {
      const moved = store.transitionTeamBrainProposal(target.id, ["pending"], targetTo, {
        decidedBy: actor.id,
        decisionReason: approve ? null : row.decisionReason,
        decided: true,
      });
      if (!moved) throw new Error("TARGET_RACE"); // rolls the card's claim back too
    }
    return true;
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "TARGET_RACE")) throw error;
  }
  if (!claimed) return { ok: false, status: 409, message: "이미 처리된 카드입니다." };

  const release = () =>
    store.teamBrainTransaction(() => {
      store.transitionTeamBrainProposal(id, ["applied"], "draft");
      if (target) store.transitionTeamBrainProposal(target.id, [targetTo], "pending");
    });

  if (approve) {
    const proposer = target ? store.getUserById(target.proposerUserId) : null;
    try {
      await applyTeamNote(config, {
        path: row.path,
        op: row.op,
        content: row.content,
        expectedBlob: row.baseBlob,
        title: row.title,
        proposalId: target?.id ?? row.id,
        author: commitIdentityFor(store, actor),
        coAuthor: proposer && proposer.id !== actor.id ? commitIdentityFor(store, proposer) : null,
      });
    } catch (error) {
      release();
      const conflict = conflictMessage(error);
      if (conflict) return { ok: false, status: 409, message: conflict };
      logger.error({ err: error, proposalId: id }, "team brain apply failed");
      deps.audit?.("team_brain_apply", `${row.id} ${row.path}`, "error");
      return { ok: false, status: 500, message: "팀 브레인에 저장하지 못했습니다." };
    }
    deps.onCommitted?.();
  }
  const action = row.kind === "direct" ? "team_brain_direct" : approve ? "team_brain_approve" : "team_brain_reject";
  deps.audit?.(action, `${target?.id ?? row.id} ${row.op} ${row.path}${target ? ` (proposer ${target.proposerUserId})` : ""}`);
  return viewOrGone(deps, actor.id, id);
}
