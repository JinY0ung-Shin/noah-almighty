<script lang="ts">
  import { onMount } from "svelte";
  import { quartOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import type { TransitionConfig } from "svelte/transition";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { addConversationToSplit, clearChatHistory, forgetConversationWidgets, newChat, selectConversation, startNewChat } from "../lib/chat";
  import { groupConversationsByDate, localDayStart, msUntilNextLocalDay } from "../lib/conversationGroups";
  import type { ConversationGroup } from "../lib/conversationGroups";
  import { createIntentDwell, prefetchConversation, PREFETCH_DWELL_MS } from "../lib/conversationPrefetch";
  import { timeLabel } from "../lib/format";
  import { loadConversations, stopKnowledgeWatch } from "../lib/loaders";
  import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";
  import { goView } from "../lib/nav";
  import { teamBrainBadgeCount, teamBrainBadgeTitle } from "../lib/teamBrain";
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
    { view: "todos", label: "할 일", icon: "check-square" },
    { view: "brain", label: "내 브레인", icon: "network" },
    { view: "teamBrain", label: "팀 브레인", icon: "users" },
    { view: "inbox", label: "알림", icon: "bell" },
    { view: "routines", label: "예약 작업", icon: "clock" },
    { view: "skills", label: "스킬 배우기", icon: "sparkles" },
    { view: "settings", label: "내 아바타", icon: "user" },
  ] as const;

  const themeLabels: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };
  const themeIcons: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };
  const themeOrder: ThemePref[] = ["system", "light", "dark"];

  // The 할 일 badge counts what needs attention now — overdue + due today — not
  // every open item; the tooltip spells the split out.
  $: todoCounts = $appState.todos.counts;
  $: todoBadgeCount = todoCounts.overdue + todoCounts.dueToday;
  // 팀 브레인 badge: my decided-but-unseen team-brain proposals + (admins) pending reviews.
  $: teamBrainBadge = teamBrainBadgeCount($appState.teamBrainStatus);
  $: todoBadgeTitle = [todoCounts.overdue ? `마감 지남 ${todoCounts.overdue}개` : "", todoCounts.dueToday ? `오늘 마감 ${todoCounts.dueToday}개` : ""]
    .filter(Boolean)
    .join(" · ");
  $: themeLabel = `테마: ${themeLabels[themePref]}`;
  $: themeIcon = themeIcons[themePref];
  $: activeConversationId =
    $appState.chatPanes.find((pane) => pane.id === $appState.activePaneId)?.conversationId ?? null;
  $: conversationTokens = conversationQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Both steps hand back the SAME array while their inputs are the ones it was
  // built from: `$appState` re-emits on every store write (token-rate while a run
  // streams), and the list only changes when the conversations array is replaced
  // or the query is. Every writer replaces the array — never edit a row in place.
  let railFilterMemo: { source: ConversationSummary[]; tokens: string[]; list: ConversationSummary[] } | null = null;
  function filterRailConversations(source: ConversationSummary[], tokens: string[]): ConversationSummary[] {
    if (railFilterMemo && railFilterMemo.source === source && railFilterMemo.tokens === tokens) return railFilterMemo.list;
    const list = source
      .filter((conversation) => !conversation.isRoutine)
      .filter((conversation) => {
        if (!tokens.length) return true;
        const hay = [conversation.title, conversation.avatarDisplayName].filter(Boolean).join(" ").toLowerCase();
        return tokens.every((token) => hay.includes(token));
      });
    railFilterMemo = { source, tokens, list };
    return list;
  }
  $: railConversations = filterRailConversations($appState.conversations, conversationTokens);

  // Date groups (오늘 / 어제 / 지난 7일 / 지난 30일 / 그 이전). `groupNow` moves only
  // when the LOCAL DATE does (the midnight timer below, or the tab coming back),
  // so an app left open overnight regroups without a reload.
  let groupNow = Date.now();
  let groupMemo: { list: ConversationSummary[]; now: number; groups: ConversationGroup<ConversationSummary>[] } | null = null;
  function groupRailConversations(list: ConversationSummary[], now: number): ConversationGroup<ConversationSummary>[] {
    if (groupMemo && groupMemo.list === list && groupMemo.now === now) return groupMemo.groups;
    const groups = groupConversationsByDate(list, now);
    groupMemo = { list, now, groups };
    return groups;
  }
  $: conversationGroups = groupRailConversations(railConversations, groupNow);
  $: chatConversationCount = $appState.conversations.filter((conversation) => !conversation.isRoutine).length;
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
    // The date groups follow the local date: a timer for the next midnight, plus
    // a re-check whenever the tab comes back (a sleeping laptop runs no timers).
    let dayTimer: ReturnType<typeof setTimeout> | null = null;
    const followLocalDay = () => {
      const now = Date.now();
      if (localDayStart(now) !== localDayStart(groupNow)) groupNow = now;
      if (dayTimer !== null) clearTimeout(dayTimer);
      dayTimer = setTimeout(followLocalDay, msUntilNextLocalDay(now) + 50);
    };
    const onTabBack = () => {
      if (!document.hidden) followLocalDay();
    };
    followLocalDay();
    document.addEventListener("visibilitychange", onTabBack);
    window.addEventListener("focus", onTabBack);
    return () => {
      desktopRailMedia?.removeEventListener?.("change", syncRailLayout);
      if (dayTimer !== null) clearTimeout(dayTimer);
      document.removeEventListener("visibilitychange", onTabBack);
      window.removeEventListener("focus", onTabBack);
      hoverIntent.cancel();
      focusIntent.cancel();
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

  // Live-run badge text from the last conversation-list load ("" = idle).
  function activeRunLabel(conversation: ConversationSummary): string {
    return conversation.activeRun ? "응답 생성 중" : "";
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
      // A NEW array, never an in-place edit: the rail's filtered/grouped list and
      // the prefetch cache (which drops everything on a list change) both key on
      // the list's identity.
      updateState((state) => {
        state.conversations = state.conversations.map((c) =>
          c.id === conversation.id ? { ...c, title: updated?.title || title } : c,
        );
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

  // Rows the viewer just deleted ONE AT A TIME — the only rows that leave with
  // motion. A reorder, a move between date groups, a search filter and 전체 삭제
  // all stay instant: this list is core navigation. Plain Sets on purpose — the
  // gate is read when the exit STARTS, never by the markup (client.md,
  // "Conditional motion on a keyed {#each}").
  const deletedConversationIds = new Set<string>();
  // A deletion that empties its date group removes the whole group (heading
  // included). The row's own exit is local to the group's list and does not run
  // then, so the GROUP leaves the same way instead.
  const emptiedGroupIds = new Set<ConversationGroup<ConversationSummary>["id"]>();
  const NO_EXIT: TransitionConfig = { duration: 0 };

  const px = (value: string): number => Number.parseFloat(value) || 0;
  const rowGapOf = (element: Element | null): number => (element ? px(getComputedStyle(element).rowGap) : 0);

  // Fades while the height closes, so what is below rises with it instead of
  // jumping; `trailing` is the space after the node that goes away with it (the
  // list's gap). An `animate:` FLIP is deliberately not used here — the list
  // reconciles on every store write and would measure every row each time.
  function collapseOut(node: Element, trailing: number): TransitionConfig {
    const style = getComputedStyle(node);
    // A row being deleted is dimmed (`.busy`): fade from what is on screen.
    const opacity = Number.parseFloat(style.opacity);
    const from = Number.isNaN(opacity) ? 1 : opacity;
    const ownMargin = px(style.marginBottom);
    const collapse = slide(node, { duration: 200, easing: quartOut });
    return {
      ...collapse,
      // Later declarations win: fade across the whole exit (slide only fades its
      // last 5 %), and close the trailing space with the node.
      css: (t, u) => `${collapse.css?.(t, u) ?? ""}; opacity: ${t * from}; margin-bottom: ${t * ownMargin - u * trailing}px`,
    };
  }

  // Both exits are DEFERRED (return a function) so the gate is asked when the
  // node actually leaves.
  function conversationOut(node: Element, id: string) {
    return (): TransitionConfig => {
      if (!deletedConversationIds.delete(id) || prefersReducedMotion()) return NO_EXIT;
      return collapseOut(node, rowGapOf(node.parentElement));
    };
  }

  function groupOut(node: Element, id: ConversationGroup<ConversationSummary>["id"]) {
    return (): TransitionConfig => {
      if (!emptiedGroupIds.delete(id) || prefersReducedMotion()) return NO_EXIT;
      // A FIRST group hands its place to the next one, which then loses the
      // separation it had as a later group (`.conv-group + .conv-group`).
      const next = node.nextElementSibling;
      const first = !node.previousElementSibling?.classList.contains("conv-group");
      const handover = first && next?.classList.contains("conv-group") ? px(getComputedStyle(next).marginTop) : 0;
      return collapseOut(node, rowGapOf(node.parentElement) + handover);
    };
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
    // The widget values this browser kept for the conversation go with it.
    forgetConversationWidgets(conversation.id);
    const openPane = $appState.chatPanes.find((pane) => pane.conversationId === conversation.id);
    // Marked before the row is removed; forgotten shortly after in case the row
    // was not on screen (filtered out by a search) and never asked.
    deletedConversationIds.add(conversation.id);
    const group = conversationGroups.find((candidate) => candidate.items.some((item) => item.id === conversation.id));
    const emptied = group && group.items.length === 1 ? group.id : null;
    if (emptied) emptiedGroupIds.add(emptied);
    window.setTimeout(() => {
      deletedConversationIds.delete(conversation.id);
      if (emptied) emptiedGroupIds.delete(emptied);
    }, 1000);
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

  // ---- Prefetch on intent ---------------------------------------------------
  // Hover (after a short dwell), a press, or keyboard focus on a row starts the
  // SAME fetch the click would, and the click reuses it (lib/conversationPrefetch.ts
  // — which also owns every guard and invalidation). Purely an optimization: a
  // touch tap, or a click that beats the dwell, just loads as before.
  function prefetchRow(id: string): void {
    if (renamingId === id || isConversationBusy(id)) return;
    // Looked up when the dwell ENDS, so the run state is the list's current one.
    const conversation = $appState.conversations.find((item) => item.id === id);
    if (conversation) prefetchConversation(conversation);
  }
  const hoverIntent = createIntentDwell(prefetchRow, PREFETCH_DWELL_MS);
  const focusIntent = createIntentDwell(prefetchRow, PREFETCH_DWELL_MS);

  function onRowPointerEnter(event: PointerEvent, id: string): void {
    // Touch has no hover — its pointerenter is the start of a tap or a scroll.
    if (event.pointerType === "touch") return;
    hoverIntent.arm(id);
  }

  // A press on the open / split button needs no dwell. Not for touch: there a
  // press is as often the start of a list scroll, and tap → click leaves no gap
  // to win.
  function onRowPress(event: PointerEvent, id: string): void {
    if (event.pointerType === "touch" || event.button) return;
    hoverIntent.cancel(id);
    prefetchRow(id);
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
      {#each nav as item}
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
          {/if}
          {#if item.view === "todos" && todoBadgeCount > 0}
            <span class="nav-badge" title={todoBadgeTitle}>{todoBadgeCount}</span>
          {/if}
          {#if item.view === "teamBrain" && teamBrainBadge > 0}
            <span class="nav-badge" title={teamBrainBadgeTitle($appState.teamBrainStatus)}>{teamBrainBadge}</span>
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
      <!-- No list role here: each date group below is its own list, labelled by
           its heading. -->
      <div id="rail-conversation-list" class="conv-list scroll-thin">
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
          {#each conversationGroups as group (group.id)}
          <div class="conv-group" out:groupOut={group.id}>
            <!-- A real heading, not a control: never focusable or clickable. -->
            <h3 class="conv-group-label" id={`rail-conversation-group-${group.id}`}>{group.label}</h3>
            <div class="conv-group-list" role="list" aria-labelledby={`rail-conversation-group-${group.id}`}>
          {#each group.items as conversation (conversation.id)}
            {@const liveLabel = activeRunLabel(conversation)}
            <!-- Named HERE, not read inside a helper the markup calls: legacy mode
                 tracks only what the expression names, and the lock would otherwise
                 stay drawn until some unrelated store write. -->
            {@const rowBusy = busyConversationIds.has(conversation.id) || renamingBusyId === conversation.id}
            {@const rowStreaming = $appState.chatPanes.some((pane) => pane.conversationId === conversation.id && pane.streaming)}
            {@const openLabel = liveLabel
              ? `대화 열기: ${conversationTitle(conversation)} · ${liveLabel}`
              : `대화 열기: ${conversationTitle(conversation)}`}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="conv-item"
              class:active={conversation.id === activeConversationId}
              class:editing={renamingId === conversation.id}
              class:busy={rowBusy}
              aria-busy={rowBusy ? "true" : "false"}
              role="listitem"
              draggable={renamingId !== conversation.id && !rowBusy}
              on:dragstart={(event) => onConvDragStart(event, conversation)}
              on:pointerenter={(event) => onRowPointerEnter(event, conversation.id)}
              on:pointerleave={() => hoverIntent.cancel(conversation.id)}
              on:focusin={() => focusIntent.arm(conversation.id)}
              on:focusout={() => focusIntent.cancel(conversation.id)}
              out:conversationOut={conversation.id}
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
                  disabled={rowBusy}
                  on:pointerdown={(event) => onRowPress(event, conversation.id)}
                  on:click={() => openConversation(conversation)}
                >
                  <span class="conv-name">{conversationTitle(conversation)}</span>
                  <span class="conv-time">{conversation.avatarDisplayName} · {timeLabel(conversation.updatedAt)}</span>
                  {#if liveLabel}
                    <!-- The run is still going with this conversation closed; the
                         button's aria-label carries the same words (its label
                         overrides this content for screen readers). -->
                    <span class="conv-live" title={liveLabel}>
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
                    disabled={paneCount >= 4 || rowBusy}
                    on:pointerdown={(event) => onRowPress(event, conversation.id)}
                    on:click={(event) => addToSplit(conversation, event)}
                  >
                    <Icon name="columns" size={15} />
                  </button>
                  <button
                    class="conv-act"
                    type="button"
                    aria-label={`대화 이름 바꾸기: ${conversationTitle(conversation)}`}
                    title="이름 바꾸기"
                    disabled={rowBusy}
                    on:click={(event) => startRename(conversation, event)}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    class="conv-act danger"
                    type="button"
                    aria-label={`대화 삭제: ${conversationTitle(conversation)}`}
                    title={rowStreaming ? "응답 중인 대화는 삭제할 수 없습니다" : "삭제"}
                    disabled={rowBusy || rowStreaming}
                    on:click={(event) => deleteConversation(conversation, event)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              {/if}
            </div>
          {/each}
            </div>
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
