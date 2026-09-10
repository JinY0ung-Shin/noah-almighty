<script lang="ts">
  import { onMount } from "svelte";
  import AuthView from "./components/AuthView.svelte";
  import Shell from "./components/Shell.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ConfirmationDialog from "./components/ConfirmationDialog.svelte";
  import DirectMessageDock from "./components/DirectMessageDock.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
  import PromptModal from "./components/PromptModal.svelte";
  import WhatsNewModal from "./components/WhatsNewModal.svelte";
  import { api, setSessionExpiredHandler } from "./lib/api";
  import { selectConversation } from "./lib/chat";
  import { loadRailCollapsed, persistRailCollapsed } from "./lib/layout";
  import { loadInboxData, startKnowledgeWatch, stopKnowledgeWatch } from "./lib/loaders";
  import { applyInitialRoute, installRouteListener, syncHash } from "./lib/nav";
  import { appState, notify, readState, replaceState, updateState } from "./lib/state";
  import { applyTheme, getThemePref, watchSystemTheme } from "./lib/theme";
  import { unseenReleases, type ReleaseNote } from "../../server/releaseNotes";
  import type { BootstrapInfo, User } from "./lib/types";
  import type { ViewName } from "./lib/types";

  let showOnboarding = false;
  let showWhatsNew = false;
  let whatsNewReleases: ReleaseNote[] = [];
  let themeWatcherInstalled = false;
  let railCollapsed = loadRailCollapsed();
  let mobileRailOpen = false;
  let activeViewName: ViewName | null = null;
  let activeViewComponent: any = null;
  let viewLoadToken = 0;

  const viewLoaders: Record<ViewName, () => Promise<{ default: any }>> = {
    explore: () => import("./views/ExploreView.svelte"),
    chat: () => import("./views/ChatView.svelte"),
    bots: () => import("./views/BotsView.svelte"),
    brain: () => import("./views/BrainView.svelte"),
    inbox: () => import("./views/InboxView.svelte"),
    routines: () => import("./views/RoutinesView.svelte"),
    groups: () => import("./views/GroupsView.svelte"),
    skills: () => import("./views/SkillsView.svelte"),
    settings: () => import("./views/SettingsView.svelte"),
    admin: () => import("./views/AdminView.svelte"),
  };
  const viewCache = new Map<ViewName, any>();
  const viewLabels: Record<ViewName, string> = {
    explore: "탐색",
    chat: "대화",
    bots: "봇 오피스",
    brain: "지식 그래프",
    inbox: "알림",
    routines: "예약 작업",
    groups: "그룹",
    skills: "스킬 배우기",
    settings: "내 아바타",
    admin: "관리자",
  };

  async function loadView(view: ViewName): Promise<void> {
    const token = ++viewLoadToken;
    activeViewName = view;
    const cached = viewCache.get(view);
    if (cached) {
      activeViewComponent = cached;
      return;
    }
    activeViewComponent = null;
    const component = (await viewLoaders[view]()).default;
    viewCache.set(view, component);
    if (token === viewLoadToken && activeViewName === view) activeViewComponent = component;
  }

  function setRailCollapsed(collapsed: boolean): void {
    railCollapsed = collapsed;
    persistRailCollapsed(collapsed);
  }

  function setMobileRailOpen(open: boolean): void {
    mobileRailOpen = open;
  }

  async function boot() {
    const themePref = applyTheme();
    if (!themeWatcherInstalled) {
      watchSystemTheme();
      themeWatcherInstalled = true;
    }
    replaceState({ booted: false, bootError: "", themePref });
    try {
      const bootstrap = await api<BootstrapInfo>("/api/bootstrap");
      const { user } = await api<{ user: User | null }>("/api/me");
      replaceState({ bootstrap, user, booted: true, themePref, view: "explore" });
      // enterApp() runs via the reactive init guard below once user is set.
    } catch (err) {
      replaceState({ booted: true, bootError: (err as Error).message, themePref: getThemePref() });
    }
  }

  // Full post-login initialization: restore route, load the inbox (badges +
  // pending requests), start the knowledge/notification watcher, and show
  // first-run onboarding. Shared by boot() and post-login (Shell remount).
  function enterApp(user: User) {
    applyInitialRoute();
    if (!location.hash) syncHash(true);
    void loadInboxData();
    startKnowledgeWatch();
    // First-run welcome shows only while the account has never been onboarded
    // (server-persisted onboardedAt). Set once on signup, so a returning login
    // — even on a new browser — never re-fires it.
    if (!user.onboardedAt) showOnboarding = true;
    // One-time "what's new" after a deploy: releases newer than the account's
    // server-persisted lastSeenRelease. Signup seeds the then-current id, so
    // this fires only for accounts that predate a deploy — onboarding (new
    // accounts) never stacks with it in practice; the guard is belt-and-braces.
    whatsNewReleases = unseenReleases(user.lastSeenRelease);
    if (!showOnboarding && whatsNewReleases.length > 0) showWhatsNew = true;
  }

  function dismissOnboarding() {
    showOnboarding = false;
    // Persist server-side so it never re-appears; optimistically reflect it in
    // state. Fire-and-forget — a failed mark just means it may show once more.
    api<{ user: User }>("/api/me/onboarded", { method: "POST" })
      .then(({ user }) => replaceState({ user }))
      .catch(() => {});
  }

  function dismissWhatsNew() {
    showWhatsNew = false;
    // Persist server-side (the server stamps ITS current release id — no body);
    // optimistic, fire-and-forget — a failed mark just means it may show once
    // more. Mirrors dismissOnboarding.
    api<{ user: User }>("/api/me/release-seen", { method: "POST" })
      .then(({ user }) => replaceState({ user }))
      .catch(() => {});
  }

  function handleSessionExpired() {
    stopKnowledgeWatch();
    updateState((state) => {
      state.user = null;
      state.currentAvatar = null;
      state.chatPanes = [];
      state.activePaneId = null;
      state.conversations = [];
      state.notifications = [];
      state.knowledgeRequests = [];
      state.routineConversations = [];
      state.routineConversationId = "";
      state.routineMessages = [];
      state.promptQueue = [];
    });
    showOnboarding = false;
    showWhatsNew = false;
    notify("세션이 만료되었습니다. 다시 로그인해 주세요.", "warn");
    history.replaceState(null, "", location.pathname);
  }

  // When a user logs in from the auth screen (AuthView sets state.user), run the
  // same post-login initialization once.
  let initializedFor: string | null = null;
  $: if ($appState.booted && $appState.user && initializedFor !== $appState.user.id) {
    initializedFor = $appState.user.id;
    enterApp($appState.user);
  }
  $: if (!$appState.user) initializedFor = null;

  // 설정 → 시작 안내 re-opens the welcome modal on demand. One-shot flag, drained
  // here the way SettingsAccessTab drains browserGuideRequested — but with no view
  // to navigate to, since the modal is a global overlay. Deliberately independent
  // of `onboardedAt`: an already-onboarded owner is exactly who asks for this.
  $: if ($appState.onboardingRequested) {
    updateState((state) => (state.onboardingRequested = false));
    showOnboarding = true;
  }

  onMount(() => {
    setSessionExpiredHandler(handleSessionExpired);
    const cleanup = installRouteListener((conversationId) => {
      const state = readState();
      const activeConversationId =
        state.chatPanes.find((pane) => pane.id === state.activePaneId)?.conversationId ?? state.chatPanes[0]?.conversationId;
      if (activeConversationId === conversationId) return;
      void selectConversation(conversationId).catch((err) =>
        notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn"),
      );
    });
    void boot();
    return () => {
      cleanup();
      stopKnowledgeWatch();
    };
  });

  $: unreadCount =
    $appState.knowledgeRequests.filter((request) => request.status === "open").length +
    $appState.notifications.filter((notification) => !notification.readAt).length;
  $: activeViewLabel = viewLabels[$appState.view];
  $: if ($appState.user && activeViewName !== $appState.view) void loadView($appState.view);
</script>

{#if !$appState.booted}
  <div class="app-status-screen" role="status" aria-live="polite" aria-label="앱을 불러오는 중">
    <div class="app-status-card">
      <img class="app-status-mark" src="/icon-192.png" alt="" aria-hidden="true" width="48" height="48" />
      <strong>Noah Almighty</strong>
      <span class="muted">작업 공간을 준비하는 중…</span>
    </div>
  </div>
{:else if $appState.bootError}
  <div class="app-status-screen" role="alert">
    <div class="app-status-card warn-box">
      <strong>앱을 시작하지 못했습니다</strong>
      <span>{$appState.bootError}</span>
      <button class="primary" type="button" on:click={boot}>다시 시도</button>
    </div>
  </div>
{:else if !$appState.user}
  <AuthView bootstrap={$appState.bootstrap} />
{:else if $appState.view === "bots"}
  <!-- 봇 오피스 is the one RAIL-LESS view: it is a full-screen messenger with its
       own roster column, so it mounts outside .workspace's grid (no <Shell/>) and
       carries its own back affordance. Kept INSIDE the logged-in branch so the
       global overlays below still mount — their DOM order is load-bearing
       (DESIGN.md §4.4). -->
  <main id="main" class="main bots-main" tabindex="-1" aria-busy={!activeViewComponent}>
    {#if activeViewComponent}
      <svelte:component this={activeViewComponent} />
    {:else}
      <div class="svelte-fallback-pad muted" role="status">화면을 준비하는 중…</div>
    {/if}
  </main>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{activeViewLabel} 화면</div>
{:else}
  <section class="workspace" class:rail-collapsed={railCollapsed}>
    <Shell
      user={$appState.user}
      view={$appState.view}
      streaming={$appState.streaming}
      {unreadCount}
      themePref={$appState.themePref}
      {railCollapsed}
      onRailCollapsedChange={setRailCollapsed}
      onMobileRailOpenChange={setMobileRailOpen}
    />
    <main id="main" class="main" tabindex="-1" inert={mobileRailOpen} aria-busy={!activeViewComponent}>
      {#if activeViewComponent}
        <svelte:component this={activeViewComponent} />
      {:else}
        <div class="svelte-fallback-pad muted" role="status">화면을 준비하는 중…</div>
      {/if}
    </main>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{activeViewLabel} 화면</div>
  </section>
{/if}

<!-- The messenger dock is NOT part of the layout: it floats in the viewport's
     bottom-right corner, so it mounts once for the logged-in state and shows on
     EVERY view — including the rail-less 봇 오피스 — rather than living in the
     rail footer where a whole view had no access to it. Non-modal, so it is
     placed BEFORE the modal stack whose DOM order is load-bearing
     (DESIGN.md §4.4) and must not be reordered. -->
{#if $appState.user}
  {#key $appState.user.id}
    <DirectMessageDock userId={$appState.user.id} hidden={mobileRailOpen} />
  {/key}
{/if}

{#if showOnboarding && $appState.user}
  <OnboardingModal
    user={$appState.user}
    confluenceConfigured={$appState.bootstrap?.confluenceConfigured ?? false}
    githubHost={$appState.bootstrap?.githubHost ?? "github.com"}
    on:close={dismissOnboarding}
  />
{/if}

{#if showWhatsNew && $appState.user}
  <WhatsNewModal releases={whatsNewReleases} on:close={dismissWhatsNew} />
{/if}

<!-- Mounted at the app root (not inside ChatView) so input-needed prompts surface
     on ANY view — otherwise a question raised while the owner is on explore/inbox/
     settings would queue invisibly. -->
{#if $appState.user}
  <PromptModal />
{/if}

<Toasts />
<ConfirmationDialog />
