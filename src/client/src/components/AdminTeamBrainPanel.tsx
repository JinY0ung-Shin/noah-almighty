// 관리자 → 팀 브레인: the vault's size, the push-only backup mirror and the
// read-only team policy (it changes through an admin's avatar + a card, never
// here). Saving the backup address binds pushes to THIS admin's git token.
import { useLayoutEffect, useRef, useState } from "react";
import "./AdminTeamBrainPanel.css";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx } from "../lib/hooks";
import { goView } from "../lib/nav";
import {
  TEAM_PAGE_TYPES,
  TEAM_PAGE_TYPE_LABELS,
  TEAM_POLICY_DEFAULTS,
  teamGuidelinesAreEmpty,
  type TeamBrainBackupState,
  type TeamPolicyView,
} from "../../../shared/teamBrain";

export interface AdminTeamBrainPanelProps {
  active?: boolean;
}

interface PanelState {
  /** Compiled wiki pages (structural files excluded). */
  noteCount: number;
  /** raw/ sources in the vault (raw/legacy included); absent from an older server. */
  rawSources?: number;
  /** raw/ sources no valid page cites yet — the curator's backlog. */
  uncompiledSources?: number;
  backup: TeamBrainBackupState;
  githubHost: string;
}

function isDirty(state: PanelState | null, url: string, branch: string): boolean {
  return !!state && (url.trim() !== (state.backup.url ?? "") || (branch.trim() || "main") !== state.backup.branch);
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("ko-KR") : "";
}

/**
 * State that a continuation running LATER (after an `await`) reads as it is
 * now: the ref is written together with the state, not at the next render.
 */
function useLive<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  });
  return [value, set.current, ref];
}

export default function AdminTeamBrainPanel({ active = false }: AdminTeamBrainPanelProps) {
  const initialized = useRef(false);
  const [busy, setBusy, busyRef] = useLive(false);
  const [state, setState, stateRef] = useLive<PanelState | null>(null);
  const [url, setUrl, urlRef] = useLive("");
  const [branch, setBranch, branchRef] = useLive("main");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 팀 정책 (POLICY.md), read-only here: it changes only through the admin's avatar + a card.
  const [policy, setPolicy] = useState<TeamPolicyView | null>(null);
  const [policyLoading, setPolicyLoading, policyLoadingRef] = useLive(false);
  const [policyError, setPolicyError] = useState("");

  /** A guidelines body that is only an HTML comment and/or headings (the template stub) counts as none. */
  const guidelinesEmpty = policy ? teamGuidelinesAreEmpty(policy.guidelines) : true;
  const uncompiled = state?.uncompiledSources ?? 0;
  // Restore needs an EMPTY vault: raw sources count too (after the schema migration every old note is one).
  const vaultEmpty = !!state && state.noteCount === 0 && (state.rawSources ?? 0) === 0;
  const dirty = isDirty(state, url, branch);

  function seed(next: PanelState) {
    setState(next);
    setUrl(next.backup.url ?? "");
    setBranch(next.backup.branch || "main");
  }

  async function loadPolicy() {
    if (policyLoadingRef.current) return;
    setPolicyLoading(true);
    setPolicyError("");
    try {
      const r = await api<{ policy?: TeamPolicyView }>("/api/admin/team-brain/policy");
      if (!r?.policy) throw new Error("팀 정책을 불러오지 못했습니다.");
      setPolicy(r.policy);
    } catch (err) {
      setPolicyError((err as Error).message);
    } finally {
      setPolicyLoading(false);
    }
  }

  async function load() {
    initialized.current = true;
    void loadPolicy();
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      seed(await api<PanelState>("/api/admin/team-brain"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function run(fn: () => Promise<string>) {
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      // Refresh the status line (last push / last error) either way.
      try {
        const next = await api<PanelState>("/api/admin/team-brain");
        if (stateRef.current && !isDirty(stateRef.current, urlRef.current, branchRef.current)) seed(next);
        else if (stateRef.current) setState({ ...next });
      } catch {
        /* keep what we have */
      }
    }
  }

  const save = () =>
    run(async () => {
      const trimmed = urlRef.current.trim();
      await api("/api/admin/team-brain/backup", {
        method: "PUT",
        body: JSON.stringify({ url: trimmed || null, branch: branchRef.current.trim() || "main" }),
      });
      const current = stateRef.current;
      if (current) setState({ ...current, backup: { ...current.backup, url: trimmed || null } });
      return trimmed ? "백업 저장소를 저장했습니다. 이제 내 git 토큰으로 백업합니다." : "백업 설정을 해제했습니다.";
    });

  const pushNow = () =>
    run(async () => {
      await api("/api/admin/team-brain/backup/push", { method: "POST" });
      return "백업을 완료했습니다.";
    });

  async function restore() {
    if (!(await confirmAction("백업 저장소의 내용으로 팀 브레인을 복원할까요? 비어 있는 팀 브레인에만 복원할 수 있습니다."))) return;
    await run(async () => {
      const r = await api<{ noteCount: number }>("/api/admin/team-brain/backup/restore", { method: "POST" });
      // The restore reply carries no raw counts, and an older mirror is migrated on restore (its notes
      // become raw sources), so read the panel state again for the real numbers.
      const next = await api<PanelState>("/api/admin/team-brain").catch(() => null);
      if (!next || next.rawSources === undefined) return `복원했습니다. 위키 페이지 ${r.noteCount}개`;
      const backlog = next.uncompiledSources ? ` (미편찬 ${next.uncompiledSources}건)` : "";
      return `복원했습니다. 위키 페이지 ${next.noteCount}개 · 원본 ${next.rawSources}건${backlog}`;
    });
  }

  function openTeamBrain() {
    goView("teamBrain");
  }

  if (!active) return null;

  return (
    <section
      className="settings-card team-brain-admin cmp-admin-team-brain-panel"
      aria-labelledby="team-brain-admin-heading"
      aria-busy={busy}
    >
      <div className="panel-section-head">
        <div>
          <h3 id="team-brain-admin-heading">팀 브레인</h3>
          <p className="muted">
            팀원 모두가 함께 읽고 쓰는 공용 지식입니다. 팀원 누구나 자기 아바타가 띄운 카드에서 ‘팀 브레인에 반영’을 눌러 직접 반영합니다. 팀 정책과
            백업은 관리자가 관리합니다.
          </p>
        </div>
        <button className="ghost-sm" type="button" disabled={busy} onClick={() => void load()}>
          새로 고침
        </button>
      </div>
      {state ? (
        <>
          <div className="team-brain-admin-stats">
            <button className="stat-card stat-clickable" type="button" onClick={openTeamBrain}>
              <div className="stat-value">{state.noteCount}</div>
              <div className="stat-label">위키 페이지</div>
              <div className="stat-link muted">팀 브레인에서 보기</div>
            </button>
            {state.rawSources !== undefined && (
              <div className="stat-card">
                <div className="stat-value">{state.rawSources}</div>
                <div className="stat-label">원본</div>
                <div className={cx("stat-link muted", uncompiled > 0 && "team-brain-admin-backlog")}>미편찬 {uncompiled}건</div>
              </div>
            )}
          </div>

          {uncompiled > 0 && (
            <p className="team-brain-admin-hint">
              아바타에게 '팀 브레인 정리(team-brain-curate)'를 요청하면 미편찬 원본을 위키로 편찬합니다.
            </p>
          )}

          <h4 className="team-brain-admin-sub">백업</h4>
          <p className="muted">
            팀 브레인은 이 서버에만 저장됩니다. 사내 git({state.githubHost})의 저장소를 지정하면 변경될 때마다 그곳으로 백업합니다.
            백업은 저장한 관리자의 git 토큰으로 올립니다. 백업 브랜치에 팀 브레인이 모르는 내용이 있으면 덮어쓰지 않고 백업을 멈춥니다.
          </p>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>백업 저장소</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
                placeholder={`owner/repo 또는 https://${state.githubHost}/owner/repo.git`}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>브랜치</span>
              <input
                value={branch}
                onChange={(event) => setBranch(event.currentTarget.value)}
                placeholder="main"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <div className="settings-save-row">
              <span className={cx("settings-save-status", dirty && "dirty", busy && "pending")} role="status" aria-live="polite">
                {busy
                  ? "처리 중…"
                  : message
                    ? message
                    : dirty
                      ? "저장하지 않은 변경이 있습니다."
                      : !state.backup.url
                        ? "백업이 설정되지 않았습니다."
                        : state.backup.lastError
                          ? `백업 실패 · ${state.backup.lastError}`
                          : state.backup.lastOkAt
                            ? `마지막 백업 ${when(state.backup.lastOkAt)} · ${state.backup.adminName}의 토큰`
                            : `아직 백업하지 않았습니다 · ${state.backup.adminName}의 토큰`}
              </span>
              <button className="primary" type="submit" disabled={busy || !dirty}>
                저장
              </button>
            </div>
          </form>
          {state.backup.url && (
            <div className="team-brain-admin-actions">
              <button className="ghost-sm" type="button" disabled={busy || dirty} onClick={() => void pushNow()}>
                지금 백업
              </button>
              <button
                className="ghost-sm"
                type="button"
                disabled={busy || dirty || !vaultEmpty}
                onClick={() => void restore()}
                title={vaultEmpty ? "" : "비어 있는 팀 브레인에만 복원할 수 있습니다."}
              >
                백업에서 복원
              </button>
            </div>
          )}
        </>
      ) : busy ? (
        <p className="muted" role="status">
          불러오는 중…
        </p>
      ) : null}
      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}

      <h4 className="team-brain-admin-sub">팀 정책</h4>
      <p className="muted">팀 정책은 관리자 본인의 아바타에게 요청하면 카드로 바뀝니다 (카드의 팀 정책 반영을 눌러야 저장됩니다).</p>
      {policy ? (
        <>
          {!policy.exists && <p className="muted team-brain-policy-note">아직 팀 정책 파일(POLICY.md)이 없어 기본값을 씁니다.</p>}
          {policy.problems.length ? (
            <div className="warn-box team-brain-policy-problems" role="note">
              <span>정책 파일에 문제가 있어 해당 항목은 기본값을 씁니다.</span>
              <ul>
                {policy.problems.map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <table className="team-brain-policy-table" aria-label="팀 정책 설정">
            <tbody>
              {TEAM_PAGE_TYPES.map((type) => (
                <tr key={type}>
                  <th scope="row">{TEAM_PAGE_TYPE_LABELS[type]} · 다시 확인 주기</th>
                  <td>
                    {policy.knobs.reviewMonths[type]}개월{" "}
                    {policy.knobs.reviewMonths[type] !== TEAM_POLICY_DEFAULTS.reviewMonths[type] && (
                      <span className="tag accent">기본 {TEAM_POLICY_DEFAULTS.reviewMonths[type]}개월</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">초안 만료</th>
                <td>
                  {policy.knobs.draftTtlDays}일{" "}
                  {policy.knobs.draftTtlDays !== TEAM_POLICY_DEFAULTS.draftTtlDays && (
                    <span className="tag accent">기본 {TEAM_POLICY_DEFAULTS.draftTtlDays}일</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">1인당 열린 카드</th>
                <td>
                  {policy.knobs.maxOpenProposals}개{" "}
                  {policy.knobs.maxOpenProposals !== TEAM_POLICY_DEFAULTS.maxOpenProposals && (
                    <span className="tag accent">기본 {TEAM_POLICY_DEFAULTS.maxOpenProposals}개</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <span className="team-brain-admin-label">가이드라인</span>
          {guidelinesEmpty ? (
            <p className="muted">작성된 가이드라인이 없습니다.</p>
          ) : (
            // Admin/avatar-written text: shown as TEXT, never rendered as markdown/HTML.
            <pre className="team-brain-policy-guidelines">{policy.guidelines}</pre>
          )}

          <span className="team-brain-admin-label">변경 이력</span>
          {policy.history.length ? (
            <ul className="team-brain-policy-history" aria-label="팀 정책 변경 이력">
              {policy.history.map((entry, i) => (
                <li key={i}>
                  <span className="muted">
                    {when(entry.at)} · {entry.by}
                  </span>{" "}
                  · {entry.title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">변경 이력이 없습니다.</p>
          )}
        </>
      ) : policyLoading ? (
        <p className="muted" role="status">
          팀 정책을 불러오는 중…
        </p>
      ) : null}
      {policyError && (
        <div className="team-brain-admin-actions">
          <p className="warn-box" role="alert">
            {policyError}
          </p>
          <button className="ghost-sm" type="button" disabled={policyLoading} onClick={() => void loadPolicy()}>
            다시 불러오기
          </button>
        </div>
      )}
    </section>
  );
}
