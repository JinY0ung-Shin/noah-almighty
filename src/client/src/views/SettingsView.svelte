<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import SettingsProfileTab from "../components/SettingsProfileTab.svelte";
  import SettingsAccessTab from "../components/SettingsAccessTab.svelte";
  import SettingsKnowledgeTab from "../components/SettingsKnowledgeTab.svelte";
  import { loadSettingsData } from "../lib/loaders";
  import { appState, updateState } from "../lib/state";

  // 그룹 moved to its own left-rail view (GroupsView) — #/settings/groups
  // redirects there (lib/nav.ts).
  const tabs = [
    { id: "profile", label: "프로필", icon: "user" },
    { id: "access", label: "권한·연결", icon: "shield" },
    { id: "knowledge", label: "지식·플러그인", icon: "book" },
  ] as const;
  type SettingsTabId = (typeof tabs)[number]["id"];

  let loading = true;
  let loadBusy = false;
  let error = "";

  $: user = $appState.user;
  $: settingsTab = $appState.settingsTab;

  onMount(load);

  async function load(): Promise<void> {
    if (loadBusy) return;
    loadBusy = true;
    loading = true;
    error = "";
    try {
      await loadSettingsData();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
      loadBusy = false;
    }
  }

  function setSettingsTab(id: SettingsTabId): void {
    updateState((state) => (state.settingsTab = id));
  }

  function focusSettingsTab(id: SettingsTabId): void {
    requestAnimationFrame(() => document.getElementById(`settings-tab-${id}`)?.focus());
  }

  function onSettingsTabKeydown(event: KeyboardEvent, currentId: SettingsTabId): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex].id;
    setSettingsTab(next);
    focusSettingsTab(next);
  }
</script>

<header class="view-header">
  <div class="title">
    <h1>내 아바타</h1>
    <p>프로필·권한·지식을 관리하세요</p>
  </div>
</header>

<div class="view-body scroll-thin settings-body" class:settings-body-access={settingsTab === "access"}>
  {#if loading}
    <div class="muted pad" role="status">불러오는 중…</div>
  {:else if error}
    <div class="warn-box" role="alert">
      설정 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" disabled={loadBusy} on:click={load}>다시 시도</button>
    </div>
  {:else if user}
    <div class="settings-tabs settings-primary-tabs" role="tablist" aria-label="설정 분류">
      {#each tabs as tab}
        <button
          id={`settings-tab-${tab.id}`}
          class="settings-tab"
          type="button"
          role="tab"
          class:active={settingsTab === tab.id}
          aria-selected={settingsTab === tab.id}
          aria-controls="settings-panel"
          tabindex={settingsTab === tab.id ? 0 : -1}
          on:click={() => setSettingsTab(tab.id)}
          on:keydown={(event) => onSettingsTabKeydown(event, tab.id)}
        >
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <div
      id="settings-panel"
      class="settings-panel"
      class:settings-panel-access={settingsTab === "access"}
      role="tabpanel"
      aria-labelledby={`settings-tab-${settingsTab}`}
    >
      <SettingsProfileTab active={settingsTab === "profile"} />
      <SettingsAccessTab active={settingsTab === "access"} />
      <SettingsKnowledgeTab active={settingsTab === "knowledge"} />
    </div>
  {/if}
</div>
