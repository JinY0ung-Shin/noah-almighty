<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import AdminPasswordResetModal from "./AdminPasswordResetModal.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { appState, notify } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import type { AdminUserDetail, AdminUserSummary, AvatarVisibility } from "../lib/types";

  export let user: AdminUserSummary;
  export let reload: () => Promise<void>;

  // Mirrors the owner-facing selector in SettingsProfileTab (팀 공개/비공개).
  const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
    { value: "group", label: "팀 공개", desc: "모든 팀원(가입이 승인된 사용자)이 탐색에서 찾아 대화할 수 있습니다." },
    { value: "private", label: "비공개", desc: "본인만 볼 수 있습니다." },
  ];

  let expanded = false;
  let loading = false;
  let loadError = "";
  let detail: AdminUserDetail | null = null;
  let busy = false;
  let actionStatus = "";
  let showPasswordModal = false;

  $: isMe = user.id === $appState.user?.id;
  $: isAdmin = user.roles?.includes("admin");
  $: visibilityDesc = VISIBILITY_OPTIONS.find((o) => o.value === user.visibility)?.desc || "";
  $: userBaseId = user.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  $: detailId = `admin-user-detail-${userBaseId}`;
  $: actionStatusId = `admin-user-action-status-${userBaseId}`;
  $: visibilityGroupId = `admin-user-visibility-${userBaseId}`;

  async function toggle() {
    if (expanded) {
      expanded = false;
      return;
    }
    expanded = true;
    if (detail) return;
    await loadDetail();
  }

  async function loadDetail() {
    if (loading) return;
    loading = true;
    loadError = "";
    try {
      const d = await api<{ user: AdminUserDetail }>(`/api/admin/users/${encodeURIComponent(user.id)}`);
      detail = d.user;
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  // After a mutation (suspend/role/logout/password-reset) the parent refreshes
  // only the summary row; the expanded detail (sessions/questions/started chats)
  // would keep stale numbers. Re-fetch it when the user prop identity changes.
  let syncedUser = user;
  $: if (user !== syncedUser) {
    syncedUser = user;
    detail = null;
    if (expanded && !loading) void loadDetail();
  }

  async function run(fn: () => Promise<void>, errLabel: string, successLabel = "") {
    if (busy) return;
    busy = true;
    actionStatus = "작업을 처리하는 중입니다.";
    try {
      await fn();
    } catch (err) {
      busy = false;
      actionStatus = `${errLabel}: ${(err as Error).message}`;
      notify(actionStatus);
      return;
    }
    try {
      await reload();
      actionStatus = successLabel || "작업이 완료되었습니다.";
      if (successLabel) notify(successLabel, "ok");
    } catch (err) {
      actionStatus = `작업은 완료됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(actionStatus, "warn");
    } finally {
      busy = false;
    }
  }

  async function toggleRole() {
    const verb = isAdmin ? "해제" : "부여";
    if (!(await confirmAction(`${user.displayName}(@${user.username})님의 관리자 권한을 ${verb}할까요?`))) return;
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
          method: "POST",
          body: JSON.stringify({ role: "admin", grant: !isAdmin }),
        }).then(() => undefined),
      "권한 변경 실패",
      `${user.displayName}님의 관리자 권한을 ${verb}했습니다.`,
    );
  }

  function setVisibility(visibility: AvatarVisibility) {
    if (busy || user.visibility === visibility) return;
    const label = VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.label || visibility;
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/visibility`, {
          method: "PUT",
          body: JSON.stringify({ visibility }),
        }).then(() => undefined),
      "공개 범위 변경 실패",
      `${user.displayName}님의 공개 범위를 ‘${label}’(으)로 변경했습니다.`,
    );
  }

  function onVisibilityKeydown(event: KeyboardEvent, current: AvatarVisibility): void {
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
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/suspend`, {
          method: "POST",
          body: JSON.stringify({ suspended: !user.suspended }),
        }).then(() => undefined),
      "상태 변경 실패",
      `${user.displayName} 계정을 ${user.suspended ? "활성화" : "정지"}했습니다.`,
    );
  }

  function forceLogout() {
    run(
      async () => {
        const r = await api<{ revoked?: number }>(`/api/admin/users/${encodeURIComponent(user.id)}/logout`, { method: "POST" });
        notify(`세션 ${r.revoked ?? 0}개를 종료했습니다.`, "ok");
      },
      "로그아웃 실패",
    );
  }

  async function deleteUser() {
    if (!(await confirmAction(`${user.displayName}(@${user.username}) 계정을 삭제할까요?\n이 사용자의 아바타·대화·설정이 모두 영구 삭제되며 되돌릴 수 없습니다.`))) return;
    run(
      () => api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" }).then(() => undefined),
      "삭제 실패",
      `${user.displayName} 계정을 삭제했습니다.`,
    );
  }

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
</script>

<div class="admin-user" class:is-suspended={user.suspended}>
  <div class="admin-row">
    <AvatarImage user={user} size={40} alt="" />
    <div class="ar-main">
      <strong>{user.displayName}</strong>
      <div class="muted">@{user.username} · 가입 {timeLabel(user.createdAt)} · 최근 {user.lastSeenAt ? timeLabel(user.lastSeenAt) : "기록 없음"}</div>
    </div>
    <div class="ar-tags">
      <span class="tag {isAdmin ? 'write' : 'read'}">{isAdmin ? "관리자" : "일반 사용자"}</span>
      <!-- 팀 공개가 기본값이라 태그를 달지 않고, 비공개일 때만 표시합니다. -->
      {#if user.visibility === "private"}<span class="tag">비공개</span>{/if}
      {#if user.suspended}<span class="tag danger">정지</span>{/if}
      {#if user.activeSessions}<span class="tag read">세션 {user.activeSessions}</span>{/if}
      {#if isMe}<span class="tag">나</span>{/if}
    </div>
    <div class="ar-actions">
      <button
        class="ghost-sm"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
        title={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
        on:click={toggle}
      >{expanded ? "접기" : "관리"}</button>
    </div>
  </div>

  {#if expanded}
    <div id={detailId} class="ar-detail">
      {#if loading}
        <div class="muted" role="status">불러오는 중…</div>
      {:else if loadError}
        <div class="warn-box" role="alert">
          불러오기 실패: {loadError}
          <button class="linkish" type="button" disabled={loading} on:click={loadDetail}>다시 시도</button>
        </div>
      {:else if detail}
        <div class="ud-grid">
          {#each detailItems(detail) as it}
            <div class="ud-item">
              <span class="ud-val">{it.v ?? 0}</span>
              <span class="ud-key muted">{it.k}</span>
            </div>
          {/each}
        </div>
        <div class="ud-visibility" aria-busy={busy}>
          <span class="ud-visibility-label" id={visibilityGroupId}>아바타 공개 범위</span>
          <div class="seg-control" role="radiogroup" aria-labelledby={visibilityGroupId} aria-describedby={actionStatus ? actionStatusId : undefined}>
            {#each VISIBILITY_OPTIONS as opt (opt.value)}
              <button
                id={`${visibilityGroupId}-${opt.value}`}
                type="button"
                class="seg-btn"
                class:active={user.visibility === opt.value}
                role="radio"
                aria-checked={user.visibility === opt.value}
                tabindex={user.visibility === opt.value ? 0 : -1}
                disabled={busy}
                on:click={() => setVisibility(opt.value)}
                on:keydown={(event) => onVisibilityKeydown(event, opt.value)}
              >{opt.label}</button>
            {/each}
          </div>
          <span class="ud-visibility-desc muted">{visibilityDesc}</span>
        </div>
        <div class="ud-actions" aria-busy={busy} aria-describedby={actionStatus ? actionStatusId : undefined}>
          <button class="ghost-sm" type="button" aria-describedby={actionStatus ? actionStatusId : undefined} disabled={isMe || busy} on:click={toggleRole}>{isAdmin ? "관리자 해제" : "관리자 지정"}</button>
          <button class="ghost-sm {user.suspended ? '' : 'danger'}" type="button" aria-describedby={actionStatus ? actionStatusId : undefined} disabled={isMe || busy} on:click={toggleSuspend}>{user.suspended ? "활성화" : "정지"}</button>
          <button class="ghost-sm" type="button" disabled={busy} on:click={() => (showPasswordModal = true)}>비밀번호 재설정</button>
          <button class="ghost-sm" type="button" aria-describedby={actionStatus ? actionStatusId : undefined} disabled={busy} on:click={forceLogout}>강제 로그아웃</button>
          <button class="ghost-sm danger" type="button" aria-describedby={actionStatus ? actionStatusId : undefined} disabled={isMe || busy} on:click={deleteUser}>삭제</button>
          {#if isMe}
            <p class="muted ud-self-note">자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다.</p>
          {/if}
        </div>
        {#if actionStatus}
          <div
            id={actionStatusId}
            class="settings-save-status"
            class:pending={busy}
            class:success={actionStatus.includes("완료") || actionStatus.includes("했습니다")}
            class:invalid={actionStatus.includes("실패")}
            role="status"
            aria-live="polite"
          >{actionStatus}</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

{#if showPasswordModal}
  <AdminPasswordResetModal user={user} on:close={() => (showPasswordModal = false)} on:done={() => reload().catch((err) => notify(`목록 새로고침에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`, "warn"))} />
{/if}
