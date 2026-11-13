// Team brain — what a HUMAN press on a chat card does (routes/teamBrain.ts).
// The model can only draft rows (agent/teamBrainTools.ts); every state change
// lands here, re-checking everything live: the presser is the row's own
// drafter and still an active teammate (an admin for a policy card), the row
// is in the status the button expects (compare-and-set — two presses at once
// apply a card once), and every page is exactly what the draft saw and the
// changeset still passes the schema (applyTeamChangeset re-checks both under
// the vault lock — refused, never overwritten). User-facing messages are
// Korean; the server's English validation errors never reach the UI.
//
// The review queue (a teammate submits, an admin approves) was retired on
// 2026-11-13: its rows are history — shown, never pressed — and the ones still
// open at the upgrade are closed by `retireTeamBrainReviewQueueOnBoot`.

import { commitIdentityFor } from "./knowledgeRepo.js";
import {
  TeamChangesetInvalidError,
  TeamNoteConflictError,
  applyTeamChangeset,
  applyTeamPolicy,
  newLegacyCitations,
  teamBrainProposalCommits,
  teamPageStates,
  teamVaultHasHistory,
  teamPolicyState,
} from "./teamBrain.js";
import {
  findSecretInText,
  parseTeamPage,
  renderTeamRaw,
  teamPageTypeForPath,
  withTeamProvenance,
} from "./teamBrainSchema.js";
import { composeTeamBrainCardPress } from "./teamBrainCardPress.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import {
  TEAM_BRAIN_CLOSED_BY_UPGRADE,
  TEAM_BRAIN_LIVE_KINDS,
  TEAM_POLICY_PATH,
  isTeamBrainLegacyKind,
  teamProvenanceIssues,
  teamProvenanceProblemLabel,
  type TeamBrainCardPressAction,
  type TeamBrainCardView,
  type TeamBrainLegacyCard,
  type TeamBrainLiveKind,
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
  | { ok: true; view: TeamBrainCardView }
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
/** A card of the retired review queue: nothing can be pressed on it any more. */
const RETIRED = {
  ok: false as const,
  status: 409,
  message: "팀 브레인 작성 방식이 바뀌어 이 카드는 더 이상 처리할 수 없습니다.",
};
/** A suspended account writes nothing (the drafter is re-checked LIVE at every press). */
const SUSPENDED = {
  ok: false as const,
  status: 403,
  message: "정지된 계정은 팀 브레인 카드를 처리할 수 없습니다.",
  agent: "The user's account is suspended, so they cannot apply team-brain cards. Nothing you draft can change that.",
};

/** A live card (the only kinds a press acts on). */
type LiveCard = TeamBrainProposal & { kind: TeamBrainLiveKind };

function isLiveCard(row: TeamBrainProposal): row is LiveCard {
  return !isTeamBrainLegacyKind(row.kind);
}

/** The row's OWN source (a direct card that brings one) — what its provenance describes. */
function hasOwnSource(row: TeamBrainProposal): boolean {
  return row.kind === "direct" && Boolean(row.intake?.type);
}

const PROVENANCE_INCOMPLETE = "출처 정보(출처 유형·출처·작성자·작성일)를 카드에서 먼저 채워 주세요.";

/** "이미 처리된 카드입니다" for a reported press, naming the row's status NOW. */
function alreadyHandled(store: Store, id: string): TeamBrainActionResult {
  const status = store.getTeamBrainProposal(id)?.status ?? "gone";
  const redraft = status === "cancelled" || status === "expired" || status === "gone";
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
 * The ONE line a card of the retired review queue shows (Korean). A row the
 * upgrade closed — or one still open because the closing step has not run yet:
 * nothing can act on it either way — says that the way changed.
 */
function legacyCard(row: TeamBrainProposal): TeamBrainLegacyCard {
  const open = row.status === "draft" || row.status === "pending" || row.status === "needs_info";
  const closedByUpgrade = open || (row.status === "cancelled" && row.decisionReason === TEAM_BRAIN_CLOSED_BY_UPGRADE);
  if (row.kind === "review") {
    if (closedByUpgrade) {
      return { closedByUpgrade, notice: "팀 브레인 작성 방식이 바뀌어(검토 절차가 없어졌습니다) 이 검토 카드는 종료되었습니다.", source: null };
    }
    const notice =
      row.status === "applied"
        ? row.decision === "approve"
          ? "제안을 승인해 팀 브레인에 반영한 검토 카드입니다."
          : row.decision === "ask"
            ? "제안자에게 보완 요청을 보낸 검토 카드입니다."
            : "제안을 반려한 검토 카드입니다."
        : row.status === "expired"
          ? "누르지 않아 만료된 검토 카드입니다."
          : "취소된 검토 카드입니다.";
    return { closedByUpgrade, notice, source: null };
  }
  if (closedByUpgrade) {
    return {
      closedByUpgrade,
      // The drafter's own submitted text (the view is drafter-only): shown so it can be handed to the avatar again.
      source: row.content.trim() ? row.content : null,
      notice:
        "팀 브레인 작성 방식이 바뀌어 이 제안은 종료되었습니다. 이제 누구나 팀 브레인에 직접 반영할 수 있으니, 아바타에게 이 내용을 팀 브레인에 다시 반영해 달라고 요청하세요.",
    };
  }
  const notice =
    row.status === "approved"
      ? "승인되어 팀 브레인에 반영된 제안입니다."
      : row.status === "rejected"
        ? "반려된 제안입니다."
        : row.status === "withdrawn"
          ? "철회한 제안입니다."
          : row.status === "expired"
            ? "제출하지 않아 만료된 제안입니다."
            : "종료된 제안입니다.";
  return { closedByUpgrade, notice, source: null };
}

/**
 * The card as `viewer` sees it, or null when they may not see it. Only the
 * row's drafter sees a card (it lives in THEIR conversation). A row of the
 * retired review queue comes back as history: its title and one line.
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
  if (!isLiveCard(proposal)) {
    return { proposal, stale: false, pages: [], actions: { apply: false, cancel: false }, provenance: null, legacy: legacyCard(proposal) };
  }
  const draft = proposal.status === "draft";
  const pages = await pageViews(config, proposal, draft);
  const stale = pages.some((p) => p.stale);
  // Judged on the VIEWER, live: any active teammate applies their own changes; POLICY.md stays the admins'.
  const mayApply = proposal.kind === "policy" ? store.isActiveAdmin(viewerId) : store.isActiveUser(viewerId);
  return {
    proposal,
    stale,
    pages,
    actions: { apply: draft && !stale && mayApply, cancel: draft },
    provenance: hasOwnSource(proposal)
      ? { editable: draft, issues: teamProvenanceIssues(proposal.intake).map((i) => i.slot) }
      : null,
    legacy: null,
  };
}

async function viewOrGone(deps: TeamBrainActionDeps, viewerId: string, id: string): Promise<TeamBrainActionResult> {
  const view = await teamBrainCardView(deps, viewerId, id);
  return view ? { ok: true, view } : NOT_FOUND;
}

/**
 * 출처 정보 수정: the drafter corrects their own draft source's provenance on
 * the card (a direct card that brings a source). Every field is re-validated
 * with the intake rules and scanned for secrets.
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

/** 취소: the drafter takes back their own draft card. Never reported to the avatar. */
export async function cancelTeamBrainCard(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
): Promise<TeamBrainActionResult> {
  const { store } = deps;
  const row = store.getTeamBrainProposal(id);
  if (!row || row.proposerUserId !== actor.id) return NOT_FOUND;
  if (!isLiveCard(row)) return RETIRED;
  if (!store.isActiveUser(actor.id)) return SUSPENDED;
  if (!store.transitionTeamBrainProposal(id, ["draft"], "cancelled")) return ALREADY;
  deps.audit?.("team_brain_cancel", `${row.id} ${row.kind} ${row.path}`);
  return viewOrGone(deps, actor.id, id);
}

/** How far back the boot sweep looks (an applied card older than this is history). */
const BOOT_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Boot sweep: a card claimed (`applied`) BEFORE this process started, in the
 * last 7 days, whose commit (`Proposal: <id>` trailer) never landed — the
 * process died mid-apply — goes back to draft. Claims made after `startedAt`
 * are this process's own (maybe in flight) — never touched. Never throws.
 */
export async function sweepTeamBrainAppliesOnBoot(
  deps: Pick<TeamBrainActionDeps, "store" | "config">,
  startedAt: string,
): Promise<number> {
  const { store, config } = deps;
  try {
    const since = new Date(Date.parse(startedAt) - BOOT_SWEEP_WINDOW_MS).toISOString();
    // Per live kind, so rows of the retired queue (and the other kind) never crowd a card out of the newest 200.
    const rows = TEAM_BRAIN_LIVE_KINDS.flatMap((kind) => store.listTeamBrainProposals({ kind, statuses: ["applied"], limit: 200 })).filter(
      (r) => r.decidedAt !== null && r.decidedAt >= since && r.decidedAt < startedAt,
    );
    if (rows.length === 0) return 0;
    const landed = await teamBrainProposalCommits(config, new Date(Date.parse(since) - 24 * 60 * 60 * 1000).toISOString());
    let fixed = 0;
    for (const r of rows) {
      if (landed.has(r.id)) continue;
      if (!store.transitionTeamBrainProposal(r.id, ["applied"], "draft", { clearDecision: true })) continue;
      logger.warn({ proposalId: r.id }, "team brain: an applied card's commit never landed; the card is a draft again");
      fixed += 1;
    }
    return fixed;
  } catch (error) {
    logger.error({ err: error }, "team brain boot sweep failed");
    return 0;
  }
}

/**
 * Boot step — the review queue's retirement (2026-11-13: every teammate
 * writes directly). Rows an older build left OPEN in the queue (a submission
 * still draft / pending / needs_info, a review card nobody pressed) are closed:
 * status `cancelled`, reason `TEAM_BRAIN_CLOSED_BY_UPGRADE`, the source text
 * and everything else kept, so the drafter's card can say what happened.
 *
 * Behind `retirementGate()`: the whole DB is backed up first, and a failed
 * backup holds the step until a later boot. Before closing, an approval the
 * previous process claimed but did not finish is settled by the vault: its
 * commit landed → the submission is `approved` (history, and its personal
 * notes stay marked); it never landed → the approve card decided nothing and
 * is closed with the rest. A vault that cannot be read holds the step too.
 *
 * Value-guarded, not a `user_version` step: nothing mints a queue row any
 * more, so the predicate matches only what an older build left — a second run
 * (or a fresh DB) finds nothing, and rows an older build writes after a
 * rollback are closed on the next boot of this one. Never throws.
 */
export async function retireTeamBrainReviewQueueOnBoot(
  deps: Pick<TeamBrainActionDeps, "store" | "config">,
): Promise<{ approved: number; closed: number }> {
  const { store, config } = deps;
  const none = { approved: 0, closed: 0 };
  try {
    const open = store.countOpenTeamBrainQueueRows();
    if (open === 0) return none;
    const gate = store.retirementGate();
    if (!gate.allowed) {
      logger.error({ open }, "team brain: the review queue's open rows are NOT closed on this boot — the database backup that must come first failed");
      return none;
    }
    const inFlight = store.listTeamBrainInFlightApprovals();
    let landed: Set<string> = new Set();
    if (inFlight.length > 0) {
      // A vault that is missing or has no history cannot say whether an approval landed: "no commit" would
      // void approvals that really were committed. Hold the whole step until the vault is back.
      if (!(await teamVaultHasHistory(config))) {
        logger.error(
          { open, inFlight: inFlight.length },
          "team brain: the review queue's open rows are NOT closed on this boot — approvals were in flight and the vault cannot be read",
        );
        return none;
      }
      const oldest = inFlight.reduce((min, f) => (f.decidedAt && f.decidedAt < min ? f.decidedAt : min), new Date().toISOString());
      landed = await teamBrainProposalCommits(config, new Date(Date.parse(oldest) - 24 * 60 * 60 * 1000).toISOString());
    }
    const result = store.retireTeamBrainReviewQueue(landed);
    logger.warn(
      { ...result, backup: gate.backupPath },
      "team brain: the review queue is retired — its open rows were closed (source text kept; the drafters' cards say so)",
    );
    return result;
  } catch (error) {
    logger.error({ err: error }, "team brain: closing the retired review queue failed; it is retried on the next boot");
    return none;
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
 * 팀 브레인에 반영 (direct): every active teammate applies their OWN card — the
 * changeset (and the card's source, as a raw file) is committed in their name.
 * 팀 정책 반영 (policy): an active admin. The card is CLAIMED first by
 * compare-and-set; a failed write releases the claim so it can be pressed again.
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
  if (!isLiveCard(row)) return RETIRED;
  if (row.kind === "policy") {
    if (!store.isActiveAdmin(actor.id)) {
      return {
        ok: false,
        status: 403,
        message: "관리자만 팀 정책을 바꿀 수 있습니다.",
        agent: "The user is not an active admin any more, so they cannot apply a team-policy card. Nothing you draft can change that.",
      };
    }
    if (row.status !== "draft") return alreadyHandled(store, id);
    return applyPolicyCard(deps, actor, row);
  }
  if (!store.isActiveUser(actor.id)) return SUSPENDED;
  if (row.status !== "draft") return alreadyHandled(store, id);
  // The card's own source is committed as a raw file: its provenance must be complete.
  if (hasOwnSource(row) && teamProvenanceIssues(row.intake).length > 0) return provenanceIncomplete(row);
  if (!row.changeset || row.changeset.changes.length === 0) {
    return {
      ok: false,
      status: 409,
      message: "반영할 변경 내용이 없습니다. 아바타에게 다시 정리해 달라고 요청하세요.",
      agent: "This card carries no page changes to commit. Draft it again with the pages it creates or updates.",
    };
  }
  // The migration pass stays with the admins: the tool refuses such a draft from anyone else, and the press
  // looks again — whoever drafted it as an admin may not be one any more.
  if (!store.isActiveAdmin(actor.id) && (await newLegacyCitations(config, row.changeset.changes)).length > 0) {
    return {
      ok: false,
      status: 403,
      message: "예전 노트(raw/legacy)를 위키로 옮기는 변경은 관리자만 반영할 수 있습니다.",
      agent:
        "This card newly cites pre-schema notes under raw/legacy/ — the migration pass, which only an admin applies — and the user is not an active admin (any more). Nothing was changed. Tell the user to ask an admin; the other pages can be drafted again without those citations.",
    };
  }
  if (!store.transitionTeamBrainProposal(id, ["draft"], "applied", { decidedBy: actor.id, decided: true })) {
    return alreadyHandled(store, id);
  }
  // The presser is the drafter: who put the source in and who committed it are the same teammate.
  const presser = { name: actor.displayName || actor.username, username: actor.username };
  try {
    await applyTeamChangeset(config, {
      raw: row.intake
        ? { path: row.path, content: renderTeamRaw({ proposal: row, approver: presser, approvedAt: new Date().toISOString(), submitter: presser }) }
        : null,
      changes: row.changeset.changes,
      title: row.title,
      proposalId: row.id,
      logOp: row.intake ? "direct" : "maintain",
      logApprovedBy: actor.username,
      author: commitIdentityFor(store, actor),
    });
  } catch (error) {
    // A failed write applied nothing: the card is a draft again, with no decision stamps.
    store.transitionTeamBrainProposal(id, ["applied"], "draft", { clearDecision: true });
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
  deps.audit?.("team_brain_direct", `${row.id} ${row.path} (${row.changeset.changes.length} pages)`);
  return viewOrGone(deps, actor.id, id);
}

/**
 * A press of a card's confirm button as the ROUTE runs it: the action above,
 * plus the report the presser's chat hands to the avatar
 * (`teamBrainCardPress.ts`) — done, or refused and why. Recorded only for a
 * LIVE card that is the presser's own (anything else is a 404 that names
 * nothing, or a card of the retired queue, which has no button to report).
 * Every reported card button goes through here.
 */
export async function pressTeamBrainCard(
  deps: TeamBrainActionDeps,
  actor: TeamBrainActor,
  id: string,
  action: TeamBrainCardPressAction,
): Promise<TeamBrainActionResult> {
  const card = deps.store.getTeamBrainProposal(id);
  const mine = card && card.proposerUserId === actor.id && isLiveCard(card) ? card : null;
  const record = (outcome: { ok: true } | { ok: false; agent?: string }) => {
    if (!mine) return;
    deps.store.noteTeamBrainCardPress({
      proposalId: id,
      userId: actor.id,
      action,
      ok: outcome.ok,
      ...composeTeamBrainCardPress({ card: mine, outcome }),
    });
  };
  let result: TeamBrainActionResult;
  try {
    result = await applyTeamBrainCard(deps, actor, id);
  } catch (error) {
    // An unexpected failure is a refused press too: whatever the client is answered, the report says so.
    record({ ok: false, agent: NOT_SAVED_AGENT });
    throw error;
  }
  if (result.ok) record({ ok: true });
  else if (result.status !== 404) record({ ok: false, agent: result.agent });
  return result;
}
