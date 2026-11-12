// A team-brain confirmation card (a `kind:"team_brain"` attachment). The avatar
// only DRAFTED it; this card is where a human decides. Its state is read LIVE
// from the server (/api/team-brain/cards/:id) and every button re-checks there.
//
// Everything shown here is teammate- or model-written text: it is rendered as
// TEXT only (`<pre>`, diff lines, list items) — never as markdown or HTML.
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import Icon from "./Icon";
import type {
  TeamBrainCardPressAction,
  TeamBrainCardView,
  TeamBrainIntake,
  TeamBrainProposalKind,
  TeamPageChangeView,
  TeamProvenanceInput,
  TeamProvenanceSlot,
} from "../../../shared/teamBrain";
import {
  TEAM_INTAKE_SLOTS,
  TEAM_INTAKE_SLOT_LABELS,
  TEAM_PAGE_TYPE_LABELS,
  TEAM_PROVENANCE_SLOTS,
  TEAM_SOURCE_KINDS,
  TEAM_SOURCE_KIND_LABELS,
  TEAM_SOURCE_KIND_PLACEHOLDERS,
  isTeamIntakeUnknown,
  teamBrainCardButtonLabel,
  teamBrainCardPressBubble,
  teamProvenanceProblem,
  teamProvenanceProblemLabel,
  teamSourceKindOf,
} from "../../../shared/teamBrain";
import { collapseUnchanged, diffLines, type DiffHunkItem } from "../../../shared/lineDiff";
import { reportTeamBrainCardPress } from "../lib/chat";
import { cx, useDocumentEvent } from "../lib/hooks";
import { refreshTeamBrainStatus } from "../lib/teamBrain";

export interface TeamBrainCardProps {
  proposalId: string;
}

function formProblems(f: TeamProvenanceInput): string[] {
  const values: Record<TeamProvenanceSlot, string> = {
    source_kind: f.sourceKind,
    source: f.source,
    author: f.author,
    authored_at: f.authoredAt,
  };
  const kind = teamSourceKindOf(f.sourceKind);
  return TEAM_PROVENANCE_SLOTS.flatMap((slot) => {
    const problem = teamProvenanceProblem(slot, values[slot], kind);
    return problem ? [teamProvenanceProblemLabel(slot, problem)] : [];
  });
}

const KIND_LABEL = {
  propose: "팀 브레인 제안",
  direct: "팀 브레인 변경",
  review: "팀 브레인 검토",
  policy: "팀 정책 변경",
} as const satisfies Record<TeamBrainProposalKind, string>;
const DECISION_LABEL = { approve: "승인", reject: "반려", ask: "보완 요청" } as const;

type Tone = "info" | "ok" | "warn" | "muted";

function statusText(v: TeamBrainCardView): { text: string; tone: Tone } {
  const p = v.proposal;
  if (p.kind === "propose") {
    switch (p.status) {
      case "draft":
        // Sources have no staleness; only a legacy note row the server refuses to submit can be stale.
        if (v.stale && !v.actions.submit) {
          return { text: "그 사이 노트가 바뀌어 제출할 수 없습니다. 아바타에게 다시 제안을 요청하세요.", tone: "warn" };
        }
        return p.intake && p.intake.followups.length
          ? { text: "답변을 반영했습니다. 다시 제출하세요.", tone: "info" }
          : { text: "아직 공유되지 않았습니다. 내용을 확인하고 제출하세요.", tone: "info" };
      case "pending":
        return { text: "관리자의 검토를 기다리고 있습니다.", tone: "info" };
      case "needs_info": {
        const q = (p.decisionReason ?? "").trim();
        const asked = q ? `: ${q}${/[.?!。？！]$/.test(q) ? "" : "."}` : ".";
        return { text: `관리자가 보완을 요청했습니다${asked} 아바타에게 답을 알려 주세요.`, tone: "warn" };
      }
      case "approved":
        return { text: `승인되어 팀 브레인에 반영되었습니다${p.decidedByName ? ` (${p.decidedByName})` : ""}.`, tone: "ok" };
      case "rejected":
        return { text: `반려되었습니다${p.decisionReason ? `: ${p.decisionReason}` : "."}`, tone: "warn" };
      case "withdrawn":
        return { text: "철회했습니다.", tone: "muted" };
      case "expired":
        return { text: "제출하지 않아 만료되었습니다.", tone: "muted" };
      default:
        return { text: "처리된 카드입니다.", tone: "muted" };
    }
  }
  if (p.status === "draft") {
    if (p.kind === "review" && v.target && v.target.status !== "pending") {
      return { text: "이 제안은 이미 처리되었거나 철회되었습니다.", tone: "muted" };
    }
    if (v.stale) {
      return p.kind === "policy"
        ? { text: "그 사이 팀 정책이 바뀌었습니다. 아바타에게 현재 정책에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" }
        : { text: "그 사이 팀 브레인이 바뀌었습니다. 아바타에게 현재 내용에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" };
    }
    if (!v.actions.apply) return { text: "관리자만 반영할 수 있습니다.", tone: "warn" };
    if (p.kind === "policy") return { text: "버튼을 눌러야 팀 정책이 저장됩니다.", tone: "info" };
    if (p.kind === "review" && p.decision === "ask") return { text: "버튼을 눌러야 보완 요청이 제안자에게 전달됩니다.", tone: "info" };
    return { text: p.kind === "review" ? "버튼을 눌러야 결정이 반영됩니다." : "버튼을 눌러야 팀 브레인에 저장됩니다.", tone: "info" };
  }
  if (p.status === "applied") {
    if (p.kind === "review") {
      if (p.decision === "approve") return { text: "승인해서 팀 브레인에 반영했습니다.", tone: "ok" };
      if (p.decision === "ask") return { text: "보완 요청을 보냈습니다.", tone: "ok" };
      return { text: "반려했습니다.", tone: "ok" };
    }
    if (p.kind === "policy") return { text: "팀 정책을 저장했습니다.", tone: "ok" };
    return { text: "팀 브레인에 저장했습니다.", tone: "ok" };
  }
  if (p.status === "expired") return { text: "누르지 않아 만료되었습니다.", tone: "muted" };
  // A review card is also cancelled by the server when another decision on the same proposal lands
  // or the proposal is withdrawn — so the wording does not claim the viewer pressed 취소.
  if (p.kind === "review") return { text: "취소되었습니다. 이 제안에 다른 결정이 반영되었거나 제안이 철회되었을 수 있습니다.", tone: "muted" };
  return { text: "취소했습니다.", tone: "muted" };
}

// The confirm button's label — the same one the press report names to the avatar.
function applyLabel(v: TeamBrainCardView): string {
  return teamBrainCardButtonLabel("apply", v.proposal);
}

function kindLine(v: TeamBrainCardView): string {
  const p = v.proposal;
  if (p.kind === "review") return `${KIND_LABEL.review} · ${DECISION_LABEL[p.decision ?? "reject"]}`;
  // Legacy single-note rows (no intake, no changeset) still read as a note write.
  if (p.kind === "propose" && !p.intake) return `${KIND_LABEL.propose} · ${p.op === "create" ? "새 노트" : "노트 수정"}`;
  return KIND_LABEL[p.kind];
}

/** "원본 1건 · 페이지 N개 (새 페이지 a · 수정 b)" — for changeset cards. */
function changesetLine(pages: TeamPageChangeView[], hasSource: boolean): string {
  const creates = pages.filter((p) => p.op === "create").length;
  const updates = pages.length - creates;
  const parts = [creates ? `새 페이지 ${creates}` : "", updates ? `수정 ${updates}` : ""].filter(Boolean).join(" · ");
  return `${hasSource ? "원본 1건 · " : ""}페이지 ${pages.length}개${parts ? ` (${parts})` : ""}`;
}

interface IntakeRow {
  label: string;
  answer: string;
  unknown: boolean;
}

/** The non-provenance answers (provenance has its own block). */
function intakeRows(intake: TeamBrainIntake): IntakeRow[] {
  const rows: IntakeRow[] = [];
  for (const slot of TEAM_INTAKE_SLOTS) {
    if ((TEAM_PROVENANCE_SLOTS as readonly string[]).includes(slot)) continue;
    const answer = intake.answers[slot];
    if (typeof answer !== "string" || !answer.trim()) continue;
    rows.push({ label: TEAM_INTAKE_SLOT_LABELS[slot], answer, unknown: isTeamIntakeUnknown(answer) });
  }
  return rows;
}

function gapLabels(intake: TeamBrainIntake): string {
  return intake.gaps
    .filter((slot) => !(TEAM_PROVENANCE_SLOTS as readonly string[]).includes(slot))
    .map((slot) => TEAM_INTAKE_SLOT_LABELS[slot] ?? slot)
    .join(", ");
}

interface ProvenanceRow {
  slot: TeamProvenanceSlot;
  label: string;
  answer: string;
  state: "ok" | "unknown" | "missing";
}

/** 출처 유형·출처·작성자·작성일, always all four (a missing one says so). */
function provenanceRows(intake: TeamBrainIntake): ProvenanceRow[] {
  return TEAM_PROVENANCE_SLOTS.map((slot) => {
    const raw = (intake.answers[slot] ?? "").trim();
    const kind = slot === "source_kind" ? teamSourceKindOf(raw) : null;
    return {
      slot,
      label: TEAM_INTAKE_SLOT_LABELS[slot],
      answer: kind ? TEAM_SOURCE_KIND_LABELS[kind] : raw,
      state: !raw ? "missing" : isTeamIntakeUnknown(raw) ? "unknown" : "ok",
    };
  });
}

interface PageDiff {
  items: DiffHunkItem[];
  added: number;
  removed: number;
  fallback: boolean;
}

function pageDiff(page: TeamPageChangeView): PageDiff | null {
  if (page.op !== "update" || page.before === null) return null;
  const d = diffLines(page.before, page.after);
  return { items: collapseUnchanged(d.lines, 3), added: d.added, removed: d.removed, fallback: d.fallback };
}

export default function TeamBrainCard({ proposalId }: TeamBrainCardProps) {
  const [view, setView] = useState<TeamBrainCardView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusyState] = useState(false);
  const [gone, setGone] = useState(false);
  // `busy`/`saving` are shown AND guard re-entry, so each has a ref the guard reads.
  const busyRef = useRef(false);
  const savingRef = useRef(false);
  // The card's root, to find the chat pane it sits in.
  const rootRef = useRef<HTMLElement | null>(null);

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }

  async function load(): Promise<void> {
    try {
      setView(await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}`));
      setLoadError("");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) setGone(true);
      else setLoadError((err as Error).message);
    }
  }

  /**
   * Tell the avatar what a press of 관리자에게 제출 / the confirm button did —
   * done or refused — so it can go on by itself (lib/chat.ts
   * reportTeamBrainCardPress). 취소 / 제안 철회 is not told. `pressed` is the card as
   * it was when pressed: its kind, decision and title name the button.
   */
  function tellAvatar(paneId: string | undefined, action: TeamBrainCardPressAction, pressed: TeamBrainCardView, ok: boolean): void {
    if (!paneId) return;
    void reportTeamBrainCardPress(paneId, proposalId, teamBrainCardPressBubble(action, pressed.proposal, ok));
  }

  async function act(action: "submit" | "withdraw" | "apply"): Promise<void> {
    if (busyRef.current || !view) return;
    const pressed = view;
    // The pane is read NOW, at the press: a card drafted in the turn still being
    // written sits in the live bubble, which is torn down (and this instance with
    // it — the ref goes null) when that turn ends, possibly before the server answers.
    const paneId = rootRef.current?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
    setBusy(true);
    setActionError("");
    try {
      setView(await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}/${action}`, { method: "POST" }));
      void refreshTeamBrainStatus();
      if (action !== "withdraw") tellAvatar(paneId, action, pressed, true);
    } catch (err) {
      setActionError((err as Error).message);
      // A press the SERVER refused is told too (the avatar may be the one to fix
      // it): 403 / 409 / 500 are the action's own refusals, each recorded with
      // its reason. Anything else — a 404 (no such card for this user), a lost
      // connection — left nothing on the server to tell.
      const status = (err as { status?: number }).status;
      if (action !== "withdraw" && (status === 403 || status === 409 || status === 500)) tellAvatar(paneId, action, pressed, false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // 출처 정보 (provenance) editor: the drafter fills or corrects 출처 유형·출처·작성자·작성일
  // on their own draft before 제출 / 반영. It opens by itself while something is
  // missing — the gated button's prerequisite is the first step — and the
  // server re-validates every save.
  const [editing, setEditing] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const [saving, setSavingState] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState<TeamProvenanceInput>({ sourceKind: "", source: "", author: "", authoredAt: "" });

  function setSaving(next: boolean): void {
    savingRef.current = next;
    setSavingState(next);
  }

  function openEditor(intake: TeamBrainIntake | null): void {
    const a = intake?.answers ?? {};
    setForm({
      sourceKind: teamSourceKindOf(a.source_kind ?? "") ?? "",
      source: a.source ?? "",
      author: a.author ?? "",
      authoredAt: a.authored_at ?? "",
    });
    setFormError("");
    setEditing(true);
  }

  async function saveProvenance(): Promise<void> {
    if (savingRef.current) return;
    const problems = formProblems(form);
    if (problems.length) {
      setFormError(problems.join(" "));
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      setView(
        await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}/provenance`, {
          method: "PUT",
          body: JSON.stringify(form),
        }),
      );
      setEditing(false);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // What followed every new `view` (each one read from the server is a new
  // object): the editor opens by itself once while provenance is missing, and
  // closes when the card stops being editable. Run after the handler that set
  // the view, so a save's own `editing = false` comes first, as before.
  const [checkedView, setCheckedView] = useState<TeamBrainCardView | null>(null);
  if (checkedView !== view) {
    setCheckedView(view);
    if (view?.provenance?.editable && view.provenance.issues.length > 0 && !autoOpened) {
      setAutoOpened(true);
      openEditor(view.proposal.intake);
    }
    if (view && !view.provenance?.editable) setEditing(false);
  }
  const provenanceBlocked = Boolean(view?.provenance && view.provenance.issues.length > 0);
  const formKind = teamSourceKindOf(form.sourceKind);

  // An open proposal is decided (or answered) elsewhere — an admin's conversation,
  // the proposer's avatar: re-read on return.
  function onVisible(): void {
    const s = view?.proposal.status;
    if (document.visibilityState === "visible" && (s === "pending" || s === "draft" || s === "needs_info")) {
      void load();
    }
  }

  useEffect(() => {
    void load();
    // Once, on mount (the listener below always calls the latest `onVisible`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useDocumentEvent("visibilitychange", onVisible);

  const status = view ? statusText(view) : null;
  const proposal = view?.proposal ?? null;
  const isReview = proposal?.kind === "review";
  const isChangesetCard = Boolean(proposal && (proposal.kind === "direct" || (proposal.kind === "review" && proposal.decision === "approve")));
  // A policy card is ONE file write (POLICY.md): its diff is the whole card, so it is shown unfolded.
  const isPolicy = proposal?.kind === "policy";
  const showPages = isChangesetCard || isPolicy;
  // Personal second-brain notes the submission came from (an older server sends none).
  const personalNotes = proposal && (proposal.kind === "propose" || proposal.kind === "direct") ? (proposal.personalNotes ?? []) : [];
  // The source being compiled: a review's target, or a direct card's own source (a maintenance changeset has none).
  const source =
    !view || !proposal
      ? null
      : proposal.kind === "review"
        ? view.target && proposal.decision !== "reject"
          ? { content: view.target.content, intake: view.target.intake }
          : null
        : proposal.kind === "direct" && (proposal.intake || proposal.content)
          ? { content: proposal.content, intake: proposal.intake }
          : null;
  const pages = view?.pages ?? [];
  const diffs = pages.map(pageDiff);
  const conflicts = proposal?.changeset?.conflicts ?? [];

  function provenanceList(intake: TeamBrainIntake) {
    return (
      <dl className="team-brain-intake-list">
        {provenanceRows(intake).map((row) => (
          <div key={row.slot} className="team-brain-intake-row">
            <dt>{row.label}</dt>
            <dd>
              {row.state === "missing" ? (
                <span className="tag danger team-brain-missing">미기재</span>
              ) : row.state === "unknown" ? (
                <span className="tag team-brain-unknown">모름</span>
              ) : (
                row.answer
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  function provenanceBlock(intake: TeamBrainIntake, editable: boolean) {
    return (
      <div className="team-brain-provenance">
        <div className="team-brain-provenance-head">
          <span className="team-brain-section-label">출처 정보</span>
          {editable && !editing ? (
            <button className="ghost-sm" type="button" onClick={() => openEditor(intake)}>
              수정
            </button>
          ) : null}
        </div>
        {editable && editing ? (
          <form
            className="team-brain-provenance-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvenance();
            }}
            aria-label="출처 정보 입력"
          >
            <label className="field">
              <span>출처 유형</span>
              <select
                value={form.sourceKind}
                onChange={(event) => {
                  const sourceKind = event.currentTarget.value;
                  setForm((f) => ({ ...f, sourceKind }));
                }}
                disabled={saving}
                required
              >
                <option value="" disabled>
                  선택하세요
                </option>
                {TEAM_SOURCE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {TEAM_SOURCE_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>출처</span>
              <input
                type={formKind === "link" ? "url" : "text"}
                value={form.source}
                onChange={(event) => {
                  const source = event.currentTarget.value;
                  setForm((f) => ({ ...f, source }));
                }}
                disabled={saving}
                placeholder={formKind ? TEAM_SOURCE_KIND_PLACEHOLDERS[formKind] : "출처 유형을 먼저 고르세요"}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>작성자</span>
              <input
                value={form.author}
                onChange={(event) => {
                  const author = event.currentTarget.value;
                  setForm((f) => ({ ...f, author }));
                }}
                disabled={saving}
                placeholder="원본을 쓰거나 말한 사람 (직접 확인했다면 본인)"
                autoComplete="off"
              />
              <small className="field-hint">모르면 '모름'이라고 적으세요.</small>
            </label>
            <label className="field">
              <span>작성일</span>
              <input
                value={form.authoredAt}
                onChange={(event) => {
                  const authoredAt = event.currentTarget.value;
                  setForm((f) => ({ ...f, authoredAt }));
                }}
                disabled={saving}
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                autoComplete="off"
              />
              <small className="field-hint">연·월만 알면 YYYY-MM, 연도만 알면 YYYY, 모르면 '모름'.</small>
            </label>
            {formError ? (
              <p className="team-brain-status tone-warn" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="team-brain-actions">
              <button className="primary" type="submit" disabled={saving}>
                {saving ? "저장 중…" : "출처 정보 저장"}
              </button>
              {!provenanceBlocked ? (
                <button className="ghost-sm" type="button" disabled={saving} onClick={() => setEditing(false)}>
                  취소
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          provenanceList(intake)
        )}
      </div>
    );
  }

  function intakeBlock(intake: TeamBrainIntake) {
    const rows = intakeRows(intake);
    const gaps = gapLabels(intake);
    return (
      <>
        {rows.length || gaps ? (
          <div className="team-brain-intake">
            <span className="team-brain-section-label">보충 정보</span>
            {rows.length ? (
              <dl className="team-brain-intake-list">
                {rows.map((row) => (
                  <div key={row.label} className="team-brain-intake-row">
                    <dt>{row.label}</dt>
                    <dd>{row.unknown ? <span className="tag team-brain-unknown">모름</span> : row.answer}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {gaps ? <p className="team-brain-gaps">아직 모르는 정보: {gaps}</p> : null}
          </div>
        ) : null}
        {intake.followups.length ? (
          <ol className="team-brain-followups" aria-label="보완 요청 기록">
            {intake.followups.map((round, i) => (
              <li key={i} className="team-brain-followup">
                <span className="team-brain-section-label">보완 요청 {i + 1}</span>
                <p className="team-brain-qa">
                  <span className="team-brain-qa-label">질문</span>
                  <span className="team-brain-qa-text">{round.questions}</span>
                </p>
                <p className="team-brain-qa">
                  <span className="team-brain-qa-label">답변</span>
                  <span className="team-brain-qa-text">{round.answer}</span>
                </p>
              </li>
            ))}
          </ol>
        ) : null}
      </>
    );
  }

  if (gone) {
    return (
      <div className="team-brain-card is-gone">
        <span className="team-brain-icon" aria-hidden="true">
          <Icon name="book" size={16} />
        </span>
        <span className="team-brain-muted">이 팀 브레인 카드는 더 이상 없습니다.</span>
      </div>
    );
  }

  if (!view || !proposal) {
    return (
      <div className="team-brain-card" aria-busy={!loadError}>
        <span className="team-brain-icon" aria-hidden="true">
          <Icon name="book" size={16} />
        </span>
        {loadError ? (
          <>
            <span className="team-brain-muted">{loadError}</span>
            <button className="ghost-sm" type="button" onClick={() => void load()}>
              다시 불러오기
            </button>
          </>
        ) : (
          <span className="team-brain-muted">팀 브레인 카드를 불러오는 중…</span>
        )}
      </div>
    );
  }

  return (
    <section className="team-brain-card" aria-label={KIND_LABEL[proposal.kind]} ref={rootRef}>
      <header className="team-brain-head">
        <span className="team-brain-icon" aria-hidden="true">
          <Icon name="book" size={16} />
        </span>
        <div className="team-brain-title">
          <span className="team-brain-kind">
            {kindLine(view)}{" "}
            {proposal.kind === "propose" && proposal.intake?.type ? (
              <span className="tag accent team-brain-type">{TEAM_PAGE_TYPE_LABELS[proposal.intake.type]}</span>
            ) : null}
          </span>
          <strong className="team-brain-name">{proposal.title}</strong>
          {isChangesetCard ? (
            <span className="team-brain-count">{changesetLine(pages, Boolean(source))}</span>
          ) : proposal.path && !isPolicy ? (
            <code className="team-brain-path">{proposal.path}</code>
          ) : null}
        </div>
      </header>

      {isReview && view.target ? (
        <p className="team-brain-summary">
          {`${view.target.proposerName || "팀원"}님의 제안${view.target.summary ? ` — ${view.target.summary}` : ""}`}
        </p>
      ) : proposal.summary ? (
        <p className="team-brain-summary">{proposal.summary}</p>
      ) : null}

      {isReview && proposal.decision === "reject" && proposal.decisionReason ? (
        <p className="team-brain-summary">반려 사유: {proposal.decisionReason}</p>
      ) : null}
      {isReview && proposal.decision === "ask" ? (
        <div className="team-brain-box team-brain-ask">
          <span className="team-brain-section-label">보완 요청</span>
          <p className="team-brain-box-text">{proposal.decisionReason ?? ""}</p>
        </div>
      ) : null}

      {proposal.kind === "propose" ? (
        proposal.intake ? (
          <>
            <details className="team-brain-details">
              <summary>원문 보기</summary>
              <pre className="team-brain-pre">{proposal.content}</pre>
            </details>
            {proposal.intake.type ? provenanceBlock(proposal.intake, Boolean(view.provenance?.editable)) : null}
            {intakeBlock(proposal.intake)}
          </>
        ) : (
          <details className="team-brain-details">
            <summary>제안 내용 보기</summary>
            <pre className="team-brain-pre">{proposal.content}</pre>
          </details>
        )
      ) : null}

      {source ? (
        <>
          {/* A direct card's own source: its provenance stays OUT of the fold, editable while a draft. */}
          {proposal.kind === "direct" && source.intake?.type
            ? provenanceBlock(source.intake, Boolean(view.provenance?.editable))
            : null}
          <details className="team-brain-details">
            <summary>원본 보기</summary>
            <pre className="team-brain-pre">{source.content}</pre>
            {source.intake ? (
              <>
                {proposal.kind !== "direct" && source.intake.type ? provenanceList(source.intake) : null}
                {intakeBlock(source.intake)}
              </>
            ) : null}
          </details>
        </>
      ) : null}

      {proposal && personalNotes.length ? (
        <div className="team-brain-linked-notes">
          <p className="team-brain-linked-line">
            연결된 내 브레인 노트:{" "}
            {personalNotes.map((note, i) => (
              <Fragment key={note.path}>
                {i > 0 ? ", " : ""}
                <code className="team-brain-path">{note.path}</code>
              </Fragment>
            ))}
          </p>
          <p className="team-brain-hint">
            {proposal.kind === "direct" ? "반영되면" : "승인되면"} 팀 위키가 정본이 됩니다 — 내 노트는 바뀌지 않으며, 링크로 바꿀지는 아바타가 물어봅니다.
          </p>
        </div>
      ) : null}

      {isChangesetCard && conflicts.length ? (
        <div className="team-brain-box team-brain-conflicts" role="note">
          <span className="team-brain-section-label">확인이 필요한 충돌</span>
          <ul>
            {conflicts.map((conflict, i) => (
              <li key={i}>{conflict}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {showPages && pages.length ? (
        <ul className="team-brain-pages" aria-label={isPolicy ? "바뀌는 정책 파일" : "바뀌는 페이지"}>
          {pages.map((page, i) => {
            const diff = diffs[i];
            return (
              <li key={page.path} className={cx("team-brain-page", page.stale && "is-stale")}>
                <div className="team-brain-page-top">
                  <span className={`tag ${page.op === "create" ? "ok" : "write"}`}>
                    {page.op === "create" ? (isPolicy ? "새 파일" : "새 페이지") : "수정"}
                  </span>
                  {page.type ? <span className="tag">{TEAM_PAGE_TYPE_LABELS[page.type]}</span> : null}
                  {diff && diff.removed > 0 ? <span className="tag danger">삭제 {diff.removed}줄</span> : null}
                  <strong className="team-brain-page-title">{page.title || page.path}</strong>
                </div>
                <code className="team-brain-path">{page.path}</code>
                {page.stale ? (
                  <p className="team-brain-page-stale">
                    {isPolicy
                      ? page.op === "create"
                        ? "그 사이 팀 정책 파일이 생겼습니다."
                        : "그 사이 팀 정책이 바뀌었습니다."
                      : page.op === "create"
                        ? "그 사이 같은 경로에 페이지가 생겼습니다."
                        : "그 사이 이 페이지가 바뀌었습니다."}
                  </p>
                ) : null}
                <details className="team-brain-details" open={isPolicy}>
                  <summary>
                    변경 보기
                    {diff ? (
                      <>
                        {" "}
                        <span className="team-brain-diff-stat">
                          (+{diff.added} −{diff.removed})
                        </span>
                      </>
                    ) : null}
                  </summary>
                  {diff ? (
                    <>
                      {diff.fallback ? (
                        <p className="team-brain-hint">변경이 커서 이전 내용 전체와 새 내용 전체를 보여 줍니다.</p>
                      ) : null}
                      <div className="team-brain-diff" role="group" aria-label={`${page.path} 변경 내용`}>
                        {diff.items.map((item, k) =>
                          item.kind === "skip" ? (
                            <div key={k} className="team-brain-diff-skip">
                              … 변경 없는 {item.count}줄 …
                            </div>
                          ) : item.kind === "del" ? (
                            <del key={k} className="team-brain-diff-line is-del">
                              <span className="team-brain-diff-sign" aria-hidden="true">
                                −
                              </span>
                              {item.text}
                            </del>
                          ) : item.kind === "add" ? (
                            <ins key={k} className="team-brain-diff-line is-add">
                              <span className="team-brain-diff-sign" aria-hidden="true">
                                +
                              </span>
                              {item.text}
                            </ins>
                          ) : (
                            <div key={k} className="team-brain-diff-line">
                              {/* Empty on purpose: the context line's sign cell is blank (it was a
                                  lone space the old template trimmed away). */}
                              <span className="team-brain-diff-sign" aria-hidden="true"></span>
                              {item.text}
                            </div>
                          ),
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* The server sends `before` only while the card is a draft: after apply the page IS `after`. */}
                      {page.op === "update" && proposal.status === "draft" ? (
                        <p className="team-brain-hint">현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.</p>
                      ) : null}
                      <pre className="team-brain-pre">{page.after}</pre>
                    </>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      ) : null}

      {status ? (
        <p className={`team-brain-status tone-${status.tone}`} role="status">
          {status.text}
        </p>
      ) : null}
      {provenanceBlocked && (view.actions.submit || view.actions.apply) ? (
        <p className="team-brain-status tone-warn">
          출처 정보(출처 유형·출처·작성자·작성일)를 채워야 {view.actions.submit ? "제출" : "반영"}할 수 있습니다.
        </p>
      ) : null}
      {actionError ? (
        <p className="team-brain-status tone-warn" role="alert">
          {actionError}
        </p>
      ) : null}
      {view.actions.submit || view.actions.withdraw || view.actions.apply || view.actions.cancel ? (
        <div className="team-brain-actions">
          {view.actions.submit ? (
            <button className="primary" type="button" disabled={busy || provenanceBlocked} onClick={() => void act("submit")}>
              관리자에게 제출
            </button>
          ) : null}
          {view.actions.apply ? (
            <button className="primary" type="button" disabled={busy || provenanceBlocked} onClick={() => void act("apply")}>
              {applyLabel(view)}
            </button>
          ) : null}
          {view.actions.withdraw ? (
            <button className="ghost-sm" type="button" disabled={busy} onClick={() => void act("withdraw")}>
              {proposal.status === "draft" ? "취소" : "제안 철회"}
            </button>
          ) : null}
          {view.actions.cancel ? (
            <button className="ghost-sm" type="button" disabled={busy} onClick={() => void act("withdraw")}>
              취소
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
