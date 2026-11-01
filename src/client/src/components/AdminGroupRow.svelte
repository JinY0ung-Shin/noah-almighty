<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { appState, notify } from "../lib/state";
  import type { AdminGroupSummary, GroupMember } from "../lib/types";
  import { MCP_TOOL_GROUPS, effectiveMcpToolGroups, isRequiredMcpToolGroup, type McpToolGroupId } from "../../../shared/mcpToolGroups";

  export let group: AdminGroupSummary;
  export let reload: () => Promise<void>;

  let expanded = false;
  let loading = false;
  let loadError = "";
  let members: GroupMember[] = [];
  let busy = false;
  let memberBusy: Record<string, boolean> = {};
  let editError = "";
  let addError = "";
  let memberStatus = "";

  // edit form
  let editName = group.name;
  let editDescription = group.description || "";

  // Tool policy editor (SYSTEM-admin only — PUT /api/admin/groups/:id/tool-policy).
  // `policyRestricted` off ⇒ null(제한 없음); on ⇒ the checked allowlist (may be []).
  let policyRestricted = group.allowedMcpToolGroups !== null;
  let policyDraft = new Set<McpToolGroupId>(
    effectiveMcpToolGroups(group.allowedMcpToolGroups),
  );
  let policyBusy = false;
  let policyError = "";

  // member search/filter
  let memberSearch = "";

  // Add-member picker. The admin view always has the full user list loaded
  // ($appState.adminUsers), so this browses/filters it client-side — focusing
  // the input lists every addable user, no search round-trip needed.
  interface SearchUser {
    id: string;
    username: string;
    displayName: string;
    hasImage?: boolean;
    suspended?: boolean;
  }
  let addQuery = "";
  let addAsAdmin = false;
  let showResults = false;
  let activeIndex = -1;
  let selected = new Map<string, SearchUser>();
  let selectedArr: SearchUser[] = [];
  let adding = false;
  let addResult = "";
  let searchWrap: HTMLDivElement | null = null;
  let addInputEl: HTMLInputElement | null = null;

  $: shownMembers = (() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.displayName || "", m.username || "", m.role === "admin" ? "관리자" : "그룹원"].join(" ").toLowerCase().includes(q),
    );
  })();
  $: editNameTrimmed = editName.trim();
  $: editDescriptionTrimmed = editDescription.trim();
  $: editDirty = editNameTrimmed !== group.name || editDescriptionTrimmed !== (group.description || "");
  $: editCanSave = Boolean(!busy && editNameTrimmed && editDirty);
  $: editStatus = busy
    ? "저장 중…"
    : editError
      ? `수정 실패: ${editError}`
      : !editNameTrimmed
        ? "그룹 이름을 입력해 주세요."
        : editDirty
          ? "저장하지 않은 그룹 정보 변경 사항이 있습니다."
          : "저장됨";
  $: addQueryTrimmed = addQuery.trim().replace(/^@/, "");
  $: canSubmitMembers = Boolean(!adding && selectedArr.length);
  $: addRoleHint = addAsAdmin ? "관리자 권한으로 추가됩니다." : "그룹원으로 추가됩니다.";
  $: detailId = `admin-group-detail-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: addListboxId = `admin-group-add-results-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: editStatusId = `admin-group-edit-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: addStatusId = `admin-group-add-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: memberStatusId = `admin-group-member-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: policyStatusId = `admin-group-policy-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: savedPolicy = group.allowedMcpToolGroups === null ? null : effectiveMcpToolGroups(group.allowedMcpToolGroups);
  $: policyDirty =
    policyRestricted !== (savedPolicy !== null) ||
    (policyRestricted &&
      savedPolicy !== null &&
      (policyDraft.size !== savedPolicy.length || savedPolicy.some((id) => !policyDraft.has(id))));
  $: policyStatus = policyBusy
    ? "저장 중…"
    : policyError
      ? `저장 실패: ${policyError}`
      : policyRestricted && [...policyDraft].every(isRequiredMcpToolGroup)
        ? "선택 가능한 도구 묶음이 모두 차단됩니다. 시스템 도구는 항상 사용할 수 있습니다."
        : policyDirty
          ? "저장하지 않은 도구 정책 변경 사항이 있습니다."
          : policyRestricted
            ? `허용 ${policyDraft.size}/${MCP_TOOL_GROUPS.length} — 저장됨`
            : "제한 없음 — 그룹원이 모든 MCP 도구 묶음을 쓸 수 있습니다.";
  $: addStatus = adding
    ? "그룹원을 추가하는 중입니다."
    : addError
      ? addError
      : selectedArr.length
        ? `${selectedArr.length}명이 선택 목록에 있습니다. ${addRoleHint}`
        : addResult
          ? addResult
          : "목록에서 추가할 사용자를 선택해 주세요. 입력하면 이름·아이디로 걸러집니다.";
  $: existingNames = new Set(members.map((m) => (m.username || "").toLowerCase()));
  $: existingIds = new Set(members.map((m) => m.userId));
  $: selectedKeys = new Set(selectedArr.map((u) => (u.username || "").toLowerCase()));
  // Everyone not already in the group and not queued in the selection.
  $: candidates = $appState.adminUsers
    .filter(
      (u) =>
        !existingIds.has(u.id) &&
        !existingNames.has((u.username || "").toLowerCase()) &&
        !selectedKeys.has((u.username || "").toLowerCase()),
    )
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username, "ko"));
  $: addQueryFilter = addQueryTrimmed.toLowerCase();
  $: shownCandidates = addQueryFilter
    ? candidates.filter(
        (u) =>
          (u.displayName || "").toLowerCase().includes(addQueryFilter) ||
          (u.username || "").toLowerCase().includes(addQueryFilter),
      )
    : candidates;
  // Highlight the first hit while filtering; browse mode starts unhighlighted
  // so a stray Enter can't add someone unintentionally.
  $: activeIndex = addQueryFilter && shownCandidates.length ? 0 : -1;

  // The same group can render in two sections at once (the 그룹 view's 내 그룹
  // card + this admin row): when an outside mutation refreshes the summary
  // list, refetch the expanded roster so both agree. Members only — the edit
  // form keeps its unsaved text.
  let syncedGroup = group;
  $: if (group !== syncedGroup) {
    syncedGroup = group;
    if (expanded && !loading) void refreshRoster();
  }

  async function refreshRoster(): Promise<void> {
    try {
      const d = await api<{ members: GroupMember[] }>(`/api/admin/groups/${encodeURIComponent(group.id)}`);
      members = d.members;
    } catch {
      /* keep the current roster; the next interaction reloads it */
    }
  }

  async function toggle() {
    if (expanded) {
      expanded = false;
      return;
    }
    expanded = true;
    await loadDetail();
  }

  async function loadDetail() {
    if (loading) return;
    loading = true;
    loadError = "";
    try {
      const d = await api<{ group: AdminGroupSummary; members: GroupMember[] }>(`/api/admin/groups/${encodeURIComponent(group.id)}`);
      members = d.members;
      editName = group.name;
      editDescription = group.description || "";
      resetPolicyDraft();
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function reloadMembers() {
    const d = await api<{ members: GroupMember[] }>(`/api/admin/groups/${encodeURIComponent(group.id)}`);
    members = d.members;
    reload().catch(() => {});
  }

  async function saveEdit() {
    const nextName = editNameTrimmed;
    if (busy || !nextName || !editDirty) return;
    busy = true;
    editError = "";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, description: editDescriptionTrimmed }),
      });
    } catch (err) {
      busy = false;
      editError = (err as Error).message;
      notify(`수정 실패: ${editError}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${nextName || group.name}" 정보를 수정했습니다.`, "ok");
    } catch (err) {
      notify(`그룹 정보는 수정했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      busy = false;
    }
  }

  function resetPolicyDraft() {
    policyRestricted = group.allowedMcpToolGroups !== null;
    policyDraft = new Set<McpToolGroupId>(
      effectiveMcpToolGroups(group.allowedMcpToolGroups),
    );
    policyError = "";
  }

  function togglePolicyGroup(id: McpToolGroupId, on: boolean) {
    if (policyBusy || isRequiredMcpToolGroup(id)) return;
    const next = new Set(policyDraft);
    if (on) next.add(id);
    else next.delete(id);
    policyDraft = next;
    policyError = "";
  }

  async function savePolicy() {
    if (policyBusy || !policyDirty) return;
    policyBusy = true;
    policyError = "";
    const allowed = policyRestricted
      ? MCP_TOOL_GROUPS.map((g) => g.id).filter((id) => policyDraft.has(id))
      : null;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/tool-policy`, {
        method: "PUT",
        body: JSON.stringify({ allowed }),
      });
    } catch (err) {
      policyBusy = false;
      policyError = (err as Error).message;
      notify(`도구 정책 저장 실패: ${policyError}`);
      return;
    }
    try {
      await reload();
      notify(
        allowed === null
          ? `그룹 "${group.name}"의 도구 제한을 해제했습니다.`
          : `그룹 "${group.name}"의 도구 정책을 저장했습니다. (허용 ${allowed.length}/${MCP_TOOL_GROUPS.length})`,
        "ok",
      );
    } catch (err) {
      notify(`도구 정책은 저장했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      policyBusy = false;
    }
  }

  function refreshSelectedArr() {
    selectedArr = [...selected.values()];
  }

  function openResults() {
    if (adding) return;
    showResults = true;
  }

  function onAddInput() {
    addError = "";
    addResult = "";
    showResults = true;
  }

  // Keep the picker open while focus stays inside it (input ↔ option clicks),
  // so several people can be queued in a row without re-focusing.
  function onAddBlur(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && searchWrap && searchWrap.contains(next)) return;
    showResults = false;
  }

  function selectUser(user: SearchUser): boolean {
    if (adding) return false;
    const username = (user.username || "").trim().replace(/^@/, "");
    const key = username.toLowerCase();
    if (!username) return false;
    if (existingNames.has(key) || (user.id && existingIds.has(user.id))) {
      addError = "이미 그룹에 있는 사용자입니다.";
      notify("이미 그룹에 있는 사용자입니다.", "info");
      addQuery = "";
      showResults = false;
      return false;
    }
    if (selected.has(key)) {
      addError = "이미 선택한 사용자입니다.";
      notify("이미 선택한 사용자입니다.", "info");
      addQuery = "";
      showResults = false;
      return false;
    }
    addError = "";
    addResult = "";
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    refreshSelectedArr();
    addQuery = "";
    requestAnimationFrame(() => addInputEl?.focus());
    return true;
  }

  function removeSelected(key: string) {
    if (adding) return;
    selected.delete(key);
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function clearSelected() {
    if (adding) return;
    selected.clear();
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function onAddKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showResults) {
      e.preventDefault();
      showResults = false;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showResults && activeIndex >= 0 && shownCandidates[activeIndex]) {
        selectUser(shownCandidates[activeIndex]);
      } else if (!showResults) {
        showResults = true;
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!showResults) {
        showResults = true;
      }
      if (!shownCandidates.length) return;
      activeIndex =
        activeIndex < 0
          ? e.key === "ArrowDown"
            ? 0
            : shownCandidates.length - 1
          : (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + shownCandidates.length) % shownCandidates.length;
      document.getElementById(`${addListboxId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  async function submitMembers() {
    if (adding) return;
    if (!selected.size) return;
    const queued = [...selected.entries()];
    const role = addAsAdmin ? "admin" : "member";
    adding = true;
    addError = "";
    addResult = "";
    const failures: string[] = [];
    let successes = 0;
    let refreshError: Error | null = null;
    try {
      for (const [key, user] of queued) {
        try {
          await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members`, {
            method: "POST",
            body: JSON.stringify({ username: user.username, role }),
          });
          selected.delete(key);
          successes++;
        } catch (err) {
          failures.push(`@${user.username}: ${(err as Error).message}`);
        }
      }
      refreshSelectedArr();
      if (successes) {
        if (!selected.size) addAsAdmin = false;
        addQuery = "";
        showResults = false;
        try {
          await reloadMembers();
        } catch (err) {
          refreshError = err as Error;
        }
      }
      if (failures.length) {
        const added = successes ? `${successes}명은 추가했습니다. ` : "";
        addError = `${added}일부 그룹원을 추가하지 못했습니다. ${failures.join(" / ")}`;
        notify(addError, "warn");
      } else if (refreshError) {
        addError = `${successes}명을 추가했지만 목록 새로고침에 실패했습니다: ${refreshError.message}`;
        notify(addError, "warn");
      } else {
        addResult = `${successes}명을 그룹에 추가했습니다.`;
        notify(addResult, "ok");
      }
    } finally {
      adding = false;
    }
  }

  async function toggleMemberRole(m: GroupMember) {
    if (memberBusy[m.userId]) return;
    const isAdmin = m.role === "admin";
    memberBusy = { ...memberBusy, [m.userId]: true };
    memberStatus = `${m.displayName}님의 역할을 변경하는 중입니다.`;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: isAdmin ? "member" : "admin" }),
      });
    } catch (err) {
      memberStatus = `역할 변경 실패: ${(err as Error).message}`;
      notify(memberStatus);
      memberBusy = { ...memberBusy, [m.userId]: false };
      return;
    }
    try {
      await reloadMembers();
      memberStatus = `${m.displayName}님의 그룹 관리자 역할을 ${isAdmin ? "해제" : "부여"}했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `역할은 변경됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      memberBusy = { ...memberBusy, [m.userId]: false };
    }
  }

  async function removeMember(m: GroupMember) {
    if (memberBusy[m.userId]) return;
    if (!(await confirmAction(`${m.displayName}님을 그룹에서 제거할까요?`))) return;
    memberBusy = { ...memberBusy, [m.userId]: true };
    memberStatus = `${m.displayName}님을 제거하는 중입니다.`;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (err) {
      memberStatus = `제거 실패: ${(err as Error).message}`;
      notify(memberStatus);
      memberBusy = { ...memberBusy, [m.userId]: false };
      return;
    }
    try {
      await reloadMembers();
      memberStatus = `${m.displayName}님을 그룹에서 제거했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `그룹원은 제거됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      memberBusy = { ...memberBusy, [m.userId]: false };
    }
  }

  async function deleteGroup() {
    if (busy) return;
    if (!(await confirmAction(`'${group.name}' 그룹을 삭제할까요?\n그룹 소속이 모두 해제되고 그룹원 간 자동 신뢰와 이 그룹을 통한 스킬 공유가 사라집니다.`))) return;
    busy = true;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
    } catch (err) {
      busy = false;
      notify(`삭제 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${group.name}"을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`그룹은 삭제했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      // The success path never reset busy: it survived only because the reload
      // unmounts the row. If reload returns a list still containing this group,
      // the delete button would stay disabled without this.
      busy = false;
    }
  }
</script>

<div class="admin-user">
  <div class="admin-row">
    <div class="ar-main">
      <strong>{group.name}</strong>
      <div class="muted">{group.description || "(설명 없음)"}</div>
    </div>
    <div class="ar-tags">
      <span class="tag">그룹원 {group.memberCount}</span>
      <span class="tag write">관리자 {group.adminCount}</span>
      {#if group.allowedMcpToolGroups}<span class="tag danger">도구 제한 {effectiveMcpToolGroups(group.allowedMcpToolGroups).length}/{MCP_TOOL_GROUPS.length}</span>{/if}
      {#if !group.avatarSharing}<span class="tag read">아바타 상호 공개 꺼짐</span>{/if}
    </div>
    <div class="ar-actions">
      <button
        class="ghost-sm"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
        title={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
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
      {:else}
        <div class="ar-detail-inner">
          <h4 class="knowledge-sub">그룹 정보</h4>
          <form class="settings-form" on:submit|preventDefault={saveEdit}>
            <div class="field-row-2col">
              <label class="field">
                <span>그룹 이름</span>
                <input bind:value={editName} aria-describedby={editStatusId} aria-invalid={editError || !editNameTrimmed ? "true" : undefined} disabled={busy} on:input={() => (editError = "")} />
              </label>
              <label class="field">
                <span>설명</span>
                <input bind:value={editDescription} placeholder="그룹을 한 줄로 소개" aria-describedby={editStatusId} disabled={busy} on:input={() => (editError = "")} />
              </label>
            </div>
            <div class="settings-save-row">
              <span id={editStatusId} class="settings-save-status" class:dirty={Boolean(editDirty && !busy && editNameTrimmed && !editError)} class:pending={busy} class:invalid={Boolean(editError || !editNameTrimmed)} role="status" aria-live="polite">{editStatus}</span>
              <button class="primary small" type="submit" disabled={!editCanSave}>{busy ? "저장 중…" : "저장"}</button>
            </div>
          </form>

          <h4 class="knowledge-sub">도구 정책</h4>
          <p class="muted">
            이 그룹의 그룹원이 아바타 대화에서 사용할 수 있는 MCP 도구 묶음을 제한합니다. 여러 그룹에 속한
            사용자는 정책이 있는 모든 그룹에서 공통으로 허용된 도구만 쓸 수 있습니다(교집합). 정책이 없는
            그룹은 제한에 영향을 주지 않으며, 설정은 시스템 관리자만 바꿀 수 있습니다. 시스템 도구는 항상 사용하며 개별 작업의 권한 검사는 유지됩니다.
          </p>
          <form class="settings-form" on:submit|preventDefault={savePolicy}>
            <label class="group-add-admin">
              <input
                type="checkbox"
                bind:checked={policyRestricted}
                aria-describedby={policyStatusId}
                disabled={policyBusy}
                on:change={() => (policyError = "")}
              />
              <span>MCP 도구 묶음 제한 사용</span>
            </label>
            {#if policyRestricted}
              <div class="group-add-chip-list" role="group" aria-label="허용할 MCP 도구 묶음">
                {#each MCP_TOOL_GROUPS as toolGroup (toolGroup.id)}
                  <label class="group-add-admin">
                    <input
                      type="checkbox"
                      checked={policyDraft.has(toolGroup.id)}
                      aria-describedby={policyStatusId}
                      disabled={policyBusy || isRequiredMcpToolGroup(toolGroup.id)}
                      on:change={(event) => togglePolicyGroup(toolGroup.id, event.currentTarget.checked)}
                    />
                    <span>{toolGroup.labelKo}{isRequiredMcpToolGroup(toolGroup.id) ? " · 항상 사용" : ""}</span>
                  </label>
                {/each}
              </div>
            {/if}
            <div class="settings-save-row">
              <span
                id={policyStatusId}
                class="settings-save-status"
                class:dirty={Boolean(policyDirty && !policyBusy && !policyError)}
                class:pending={policyBusy}
                class:invalid={Boolean(policyError)}
                role="status"
                aria-live="polite"
              >{policyStatus}</span>
              <button class="primary small" type="submit" disabled={policyBusy || !policyDirty}>{policyBusy ? "저장 중…" : "정책 저장"}</button>
            </div>
          </form>

          <h4 class="knowledge-sub">그룹원</h4>
          <div class="admin-users-head">
            <input
              type="search"
              class="admin-search"
              placeholder="그룹원 이름·아이디 검색"
              aria-label="그룹원 검색"
              bind:value={memberSearch}
              disabled={!members.length}
            />
            <span class="muted nowrap">
              {#if shownMembers.length === members.length}그룹원 {members.length}명{:else}표시 {shownMembers.length}명 / 전체 {members.length}명{/if}
            </span>
          </div>
          <div class="plugin-rows">
            {#if !members.length}
              <div class="empty-note">그룹원이 없습니다.</div>
            {:else if !shownMembers.length}
              <div class="empty-note">
                "{memberSearch.trim()}"에 맞는 그룹원이 없습니다.
                <button class="linkish small" type="button" on:click={() => (memberSearch = "")}>검색어 지우기</button>
              </div>
            {:else}
              {#each shownMembers as m (m.userId)}
                <div class="plugin-row" class:busy={memberBusy[m.userId]}>
                  <AvatarImage user={{ id: m.userId, username: m.username, displayName: m.displayName, hasImage: m.hasImage }} size={32} alt="" />
                  <div class="pr-main">
                    <strong>{m.displayName}</strong>
                    <div class="pr-sub">@{m.username}</div>
                  </div>
                  {#if m.role === "admin"}<span class="tag write">관리자</span>{:else}<span class="tag read">그룹원</span>{/if}
                  <div class="pr-actions">
                    <button class="ghost-sm" type="button" title={m.role === "admin" ? "그룹 관리자 해제" : "그룹 관리자 지정"} aria-describedby={memberStatus ? memberStatusId : undefined} disabled={memberBusy[m.userId]} on:click={() => toggleMemberRole(m)}>
                      {m.role === "admin" ? "관리자 해제" : "관리자 지정"}
                    </button>
                    <button class="msg-act danger" type="button" title="그룹원 제거" aria-label={`${m.displayName} 제거`} aria-describedby={memberStatus ? memberStatusId : undefined} disabled={memberBusy[m.userId]} on:click={() => removeMember(m)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
          {#if memberStatus}
            <div
              id={memberStatusId}
              class="settings-save-status"
              class:pending={memberStatus.includes("중입니다")}
              class:success={memberStatus.includes("했습니다")}
              class:invalid={memberStatus.includes("실패") || memberStatus.includes("못했습니다")}
              role="status"
              aria-live="polite"
            >{memberStatus}</div>
          {/if}

          <div class="group-add-panel" aria-describedby={addStatusId} aria-busy={adding}>
            <div class="group-add">
              <div class="trusted-search" bind:this={searchWrap}>
                <input
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls={addListboxId}
                  aria-expanded={showResults ? "true" : "false"}
                  aria-activedescendant={showResults && activeIndex >= 0 ? `${addListboxId}-option-${activeIndex}` : undefined}
                  aria-describedby={addStatusId}
                  aria-invalid={addError ? "true" : undefined}
                  placeholder="선택하면 전체 목록이 열립니다 — 이름·아이디로 검색"
                  aria-label="그룹원 추가"
                  disabled={adding}
                  bind:this={addInputEl}
                  bind:value={addQuery}
                  on:focus={openResults}
                  on:click={openResults}
                  on:input={onAddInput}
                  on:keydown={onAddKeydown}
                  on:blur={onAddBlur}
                />
                <div id={addListboxId} class="trusted-results" role="listbox" hidden={!showResults}>
                  {#if !shownCandidates.length}
                    <div class="empty-note">{addQueryTrimmed ? "일치하는 사용자가 없습니다." : "추가할 수 있는 사용자가 없습니다."}</div>
                  {:else}
                    {#each shownCandidates as u, idx (u.id)}
                      <button
                        id={`${addListboxId}-option-${idx}`}
                        type="button"
                        class="trusted-result"
                        class:active={idx === activeIndex}
                        role="option"
                        aria-selected={idx === activeIndex}
                        disabled={adding}
                        on:click={() => selectUser(u)}
                      >
                        <AvatarImage user={{ id: u.id, username: u.username, displayName: u.displayName, hasImage: u.hasImage }} size={28} alt="" />
                        <div class="pr-main">
                          <strong>{u.displayName}</strong>
                          <div class="pr-sub">@{u.username}</div>
                        </div>
                        {#if u.suspended}<span class="tag danger">정지</span>{/if}
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>
              <label class="group-add-admin"><input type="checkbox" bind:checked={addAsAdmin} aria-describedby={addStatusId} disabled={adding} /><span>그룹 관리자로</span></label>
              <button class="primary small" type="button" aria-describedby={addStatusId} disabled={!canSubmitMembers} on:click={submitMembers}>
                {adding ? "추가 중…" : selectedArr.length ? `${selectedArr.length}명 추가` : "그룹원 추가"}
              </button>
            </div>
          </div>
          <div class="settings-save-row compact">
            <span
              id={addStatusId}
              class="settings-save-status"
              class:dirty={Boolean(!adding && !addError && !addResult && selectedArr.length)}
              class:pending={adding}
              class:success={Boolean(addResult)}
              class:invalid={Boolean(addError)}
              role="status"
              aria-live="polite"
            >{addStatus}</span>
          </div>
          {#if selectedArr.length}
            <div class="group-add-selected">
              <div class="group-add-chip-list" role="list" aria-label="추가할 그룹원 선택 목록">
                {#each selectedArr as u (u.username.toLowerCase())}
                  <span class="group-add-chip" role="listitem">
                    <span>{u.displayName || u.username} · @{u.username}</span>
                    <button class="msg-act" type="button" title="선택 해제" aria-label={`${u.displayName || u.username} 선택 해제`} disabled={adding} on:click={() => removeSelected(u.username.toLowerCase())}>
                      <Icon name="close" />
                    </button>
                  </span>
                {/each}
              </div>
              <button class="linkish small group-add-clear" type="button" disabled={adding} on:click={clearSelected}>선택 모두 해제</button>
            </div>
          {/if}

          <div class="ud-actions">
            <button class="ghost-sm danger" type="button" disabled={busy} on:click={deleteGroup}>그룹 삭제</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
