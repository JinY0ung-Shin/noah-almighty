import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import AvatarImage from "./AvatarImage";
import AdminPasswordResetModal from "./AdminPasswordResetModal";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx, useAppState, useLatest } from "../lib/hooks";
import { Presence } from "../lib/presence";
import { notify } from "../lib/state";
import { timeLabel } from "../lib/format";
import type { AdminUserDetail, AdminUserSummary, AvatarVisibility } from "../lib/types";

export interface AdminUserRowProps {
  user: AdminUserSummary;
  reload: () => Promise<void>;
}

// Mirrors the owner-facing selector in SettingsProfileTab (팀 공개/비공개).
const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
  { value: "group", label: "팀 공개", desc: "모든 팀원(가입이 승인된 사용자)이 탐색에서 찾아 대화할 수 있습니다." },
  { value: "private", label: "비공개", desc: "본인만 볼 수 있습니다." },
];

const detailItems = (d: AdminUserDetail) => [
  { k: "시작한 대화", v: d.conversationsStarted },
  { k: "받은 대화", v: d.conversationsReceived },
  { k: "플러그인", v: d.pluginCount },
  { k: "예약 작업", v: `${d.routinesActive}/${d.routinesTotal}` },
  { k: "시크릿", v: d.secretCount },
  { k: "활성 세션", v: d.activeSessions },
  { k: "미응답 질문", v: d.openRequests },
  { k: "GIT_TOKEN", v: d.gitTokenSet ? "있음" : "없음" },
  { k: "지식 저장소", v: d.knowledgeRepoSet ? "연결됨" : "없음" },
];

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

export default function AdminUserRow({ user, reload }: AdminUserRowProps) {
  const appState = useAppState();
  const [expanded, setExpanded, expandedRef] = useLive(false);
  const [loading, setLoading, loadingRef] = useLive(false);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [busy, setBusy, busyRef] = useLive(false);
  const [actionStatus, setActionStatus] = useState("");
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  // What an action reads once its confirmation (or its request) has come back.
  const userRef = useLatest(user);
  const reloadRef = useLatest(reload);

  const isMe = user.id === appState.user?.id;
  const isAdmin = user.roles?.includes("admin");
  const visibilityDesc = VISIBILITY_OPTIONS.find((o) => o.value === user.visibility)?.desc || "";
  const userBaseId = user.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const detailId = `admin-user-detail-${userBaseId}`;
  const actionStatusId = `admin-user-action-status-${userBaseId}`;
  const visibilityGroupId = `admin-user-visibility-${userBaseId}`;

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detail) return;
    await loadDetail();
  }

  async function loadDetail() {
    if (loadingRef.current) return;
    setLoading(true);
    setLoadError("");
    try {
      const d = await api<{ user: AdminUserDetail }>(`/api/admin/users/${encodeURIComponent(userRef.current.id)}`);
      setDetail(d.user);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // After a mutation (suspend/role/logout/password-reset) the parent refreshes
  // only the summary row; the expanded detail (sessions/questions/started chats)
  // would keep stale numbers. Re-fetch it when the user prop identity changes.
  // (A layout effect: the stale detail is gone before the row is painted again.)
  const syncedUser = useRef(user);
  useLayoutEffect(() => {
    if (user === syncedUser.current) return;
    syncedUser.current = user;
    setDetail(null);
    if (expandedRef.current && !loadingRef.current) void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function run(fn: () => Promise<void>, errLabel: string, successLabel = "") {
    if (busyRef.current) return;
    setBusy(true);
    setActionStatus("작업을 처리하는 중입니다.");
    try {
      await fn();
    } catch (err) {
      setBusy(false);
      const failed = `${errLabel}: ${(err as Error).message}`;
      setActionStatus(failed);
      notify(failed);
      return;
    }
    try {
      await reloadRef.current();
      setActionStatus(successLabel || "작업이 완료되었습니다.");
      if (successLabel) notify(successLabel, "ok");
    } catch (err) {
      const failed = `작업은 완료됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      setActionStatus(failed);
      notify(failed, "warn");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRole() {
    const verb = isAdmin ? "해제" : "부여";
    if (!(await confirmAction(`${user.displayName}(@${user.username})님의 관리자 권한을 ${verb}할까요?`))) return;
    const current = userRef.current;
    const currentIsAdmin = current.roles?.includes("admin");
    void run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(current.id)}/roles`, {
          method: "POST",
          body: JSON.stringify({ role: "admin", grant: !currentIsAdmin }),
        }).then(() => undefined),
      "권한 변경 실패",
      `${current.displayName}님의 관리자 권한을 ${verb}했습니다.`,
    );
  }

  function setVisibility(visibility: AvatarVisibility) {
    if (busy || user.visibility === visibility) return;
    const label = VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.label || visibility;
    void run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/visibility`, {
          method: "PUT",
          body: JSON.stringify({ visibility }),
        }).then(() => undefined),
      "공개 범위 변경 실패",
      `${user.displayName}님의 공개 범위를 ‘${label}’(으)로 변경했습니다.`,
    );
  }

  function onVisibilityKeydown(event: ReactKeyboardEvent<HTMLButtonElement>, current: AvatarVisibility): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const idx = VISIBILITY_OPTIONS.findIndex((o) => o.value === current);
    const nextIdx =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? VISIBILITY_OPTIONS.length - 1
          : (idx + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + VISIBILITY_OPTIONS.length) %
            VISIBILITY_OPTIONS.length;
    const next = VISIBILITY_OPTIONS[nextIdx].value;
    requestAnimationFrame(() => document.getElementById(`${visibilityGroupId}-${next}`)?.focus());
    setVisibility(next);
  }

  async function toggleSuspend() {
    if (!user.suspended && !(await confirmAction(`${user.displayName} 계정을 정지할까요?\n로그인과 활성 세션이 즉시 차단됩니다.`))) return;
    const current = userRef.current;
    void run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(current.id)}/suspend`, {
          method: "POST",
          body: JSON.stringify({ suspended: !current.suspended }),
        }).then(() => undefined),
      "상태 변경 실패",
      `${current.displayName} 계정을 ${current.suspended ? "활성화" : "정지"}했습니다.`,
    );
  }

  function forceLogout() {
    void run(async () => {
      const r = await api<{ revoked?: number }>(`/api/admin/users/${encodeURIComponent(user.id)}/logout`, { method: "POST" });
      notify(`세션 ${r.revoked ?? 0}개를 종료했습니다.`, "ok");
    }, "로그아웃 실패");
  }

  async function deleteUser() {
    if (
      !(await confirmAction(
        `${user.displayName}(@${user.username}) 계정을 삭제할까요?\n이 사용자의 아바타·대화·설정이 모두 영구 삭제되며 되돌릴 수 없습니다.`,
      ))
    )
      return;
    const current = userRef.current;
    void run(
      () => api(`/api/admin/users/${encodeURIComponent(current.id)}`, { method: "DELETE" }).then(() => undefined),
      "삭제 실패",
      `${current.displayName} 계정을 삭제했습니다.`,
    );
  }

  const describedBy = actionStatus ? actionStatusId : undefined;

  return (
    <>
      <div className={cx("admin-user", user.suspended && "is-suspended")}>
        <div className="admin-row">
          <AvatarImage user={user} size={40} alt="" />
          <div className="ar-main">
            <strong>{user.displayName}</strong>
            <div className="muted">
              @{user.username} · 가입 {timeLabel(user.createdAt)} · 최근 {user.lastSeenAt ? timeLabel(user.lastSeenAt) : "기록 없음"}
            </div>
          </div>
          <div className="ar-tags">
            <span className={`tag ${isAdmin ? "write" : "read"}`}>{isAdmin ? "관리자" : "일반 사용자"}</span>
            {/* 팀 공개가 기본값이라 태그를 달지 않고, 비공개일 때만 표시합니다. */}
            {user.visibility === "private" && <span className="tag">비공개</span>}
            {user.suspended && <span className="tag danger">정지</span>}
            {user.activeSessions ? <span className="tag read">세션 {user.activeSessions}</span> : null}
            {isMe && <span className="tag">나</span>}
          </div>
          <div className="ar-actions">
            <button
              className="ghost-sm"
              type="button"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
              title={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
              onClick={() => void toggle()}
            >
              {expanded ? "접기" : "관리"}
            </button>
          </div>
        </div>

        {expanded && (
          <div id={detailId} className="ar-detail">
            {loading ? (
              <div className="muted" role="status">
                불러오는 중…
              </div>
            ) : loadError ? (
              <div className="warn-box" role="alert">
                불러오기 실패: {loadError}{" "}
                <button className="linkish" type="button" disabled={loading} onClick={() => void loadDetail()}>
                  다시 시도
                </button>
              </div>
            ) : detail ? (
              <>
                <div className="ud-grid">
                  {detailItems(detail).map((it, index) => (
                    <div className="ud-item" key={index}>
                      <span className="ud-val">{it.v ?? 0}</span>
                      <span className="ud-key muted">{it.k}</span>
                    </div>
                  ))}
                </div>
                <div className="ud-visibility" aria-busy={busy}>
                  <span className="ud-visibility-label" id={visibilityGroupId}>
                    아바타 공개 범위
                  </span>
                  <div className="seg-control" role="radiogroup" aria-labelledby={visibilityGroupId} aria-describedby={describedBy}>
                    {VISIBILITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        id={`${visibilityGroupId}-${opt.value}`}
                        type="button"
                        className={cx("seg-btn", user.visibility === opt.value && "active")}
                        role="radio"
                        aria-checked={user.visibility === opt.value}
                        tabIndex={user.visibility === opt.value ? 0 : -1}
                        disabled={busy}
                        onClick={() => setVisibility(opt.value)}
                        onKeyDown={(event) => onVisibilityKeydown(event, opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <span className="ud-visibility-desc muted">{visibilityDesc}</span>
                </div>
                <div className="ud-actions" aria-busy={busy} aria-describedby={describedBy}>
                  <button className="ghost-sm" type="button" aria-describedby={describedBy} disabled={isMe || busy} onClick={() => void toggleRole()}>
                    {isAdmin ? "관리자 해제" : "관리자 지정"}
                  </button>
                  <button
                    className={`ghost-sm ${user.suspended ? "" : "danger"}`}
                    type="button"
                    aria-describedby={describedBy}
                    disabled={isMe || busy}
                    onClick={() => void toggleSuspend()}
                  >
                    {user.suspended ? "활성화" : "정지"}
                  </button>
                  <button className="ghost-sm" type="button" disabled={busy} onClick={() => setShowPasswordModal(true)}>
                    비밀번호 재설정
                  </button>
                  <button className="ghost-sm" type="button" aria-describedby={describedBy} disabled={busy} onClick={forceLogout}>
                    강제 로그아웃
                  </button>
                  <button className="ghost-sm danger" type="button" aria-describedby={describedBy} disabled={isMe || busy} onClick={() => void deleteUser()}>
                    삭제
                  </button>
                  {isMe && <p className="muted ud-self-note">자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다.</p>}
                </div>
                {actionStatus && (
                  <div
                    id={actionStatusId}
                    className={cx(
                      "settings-save-status",
                      busy && "pending",
                      (actionStatus.includes("완료") || actionStatus.includes("했습니다")) && "success",
                      actionStatus.includes("실패") && "invalid",
                    )}
                    role="status"
                    aria-live="polite"
                  >
                    {actionStatus}
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      <Presence>
        {showPasswordModal && (
          <AdminPasswordResetModal
            key="password-reset"
            user={user}
            onClose={() => setShowPasswordModal(false)}
            onDone={() =>
              void reloadRef
                .current()
                .catch((err) => notify(`목록 새로고침에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`, "warn"))
            }
          />
        )}
      </Presence>
    </>
  );
}
