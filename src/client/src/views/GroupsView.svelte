<script lang="ts">
  import { onMount } from "svelte";
  // The 그룹 view consolidates everything group-shaped in one left-rail tab:
  // "내 그룹" (every member's view of their own groups, the card formerly under
  // 내 아바타 ▸ 그룹) and, for SYSTEM admins only, "그룹 관리" (create/search/
  // manage all groups, formerly the 관리자 ▸ 그룹 tab). Legacy hashes
  // #/settings/groups and #/admin/groups redirect here (lib/nav.ts).
  import AdminGroupRow from "../components/AdminGroupRow.svelte";
  import SettingsGroupCard from "../components/SettingsGroupCard.svelte";
  import type { SettingsGroup } from "../components/SettingsGroupCard.svelte";
  import { api } from "../lib/api";
  import { loadAdminGroups, loadAdminUsers } from "../lib/loaders";
  import { appState, notify, updateState } from "../lib/state";

  // ---- 내 그룹 (everyone) ----
  let groups: SettingsGroup[] = [];
  let groupsLoading = false;
  let groupsError = "";

  // ---- 그룹 관리 (system admin) ----
  let adminLoading = false;
  let adminLoaded = false;
  let adminError = "";

  // group create form (moved from the admin view's 그룹 tab)
  let newGroupName = "";
  let newGroupDescription = "";
  let creatingGroup = false;
  let groupCreateError = "";
  let groupCreateMessage = "";
  const groupCreateStatusId = "groups-admin-create-status";

  $: user = $appState.user;
  $: isSystemAdmin = Boolean(user?.roles?.includes("admin"));
  $: groupQuery = $appState.adminGroupSearch.trim().toLowerCase();
  $: shownGroups = groupQuery
    ? $appState.adminGroups.filter((g) =>
        [g.name, g.description || "", `그룹원 ${g.memberCount}`, `관리자 ${g.adminCount}`]
          .join(" ")
          .toLowerCase()
          .includes(groupQuery),
      )
    : $appState.adminGroups;
  $: newGroupNameTrimmed = newGroupName.trim();
  $: canCreateGroup = Boolean(!creatingGroup && newGroupNameTrimmed);
  $: groupCreateStatus = creatingGroup
    ? "그룹을 만드는 중입니다."
    : groupCreateError
      ? `그룹 생성 실패: ${groupCreateError}`
      : groupCreateMessage
        ? groupCreateMessage
        : newGroupNameTrimmed
          ? "그룹을 만들 준비가 됐습니다."
          : "그룹 이름을 입력해 주세요.";
  $: refreshing = groupsLoading || adminLoading;

  onMount(() => {
    void loadMyGroups();
    if (isSystemAdmin) void loadAdminSection();
  });

  // Request-sequence token instead of a `groupsLoading` early-return: a card's
  // reloadMyGroups() after a mutation must ALWAYS reflect post-mutation data. The
  // old early-return let a reload no-op against an in-flight PRE-mutation fetch,
  // which then repopulated the roster with the just-removed member. Every call
  // starts a fresh fetch; only the latest response is applied.
  let groupsSeq = 0;
  async function loadMyGroups(): Promise<void> {
    const seq = ++groupsSeq;
    groupsLoading = true;
    groupsError = "";
    try {
      const { groups: next } = await api<{ groups: SettingsGroup[] }>("/api/me/groups");
      if (seq === groupsSeq) groups = next;
    } catch (err) {
      if (seq === groupsSeq) groupsError = (err as Error).message;
    } finally {
      if (seq === groupsSeq) groupsLoading = false;
    }
  }

  async function loadAdminSection(): Promise<void> {
    if (adminLoading) return;
    adminLoading = true;
    adminError = "";
    try {
      // adminUsers feeds AdminGroupRow's member-add picker (browses the roster).
      await Promise.all([loadAdminGroups(), loadAdminUsers()]);
      adminLoaded = true;
    } catch (err) {
      adminError = (err as Error).message;
    } finally {
      adminLoading = false;
    }
  }

  function refreshAll(): void {
    void loadMyGroups();
    if (isSystemAdmin) void loadAdminSection();
  }

  /** SettingsGroupCard reload: my cards + (admin) the summary counters. */
  async function reloadMyGroups(): Promise<void> {
    await loadMyGroups();
    if (isSystemAdmin) loadAdminGroups().catch(() => {});
  }

  /** AdminGroupRow reload: rename/policy/delete also show on my cards. */
  async function reloadAdminGroups(): Promise<void> {
    void loadMyGroups();
    await loadAdminGroups();
  }

  async function createGroup(): Promise<void> {
    if (creatingGroup) return;
    const name = newGroupNameTrimmed;
    groupCreateMessage = "";
    if (!name) {
      groupCreateError = "그룹 이름을 입력해 주세요.";
      notify("그룹 이름을 입력해 주세요.", "warn");
      return;
    }
    creatingGroup = true;
    groupCreateError = "";
    try {
      await api("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({ name, description: newGroupDescription.trim() }),
      });
    } catch (err) {
      creatingGroup = false;
      groupCreateError = (err as Error).message;
      notify(`그룹 생성 실패: ${groupCreateError}`);
      return;
    }
    newGroupName = "";
    newGroupDescription = "";
    updateState((state) => (state.adminGroupSearch = ""));
    try {
      await loadAdminGroups();
      groupCreateMessage = `그룹 "${name}"을 만들었습니다.`;
      notify(groupCreateMessage, "ok");
    } catch (err) {
      groupCreateError = `그룹은 만들었지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(groupCreateError, "warn");
    } finally {
      creatingGroup = false;
    }
  }
</script>

<header class="view-header">
  <div class="title">
    <h1>그룹</h1>
    <p>{isSystemAdmin ? "내가 속한 그룹을 확인하고 전체 그룹을 관리하세요" : "내가 속한 그룹과 그룹원을 확인하세요"}</p>
  </div>
  <button class="ghost-sm" type="button" disabled={refreshing} on:click={refreshAll}>{refreshing ? "새로고침 중…" : "새로고침"}</button>
</header>

<div class="view-body scroll-thin settings-body">
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>내 그룹</h3>
        <p class="muted">
          내가 속한 그룹과 그룹원입니다. 그룹원 아바타 상호 공개가 켜진 그룹에서는 그룹원끼리 자동으로 서로 신뢰해 아바타에 권한이 부여됩니다. 그룹 관리자는
          그룹원과 공유 스킬 채널을 여기서 관리할 수 있어요.
        </p>
      </div>
      <div class="head-actions">
        <span class="muted small nowrap">{groupsError ? "조회 실패" : groupsLoading ? "새로고침 중" : `총 ${groups.length}개`}</span>
        <button class="linkish small" type="button" disabled={groupsLoading} on:click={() => void loadMyGroups()}>새로고침</button>
      </div>
    </div>
    <div class="groups-body">
      {#if groupsLoading}
        <div class="muted" role="status">불러오는 중…</div>
      {:else if groupsError}
        <div class="warn-box" role="alert">그룹을 불러오지 못했습니다: {groupsError} <button class="linkish" type="button" disabled={groupsLoading} on:click={() => void loadMyGroups()}>다시 시도</button></div>
      {:else if !groups.length}
        <div class="empty-note">
          {isSystemAdmin
            ? "아직 속한 그룹이 없습니다. 아래 ‘그룹 관리’에서 그룹을 만들고 그룹원을 추가할 수 있습니다."
            : "아직 속한 그룹이 없습니다. 그룹은 시스템 관리자가 만들고 그룹원을 추가합니다."}
        </div>
      {:else}
        {#each groups as group (group.id)}
          <SettingsGroupCard {group} reload={reloadMyGroups} />
        {/each}
      {/if}
    </div>
  </section>

  {#if isSystemAdmin}
    <section class="settings-card">
      <div class="panel-section-head">
        <div>
          <h3>그룹 관리</h3>
          <p class="muted">
            시스템 관리자 전용입니다. 그룹 생성·삭제와 도구 정책, 그룹원 구성을 여기서 관리합니다. 각 그룹의 그룹원 아바타
            상호 공개는 그룹 관리자가 자기 그룹의 ‘내 그룹’ 카드에서 설정해요.
          </p>
        </div>
      </div>
      {#if adminError}
        <div class="warn-box" role="alert">
          그룹 관리 정보를 불러오지 못했습니다: {adminError}
          <button class="linkish" type="button" disabled={adminLoading} on:click={() => void loadAdminSection()}>다시 시도</button>
        </div>
      {:else if adminLoading && !adminLoaded}
        <!-- Initial spinner only — later refreshes keep the form/list mounted so
             typed-but-unsaved create-form text survives (always-mount rule). -->
        <div class="muted" role="status">불러오는 중…</div>
      {:else}
        <form class="settings-form" aria-busy={creatingGroup} aria-describedby={groupCreateStatusId} on:submit|preventDefault={createGroup}>
          <div class="field-row-2col">
            <label class="field">
              <span>그룹 이름</span>
              <input
                bind:value={newGroupName}
                name="name"
                placeholder="예: 플랫폼개발팀"
                aria-describedby={groupCreateStatusId}
                aria-invalid={groupCreateError ? "true" : undefined}
                required
                disabled={creatingGroup}
                on:input={() => { groupCreateError = ""; groupCreateMessage = ""; }}
              />
            </label>
            <label class="field">
              <span>설명 (선택)</span>
              <input
                bind:value={newGroupDescription}
                name="description"
                placeholder="그룹을 한 줄로 소개"
                aria-describedby={groupCreateStatusId}
                disabled={creatingGroup}
                on:input={() => { groupCreateError = ""; groupCreateMessage = ""; }}
              />
            </label>
          </div>
          <div class="settings-save-row">
            <span
              id={groupCreateStatusId}
              class="settings-save-status"
              class:dirty={Boolean(newGroupNameTrimmed && !creatingGroup && !groupCreateError && !groupCreateMessage)}
              class:pending={creatingGroup}
              class:success={Boolean(groupCreateMessage)}
              class:invalid={Boolean(groupCreateError)}
              role="status"
              aria-live="polite"
            >{groupCreateStatus}</span>
            <button class="primary" type="submit" aria-describedby={groupCreateStatusId} disabled={!canCreateGroup}>{creatingGroup ? "생성 중…" : "그룹 만들기"}</button>
          </div>
        </form>
        <div class="admin-users-head">
          <input
            type="search"
            class="admin-search"
            placeholder="그룹 이름·설명 검색"
            aria-label="그룹 검색"
            value={$appState.adminGroupSearch}
            disabled={!$appState.adminGroups.length}
            on:input={(e) => updateState((s) => (s.adminGroupSearch = e.currentTarget.value))}
          />
          <span class="muted nowrap">
            {#if shownGroups.length === $appState.adminGroups.length}총 {$appState.adminGroups.length}개{:else}표시 {shownGroups.length}개 / 전체 {$appState.adminGroups.length}개{/if}
          </span>
        </div>
        <div class="admin-list">
          {#if !$appState.adminGroups.length}
            <div class="muted pad">아직 그룹이 없습니다.</div>
          {:else if !shownGroups.length}
            <div class="muted pad">
              "{$appState.adminGroupSearch.trim()}"에 맞는 그룹이 없습니다.
              <button class="linkish small" type="button" on:click={() => updateState((s) => (s.adminGroupSearch = ""))}>검색어 지우기</button>
            </div>
          {:else}
            {#each shownGroups as group (group.id)}
              <AdminGroupRow {group} reload={reloadAdminGroups} />
            {/each}
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>
