<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { addConversationToSplit, clearChatHistory, newChat, selectConversation, startNewChat } from "../lib/chat";
  import { timeLabel } from "../lib/format";
  import { loadConversations, stopKnowledgeWatch } from "../lib/loaders";
  import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";
  import { goView } from "../lib/nav";
  import { trapTab } from "../lib/modalBehavior";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { setThemePref } from "../lib/theme";
  import type { ThemePref } from "../lib/theme";
  import type { ConversationSummary, User, ViewName } from "../lib/types";

  export let user: User;
  export let view: ViewName;
  export let streaming = false;
  export let unreadCount = 0;
  export let themePref: ThemePref = "system";
  export let railCollapsed = false;
  export let onRailCollapsedChange: (collapsed: boolean) => void = () => {};
  export let onMobileRailOpenChange: (open: boolean) => void = () => {};

  let railOpen = false;
  let railElement: HTMLElement | undefined;
  let railToggle: HTMLButtonElement | undefined;
  let railDismiss: HTMLButtonElement | undefined;
  let railBackdrop: HTMLButtonElement | undefined;
  let railSpringing = false;
  let cancelRailSpring: () => void = () => {};
  const desktopRailMedia =
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 861px)") : null;
  let desktopRail = desktopRailMedia?.matches ?? true;
  let conversationQuery = "";
  let conversationSearchInput: HTMLInputElement | undefined;
  let conversationsLoading = false;
  let conversationsError = "";
  let renamingId = "";
  let renameValue = "";
  let renameError = "";
  let renameInput: HTMLInputElement | undefined;
  let renamingBusyId = "";
  let busyConversationIds = new Set<string>();
  let clearingConversations = false;
  let logoutBusy = false;

  const nav = [
    { view: "explore", label: "탐색", icon: "compass" },
    { view: "chat", label: "대화", icon: "chat" },
    // 봇 오피스 rides the same admin gate as the 내 봇 feature it opens (phase 1),
    // filtered into `visibleNav` below rather than rendered unconditionally.
    { view: "bots", label: "봇 오피스", icon: "activity" },
    { view: "brain", label: "지식 그래프", icon: "network" },
    { view: "inbox", label: "알림", icon: "bell" },
    { view: "routines", label: "예약 작업", icon: "clock" },
    { view: "groups", label: "그룹", icon: "users" },
    { view: "skills", label: "스킬 배우기", icon: "sparkles" },
    { view: "settings", label: "내 아바타", icon: "user" },
  ] as const;

  const themeLabels: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };
  const themeIcons: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };
  const themeOrder: ThemePref[] = ["system", "light", "dark"];

  $: themeLabel = `테마: ${themeLabels[themePref]}`;
  $: themeIcon = themeIcons[themePref];
  $: activeConversationId =
    $appState.chatPanes.find((pane) => pane.id === $appState.activePaneId)?.conversationId ?? null;
  $: conversationTokens = conversationQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  $: railConversations = $appState.conversations
    .filter((conversation) => !conversation.isRoutine)
    .filter((conversation) => {
      if (!conversationTokens.length) return true;
      const hay = [conversation.title, conversation.avatarDisplayName].filter(Boolean).join(" ").toLowerCase();
      return conversationTokens.every((token) => hay.includes(token));
    });
  $: chatConversationCount = $appState.conversations.filter((conversation) => !conversation.isRoutine).length;
  // 봇 오피스 badge: settled bot work the owner hasn't looked at (done/실패/입력
  // 대기), summed across every bot. Derived at the top level and NAMED in the
  // markup — a legacy-mode template expression tracks only what the markup
  // itself reads, so reading this inside a helper would freeze the count.
  // Three digits would push the nav label around, so it caps at 99+.
  $: botUnseenCount = $appState.botTaskUnseen.total;
  $: botUnseenLabel = botUnseenCount > 99 ? "99+" : String(botUnseenCount);
  $: conversationResultStatus = conversationsLoading
    ? "대화 목록을 불러오는 중입니다."
    : conversationsError
      ? "대화 목록을 불러오지 못했습니다."
      : conversationQuery.trim()
        ? `검색 결과 ${railConversations.length}개, 전체 대화 ${chatConversationCount}개입니다.`
        : `저장된 대화 ${chatConversationCount}개입니다.`;

  onMount(() => {
    void refreshConversations();
    const syncRailLayout = (event: MediaQueryListEvent) => {
      desktopRail = event.matches;
      if (desktopRail && railOpen) {
        cancelRailAnimation();
        clearRailVisual();
        setRailOpen(false);
      }
    };
    desktopRailMedia?.addEventListener?.("change", syncRailLayout);
    return () => {
      desktopRailMedia?.removeEventListener?.("change", syncRailLayout);
      if (railOpen) onMobileRailOpenChange(false);
    };
  });

  async function refreshConversations() {
    conversationsLoading = true;
    conversationsError = "";
    try {
      await loadConversations();
    } catch (err) {
      conversationsError = (err as Error).message;
    } finally {
      conversationsLoading = false;
    }
  }

  async function logout() {
    if (logoutBusy) return;
    logoutBusy = true;
    stopKnowledgeWatch();
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
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
    history.replaceState(null, "", location.pathname);
  }

  function setConversationBusy(id: string, on: boolean) {
    const next = new Set(busyConversationIds);
    if (on) next.add(id);
    else next.delete(id);
    busyConversationIds = next;
  }

  function isConversationBusy(id: string): boolean {
    return busyConversationIds.has(id) || renamingBusyId === id;
  }

  function isConversationStreaming(id: string): boolean {
    return $appState.chatPanes.some((pane) => pane.conversationId === id && pane.streaming);
  }

  // Live-run badge text from the last conversation-list load ("" = idle). The two
  // states carry their OWN wording, not just their own dot colour.
  function activeRunLabel(conversation: ConversationSummary): string {
    if (!conversation.activeRun) return "";
    return conversation.activeRun.background ? "백그라운드 작업 중" : "응답 생성 중";
  }

  function conversationDomId(id: string, suffix: string): string {
    return `conversation-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${suffix}`;
  }

  function startRename(conversation: ConversationSummary, event: MouseEvent) {
    event.stopPropagation();
    if (isConversationBusy(conversation.id)) return;
    renamingId = conversation.id;
    renameValue = conversation.title || "";
    renameError = "";
  }

  function cancelRename() {
    if (renamingBusyId) return;
    renamingId = "";
    renameValue = "";
    renameError = "";
  }

  async function commitRename(conversation: ConversationSummary) {
    if (renamingBusyId === conversation.id) return;
    const title = renameValue.trim();
    if (!title || title === conversation.title) {
      cancelRename();
      return;
    }
    renamingBusyId = conversation.id;
    renameError = "";
    try {
      const { conversation: updated } = await api<{ conversation: ConversationSummary }>(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      updateState((state) => {
        const target = state.conversations.find((c) => c.id === conversation.id);
        if (target) target.title = updated?.title || title;
      });
      notify("대화 이름을 변경했습니다.", "ok");
      renamingId = "";
      renameValue = "";
    } catch (err) {
      renameError = (err as Error).message;
      notify(`이름 변경 실패: ${renameError}`, "warn");
      queueMicrotask(() => renameInput?.focus());
    } finally {
      renamingBusyId = "";
    }
  }

  async function deleteConversation(conversation: ConversationSummary, event: MouseEvent) {
    event.stopPropagation();
    if (isConversationBusy(conversation.id)) return;
    if ($appState.chatPanes.some((pane) => pane.conversationId === conversation.id && pane.streaming)) {
      notify("응답 중인 대화는 삭제할 수 없습니다. 먼저 응답을 중지해 주세요.", "warn");
      return;
    }
    const title = conversation.title || "새 대화";
    if (!(await confirmAction(`"${title}" 대화를 삭제할까요? 삭제하면 되돌릴 수 없습니다.`))) return;
    setConversationBusy(conversation.id, true);
    try {
      await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" });
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
      setConversationBusy(conversation.id, false);
      return;
    }
    const openPane = $appState.chatPanes.find((pane) => pane.conversationId === conversation.id);
    updateState((state) => {
      state.conversations = state.conversations.filter((c) => c.id !== conversation.id);
    });
    if (openPane) newChat(openPane.id);
    notify(`"${title}" 대화를 삭제했습니다.`, "ok");
    setConversationBusy(conversation.id, false);
  }

  async function clearConversations() {
    if (clearingConversations || !chatConversationCount) return;
    if ($appState.chatPanes.some((pane) => pane.streaming)) {
      notify("응답 중인 대화가 있습니다. 먼저 응답을 중지해 주세요.", "warn");
      return;
    }
    // The visible button says 비우기, so the confirm, the toast and the
    // aria-label all say 비우기 too — a screen-reader user must hear the same
    // verb the button shows.
    const confirmed = await confirmAction("저장된 모든 일반 대화 기록을 비울까요? 비우면 되돌릴 수 없습니다.", {
      title: "대화 기록을 비울까요?",
      confirmLabel: "비우기",
      tone: "danger",
    });
    if (!confirmed) return;
    clearingConversations = true;
    try {
      const deleted = await clearChatHistory();
      notify(deleted ? `${deleted}개의 대화를 비웠습니다.` : "비울 대화가 없습니다.", "ok");
    } catch (err) {
      notify(`전체 비우기 실패: ${(err as Error).message}`, "warn");
    } finally {
      clearingConversations = false;
    }
  }

  function setRailOpen(open: boolean) {
    if (railOpen === open) return;
    railOpen = open;
    onMobileRailOpenChange(open);
  }

  function cancelRailAnimation(): void {
    cancelRailSpring();
    cancelRailSpring = () => {};
    railSpringing = false;
  }

  function railWidth(): number {
    return Math.max(1, railElement?.getBoundingClientRect().width ?? 320);
  }

  function canAnimateRail(): boolean {
    return !prefersReducedMotion() && (railElement?.getBoundingClientRect().width ?? 0) > 0;
  }

  function currentRailX(): number {
    if (!railElement) return 0;
    const transform = getComputedStyle(railElement).transform;
    if (!transform || transform === "none") return 0;
    try {
      return new DOMMatrixReadOnly(transform).m41;
    } catch {
      return 0;
    }
  }

  function setRailVisual(x: number): void {
    if (!railElement) return;
    const width = railWidth();
    const progress = Math.max(0, Math.min(1, 1 + x / width));
    railElement.style.transform = `translate3d(${x}px, 0, 0)`;
    railElement.style.visibility = "visible";
    if (railBackdrop) {
      railBackdrop.style.opacity = String(progress);
      railBackdrop.style.pointerEvents = progress > 0.02 ? "auto" : "none";
    }
  }

  function clearRailVisual(): void {
    railElement?.style.removeProperty("transform");
    railElement?.style.removeProperty("visibility");
    railBackdrop?.style.removeProperty("opacity");
    railBackdrop?.style.removeProperty("pointer-events");
    railSpringing = false;
  }

  function springRail(from: number, target: number, initialVelocity: number, complete: () => void): void {
    cancelRailAnimation();
    railSpringing = true;
    cancelRailSpring = springValue({
      from,
      to: target,
      velocity: initialVelocity,
      response: 0.3,
      dampingRatio: Math.abs(initialVelocity) > 120 ? 0.86 : 1,
      onUpdate: setRailVisual,
      onComplete: () => {
        cancelRailSpring = () => {};
        complete();
      },
    });
  }

  function finishRailClose(restoreFocus: boolean): void {
    setRailOpen(false);
    queueMicrotask(clearRailVisual);
    if (restoreFocus) requestAnimationFrame(() => railToggle?.focus());
  }

  function closeRail(restoreFocus = false) {
    if (desktopRail || !railOpen || !canAnimateRail()) {
      cancelRailAnimation();
      setRailOpen(false);
      clearRailVisual();
      if (restoreFocus) requestAnimationFrame(() => railToggle?.focus());
      return;
    }
    const from = currentRailX();
    springRail(from, -railWidth(), 0, () => finishRailClose(restoreFocus));
  }

  function openRail() {
    if (desktopRail) {
      onRailCollapsedChange(false);
      requestAnimationFrame(() => railDismiss?.focus());
      return;
    }
    if (railOpen) return;
    railSpringing = true;
    setRailOpen(true);
    requestAnimationFrame(() => {
      if (!canAnimateRail()) {
        clearRailVisual();
        railDismiss?.focus();
        return;
      }
      const from = -railWidth();
      setRailVisual(from);
      springRail(from, 0, 0, () => {
        clearRailVisual();
        railDismiss?.focus();
      });
    });
  }

  function startRailDrag(event: PointerEvent): void {
    if (desktopRail || !railOpen || !railElement) return;
    event.preventDefault();
    event.stopPropagation();
    cancelRailAnimation();
    railSpringing = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const width = railWidth();
    const startPointer = event.clientX;
    const startPosition = currentRailX();
    let position = startPosition;
    let velocity = 0;
    let lastPosition = position;
    let lastTime = event.timeStamp;

    const onMove = (move: PointerEvent) => {
      const raw = startPosition + move.clientX - startPointer;
      position = raw > 0 ? rubberband(raw, width) : raw < -width ? -width + rubberband(raw + width, width) : raw;
      const dt = Math.max(1, move.timeStamp - lastTime) / 1000;
      const instantVelocity = (position - lastPosition) / dt;
      velocity = velocity * 0.65 + instantVelocity * 0.35;
      lastPosition = position;
      lastTime = move.timeStamp;
      setRailVisual(position);
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onUp = () => {
      cleanup();
      const projectedPosition = project(position, velocity);
      const shouldClose = projectedPosition < -width * 0.5 || velocity < -520;
      const target = shouldClose ? -width : 0;
      springRail(position, target, velocity, () => {
        if (shouldClose) finishRailClose(true);
        else clearRailVisual();
      });
    };
    const onCancel = () => {
      cleanup();
      springRail(position, 0, 0, clearRailVisual);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  function startRailEdgeDrag(event: PointerEvent): void {
    if (desktopRail || railOpen || !railElement) return;
    event.preventDefault();
    cancelRailAnimation();
    setRailOpen(true);
    railSpringing = true;
    const width = railWidth();
    const startPointer = event.clientX;
    let position = -width;
    let velocity = 0;
    let lastPosition = position;
    let lastTime = event.timeStamp;
    setRailVisual(position);

    const onMove = (move: PointerEvent) => {
      const raw = -width + Math.max(0, move.clientX - startPointer);
      position = raw > 0 ? rubberband(raw, width) : raw;
      const dt = Math.max(1, move.timeStamp - lastTime) / 1000;
      velocity = velocity * 0.65 + ((position - lastPosition) / dt) * 0.35;
      lastPosition = position;
      lastTime = move.timeStamp;
      setRailVisual(position);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onUp = () => {
      cleanup();
      const shouldOpen = project(position, velocity) > -width * 0.5 || velocity > 520;
      springRail(position, shouldOpen ? 0 : -width, velocity, () => {
        if (shouldOpen) {
          clearRailVisual();
          railDismiss?.focus();
        } else {
          finishRailClose(false);
        }
      });
    };
    const onCancel = () => {
      cleanup();
      springRail(position, -width, 0, () => finishRailClose(false));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  function dismissRail() {
    if (desktopRail) onRailCollapsedChange(true);
    else closeRail(true);
    if (desktopRail) requestAnimationFrame(() => railToggle?.focus());
  }

  function navigate(viewName: ViewName) {
    goView(viewName);
    closeRail();
  }

  async function openConversation(conversation: ConversationSummary) {
    if (isConversationBusy(conversation.id)) return;
    setConversationBusy(conversation.id, true);
    try {
      await selectConversation(conversation.id);
      closeRail();
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setConversationBusy(conversation.id, false);
    }
  }

  function conversationTitle(conversation: ConversationSummary) {
    return conversation.title || conversation.avatarDisplayName || "제목 없는 대화";
  }

  function clearConversationSearch(): void {
    conversationQuery = "";
    conversationSearchInput?.focus();
  }

  // Drag a conversation onto the chat workbench to add it as a split pane. The
  // chat-id MIME lets the drop zone (ChatView) accept only our payload.
  const CONV_DND_MIME = "application/x-noah-conversation";
  function onConvDragStart(event: DragEvent, conversation: ConversationSummary) {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(CONV_DND_MIME, conversation.id);
    event.dataTransfer.setData("text/plain", conversationTitle(conversation));
    event.dataTransfer.effectAllowed = "copy";
  }

  // Touch/keyboard-friendly alternative to dragging: add directly to the split.
  async function addToSplit(conversation: ConversationSummary, event: Event) {
    event.stopPropagation();
    if (isConversationBusy(conversation.id)) return;
    setConversationBusy(conversation.id, true);
    try {
      await addConversationToSplit(conversation.id);
      closeRail();
    } catch (err) {
      notify(`분할에 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setConversationBusy(conversation.id, false);
    }
  }

  $: paneCount = $appState.chatPanes.length;

  function pickTheme(value: ThemePref) {
    setThemePref(value);
    replaceState({ themePref: value });
    notify(`테마: ${themeLabels[value]}`, "info");
  }

  function cycleTheme() {
    const next = themeOrder[(themeOrder.indexOf(themePref) + 1) % themeOrder.length];
    pickTheme(next);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!desktopRail && railOpen && event.key === "Escape") {
      event.preventDefault();
      dismissRail();
      return;
    }
    if (!desktopRail && railOpen && event.key === "Tab") {
      // Shared trap (also applies the aria-hidden/display/visibility + tabindex=-1
      // filtering the hand-rolled copy lacked).
      trapTab(event, railElement);
    }
  }

  $: railExpanded = desktopRail ? !railCollapsed : railOpen;

  // ---- Admin presence badge (rail footer) ----------------------------------
  // Deliberately the smallest possible surface: one line that expands in place.
  // The count excludes the viewer, so "접속 2" means two OTHER people are here.
  let presenceOpen = false;
  $: isAdmin = Boolean(user.roles?.includes("admin"));
  // Derived here (not filtered inline in the markup): a legacy-mode template
  // expression tracks only what the MARKUP names, so `isAdmin` read inside an
  // inline callback would leave the list frozen at its first value.
  $: visibleNav = nav.filter((item) => item.view !== "bots" || isAdmin);
  $: presentOthers = ($appState.adminPresence?.users ?? []).filter((u) => u.id !== user.id);
  // Server-owned window, rendered in whole hours once it reaches one — "최근 60분"
  // is not how anyone says it.
  $: presenceWindow = (() => {
    const minutes = $appState.adminPresence?.windowMinutes ?? 60;
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
  })();

  // Minute-granularity only — the window is a few minutes wide, so anything
  // finer would just flicker.
  function presenceAge(iso: string): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return minutes < 1 ? "방금" : `${minutes}분 전`;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if !desktopRail && !railOpen}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="rail-edge-swipe" aria-hidden="true" on:pointerdown={startRailEdgeDrag}></div>
{/if}

<button
  bind:this={railToggle}
  class="icon-button rail-toggle svelte-rail-toggle"
  type="button"
  aria-label="메뉴 열기"
  aria-controls="rail"
  aria-expanded={railExpanded ? "true" : "false"}
  inert={railOpen && !desktopRail}
  title="메뉴"
  on:click={openRail}
>
  <Icon name="menu" />
</button>

<aside
  bind:this={railElement}
  class="rail"
  class:open={railOpen}
  class:rail-springing={railSpringing}
  id="rail"
  aria-label="대화 목록"
  aria-hidden={railExpanded ? undefined : "true"}
  inert={!railExpanded}
>
  <button class="rail-grabber" type="button" aria-label="메뉴를 왼쪽으로 끌어 닫기" on:pointerdown={startRailDrag}>
    <span aria-hidden="true"></span>
  </button>
  <div class="rail-head">
    <div class="rail-brand-row">
      <button class="rail-brand" type="button" title="홈으로 이동" on:click={() => navigate("explore")}>
        <img class="mark" src="/icon-192.png" alt="" aria-hidden="true" width="34" height="34" />
        <span>
          <span class="name">Noah Almighty</span>
        </span>
      </button>
      <button
        bind:this={railDismiss}
        class="icon-button rail-dismiss"
        type="button"
        aria-label={desktopRail ? "왼쪽 메뉴 접기" : "메뉴 닫기"}
        aria-controls="rail"
        title={desktopRail ? "왼쪽 메뉴 접기" : "메뉴 닫기"}
        on:click={dismissRail}
      >
        <Icon name={desktopRail ? "panel-left-close" : "close"} size={18} />
      </button>
    </div>

    <nav class="rail-nav" aria-label="주 메뉴">
      {#each visibleNav as item}
        <button
          class="nav-item"
          type="button"
          class:active={view === item.view}
          aria-current={view === item.view ? "page" : undefined}
          on:click={() => navigate(item.view)}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
          {#if item.view === "inbox" && unreadCount > 0}
            <span class="nav-badge">{unreadCount}</span>
          {:else if item.view === "bots" && botUnseenCount > 0}
            <!-- A bare number next to a label doesn't say WHAT it counts: the
                 hover title and the screen-reader text both spell it out, and
                 the visible chip keeps the capped digits. -->
            <span class="nav-badge" title={`확인하지 않은 봇 작업 결과 ${botUnseenCount}건`}>
              <span aria-hidden="true">{botUnseenLabel}</span>
              <span class="sr-only">확인하지 않은 봇 작업 결과 {botUnseenCount}건</span>
            </span>
          {/if}
        </button>
      {/each}

      {#if isAdmin}
        <button class="nav-item" type="button" class:active={view === "admin"} aria-current={view === "admin" ? "page" : undefined} on:click={() => navigate("admin")}>
          <Icon name="shield" />
          <span>관리자</span>
        </button>
      {/if}
    </nav>

    <button
      class="new-chat"
      type="button"
      title="현재 아바타와 새 대화를 시작합니다 (대화가 없으면 내 아바타)"
      on:click={() => {
        void startNewChat();
        closeRail();
      }}
    >
      <Icon name="plus" />
      <span>새 대화</span>
    </button>
  </div>

  <div class="rail-history">
    <div class="rail-section-row">
      <div class="rail-section-label">내 대화 <span class="rail-section-count">{chatConversationCount}</span></div>
      <button
        class="rail-clear-history"
        type="button"
        aria-label="모든 일반 대화 비우기"
        title="모든 일반 대화 비우기"
        disabled={conversationsLoading || clearingConversations || chatConversationCount === 0}
        on:click={clearConversations}
      >
        <Icon name="trash" size={13} />
        <span>{clearingConversations ? "비우는 중…" : "비우기"}</span>
      </button>
    </div>
    <div class="conv-list-wrap">
      <div class="conv-search-wrap">
        <input
          bind:this={conversationSearchInput}
          class="conv-search"
          type="search"
          placeholder={conversationsLoading ? "대화 불러오는 중" : "대화 검색"}
          aria-label="대화 검색"
          aria-controls="rail-conversation-list"
          aria-describedby="rail-conversation-status"
          disabled={conversationsLoading}
          bind:value={conversationQuery}
        />
        {#if conversationQuery}
          <button
            class="conv-search-clear"
            type="button"
            aria-label="대화 검색어 지우기"
            title="검색어 지우기"
            on:click={clearConversationSearch}
          ><Icon name="close" size={14} /></button>
        {/if}
      </div>
      <div id="rail-conversation-status" class="sr-only" role="status" aria-live="polite">{conversationResultStatus}</div>
      <div
        id="rail-conversation-list"
        class="conv-list scroll-thin"
        role={!conversationsLoading && !conversationsError && railConversations.length ? "list" : undefined}
        aria-label={!conversationsLoading && !conversationsError && railConversations.length ? "내 대화 목록" : undefined}
      >
        {#if conversationsLoading}
          <div class="conv-empty" role="status">불러오는 중…</div>
        {:else if conversationsError}
          <div class="conv-empty" role="alert">
            대화를 불러오지 못했습니다.
            <button class="linkish small rail-retry" type="button" disabled={conversationsLoading} on:click={refreshConversations}>다시 시도</button>
          </div>
        {:else if !railConversations.length}
          <div class="conv-empty">{conversationQuery ? "검색 결과가 없습니다." : "아직 저장된 대화가 없습니다."}</div>
        {:else}
          {#each railConversations as conversation (conversation.id)}
            {@const liveLabel = activeRunLabel(conversation)}
            {@const openLabel = liveLabel
              ? `대화 열기: ${conversationTitle(conversation)} · ${liveLabel}`
              : `대화 열기: ${conversationTitle(conversation)}`}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="conv-item"
              class:active={conversation.id === activeConversationId}
              class:editing={renamingId === conversation.id}
              class:busy={isConversationBusy(conversation.id)}
              aria-busy={isConversationBusy(conversation.id) ? "true" : "false"}
              role="listitem"
              draggable={renamingId !== conversation.id && !isConversationBusy(conversation.id)}
              on:dragstart={(event) => onConvDragStart(event, conversation)}
            >
              {#if renamingId === conversation.id}
                <div class="conv-edit-wrap">
                  <!-- svelte-ignore a11y-autofocus -->
                  <input
                    class="conv-rename"
                    bind:this={renameInput}
                    bind:value={renameValue}
                    placeholder="대화 이름"
                    aria-label="대화 이름"
                    aria-describedby={conversationDomId(conversation.id, "rename-status")}
                    aria-invalid={renameError ? "true" : undefined}
                    title="Enter 저장 · Esc 취소"
                    autofocus
                    disabled={renamingBusyId === conversation.id}
                    on:click|stopPropagation
                    on:input={() => (renameError = "")}
                    on:keydown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitRename(conversation);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelRename();
                      }
                    }}
                    on:blur={() => commitRename(conversation)}
                  />
                  <span
                    id={conversationDomId(conversation.id, "rename-status")}
                    class="conv-edit-status"
                    class:invalid={Boolean(renameError)}
                    role="status"
                    aria-live="polite"
                  >{renamingBusyId === conversation.id ? "저장 중…" : renameError ? `이름 변경 실패: ${renameError}` : "Enter 저장 · Esc 취소"}</span>
                </div>
              {:else}
                <button
                  class="conv-open"
                  type="button"
                  title={openLabel}
                  aria-label={openLabel}
                  aria-current={conversation.id === activeConversationId ? "true" : undefined}
                  disabled={isConversationBusy(conversation.id)}
                  on:click={() => openConversation(conversation)}
                >
                  <span class="conv-name">{conversationTitle(conversation)}</span>
                  <span class="conv-time">{conversation.avatarDisplayName} · {timeLabel(conversation.updatedAt)}</span>
                  {#if liveLabel}
                    <!-- The run is still going with this conversation closed; the
                         button's aria-label carries the same words (its label
                         overrides this content for screen readers). -->
                    <span
                      class="conv-live"
                      data-kind={conversation.activeRun?.background ? "background" : "streaming"}
                      title={liveLabel}
                    >
                      <span class="conv-live-dot" aria-hidden="true"></span>
                      <span class="conv-live-text">{liveLabel}</span>
                    </span>
                  {/if}
                </button>
                <div class="conv-acts">
                  <button
                    class="conv-act"
                    type="button"
                    aria-label={`분할 대화에 추가: ${conversationTitle(conversation)}`}
                    title={paneCount >= 4 ? "분할 대화는 최대 4개" : "분할 대화에 추가"}
                    disabled={paneCount >= 4 || isConversationBusy(conversation.id)}
                    on:click={(event) => addToSplit(conversation, event)}
                  >
                    <Icon name="columns" size={15} />
                  </button>
                  <button
                    class="conv-act"
                    type="button"
                    aria-label={`대화 이름 바꾸기: ${conversationTitle(conversation)}`}
                    title="이름 바꾸기"
                    disabled={isConversationBusy(conversation.id)}
                    on:click={(event) => startRename(conversation, event)}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    class="conv-act danger"
                    type="button"
                    aria-label={`대화 삭제: ${conversationTitle(conversation)}`}
                    title={isConversationStreaming(conversation.id) ? "응답 중인 대화는 삭제할 수 없습니다" : "삭제"}
                    disabled={isConversationBusy(conversation.id) || isConversationStreaming(conversation.id)}
                    on:click={(event) => deleteConversation(conversation, event)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>

  <div class="rail-footer">
    {#if streaming}
      <div class="svelte-rail-streaming"><span class="spinner"></span><span>응답 중</span></div>
    {/if}
    {#if isAdmin && $appState.adminPresence}
      <div class="rail-presence">
        <button
          class="rail-presence-toggle"
          type="button"
          aria-expanded={presenceOpen}
          aria-controls="rail-presence-list"
          title={`최근 ${presenceWindow} 안에 활동한 다른 사용자 ${presentOthers.length}명 (관리자만 보입니다)`}
          on:click={() => (presenceOpen = !presenceOpen)}
        >
          <span class="rail-presence-dot" class:alone={presentOthers.length === 0} aria-hidden="true"></span>
          <span>접속 {presentOthers.length}</span>
          <Icon name={presenceOpen ? "chevron-down" : "chevron-right"} size={13} />
        </button>
        {#if presenceOpen}
          <div id="rail-presence-list" class="rail-presence-list scroll-thin">
            {#if !presentOthers.length}
              <div class="rail-presence-empty">최근 {presenceWindow} 동안 나 혼자 있었습니다.</div>
            {:else}
              {#each presentOthers as person (person.id)}
                <div class="rail-presence-item">
                  <AvatarImage user={person} size={20} />
                  <span class="rail-presence-name">{person.displayName || person.username}</span>
                  <span class="rail-presence-age">{presenceAge(person.lastSeenAt)}</span>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <div class="rail-user-row">
      <button class="rail-me" type="button" title="내 아바타 설정" on:click={() => navigate("settings")}>
        <AvatarImage user={user} size={34} />
        <span class="meta">
          <b>{user.alias || user.displayName}</b>
          <span>@{user.username}</span>
        </span>
      </button>
      <button class="icon-button" type="button" aria-label={themeLabel} title={`${themeLabel} (클릭하여 변경)`} on:click={cycleTheme}>
        <Icon name={themeIcon} />
      </button>
      <button class="icon-button" type="button" aria-label="로그아웃" title="로그아웃" disabled={logoutBusy} on:click={logout}>
      <Icon name="logout" />
      </button>
    </div>
  </div>
</aside>

<button
  bind:this={railBackdrop}
  class="rail-backdrop"
  class:open={railOpen}
  type="button"
  aria-label="메뉴 닫기"
  aria-hidden={railOpen ? undefined : "true"}
  tabindex="-1"
  on:click={() => closeRail(true)}
></button>
