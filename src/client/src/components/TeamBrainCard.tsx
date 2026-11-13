// A team-brain confirmation card (a `kind:"team_brain"` attachment). The avatar
// only DRAFTED it; this card is where its drafter decides: the confirm button
// (팀 브레인에 반영 — a teammate's own page changes; 팀 정책 반영 — an admin's POLICY.md
// change) commits, 취소 drops the draft. Its state is read LIVE from the server
// (/api/team-brain/cards/:id) and every button re-checks there. A card of the
// retired review queue (`view.legacy`) is history: its title and one line.
//
// Everything shown here is teammate- or model-written text: it is rendered as
// TEXT only (`<pre>`, diff lines, list items) — never as markdown or HTML.
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import Icon from "./Icon";
import type {
  TeamBrainCardView,
  TeamBrainIntake,
  TeamBrainLiveKind,
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
  isTeamBrainLegacyKind,
  isTeamIntakeUnknown,
  teamBrainCardButtonLabel,
  teamBrainCardPressBubble,
  teamProvenanceProblem,
  teamProvenanceProblemLabel,
  teamSourceKindOf,
} from "../../../shared/teamBrain";
import { collapseUnchanged, diffLines, type DiffHunkItem } from "../../../shared/lineDiff";
import { reportTeamBrainCardPress } from "../lib/chat";
import { cx, useDocumentEvent, useLatest } from "../lib/hooks";

// Draft cards on screen. One card's commit may change a page another draft
// changes too (that draft is then stale and its apply refused), so the others
// re-read when a card is applied.
const draftCardRereads = new Set<() => void>();

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
  direct: "팀 브레인 변경",
  policy: "팀 정책 변경",
} as const satisfies Record<TeamBrainLiveKind, string>;

type Tone = "info" | "ok" | "warn" | "muted";

function statusText(v: TeamBrainCardView, kind: TeamBrainLiveKind): { text: string; tone: Tone } {
  const policy = kind === "policy";
  switch (v.proposal.status) {
    case "draft":
      if (v.stale) {
        return policy
          ? { text: "그 사이 팀 정책이 바뀌었습니다. 아바타에게 현재 정책에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" }
          : { text: "그 사이 팀 브레인이 바뀌었습니다. 아바타에게 현재 내용에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" };
      }
      // Not stale and still no confirm button: the server judged the VIEWER (policy: no longer an admin).
      if (!v.actions.apply) {
        return policy
          ? { text: "관리자만 반영할 수 있습니다.", tone: "warn" }
          : { text: "지금은 이 계정으로 팀 브레인에 반영할 수 없습니다.", tone: "warn" };
      }
      return policy
        ? { text: "버튼을 눌러야 팀 정책이 저장됩니다.", tone: "info" }
        : { text: "버튼을 눌러야 팀 브레인에 저장됩니다.", tone: "info" };
    case "applied":
      return policy ? { text: "팀 정책을 저장했습니다.", tone: "ok" } : { text: "팀 브레인에 저장했습니다.", tone: "ok" };
    case "expired":
      return { text: "누르지 않아 만료되었습니다.", tone: "muted" };
    default:
      return { text: "취소했습니다.", tone: "muted" };
  }
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

  // A card applied elsewhere on screen: a draft re-reads (it may be stale now).
  const rereadDraft = useLatest(() => {
    if (view?.proposal.status === "draft" && !busyRef.current) void load();
  });
  const rereadListener = useRef(() => rereadDraft.current());
  useEffect(() => {
    const listener = rereadListener.current;
    draftCardRereads.add(listener);
    return () => {
      draftCardRereads.delete(listener);
    };
  }, []);

  /**
   * The confirm button (`apply`) or 취소 (`cancel`). A press of the confirm
   * button is told to the avatar — done or refused — so it can go on by itself
   * (lib/chat.ts reportTeamBrainCardPress); 취소 is not.
   */
  async function act(action: "apply" | "cancel"): Promise<void> {
    if (busyRef.current || !view || isTeamBrainLegacyKind(view.proposal.kind)) return;
    // The card as it was when pressed: its kind and title name the button.
    const pressed = { kind: view.proposal.kind, title: view.proposal.title };
    // The pane is read NOW, at the press: a card drafted in the turn still being
    // written sits in the live bubble, which is torn down (and this instance with
    // it — the ref goes null) when that turn ends, possibly before the server answers.
    const paneId = rootRef.current?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
    const tellAvatar = (ok: boolean): void => {
      if (action === "apply" && paneId) void reportTeamBrainCardPress(paneId, proposalId, teamBrainCardPressBubble(pressed, ok));
    };
    setBusy(true);
    setActionError("");
    try {
      setView(await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}/${action}`, { method: "POST" }));
      if (action === "apply") {
        for (const reread of [...draftCardRereads]) {
          if (reread !== rereadListener.current) reread();
        }
      }
      tellAvatar(true);
    } catch (err) {
      setActionError((err as Error).message);
      // A press the SERVER refused is told too (the avatar may be the one to fix
      // it): 403 / 409 / 500 are the action's own refusals, each recorded with
      // its reason. Anything else — a 404 (no such card for this user), a lost
      // connection — left nothing on the server to tell.
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 409 || status === 500) tellAvatar(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // 출처 정보 (provenance) editor: the drafter fills or corrects 출처 유형·출처·작성자·작성일
  // on their own draft before 반영. It opens by itself while something is
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

  // A draft goes stale (a teammate changed the page) or expires while the tab is away: re-read on return.
  function onVisible(): void {
    if (document.visibilityState === "visible" && view?.proposal.status === "draft") void load();
  }

  useEffect(() => {
    void load();
    // Once, on mount (the listener below always calls the latest `onVisible`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useDocumentEvent("visibilitychange", onVisible);

  const proposal = view?.proposal ?? null;
  // Null on a card of the retired review queue (kinds `propose` / `review`).
  const kind = view && proposal && !view.legacy && !isTeamBrainLegacyKind(proposal.kind) ? proposal.kind : null;
  const status = view && kind ? statusText(view, kind) : null;
  // A policy card is ONE file write (POLICY.md): its diff is the whole card, so it is shown unfolded.
  const isPolicy = kind === "policy";
  // Personal second-brain notes the changes came from.
  const personalNotes = proposal && kind === "direct" ? (proposal.personalNotes ?? []) : [];
  // A direct card's own source (a changeset that only edits existing pages has none).
  const source = proposal && kind === "direct" && (proposal.intake || proposal.content) ? { content: proposal.content, intake: proposal.intake } : null;
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
    return rows.length || gaps ? (
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
    ) : null;
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

  if (!kind) {
    // History of the retired review queue: the title and the server's one line. No buttons.
    return (
      <section className="team-brain-card" aria-label="지난 팀 브레인 카드">
        <header className="team-brain-head">
          <span className="team-brain-icon" aria-hidden="true">
            <Icon name="book" size={16} />
          </span>
          <div className="team-brain-title">
            <strong className="team-brain-name">{proposal.title}</strong>
          </div>
        </header>
        {view.legacy ? (
          <p className={`team-brain-status tone-${view.legacy.closedByUpgrade ? "info" : "muted"}`} role="status">
            {view.legacy.notice}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="team-brain-card" aria-label={KIND_LABEL[kind]} ref={rootRef}>
      <header className="team-brain-head">
        <span className="team-brain-icon" aria-hidden="true">
          <Icon name="book" size={16} />
        </span>
        <div className="team-brain-title">
          <span className="team-brain-kind">{KIND_LABEL[kind]}</span>
          <strong className="team-brain-name">{proposal.title}</strong>
          {kind === "direct" ? <span className="team-brain-count">{changesetLine(pages, Boolean(source))}</span> : null}
        </div>
      </header>

      {proposal.summary ? <p className="team-brain-summary">{proposal.summary}</p> : null}

      {source ? (
        <>
          {/* The card's own source: its provenance stays OUT of the fold, editable while a draft. */}
          {source.intake?.type ? provenanceBlock(source.intake, Boolean(view.provenance?.editable)) : null}
          <details className="team-brain-details">
            <summary>원본 보기</summary>
            <pre className="team-brain-pre">{source.content}</pre>
            {source.intake ? intakeBlock(source.intake) : null}
          </details>
        </>
      ) : null}

      {personalNotes.length ? (
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
            반영되면 팀 위키가 정본이 됩니다 — 내 노트는 바뀌지 않으며, 링크로 바꿀지는 아바타가 물어봅니다.
          </p>
        </div>
      ) : null}

      {conflicts.length ? (
        <div className="team-brain-box team-brain-conflicts" role="note">
          <span className="team-brain-section-label">확인이 필요한 충돌</span>
          <ul>
            {conflicts.map((conflict, i) => (
              <li key={i}>{conflict}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {pages.length ? (
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
      {provenanceBlocked && view.actions.apply ? (
        <p className="team-brain-status tone-warn">출처 정보(출처 유형·출처·작성자·작성일)를 채워야 반영할 수 있습니다.</p>
      ) : null}
      {actionError ? (
        <p className="team-brain-status tone-warn" role="alert">
          {actionError}
        </p>
      ) : null}
      {view.actions.apply || view.actions.cancel ? (
        <div className="team-brain-actions">
          {view.actions.apply ? (
            <button className="primary" type="button" disabled={busy || provenanceBlocked} onClick={() => void act("apply")}>
              {teamBrainCardButtonLabel({ kind })}
            </button>
          ) : null}
          {view.actions.cancel ? (
            <button className="ghost-sm" type="button" disabled={busy} onClick={() => void act("cancel")}>
              취소
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
