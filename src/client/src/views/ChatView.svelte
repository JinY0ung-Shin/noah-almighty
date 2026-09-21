<script lang="ts">
  import { afterUpdate, onDestroy, onMount, tick } from "svelte";
  import ActivityTree from "../components/ActivityTree.svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import BotTaskCard from "../components/BotTaskCard.svelte";
  import CanvasPanel from "../components/CanvasPanel.svelte";
  import FilePreviewPanel from "../components/FilePreviewPanel.svelte";
  import Icon from "../components/Icon.svelte";
  import PromptModal from "../components/PromptModal.svelte";
  import { activePane, appState, newId, notify, readState, updateState } from "../lib/state";
  import {
    PLUGIN_STATUS_LABELS,
    addConversationToSplit,
    anchorBotTasksToMessages,
    attachActiveRun,
    cancelBotTask,
    closePane,
    newChat,
    regenerate,
    respondPlanReview,
    selectConversation,
    sendMessage,
    sendSteer,
    startChatWith,
    stopPane,
  } from "../lib/chat";
  import { api } from "../lib/api";
  import {
    allowlistSeed,
    browserBridgeReachable,
    bridgeVersionVerdict,
    extensionsPageUrl,
    readAllowedOrigins,
    writeAllowedOrigins,
    type BridgeVersionVerdict,
  } from "../lib/browserBridge";
  import { autosize, clickOutside, copyText, downscaleImageToDataUrl, enhanceMarkdown, readFileAsDataUrl } from "../lib/dom";
  import { STT_MAX_SEC, startVoiceInput, type SttPhase, type SttSession } from "../lib/stt";
  import { loadAvatars, loadConversations } from "../lib/loaders";
  import { goView, routeFromHash } from "../lib/nav";
  import { formatFileSize, formatUsageLabel, renderMarkdown, renderMarkdownCached, timeLabel } from "../lib/format";
  import { createStickController, type StickController } from "../lib/autoscroll";
  import { panelSlides, segmentAttachments } from "../lib/bubbleSegments";
  import { menuCommandsForPane, filterSlashCommands, type SlashCommand } from "../lib/slash";
  import type { AgentActivity, AvatarSummary, BotTask, ChatPane, ImageMediaType, MessageAttachment, PendingImage, SkillInfo, StoredMessage } from "../lib/types";
  import { DEFAULT_MODEL_TIER } from "../../../server/modelTiers";
  import { DEFAULT_EFFORT_LEVEL } from "../../../server/effortLevels";
  import {
    DEFAULT_MCP_TOOL_GROUPS,
    MCP_TOOL_GROUPS,
    effectiveMcpToolGroups,
    isRequiredMcpToolGroup,
    type McpToolGroupId,
  } from "../../../shared/mcpToolGroups";
  import { TOUR_SCENARIOS, type TourScenario } from "../../../shared/tourScenarios";

  let splitAvatarId = "";
  let splitAddBusy = false;
  // Slash autocomplete: which pane it's open for + the selected index.
  let slashPaneId = "";
  let slashIndex = 0;
  let physicalKeyboard = false;
  // Per-pane group-knowledge dropdown open state.
  let gkOpenPaneId = "";
  // Per-pane MCP tool-group checkbox panel open state.
  let mcpToolsOpenPaneId = "";
  // Per-pane mobile composer settings disclosure state.
  let composerSettingsOpenPaneId = "";
  // Plan-approval: which pane is in "수정 요청" (reject-with-feedback) mode, and its draft.
  let planRejectPaneId = "";
  let planFeedback = "";
  let planReviewErrors: Record<string, string> = {};

  function planReviewStatusText(pane: ChatPane): string {
    if (pane.planReviewSubmitting) return "응답을 전송하는 중입니다.";
    return planReviewErrors[pane.id] ? `응답 전송 실패: ${planReviewErrors[pane.id]}` : "";
  }
  function clearPlanReviewError(paneId: string): void {
    if (!planReviewErrors[paneId]) return;
    const next = { ...planReviewErrors };
    delete next[paneId];
    planReviewErrors = next;
  }
  function setPlanReviewError(paneId: string, message: string): void {
    planReviewErrors = { ...planReviewErrors, [paneId]: message };
  }

  async function approvePlan(pane: ChatPane): Promise<void> {
    clearPlanReviewError(pane.id);
    try {
      await respondPlanReview(pane.id, "approved");
    } catch (err) {
      setPlanReviewError(pane.id, (err as Error).message);
    }
  }
  function startRejectPlan(pane: ChatPane): void {
    planRejectPaneId = pane.id;
    planFeedback = "";
    clearPlanReviewError(pane.id);
  }
  function cancelRejectPlan(): void {
    planRejectPaneId = "";
    planFeedback = "";
  }
  async function submitRejectPlan(pane: ChatPane): Promise<void> {
    const feedback = planFeedback;
    clearPlanReviewError(pane.id);
    try {
      await respondPlanReview(pane.id, "rejected", feedback);
      cancelRejectPlan();
    } catch (err) {
      setPlanReviewError(pane.id, (err as Error).message);
    }
  }

  onMount(async () => {
    try {
      const route = routeFromHash();
      await loadConversations();
      await loadAvatars();
      if (route.view === "chat" && route.arg && activePane()?.conversationId !== route.arg) {
        await selectConversation(route.arg);
        return;
      }
        const pane = activePane();
        if (pane) {
          // NOT awaited: attachActiveRun resolves only when the RUN ends (a run
          // parked on a blocking canvas can wait 30 minutes), and onMount must
          // not stay pending that long.
          void attachActiveRun(pane.id);
        }
    } catch (err) {
      notify(`대화 목록을 불러오지 못했습니다: ${(err as Error).message}`, "warn");
    }
  });

  // Auto-scroll: one StickController per pane owns ALL the mechanics — the
  // ResizeObserver re-pins, wheel/touch/pointer gesture capture (user intent is
  // read from INPUT events, not inferred from scroll deltas), and the
  // scroll-event decision via `nextStickBottom`. See `lib/autoscroll.ts` for
  // the full rationale; `stickBottom` stays in the pane store so the FAB and
  // the send-time re-arm (lib/chat.ts) keep working unchanged.
  const stickControllers: Record<string, StickController> = {};

  function stickFor(paneId: string): StickController {
    return (stickControllers[paneId] ??= createStickController({
      // Read/write through the LIVE store — never a captured pane snapshot, so
      // the controller can't act on a stale stickBottom between re-renders.
      isStuck: () => readState().chatPanes.find((p) => p.id === paneId)?.stickBottom,
      setStuck: (next) =>
        updateState((state) => {
          const target = state.chatPanes.find((p) => p.id === paneId);
          if (target && target.stickBottom !== next) target.stickBottom = next;
        }),
    }));
  }

  // Svelte action for the `.transcript` element of one pane.
  function transcriptStick(node: HTMLElement, paneId: string) {
    const wired = stickFor(paneId).attach(node);
    return {
      destroy() {
        wired.destroy();
        delete stickControllers[paneId];
      },
    };
  }

  // Re-pin on every store-driven render (new message, conversation switch —
  // even one that doesn't change content height, which the ResizeObserver
  // can't see). pin() bails when the user has scrolled up.
  afterUpdate(() => {
    for (const item of panes) stickControllers[item.id]?.pin();
  });

  $: panes = $appState.chatPanes;
  $: pane = panes.find((item) => item.id === $appState.activePaneId) ?? panes[0] ?? null;
  $: splitClass = panes.length <= 1 ? "single" : $appState.chatLayout;
  // Split-add options: ALL visible avatars (duplicates allowed — you can run
  // several parallel conversations with the same avatar, incl. your own), with
  // the open panes' avatars unioned in as a fallback so your own avatar is always
  // selectable even before discovery loads.
  $: splitOptions = (() => {
    const byId = new Map<string, { id: string; alias?: string; displayName?: string; username?: string }>();
    for (const item of panes) if (item.avatar?.id) byId.set(item.avatar.id, item.avatar);
    for (const avatar of $appState.avatars) if (avatar?.id) byId.set(avatar.id, avatar);
    return [...byId.values()];
  })();
  $: if (splitOptions.length && !splitOptions.some((avatar) => avatar.id === splitAvatarId)) {
    splitAvatarId = splitOptions[0].id;
  } else if (!splitOptions.length && splitAvatarId) {
    splitAvatarId = "";
  }

  $: user = $appState.user;
  // Desktop / physical keyboard → Enter sends; touch-only → button sends.
  $: finePointer = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
  $: enterSends = finePointer || physicalKeyboard;

  function isOwnPane(item: ChatPane): boolean {
    return Boolean(item.avatar.isOwn || item.avatar.id === user?.id);
  }

  function isExternalPane(item: ChatPane): boolean {
    return item.avatar.runtime === "external";
  }

  function eligibleGroups(item: ChatPane) {
    return isOwnPane(item) ? (user?.groups || []).filter((g) => g.knowledgeRepoConfigured) : [];
  }

  function hasModelPicker(): boolean {
    return Boolean($appState.bootstrap?.modelSelection?.tiers.length);
  }

  function canPickModel(): boolean {
    return Boolean(hasModelPicker() && !$appState.bootstrap?.modelSelection?.locked);
  }

  function currentModelTier(item: ChatPane): string {
    const tiers = $appState.bootstrap?.modelSelection?.tiers || [];
    const selected = item.modelTier ?? DEFAULT_MODEL_TIER;
    return tiers.some((tier) => tier.id === selected) ? selected : DEFAULT_MODEL_TIER;
  }

  function hasEffortPicker(): boolean {
    return Boolean($appState.bootstrap?.effortSelection);
  }

  function hasComposerControls(item: ChatPane): boolean {
    // External panes get the settings row for the gateway model picker; native
    // panes always get it too — the MCP tool-group picker always exists
    // (MCP_TOOL_GROUPS is a non-empty registry), so the row is never empty. The
    // per-item argument is kept for call-site clarity and future gating.
    void item;
    return true;
  }

  function modelTierLabel(item: ChatPane): string {
    const tierId = currentModelTier(item);
    return $appState.bootstrap?.modelSelection?.tiers.find((tier) => tier.id === tierId)?.label ?? tierId;
  }

  function effortLabel(item: ChatPane): string {
    const levelId = item.effort ?? $appState.bootstrap?.effortSelection?.default ?? DEFAULT_EFFORT_LEVEL;
    return $appState.bootstrap?.effortSelection?.levels.find((level) => level.id === levelId)?.label ?? levelId;
  }

  function groupKnowledgeLabel(item: ChatPane): string {
    const groups = eligibleGroups(item);
    if (!groups.length) return "";
    const onCount = groups.filter((g) => !(item.groupKnowledgeOff || []).includes(g.id)).length;
    return `그룹 ${onCount}/${groups.length}`;
  }

  function selectedMcpToolGroups(item: ChatPane): McpToolGroupId[] {
    const selected = item.mcpToolGroups ?? DEFAULT_MCP_TOOL_GROUPS;
    return effectiveMcpToolGroups(selected);
  }

  // Admin per-group tool policy from /api/me (`user.allowedMcpToolGroups`, the
  // effective intersection): blocked groups render disabled in the picker; the
  // server clamps every run regardless. A top-level `$:` derivation, NOT a
  // helper-body read — legacy-mode template helper bodies compile inside
  // $.untrack and would go stale. Helpers below take it as a PARAMETER so the
  // template callsites stay tracked.
  $: adminBlockedMcpToolGroupSet = (() => {
    const allowed = $appState.user?.allowedMcpToolGroups;
    if (!allowed) return new Set<McpToolGroupId>();
    return new Set<McpToolGroupId>(
      MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => !isRequiredMcpToolGroup(id) && !allowed.includes(id)),
    );
  })();

  // Guided tours offered in the owner's empty state. A browser-driven scenario
  // disappears entirely when admin policy blocks the browser tool group — never
  // offer a route this run cannot have. Derived at the top level for the same
  // reason as the set above: a helper body would read a stale value.
  $: tourScenarios = TOUR_SCENARIOS.filter(
    (scenario) => !scenario.needsBrowser || !adminBlockedMcpToolGroupSet.has("browser"),
  );

  /* ---- 봇 오피스: 스레드 안에 놓이는 위임 작업 카드 --------------------------
     내 봇에게 맡긴 일은 그 일을 시킨 turn 옆에 있어야 읽힌다. 그래서 카드는
     별도 보드가 아니라 트랜스크립트 안에, 자기보다 앞선 마지막 사용자 메시지
     바로 뒤에 놓인다(그보다 오래된 작업은 -1 = 첫 말풍선 위).

     이 스니펫은 스트리밍 토큰마다 다시 도는 자리라, 마크업은 미리 만든 맵을
     '조회만' 한다({#each} 안에서 필터 금지). 봇 오피스가 아니면 derivation이
     첫 줄에서 같은 빈 맵을 돌려주므로 일반 대화에는 DOM 차이가 0이다. */
  const NO_INLINE_BOT_TASKS: Map<string, Map<number, BotTask[]>> = new Map();
  const NO_BOT_TASKS: BotTask[] = [];
  let cancellingBotTaskId = "";

  $: inlineBotTasks = anchorBotTasksByPane($appState.view, $appState.chatPanes, $appState.botTasks);

  function anchorBotTasksByPane(
    view: string,
    list: ChatPane[],
    tasks: BotTask[],
  ): Map<string, Map<number, BotTask[]>> {
    if (view !== "bots" || !tasks.length) return NO_INLINE_BOT_TASKS;
    const byPane = new Map<string, Map<number, BotTask[]>>();
    for (const item of list) {
      const agentId = item.avatar.personalAgent?.agentId;
      if (!agentId) continue;
      const mine = tasks.filter((task) => task.agentId === agentId);
      if (mine.length) byPane.set(item.id, anchorBotTasksToMessages(mine, item.messages));
    }
    return byPane;
  }

  async function cancelInlineBotTask(task: BotTask): Promise<void> {
    if (cancellingBotTaskId) return;
    cancellingBotTaskId = task.id;
    try {
      await cancelBotTask(task);
    } finally {
      cancellingBotTaskId = "";
    }
  }

  // Browser-bridge compatibility badge for the composer hint row: compares the
  // INSTALLED extension build against the server bundle AND the server's
  // min-compatible floor, so a stale install shows up before the avatar hits
  // "Unsupported operation" — but an install that merely differs while staying
  // at/above the floor keeps working instead of demanding a re-download on
  // every extension-folder touch. Probed once per app load — both sides only
  // change with a deploy or an extension reload, and either reloads this page in
  // practice. The probe only starts once a pane actually has the browser tool
  // group selected, so panes that never touch the bridge never ping it.
  //
  // FOUR distinct states, not three: `compatible` (works now, an update exists)
  // is its own rung between "matches the server" and "must update", because
  // collapsing it into the healthy state hides an update the user could take at
  // their convenience. `unreachable` is the version verdict's absence, so the
  // reachability and version axes fold into ONE level the badge renders from —
  // they were two fields that always moved together.
  type BridgeBadgeLevel = BridgeVersionVerdict | "unreachable";
  let bridgeCompat:
    | {
        level: BridgeBadgeLevel;
        installed: string;
        expected: string;
      }
    | null = null;
  let bridgeCompatStarted = false;
  // Bounds the transient-failure retry below: the reactive guard subscribes to
  // bridgeCompatStarted, so resetting it to false on every catch would spin an
  // unbounded fetch loop while GET /api/browser-extension keeps 5xx-ing.
  let bridgeCompatFailures = 0;

  async function probeBridgeCompat(): Promise<void> {
    try {
      const [meta, reply] = await Promise.all([
        api<{
          version?: string | null;
          minCompatibleVersion?: string | null;
          defaultAllowedOrigins?: string[];
        }>("/api/browser-extension"),
        // getAllowedOrigins exists in every extension build, so it is the one
        // probe that cannot side-effect an old install; pre-0.4.0 builds
        // answer without `version`, which reads as "outdated".
        browserBridgeReachable() ? readAllowedOrigins() : Promise.resolve(null),
      ]);
      const expected = typeof meta.version === "string" ? meta.version : "";
      const floor = typeof meta.minCompatibleVersion === "string" ? meta.minCompatibleVersion : null;
      const installed = reply?.ok && typeof reply.version === "string" ? reply.version : "";
      bridgeCompat =
        !reply || !reply.ok
          ? { level: "unreachable", installed: "", expected }
          : { level: bridgeVersionVerdict(installed, expected, floor), installed, expected };
      // First-run convenience: an EMPTY local allowlist (deny-all, before any
      // user choice exists) is seeded once with the operator's default
      // (BROWSER_ALLOWED_ORIGINS). A user-edited or managed list never is —
      // allowlistSeed answers null there — and the notice keeps the change
      // visible instead of silently widening what the agent may drive.
      const seed = allowlistSeed(meta.defaultAllowedOrigins, reply, location.hostname);
      if (seed) {
        const seeded = await writeAllowedOrigins(seed);
        if (seeded.ok) {
          notify(
            `브라우저 제어 허용 사이트에 서버 기본값 ${seed.length}개를 적용했습니다. 설정 → 접근/보안에서 바꿀 수 있어요.`,
            "ok",
          );
        }
      }
    } catch {
      // Transient failure — allow a couple of retries on the next reactive fire,
      // then give up (until a reload) so a persistent 5xx can't spin forever.
      bridgeCompatFailures += 1;
      if (bridgeCompatFailures < 2) {
        bridgeCompatStarted = false;
      }
    }
  }

  $: browserBridgeSelected =
    !adminBlockedMcpToolGroupSet.has("browser") &&
    $appState.chatPanes.some((p) => !isExternalPane(p) && selectedMcpToolGroups(p).includes("browser"));
  $: if (browserBridgeSelected && !bridgeCompatStarted) {
    bridgeCompatStarted = true;
    void probeBridgeCompat();
  }

  // Each rung carries its own TEXT, not just its own colour: `current` and
  // `compatible` would otherwise read identically to anyone who cannot tell the
  // two dots apart, and a difference nobody can name is not a state.
  function bridgeBadge(compat: NonNullable<typeof bridgeCompat>): { text: string; title: string } {
    if (compat.level === "current") {
      return {
        text: `브라우저 확장 v${compat.installed}`,
        title: "설치된 브라우저 확장이 서버가 배포하는 버전과 일치합니다.",
      };
    }
    if (compat.level === "compatible") {
      return {
        text: `브라우저 확장 v${compat.installed} · 업데이트 있음`,
        title: `서버 번들(v${compat.expected || "?"})과 다르지만 호환되는 버전이라 그대로 쓸 수 있습니다. 설정 → 접근/보안의 원클릭 업데이트로 편할 때 올리세요.`,
      };
    }
    if (compat.level === "outdated") {
      return {
        text: `확장 업데이트 필요 (${compat.installed ? `v${compat.installed}` : "구버전"} → v${compat.expected || "?"})`,
        title: `설치된 브라우저 확장이 이 서버와 호환되지 않는 버전입니다. 설정 → 접근/보안에서 원클릭 업데이트를 누르거나, zip을 다시 받아 폴더를 교체한 뒤 ${extensionsPageUrl()}에서 리로드(↻)하세요.`,
      };
    }
    return {
      text: "브라우저 확장 연결 안 됨",
      title:
        "이 브라우저에서 Noah 확장에 연결할 수 없습니다. 설정 → 접근/보안의 안내대로 설치했는지, Noah 주소가 확장의 허용 origin에 있는지 확인하세요.",
    };
  }

  /**
   * Jump from the composer's problem badge to where the extension is actually
   * installed. `browserGuideRequested` is the one-shot deep link the 접근/보안
   * tab consumes on activation (same path the what's-new dialog uses); goView
   * carries the hash so Back returns to the chat.
   */
  function openBrowserBridgeGuide(): void {
    updateState((state) => {
      state.browserGuideRequested = true;
    });
    goView("settings", "access");
  }

  function mcpToolsLabel(item: ChatPane, adminBlocked: Set<McpToolGroupId>): string {
    const effective = selectedMcpToolGroups(item).filter((id) => !adminBlocked.has(id));
    return `도구 ${effective.length}/${MCP_TOOL_GROUPS.length}`;
  }

  function composerSettingsSummary(item: ChatPane, adminBlocked: Set<McpToolGroupId>): string {
    if (isExternalPane(item)) {
      return (
        item.modelTier ||
        (item.externalDefaultModel ? `기본 (${item.externalDefaultModel})` : "기본 모델")
      );
    }
    const parts: string[] = [];
    if (hasModelPicker()) parts.push(modelTierLabel(item));
    if (hasEffortPicker()) parts.push(`강도 ${effortLabel(item)}`);
    const groupLabel = groupKnowledgeLabel(item);
    if (groupLabel) parts.push(groupLabel);
    parts.push(mcpToolsLabel(item, adminBlocked));
    return parts.join(" · ");
  }

  function paneDomId(prefix: string, paneId: string): string {
    return `${prefix}-${paneId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  function slashOptionId(paneId: string, index: number): string {
    return paneDomId(`slash-option-${index}`, paneId);
  }

  function activeSlashOptionId(item: ChatPane): string | undefined {
    if (slashPaneId !== item.id) return undefined;
    const matches = slashMatches(item);
    if (!matches.length) return undefined;
    return slashOptionId(item.id, Math.min(slashIndex, matches.length - 1));
  }
  // Per-pane active slash-option id, derived reactively so aria-activedescendant
  // tracks ArrowUp/Down: activeSlashOptionId reads slashPaneId/slashIndex only in
  // its body, so a bare template call is untracked and stays pinned to option 0.
  $: activeSlashDescendant = (() => {
    void slashPaneId;
    void slashIndex;
    const map: Record<string, string | undefined> = {};
    for (const p of $appState.chatPanes) map[p.id] = activeSlashOptionId(p);
    return map;
  })();

  function toggleComposerSettings(item: ChatPane) {
    const closing = composerSettingsOpenPaneId === item.id;
    composerSettingsOpenPaneId = closing ? "" : item.id;
    if (closing && gkOpenPaneId === item.id) gkOpenPaneId = "";
    if (closing && mcpToolsOpenPaneId === item.id) mcpToolsOpenPaneId = "";
  }

  // Gateway model catalogs load eagerly per EXTERNAL pane: on desktop the
  // composer controls are always visible (the settings toggle only exists on
  // mobile), so there is no interaction to hook a lazy fetch onto — populate
  // the picker as soon as the pane exists. ensureExternalModels is one-shot
  // per pane (undefined-check + in-flight guard), so this settles immediately.
  $: for (const paneItem of panes) {
    if (isExternalPane(paneItem) && paneItem.externalModels === undefined) {
      void ensureExternalModels(paneItem);
    }
  }

  function toggleMcpToolsPanel(item: ChatPane) {
    const closing = mcpToolsOpenPaneId === item.id;
    mcpToolsOpenPaneId = closing ? "" : item.id;
    if (!closing && gkOpenPaneId === item.id) gkOpenPaneId = "";
  }

  function toggleGroupKnowledgePanel(item: ChatPane) {
    const closing = gkOpenPaneId === item.id;
    gkOpenPaneId = closing ? "" : item.id;
    if (!closing && mcpToolsOpenPaneId === item.id) mcpToolsOpenPaneId = "";
  }

  async function submit(item: ChatPane) {
    if (!canSendMessage(item)) return;
    closeSlash();
    const message = item.draft;
    // On desktop, restore focus to the composer so the user can keep typing while
    // the response streams (the send button / touch tap moves focus off it). On
    // mobile, do the opposite: blur the textarea so the soft keyboard drops away
    // after sending instead of staying up over the conversation.
    const pending = sendMessage(item.id, message);
    if (isMobileViewport()) blurComposer(item.id);
    else focusComposer(item.id);
    await pending;
    await tick();
  }

  function canSendMessage(item: ChatPane): boolean {
    return Boolean(
      !item.streaming &&
        item.avatar &&
        (item.draft.trim() || (!isExternalPane(item) && item.pendingImages?.length)),
    );
  }

  function isMobileViewport(): boolean {
    return window.matchMedia?.("(max-width: 860px)").matches ?? false;
  }

  function blurComposer(paneId: string) {
    const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] textarea`);
    el?.blur();
  }

  /* ---- image attachments ---- */
  const MAX_COMPOSER_IMAGES = 6;
  // Long-edge cap before upload (Claude's recommended max; also keeps payloads small).
  const IMAGE_MAX_DIM = 1568;
  // Hand-mirrors the server's MAX_CHAT_IMAGE_BYTES (chatImages.ts). Only file mode
  // needs it: the vision path downscales, so it never approaches the cap.
  const MAX_ATTACH_FILE_BYTES = 5 * 1024 * 1024;
  const ACCEPTED_IMAGE_TYPES: ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // Downscale to IMAGE_MAX_DIM via canvas (re-encoding to the same family). GIFs
  // are kept verbatim so animation survives (still size-capped server-side). The
  // decode/downscale (a CSP-sensitive `data:` URL load) lives in downscaleImageToDataUrl.
  async function resizeImageForChat(file: File): Promise<{ dataUrl: string; mediaType: ImageMediaType }> {
    const type: ImageMediaType = (ACCEPTED_IMAGE_TYPES as string[]).includes(file.type) ? (file.type as ImageMediaType) : "image/png";
    if (type === "image/gif") {
      const sourceDataUrl = await readFileAsDataUrl(file);
      return { dataUrl: sourceDataUrl, mediaType: "image/gif" };
    }
    const out = type === "image/jpeg" ? "image/jpeg" : type === "image/webp" ? "image/webp" : "image/png";
    const dataUrl = await downscaleImageToDataUrl(file, IMAGE_MAX_DIM, { outputType: out });
    // The browser may emit PNG if it can't encode the requested type — trust the prefix.
    const mediaType = (/^data:(image\/[a-z+]+);/.exec(dataUrl)?.[1] as ImageMediaType) || "image/png";
    return { dataUrl, mediaType };
  }

  // Vision support for the model THIS pane would use: pane pick > my saved
  // default > deployment default. Mirrors the server's resolution (which also
  // enforces it on upload); env-pinned deployments fall back to the global flag.
  function paneVisionEnabled(item: ChatPane, state: ReturnType<typeof readState> = readState()): boolean {
    const boot = state.bootstrap;
    if (!boot || isExternalPane(item)) return true;
    const sel = boot.modelSelection;
    if (!sel || sel.locked) return boot.visionEnabled !== false;
    const tier = item.modelTier || state.user?.modelDefault || "";
    const entry = tier ? sel.tiers.find((t) => t.id === tier) : undefined;
    if (entry) return entry.vision !== false;
    return (sel.defaultVision ?? boot.visionEnabled) !== false;
  }

  async function addImages(item: ChatPane, files: FileList | File[] | null | undefined) {
    if (!files) return;
    if (isExternalPane(item)) {
      notify("외부 아바타는 아직 이미지 첨부를 지원하지 않습니다.", "warn");
      return;
    }
    // Vision-off pane = FILE MODE: the server stages the image in the agent
    // workspace and hands the model only the path, so the ORIGINAL bytes go up
    // (no canvas re-encode) and only the four types the server sniffs pass.
    const fileMode = !paneVisionEnabled(item);
    const dropped = Array.from(files);
    let list = dropped.filter((f) => f.type.startsWith("image/"));
    if (fileMode) {
      list = list.filter((f) => (ACCEPTED_IMAGE_TYPES as string[]).includes(f.type));
      if (list.length < dropped.length) notify("PNG/JPEG/WebP/GIF만 첨부할 수 있습니다.", "warn");
      // Size-check before the room slice so an oversized file can't eat a slot.
      list = list.filter((f) => {
        if (f.size <= MAX_ATTACH_FILE_BYTES) return true;
        notify(`'${f.name || "이미지"}'은(는) 5 MB를 넘어 첨부할 수 없습니다.`, "warn");
        return false;
      });
    }
    if (!list.length) return;
    const current = readState().chatPanes.find((p) => p.id === item.id);
    const room = MAX_COMPOSER_IMAGES - (current?.pendingImages?.length || 0);
    if (room <= 0) {
      notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
      return;
    }
    const accepted: PendingImage[] = [];
    for (const file of list.slice(0, room)) {
      try {
        const { dataUrl, mediaType } = fileMode
          ? { dataUrl: await readFileAsDataUrl(file), mediaType: file.type as ImageMediaType }
          : await resizeImageForChat(file);
        accepted.push({ id: newId(), dataUrl, name: file.name || "image", mediaType });
      } catch {
        notify(`'${file.name || "이미지"}'를 불러오지 못했습니다.`, "warn");
      }
    }
    if (list.length > room) notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
    if (!accepted.length) return;
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = [...(target.pendingImages || []), ...accepted];
    });
    if (fileMode) notify("현재 모델은 이미지 내용을 보지 못합니다. 이미지는 파일로만 전달됩니다.", "info");
  }

  // A vision-off pane still attaches — the model gets the FILE, never the
  // pixels. Say that on the control itself instead of hiding it.
  function attachHint(item: ChatPane, state: ReturnType<typeof readState>): string {
    return paneVisionEnabled(item, state) ? "이미지 첨부" : "이미지 첨부 (모델이 내용을 보지 못하고 파일로 전달됨)";
  }

  // The disabled send button's title enumerates what WOULD make it sendable, so
  // it has to name the inputs this pane actually has: image attach is native-only,
  // voice depends on the deployment.
  function emptyComposerHint(item: ChatPane, state: ReturnType<typeof readState>): string {
    const voice = Boolean(state.bootstrap?.sttEnabled);
    if (isExternalPane(item)) return voice ? "메시지 또는 음성을 추가하세요" : "메시지를 입력하세요";
    return voice ? "메시지, 이미지 또는 음성을 추가하세요" : "메시지 또는 이미지를 추가하세요";
  }

  async function onPickImages(event: Event, item: ChatPane) {
    const input = event.currentTarget as HTMLInputElement;
    await addImages(item, input.files);
    input.value = ""; // allow re-picking the same file
  }

  function onComposerPaste(event: ClipboardEvent, item: ChatPane) {
    if (isExternalPane(item)) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // Prefer items (covers screenshots/copied images), fall back to files (some
    // browsers only populate one of the two for a pasted image).
    const fromItems = Array.from(clipboard.items || [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    const fromFiles = Array.from(clipboard.files || []).filter((f) => f.type.startsWith("image/"));
    const files = (fromItems.length ? fromItems : fromFiles).filter(
      (f, i, arr) => arr.findIndex((g) => g.name === f.name && g.size === f.size) === i,
    );
    if (files.length) {
      event.preventDefault();
      void addImages(item, files);
    }
  }

  function removePendingImage(item: ChatPane, id: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = (target.pendingImages || []).filter((img) => img.id !== id);
    });
  }

  /* ---- voice input (STT) ---- */
  // ONE take at a time across every pane — the mic is a single device — so the
  // session lives on the view, not on a pane. Only the finished transcript
  // touches the store: the textarea is one-way bound to `draft` (and autosize is
  // keyed on it), so a DOM write would be overwritten on the next render.
  let sttPaneId = "";
  let sttPhase: SttPhase | "" = "";
  let sttElapsed = 0;
  let sttSession: SttSession | null = null;
  // Whether THIS take will stop on its own. False until the end-of-speech
  // detector reports itself listening, because where it cannot load the take
  // still ends on the button or the 60s cap — and the hint must not say
  // otherwise.
  let sttAutoStop = false;
  // A stop pressed while getUserMedia is still pending (the browser's permission
  // prompt is up) has no session to stop yet — remember it and drop the take as
  // soon as one exists, so the mic never keeps recording unattended.
  let sttCancelPending = false;

  // Click-time read only. A TEMPLATE expression must never get its session
  // state from a helper's closure: legacy mode resolves an expression's
  // dependencies at COMPILE time and `untrack`s the call, so a `title` computed
  // in here would sit frozen at "음성 입력" for the whole take (the mic button
  // names `sttPaneId`/`sttPhase` in the markup instead).
  function micBusyElsewhere(item: ChatPane): boolean {
    return Boolean(sttPaneId) && sttPaneId !== item.id;
  }

  async function toggleVoiceInput(item: ChatPane): Promise<void> {
    if (micBusyElsewhere(item) || sttPhase === "transcribing") return;
    if (sttPaneId === item.id) {
      // Second press stops the take; before the session exists it means "never mind".
      if (sttSession) sttSession.stop();
      else sttCancelPending = true;
      return;
    }
    sttPaneId = item.id;
    sttPhase = "recording";
    sttElapsed = 0;
    sttAutoStop = false;
    sttCancelPending = false;
    try {
      const session = await startVoiceInput({
        onPhase: (phase) => (sttPhase = phase),
        onElapsed: (seconds) => (sttElapsed = seconds),
        onAutoStopArmed: () => (sttAutoStop = true),
      });
      sttSession = session;
      if (sttCancelPending) session.cancel();
      const text = await session.done;
      if (text) appendTranscript(item.id, text);
    } catch (err) {
      notify((err as Error).message, "warn");
    } finally {
      sttSession = null;
      sttPaneId = "";
      sttPhase = "";
      sttElapsed = 0;
      sttAutoStop = false;
      sttCancelPending = false;
    }
  }

  /** Voice text EXTENDS the draft instead of replacing it, then hands focus back. */
  function appendTranscript(paneId: string, text: string): void {
    const existing = readState().chatPanes.find((item) => item.id === paneId)?.draft || "";
    setDraft(paneId, existing ? `${existing} ${text}` : text);
    focusComposer(paneId);
  }

  function cancelVoiceInput(): void {
    if (sttSession) sttSession.cancel();
    else if (sttPaneId) sttCancelPending = true;
  }

  /**
   * Which pane Alt+M acts on: the composer holding focus wins, so a split view
   * dictates into the box the user is already in; a lone pane needs no
   * disambiguation. With several panes and focus elsewhere it resolves to
   * nothing rather than guessing which conversation to talk into. A take
   * already in flight owns the shortcut outright — its stop half has to work
   * from anywhere in the view, and pressing it at any other pane would no-op.
   */
  function voiceShortcutPaneId(event: KeyboardEvent): string {
    if (sttPaneId) return sttPaneId;
    const inComposer = [event.target, document.activeElement].find(
      (node): node is HTMLElement => node instanceof HTMLElement && Boolean(node.closest(".composer-box")),
    );
    const owner = inComposer?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
    return owner || (panes.length === 1 ? panes[0].id : "");
  }

  // Alt+M is the mic button from anywhere in the chat view. Keyed on
  // `event.code` so the binding survives non-QWERTY layouts, and the ctrlKey
  // exclusion also drops AltGr (which reports ctrl+alt) so layouts that type
  // their extra characters with it are unaffected. No recording logic of its
  // own: the toggle already handles busy/transcribing/stop/cancel-pending.
  function onGlobalKeydown(event: KeyboardEvent): void {
    if (event.code !== "KeyM" || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.isComposing) return;
    const state = readState();
    // App.svelte swaps ONE top-level view at a time, so this listener already
    // dies with the component; the view check keeps it correct if chat ever
    // moves under the always-mounted pattern the settings tabs use.
    if (!state.bootstrap?.sttEnabled || state.view !== "chat") return;
    const target = panes.find((item) => item.id === voiceShortcutPaneId(event));
    if (!target) return;
    event.preventDefault();
    void toggleVoiceInput(target);
  }

  // Release the mic when the pane holding it goes away (closed pane, view swap)
  // instead of recording into a draft nobody can see.
  $: if (sttPaneId && !panes.some((item) => item.id === sttPaneId)) cancelVoiceInput();
  onDestroy(cancelVoiceInput);

  // Live (just-sent) bubbles render from the locally-held data URL; on reload it
  // falls back to the owner-scoped serving endpoint.
  function imageSrc(message: StoredMessage, att: MessageAttachment, item: ChatPane): string {
    return (
      item.localImages?.[att.id] ||
      `/api/conversations/${encodeURIComponent(message.conversationId)}/images/${encodeURIComponent(att.id)}`
    );
  }

  // Hidden attachments (slide PNGs published for canvas embeds) are served by
  // URL but never rendered in the bubble.
  function visibleAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
    return (attachments ?? []).filter((att) => !att.hidden);
  }

  // Download URL for a generated-file attachment; `name` only picks the
  // save-dialog filename (the server sanitizes it).
  function fileSrc(conversationId: string, att: MessageAttachment): string {
    const base = `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(att.id)}`;
    return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
  }

  // File-card click: open the right-side preview panel (slides + download
  // button). Split view has no side-panel slot, so it keeps the direct
  // download instead.
  function openFilePreview(item: ChatPane, att: MessageAttachment, source: MessageAttachment[] | undefined): void {
    if (readState().chatPanes.length > 1) {
      const a = document.createElement("a");
      a.href = fileSrc(item.conversationId, att);
      a.download = att.name || "file";
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    const slides = panelSlides(source, att);
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.filePreview = { attachment: att, slides };
    });
  }

  /* ---- slash autocomplete ---- */
  function slashQuery(text: string): string | null {
    if (typeof text !== "string" || text.startsWith("//")) return null;
    const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }
  function slashMatches(item: ChatPane): SlashCommand[] {
    const query = slashQuery(item.draft);
    if (query === null || item.streaming) return [];
    return filterSlashCommands(menuCommandsForPane(item), query);
  }

  // Skill entries in the slash menu are populated from the avatar's installed
  // skills, fetched once (lazily) the first time the menu opens for a pane. The
  // result is stored on the pane so slashMatches stays reactive via the store.
  const skillsInFlight = new Set<string>();
  async function ensureSkills(item: ChatPane) {
    if (item.skillsLoaded || skillsInFlight.has(item.id) || !item.avatar?.id) return;
    skillsInFlight.add(item.id);
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(item.avatar.id)}/skills`);
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) {
          target.skills = result.skills || [];
          target.skillsLoaded = true;
        }
      });
    } catch {
      // Soft-fail: the menu still shows built-in commands. Mark loaded so we don't
      // retry on every keystroke; a fresh pane (e.g. reload) gets another chance.
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) target.skillsLoaded = true;
      });
    } finally {
      skillsInFlight.delete(item.id);
    }
  }
  // Gateway model catalog for an external pane's model picker, fetched once
  // (lazily) the first time the composer settings open. Mirrors ensureSkills:
  // the result lives on the pane for reactivity; a failure soft-fails to a
  // default-only picker (externalModels = null) instead of blocking the chat.
  const externalModelsInFlight = new Set<string>();
  async function ensureExternalModels(item: ChatPane) {
    if (item.externalModels !== undefined || externalModelsInFlight.has(item.id)) return;
    externalModelsInFlight.add(item.id);
    try {
      const result = await api<{ models: string[]; defaultModel: string | null }>(
        `/api/avatars/${encodeURIComponent(item.avatar.id)}/models`,
      );
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) {
          target.externalModels = result.models || [];
          target.externalDefaultModel = result.defaultModel ?? null;
        }
      });
    } catch {
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) target.externalModels = null;
      });
      notify("Gateway 모델 목록을 가져오지 못했습니다. 기본 모델로 대화를 계속합니다.", "warn");
    } finally {
      externalModelsInFlight.delete(item.id);
    }
  }

  function closeSlash() {
    slashPaneId = "";
    slashIndex = 0;
  }
  function applySlash(item: ChatPane, cmd: SlashCommand) {
    closeSlash();
    if (cmd.action === "new") {
      setDraft(item.id, "");
      newChat(item.id);
      return;
    }
    // Skill entries aren't typeable as a raw "/command" (names can contain ":"),
    // so we send the expanded instruction that names the skill instead.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? cmd.prompt("") : "");
      void submit(item);
      return;
    }
    if (cmd.requiresArgs) {
      setDraft(item.id, `/${cmd.name} `);
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}`);
    void submit(item);
  }
  function completeSlash(item: ChatPane, cmd: SlashCommand) {
    // Tab on a skill drops its instruction into the composer (editable) instead of
    // sending, so the user can append details before pressing Enter.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? `${cmd.prompt("")} ` : "");
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}${cmd.requiresArgs ? " " : ""}`);
    focusComposer(item.id);
  }

  function onComposerKeydown(event: KeyboardEvent, item: ChatPane) {
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) physicalKeyboard = true;
    const matches = slashPaneId === item.id ? slashMatches(item) : [];
    if (matches.length) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Home") slashIndex = 0;
        else if (event.key === "End") slashIndex = matches.length - 1;
        else slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applySlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        completeSlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    if (!enterSends) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      if (item.streaming) {
        // Mid-turn message: the server hands it to the model between the running
        // turn's tool calls. An external avatar runs behind the gateway, which
        // has no such channel — there Enter keeps inserting a newline.
        if (isExternalPane(item)) return;
        if (item.pendingImages?.length) {
          // Swallow the Enter too: the user meant "send", and a stray newline on
          // top of the refusal is noise.
          event.preventDefault();
          notify("이미지는 응답이 끝난 뒤 보낼 수 있어요.", "warn");
          return;
        }
        // Nothing typed — fall through so Enter still breaks the line.
        if (!item.draft.trim()) return;
        event.preventDefault();
        void sendSteer(item.id, item.draft);
        return;
      }
      if (!canSendMessage(item)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      void submit(item);
    }
  }

  /**
   * Can this pane take a mid-turn message at all? Local panes only — an external
   * gateway run has no channel for one — for as long as a turn is streaming. It
   * deliberately does NOT look at the draft: the control is a standing part of
   * the streaming composer, disabled while there is nothing to send, so the grid
   * column list never changes under the user's fingers as they type. Reads only
   * its arguments, so the template expression that calls it re-evaluates
   * whenever the pane object changes.
   */
  function canSteer(item: ChatPane): boolean {
    return Boolean(!isExternalPane(item) && item.streaming);
  }

  /**
   * The mid-turn send button's tooltip. A control disabled with no stated
   * prerequisite reads as broken, so the empty-draft state names what would make
   * it work rather than just greying out.
   */
  function steerSendTitle(item: ChatPane): string {
    return item.draft.trim()
      ? "응답 중 메시지 보내기 (다음 작업 사이에 전달됩니다)"
      : "메시지를 입력하면 응답 중에도 보낼 수 있어요";
  }

  /**
   * The composer's placeholder while a turn is streaming. Local panes say that a
   * message sent now is delivered between the avatar's next two actions, and name
   * the gesture that actually sends on this device — Enter only sends where a
   * physical keyboard was detected. External panes keep the old wording: there
   * the draft really is only a head start on the next turn.
   */
  function streamingPlaceholder(item: ChatPane, sends: boolean): string {
    if (isExternalPane(item)) return "응답을 기다리는 중… (다음 메시지를 미리 작성할 수 있어요)";
    return sends
      ? "응답 중에도 메시지를 보낼 수 있어요 · Enter로 보내면 다음 작업 사이에 전달됩니다"
      : "응답 중에도 메시지를 보낼 수 있어요 · 보내기 버튼을 누르면 다음 작업 사이에 전달됩니다";
  }

  function onComposerInput(event: Event, item: ChatPane) {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    setDraft(item.id, value);
    if (slashQuery(value) !== null && !item.streaming) {
      slashPaneId = item.id;
      slashIndex = 0;
      void ensureSkills(item);
    } else if (slashPaneId === item.id) {
      closeSlash();
    }
  }

  function focusComposer(paneId: string) {
    void tick().then(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] textarea`);
      el?.focus();
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function setDraft(paneId: string, value: string) {
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.draft = value;
    });
  }

  function useStarter(item: ChatPane, text: string) {
    setActive(item.id);
    setDraft(item.id, text);
    focusComposer(item.id);
  }

  /**
   * Seed a guided tour: the literal "/tour <slug>" goes into the composer and the
   * SERVER expands it, so no copy of the agent-facing prompt lives client-side.
   * A browser tour turns its own prerequisite on in the SAME click (a card whose
   * unstated prerequisite makes it fail on step one reads as broken) — which also
   * brings up the bridge badge, itself the path to the install guide. Never
   * auto-sent: the owner reads the seeded line and presses send.
   */
  function useTour(item: ChatPane, scenario: TourScenario) {
    if (scenario.needsBrowser && !selectedMcpToolGroups(item).includes("browser")) {
      setMcpToolGroup(item, "browser", true);
    }
    useStarter(item, `/tour ${scenario.slug}`);
  }

  function copyMessage(message: StoredMessage, event: MouseEvent) {
    void copyText(message.content || message.response?.text || "", event.currentTarget as HTMLButtonElement);
  }

  function editMessage(item: ChatPane, message: StoredMessage) {
    setActive(item.id);
    setDraft(item.id, message.content || "");
    focusComposer(item.id);
    notify("메시지를 입력창에 불러왔습니다. 수정 후 보내기를 누르세요.", "info");
  }

  function setActive(paneId: string) {
    updateState((state) => {
      state.activePaneId = paneId;
      state.currentAvatar = state.chatPanes.find((item) => item.id === paneId)?.avatar || state.currentAvatar;
    });
  }

  function scrollToBottom(item: ChatPane) {
    stickFor(item.id).jumpToBottom();
  }

  async function addSplitPane() {
    if (splitAddBusy) return;
    const avatar = splitOptions.find((item) => item.id === splitAvatarId);
    if (!avatar) return;
    if (panes.length >= 4) {
      notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
      return;
    }
    splitAddBusy = true;
    try {
      await startChatWith(avatar as AvatarSummary, true);
    } catch (err) {
      notify(`분할 대화를 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      splitAddBusy = false;
    }
  }

  // Drop target for a conversation dragged from the rail's "내 대화" list.
  // Mirrors the MIME set in Shell.svelte's onConvDragStart.
  const CONV_DND_MIME = "application/x-noah-conversation";
  let dropActive = false;

  function isConvDrag(event: DragEvent): boolean {
    return Boolean(event.dataTransfer?.types?.includes(CONV_DND_MIME));
  }
  function onWorkbenchDragOver(event: DragEvent) {
    if (!isConvDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dropActive = true;
  }
  function onWorkbenchDragLeave(event: DragEvent) {
    // Only clear when leaving the workbench itself, not when crossing children.
    if (event.currentTarget === event.target) dropActive = false;
  }
  async function onWorkbenchDrop(event: DragEvent) {
    if (!isConvDrag(event)) return;
    event.preventDefault();
    dropActive = false;
    const conversationId = event.dataTransfer?.getData(CONV_DND_MIME);
    if (!conversationId) return;
    try {
      await addConversationToSplit(conversationId);
    } catch (err) {
      notify(`분할에 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    }
  }

  async function setGroupKnowledge(item: ChatPane, groupId: string, on: boolean) {
    const off = new Set(item.groupKnowledgeOff || []);
    if (on) off.delete(groupId);
    else off.add(groupId);
    const next = [...off];
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.groupKnowledgeOff = next;
      if (state.user) state.user.groupKnowledgeOffDefault = [...next];
    });
    const label = eligibleGroups(item).find((g) => g.id === groupId)?.name || "그룹";
    notify(`"${label}" 그룹 지식을 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/group-knowledge-default", { method: "PUT", body: JSON.stringify({ off: next }) }).catch((err) =>
      notify(`그룹 지식 기본값을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  // Model tier picked in the composer. Like the group-knowledge toggle it lives on
  // the pane and rides the next chat POST (which persists it per-conversation), AND
  // writes through to the owner's remembered default so the choice seeds the next
  // new conversation. The picker has no "default" option — every value is a real
  // tier (the default is Opus, applied server-side when never chosen).
  function setModelTier(item: ChatPane, tier: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.modelTier = tier;
      if (state.user) state.user.modelDefault = tier;
    });
    const label = $appState.bootstrap?.modelSelection?.tiers.find((t) => t.id === tier)?.label;
    notify(`모델을 ${label ?? tier}(으)로 변경했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ model: tier }) }).catch((err) =>
      notify(`기본 모델을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  // Gateway model for an EXTERNAL pane: lives on the pane and rides the next
  // chat POST (per-conversation). Unlike the native tier there is no per-user
  // default — the admin-configured agent model is the baseline, and "" clears
  // back to it.
  function setExternalModel(item: ChatPane, modelId: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.modelTier = modelId || undefined;
    });
    notify(
      modelId
        ? `모델을 ${modelId}(으)로 변경했습니다. 다음 메시지부터 적용됩니다.`
        : "기본 모델로 되돌렸습니다. 다음 메시지부터 적용됩니다.",
      "info",
    );
  }

  // Reasoning effort, mirroring setModelTier: lives on the pane, rides the next chat
  // POST (per-conversation), and writes through to the remembered per-user default.
  // Every value is a real level (the default is "높음"/high when never chosen).
  function setEffort(item: ChatPane, effort: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.effort = effort;
      if (state.user) state.user.effortDefault = effort;
    });
    const label = $appState.bootstrap?.effortSelection?.levels.find((e) => e.id === effort)?.label;
    notify(`사고 강도: ${label ?? effort}. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ effort }) }).catch((err) =>
      notify(`기본 사고 강도를 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function setMcpToolGroup(item: ChatPane, groupId: McpToolGroupId, on: boolean) {
    // Admin-blocked groups are disabled in the picker; ignore any stray toggle.
    if (isRequiredMcpToolGroup(groupId) || adminBlockedMcpToolGroupSet.has(groupId)) return;
    const current = new Set(selectedMcpToolGroups(item));
    if (on) current.add(groupId);
    else current.delete(groupId);
    const next = MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => current.has(id));
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.mcpToolGroups = next;
      if (state.user) state.user.mcpToolGroupsDefault = [...next];
    });
    const label = MCP_TOOL_GROUPS.find((group) => group.id === groupId)?.labelKo ?? groupId;
    notify(`"${label}" MCP 도구를 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ mcpToolGroups: next }) }).catch((err) =>
      notify(`기본 MCP 도구 설정을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function messageText(message: StoredMessage) {
    return message.response?.text || message.response?.summary || message.content;
  }
  function runtimeBadge(message: StoredMessage): string | null {
    const runtime = message.response?.runtime;
    if (runtime === "local") return "로컬";
    if (runtime === "external") return "외부 아바타";
    if (message.response?.summary === "오류" || message.response?.summary === "중지됨") return message.response.summary;
    return null;
  }
  // "도구 N개 · 태스크 N개 · 에이전트 N개 <suffix>" from the three counts, or
  // emptyLabel when all are zero. Shared by the live + completed activity labels.
  function activityCountLabel(toolCount: number, taskCount: number, agentCount: number, suffix: string, emptyLabel: string): string {
    const parts: string[] = [];
    if (toolCount) parts.push(`도구 ${toolCount}개`);
    if (taskCount) parts.push(`태스크 ${taskCount}개`);
    if (agentCount) parts.push(`에이전트 ${agentCount}개`);
    return parts.length ? `${parts.join(" · ")} ${suffix}` : emptyLabel;
  }
  function activitySummary(item: ChatPane): string {
    const toolCount = item.liveTools.filter((t) => t.kind === "tool").length;
    const taskCount = item.liveTasks.length;
    const agentCount = item.liveAgents.filter((a) => !a.isMain).length;
    return activityCountLabel(toolCount, taskCount, agentCount, "진행 중", "작업 중…");
  }
  // One-line description list for the background-phase note ("빌드 실행, 리포 조사").
  function bgTaskSummary(item: ChatPane): string {
    return (item.backgroundTasks || [])
      .map((t) => t.description || t.taskType || t.taskId)
      .filter(Boolean)
      .join(", ");
  }

  // Activity-tree snapshot kept on a COMPLETED assistant message, so the tool/agent
  // runs stay visible after the response finishes (collapsed by default).
  function completedActivity(message: StoredMessage) {
    const activity = message.response?.activity;
    return activity && (activity.tools.length || activity.tasks?.length) ? activity : null;
  }
  function completedActivityLabel(activity: AgentActivity): string {
    const toolCount = activity.tools.filter((t) => t.kind === "tool").length;
    const taskCount = (activity.tasks?.length || 0) + activity.tools.filter((t) => t.kind === "task").length;
    const agentCount = activity.agents.filter((a) => !a.isMain).length;
    return activityCountLabel(toolCount, taskCount, agentCount, "사용함", "작업 내역");
  }

  // Second-brain captures ride the activity rows as kind:"memory", but render
  // as a chip on the SUMMARY line — visible while the disclosure is collapsed
  // (ActivityTree deliberately skips them, so they never appear inside).
  function memoryChip(
    tools: Array<{ kind: string; label: string; detail?: string }>,
  ): { label: string; title: string } | null {
    const rows = tools.filter((t) => t.kind === "memory");
    if (!rows.length) return null;
    return {
      label: rows.length === 1 ? rows[0].label : `기억 ${rows.length}건 저장됨`,
      title: rows.map((r) => [r.label, r.detail].filter(Boolean).join(" · ")).join("\n"),
    };
  }

  // Context compactions ride the activity rows as kind:"compact" and DO render
  // inside the tree (unlike 기억), but the card is collapsed by default — so the
  // summary line also carries a chip: a compaction nobody notices is exactly the
  // gap this row exists to close. Failure says so in its TEXT, not by colour.
  function compactChip(
    tools: Array<{ kind: string; label: string; detail?: string; status?: string }>,
  ): { icon: string; label: string; title: string } | null {
    const rows = tools.filter((t) => t.kind === "compact");
    if (!rows.length) return null;
    const failed = rows.some((r) => r.status === "failed");
    return {
      icon: failed ? "⚠️" : "✂️",
      label: failed
        ? "맥락 정리 실패"
        : rows.length === 1
          ? "맥락 요약됨"
          : `맥락 ${rows.length}회 요약됨`,
      title: rows.map((r) => [r.label, r.detail].filter(Boolean).join(" · ")).join("\n"),
    };
  }

  // Which collapsed "생각 과정" / "작업 내역" cards the user has opened, keyed by
  // `${messageKey}:${card}`. <details> only HIDES its children, so a body left in
  // the template still costs a full markdown parse (thinking) or an ActivityTree
  // mount (activity) for every message in the transcript, on a card almost nobody
  // opens. Rendering on first open keeps a long transcript's mount cost flat.
  // Trade-off: Chrome's find-in-page can no longer reach inside an unopened card.
  let expandedCards = new Set<string>();
  function cardKey(message: StoredMessage, card: "thinking" | "activity"): string {
    return `${message.id || message.createdAt}:${card}`;
  }
  function toggleCard(key: string, event: Event): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (open === expandedCards.has(key)) return;
    if (open) expandedCards.add(key);
    else expandedCards.delete(key);
    expandedCards = expandedCards;
  }
</script>

<svelte:window on:keydown={onGlobalKeydown} />

{#snippet attachmentCards(item: ChatPane, atts: MessageAttachment[], source: MessageAttachment[] | undefined)}
  <div class="msg-images">
    {#each atts as att (att.id)}
      {#if att.kind === "file"}
        <button class="msg-file-card" type="button" on:click={() => openFilePreview(item, att, source)}>
          <span class="msg-file-icon" aria-hidden="true"><Icon name="file" /></span>
          <span class="msg-file-meta">
            <span class="msg-file-name">{att.name || "파일"}</span>
            <span class="msg-file-info">{att.size ? `${formatFileSize(att.size)} · ` : ""}열기</span>
          </span>
        </button>
      {:else}
        <figure class="msg-image-item">
          <a class="msg-image-link" href={`/api/conversations/${encodeURIComponent(item.conversationId)}/images/${encodeURIComponent(att.id)}`} target="_blank" rel="noopener noreferrer">
            <img class="msg-image" src={`/api/conversations/${encodeURIComponent(item.conversationId)}/images/${encodeURIComponent(att.id)}`} alt={att.caption || att.name || "생성된 이미지"} loading="lazy" />
          </a>
          {#if att.caption}<figcaption class="msg-image-caption">{att.caption}</figcaption>{/if}
        </figure>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet botTaskCards(item: ChatPane, anchor: number)}
  {#each inlineBotTasks.get(item.id)?.get(anchor) ?? NO_BOT_TASKS as task (task.id)}
    <!-- compact: the card is an annotation between message bubbles, not a
         competing surface, and its density must not depend on whichever view
         happens to mount this transcript. -->
    <BotTaskCard
      {task}
      busy={cancellingBotTaskId === task.id}
      compact
      onCancel={cancelInlineBotTask}
    />
  {/each}
{/snippet}

{#snippet transcript(item: ChatPane)}
  <div class="chat-body">
    <div
      class="transcript scroll-thin"
      use:transcriptStick={item.id}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={item.streaming ? "true" : "false"}
    >
      <div class="transcript-inner">
        {#if !item.messages.length && !item.streaming}
          {@const own = isOwnPane(item)}
          <div class="empty-state">
            <AvatarImage user={item.avatar} size={72} alt="" />
            <div class="hero">
              <h3>{item.avatar.alias || item.avatar.displayName} 아바타와 대화</h3>
              <p>{item.avatar.bio || (item.avatar.elevated || own ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.")}</p>
            </div>
            {#if own && !isExternalPane(item)}
              <!-- The owner's own avatar gets guided tours instead of generic
                   chips: a first-time owner needs to see what the avatar can do,
                   not a prompt they still have to judge. Colleague, group-agent
                   and external panes keep the chips (isOwn is false for all
                   three, group agents included). -->
              <div class="starter-prompts tour-cards" role="group" aria-label="체험 시나리오">
                <p class="tour-caption">처음이라면 이 중 하나로 시작해 보세요. 카드를 누르면 입력창에 준비됩니다.</p>
                {#each tourScenarios as scenario (scenario.slug)}
                  <button class="starter-prompt tour-card" type="button" on:click={() => useTour(item, scenario)}>
                    <strong>{scenario.titleKo}</strong>
                    <small>{scenario.descriptionKo}</small>
                    <span class="tag">{scenario.durationKo}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="starter-prompts" role="group" aria-label="시작 프롬프트">
                {#each (item.avatar.elevated || own ? ["내가 지금 맡길 수 있는 일을 3가지로 제안해줘.", "이 대화에서 필요한 배경 정보를 먼저 물어봐줘.", "반복해서 실행할 예약 작업을 같이 설계해줘."] : ["이 아바타가 잘 아는 분야를 요약해줘.", "내 질문에 답하기 전에 필요한 맥락을 물어봐줘.", "관련된 지식을 바탕으로 핵심만 정리해줘."]) as text}
                  <button class="starter-prompt" type="button" on:click={() => useStarter(item, text)}>{text}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {@render botTaskCards(item, -1)}

        {#each item.messages as message, index (message.id || `${message.role}-${message.createdAt}-${index}`)}
          <div class={`message ${message.role}`}>
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{message.role === "user" ? "나" : item.avatar.alias || item.avatar.displayName}</span>
              <!-- A message the viewer sent WHILE the avatar was answering. The
                   badge is what tells it apart from an ordinary turn: it landed
                   between the previous turn's tool calls, not after it. -->
              {#if message.role === "user" && message.kind === "steer"}<span class="tag steer-badge">응답 중 전달</span>{/if}
              {#if message.createdAt}<time class="msg-time" datetime={message.createdAt}>{timeLabel(message.createdAt)}</time>{/if}
            </div>
            <div class={`bubble ${message.response?.summary === "오류" ? "errored" : ""}`}>
              {#if message.role === "assistant"}
                {@const activity = completedActivity(message)}
                {#if runtimeBadge(message)}
                  <div class="response-meta"><span class="meta-badge">{runtimeBadge(message)}</span></div>
                {/if}
                {#if message.response?.thinking}
                  {@const thinkingKey = cardKey(message, "thinking")}
                  <details class="thinking-card" on:toggle={(event) => toggleCard(thinkingKey, event)}>
                    <summary class="thinking-card-head"><span class="tag thinking-card-badge">생각 과정</span></summary>
                    {#if expandedCards.has(thinkingKey)}
                      <div class="md thinking-card-body" use:enhanceMarkdown={message.response.thinking}>{@html renderMarkdownCached(message.response.thinking)}</div>
                    {/if}
                  </details>
                {/if}
                {#if message.response?.plan}
                  <details class="plan-card" open>
                    <summary class="plan-card-head"><span class="tag plan-card-badge">계획</span><span class="plan-card-hint">계획 모드</span></summary>
                    <div class="md plan-card-body" use:enhanceMarkdown={message.response.plan}>{@html renderMarkdownCached(message.response.plan)}</div>
                  </details>
                {/if}
                {#each segmentAttachments(messageText(message), message.attachments) as seg, segIndex (segIndex)}
                  {#if seg.text}
                    <div class="md" use:enhanceMarkdown={seg.text}>{@html renderMarkdownCached(seg.text)}</div>
                  {/if}
                  {#if seg.atts.length}
                    {@render attachmentCards(item, seg.atts, message.attachments)}
                  {/if}
                {/each}
                <!-- BELOW the answer, mirroring the live bubble: the card is a
                     footnote about how the answer was made, and keeping the two
                     positions identical means nothing teleports when a stream
                     finalizes into a stored message. -->
                {#if activity}
                  {@const activityKey = cardKey(message, "activity")}
                  {@const memChip = memoryChip(activity.tools)}
                  {@const cmpChip = compactChip(activity.tools)}
                  <details class="activity-live activity-done" on:toggle={(event) => toggleCard(activityKey, event)}>
                    <summary>
                      <span class="activity-summary-text">{completedActivityLabel(activity)}</span>
                      {#if memChip}<span class="activity-memory-chip" title={memChip.title}><span aria-hidden="true">🧠</span>{memChip.label}</span>{/if}
                      {#if cmpChip}<span class="activity-memory-chip" title={cmpChip.title}><span aria-hidden="true">{cmpChip.icon}</span>{cmpChip.label}</span>{/if}
                    </summary>
                    {#if expandedCards.has(activityKey)}
                      <div class="agent-activity">
                        <ActivityTree agentId="main" agents={activity.agents} tools={activity.tools} tasks={activity.tasks || []} />
                      </div>
                    {/if}
                  </details>
                {/if}
              {:else}
                {#if visibleAttachments(message.attachments).length}
                  <div class="msg-images">
                    {#each visibleAttachments(message.attachments) as att (att.id)}
                      <figure class="msg-image-item">
                        <a class="msg-image-link" href={imageSrc(message, att, item)} target="_blank" rel="noopener noreferrer">
                          <img class="msg-image" src={imageSrc(message, att, item)} alt={att.caption || att.name || "첨부 이미지"} loading="lazy" />
                        </a>
                        {#if att.caption}<figcaption class="msg-image-caption">{att.caption}</figcaption>{/if}
                      </figure>
                    {/each}
                  </div>
                {/if}
                {#if message.content}{message.content}{/if}
              {/if}
            </div>
            <div class="msg-actions">
              <button class="msg-act" type="button" aria-label="복사" title="복사" on:click={(event) => copyMessage(message, event)}><Icon name="copy" /></button>
              {#if message.role === "user"}
                <button class="msg-act" type="button" aria-label="편집" title="편집 후 다시 보내기" on:click={() => editMessage(item, message)}><Icon name="edit" /></button>
              {:else if index === item.messages.length - 1 && !item.streaming}
                <button class="msg-act regen" type="button" aria-label="다시 생성" title="다시 생성" on:click={() => regenerate(item.id)}><Icon name="refresh" /></button>
              {/if}
            </div>
          </div>
          {@render botTaskCards(item, index)}
        {/each}

        {#if item.streaming}
          <!-- Accepted by the server, not handed to the model yet. Rendered from
               `item.steers` (named in the markup, so legacy-mode tracking sees
               it) and replaced by the persisted user row on `steer{delivered}`.
               Above the live bubble: it is waiting on the answer below it. -->
          {#each item.steers ?? [] as steer (steer.id)}
            <div class="message user steer-pending">
              <div class="msg-role">
                <span class="role-dot"></span>
                <span>나</span>
                <span class="tag steer-badge">전달 대기 중</span>
              </div>
              <div class="bubble">{steer.text}</div>
            </div>
          {/each}
          <div class="message assistant" aria-live="off">
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{item.avatar.alias || item.avatar.displayName}</span>
            </div>
            <div class="bubble">
              {#if item.liveThinking}
                <details class="thinking-card" class:thinking-card-active={item.thinkingActive}>
                  <summary class="thinking-card-head">
                    <span class="tag thinking-card-badge">생각 과정</span>
                    {#if item.thinkingActive}
                      <span class="thinking-card-hint">생각 중…</span>
                      <span class="thinking-card-spin" aria-hidden="true"></span>
                    {/if}
                  </summary>
                  <div class="md thinking-card-body" use:enhanceMarkdown={item.liveThinking}>{@html renderMarkdown(item.liveThinking)}</div>
                </details>
              {/if}
              {#if item.livePlan}
                <details class="plan-card" open>
                  <summary class="plan-card-head"><span class="tag plan-card-badge">계획</span><span class="plan-card-hint">{item.planReview ? "승인 대기 중" : "계획 모드"}</span></summary>
                  <div class="md plan-card-body" use:enhanceMarkdown={item.livePlan}>{@html renderMarkdown(item.livePlan)}</div>
                  {#if item.planReview}
                    {@const planStatus = planReviewStatusText(item)}
                    <div class="plan-actions" aria-busy={item.planReviewSubmitting ? "true" : "false"} aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined}>
                      {#if planRejectPaneId === item.id}
                        <textarea
                          class="plan-feedback"
                          rows="2"
                          placeholder="수정할 점을 알려주세요 (선택)"
                          bind:value={planFeedback}
                          aria-label="계획 수정 요청 내용"
                          aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined}
                          aria-invalid={planReviewErrors[item.id] ? "true" : undefined}
                          disabled={item.planReviewSubmitting}
                        ></textarea>
                        <div class="plan-actions-row">
                          <button class="btn btn-ghost btn-sm" type="button" aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined} disabled={item.planReviewSubmitting} on:click={cancelRejectPlan}>취소</button>
                          <button class="btn btn-primary btn-sm" type="button" aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined} disabled={item.planReviewSubmitting} on:click={() => submitRejectPlan(item)}>수정 요청 보내기</button>
                        </div>
                      {:else}
                        <div class="plan-actions-row">
                          <button class="btn btn-ghost btn-sm" type="button" aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined} disabled={item.planReviewSubmitting} on:click={() => startRejectPlan(item)}>수정 요청</button>
                          <button class="btn btn-primary btn-sm" type="button" aria-describedby={planStatus ? paneDomId("plan-review-status", item.id) : undefined} disabled={item.planReviewSubmitting} on:click={() => approvePlan(item)}>승인</button>
                        </div>
                      {/if}
                      {#if planStatus}
                        <div id={paneDomId("plan-review-status", item.id)} class="plan-review-status" class:invalid={Boolean(planReviewErrors[item.id])} role="status" aria-live="polite">{planStatus}</div>
                      {/if}
                    </div>
                  {/if}
                </details>
              {:else if item.planPending}
                <div class="plan-card plan-card-pending">
                  <div class="plan-card-head"><span class="tag plan-card-badge">계획</span><span class="plan-card-hint">계획을 작성하는 중…</span><span class="plan-card-spin" aria-hidden="true"></span></div>
                </div>
              {/if}
              {#each segmentAttachments(item.liveText, item.liveAttachments) as seg, segIndex (segIndex)}
                {#if seg.text || (seg.tail && item.liveText)}
                  <div class="md" use:enhanceMarkdown={seg.text}>{@html renderMarkdown(seg.text)}{#if seg.tail}<span class="stream-caret" aria-hidden="true"></span>{/if}</div>
                {/if}
                {#if seg.atts.length}
                  {@render attachmentCards(item, seg.atts, item.liveAttachments)}
                {/if}
              {/each}
              <!-- BELOW the streamed text, at the reading edge, for two reasons
                   that are both about motion: the card GROWS as tools run, and at
                   the top every growth spurt shoved the text the user was reading
                   downward; and the text grows too, which at the top pushed the
                   one live "what is it doing right now" signal ever further from
                   where the eyes are. At the bottom both kinds of growth extend
                   the bubble's edge instead, which is exactly what autoscroll
                   already follows. -->
              {#if item.liveAgents.length}
                {@const liveMemChip = memoryChip(item.liveTools)}
                {@const liveCmpChip = compactChip(item.liveTools)}
                <details class="activity-live" open>
                  <summary>
                    <span class="activity-summary-text">{activitySummary(item)}</span>
                    {#if liveMemChip}<span class="activity-memory-chip" title={liveMemChip.title}><span aria-hidden="true">🧠</span>{liveMemChip.label}</span>{/if}
                    {#if liveCmpChip}<span class="activity-memory-chip" title={liveCmpChip.title}><span aria-hidden="true">{liveCmpChip.icon}</span>{liveCmpChip.label}</span>{/if}
                  </summary>
                  <div class="agent-activity">
                    <ActivityTree agentId="main" agents={item.liveAgents} tools={item.liveTools} tasks={item.liveTasks} />
                  </div>
                </details>
              {/if}
              {#if item.backgroundPhase}
                <!-- The visible turn is finalized (bubble above), but SDK background
                     tasks keep the session alive; the stop button cancels them. -->
                <div class="bg-task-note" role="status">
                  <span class="bg-task-dot" aria-hidden="true"></span>
                  <span class="bg-task-text">
                    {item.backgroundTasks?.length
                      ? `백그라운드 작업 ${item.backgroundTasks.length}개 진행 중 · ${bgTaskSummary(item)}`
                      : "백그라운드 작업 마무리 중…"}
                  </span>
                </div>
              {/if}
              <div class="stream-status">
                <span class="spinner"></span>
                <span class="label">{item.liveStatus || "응답 생성 중…"}</span>
              </div>
              {#if item.livePlugins.length}
                <div class="plugin-chips">
                  {#each item.livePlugins as chip (chip.name)}
                    <span class="plugin-chip" data-status={chip.status}>
                      <span class="pc-dot"></span>
                      <span class="pc-text">{chip.name} · {PLUGIN_STATUS_LABELS[chip.status] || chip.status}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
    {#if item.stickBottom === false}
      <button class="scroll-bottom" type="button" aria-label="맨 아래로" title="맨 아래로" on:click={() => scrollToBottom(item)}><Icon name="arrow-down" /></button>
    {/if}
  </div>
{/snippet}

{#snippet composer(item: ChatPane, compact: boolean, index: number)}
  <footer class="composer">
    <div class="composer-inner">
      <form class="composer-form" on:submit|preventDefault={() => submit(item)}>
        {#if slashPaneId === item.id}
          {@const matches = slashMatches(item)}
          {#if matches.length}
            <div id={paneDomId("slash-menu", item.id)} class="slash-menu" role="listbox" aria-label="슬래시 명령">
              <div class="slash-menu-head">슬래시 명령</div>
              {#each matches as cmd, i}
                <button
                  id={slashOptionId(item.id, i)}
                  class="slash-option"
                  class:active={i === Math.min(slashIndex, matches.length - 1)}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex ? "true" : "false"}
                  on:mousedown|preventDefault={() => {}}
                  on:click={() => applySlash(item, cmd)}
                >
                  <span class="slash-option-command">
                    /{cmd.name}{cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}
                    {#if cmd.kind === "skill"}<span class="slash-option-tag">스킬{cmd.source && cmd.source !== "default" ? ` · ${cmd.source}` : ""}</span>{/if}
                  </span>
                  <span class="slash-option-main"><strong>{cmd.title}</strong><span>{cmd.description}</span></span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
        {#if !isExternalPane(item) && item.pendingImages?.length}
          <div class="composer-attachments" aria-label="첨부한 이미지">
            {#each item.pendingImages as img (img.id)}
              <div class="composer-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <button
                  class="composer-thumb-remove"
                  type="button"
                  aria-label="이미지 제거"
                  title="제거"
                  disabled={item.streaming}
                  on:click={() => removePendingImage(item, img.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div
          class="composer-box"
          class:no-attach={isExternalPane(item)}
          class:no-stt={!$appState.bootstrap?.sttEnabled}
          class:with-steer={canSteer(item)}
        >
          {#if !isExternalPane(item)}
            <label
              class="composer-attach"
              class:disabled={item.streaming}
              title={attachHint(item, $appState)}
              aria-label={attachHint(item, $appState)}
            >
              <Icon name="image" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                disabled={item.streaming}
                on:change={(event) => onPickImages(event, item)}
              />
            </label>
          {/if}
          <!-- Intentionally NOT disabled while streaming: disabling blurs the
               textarea (focus loss after every send) and blocks composing the
               next message. On a local pane what is typed mid-stream can now be
               SENT into the running turn (see `canSteer`); on an external one it
               is still only a head start on the next turn. -->
          <textarea
            rows="1"
            placeholder={item.streaming ? streamingPlaceholder(item, enterSends) : `${item.avatar.alias || item.avatar.displayName}에게 메시지…`}
            value={item.draft}
            aria-label={`${item.avatar.alias || item.avatar.displayName}에게 보낼 메시지`}
            aria-describedby={paneDomId("composer-hint", item.id)}
            use:autosize={item.draft}
            aria-controls={activeSlashDescendant[item.id] ? paneDomId("slash-menu", item.id) : undefined}
            aria-haspopup="listbox"
            aria-activedescendant={activeSlashDescendant[item.id]}
            on:input={(event) => onComposerInput(event, item)}
            on:keydown={(event) => onComposerKeydown(event, item)}
            on:paste={(event) => onComposerPaste(event, item)}
          ></textarea>
          {#if $appState.bootstrap?.sttEnabled}
            {@const owns = sttPaneId === item.id}
            {@const busy = Boolean(sttPaneId) && !owns}
            {@const recording = owns && sttPhase === "recording"}
            {@const transcribing = owns && sttPhase === "transcribing"}
            {@const micLabel = busy
              ? "다른 대화에서 녹음 중입니다"
              : transcribing
                ? "전사 중…"
                : recording
                  ? "녹음 중지"
                  : "음성 입력"}
            <!-- The shortcut rides the title, not the accessible name: it is
                 discoverability, and `aria-keyshortcuts` is where a screen
                 reader expects to find it. Only the two states the shortcut
                 actually drives advertise it. -->
            {@const micTitle = busy || transcribing ? micLabel : `${micLabel} (Alt+M)`}
            <!-- Deliberately NOT hidden while streaming: the composer stays
                 editable mid-stream, so dictating the next message must work too. -->
            <button
              class="composer-mic"
              class:recording
              type="button"
              aria-label={micLabel}
              aria-keyshortcuts="Alt+M"
              aria-pressed={recording ? "true" : "false"}
              title={micTitle}
              disabled={busy || transcribing}
              on:click={() => toggleVoiceInput(item)}
            >
              <Icon name={recording ? "stop" : "mic"} />
            </button>
          {/if}
          <!-- Mid-turn send, LEFT of the stop button: two different actions on a
               streaming turn — hand the model another message, or kill the run —
               so they are two controls, never one that changes meaning. It stays
               mounted for the whole stream and merely disables, so the row never
               reflows mid-keystroke and the affordance is visible BEFORE the
               user has typed anything to use it on. -->
          {#if canSteer(item)}
            <button
              class="send-button steer-send"
              type="button"
              aria-label="응답 중 메시지 보내기"
              title={steerSendTitle(item)}
              disabled={item.steerSending || !item.draft.trim()}
              on:click={() => sendSteer(item.id, item.draft)}
            >
              <Icon name="send" />
            </button>
          {/if}
          <button
            class="send-button"
            class:is-stop={item.streaming}
            type="button"
            aria-label={item.streaming ? "응답 중지" : "보내기"}
            title={item.streaming ? "응답 중지" : canSendMessage(item) ? "보내기" : emptyComposerHint(item, $appState)}
            disabled={!item.streaming && !canSendMessage(item)}
            on:click={() => (item.streaming ? stopPane(item.id) : submit(item))}
          >
            <Icon name={item.streaming ? "stop" : "send"} />
          </button>
        </div>
        <div class="composer-hint" id={paneDomId("composer-hint", item.id)}>
          {#if compact}
            <span>대화 {index + 1}</span>
          {:else if enterSends}
            <span>Enter 전송 · <kbd>Shift+Enter</kbd> 줄바꿈</span>
          {:else}
            <span>보내기 버튼으로 전송</span>
          {/if}
          {#if hasComposerControls(item) || formatUsageLabel(item.usage) || (sttPaneId === item.id && sttPhase)}
            <span class="composer-meta">
              {#if sttPaneId === item.id && sttPhase}
                <span class="composer-stt" data-phase={sttPhase}
                  >{sttPhase === "recording" ? `녹음 중 ${sttElapsed}초 / ${STT_MAX_SEC}초` : "전사 중…"}</span
                >
                <!-- Its own span, and only once the detector is actually
                     listening: the counter must stay on one line, this may wrap. -->
                {#if sttPhase === "recording" && sttAutoStop}
                  <span>말이 끝나면 자동으로 멈춰요</span>
                {/if}
              {/if}
              {#if hasComposerControls(item)}
                <button
                  class="composer-settings-btn"
                  type="button"
                  aria-expanded={composerSettingsOpenPaneId === item.id ? "true" : "false"}
                  aria-controls={paneDomId("composer-controls", item.id)}
                  title="이 대화의 모델, 사고 강도, 지식, MCP 도구를 설정합니다"
                  on:click={() => toggleComposerSettings(item)}
                >
                  <Icon name="gear" size={16} />
                  <span class="composer-settings-label">설정</span>
                  <span class="composer-settings-summary">{composerSettingsSummary(item, adminBlockedMcpToolGroupSet)}</span>
                </button>
                <span id={paneDomId("composer-controls", item.id)} class="composer-controls" class:open={composerSettingsOpenPaneId === item.id}>
                  {#if isExternalPane(item)}
                    <select
                      class="composer-model-select"
                      aria-label="이 대화에 사용할 Gateway 모델"
                      title="이 대화에서 다음 메시지부터 사용할 Gateway 모델을 고릅니다"
                      value={item.modelTier ?? ""}
                      disabled={item.externalModels === undefined}
                      on:change={(event) => setExternalModel(item, event.currentTarget.value)}
                    >
                      <option value="">
                        {item.externalModels === undefined
                          ? "모델 목록 불러오는 중…"
                          : item.externalDefaultModel
                            ? `기본 (${item.externalDefaultModel})`
                            : "기본 모델"}
                      </option>
                      {#each (item.externalModels ?? []).filter((id) => id !== item.externalDefaultModel) as modelId (modelId)}
                        <option value={modelId}>{modelId}</option>
                      {/each}
                    </select>
                  {:else}
                  {#if $appState.bootstrap?.modelSelection?.tiers.length}
                    <select
                      class="composer-model-select"
                      aria-label="이 대화에 사용할 모델"
                      title={canPickModel() ? "이 대화에서 다음 메시지부터 사용할 모델을 고릅니다" : "서버 설정으로 모델이 고정되어 있습니다"}
                      value={currentModelTier(item)}
                      disabled={!canPickModel()}
                      on:change={(event) => setModelTier(item, event.currentTarget.value)}
                    >
                      {#each $appState.bootstrap.modelSelection.tiers as tier (tier.id)}
                        <option value={tier.id} title={tier.model ? `${tier.description}\n(${tier.model})` : tier.description}>
                          {tier.label}{tier.model ? ` · ${tier.model}` : ""}
                        </option>
                      {/each}
                    </select>
                  {/if}
                  {#if $appState.bootstrap?.effortSelection}
                    <select
                      class="composer-model-select"
                      aria-label="이 대화에 사용할 사고 강도(effort)"
                      title="이 대화에서 다음 메시지부터 모델이 들이는 사고/추론 강도를 고릅니다"
                      value={item.effort ?? $appState.bootstrap.effortSelection.default ?? DEFAULT_EFFORT_LEVEL}
                      on:change={(event) => setEffort(item, event.currentTarget.value)}
                    >
                      {#each $appState.bootstrap.effortSelection.levels as level (level.id)}
                        <option value={level.id} title={level.description}>{level.label}</option>
                      {/each}
                    </select>
                  {/if}
                  {#if eligibleGroups(item).length}
                    {@const groups = eligibleGroups(item)}
                    {@const onCount = groups.filter((g) => !(item.groupKnowledgeOff || []).includes(g.id)).length}
                    <button
                      class="composer-gk-btn"
                      type="button"
                      aria-expanded={gkOpenPaneId === item.id ? "true" : "false"}
                      aria-controls={paneDomId("composer-gk-panel", item.id)}
                      title="이 대화에서 다음 메시지부터 사용할 그룹 지식을 고릅니다"
                      on:click={() => toggleGroupKnowledgePanel(item)}
                    >그룹 지식 {onCount}/{groups.length}</button>
                  {/if}
                  <button
                    class="composer-tools-btn"
                    type="button"
                    aria-expanded={mcpToolsOpenPaneId === item.id ? "true" : "false"}
                    aria-controls={paneDomId("composer-tools-panel", item.id)}
                    title="이 대화에서 다음 메시지부터 사용할 MCP 도구 묶음을 고릅니다"
                    on:click={() => toggleMcpToolsPanel(item)}
                  >MCP 도구 {selectedMcpToolGroups(item).filter((id) => !adminBlockedMcpToolGroupSet.has(id)).length}/{MCP_TOOL_GROUPS.length}</button>
                  {/if}
                </span>
              {/if}
              {#if formatUsageLabel(item.usage)}
                <span class="composer-usage">{formatUsageLabel(item.usage)}</span>
              {/if}
              {#if bridgeCompat && !isExternalPane(item) && selectedMcpToolGroups(item).includes("browser") && !adminBlockedMcpToolGroupSet.has("browser")}
                {@const badge = bridgeBadge(bridgeCompat)}
                {#if bridgeCompat.level === "current"}
                  <span class="composer-bridge" data-status="current" title={badge.title}>{badge.text}</span>
                {:else}
                  <!-- Any badge that reports something ACTIONABLE is a dead end
                       without a way out: make the whole line the button to the
                       install guide — including `compatible`, where the action
                       is optional but real. Only the exact-match install stays a
                       plain span, so the hint row keeps no control nobody needs. -->
                  <button
                    class="composer-bridge"
                    type="button"
                    data-status={bridgeCompat.level}
                    title={`${badge.title}\n\n눌러서 설치·업데이트 안내를 엽니다.`}
                    on:click={openBrowserBridgeGuide}
                  >{badge.text} →</button>
                {/if}
              {/if}
            </span>
          {/if}
        </div>
      </form>
      {#if gkOpenPaneId === item.id && eligibleGroups(item).length}
        <div
          id={paneDomId("composer-gk-panel", item.id)}
          class="composer-gk-panel"
          role="group"
          aria-label="이 대화에서 사용할 그룹 지식"
          use:clickOutside={{ onOutside: () => (gkOpenPaneId = ""), ignore: ".composer-gk-btn" }}
        >
          <div class="composer-gk-title">이 대화에서 사용할 그룹 지식</div>
          {#each eligibleGroups(item) as group (group.id)}
            <label class="composer-gk-item">
              <input
                type="checkbox"
                checked={!(item.groupKnowledgeOff || []).includes(group.id)}
                on:change={(event) => setGroupKnowledge(item, group.id, event.currentTarget.checked)}
              />
              <span>{group.name}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if !isExternalPane(item) && mcpToolsOpenPaneId === item.id}
        <div
          id={paneDomId("composer-tools-panel", item.id)}
          class="composer-tools-panel"
          role="group"
          aria-label="이 대화에서 사용할 MCP 도구"
          use:clickOutside={{ onOutside: () => (mcpToolsOpenPaneId = ""), ignore: ".composer-tools-btn" }}
        >
          <div class="composer-tools-title">이 대화에서 사용할 MCP 도구</div>
          {#each MCP_TOOL_GROUPS as group (group.id)}
            {@const adminBlocked = adminBlockedMcpToolGroupSet.has(group.id)}
            <label class="composer-tools-item">
              <input
                type="checkbox"
                checked={selectedMcpToolGroups(item).includes(group.id) && !adminBlocked}
                disabled={isRequiredMcpToolGroup(group.id) || adminBlocked}
                on:change={(event) => setMcpToolGroup(item, group.id, event.currentTarget.checked)}
              />
              <span>
                <strong>{group.labelKo}</strong>
                <small>{isRequiredMcpToolGroup(group.id) ? "항상 사용 · 매뉴얼과 시스템 상태를 확인합니다. 설정 변경은 기존 권한을 따릅니다." : adminBlocked ? "관리자의 그룹 도구 정책으로 제한된 도구 묶음입니다" : group.descriptionKo}</small>
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  </footer>
{/snippet}

{#snippet splitControls()}
  <div class="split-controls" role="group" aria-label="분할 대화">
    {#if panes.length > 1}
      {#each ["vertical", "horizontal", "grid"] as layout}
        <button
          type="button"
          class="split-btn"
          class:active={$appState.chatLayout === layout}
          aria-label={layout === "vertical" ? "좌우 분할" : layout === "horizontal" ? "상하 분할" : "격자 분할"}
          aria-pressed={$appState.chatLayout === layout ? "true" : "false"}
          on:click={() => updateState((state) => (state.chatLayout = layout as typeof state.chatLayout))}
        >
          <Icon name={layout === "vertical" ? "columns" : layout === "horizontal" ? "rows" : "grid"} />
        </button>
      {/each}
    {/if}
    <select class="split-avatar-select" bind:value={splitAvatarId} disabled={splitAddBusy || !splitOptions.length || panes.length >= 4} aria-label="분할로 추가할 아바타">
      {#if splitOptions.length}
        {#each splitOptions as av}
          <option value={av.id}>{av.alias || av.displayName || av.username}</option>
        {/each}
      {:else}
        <option value="">추가할 아바타 없음</option>
      {/if}
    </select>
    <button class="split-add" type="button" title="대화 추가 (분할)" aria-label="대화 추가 (분할)" disabled={splitAddBusy || !splitOptions.length || panes.length >= 4} on:click={addSplitPane}>
      <Icon name="plus" />
    </button>
  </div>
{/snippet}

{#if !pane}
  <header class="view-header">
    <div>
      <h1>대화</h1>
      <p>탐색에서 아바타를 골라 대화를 시작하세요</p>
    </div>
  </header>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="view-body" class:drop-active={dropActive} on:dragover={onWorkbenchDragOver} on:dragleave={onWorkbenchDragLeave} on:drop={onWorkbenchDrop}>
    <div class="empty-state">
      <div class="hero">
        <h3>아직 선택한 아바타가 없습니다</h3>
        <p>탐색 탭에서 대화할 아바타를 골라 주세요. 왼쪽 대화 목록에서 대화를 끌어와 열 수도 있습니다.</p>
      </div>
      <button class="primary" type="button" on:click={() => goView("explore")}>대화할 아바타 찾기</button>
    </div>
  </div>
{:else if panes.length > 1}
  <header class="view-header chat-head">
    <div class="header-left">
      <div class="title">
        <h1>분할 대화</h1>
        <p>최대 4개의 대화를 동시에 진행할 수 있습니다.</p>
      </div>
    </div>
    <div class="chat-head-actions">
      {@render splitControls()}
      <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
    </div>
  </header>

  <div class="chat-layout">
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class={`chat-workbench ${splitClass}`}
      class:drop-active={dropActive}
      on:dragover={onWorkbenchDragOver}
      on:dragleave={onWorkbenchDragLeave}
      on:drop={onWorkbenchDrop}
    >
      {#each panes as item, index (item.id)}
        <section
          class="chat-col chat-pane compact"
          class:active={item.id === pane.id}
          data-pane={item.id}
          aria-labelledby={paneDomId("pane-title", item.id)}
          aria-current={item.id === pane.id ? "true" : undefined}
          on:focusin={() => setActive(item.id)}
        >
          <div class="pane-head">
            <button
              id={paneDomId("pane-title", item.id)}
              class="pane-title pane-title-button"
              type="button"
              aria-pressed={item.id === pane.id ? "true" : "false"}
              on:click={() => setActive(item.id)}
            >
              <AvatarImage user={item.avatar} size={30} alt="" />
              <div>
                <strong>대화 {index + 1}</strong>
                <span>{item.avatar.alias || item.avatar.displayName}</span>
              </div>
            </button>
            <div class="pane-actions">
              <button class="ghost-sm" type="button" disabled={item.streaming} on:click|stopPropagation={() => newChat(item.id)}>새 대화</button>
              <button class="msg-act" type="button" aria-label="대화 창 닫기" disabled={panes.length <= 1} on:click|stopPropagation={() => closePane(item.id)}>
                <Icon name="close" />
              </button>
            </div>
          </div>
          {@render transcript(item)}
          {@render composer(item, true, index)}
          <PromptModal paneId={item.id} />
        </section>
      {/each}
    </div>
    <!-- Same side-panel slot as the single-pane branch, for the ACTIVE pane:
         without it a canvas created while split is invisible until the user is
         back to one pane. -->
    {#if pane.filePreview}
      <FilePreviewPanel {pane} />
    {:else if pane.canvases?.length}
      <CanvasPanel {pane} />
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="chat-layout" class:drop-active={dropActive} on:dragover={onWorkbenchDragOver} on:dragleave={onWorkbenchDragLeave} on:drop={onWorkbenchDrop}>
    <section class="chat-col chat-pane active" data-pane={pane.id}>
      <header class="view-header chat-head">
        <div class="header-left">
          <div class="chat-avatar">
            <AvatarImage user={pane.avatar} size={36} alt="" />
            <div>
              <h1 class="ca-name">{pane.avatar.alias || pane.avatar.displayName}</h1>
              <div class="ca-handle">@{pane.avatar.username}{pane.avatar.elevated ? "" : " · 읽기 전용"}</div>
            </div>
          </div>
        </div>
        <div class="chat-head-actions">
          {@render splitControls()}
          <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
        </div>
      </header>
      {@render transcript(pane)}
      {@render composer(pane, false, 0)}
      <PromptModal paneId={pane.id} />
    </section>
    {#if pane.filePreview}
      <FilePreviewPanel {pane} />
    {:else if pane.canvases?.length}
      <CanvasPanel {pane} />
    {/if}
  </div>
{/if}

<style>
  /* Plan-mode plan card (ExitPlanMode). A distinct, collapsible card inside the
     assistant bubble that surfaces the proposed plan — shown live while the turn
     streams and persisted on the finished message (response.plan). */
  .plan-card {
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: var(--r-md);
    background: var(--surface-2);
    margin: var(--s-2) 0;
    overflow: hidden;
  }
  .plan-card-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    list-style: none;
    user-select: none;
    font-size: var(--t-sm);
    min-width: 0;
  }
  .plan-card-head::-webkit-details-marker {
    display: none;
  }
  /* Composes the global `.tag` base (geometry + type scale); only the colour and
     weight deltas that make it read as an accent badge live here. */
  .plan-card-badge {
    font-weight: 700;
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    letter-spacing: 0.02em;
  }
  .plan-card-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t-xs);
  }
  .plan-card-body {
    padding: 0 var(--s-3) var(--s-2);
    min-width: 0;
    max-width: 100%;
  }
  /* Inline approve / reject controls shown on a live plan card while the avatar
     waits for the owner's approval (interactive plan mode). */
  .plan-actions {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: 0 var(--s-3) var(--s-3);
  }
  .plan-actions-row {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }
  .plan-feedback {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--panel);
    color: var(--text);
    padding: var(--s-2);
    font: inherit;
    font-size: var(--t-sm);
  }
  .plan-review-status {
    align-self: flex-end;
    color: var(--muted);
    font-size: var(--t-xs);
  }
  .plan-review-status.invalid {
    color: var(--danger);
  }
  /* Placeholder shown between EnterPlanMode and ExitPlanMode: the avatar is
     composing the plan in the background (tool rows are suppressed for plan
     tools), so without this the turn looks stalled. */
  .plan-card-pending .plan-card-head {
    cursor: default;
  }
  /* Self-contained spinner: the base `.spinner` rule is scoped to `.stream-status`,
     so this placeholder (outside it) must style its own. `spin` is a global keyframe. */
  .plan-card-spin {
    margin-left: auto;
    flex: none;
    width: 12px;
    height: 12px;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  /* Reasoning (extended-thinking) view. Deliberately muted and secondary to the
     answer — collapsed by default on completed bubbles, expanded live so the user
     sees the chain of thought stream (esp. while the answer text is still empty). */
  .thinking-card {
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--line);
    border-left: 3px solid var(--muted);
    border-radius: var(--r-md);
    background: var(--surface-2);
    margin: var(--s-2) 0;
    overflow: hidden;
  }
  .thinking-card-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    list-style: none;
    user-select: none;
    font-size: var(--t-sm);
    min-width: 0;
  }
  .thinking-card-head::-webkit-details-marker {
    display: none;
  }
  /* Chevron affordance (right when closed, down when open) — the badge alone
     doesn't read as expandable on a collapsed card. */
  .thinking-card-head::after {
    content: "";
    margin-left: auto;
    flex: none;
    width: 6px;
    height: 6px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    transform: rotate(-45deg);
    transition: transform 0.15s var(--ease-out);
  }
  .thinking-card[open] .thinking-card-head::after {
    transform: rotate(45deg);
  }
  /* Composes the global `.tag` base (geometry + type scale); only the colour and
     weight deltas that make it read as a muted, secondary badge live here. */
  .thinking-card-badge {
    font-weight: 700;
    background: var(--line);
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  /* Live reasoning indicator: shown on the collapsed card while thinking deltas
     stream, so a closed-by-default card still signals the avatar is thinking. */
  .thinking-card-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--t-xs);
  }
  /* Self-contained spinner: the base `.spinner` rule is scoped to `.stream-status`.
     `spin` is a global keyframe. */
  .thinking-card-spin {
    flex: none;
    width: 12px;
    height: 12px;
    border: 2px solid var(--line);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  /* Dim the card while reasoning is active so a collapsed card reads as
     "working in the background" rather than as finished content. */
  .thinking-card-active {
    opacity: 0.78;
  }
  .thinking-card-body {
    padding: 0 var(--s-3) var(--s-2);
    min-width: 0;
    max-width: 100%;
    color: var(--muted);
    /* One step below the answer prose (.bubble is var(--t-md)) — reasoning stays
       secondary to the answer. */
    font-size: var(--t-base);
  }
</style>
