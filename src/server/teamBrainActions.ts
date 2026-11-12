// Team brain — what a HUMAN press on a chat card does (routes/teamBrain.ts).
// The model can only draft rows (agent/teamBrainTools.ts); every state change
// lands here, re-checking everything live: the presser is the row's own
// drafter, still active, an admin where the action needs one, the row is in
// the status the button expects (compare-and-set — two admins pressing at once
// decide a proposal once), and every page is exactly what the draft saw and
// the changeset still passes the schema (applyTeamChangeset re-checks both
// under the vault lock — refused, never overwritten). User-facing messages are
// Korean; the server's English validation errors never reach the UI.

import { commitIdentityFor } from "./knowledgeRepo.js";
import {
  TeamChangesetInvalidError,
  TeamNoteConflictError,
  applyTeamChangeset,
  applyTeamPolicy,
  teamBrainProposalCommits,
  teamPageStates,
  teamPolicyState,
} from "./teamBrain.js";
import {
  findSecretInText,
  isTeamRawPath,
  parseTeamPage,
  renderTeamRaw,
  teamPageTypeForPath,
  withTeamProvenance,
} from "./teamBrainSchema.js";
import { composeTeamBrainCardPress, type TeamBrainCardPressBatch } from "./teamBrainCardPress.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import {
  TEAM_BRAIN_SUBMIT_ALL_MIN,
  TEAM_POLICY_PATH,
  teamProvenanceIssues,
  teamProvenanceProblemLabel,
  type TeamBrainCardPressAction,
  type TeamBrainCardView,
  type TeamBrainProposal,
  type TeamPageChangeView,
  type TeamProvenanceInput,
} from "../shared/teamBrain.js";

export interface TeamBrainActor {
  id: string;
  username: string;
  displayName: string;
}

/**
 * `message` is the Korean line the card shows. `agent` is the same refusal for
 * the AVATAR (English): why the press did nothing and whose fix it is — it
 * rides the press report (`teamBrainCardPress.ts`), never the UI.
 */
export type TeamBrainActionResult =
  | { ok: true; view: TeamBrainCardView; /** 초안 모두 제출: what the ONE press sent and what it left. */ batch?: TeamBrainCardPressBatch }
  | { ok: false; status: number; message: string; agent?: string };

export interface TeamBrainActionDeps {
  store: Store;
  config: AppConfig;
  /** A changeset was committed — the backup mirror schedules a push. */
  onCommitted?: () => void;
  audit?: (action: string, detail: string, status?: "success" | "error") => void;
}

const NOT_FOUND = { ok: false as const, status: 404, message: "카드를 찾을 수 없습니다." };
const ALREADY = { ok: false as const, status: 409, message: "이미 처리된 카드입니다." };
/** The row's OWN source (propose, or an admin's direct card with one) — what its provenance describes. */
function hasOwnSource(row: TeamBrainProposal): boolean {
  return (row.kind === "propose" || row.kind === "direct") && Boolean(row.intake?.type);
}

/**
 * The drafter's submission drafts whose card lives in `row`'s conversation,
 * oldest first: `ready` to go to the admins, and `held` back because their
 * provenance is still incomplete (the user fills it on that card). What ONE
 * press of 초안 모두 제출 covers — each of them is a card the user can see in
 * that conversation.
 */
function conversationSubmissionDrafts(store: Store, row: TeamBrainProposal): TeamBrainCardPressBatch & { ready: TeamBrainProposal[] } {
  const drafts = row.conversationId
    ? store
        .listTeamBrainProposals({
          kind: "propose",
          statuses: ["draft"],
          proposerUserId: row.proposerUserId,
          conversationId: row.conversationId,
          limit: 200,
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    : [row];
  const ready = drafts.filter((d) => teamProvenanceIssues(d.intake).length === 0);
  return { ready, submitted: [], held: drafts.filter((d) => !ready.includes(d)) };
}

/** How many drafts 초안 모두 제출 on THIS card would send: only on the newest ready draft of at least two. */
function submitAllCount(store: Store, row: TeamBrainProposal): number {
  if (row.kind !== "propose" || row.status !== "draft") return 0;
  const { ready } = conversationSubmissionDrafts(store, row);
  return ready.length >= TEAM_BRAIN_SUBMIT_ALL_MIN && ready[ready.length - 1]!.id === row.id ? ready.length : 0;
}

const PROVENANCE_INCOMPLETE = "출처 정보(출처 유형·출처·작성자·작성일)를 카드에서 먼저 채워 주세요.";

/** "이미 처리된 카드입니다" for a reported press, naming the row's status NOW. */
function alreadyHandled(store: Store, id: string): TeamBrainActionResult {
  const status = store.getTeamBrainProposal(id)?.status ?? "gone";
  const redraft = status === "cancelled" || status === "expired" || status === "withdrawn" || status === "gone";
  return {
    ...ALREADY,
    agent: `The card is not a draft any more (its status is now "${status}") — it was already pressed, cancelled or it expired, so this press did nothing. ${
      redraft ? "If the change is still wanted, draft a new card." : "Do not draft it again."
    }`,
  };
}

/** The provenance refusal for a reported press, naming the slots the card still needs. */
function provenanceIncomplete(row: TeamBrainProposal): TeamBrainActionResult {
  const slots = teamProvenanceIssues(row.intake).map((i) => i.slot);
  return {
    ok: false,
    status: 409,
    message: PROVENANCE_INCOMPLETE,
    agent: `The source's provenance is incomplete or invalid (${slots.join(", ")}). The user fills it in on the card itself (its 출처 정보 form) and presses the button again — do not draft the card again.`,
  };
}

const NOT_SAVED_AGENT =
  "Noah could not write the team brain (a failure on Noah's side, not a problem with the card). The card is a draft again, so the user can press it again — do not draft it again. If it keeps failing, an admin of this Noah instance has to look at the server.";

/** The avatar's version of a refused commit: what changed under the card, and that the fix is a NEW card. */
function applyErrorAgentNote(error: unknown): string | undefined {
  if (error instanceof TeamNoteConflictError) {
    const what =
      error.reason === "EXISTS"
        ? "a file this card creates exists now"
        : error.reason === "MISSING"
          ? "a page this card updates is gone"
          : "a page this card updates changed after you read it";
    return `The team brain changed after this card was drafted — ${what}${error.path ? ` (${error.path})` : ""}. Nothing was committed and this card can no longer be applied. Read the affected page(s) again with mcp__brain__get_note (scope "team"), rebuild the change on the current content (with the new \`blob\` as \`baseBlob\`) and draft a new card.`;
  }
  if (error instanceof TeamChangesetInvalidError) {
    const lines = error.errors.slice(0, 10).map((line) => `- ${line.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    return `The change no longer passes the team-brain rules as the vault is now (${error.errors.length} problem${error.errors.length === 1 ? "" : "s"}):\n${lines.join("\n")}\nNothing was committed. Fix these and draft a new card.`;
  }
  return undefined;
}

const STALE_MESSAGE = "그 사이 팀 브레인이 바뀌었습니다. 아바타에게 현재 내용에 맞춰 다시 정리해 달라고 요청하세요.";

/** A policy card's one "page": POLICY.md now → the drafted text; stale = it changed since the draft. */
async function policyView(config: AppConfig, row: TeamBrainProposal, checkStale: boolean): Promise<TeamPageChangeView[]> {
  const state = await teamPolicyState(config);
  return [
    {
      path: TEAM_POLICY_PATH,
      op: row.baseBlob === null ? "create" : "update",
      title: "팀 정책",
      type: null,
      before: row.status === "draft" ? state.content : null,
      after: row.content,
      stale: checkStale && state.blob !== row.baseBlob,
    },
  ];
}

/** Each page write of a changeset with its committed state now; stale = changed since the draft. */
async function pageViews(config: AppConfig, row: TeamBrainProposal, checkStale: boolean): Promise<TeamPageChangeView[]> {
  if (row.kind === "policy") return policyView(config, row, checkStale);
  const changes = row.changeset?.changes ?? [];
  if (changes.length === 0) return [];
  const states = await teamPageStates(
    config,
    changes.map((c) => c.path),
  );
  return changes.map((c) => {
    const state = states.get(c.path) ?? { content: null, blob: null };
    const parsed = parseTeamPage(c.path, c.content);
    const stale = checkStale && (c.op === "create" ? state.blob !== null : state.blob !== c.baseBlob);
    return {
      path: c.path,
      op: c.op,
      title: parsed.ok ? parsed.meta.title : parsed.title,
      type: parsed.ok ? parsed.meta.type : teamPageTypeForPath(c.path),
      // Once applied, the committed page IS `after` — show no "before" rather than a misleading empty diff.
      before: row.status === "draft" ? state.content : null,
      after: c.content,
      stale,
    };
  });
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
  const targetRow = proposal.targetId ? store.getTeamBrainProposal(proposal.targetId) : null;
  // A review card's target is a TEAMMATE's submission: their personal-note paths stay theirs.
  const target = targetRow ? { ...targetRow, personalNotes: [] } : null;
  const draft = proposal.status === "draft";
  const pages = await pageViews(config, proposal, draft);
  const stale = pages.some((p) => p.stale);
  const admin = store.isActiveAdmin(viewerId);
  const submitAll = submitAllCount(store, proposal);
  // Seeing a decided proposal on its card counts as seeing the result (the badge clears).
  if (proposal.kind === "propose" && ["approved", "rejected", "needs_info"].includes(proposal.status)) {
    store.markTeamBrainResultsSeen(viewerId, [proposal.id]);
  }
  return {
    proposal,
    target,
    stale,
    pages,
    actions: {
      submit: proposal.kind === "propose" && draft,
      withdraw: proposal.kind === "propose" && (draft || proposal.status === "pending" || proposal.status === "needs_info"),
      apply:
        proposal.kind !== "propose" &&
        draft &&
        admin &&
        !stale &&
        (proposal.kind === "direct" || proposal.kind === "policy" || target?.status === "pending"),
      cancel: proposal.kind !== "propose" && draft,
      // Present only on the one card that carries the button.
      ...(submitAll ? { submitAll } : {}),
    },
    provenance: hasOwnSource(proposal)
      ? { editable: draft, issues: teamProvenanceIssues(proposal.intake).map((i) => i.slot) }
      : null,
  };
}

async function viewOrGone(deps: TeamBrainActionDeps, viewerId: string, id: string): Promise<TeamBrainActionResult> {
  const view = await teamBrainCardView(deps, viewerId, id);
  return view ? { ok: true, view } : NOT_FOUND;
}

/** 관리자에게 제출: a teammate's draft source goes to the review queue (a source has no staleness). */
export async function submitTeamBrainProposal(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  store.expireTeamBrainDrafts();
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id || !store.isActiveUser(actor.id)) return NOT_FOUND;
  if (row.kind !== "propose" || row.status !== "draft") return alreadyHandled(store, id);
  // A source goes to the queue only with its provenance (rows drafted before it was asked fill it on the card).
  if (teamProvenanceIssues(row.intake).length > 0) return provenanceIncomplete(row);
  if (!store.transitionTeamBrainProposal(id, ["draft"], "pending")) return alreadyHandled(store, id);
  deps.audit?.("team_brain_submit", `${row.id} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

/**
 * 초안 N건 모두 제출: ONE press sends every submission draft of the pressed
 * card's conversation to the review queue (the brain-share selection pass
 * drafts several at once). Each of them is the presser's own draft, shown as a
 * card in that conversation; a draft whose provenance is incomplete stays a
 * draft and is named in the press report. Each row is its own compare-and-set,
 * so one pressed meanwhile is simply not sent twice.
 */
export async function submitAllTeamBrainProposals(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
  /** The number on the button the user pressed; a press never sends a different number of drafts. */
  expected?: number,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  store.expireTeamBrainDrafts();
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id || !store.isActiveUser(actor.id)) return NOT_FOUND;
  if (row.kind !== "propose" || row.status !== "draft") return alreadyHandled(store, id);
  if (teamProvenanceIssues(row.intake).length > 0) return provenanceIncomplete(row);
  const { ready, held } = conversationSubmissionDrafts(store, row);
  // The card was read before another draft appeared, was filled in or went away: the user
  // agreed to the number they saw, so nothing is sent and the card shows the number now.
  if (expected !== undefined && expected !== ready.length) {
    return {
      ok: false,
      status: 409,
      message: `그 사이 제출할 초안이 ${ready.length}건으로 바뀌었습니다. 카드를 확인한 뒤 다시 눌러 주세요.`,
      agent: `The drafts of this conversation changed after the card was last read: its button said ${expected}, ${ready.length} ${ready.length === 1 ? "is" : "are"} ready now. Nothing was sent; the card shows the current number, and the user presses again if they still want to — do not draft anything again.`,
    };
  }
  const submitted: TeamBrainProposal[] = [];
  let failed = false;
  for (const draft of ready) {
    try {
      if (!store.transitionTeamBrainProposal(draft.id, ["draft"], "pending")) continue;
      submitted.push(draft);
      deps.audit?.("team_brain_submit", `${draft.id} ${draft.path} (one press for ${ready.length})`);
    } catch (error) {
      // Nothing sent yet: an ordinary failed press. Part-way: say exactly what went and what did not.
      if (submitted.length === 0) throw error;
      logger.error({ err: error, proposalId: draft.id }, "team brain submit-all stopped part-way");
      failed = true;
      break;
    }
  }
  if (submitted.length === 0) return alreadyHandled(store, id);
  const unsent = failed
    ? ready.filter((d) => !submitted.includes(d) && store.getTeamBrainProposal(d.id)?.status === "draft")
    : [];
  const view = await teamBrainCardView(deps, actor.id, id);
  return view ? { ok: true, view, batch: { submitted, held, ...(unsent.length ? { unsent } : {}) } } : NOT_FOUND;
}

/**
 * 출처 정보 수정: the drafter corrects their own draft source's provenance on
 * the card (a propose draft, or an admin's direct card with a source). Every
 * field is re-validated with the intake rules and scanned for secrets.
 */
export async function editTeamBrainProvenance(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
  body: unknown,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  store.expireTeamBrainDrafts();
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id || !store.isActiveUser(actor.id)) return NOT_FOUND;
  if (!hasOwnSource(row) || !row.intake) return { ok: false, status: 409, message: "이 카드에는 고칠 출처 정보가 없습니다." };
  if (row.status !== "draft") return ALREADY;
  const b = (body && typeof body === "object" ? body : {}) as Partial<Record<keyof TeamProvenanceInput, unknown>>;
  const field = (v: unknown) => (typeof v === "string" ? v : "");
  const input = {
    source_kind: field(b.sourceKind),
    source: field(b.source),
    author: field(b.author),
    authored_at: field(b.authoredAt),
  };
  const merged = withTeamProvenance(row.intake, input);
  if (!merged.ok) {
    return { ok: false, status: 400, message: merged.issues.map((i) => teamProvenanceProblemLabel(i.slot, i.problem)).join(" ") };
  }
  if (findSecretInText(Object.values(input).join("\n"), store.getUserSecrets(actor.id))) {
    return { ok: false, status: 400, message: "출처 정보에 비밀 값(토큰·비밀번호 등)이 들어 있습니다. 지우고 다시 저장하세요." };
  }
  if (!store.updateTeamBrainDraftIntake(id, actor.id, merged.intake)) return ALREADY;
  deps.audit?.("team_brain_edit_provenance", `${row.id} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

/** 철회 / 취소: the drafter takes back a draft, pending or needs_info proposal, or cancels an admin card. */
export async function withdrawTeamBrainProposal(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id) return NOT_FOUND;
  let inFlight = false;
  const moved = store.teamBrainTransaction(() => {
    if (row.kind !== "propose") return store.transitionTeamBrainProposal(id, ["draft"], "cancelled");
    // An admin's approve is committing right now: the source is being published — too late to take back.
    if (store.teamBrainApplyInFlight(id)) {
      inFlight = true;
      return false;
    }
    if (!store.transitionTeamBrainProposal(id, ["draft", "pending", "needs_info"], "withdrawn")) return false;
    store.cancelTeamBrainReviewDrafts(id); // the drafted decisions on it are void
    return true;
  });
  if (inFlight) return { ok: false, status: 409, message: "관리자가 지금 이 제안을 팀 브레인에 반영하고 있습니다." };
  if (!moved) return ALREADY;
  deps.audit?.("team_brain_withdraw", `${row.id} ${row.kind} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

/**
 * The commit landed: the target is approved. The CAS cannot lose to another
 * press (an approve in flight blocks them and the withdraw); if it ever does,
 * the vault is the truth — compensate by forcing approved and log it.
 */
function approveTargetAfterCommit(store: Store, targetId: string, decidedBy: string): void {
  const fields = { decidedBy, decisionReason: null, decided: true, resetSeen: true };
  if (store.transitionTeamBrainProposal(targetId, ["pending"], "approved", fields)) return;
  logger.error({ proposalId: targetId }, "team brain: approved target left pending; forcing approved (its source is committed)");
  store.transitionTeamBrainProposal(targetId, ["draft", "needs_info", "rejected", "withdrawn", "expired"], "approved", fields);
}

/** How far back the boot sweep looks (an applied card older than this is history). */
const BOOT_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Boot sweep: an approve card (direct, or review approve) claimed BEFORE this
 * process started, in the last 7 days, whose commit (`Proposal: <id>` trailer)
 * never landed — the process died mid-apply — goes back to draft (and an old
 * build's already-approved target back to pending); one whose commit DID land
 * but whose target is still pending gets the target approved. Claims made
 * after `startedAt` are this process's own (maybe in flight) — never touched.
 * Never throws.
 */
export async function sweepTeamBrainAppliesOnBoot(
  deps: Pick<TeamBrainActionDeps, "store" | "config">,
  startedAt: string,
): Promise<number> {
  const { store, config } = deps;
  try {
    const since = new Date(Date.parse(startedAt) - BOOT_SWEEP_WINDOW_MS).toISOString();
    const rows = store
      .listTeamBrainProposals({ statuses: ["applied"], limit: 200 })
      .filter(
        (r) =>
          (r.kind === "direct" || r.kind === "policy" || (r.kind === "review" && r.decision === "approve")) &&
          r.decidedAt !== null &&
          r.decidedAt >= since &&
          r.decidedAt < startedAt,
      );
    if (rows.length === 0) return 0;
    const landed = await teamBrainProposalCommits(config, new Date(Date.parse(since) - 24 * 60 * 60 * 1000).toISOString());
    let fixed = 0;
    for (const r of rows) {
      const target = r.kind === "review" && r.targetId ? store.getTeamBrainProposal(r.targetId) : null;
      if (landed.has(target?.id ?? r.id)) {
        if (target?.status === "pending") {
          approveTargetAfterCommit(store, target.id, r.decidedBy ?? r.proposerUserId);
          fixed += 1;
        }
        continue;
      }
      store.teamBrainTransaction(() => {
        store.transitionTeamBrainProposal(r.id, ["applied"], "draft", { clearDecision: true });
        if (target) store.transitionTeamBrainProposal(target.id, ["approved"], "pending", { clearDecision: true, decisionReason: null });
      });
      logger.warn({ proposalId: r.id }, "team brain: an applied card's commit never landed; the card is a draft again");
      fixed += 1;
    }
    return fixed;
  } catch (error) {
    logger.error({ err: error }, "team brain boot sweep failed");
    return 0;
  }
}

function applyErrorMessage(error: unknown): string | null {
  if (error instanceof TeamNoteConflictError) return STALE_MESSAGE;
  if (error instanceof TeamChangesetInvalidError) {
    return `변경 내용이 팀 브레인 규칙에 맞지 않습니다 (문제 ${error.errors.length}건). 아바타에게 다시 정리해 달라고 요청하세요.`;
  }
  return null;
}

/**
 * 팀 정책 반영 (policy): claim the card, commit POLICY.md (refused when it
 * changed since the draft or no longer passes the policy rules), release the
 * claim on a failed write. The new knobs apply from the next store read
 * (readTeamPolicySync re-reads on the file's mtime).
 */
async function applyPolicyCard(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  row: TeamBrainProposal,
): Promise<TeamBrainActionResult> {
  const { store, config } = deps;
  if (!store.transitionTeamBrainProposal(row.id, ["draft"], "applied", { decidedBy: actor.id, decided: true })) {
    return alreadyHandled(store, row.id);
  }
  try {
    await applyTeamPolicy(config, {
      content: row.content,
      baseBlob: row.baseBlob,
      title: row.title,
      proposalId: row.id,
      author: commitIdentityFor(store, actor),
      logApprovedBy: actor.username,
    });
  } catch (error) {
    store.transitionTeamBrainProposal(row.id, ["applied"], "draft", { clearDecision: true });
    if (error instanceof TeamNoteConflictError) {
      return {
        ok: false,
        status: 409,
        message: "그 사이 팀 정책이 바뀌었습니다. 아바타에게 현재 정책에 맞춰 다시 정리해 달라고 요청하세요.",
        agent: `${TEAM_POLICY_PATH} changed after this card was drafted. Nothing was committed and this card can no longer be applied. Read it again (mcp__brain__get_note, scope "team"), make the same change on the current file and draft a new policy card with its new \`blob\` as \`baseBlob\`.`,
      };
    }
    if (error instanceof TeamChangesetInvalidError) {
      return {
        ok: false,
        status: 409,
        message: "팀 정책 형식이 올바르지 않습니다. 아바타에게 다시 정리해 달라고 요청하세요.",
        agent: applyErrorAgentNote(error),
      };
    }
    logger.error({ err: error, proposalId: row.id }, "team policy apply failed");
    deps.audit?.("team_brain_policy", row.id, "error");
    return { ok: false, status: 500, message: "팀 정책을 저장하지 못했습니다.", agent: NOT_SAVED_AGENT };
  }
  deps.onCommitted?.();
  deps.audit?.("team_brain_policy", `${row.id} ${TEAM_POLICY_PATH}`);
  return viewOrGone(deps, actor.id, row.id);
}

/**
 * 팀 브레인에 반영 (direct) / 승인 반영 · 반려 확정 · 보완 요청 보내기 (review):
 * admin only. The card (and, for a review, its target) is CLAIMED first by
 * compare-and-set in one transaction; a failed write releases the claim so the
 * card can be pressed again.
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
    return {
      ok: false,
      status: 403,
      message: "관리자만 팀 브레인에 반영할 수 있습니다.",
      agent: "The user is not an active admin any more, so they cannot apply team-brain cards. Nothing you draft can change that.",
    };
  }
  if (row.kind === "propose" || row.status !== "draft") return alreadyHandled(store, id);
  if (row.kind === "policy") return applyPolicyCard(deps, actor, row);
  // The admin's own source is committed as a raw file: its provenance must be complete too.
  if (hasOwnSource(row) && teamProvenanceIssues(row.intake).length > 0) return provenanceIncomplete(row);
  const target = row.kind === "review" && row.targetId ? store.getTeamBrainProposal(row.targetId) : null;
  if (row.kind === "review" && (!target || target.kind !== "propose" || target.status !== "pending")) {
    return {
      ok: false,
      status: 409,
      message: "이 제안은 이미 처리되었거나 철회되었습니다.",
      agent: `The submission this card decides is not pending any more (its status is now "${
        target?.kind === "propose" ? target.status : "gone"
      }") — it was already decided or withdrawn, so this decision card is void. Do not draft it again.`,
    };
  }
  const decision = row.kind === "direct" ? "approve" : row.decision;
  if (!decision) {
    return {
      ok: false,
      status: 409,
      message: "이 카드의 결정이 올바르지 않습니다.",
      agent: "This card records no valid decision. Draft the decision again with mcp__brain__prepare_team_review.",
    };
  }
  const commits = decision === "approve";
  if (commits && (!row.changeset || row.changeset.changes.length === 0)) {
    return {
      ok: false,
      status: 409,
      message: "반영할 변경 내용이 없습니다. 아바타에게 다시 정리해 달라고 요청하세요.",
      agent: "This card carries no page changes to commit. Draft it again with the pages it creates or updates.",
    };
  }
  if (commits && target && !isTeamRawPath(target.path)) {
    return {
      ok: false,
      status: 409,
      message: "이 제안의 원본 경로가 올바르지 않습니다.",
      agent: "The submission's source path is not a raw/ path (a row from before the schema), so it cannot be committed as a source. It can only be rejected, or asked to be submitted again.",
    };
  }
  const targetTo = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "needs_info";

  // Claim. Every press voids the OTHER drafted decisions on the same target
  // (one decision per round — a changeset compiled before a 보완 요청 answer
  // never commits after it). reject / ask move the card AND the target
  // together. An approve claims the CARD only: the target turns approved after
  // the commit lands, so the proposer never sees an approval that may still
  // fail; an approve in flight blocks every other press and the withdraw.
  let claimed = false;
  let voided: string[] = [];
  try {
    claimed = store.teamBrainTransaction(() => {
      if (target && (store.getTeamBrainProposal(target.id)?.status !== "pending" || store.teamBrainApplyInFlight(target.id))) {
        return false;
      }
      if (!store.transitionTeamBrainProposal(id, ["draft"], "applied", { decidedBy: actor.id, decided: true })) return false;
      if (target) {
        voided = store.cancelTeamBrainReviewDrafts(target.id, id);
        if (!commits) {
          const moved = store.transitionTeamBrainProposal(target.id, ["pending"], targetTo, {
            decidedBy: actor.id,
            // reject: the reason; ask: the questions (shown to the proposer while needs_info).
            decisionReason: row.decisionReason,
            decided: true,
            resetSeen: true,
          });
          if (!moved) throw new Error("TARGET_RACE"); // rolls the whole claim back
        }
      }
      return true;
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "TARGET_RACE")) throw error;
  }
  if (!claimed) return alreadyHandled(store, id);

  // A failed write decided nothing: the card is a draft again (no decision
  // stamps) and the drafts it voided come back.
  const release = () =>
    store.teamBrainTransaction(() => {
      store.transitionTeamBrainProposal(id, ["applied"], "draft", { clearDecision: true });
      store.restoreTeamBrainReviewDrafts(voided);
    });

  if (commits) {
    const proposer = target ? store.getUserById(target.proposerUserId) : null;
    const approver = { name: actor.displayName || actor.username, username: actor.username };
    const approvedAt = new Date().toISOString();
    // The source being committed: the target's (review), or the admin's own (direct with a source).
    const source = target ?? (row.intake ? row : null);
    const submitter = target
      ? proposer
        ? { name: proposer.displayName || proposer.username, username: proposer.username }
        : { name: target.proposerName, username: "" }
      : approver;
    try {
      await applyTeamChangeset(config, {
        raw: source
          ? { path: source.path, content: renderTeamRaw({ proposal: source, approver, approvedAt, submitter }) }
          : null,
        changes: row.changeset!.changes,
        title: row.title,
        proposalId: target?.id ?? row.id,
        logOp: target ? "ingest" : row.intake ? "direct" : "maintain",
        logBy: target ? submitter.username || submitter.name : undefined,
        logApprovedBy: actor.username,
        author: commitIdentityFor(store, actor),
        coAuthor: proposer && proposer.id !== actor.id ? commitIdentityFor(store, proposer) : null,
      });
    } catch (error) {
      release();
      const message = applyErrorMessage(error);
      if (message) {
        if (error instanceof TeamChangesetInvalidError) {
          logger.warn({ proposalId: id, errors: error.errors.slice(0, 10) }, "team brain changeset refused at apply");
        }
        return { ok: false, status: 409, message, agent: applyErrorAgentNote(error) };
      }
      logger.error({ err: error, proposalId: id }, "team brain apply failed");
      deps.audit?.("team_brain_apply", `${row.id} ${row.path}`, "error");
      return { ok: false, status: 500, message: "팀 브레인에 저장하지 못했습니다.", agent: NOT_SAVED_AGENT };
    }
    deps.onCommitted?.();
    if (target) approveTargetAfterCommit(store, target.id, actor.id);
  }
  const action =
    row.kind === "direct"
      ? "team_brain_direct"
      : decision === "approve"
        ? "team_brain_approve"
        : decision === "reject"
          ? "team_brain_reject"
          : "team_brain_ask";
  const pages = row.changeset?.changes.length ?? 0;
  deps.audit?.(
    action,
    `${target?.id ?? row.id} ${target?.path ?? row.path}${commits ? ` (${pages} pages)` : ""}${target ? ` (proposer ${target.proposerUserId})` : ""}`,
  );
  return viewOrGone(deps, actor.id, id);
}

/**
 * A press of a card's confirm button as the ROUTE runs it: the action above,
 * plus the report the presser's chat hands to the avatar
 * (`teamBrainCardPress.ts`) — done, or refused and why. Recorded only for a
 * card that is the presser's own (anything else is a 404 that names nothing).
 */
export async function pressTeamBrainCard(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
  action: TeamBrainCardPressAction,
  /** `submit_all` only: the number on the button that was pressed. */
  expected?: number,
): Promise<TeamBrainActionResult> {
  const card = deps.store.getTeamBrainProposal(id);
  const mine = card && card.proposerUserId === actor.id ? card : null;
  const record = (outcome: { ok: true; batch?: TeamBrainCardPressBatch } | { ok: false; agent?: string }) => {
    if (!mine) return;
    deps.store.noteTeamBrainCardPress({
      proposalId: id,
      userId: actor.id,
      action,
      ok: outcome.ok,
      ...composeTeamBrainCardPress({ action, card: mine, outcome }),
    });
  };
  let result: TeamBrainActionResult;
  try {
    result =
      action === "submit"
        ? await submitTeamBrainProposal(deps, actor, id)
        : action === "submit_all"
          ? await submitAllTeamBrainProposals(deps, actor, id, expected)
          : await applyTeamBrainCard(deps, actor, id);
  } catch (error) {
    // An unexpected failure is a refused press too: whatever the client is answered, the report says so.
    record({ ok: false, agent: NOT_SAVED_AGENT });
    throw error;
  }
  if (result.ok) record({ ok: true, batch: result.batch });
  else if (result.status !== 404) record({ ok: false, agent: result.agent });
  return result;
}
