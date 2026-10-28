<script lang="ts" context="module">
  import type { GroupMember } from "../lib/types";
  import type { McpToolGroupId } from "../../../shared/mcpToolGroups";

  // The richer per-group shape returned by GET /api/me/groups (members + repo),
  // vs. the lighter UserGroupMembership on User.groups.
  export interface SettingsGroup {
    id: string;
    name: string;
    role: "admin" | "member";
    knowledgeRepo: string | null;
    knowledgeBranch: string | null;
    knowledgeSelected: string[] | null;
    /** System-admin tool policy for this group (read-only here); null = none. */
    allowedMcpToolGroups: McpToolGroupId[] | null;
    /** Group policy: off = knowledge-sharing-only (no avatar reach/trust between members). */
    avatarSharing: boolean;
    members: GroupMember[];
  }
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  // One group block in the 그룹 tab: teammate roster (searchable, chat shortcut),
  // and for group admins, member management (role toggle / remove) + a member-add
  // typeahead, plus the shared knowledge-repo card. Ports buildGroupBlock /
  // buildGroupRosterRow / buildGroupRepoCard / buildGroupMemberAddForm from
  // settings/groups.js. The user-search typeahead is inlined here (per the task
  // rule: no shared UserSearch component).
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { startChatWith, openSeededChat } from "../lib/chat";
  import { notify, readState, newId } from "../lib/state";
  import { repoToHref } from "../lib/format";
  import type { AvatarSummary, GroupSharedSkill, RepoPluginContents } from "../lib/types";
  import { MCP_TOOL_GROUPS, effectiveMcpToolGroups } from "../../../shared/mcpToolGroups";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import SettingsPluginSelect from "./SettingsPluginSelect.svelte";
  import GraphViewModal from "./GraphViewModal.svelte";

  let graphOpen = false;
  let requestRepoBusy = false;
  let chatBusyId = "";

  export let group: SettingsGroup;
  export let githubHost = "github.com";
  /** Reload the whole group list from the server (after member/repo mutations). */
  export let reload: () => Promise<void>;

  $: amAdmin = group.role === "admin";
  $: meId = readState().user?.id;
  // System-admin tool policy (read-only — only the admin page can change it).
  $: policyAllowedLabels = (() => {
    const allowed = group.allowedMcpToolGroups;
    if (!allowed) return null;
    return MCP_TOOL_GROUPS.filter((g) => effectiveMcpToolGroups(allowed).includes(g.id)).map((g) => g.labelKo);
  })();

  function groupPanelId(suffix: string): string {
    return `group-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${suffix}`;
  }

  // ---- roster search ----
  let rosterQuery = "";
  $: shownMembers = rosterQuery.trim()
    ? group.members.filter((m) =>
        [m.displayName || "", m.username || "", m.role === "admin" ? "관리자" : "그룹원"]
          .join(" ")
          .toLowerCase()
          .includes(rosterQuery.trim().toLowerCase()),
      )
    : group.members;
  $: memberCountLabel =
    shownMembers.length === group.members.length
      ? `그룹원 ${group.members.length}명`
      : `표시 ${shownMembers.length}명 / 전체 ${group.members.length}명`;

  let rowBusy: Record<string, boolean> = {};
  let memberStatus = "";
  $: memberStatusId = groupPanelId("member-status");
  $: addStatusId = groupPanelId("member-add-status");

  async function chatWith(m: GroupMember): Promise<void> {
    if (chatBusyId) return;
    const av: AvatarSummary =
      readState().avatars.find((a) => a.id === m.userId) || {
        id: m.userId,
        username: m.username,
        displayName: m.displayName,
        alias: "",
        bio: "",
        hashtags: [],
        hasImage: m.hasImage,
        pluginCount: 0,
        visibility: m.visibility,
        updatedAt: null,
      };
    chatBusyId = m.userId;
    memberStatus = `${m.displayName}님과의 대화를 여는 중입니다.`;
    try {
      await startChatWith(av);
    } catch (err) {
      memberStatus = `대화를 열지 못했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      chatBusyId = "";
    }
  }

  async function toggleRole(m: GroupMember): Promise<void> {
    if (rowBusy[m.userId]) return;
    rowBusy = { ...rowBusy, [m.userId]: true };
    const nextRole = m.role === "admin" ? "member" : "admin";
    memberStatus = `${m.displayName}님의 역할을 변경하는 중입니다.`;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
    } catch (err) {
      memberStatus = `역할 변경 실패: ${(err as Error).message}`;
      notify(memberStatus, "warn");
      rowBusy = { ...rowBusy, [m.userId]: false };
      return;
    }
    try {
      await reload();
      memberStatus = `${m.displayName}님의 그룹 관리자 역할을 ${m.role === "admin" ? "해제" : "부여"}했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `역할은 변경했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      rowBusy = { ...rowBusy, [m.userId]: false };
    }
  }

  async function removeMember(m: GroupMember): Promise<void> {
    if (rowBusy[m.userId]) return;
    if (!(await confirmAction(`${m.displayName}님을 그룹에서 제거할까요?`))) return;
    rowBusy = { ...rowBusy, [m.userId]: true };
    memberStatus = `${m.displayName}님을 그룹에서 제거하는 중입니다.`;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (err) {
      memberStatus = `제거 실패: ${(err as Error).message}`;
      notify(memberStatus, "warn");
      rowBusy = { ...rowBusy, [m.userId]: false };
      return;
    }
    try {
      await reload();
      memberStatus = `${m.displayName}님을 그룹에서 제거했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `그룹원은 제거했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      rowBusy = { ...rowBusy, [m.userId]: false };
    }
  }

  // ---- member-add typeahead (inlined) ----
  interface SearchUser {
    id: string;
    username: string;
    displayName: string;
  }
  let addQuery = "";
  let addAsAdmin = false;
  let searchResults: SearchUser[] = [];
  let showResults = false;
  let activeIndex = -1;
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  // Queued selections keyed by lowercased username.
  let selected = new Map<string, SearchUser>();
  let selectedArr: SearchUser[] = [];
  let adding = false;
  let addError = "";
  let addResult = "";

  $: addQueryTrimmed = addQuery.trim().replace(/^@/, "");
  $: canPickTyped = Boolean(!adding && addQueryTrimmed);
  $: canSubmitMembers = Boolean(!adding && (selectedArr.length || addQueryTrimmed));
  $: addRoleHint = addAsAdmin ? "관리자 권한으로 추가됩니다." : "그룹원으로 추가됩니다.";
  $: addStatus = adding
    ? "그룹원을 추가하는 중입니다."
    : addError
      ? addError
      : selectedArr.length
        ? `${selectedArr.length}명이 선택 목록에 있습니다. ${addRoleHint}`
        : addResult
          ? addResult
          : addQueryTrimmed
            ? `입력한 사용자를 선택 목록에 추가하거나 바로 추가할 수 있습니다. ${addRoleHint}`
            : "추가할 사용자를 검색해 주세요.";
  $: existingNames = new Set(group.members.map((m) => (m.username || "").toLowerCase()));
  $: existingIds = new Set(group.members.map((m) => m.userId));

  function refreshSelectedArr(): void {
    selectedArr = [...selected.values()];
  }

  async function runSearch(q: string): Promise<void> {
    const s = ++searchSeq;
    try {
      const { users } = await api<{ users: SearchUser[] }>(`/api/me/users/search?q=${encodeURIComponent(q)}`);
      if (s !== searchSeq) return;
      const selectedKeys = new Set(selected.keys());
      searchResults = users.filter(
        (u) => !existingIds.has(u.id) && !existingNames.has((u.username || "").toLowerCase()) && !selectedKeys.has((u.username || "").toLowerCase()),
      );
      showResults = true;
      activeIndex = searchResults.length ? 0 : -1;
    } catch {
      if (s === searchSeq) {
        showResults = false;
        addError = "사용자 검색에 실패했습니다.";
      }
    }
  }

  function onAddInput(): void {
    addError = "";
    addResult = "";
    const q = addQuery.trim().replace(/^@/, "");
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      searchSeq++;
      searchResults = [];
      showResults = false;
      return;
    }
    searchTimer = setTimeout(() => void runSearch(q), 200);
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
      return false;
    }
    if (selected.has(key)) {
      addError = "이미 선택한 사용자입니다.";
      notify("이미 선택한 사용자입니다.", "info");
      addQuery = "";
      return false;
    }
    addError = "";
    addResult = "";
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    refreshSelectedArr();
    addQuery = "";
    showResults = false;
    searchResults = [];
    return true;
  }

  function addTyped(): boolean {
    if (adding) return false;
    const username = addQueryTrimmed;
    if (!username) return false;
    return selectUser({ id: "", username, displayName: username });
  }

  function removeSelected(key: string): void {
    if (adding) return;
    selected.delete(key);
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function clearSelected(): void {
    if (adding) return;
    selected.clear();
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function onAddKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && showResults) {
      e.preventDefault();
      showResults = false;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showResults && activeIndex >= 0 && searchResults[activeIndex]) {
        selectUser(searchResults[activeIndex]);
      } else {
        addTyped();
      }
      return;
    }
    if (!showResults || !searchResults.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + searchResults.length) % searchResults.length;
    }
  }

  async function submitMembers(): Promise<void> {
    if (adding) return;
    if (!selected.size && addQuery.trim()) addTyped();
    if (!selected.size) return;
    const queued = [...selected.entries()];
    const role = addAsAdmin ? "admin" : "member";
    adding = true;
    addError = "";
    addResult = "";
    const failures: string[] = [];
    let refreshError: Error | null = null;
    let successes = 0;
    try {
      for (const [key, user] of queued) {
        try {
          await api(`/api/me/groups/${encodeURIComponent(group.id)}/members`, {
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
        try {
          await reload();
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

  // ---- group knowledge repo ----
  let repoInput = "";
  let branchInput = "";
  $: savedGroupRepo = group.knowledgeRepo || "";
  $: savedGroupBranch = group.knowledgeBranch || "";
  $: {
    repoInput = savedGroupRepo;
    branchInput = savedGroupBranch;
  }
  let repoBusy = false;
  let repoRefreshed = false;
  let repoError = "";
  $: repoStatusId = groupPanelId("repo-status");
  $: repoInputTrimmed = repoInput.trim();
  $: branchInputTrimmed = branchInput.trim();
  $: repoDirty = repoInputTrimmed !== savedGroupRepo || branchInputTrimmed !== savedGroupBranch;
  $: repoCanSave = Boolean(!repoBusy && repoInputTrimmed && repoDirty);
  $: repoStatus = repoBusy
    ? "저장 중…"
    : repoError
      ? `저장 실패: ${repoError}`
      : !repoInputTrimmed && savedGroupRepo
        ? "연결 해제는 ‘연결 해제’ 버튼을 사용합니다."
        : repoDirty
          ? "저장하지 않은 저장소 변경 사항이 있습니다."
          : savedGroupRepo
            ? "연결됨"
            : "연결 전";

  async function saveRepo(): Promise<void> {
    if (repoBusy) return;
    const repo = repoInputTrimmed;
    const branch = branchInputTrimmed;
    if (!repo) {
      repoError = group.knowledgeRepo ? "공용 저장소 연결 해제는 ‘연결 해제’ 버튼을 사용해 주세요." : "공용 지식 저장소 주소를 입력해 주세요.";
      notify(group.knowledgeRepo ? "공용 저장소 연결을 해제하려면 ‘연결 해제’ 버튼을 사용해 주세요." : "공용 지식 저장소 주소를 입력해 주세요.", "warn");
      return;
    }
    if (!repoDirty) return;
    repoBusy = true;
    repoError = "";
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo`, {
        method: "PUT",
        body: JSON.stringify({ repo, branch: branch || null }),
      });
    } catch (err) {
      repoError = (err as Error).message;
      notify(`저장 실패: ${repoError}`, "warn");
      repoBusy = false;
      return;
    }
    // New repo → different plugins; drop the cached listing + close the picker so
    // it can't show the old repo's plugin names against the new selection.
    pickOpen = false;
    contents = null;
    try {
      await reload();
      notify(`"${group.name}" 공용 지식 저장소 "${repo}"을 연결했습니다.`, "ok");
    } catch (err) {
      notify(`공용 지식 저장소는 연결했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  async function refreshRepo(): Promise<void> {
    if (repoBusy) return;
    repoBusy = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/refresh`, { method: "POST" });
      repoRefreshed = true;
      setTimeout(() => (repoRefreshed = false), 1200);
      notify(`"${group.name}" 공용 지식 저장소를 최신 상태로 새로고침했습니다.`, "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  async function disconnectRepo(): Promise<void> {
    if (repoBusy) return;
    if (!(await confirmAction("이 그룹의 공용 지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 그룹원 아바타들이 더 이상 그 스킬을 불러오지 않습니다."))) return;
    repoBusy = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo`, { method: "PUT", body: JSON.stringify({ repo: null }) });
    } catch (err) {
      notify(`연결 해제 실패: ${(err as Error).message}`, "warn");
      repoBusy = false;
      return;
    }
    try {
      await reload();
      notify(`"${group.name}" 공용 지식 저장소 연결을 해제했습니다.`, "ok");
    } catch (err) {
      notify(`공용 지식 저장소 연결은 해제했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  async function requestGroupRepo(): Promise<void> {
    if (requestRepoBusy) return;
    requestRepoBusy = true;
    try {
      await openSeededChat(`"${group.name}" 그룹의 공용 지식 저장소를 만들어서 연결해줘. 그룹원들이 함께 사용할 기본 지식/스킬 구조까지 준비해줘.`);
    } catch (err) {
      notify(`요청 대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      requestRepoBusy = false;
    }
  }

  // plugin selection (expandable)
  let pickOpen = false;
  let contents: RepoPluginContents | null = null;
  let contentsErr = "";
  let contentsLoading = false;
  $: selSummary = !group.knowledgeSelected ? "저장소의 모든 플러그인을 사용 중" : `${group.knowledgeSelected.length}개 플러그인만 사용 중`;

  async function togglePick(): Promise<void> {
    pickOpen = !pickOpen;
    if (!pickOpen) return;
    if (!contents && !contentsLoading) await loadContents();
    await tick();
    document.getElementById(groupPanelId("plugin-contents"))?.scrollIntoView({ block: "center" });
  }
  async function loadContents(): Promise<void> {
    if (contentsLoading) return;
    contentsLoading = true;
    contentsErr = "";
    try {
      const { contents: info } = await api<{ contents: RepoPluginContents }>(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/contents`);
      contents = info;
    } catch (err) {
      contentsErr = (err as Error).message;
    } finally {
      contentsLoading = false;
    }
  }
  async function saveSelection(next: string[] | null): Promise<void> {
    await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/selected`, { method: "PUT", body: JSON.stringify({ selected: next }) });
    try {
      await reload();
    } catch (err) {
      notify(`플러그인 선택은 저장했지만 그룹 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }

  const listboxId = `group-search-${newId()}`;

  // ---- 공유 스킬 채널 관리 (그룹 관리자) ----
  // 그룹원이 공유한 스킬을 이 그룹 채널에서만 내리는 moderation. 차단은
  // (그룹, 소유자, 스킬 이름) 키라서 공유 해제 후 재공유해도 유지되고, 다른
  // 공통 그룹이 있으면 그쪽으로는 계속 보인다(서버가 질의 단계에서 강제).
  let sharedSkills: GroupSharedSkill[] = [];
  let sharedSkillsLoading = false;
  let sharedSkillsError = "";
  let blockBusyKey = "";
  const skillKey = (s: GroupSharedSkill) => `${s.ownerUserId}:${s.skillName}`;

  // 관리자에게만 필요한 목록이라 관리자 카드에서만 불러온다 (메타데이터 전용
  // 질의라 클론을 건드리지 않는다).
  onMount(() => {
    if (amAdmin) void loadSharedSkills();
  });

  async function loadSharedSkills(): Promise<void> {
    if (sharedSkillsLoading) return;
    sharedSkillsLoading = true;
    sharedSkillsError = "";
    try {
      const { skills } = await api<{ skills: GroupSharedSkill[] }>(
        `/api/me/groups/${encodeURIComponent(group.id)}/shared-skills`,
      );
      sharedSkills = skills;
    } catch (err) {
      sharedSkillsError = (err as Error).message;
    } finally {
      sharedSkillsLoading = false;
    }
  }

  async function toggleSkillBlock(skill: GroupSharedSkill): Promise<void> {
    if (blockBusyKey) return;
    const title = skill.displayName || skill.skillName;
    const confirmed = await confirmAction(
      skill.blocked
        ? `@${skill.owner.username}의 "${title}" 스킬 차단을 해제할까요? "${group.name}" 그룹원에게 다시 보입니다.`
        : `@${skill.owner.username}의 "${title}" 스킬을 "${group.name}" 그룹 채널에서 차단할까요? 이 그룹을 통해서는 그룹원에게 보이지 않게 됩니다. 이미 전수받은 사본과 다른 그룹은 그대로예요.`,
      skill.blocked
        ? { title: "차단을 해제할까요?", confirmLabel: "차단 해제" }
        : { title: "공유 스킬을 차단할까요?", confirmLabel: "차단", tone: "danger" },
    );
    if (!confirmed) return;
    const base = `/api/me/groups/${encodeURIComponent(group.id)}/shared-skills/blocks`;
    blockBusyKey = skillKey(skill);
    try {
      if (skill.blocked) {
        await api(
          `${base}/${encodeURIComponent(skill.ownerUserId)}/${encodeURIComponent(skill.skillName)}`,
          { method: "DELETE" },
        );
        notify(`"${title}" 스킬 차단을 해제했습니다.`, "ok");
      } else {
        await api(base, {
          method: "POST",
          body: JSON.stringify({ ownerUserId: skill.ownerUserId, skillName: skill.skillName }),
        });
        notify(`"${title}" 스킬을 "${group.name}" 그룹 채널에서 차단했습니다.`, "ok");
      }
      await loadSharedSkills();
    } catch (err) {
      notify(`공유 스킬 차단 설정 실패: ${(err as Error).message}`, "warn");
    } finally {
      blockBusyKey = "";
    }
  }

  // ---- avatar-sharing policy (group admins) ----
  let sharingSaving = false;
  async function toggleAvatarSharing(on: boolean): Promise<void> {
    if (sharingSaving) return;
    sharingSaving = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/avatar-sharing`, {
        method: "PUT",
        body: JSON.stringify({ enabled: on }),
      });
      notify(
        on
          ? `"${group.name}" 그룹의 그룹원 아바타 상호 공개를 켰습니다.`
          : `"${group.name}" 그룹의 그룹원 아바타 상호 공개를 껐습니다. 이제 이 그룹은 지식 공유 전용이에요.`,
        "ok",
      );
      try {
        await reload();
      } catch (err) {
        notify(`설정은 저장했지만 그룹 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
      }
    } catch (err) {
      notify(`그룹원 아바타 상호 공개 설정을 저장하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      sharingSaving = false;
    }
  }

  function summarizeRepoContentsError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("repository not found")) return "저장소를 찾지 못했습니다. 저장소 주소 또는 접근 권한을 확인해 주세요.";
    if (lower.includes("command failed") || lower.includes("git clone")) return "저장소 내용을 가져오지 못했습니다.";
    return message.length > 140 ? `${message.slice(0, 140)}…` : message;
  }

  function shouldShowRepoErrorDetails(message: string): boolean {
    return message.length > 140 || /command failed|git clone/i.test(message);
  }
</script>

<div class="group-block">
  <div class="group-block-head">
    <strong>{group.name}</strong>
    {#if amAdmin}
      <span class="tag write">내가 관리자</span>
    {:else}
      <span class="tag read">그룹원</span>
    {/if}
    {#if !group.avatarSharing}
      <span class="tag read">지식 공유 전용</span>
    {/if}
  </div>

  {#if amAdmin}
    <label class="shared-account-item">
      <input
        type="checkbox"
        checked={group.avatarSharing}
        disabled={sharingSaving}
        aria-busy={sharingSaving}
        on:change={(event) => toggleAvatarSharing(event.currentTarget.checked)}
      />
      <span class="shared-account-meta">
        <strong>그룹원 아바타 상호 공개</strong>
        <span class="muted">켜면 같은 그룹원끼리 서로의 아바타를 찾고 대화할 수 있어요(신뢰 권한 포함). 끄면 이 그룹은 지식 공유 전용이 되어 그룹원 아바타가 서로에게 보이지 않아요. 공용 지식 저장소는 계속 함께 사용합니다.</span>
      </span>
    </label>
  {:else if !group.avatarSharing}
    <p class="muted">이 그룹은 그룹원 아바타 상호 공개가 꺼져 있어요(지식 공유 전용). 그룹원 아바타와의 대화는 그룹 관리자가 다시 켜면 가능해집니다.</p>
  {/if}

  {#if group.members.length}
    <div class="admin-users-head group-roster-head">
      <input type="search" class="admin-search" placeholder="그룹원 이름·아이디 검색" aria-label={`${group.name} 그룹원 검색`} bind:value={rosterQuery} />
      <span class="muted nowrap">{memberCountLabel}</span>
    </div>
  {/if}

  <div class="plugin-rows">
    {#if !group.members.length}
      <div class="empty-note">그룹원이 없습니다.</div>
    {:else if !shownMembers.length}
      <div class="empty-note">
        "{rosterQuery.trim()}"에 맞는 그룹원이 없습니다.
        <button class="linkish small" type="button" on:click={() => (rosterQuery = "")}>검색어 지우기</button>
      </div>
    {:else}
      {#each shownMembers as m (m.userId)}
        <div
          class="plugin-row"
          class:busy={rowBusy[m.userId] || chatBusyId === m.userId}
          aria-busy={rowBusy[m.userId] || chatBusyId === m.userId ? "true" : "false"}>
          <AvatarImage user={{ ...m, id: m.userId }} size={32} alt="" />
          <div class="pr-main">
            <strong>{m.displayName}{m.userId === meId ? " (나)" : ""}</strong>
            <div class="pr-sub">@{m.username}</div>
          </div>
          {#if m.role === "admin"}<span class="tag write">관리자</span>{/if}
          <div class="pr-actions">
            {#if m.userId !== meId && group.avatarSharing}
              <button class="ghost-sm" type="button" title={`${m.displayName}의 아바타와 대화`} aria-describedby={memberStatus ? memberStatusId : undefined} disabled={Boolean(chatBusyId)} on:click={() => chatWith(m)}>
                {chatBusyId === m.userId ? "여는 중…" : "대화"}
              </button>
            {/if}
            {#if amAdmin && m.userId !== meId}
              <button class="ghost-sm" type="button" aria-describedby={memberStatus ? memberStatusId : undefined} disabled={rowBusy[m.userId]} on:click={() => toggleRole(m)}>
                {m.role === "admin" ? "관리자 해제" : "관리자 지정"}
              </button>
              <button class="ghost-sm danger" type="button" aria-describedby={memberStatus ? memberStatusId : undefined} disabled={rowBusy[m.userId]} on:click={() => removeMember(m)}>제거</button>
            {/if}
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
      class:invalid={memberStatus.includes("실패") || memberStatus.includes("못했습니다")}
      class:success={memberStatus.includes("했습니다") && !memberStatus.includes("실패") && !memberStatus.includes("못했")}
      role="status"
      aria-live="polite"
    >{memberStatus}</div>
  {/if}

  {#if amAdmin}
    <div class="group-add-panel" aria-busy={adding} aria-describedby={addStatusId}>
      <div class="group-add">
        <div class="trusted-search">
          <input
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={showResults}
            aria-activedescendant={showResults && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            aria-describedby={addStatusId}
            aria-invalid={addError ? "true" : undefined}
            placeholder="추가할 그룹원 아이디(@) 또는 이름"
            aria-label="그룹원 추가"
            disabled={adding}
            bind:value={addQuery}
            on:input={onAddInput}
            on:keydown={onAddKeydown}
            on:blur={() => setTimeout(() => (showResults = false), 150)}
          />
          <div id={listboxId} class="trusted-results" role="listbox" hidden={!showResults}>
            {#if !searchResults.length}
              <div class="empty-note">일치하는 사용자가 없습니다.</div>
            {:else}
              {#each searchResults as u, idx (u.id || u.username)}
                <button
                  id={`${listboxId}-option-${idx}`}
                  type="button"
                  class="trusted-result"
                  class:active={idx === activeIndex}
                  role="option"
                  aria-selected={idx === activeIndex}
                  disabled={adding}
                  on:click={() => selectUser(u)}
                >
                  <div class="pr-main">
                    <strong>{u.displayName}</strong>
                    <div class="pr-sub">@{u.username}</div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
        <button class="icon-button group-add-pick" type="button" title="입력한 사용자를 선택 목록에 추가" aria-label="입력한 사용자를 선택 목록에 추가" aria-describedby={addStatusId} disabled={!canPickTyped} on:click={addTyped}>
          <Icon name="plus" />
        </button>
        <label class="group-add-admin"><input type="checkbox" bind:checked={addAsAdmin} aria-describedby={addStatusId} disabled={adding} /><span>그룹 관리자로</span></label>
        <button class="primary small" type="button" aria-describedby={addStatusId} disabled={!canSubmitMembers} on:click={submitMembers}>
          {adding ? "추가 중…" : selectedArr.length ? `${selectedArr.length}명 추가` : addQueryTrimmed ? "입력한 사용자 추가" : "선택한 그룹원 추가"}
        </button>
      </div>
      <div class="settings-save-row compact">
        <span
          id={addStatusId}
          class="settings-save-status"
          class:dirty={Boolean(!adding && !addError && !addResult && (selectedArr.length || addQueryTrimmed))}
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
    </div>

    <div class="group-repo">
      <h4 class="knowledge-sub">공용 지식 저장소</h4>
      {#if group.knowledgeRepo}
        <div class="head-actions">
          <button class="linkish small" type="button" title="노트 사이의 [[링크]] 연결을 그래프로 봅니다" on:click={() => (graphOpen = true)}>그래프 보기</button>
          <button class="linkish small" type="button" disabled={repoBusy} on:click={refreshRepo}>{repoRefreshed ? "새로고침됨 ✓" : "새로고침"}</button>
          <button class="linkish small danger" type="button" disabled={repoBusy} title="이 그룹의 공용 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)" on:click={disconnectRepo}>연결 해제</button>
        </div>
      {/if}
      <form class="settings-form" on:submit|preventDefault={saveRepo}>
        <div class="field-row-2col">
          <label class="field">
            <span>저장소 주소</span>
            <input bind:value={repoInput} placeholder="owner/repo 또는 사내 git URL" aria-describedby={repoStatusId} aria-invalid={repoError ? "true" : undefined} disabled={repoBusy} on:input={() => (repoError = "")} />
          </label>
          <label class="field">
            <span>브랜치 (선택)</span>
            <input bind:value={branchInput} placeholder="비우면 기본 브랜치" aria-describedby={repoStatusId} disabled={repoBusy} on:input={() => (repoError = "")} />
          </label>
        </div>
        <div class="settings-save-row">
          <span id={repoStatusId} class="settings-save-status" class:dirty={repoDirty && !repoBusy && !repoError} class:pending={repoBusy} class:invalid={Boolean(repoError)} role="status" aria-live="polite">{repoStatus}</span>
          <button class="primary" type="submit" disabled={!repoCanSave}>{repoBusy ? "저장 중…" : savedGroupRepo ? "저장" : "연결"}</button>
        </div>
      </form>
      {#if !group.knowledgeRepo}
        <div class="empty-note">
          공용 저장소를 연결하면 그룹원 전원의 아바타가 그 저장소의 스킬을 사용합니다.
          <button class="linkish small" type="button" disabled={requestRepoBusy} on:click={requestGroupRepo}>
            {requestRepoBusy ? "대화 여는 중…" : "아바타에게 공용 저장소 만들기 요청"}
          </button>
        </div>
      {:else}
        {@const href = repoToHref(group.knowledgeRepo, githubHost)}
        {@const linkText = group.knowledgeRepo + (group.knowledgeBranch ? ` @ ${group.knowledgeBranch}` : "")}
        <div class="kr-link">
          <Icon name="globe" />
          {#if href}
            <a {href} target="_blank" rel="noreferrer noopener">{linkText}</a>
          {:else}
            <code>{linkText}</code>
          {/if}
        </div>
        <div class="kr-plugins">
          <span class="muted">{selSummary}</span>
          <button
            class="linkish small"
            type="button"
            aria-expanded={pickOpen}
            aria-controls={groupPanelId("plugin-contents")}
            on:click={togglePick}
          >사용할 플러그인 선택</button>
        </div>
        {#if pickOpen}
          <div id={groupPanelId("plugin-contents")} class="plugin-contents" aria-busy={contentsLoading ? "true" : "false"}>
            {#if contentsLoading}
              <div class="muted" role="status">불러오는 중…</div>
            {:else if contentsErr}
              <div class="error-note" role="alert">
                조회 실패: {summarizeRepoContentsError(contentsErr)}
                {#if shouldShowRepoErrorDetails(contentsErr)}
                  <details class="error-details">
                    <summary>오류 상세</summary>
                    <code>{contentsErr}</code>
                  </details>
                {/if}
                <button class="linkish small" type="button" disabled={contentsLoading} on:click={loadContents}>다시 시도</button>
              </div>
            {:else if contents}
              <SettingsPluginSelect
                info={contents}
                selected={group.knowledgeSelected}
                headText="그룹원 아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
                onSave={saveSelection}
              />
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    <div class="group-shared-skills">
      <h4 class="knowledge-sub">공유 스킬</h4>
      <div class="head-actions">
        <span class="muted small nowrap">
          {sharedSkillsError ? "조회 실패" : sharedSkillsLoading ? "불러오는 중" : `총 ${sharedSkills.length}개`}
        </span>
        <button class="linkish small" type="button" disabled={sharedSkillsLoading} on:click={() => void loadSharedSkills()}>새로고침</button>
      </div>
      <p class="muted small">
        그룹원이 자기 지식 저장소에서 공유한 스킬입니다. 차단하면 이 그룹을 통해서는 보이지 않아요 — 다른 공통 그룹이 있으면 그쪽으로는 계속 보이고,
        이미 전수받은 사본과 공유한 사람 본인의 목록은 그대로입니다. 공유를 해제했다가 다시 공유해도 차단은 유지돼요.
      </p>
      {#if !group.avatarSharing}
        <p class="muted small">
          지금은 그룹원 아바타 상호 공개가 꺼져 있어 이 그룹 채널로는 어차피 스킬이 보이지 않습니다. 차단 설정은 저장되고, 상호 공개를 다시 켜면 그대로 적용돼요.
        </p>
      {/if}
      {#if sharedSkillsLoading && !sharedSkills.length}
        <div class="muted" role="status">불러오는 중…</div>
      {:else if sharedSkillsError}
        <div class="warn-box" role="alert">
          공유 스킬을 불러오지 못했습니다: {sharedSkillsError}
          <button class="linkish" type="button" disabled={sharedSkillsLoading} on:click={() => void loadSharedSkills()}>다시 시도</button>
        </div>
      {:else if !sharedSkills.length}
        <div class="empty-note">아직 이 그룹의 그룹원이 공유한 스킬이 없습니다.</div>
      {:else}
        <div class="plugin-rows">
          {#each sharedSkills as skill (skillKey(skill))}
            <div class="plugin-row" class:busy={blockBusyKey === skillKey(skill)} aria-busy={blockBusyKey === skillKey(skill) ? "true" : "false"}>
              <AvatarImage user={skill.owner} size={32} alt="" />
              <div class="pr-main">
                <strong>{skill.displayName || skill.skillName}</strong>
                <div class="pr-sub">
                  {skill.owner.displayName} · @{skill.owner.username}
                  {#if skill.displayName && skill.displayName !== skill.skillName} · {skill.skillName}{/if}
                  · 전수 {skill.learnCount}회
                </div>
              </div>
              {#if skill.blocked}<span class="tag read">차단됨</span>{/if}
              <div class="pr-actions">
                <button
                  class="ghost-sm"
                  class:danger={!skill.blocked}
                  type="button"
                  title={skill.blocked
                    ? "이 그룹의 그룹원에게 다시 보이게 합니다"
                    : "이 그룹을 통해서는 그룹원에게 보이지 않게 합니다"}
                  aria-label={`${skill.displayName || skill.skillName} ${skill.blocked ? "차단 해제" : "차단"}`}
                  disabled={Boolean(blockBusyKey)}
                  on:click={() => toggleSkillBlock(skill)}
                >{skill.blocked ? "차단 해제" : "차단"}</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <p class="muted small">
      {group.knowledgeRepo ? "이 그룹에는 공용 지식 저장소가 연결되어 그룹원들의 아바타와 공유됩니다." : "이 그룹에는 아직 공용 지식 저장소가 없습니다."}
      {#if group.knowledgeRepo}
        <button class="linkish small" type="button" title="노트 사이의 [[링크]] 연결을 그래프로 봅니다" on:click={() => (graphOpen = true)}>그래프 보기</button>
      {/if}
    </p>
  {/if}

  {#if policyAllowedLabels}
    <p class="muted small">
      시스템 관리자가 이 그룹의 도구 정책을 설정했습니다 — 허용:
      {policyAllowedLabels.length ? policyAllowedLabels.join(", ") : "없음 (모든 MCP 도구 묶음 차단)"}.
      여러 그룹에 속한 경우 정책이 있는 그룹들의 교집합이 적용됩니다.
    </p>
  {/if}

  {#if graphOpen}
    <GraphViewModal
      endpoint={`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/graph`}
      title={`지식 그래프 · ${group.name}`}
      sourceKey={`group:${group.id}`}
      on:close={() => (graphOpen = false)}
    />
  {/if}
</div>
