<script lang="ts">
  import { onMount } from "svelte";
  import AvatarCapabilitiesModal from "../components/AvatarCapabilitiesModal.svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { TOUR_SEED_NOTICE, openSeededChat, startChatWith } from "../lib/chat";
  import { loadAvatars } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import {
    accessReady as isAccessReady,
    knowledgeReady as isKnowledgeReady,
    profileReady as isProfileReady,
  } from "../lib/setupReadiness";
  import { appState, notify, updateState } from "../lib/state";
  import type { AvatarSummary } from "../lib/types";
  import type { TourSlug } from "../../../shared/tourScenarios";

  let loading = true;
  let error = "";
  let loadingAvatarId: string | null = null;
  let searchInput: HTMLInputElement | null = null;
  /** The avatar whose 소개 dialog is open (intro + 역량), or null when closed. */
  let introAvatar: AvatarSummary | null = null;

  onMount(() => {
    void load();
  });

  async function load(force = false): Promise<void> {
    loading = true;
    error = "";
    try {
      await loadAvatars(force);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  $: displayQuery = ($appState.exploreQuery || "").trim();
  $: query = displayQuery.toLowerCase();
  $: tokens = query ? query.split(/\s+/).map((item) => item.replace(/^#+/, "")).filter(Boolean) : [];
  $: sorted = [...$appState.avatars].sort((a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""));
  $: avatars = tokens.length ? sorted.filter((av) => matches(av, tokens)) : sorted;
  // Shared with the welcome modal's quick steps — see lib/setupReadiness.ts for
  // the superset rule the two used to disagree on.
  $: profileReady = isProfileReady($appState.user);
  $: knowledgeReady = isKnowledgeReady($appState.user);
  $: accessReady = isAccessReady($appState.user);
  // 아바타는 같은 그룹원에게만 보이므로, 그룹이 없는 사용자에게는 자기 아바타(와 외부
  // Agent)만 남습니다. 빈 목록처럼 보이는 이유를 카드 아래에서 설명해 줍니다.
  $: hasPeerAvatars = $appState.avatars.some((av) => av.id !== $appState.user?.id && av.runtime !== "external");
  const GROUP_HINT = "그룹에 소속되면 동료의 아바타가 여기에 보여요. 그룹 참여는 관리자에게 문의하세요.";

  function rank(av: AvatarSummary) {
    if (av.id === $appState.user?.id) return 0;
    // Group shared agents sort with same-group teammates (both are group-scoped).
    if (av.sharesGroup || av.groupAgent) return 1;
    return 2;
  }

  function matches(av: AvatarSummary, parts: string[]) {
    const hay = [av.displayName, av.alias, av.username, av.bio, ...(av.hashtags || [])].filter(Boolean).join(" ").toLowerCase();
    return parts.every((part) => hay.includes(part));
  }

  // ---- 시작하기 checklist -------------------------------------------------
  // The card detects its own progress instead of asking the owner to remember
  // what they did: every item reads the same state the avatar acts on, and the
  // card removes itself at 4/4 without a dismissal being stored.

  interface SetupItem {
    key: string;
    label: string;
    /** Shown while incomplete; a 완료 item always renders the check instead. */
    icon: string;
    done: boolean;
    run: () => void;
  }

  let setupBannerDismissed = false;

  /**
   * 첫 스킬 = "does my knowledge repo hold at least one skill". `null` means the
   * question is still unanswered, which is NOT the same as "no" — see the
   * visibility rule below.
   *
   * `/api/skill-share/mine` is the only endpoint that answers exactly this: it
   * lists the owner's own `skills/<slug>` dirs. `/api/avatars/:id/skills` (the
   * slash menu's source) mixes bundled "default" and plugin skills into one
   * list, and separating out the repo ones needs the server's Korean source
   * label — a constant `tsconfig.client.json` does not expose to the client, so
   * using it would mean a new hand-mirror. It is also the heavier call: it
   * syncs every enabled plugin repo on top of the same knowledge-repo refresh.
   */
  let ownSkillCount: number | null = null;
  /** One request per mount, settled or failed. */
  let skillProbeStarted = false;

  async function probeOwnSkills(): Promise<void> {
    if (skillProbeStarted) return;
    skillProbeStarted = true;
    try {
      const result = await api<{ repoConfigured: boolean; skills: unknown[] }>("/api/skill-share/mine");
      ownSkillCount = result.repoConfigured ? (result.skills?.length ?? 0) : 0;
    } catch {
      // Fail CLOSED: a failed probe must not tick the item off. Marking it done
      // on an error could push the card to 4/4 and hide setup the owner has not
      // actually finished — the opposite of what the card exists for.
      ownSkillCount = 0;
    }
  }

  /** Dismissed earlier this session — returns next session, which is intended. */
  function dismissedInStorage(): boolean {
    try {
      return sessionStorage.getItem("setupBannerDismissed") === "1";
    } catch {
      return false;
    }
  }

  function dismissSetupBanner() {
    try {
      sessionStorage.setItem("setupBannerDismissed", "1");
    } catch {
      /* ignore */
    }
    setupBannerDismissed = true;
  }

  /** Seed "/tour <slug>" the way the welcome modal does — the server expands it. */
  async function seedTour(slug: TourSlug): Promise<void> {
    try {
      await openSeededChat(`/tour ${slug}`, TOUR_SEED_NOTICE);
    } catch (err) {
      notify(`체험 시나리오를 열지 못했습니다: ${(err as Error).message}`, "warn");
    }
  }

  $: dismissedThisSession = setupBannerDismissed || dismissedInStorage();
  // Lazy: only an owner who still has the card AND already has a repo can have
  // own skills, so nobody else pays for a request that refreshes their clone.
  $: if ($appState.user && !dismissedThisSession && knowledgeReady) void probeOwnSkills();

  $: setupItems = [
    {
      key: "profile",
      label: "프로필",
      icon: "user",
      done: profileReady,
      run: () => goView("settings", "profile"),
    },
    {
      // The capture tour's first step creates or connects the repo with the
      // avatar's own tools, so an unconfigured owner belongs IN it, not in a
      // settings form.
      key: "knowledge",
      label: "지식 저장소",
      icon: "book",
      done: knowledgeReady,
      run: () => void seedTour("capture"),
    },
    {
      // Tokens and SSH keys genuinely need the owner's hands — no tour can
      // paste a credential for them.
      key: "access",
      label: "권한 연결",
      icon: "key",
      done: accessReady,
      run: () => goView("settings", "access"),
    },
    {
      key: "skill",
      label: "첫 스킬",
      icon: "sparkles",
      done: (ownSkillCount ?? 0) > 0,
      run: () => void seedTour("skill"),
    },
  ] satisfies SetupItem[];
  $: completedCount = setupItems.filter((item) => item.done).length;
  $: firstIncomplete = setupItems.find((item) => !item.done) ?? null;
  $: showSetupBanner =
    Boolean($appState.user) &&
    !dismissedThisSession &&
    completedCount < setupItems.length &&
    // The skill answer only DECIDES visibility for an owner whose other three
    // are already done; painting the card before it lands would flash a setup
    // prompt at someone who finished setup long ago.
    !(ownSkillCount === null && profileReady && knowledgeReady && accessReady);
  $: resultStatus = loading
    ? "아바타 목록을 불러오는 중입니다."
    : error
      ? `아바타 목록을 불러오지 못했습니다: ${error}`
      : !$appState.avatars.length
        ? "같은 그룹의 아바타가 아직 없습니다."
        : !avatars.length
          ? `${displayQuery} 검색 결과가 없습니다.`
          : displayQuery
            ? `${displayQuery} 검색 결과 ${avatars.length}개가 있습니다.`
            : `아바타 ${avatars.length}개가 있습니다.`;

  async function openChat(av: AvatarSummary) {
    if (loadingAvatarId) return;
    loadingAvatarId = av.id;
    try {
      await startChatWith(av);
    } catch (err) {
      notify(`대화를 시작하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      loadingAvatarId = null;
    }
  }

  function clearSearch() {
    updateState((state) => (state.exploreQuery = ""));
    searchInput?.focus();
  }
</script>

<header class="view-header">
  <div>
    <h1>탐색</h1>
    <p>같은 그룹의 아바타와 대화를 시작하세요</p>
  </div>
</header>

<div class="view-body scroll-thin" aria-busy={loading}>
  {#if showSetupBanner}
    <div class="setup-banner">
      <div class="sb-copy">
        <strong>아바타 시작하기 · {completedCount}/{setupItems.length} 완료</strong>
        <span>끝낸 항목은 자동으로 체크됩니다. 남은 항목을 누르면 이어서 준비할 수 있어요.</span>
      </div>
      <div class="setup-steps" aria-label="아바타 시작하기 진행 상태">
        {#each setupItems as item (item.key)}
          <button class="setup-step" class:done={item.done} type="button" aria-label={`${item.label} ${item.done ? "완료" : "필요"}`} on:click={item.run}>
            <Icon name={item.done ? "check" : item.icon} />
            <span>{item.label}</span>
          </button>
        {/each}
      </div>
      <div class="sb-actions">
        <button class="primary small" type="button" on:click={() => firstIncomplete?.run()}>이어서 설정</button>
        <button class="linkish small" type="button" on:click={dismissSetupBanner}>닫기</button>
      </div>
    </div>
  {/if}

  <div class="explore-search-bar">
    <Icon name="compass" />
    <input
      id="explore-search"
      class="explore-search"
      type="search"
      placeholder="이름·해시태그로 검색 (예: #코드리뷰)"
      aria-label="아바타 검색"
      aria-describedby="explore-results-status"
      bind:this={searchInput}
      value={$appState.exploreQuery}
      on:input={(event) => updateState((state) => (state.exploreQuery = event.currentTarget.value))}
    />
    {#if displayQuery}
      <button class="msg-act explore-search-clear" type="button" aria-label="검색어 지우기" title="검색어 지우기" on:click={clearSearch}>
        <Icon name="close" />
      </button>
    {/if}
  </div>
  <div class="sr-only" id="explore-results-status" role="status" aria-live="polite">{resultStatus}</div>

  {#if loading}
    <div class="muted pad" role="status">불러오는 중…</div>
  {:else if error}
    <div class="warn-box" role="alert">
      아바타 목록을 불러오지 못했습니다: {error}
      <button class="linkish" type="button" disabled={loading} on:click={() => load(true)}>다시 시도</button>
    </div>
  {:else if !$appState.avatars.length}
    <div class="empty-note">
      같은 그룹의 아바타가 아직 없습니다.
      {GROUP_HINT}
      <button class="linkish small" type="button" on:click={() => goView("settings", "profile")}>내 아바타 공개 범위 설정</button>
    </div>
  {:else if !avatars.length}
    <div class="empty-note">
      "{displayQuery}"에 맞는 아바타가 없습니다.
      <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
    </div>
  {:else}
    <div class="avatar-grid" aria-label={displayQuery ? `${displayQuery} 검색 결과` : "아바타 목록"}>
      {#each avatars as av (av.id)}
        <!-- The card itself is one big button (click = start chat), so 소개 보기 has to
             be a SIBLING control — buttons can't nest. The wrapper is the grid item;
             the card fills it so the grid sizing and the hover ::after arrow are
             unchanged. -->
        <div class="avatar-card-wrap">
          <button
            class="avatar-card"
            class:opening={loadingAvatarId === av.id}
            type="button"
            aria-label={`${av.alias || av.displayName} 아바타와 대화${loadingAvatarId === av.id ? ", 여는 중" : ""}`}
            title={`${av.alias || av.displayName} 아바타와 대화`}
            aria-busy={loadingAvatarId === av.id}
            disabled={Boolean(loadingAvatarId)}
            on:click={() => openChat(av)}
          >
            <AvatarImage user={av} size={56} alt="" />
            <div class="ac-body">
              <div class="ac-name">
                <strong>{av.displayName}</strong>
                {#if av.id === $appState.user?.id}
                  <span class="tag accent">나</span>
                {:else if av.runtime === "external"}
                  <span class="tag accent">외부 아바타</span>
                {:else if av.groupAgent}
                  <span class="tag write">그룹 에이전트 · {av.groupAgent.groupName}</span>
                {:else if av.sharesGroup}
                  <span class="tag write">같은 그룹</span>
                {/if}
                {#if av.visibility === "private"}
                  <span class="tag">비공개</span>
                {/if}
              </div>
              <div class="ac-handle">{loadingAvatarId === av.id ? "대화 여는 중…" : `@${av.username}`}</div>
              {#if av.alias}<div class="ac-alias">"{av.alias}"</div>{/if}
              {#if av.bio}<p class="ac-bio">{av.bio}</p>{/if}
              <div class="ac-tags">
                {#each (av.hashtags || []).slice(0, 6) as tag}
                  <span class="tag accent">#{tag}</span>
                {/each}
                {#if av.runtime !== "external" && av.pluginCount != null}
                  <span class="tag">플러그인 {av.pluginCount}개</span>
                {/if}
              </div>
            </div>
          </button>
          <!-- Stays enabled while a chat is opening: reading the intro is harmless. -->
          <button
            class="ac-intro"
            type="button"
            aria-label={`${av.alias || av.displayName} 소개 보기`}
            title={`${av.alias || av.displayName} 소개 보기`}
            on:click={() => (introAvatar = av)}
          >소개</button>
        </div>
      {/each}
      {#if !hasPeerAvatars && !displayQuery}
        <div class="empty-note">{GROUP_HINT}</div>
      {/if}
    </div>
  {/if}
</div>

{#if introAvatar}
  <AvatarCapabilitiesModal avatar={introAvatar} on:close={() => (introAvatar = null)} />
{/if}
