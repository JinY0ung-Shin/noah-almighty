import { api } from "./api";
import { agentTitle } from "./agentCards";
import { confirmAction } from "./confirm";
import { loadConversations, loadMessages } from "./loaders";
import { syncHash } from "./nav";
import { consumeSse, type SseFrame } from "./sse";
import { ensureNotificationPermission, osNotify } from "./notifications";
import { newId, notify, readState, updateState } from "./state";
import { isDrawioAttachment } from "./drawioViewer";
import { formatTokenCount } from "./format";
import {
  extensionSupportsSecretInput,
  readAllowedOrigins,
  SECRET_INPUT_MIN_EXTENSION_VERSION,
  sendToExtension,
  type BridgeOperation,
  type BridgeReply,
} from "./browserBridge";
import { resolveTypedSlashCommand } from "./slash";
import { DEFAULT_MODEL_TIER } from "../../../server/modelTiers";
import { DEFAULT_EFFORT_LEVEL } from "../../../server/effortLevels";
import {
  MCP_TOOL_LABELS,
  SDK_HIDDEN_ACTIVITY_TOOLS,
  SDK_TOOL_LABELS,
  mcpToolInputSummary,
} from "../../../shared/sdkToolPresentation";
import { DEFAULT_MCP_TOOL_GROUPS } from "../../../shared/mcpToolGroups";
import {
  hasRows,
  rowSegment,
  segmentRows,
  segmentSealTargets,
  type SegmentRows,
} from "./activitySegments";
import type {
  AgentActivity,
  AgentResponse,
  AvatarDetail,
  AvatarSummary,
  BotTask,
  BotTaskStatus,
  CanvasArtifact,
  ChatPane,
  ConversationSummary,
  LiveTaskRow,
  LiveToolRow,
  PaneCanvas,
  SteerPublic,
  StoredMessage,
} from "./types";

const MAX_CHAT_PANES = 4;

// Internal orchestration tools the viewer shouldn't see as activity rows.
const HIDDEN_TOOLS = new Set(SDK_HIDDEN_ACTIVITY_TOOLS);

// Friendly, human-readable labels for tools shown in the activity tree. Raw
// names (e.g. `mcp__knowledge__request_info`) are an implementation detail.
// Both maps live in shared/sdkToolPresentation.ts so the server status line
// uses the SAME labels.
const TOOL_LABELS: Record<string, string> = {
  ...SDK_TOOL_LABELS,
  ...MCP_TOOL_LABELS,
};

export const PLUGIN_STATUS_LABELS: Record<string, string> = {
  started: "불러오는 중",
  installed: "설치됨",
  completed: "사용 준비됨",
  failed: "불러오기 실패",
};

export function humanTool(name: string | undefined): string {
  if (!name) return "도구";
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // Keep in lockstep with sdkToolLabel (src/shared/sdkToolPresentation.ts):
  // server segments may contain underscores (git_repo, group_agent).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return (mcp ? mcp[2] : name).replace(/_/g, " ");
}

// Intelligent one-line summary of a tool's input: prefer a recognizable key
// (command/file_path/path/pattern/url/query/…) over dumping JSON. Mirrors the
// old summarizeInputForCard().
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input);
  if (typeof input !== "object") return truncate(String(input));
  const obj = input as Record<string, unknown>;
  const keys = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
    "description",
    "repo",
    "name",
  ];
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key])
      return truncate(obj[key] as string);
  }
  const firstStr = Object.values(obj).find((v) => typeof v === "string" && v);
  return typeof firstStr === "string"
    ? truncate(firstStr)
    : truncate(JSON.stringify(obj));
}

function truncate(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Korean object particle for a noun the caller interpolates. Every slash
 * command's argsLabel used to end in a consonant ("내용", "작업", "요청"), so a
 * hardcoded "을" read correctly; a vowel-final label like "시나리오" needs "를".
 * Non-Hangul labels fall back to the "을(를)" form used elsewhere in the UI.
 */
function objectParticle(noun: string): string {
  const last = noun.charCodeAt(noun.length - 1);
  if (Number.isNaN(last) || last < 0xac00 || last > 0xd7a3) return "을(를)";
  return (last - 0xac00) % 28 === 0 ? "를" : "을";
}

/**
 * A 내 봇 (personal agent) can carry its own model tier, which outranks the
 * owner's remembered default: the bot was configured to run on that tier, so a
 * fresh thread with it starts there. Validated against the tiers THIS deployment
 * offers — a stored tier the server no longer offers falls back rather than
 * sending an unknown alias.
 */
function personalAgentModelTier(avatar: AvatarDetail): string | undefined {
  const tier = avatar.personalAgent?.defaultModel;
  if (!tier) return undefined;
  const tiers = readState().bootstrap?.modelSelection?.tiers ?? [];
  return tiers.some((item) => item.id === tier) ? tier : undefined;
}

function makePane(
  avatar: AvatarDetail,
  conversationId = newId(),
  messages: StoredMessage[] = [],
  canvasArtifacts: CanvasArtifact[] = [],
): ChatPane {
  const canvases = paneCanvasesFromArtifacts(canvasArtifacts);
  return {
    id: newId(),
    avatar,
    conversationId,
    messages,
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveTextBreakPending: false,
    liveThinking: "",
    thinkingActive: false,
    livePlan: "",
    planPending: false,
    planReview: null,
    planReviewSubmitting: false,
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    groupKnowledgeOff: avatar.isOwn
      ? [...(readState().user?.groupKnowledgeOffDefault || [])]
      : [],
    // Seed the composer pickers from the owner's remembered defaults so the last
    // choice carries to a new conversation (null/undefined = fall back to the
    // hardcoded server/SDK default). selectConversation() overrides these with the
    // per-conversation stored value when resuming an existing thread. External
    // panes stay unseeded: their model slot holds a GATEWAY model id, so a native
    // tier alias must never leak into it (undefined = admin-configured default).
    modelTier:
      avatar.runtime === "external"
        ? undefined
        : (personalAgentModelTier(avatar) ?? readState().user?.modelDefault ?? undefined),
    effort:
      avatar.runtime === "external"
        ? undefined
        : (readState().user?.effortDefault ?? undefined),
    mcpToolGroups: readState().user?.mcpToolGroupsDefault
      ? [...readState().user!.mcpToolGroupsDefault!]
      : [...DEFAULT_MCP_TOOL_GROUPS],
    canvases,
    activeCanvasId: canvases.length ? canvases[canvases.length - 1].id : null,
    stickBottom: true,
    usage: null,
    abortController: null,
  };
}

/**
 * A pane-REPLACING navigation drops panes that may still own a live reader loop
 * (a send's own stream, or a reattach). Nothing else ends those loops, so the
 * dropped pane keeps its SSE connection open until the stream happens to break.
 * Abort them right AFTER the swap: their `finalizePane`/`updatePane` teardown
 * all no-op once the pane is gone from state, and the abort is client-side only
 * — the server run is untouched (only POST /api/chat/runs/:id/cancel ends one),
 * so reattaching to it later still works. Pass the pane list captured BEFORE the
 * swap; whatever survived into the new state is left alone.
 */
function abortDroppedPanes(before: ChatPane[]): void {
  const live = new Set(readState().chatPanes.map((item) => item.id));
  for (const pane of before) {
    if (!live.has(pane.id)) pane.abortController?.abort();
  }
}

/* ---------- delegated bot tasks (봇 오피스) ---------- */

const TERMINAL_BOT_TASK_STATUSES: BotTaskStatus[] = ["done", "failed", "cancelled"];

function botTaskTime(iso: string | null | undefined): number {
  const ms = Date.parse(iso || "");
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * A task row off the wire is UNVALIDATED — it arrives from an SSE frame or a
 * 202 body, neither of which type-checks across the gap. Guarding on the three
 * fields every consumer keys on (identity, which bot, which state) keeps a
 * malformed payload out of the board instead of rendering an empty card.
 */
export function isBotTask(value: unknown): value is BotTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<BotTask>;
  return (
    typeof task.id === "string" &&
    task.id !== "" &&
    typeof task.agentId === "string" &&
    typeof task.status === "string"
  );
}

/** Merge one task row into state.botTasks, newest first. */
export function upsertBotTask(task: BotTask): void {
  updateState((state) => {
    state.botTasks = [task, ...state.botTasks.filter((item) => item.id !== task.id)].sort(
      (a, b) => botTaskTime(b.createdAt) - botTaskTime(a.createdAt),
    );
  });
}

/**
 * Adopt a freshly fetched page of tasks. A local row the run stream already
 * advanced to a TERMINAL status wins over the fetched copy — the poll may have
 * been issued before that transition, and terminal never regresses server-side,
 * so this can only prevent a visible "완료 → 실행 중" flicker. Rows the response
 * doesn't mention are kept for the same reason (they arrived mid-flight).
 */
export function mergeBotTasks(fetched: BotTask[]): void {
  updateState((state) => {
    const merged = new Map<string, BotTask>();
    for (const task of fetched) merged.set(task.id, task);
    for (const local of state.botTasks) {
      const incoming = merged.get(local.id);
      const localIsAhead =
        TERMINAL_BOT_TASK_STATUSES.includes(local.status) &&
        !TERMINAL_BOT_TASK_STATUSES.includes(incoming?.status as BotTaskStatus);
      if (!incoming || localIsAhead) merged.set(local.id, local);
    }
    state.botTasks = [...merged.values()].sort(
      (a, b) => botTaskTime(b.createdAt) - botTaskTime(a.createdAt),
    );
  });
}

/**
 * The status vocabulary 봇 오피스 speaks. It lives here rather than in one of the
 * views because the card (in the transcript), the roster line and the summary
 * bar all name the same states — three copies would drift apart one rename at a
 * time.
 */
export const BOT_TASK_STATUS_LABELS: Record<BotTaskStatus, string> = {
  queued: "대기 중",
  running: "실행 중",
  waiting_input: "입력 대기",
  done: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

/**
 * The states that ASK the owner for something, which is exactly what the server
 * stamps `seenAt` on. A running or queued row is never "unseen": its own motion
 * is the signal, and a cancelled one was ended by the owner while looking at it.
 */
const SETTLED_BOT_TASK_STATUSES: BotTaskStatus[] = ["done", "failed", "waiting_input"];

/** A settled row the owner hasn't looked at yet — the unseen chips count these. */
export function isUnseenBotTask(task: BotTask): boolean {
  return !task.seenAt && SETTLED_BOT_TASK_STATUSES.includes(task.status);
}

/**
 * Cancel a queued task or stop a running one — the same endpoint either way.
 * Lives here because the card that carries the button now renders inside the
 * TRANSCRIPT (ChatView) while the board around it is 봇 오피스; a view-local copy
 * would have to exist twice. The row the server returns is adopted AS-IS: a
 * stopped run does not end here, its terminal state arrives on a later
 * `bot_task` frame or poll, so the toast only claims the request was sent.
 */
export async function cancelBotTask(task: BotTask): Promise<void> {
  const running = task.status === "running";
  try {
    const result = await api<{ task: BotTask; stopping?: boolean }>(
      `/api/me/bot-tasks/${encodeURIComponent(task.id)}/cancel`,
      { method: "POST" },
    );
    if (result?.task) upsertBotTask(result.task);
    notify(
      result?.stopping ? "중지 요청을 보냈어요 — 곧 작업이 종료됩니다" : "작업을 취소했습니다.",
      "ok",
    );
  } catch (err) {
    notify(`작업을 ${running ? "중지" : "취소"}하지 못했습니다: ${(err as Error).message}`, "warn");
  }
}

/**
 * Where each delegated task belongs in the transcript: immediately AFTER the
 * last USER message it postdates, so a card sits next to the turn that spawned
 * it. Bucket `-1` holds tasks older than every message (they render above the
 * first bubble). Both inputs are already chronological, so one merge pass with a
 * forward-only cursor places every task.
 *
 * Pure by design — the caller derives the map in a `$:` and the `{#each}` only
 * LOOKS UP its bucket, because that markup re-runs once per streamed token.
 */
export function anchorBotTasksToMessages(
  tasks: BotTask[],
  messages: StoredMessage[],
): Map<number, BotTask[]> {
  const byAnchor = new Map<number, BotTask[]>();
  if (!tasks.length) return byAnchor;
  const anchors: { index: number; at: number }[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const at = botTaskTime(message.createdAt);
    if (at) anchors.push({ index, at });
  });
  const ordered = [...tasks].sort((a, b) => botTaskTime(a.createdAt) - botTaskTime(b.createdAt));
  let cursor = 0;
  for (const task of ordered) {
    const at = botTaskTime(task.createdAt);
    while (cursor + 1 < anchors.length && anchors[cursor + 1].at <= at) cursor += 1;
    const anchor = anchors.length && anchors[cursor].at <= at ? anchors[cursor].index : -1;
    const bucket = byAnchor.get(anchor);
    if (bucket) bucket.push(task);
    else byAnchor.set(anchor, [task]);
  }
  return byAnchor;
}

export async function startChatWith(
  summary: AvatarSummary,
  split = false,
): Promise<void> {
  if (
    !split &&
    readState().chatPanes.some((pane) => pane.streaming) &&
    !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
  ) {
    return;
  }
  // Resume the most recent existing conversation with this avatar instead of
  // spawning a duplicate thread (matches the old explore behavior). Only for a
  // single, non-split open.
  if (!split && readState().chatPanes.length <= 1) {
    const existing = readState().conversations.find(
      (c) => c.avatarUserId === summary.id && !c.isRoutine,
    );
    if (existing) {
      await selectConversation(existing.id);
      return;
    }
  }
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(summary.id)}`,
  );
  const pane = makePane(avatar);
  const before = [...readState().chatPanes];
  updateState((state) => {
    state.currentAvatar = avatar;
    if (
      split &&
      state.chatPanes.length &&
      state.chatPanes.length < MAX_CHAT_PANES
    )
      state.chatPanes.push(pane);
    else state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  abortDroppedPanes(before);
  syncHash();
  void loadConversations();
}

// The notice every 체험 시나리오 handoff shows. Both surfaces that seed a
// "/tour <slug>" (the welcome modal's cards and the explore 시작하기 checklist)
// promise the same thing, so the sentence lives once next to openSeededChat
// rather than being retyped per caller.
export const TOUR_SEED_NOTICE = "입력창에 체험 시나리오를 준비했습니다. 보내기를 누르면 시작해요.";

// Open a fresh chat with the owner's own avatar and seed the composer with text
// (not sent — the owner reviews first). Used by the inbox notification handoff,
// "ask my avatar" actions, and the routines "지금 실행" handoff. Mirrors the old
// chatAboutTopic(). `notice` is overridable because the default names a "주제",
// which is wrong for callers seeding something other than a discussion topic.
export async function openSeededChat(
  seedText: string,
  notice = "입력창에 주제를 채웠습니다. 검토 후 보내기를 누르세요.",
): Promise<void> {
  const me = readState().user;
  if (!me) return;
  if (
    readState().chatPanes.some((pane) => pane.streaming) &&
    !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
  )
    return;
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(me.id)}`,
  );
  const pane = makePane(avatar);
  pane.draft = seedText;
  const before = [...readState().chatPanes];
  updateState((state) => {
    state.currentAvatar = avatar;
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  abortDroppedPanes(before);
  syncHash();
  void loadConversations();
  notify(notice, "info");
}

// A routine's thread IS a real conversation, but it lives in a SEPARATE state
// array: loadRoutinesData fetches it with kind:"routine" into routineConversations,
// and /api/conversations defaults to kind:"chat", which EXCLUDES routine threads.
// So a lookup that reads only state.conversations misses every routine handoff
// (the routines view's "일반 대화로 열기") and reports a misleading "대화를 찾을 수
// 없습니다". Both arrays are consulted before refetching, and the refetch keeps the
// two lists SEPARATE instead of pulling routine threads into state.conversations —
// the chat sidebar and startChatWith both treat that array as chat-only.
async function findConversationSummary(
  conversationId: string,
): Promise<ConversationSummary | null> {
  const local = readState();
  const cached =
    local.conversations.find((item) => item.id === conversationId) ??
    local.routineConversations.find((item) => item.id === conversationId);
  if (cached) return cached;
  const chat = await loadConversations();
  return (
    chat.find((item) => item.id === conversationId) ??
    (await loadConversations("routine")).find(
      (item) => item.id === conversationId,
    ) ??
    null
  );
}

/**
 * Build a DETACHED pane for one stored conversation: resolve its summary, fetch
 * the messages and the avatar in parallel, and apply the per-conversation picker
 * selections. Deliberately touches no global state — not `view`, not
 * `chatPanes`, not the hash — so a caller that must NOT navigate to #/chat (봇
 * 오피스 mounts the chat surface inside its own view) can place the pane itself.
 * Returns null, having toasted, when the conversation is gone.
 */
export async function loadPaneForConversation(
  conversationId: string,
): Promise<ChatPane | null> {
  const conv = await findConversationSummary(conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return null;
  }
  const [loaded, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(conv.avatarUserId)}`,
    ),
  ]);
  const pane = makePane(
    avatarRes.avatar,
    conversationId,
    loaded.messages,
    loaded.canvases,
  );
  applyLoadedConversation(pane, loaded);
  return pane;
}

/**
 * 봇 오피스: make this bot's thread the ONLY chat pane WITHOUT leaving the bots
 * view. With a conversationId the stored thread is loaded; without one a fresh
 * pane is minted so a bot the owner never talked to still opens a composer.
 * The pane merely has to EXIST in state.chatPanes — that is what lets the
 * private updatePane resolve it and the mounted ChatView go live. Navigation
 * (view + hash) stays with the caller, which owns the #/bots/<agentId> route.
 */
export async function openBotThreadPane(
  summary: AvatarSummary,
  conversationId?: string,
): Promise<ChatPane | null> {
  let pane: ChatPane | null;
  if (conversationId) {
    pane = await loadPaneForConversation(conversationId);
  } else {
    const { avatar } = await api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(summary.id)}`,
    );
    pane = makePane(avatar);
  }
  if (!pane) return null;
  const placed = pane;
  const before = [...readState().chatPanes];
  updateState((state) => {
    state.currentAvatar = placed.avatar;
    state.chatPanes = [placed];
    state.activePaneId = placed.id;
  });
  abortDroppedPanes(before);
  // Only a STORED thread can have a run to rejoin, and this is never awaited:
  // attachActiveRun resolves at run end (see selectConversation).
  if (conversationId) void attachActiveRun(placed.id);
  return placed;
}

export async function selectConversation(
  conversationId: string,
): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find(
    (pane) => pane.conversationId === conversationId,
  );
  if (existingPane?.streaming) {
    updateState((s) => {
      s.activePaneId = existingPane.id;
      s.view = "chat";
    });
    syncHash();
    return;
  }
  const pane = await loadPaneForConversation(conversationId);
  if (!pane) return;
  const before = [...readState().chatPanes];
  updateState((s) => {
    s.currentAvatar = pane.avatar;
    s.chatPanes = [pane];
    s.activePaneId = pane.id;
    s.view = "chat";
  });
  abortDroppedPanes(before);
  syncHash(true);
  // NOT awaited: attachActiveRun resolves only when the RUN ends, and a run
  // parked on a blocking canvas can wait 30 minutes. Awaiting it would hold this
  // caller — the sidebar's per-conversation busy lock — hostage for that whole
  // time, leaving the conversation's button disabled and every later open a no-op.
  void attachActiveRun(pane.id);
}

// Add an EXISTING conversation as an extra split pane (drag-from-list / "분할에
// 추가" button). If that conversation is already open in a pane, just focus it
// instead of duplicating. Reuses selectConversation's load path but PUSHES the
// pane rather than replacing the whole split.
export async function addConversationToSplit(
  conversationId: string,
): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find(
    (pane) => pane.conversationId === conversationId,
  );
  if (existingPane) {
    updateState((s) => {
      s.activePaneId = existingPane.id;
      s.currentAvatar = existingPane.avatar;
      s.view = "chat";
    });
    syncHash(true);
    return;
  }
  if (state.chatPanes.length >= MAX_CHAT_PANES) {
    notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
    return;
  }
  const conv = await findConversationSummary(conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return;
  }
  const [loaded, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(conv.avatarUserId)}`,
    ),
  ]);
  const pane = makePane(
    avatarRes.avatar,
    conversationId,
    loaded.messages,
    loaded.canvases,
  );
  applyLoadedConversation(pane, loaded);
  updateState((s) => {
    if (s.chatPanes.length >= MAX_CHAT_PANES) return;
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
    s.currentAvatar = pane.avatar;
    s.view = "chat";
  });
  syncHash(true);
  // Not awaited, same as selectConversation: this resolves only at run end, and
  // the sidebar's "분할 대화에 추가" button is disabled until the caller returns.
  void attachActiveRun(pane.id);
}

export function newChat(paneId?: string, opts?: { force?: boolean }): void {
  const pane = paneId
    ? readState().chatPanes.find((item) => item.id === paneId)
    : readState().chatPanes.find(
        (item) => item.id === readState().activePaneId,
      );
  if (!pane || (pane.streaming && !opts?.force)) return;
  const next = makePane(pane.avatar);
  const before = [...readState().chatPanes];
  updateState((state) => {
    state.chatPanes = state.chatPanes.map((item) =>
      item.id === pane.id ? next : item,
    );
    state.activePaneId = next.id;
    state.currentAvatar = next.avatar;
  });
  // force:true can replace a still-streaming pane (startNewChat's confirm path).
  abortDroppedPanes(before);
  syncHash();
}

/**
 * Rail "새 대화" action: start a fresh thread IMMEDIATELY (same meaning as the
 * chat-header button), instead of merely navigating to explore. Target: the
 * active pane's avatar; with no open pane, the user's own avatar. Streaming
 * panes get the same confirm as startChatWith before being replaced.
 */
export async function startNewChat(): Promise<void> {
  const state = readState();
  const pane =
    state.chatPanes.find((item) => item.id === state.activePaneId) ??
    state.chatPanes[0];
  if (pane) {
    if (
      pane.streaming &&
      !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
    ) {
      return;
    }
    newChat(pane.id, { force: true });
    updateState((s) => {
      s.view = "chat";
    });
    syncHash();
    return;
  }
  const me = state.user;
  if (!me) return;
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(me.id)}`,
  );
  const fresh = makePane(avatar);
  updateState((s) => {
    s.currentAvatar = avatar;
    s.chatPanes = [fresh];
    s.activePaneId = fresh.id;
    s.view = "chat";
  });
  syncHash();
  void loadConversations();
}

export async function clearChatHistory(): Promise<number> {
  const result = await api<{ deleted: number; conversationIds: string[] }>(
    "/api/conversations",
    { method: "DELETE" },
  );
  const ids = new Set(result.conversationIds || []);
  if (!ids.size) {
    return 0;
  }
  for (const pane of readState().chatPanes) {
    if (ids.has(pane.conversationId)) {
      pane.abortController?.abort();
    }
  }
  updateState((state) => {
    state.conversations = state.conversations.filter(
      (conversation) => !ids.has(conversation.id),
    );
    state.chatPanes = state.chatPanes.map((pane) =>
      ids.has(pane.conversationId) ? makePane(pane.avatar) : pane,
    );
    if (!state.chatPanes.some((pane) => pane.id === state.activePaneId)) {
      state.activePaneId = state.chatPanes[0]?.id ?? null;
    }
    const activePane = state.chatPanes.find(
      (pane) => pane.id === state.activePaneId,
    );
    state.currentAvatar = activePane?.avatar ?? state.currentAvatar;
  });
  syncHash(true);
  return result.deleted || ids.size;
}

/* ---------- 여기서부터 다시 (rewind) + 다시 생성 ---------- */

/**
 * A user row that OPENED a turn. A steer did not — it reached the model in the
 * MIDDLE of one (between tool calls, or as the head of a follow-up turn inside the
 * same run), so there is no turn boundary in front of it to restart from.
 */
function isTurnOpener(message: StoredMessage | undefined): boolean {
  return message?.role === "user" && message.kind !== "steer";
}

/**
 * A row 여기서부터 다시 can go back to: a turn opener that was NOT queued behind
 * another run. A `queued` row was stored while an earlier run was still active,
 * so it sits BEFORE that run's answer — "it and everything after it" would take
 * the earlier turn's answer with it. The server refuses both kinds; mirroring the
 * rule keeps the UI from offering an action that could only come back refused.
 */
export function isRewindAnchor(message: StoredMessage | undefined): boolean {
  return isTurnOpener(message) && message?.kind !== "queued";
}

/** The turn 다시 생성 re-runs: the LAST turn-opening user row (the server picks the same one). */
function lastTurnOpenerIndex(messages: StoredMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnOpener(messages[i])) return i;
  }
  return -1;
}

/** Whether 다시 생성 can re-run the latest turn — its opener exists and was not queued. */
export function canRegenerate(messages: StoredMessage[]): boolean {
  return isRewindAnchor(messages[lastTurnOpenerIndex(messages)]);
}

/**
 * Whether a rewound row carries images of its own. Its text may then be empty — an
 * image-only message is still a message (the server re-feeds those images), so
 * neither 다시 생성 nor an edit needs text to go back to it.
 */
export function hasVisibleImages(message: StoredMessage | undefined): boolean {
  return (message?.attachments ?? []).some((att) => att.kind === "image" && !att.hidden);
}

/**
 * A row the CLIENT created (the optimistic user bubble, a stopped bubble) later
 * takes the id the server stored it under. `clientKey` remembers the id it was
 * born with, and the transcript is keyed on it: the adoption then updates the
 * node in place, where re-keying would destroy it and replay its entry animation
 * a beat after it appeared. Re-reads carry it over by id (`mergeLoadedMessages`).
 */
type KeyedMessage = StoredMessage & { clientKey?: string };

/**
 * A row's identity for UI state that must survive id adoption — the each-block key,
 * which cards are open: the id it was born with when the client made it.
 */
export function stableMessageId(message: StoredMessage): string {
  return (message as KeyedMessage).clientKey || message.id;
}

/** The transcript's each-block key for a row — stable across id adoption. */
export function messageKey(message: StoredMessage, index: number): string {
  return (
    stableMessageId(message) || `${message.role}-${message.createdAt}-${index}`
  );
}

/**
 * Per pane: bumped by every send and every transcript re-read. A re-read applies
 * its response only while nothing newer has happened since it started — an
 * unordered response would roll a later change back: a new optimistic send, a
 * newer re-read, or a stopped bubble the server had not stored yet when the GET
 * was answered.
 */
const transcriptEpochs = new Map<string, number>();

function nextTranscriptEpoch(paneId: string): number {
  const epoch = (transcriptEpochs.get(paneId) ?? 0) + 1;
  transcriptEpochs.set(paneId, epoch);
  return epoch;
}

function isLatestTranscriptEpoch(paneId: string, epoch: number): boolean {
  return (transcriptEpochs.get(paneId) ?? 0) === epoch;
}

function adoptServerId(row: StoredMessage, serverId: string): void {
  const keyed = row as KeyedMessage;
  if (!keyed.clientKey) keyed.clientKey = row.id;
  row.id = serverId;
}

/**
 * A re-read of the transcript, applied without disturbing what the pane already
 * shows: rows keep their each-block key (matched by id, which adoption made the
 * server's), and a row keeps the activity snapshot it rendered — `done` PUTs that
 * snapshot fire-and-forget, so a re-read right after a turn can beat it there.
 */
function mergeLoadedMessages(
  current: StoredMessage[],
  loaded: StoredMessage[],
): StoredMessage[] {
  const byId = new Map(current.map((row) => [row.id, row as KeyedMessage]));
  return loaded.map((row) => {
    const mine = byId.get(row.id);
    if (!mine) return row;
    const merged: KeyedMessage = { ...row };
    if (mine.clientKey) merged.clientKey = mine.clientKey;
    if (row.response && !row.response.activity && mine.response?.activity)
      merged.response = { ...row.response, activity: mine.response.activity };
    return merged;
  });
}

/** Open the inline editor on an earlier user message (여기서부터 다시). */
export function startRewindEdit(paneId: string, messageId: string): void {
  updatePane(paneId, (pane) => {
    if (pane.streaming) return;
    const message = pane.messages.find((m) => m.id === messageId);
    if (!message || !isRewindAnchor(message)) return;
    pane.rewindEdit = { messageId, draft: message.content || "" };
  });
}

export function setRewindEditDraft(paneId: string, draft: string): void {
  updatePane(paneId, (pane) => {
    if (pane.rewindEdit) pane.rewindEdit.draft = draft;
  });
}

export function cancelRewindEdit(paneId: string): void {
  updatePane(paneId, (pane) => {
    pane.rewindEdit = null;
  });
}

/**
 * Send the inline edit: after ONE confirmation the conversation goes back to the
 * edited message — it and every row after it are replaced by the edited text and
 * the new answer. The discarded messages' shared file cards go with them and
 * their share links are revoked; everything else the discarded turns did stays
 * as it is (workspace/repo files, commits, browser actions, created routines and
 * bots). The dialog says both halves outright.
 */
export async function submitRewindEdit(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  const edit = pane?.rewindEdit;
  if (!pane || !edit || pane.streaming || !pane.avatar) return;
  const index = pane.messages.findIndex((m) => m.id === edit.messageId);
  if (index < 0 || !isRewindAnchor(pane.messages[index])) {
    cancelRewindEdit(paneId);
    notify("편집할 메시지를 찾을 수 없습니다.", "warn");
    return;
  }
  if (!edit.draft.trim() && !hasVisibleImages(pane.messages[index])) return;
  const later = pane.messages.length - index - 1;
  // What goes and what stays, said plainly: the later messages AND their shared
  // file cards and share links are deleted; work the turns did outside the chat
  // (workspace/repo files, commits, browser actions, created routines and bots)
  // is not undone.
  const confirmed = await confirmAction(
    later > 0
      ? `이 메시지부터 다시 시작할까요?\n\n이후 메시지 ${later}개와 거기에 딸린 첨부 파일·공유 링크가 삭제되며 되돌릴 수 없습니다. 작업 폴더의 파일 변경·커밋 등 이미 실행된 작업은 그대로 남습니다.`
      : "이 메시지부터 다시 시작할까요?\n\n작업 폴더의 파일 변경·커밋 등 이미 실행된 작업은 그대로 남습니다.",
    { title: "여기서부터 다시", confirmLabel: "다시 시작", tone: "danger" },
  );
  if (!confirmed) return;
  // The dialog is asynchronous: the pane may have started streaming (a run
  // reattached), closed the editor, or moved to another conversation meanwhile.
  const current = readState().chatPanes.find((item) => item.id === paneId);
  if (
    !current ||
    current.streaming ||
    current.rewindEdit?.messageId !== edit.messageId
  )
    return;
  await sendMessage(paneId, current.rewindEdit.draft, {
    rewindFromMessageId: edit.messageId,
  });
}

/**
 * 다시 생성: re-run the LAST ordinary user turn. Every row after it goes — each
 * answer segment, steer and background report of that turn, not just the final
 * row (the server drops the same set, so a reload shows what the screen shows).
 */
export function regenerate(paneId: string): void {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !canRegenerate(pane.messages)) return;
  const anchorIndex = lastTurnOpenerIndex(pane.messages);
  void sendMessage(paneId, pane.messages[anchorIndex].content, {
    regenerate: true,
  });
}

/**
 * Per pane, the optimistic USER bubble of the send in flight. The `open` frame
 * names the row the server persisted (`userMessageId`), and adopting it is what
 * lets a message sent in THIS session be edited and rewound at all — the server
 * only knows its own ids. Consumed by the first `open`; a replayed one finds
 * nothing and is a no-op. A regenerate never registers: its server picks the
 * anchor itself, and a stale tab's server may re-run a DIFFERENT row, so the id
 * is not ours to adopt — the re-read when that run ends settles it instead.
 */
const pendingUserMessageIds = new Map<string, string>();

/** What a rewind/regenerate's `open` clears locally once the server has applied it. */
interface RewindCleanup {
  conversationId: string;
  /** Attachments of the dropped rows (the file preview closes if it shows one). */
  attachmentIds: Set<string>;
  /** Delegated-task cards anchored at/after the anchor row (their rows are deleted server-side). */
  botTaskIds: Set<string>;
}
const pendingRewindCleanups = new Map<string, RewindCleanup>();

function adoptUserMessageId(
  pane: ChatPane,
  optimisticId: string | undefined,
  serverId: unknown,
): void {
  if (!optimisticId || typeof serverId !== "string" || !serverId) return;
  if (optimisticId === serverId) return;
  if (pane.messages.some((m) => m.id === serverId)) return;
  const row = pane.messages.find((m) => m.id === optimisticId);
  if (row) adoptServerId(row, serverId);
}

/** Delegated-task cards the transcript shows at or after `anchorIndex`. */
function botTaskIdsFromAnchor(pane: ChatPane, anchorIndex: number): Set<string> {
  const tasks = readState().botTasks.filter(
    (task) => task.conversationId === pane.conversationId,
  );
  const ids = new Set<string>();
  if (!tasks.length) return ids;
  for (const [index, bucket] of anchorBotTasksToMessages(tasks, pane.messages)) {
    if (index >= anchorIndex) for (const task of bucket) ids.add(task.id);
  }
  return ids;
}

/**
 * The server applied the rewind before opening the run (that is what `open`
 * proves), so the side state of the dropped turns goes now: their task cards,
 * a file preview showing one of their cards, and canvases they created or
 * refined. Canvases carry no timestamps client-side, so they come back from the
 * server — merged with anything THIS run has already shown live, which the
 * fetch may not include yet.
 */
function applyRewindCleanup(
  paneId: string,
  cleanup: RewindCleanup,
  runId: string | undefined,
): void {
  if (cleanup.botTaskIds.size) {
    updateState((state) => {
      state.botTasks = state.botTasks.filter(
        (task) => !cleanup.botTaskIds.has(task.id),
      );
    });
  }
  updatePane(paneId, (pane) => {
    if (
      pane.filePreview &&
      cleanup.attachmentIds.has(pane.filePreview.attachment.id)
    )
      pane.filePreview = null;
  });
  // Not a transcript re-read of its own (it bumps nothing), but a later one — the
  // run-end re-read — supersedes it, so a late answer here is dropped.
  const epoch = transcriptEpochs.get(paneId) ?? 0;
  void (async () => {
    try {
      const loaded = await loadMessages(cleanup.conversationId);
      if (!isLatestTranscriptEpoch(paneId, epoch)) return;
      updatePane(paneId, (pane) => {
        if (pane.conversationId !== cleanup.conversationId) return;
        const live = pane.canvases.filter(
          (canvas) => Boolean(runId) && canvas.runId === runId,
        );
        pane.canvases = [
          ...paneCanvasesFromArtifacts(loaded.canvases).filter(
            (canvas) => !live.some((item) => item.id === canvas.id),
          ),
          ...live,
        ];
        if (
          pane.activeCanvasId &&
          !pane.canvases.some((canvas) => canvas.id === pane.activeCanvasId)
        )
          pane.activeCanvasId = null;
      });
    } catch {
      /* best effort — the next open of the conversation reloads them */
    }
  })();
}

/**
 * A rewind/regenerate that never opened a run: put the transcript back at once
 * (an edit also gets its editor back, text intact — the text only exists there),
 * then re-read it. A refusal usually means this view is STALE — the server's
 * conversation moved on (another tab, a queued turn), which is exactly what its
 * "대화 내용이 바뀌어…" 409 says — and a transport failure may have reached the
 * server after all. The editor survives the re-read while its row still exists;
 * otherwise its text moves to the composer instead of vanishing. Transcript only:
 * a model/effort/tool pick made before the refused edit stays picked.
 */
function restoreFailedRewind(
  paneId: string,
  conversationId: string,
  snapshot: StoredMessage[],
  editMessageId: string | undefined,
  text: string,
): void {
  updatePane(paneId, (target) => {
    if (target.conversationId !== conversationId) return;
    target.messages = snapshot;
    target.usage = lastUsage(snapshot);
    if (editMessageId) target.rewindEdit = { messageId: editMessageId, draft: text };
  });
  const epoch = nextTranscriptEpoch(paneId);
  void (async () => {
    try {
      const loaded = await loadMessages(conversationId);
      if (!isLatestTranscriptEpoch(paneId, epoch)) return;
      updatePane(paneId, (target) => {
        if (target.conversationId !== conversationId || target.streaming) return;
        applyLoadedTranscript(target, loaded);
        if (
          target.rewindEdit &&
          !target.messages.some((m) => m.id === target.rewindEdit?.messageId)
        ) {
          const orphaned = target.rewindEdit.draft;
          target.rewindEdit = null;
          if (!target.draft.trim()) target.draft = orphaned;
        }
      });
    } catch {
      /* offline — the restored snapshot stands until the next load */
    }
  })();
}

/**
 * A rewind/regenerate run ENDED (a terminal frame was read, so the server had
 * stored every row of it): re-read the transcript so the pane shows the server's
 * rows — its ids, and exactly the rows it kept, even when this view had drifted —
 * merged so nothing on screen re-mounts or loses its activity card. Transcript
 * only: a model/effort/tool pick made while the run streamed stays picked.
 */
async function refreshAfterRewind(
  paneId: string,
  conversationId: string,
): Promise<void> {
  const epoch = nextTranscriptEpoch(paneId);
  try {
    const loaded = await loadMessages(conversationId);
    if (!isLatestTranscriptEpoch(paneId, epoch)) return;
    updatePane(paneId, (target) => {
      if (target.conversationId !== conversationId || target.streaming) return;
      applyLoadedTranscript(target, loaded);
    });
  } catch {
    /* best effort — the next open of the conversation reloads it */
  }
}

export async function sendMessage(
  paneId: string,
  rawMessage: string,
  opts: {
    regenerate?: boolean;
    /**
     * 여기서부터 다시: the SERVER id of the earlier ordinary user row this send
     * replaces. That row and everything after it are dropped (server-side too),
     * and `rawMessage` — the edited text — becomes the conversation's newest
     * turn, carrying the row's images. The composer is left untouched.
     */
    rewindFromMessageId?: string;
    /**
     * A non-blocking canvas submission/edit (#50). Delivered as a normal turn: the
     * server formats the agent-facing message and persists a short Korean bubble.
     */
    canvasSubmission?: {
      canvasId: string;
      values?: Record<string, unknown>;
      editedContent?: string;
    };
  } = {},
): Promise<void> {
  let pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.avatar) return;
  let message = rawMessage.trim();
  // A canvas submission carries no typed text — the visible bubble is a short
  // Korean summary mirroring the server's displayMessage (hand-mirrored validator).
  if (opts.canvasSubmission) {
    message = opts.canvasSubmission.editedContent
      ? "캔버스를 수정해 보냈습니다."
      : "캔버스 응답을 보냈습니다.";
  }
  const rewindFromMessageId = opts.rewindFromMessageId || undefined;
  // The ordinary user row a rewind or regenerate goes back to. A rewind REPLACES
  // it (and everything after it) with the edited text; a regenerate keeps it and
  // re-runs its turn, dropping every row after it.
  const anchorIndex = rewindFromMessageId
    ? pane.messages.findIndex((m) => m.id === rewindFromMessageId)
    : opts.regenerate
      ? lastTurnOpenerIndex(pane.messages)
      : -1;
  const rewinding = Boolean(rewindFromMessageId) || opts.regenerate === true;
  const anchor = rewinding ? pane.messages[anchorIndex] : undefined;
  if (rewinding && !isRewindAnchor(anchor)) return;
  // Snapshot staged images early so a text-empty, image-only turn can be sent.
  // Regenerates and rewinds carry no freshly staged images: they re-send a
  // stored turn (its own images are re-read server-side), and whatever sits in
  // the composer belongs to the NEXT message.
  const pendingImages = rewinding ? [] : [...(pane.pendingImages || [])];
  // An image-only row is still a message: going back to it needs no text.
  const anchorImages = rewinding && hasVisibleImages(anchor);
  if (!message && pendingImages.length === 0 && !anchorImages) return;

  const slash =
    message && !opts.canvasSubmission
      ? resolveTypedSlashCommand(pane, message)
      : null;
  if (slash) {
    if (slash.command.action === "new") {
      // An edit cannot turn into "start a new chat" — the editor stays open.
      if (rewindFromMessageId) {
        notify("편집한 메시지로는 새 대화를 시작할 수 없습니다.", "warn");
        return;
      }
      newChat(pane.id);
      return;
    }
    if (slash.command.requiresArgs && !slash.args) {
      // The inline editor keeps its own text; only a composer send is reseeded.
      if (!rewindFromMessageId)
        updatePane(pane.id, (target) => {
          target.draft = `/${slash.command.name} `;
        });
      const argsLabel = slash.command.argsLabel || "내용";
      notify(
        `/${slash.command.name} 뒤에 ${argsLabel}${objectParticle(argsLabel)} 입력해 주세요.`,
        "warn",
      );
      return;
    }
    // Send the literal "/command [args]"; the server swaps in the expanded
    // (agent-facing) prompt so the bubble + persisted turn stay the literal.
    message = `/${slash.command.name}${slash.args ? ` ${slash.args}` : ""}`;
    if (!message && pendingImages.length === 0 && !anchorImages) return;
  }

  // Staged images ride this turn and can be restored if the send fails before
  // anything streamed. An edit carries the replaced row's images instead: the
  // server keeps their bytes and re-feeds them, so the bubble shows them as-is.
  const userMessage: StoredMessage = {
    id: newId(),
    conversationId: pane.conversationId,
    role: "user",
    content: message,
    attachments: rewindFromMessageId
      ? anchor?.attachments?.length
        ? anchor.attachments.map((att) => ({ ...att }))
        : undefined
      : pendingImages.length
        ? pendingImages.map((img) => ({
            id: img.id,
            kind: "image" as const,
            mediaType: img.mediaType,
            name: img.name,
          }))
        : undefined,
    response: null,
    createdAt: new Date().toISOString(),
  };
  // A real send is a user gesture — the right moment to (idempotently) ask for OS
  // notification permission so answer-complete / input-needed alerts can fire later.
  void ensureNotificationPermission();

  // A rewind/regenerate restores this exact list if the server never opens its
  // run, and hands `open` what to clear once it does: the rows from the first
  // dropped one on are going away server-side.
  const snapshot = rewinding ? pane.messages.slice() : null;
  if (rewinding) {
    const carried = new Set((userMessage.attachments ?? []).map((att) => att.id));
    const dropped = pane.messages.slice(
      rewindFromMessageId ? anchorIndex : anchorIndex + 1,
    );
    pendingRewindCleanups.set(paneId, {
      conversationId: pane.conversationId,
      attachmentIds: new Set(
        dropped
          .flatMap((row) => (row.attachments ?? []).map((att) => att.id))
          .filter((id) => !carried.has(id)),
      ),
      botTaskIds: botTaskIdsFromAnchor(pane, anchorIndex),
    });
  } else {
    pendingRewindCleanups.delete(paneId);
  }
  if (opts.regenerate) pendingUserMessageIds.delete(paneId);
  else pendingUserMessageIds.set(paneId, userMessage.id);
  terminalMessageIds.delete(paneId);
  // This send changes the transcript: a re-read already in flight must not land on top.
  nextTranscriptEpoch(paneId);

  const controller = new AbortController();
  updatePane(pane.id, (target) => {
    if (rewinding && anchor) {
      const at = target.messages.findIndex((m) => m.id === anchor.id);
      if (at >= 0) {
        target.messages = rewindFromMessageId
          ? [...target.messages.slice(0, at), userMessage]
          : target.messages.slice(0, at + 1);
      }
      target.usage = lastUsage(target.messages);
    } else {
      target.messages.push(userMessage);
    }
    // Any open inline edit goes with a send: the transcript it points into moved on.
    target.rewindEdit = null;
    // Hold the data URLs locally so the just-sent bubble renders images before
    // they're fetchable from the server, and clear the composer's staged images.
    // A rewind/regenerate re-sends a stored turn, so the composer — whatever is
    // typed or staged there belongs to the NEXT message — is left as it is.
    if (pendingImages.length) {
      target.localImages = { ...(target.localImages || {}) };
      for (const img of pendingImages) target.localImages[img.id] = img.dataUrl;
    }
    if (!rewinding) {
      target.pendingImages = [];
      target.draft = "";
    }
    resetLive(target);
    // The previous turn's run id outlives its turn (resetLive keeps it for the
    // canvas/stop paths). Drop it here so this send's failure handling can tell
    // "our run opened, reconnect to it" from "the send never got off the ground".
    target.liveRunId = null;
    target.streaming = true;
    // A send is an explicit "follow the response" intent, so re-arm auto-scroll
    // even if a prior turn (or a stray scroll) had detached it — otherwise the
    // new answer streams in off-screen. onTranscriptScroll can still disengage
    // it the moment the user genuinely scrolls up.
    target.stickBottom = true;
    target.liveStatus = "응답 준비 중…";
    target.abortController = controller;
  });

  // A terminal frame (done / bg_end / cancelled / error) was read for this send's
  // run — the server persists each of those rows BEFORE it emits the frame.
  let runEnded = false;
  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
      body: JSON.stringify({
        avatarId: pane.avatar.id,
        message,
        conversationId: pane.conversationId,
        regenerate: opts.regenerate === true,
        ...(rewindFromMessageId ? { rewindFromMessageId } : {}),
        multiSession: readState().chatPanes.length > 1,
        // External avatars run their own tool stack behind the gateway, so the
        // local-only composer settings (effort/knowledge/MCP groups) stay off
        // that path. The MODEL is the exception: the viewer may pick a gateway
        // model id per conversation ("" = clear back to the admin default).
        ...(pane.avatar.runtime === "external"
          ? { model: pane.modelTier || "" }
          : {
              groupKnowledgeOff: pane.groupKnowledgeOff || [],
              // Model tier / reasoning effort / MCP groups: the pane is seeded from
              // remembered defaults, then persisted per native conversation.
              model: pane.modelTier || DEFAULT_MODEL_TIER,
              effort: pane.effort || DEFAULT_EFFORT_LEVEL,
              mcpToolGroups:
                pane.mcpToolGroups ?? DEFAULT_MCP_TOOL_GROUPS,
            }),
        // Staged image attachments (data URLs). The server reuses our id as the
        // stored attachment id + filename. Omit when none.
        images: pane.avatar.runtime !== "external" && pendingImages.length
          ? pendingImages.map((img) => ({ id: img.id, data: img.dataUrl }))
          : undefined,
        // Non-blocking canvas submission/edit (#50), when this turn was triggered
        // from a canvas form rather than the composer.
        canvasSubmission: opts.canvasSubmission,
      }),
    });
    if (response.status === 401) {
      throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    // 202 = the bot was already busy, so the server QUEUED this turn as a
    // delegated task instead of opening a stream. The body is JSON, not SSE:
    // branch BEFORE readRunStream (202 is `ok`, so the error path below never
    // sees it). The user bubble is already in the transcript and the draft is
    // already cleared; the `finally` below unsets streaming, so the pane simply
    // never enters a live turn — the task card carries the progress from here.
    if (response.status === 202) {
      // The server stored the message as a QUEUED row (it sits before the busy
      // run's answer), so the bubble mirrors that kind and offers no rewind.
      updatePane(paneId, (target) => {
        const row = target.messages.find((m) => m.id === userMessage.id);
        if (row) row.kind = "queued";
      });
      const queued = await response.json().catch(() => ({}));
      if (isBotTask(queued?.task)) upsertBotTask(queued.task);
      notify(
        "봇이 작업 중이라 대기열에 추가했어요 — 현재 작업이 끝나면 자동으로 시작합니다.",
        "info",
      );
      return;
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    // The POST body IS the run's first connection. `consumeSse` resolves the same
    // way whether the server finished the run or the socket died, so only a
    // terminal frame ends the turn here — otherwise the run is still going and we
    // follow it through the reattach loop.
    if (await readRunStream(paneId, response.body)) runEnded = true;
    else runEnded = (await followSendDrop(paneId, controller)) === "terminal";
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      finalizePane(paneId, "중지됨", true);
    } else if (paneRunId(paneId)) {
      // The turn's own connection failed, but the run had already opened and is
      // still in the server's registry — reconnect instead of ending the turn on
      // a transport failure (and never undo the user bubble: the server has it).
      runEnded = (await followSendDrop(paneId, controller)) === "terminal";
    } else {
      const current = readState().chatPanes.find((item) => item.id === paneId);
      if (!current?.liveText && snapshot) {
        // A rewind/regenerate that never opened its run: the transcript comes
        // back as it was, an edit with its editor and text.
        restoreFailedRewind(
          paneId,
          pane.conversationId,
          snapshot,
          rewindFromMessageId,
          rawMessage,
        );
        notify(`메시지를 보내지 못했습니다: ${error.message}`);
      } else if (!current?.liveText && userMessage) {
        // Nothing arrived for a normal send — undo it cleanly and restore the
        // draft + the staged images so the user can retry without re-attaching.
        updatePane(paneId, (target) => {
          const last = target.messages[target.messages.length - 1];
          if (last?.id === userMessage.id) target.messages.pop();
          target.draft = rawMessage;
          if (pendingImages.length) {
            target.pendingImages = pendingImages;
            for (const img of pendingImages)
              delete target.localImages?.[img.id];
          }
        });
        notify(`메시지를 보내지 못했습니다: ${error.message}`);
      } else {
        finalizeError(paneId, error.message);
      }
    }
  } finally {
    // Consumed by `open`; a send that never got one must not leave them for a
    // later run's frame to act on.
    pendingUserMessageIds.delete(paneId);
    pendingRewindCleanups.delete(paneId);
    dropRunPrompts(paneId);
    updatePane(paneId, (target) => {
      target.streaming = false;
      target.abortController = null;
      target.liveStatus = "";
    });
    // A rewind/regenerate whose run really ENDED (a refusal re-reads on its own
    // path): the server's rows are the truth now, whatever this view assumed. A
    // stopped or dropped one is not re-read — the server stores a stopped row
    // only once its run has unwound, after this GET would already be answered,
    // and the merge would then wipe the stopped bubble the viewer is looking at.
    if (snapshot && runEnded)
      void refreshAfterRewind(paneId, pane.conversationId);
    void loadConversations();
  }
}

/**
 * Send a mid-turn message ("steer") into the RUN that is already streaming: the
 * server hands it to the model between tool calls, or — if the turn wraps up
 * first — as the head of a follow-up turn inside the same run.
 *
 * Deliberately NOT a variant of `sendMessage`: there is no new run to open, no
 * slash expansion (the server never sees an expanded steer) and no image
 * attachment (those wait for the turn to end). External avatars run behind the
 * gateway, which has no mid-turn channel at all, so they never reach the POST.
 *
 * The draft is cleared optimistically and put BACK on any failure, because the
 * text only exists in the composer until the server has acknowledged it.
 */
export async function sendSteer(paneId: string, rawText: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || !pane.streaming || !pane.liveRunId || pane.steerSending) return;
  if (pane.avatar?.runtime === "external") return;
  const message = rawText.trim();
  if (!message) return;
  const runId = pane.liveRunId;
  updatePane(paneId, (target) => {
    target.draft = "";
    target.steerSending = true;
  });
  try {
    const result = await api<{ steer?: SteerPublic }>(
      `/api/chat/runs/${encodeURIComponent(runId)}/message`,
      { method: "POST", body: JSON.stringify({ message }) },
    );
    // The `steer{queued}` frame carries the same row; whichever lands first wins
    // and the other is deduped on the id.
    if (result?.steer?.id)
      updatePane(paneId, (target) => upsertPendingSteer(target, result.steer!));
  } catch (err) {
    restoreSteerDraft(paneId, message);
    // `api()` already localizes the server's Korean `apiError` text; the generic
    // line only covers a body that carried no message at all.
    notify((err as Error)?.message || "메시지를 전달하지 못했습니다.", "warn");
  } finally {
    updatePane(paneId, (target) => {
      target.steerSending = false;
    });
  }
}

export async function attachActiveRun(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.conversationId) return;
  try {
    const result = await api<{ run: { runId: string } | null }>(
      `/api/chat/runs?conversationId=${encodeURIComponent(pane.conversationId)}`,
    );
    if (result.run?.runId) {
      await attachRun(paneId, result.run.runId);
      return;
    }
    if (pane.messages[pane.messages.length - 1]?.role === "user") {
      const epoch = nextTranscriptEpoch(paneId);
      const loaded = await loadMessages(pane.conversationId);
      if (!isLatestTranscriptEpoch(paneId, epoch)) return;
      updatePane(paneId, (target) => {
        applyLoadedConversation(target, loaded);
      });
    }
  } catch {
    /* best effort */
  }
}

export async function attachRun(paneId: string, runId: string): Promise<void> {
  // A wake nudge can race an attach that is already in flight; one loop per pane.
  if (activeRunLoops.has(paneId)) return;
  const controller = new AbortController();
  updatePane(paneId, (target) => {
    resetLive(target);
    target.streaming = true;
    target.liveRunId = runId;
    target.liveStatus = REATTACH_STATUS;
    target.abortController = controller;
  });
  try {
    await followRun(paneId, runId, controller);
  } finally {
    // Teardown runs ONCE, when the run is really over — never between reconnect
    // attempts, which is what keeps the live region mounted across a drop.
    dropRunPrompts(paneId);
    updatePane(paneId, (target) => {
      target.streaming = false;
      target.abortController = null;
      target.liveStatus = "";
    });
  }
}

/* ---------- run streams: terminal-aware reading + auto-reconnect ---------- */

// A run's SSE is legitimately OVER only after one of these frames. `done` with
// `background:true` is NOT terminal — the SDK keeps working past the visible turn
// and the stream stays open for bg_tasks / bg_message / bg_end. Anything else that
// ends the stream is a dropped CONNECTION (laptop sleep, network switch, proxy
// lifetime) while the run itself lives on in the server's registry.
function isTerminalFrame(frame: SseFrame): boolean {
  if (frame.event === "done") return frame.data?.background !== true;
  return (
    frame.event === "bg_end" ||
    frame.event === "cancelled" ||
    frame.event === "error"
  );
}

// How one read of a run's stream ended.
type StreamEnd =
  | "terminal" // the run itself finished
  | "dropped" // the connection died before the run did → reconnect
  | "gone" // the server no longer has this run (404)
  | "aborted" // stop button / pane close
  | "detached" // the pane closed or moved to another conversation
  | "failed"; // the run could not be reached at all on a first attach

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const REATTACH_STATUS = "진행 중인 응답에 다시 연결 중…";
const RECONNECTING_STATUS = "연결이 끊겨 다시 연결하는 중…";

// Panes a run-stream loop currently owns, so a wake nudge can't stack a second
// loop on top of a live one.
const activeRunLoops = new Set<string>();
// Panes sitting out a reconnect backoff → the resolver that ends the wait early.
const reconnectWaiters = new Map<string, (retry: boolean) => void>();

function paneRunId(paneId: string): string | null {
  return (
    readState().chatPanes.find((item) => item.id === paneId)?.liveRunId ?? null
  );
}

/** Read an already-open SSE body, reporting whether the RUN finished on it. */
async function readRunStream(
  paneId: string,
  stream: ReadableStream<Uint8Array>,
): Promise<boolean> {
  let terminal = false;
  await consumeSse(stream, (frame) => {
    if (isTerminalFrame(frame)) terminal = true;
    handleSseEvent(paneId, frame);
  });
  return terminal;
}

/**
 * ONE attempt at reading a run's event log. The server replays the WHOLE log, so
 * the live state is reset first and rebuilt from the replay — every downstream
 * handler dedupes (messages by id, memory/compact rows by server-minted event id,
 * canvases by requestId), which is what makes re-reading idempotent.
 */
async function streamRunEvents(
  paneId: string,
  runId: string,
  controller: AbortController,
  connectedOnce: boolean,
): Promise<StreamEnd> {
  try {
    const response = await fetch(
      `/api/chat/runs/${encodeURIComponent(runId)}/events`,
      {
        headers: { Accept: "text/event-stream" },
        credentials: "same-origin",
        signal: controller.signal,
      },
    );
    if (response.status === 404) return "gone";
    // A hard failure on a run we have never read means we cannot reach it at all.
    // Once a read HAS succeeded the run is known to exist (a run the server no
    // longer has answers 404), so later failures are drops and keep retrying.
    if (!response.ok || !response.body)
      return connectedOnce ? "dropped" : "failed";
    updatePane(paneId, (pane) => {
      resetLive(pane);
      pane.streaming = true;
      pane.liveRunId = runId;
      pane.liveStatus = REATTACH_STATUS;
    });
    if (await readRunStream(paneId, response.body)) return "terminal";
    return controller.signal.aborted ? "aborted" : "dropped";
  } catch (err) {
    if (controller.signal.aborted || (err as Error).name === "AbortError")
      return "aborted";
    return connectedOnce ? "dropped" : "failed";
  }
}

/**
 * Follow a run to its END, reconnecting whenever the connection drops first.
 * A drop must NOT tear the live region down: the pane stays `streaming` (which is
 * what keeps the background-phase indicator and its wake-up bubbles mounted) and
 * the run's event log is re-read with capped backoff until the run really
 * finishes, the server forgets it, or the viewer stops it.
 */
async function followRun(
  paneId: string,
  runId: string,
  controller: AbortController,
  opts: { connectedOnce?: boolean } = {},
): Promise<StreamEnd> {
  const startedIn =
    readState().chatPanes.find((item) => item.id === paneId)?.conversationId ??
    null;
  let connectedOnce = opts.connectedOnce === true;
  let attempt = 0;
  activeRunLoops.add(paneId);
  try {
    for (;;) {
      const end = await streamRunEvents(
        paneId,
        runId,
        controller,
        connectedOnce,
      );
      if (end !== "dropped") {
        if (end === "gone") await catchUpAfterRunGone(paneId);
        if (end === "failed")
          notify("진행 중인 응답에 다시 연결하지 못했습니다.", "warn");
        return end;
      }
      connectedOnce = true;
      const pane = readState().chatPanes.find((item) => item.id === paneId);
      if (!pane || (startedIn !== null && pane.conversationId !== startedIn))
        return "detached";
      updatePane(paneId, (target) => {
        target.streaming = true;
        target.liveStatus = RECONNECTING_STATUS;
      });
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
        ];
      attempt += 1;
      if (!(await waitBeforeRetry(paneId, delay, controller))) return "aborted";
    }
  } finally {
    activeRunLoops.delete(paneId);
    reconnectWaiters.delete(paneId);
  }
}

// The server no longer has this run (it finished and aged out, or the process
// restarted): catch up from the persisted transcript instead of waiting for
// events that will never come.
async function catchUpAfterRunGone(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane) return;
  const epoch = nextTranscriptEpoch(paneId);
  try {
    const loaded = await loadMessages(pane.conversationId);
    if (!isLatestTranscriptEpoch(paneId, epoch)) return;
    updatePane(paneId, (target) => {
      applyLoadedConversation(target, loaded);
    });
  } catch {
    /* best effort — the transcript reloads on the next open */
  }
}

/**
 * Sleep out a reconnect backoff. Resolves false when the run was aborted (stop
 * button / pane close): the abort has to cut the wait short, or the viewer would
 * keep watching a "다시 연결하는 중" pane they already stopped. A wake nudge
 * resolves it early with true so a returning tab retries immediately.
 */
function waitBeforeRetry(
  paneId: string,
  ms: number,
  controller: AbortController,
): Promise<boolean> {
  if (controller.signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (retry: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      if (reconnectWaiters.get(paneId) === settle)
        reconnectWaiters.delete(paneId);
      resolve(retry);
    };
    const onAbort = (): void => settle(false);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    reconnectWaiters.set(paneId, settle);
    timer = setTimeout(() => settle(true), ms);
  });
}

/**
 * A send's own stream ended before its run did. Reconnect to the run's event log;
 * a stop DURING that reconnect still ends the turn as a stopped bubble, exactly
 * as an abort on the original stream would.
 */
async function followSendDrop(
  paneId: string,
  controller: AbortController,
): Promise<StreamEnd | null> {
  const runId = paneRunId(paneId);
  if (!runId) return null;
  if (controller.signal.aborted) {
    finalizePane(paneId, "중지됨", true);
    return "aborted";
  }
  const end = await followRun(paneId, runId, controller, {
    connectedOnce: true,
  });
  if (end === "aborted") finalizePane(paneId, "중지됨", true);
  return end;
}

/**
 * The tab came back, or the network did. Anything sitting in a reconnect backoff
 * retries NOW instead of waiting the delay out, and the ACTIVE pane re-discovers a
 * run it lost track of entirely — the case a reconnect can't cover, because the
 * client never learned (or already dropped) the run id.
 */
function onConnectionWake(): void {
  for (const wake of [...reconnectWaiters.values()]) wake(true);
  const state = readState();
  const pane = state.chatPanes.find((item) => item.id === state.activePaneId);
  if (pane && !pane.streaming) void attachActiveRun(pane.id);
}

// Registered once at import: chat.ts has no boot hook of its own, and these
// listeners are only meaningful while this module's panes exist anyway. Guarded
// for the non-DOM vitest project, which imports this module without a window.
let wakeListenersBound = false;
function bindConnectionWakeListeners(): void {
  if (wakeListenersBound) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  wakeListenersBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onConnectionWake();
  });
  window.addEventListener("online", onConnectionWake);
}
bindConnectionWakeListeners();

export async function stopPane(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane) return;
  if (pane.liveRunId) {
    api(`/api/chat/runs/${encodeURIComponent(pane.liveRunId)}/cancel`, {
      method: "POST",
    }).catch(() => {});
  }
  pane.abortController?.abort();
  // Finalize HERE, at the user's stop, not only in whichever loop the abort
  // lands in: the send loop finalizes on its AbortError, but a REATTACHED pane
  // (attachRun — reload, tab wake, a dropped send) tears down silently, so the
  // stopped turn vanished with nothing pushed. Text folding made that loss
  // total: liveText holds only the current block, so after a fold there was no
  // narration left to even see disappear. The `turnFinalized` marker turns the
  // loop's own later finalize into a no-op instead of a second bubble. Guarded
  // on `streaming` so a stop that lands right after the done frame already
  // ended the turn doesn't append a stray stopped bubble.
  if (pane.streaming) finalizePane(paneId, "중지됨", true);
}

export function closePane(paneId: string): void {
  const state = readState();
  const pane = state.chatPanes.find((item) => item.id === paneId);
  if (pane?.streaming) void stopPane(paneId);
  updateState((s) => {
    s.chatPanes = s.chatPanes.filter((item) => item.id !== paneId);
    if (!s.chatPanes.length && s.currentAvatar)
      s.chatPanes = [makePane(s.currentAvatar)];
    s.activePaneId = s.chatPanes[0]?.id || null;
  });
}

/* ---------- SSE handling ---------- */

function handleSseEvent(paneId: string, frame: SseFrame): void {
  const { event, data } = frame;
  switch (event) {
    case "delta":
      if (typeof data?.text === "string") {
        const text = data.text;
        updatePane(paneId, (pane) => {
          if (pane.liveTextBreakPending) {
            pane.liveTextBreakPending = false;
            if (
              pane.liveText &&
              !pane.liveText.endsWith("\n") &&
              !text.startsWith("\n")
            )
              pane.liveText += "\n\n";
          }
          pane.liveText += text;
          // Answer text means the reasoning phase has handed off; stop the pulse.
          pane.thinkingActive = false;
        });
      }
      return;
    case "thinking":
      // Reasoning stream — its own collapsible view, never the answer bubble.
      if (typeof data?.text === "string") {
        const text = data.text;
        updatePane(paneId, (pane) => {
          pane.liveThinking = (pane.liveThinking || "") + text;
          pane.thinkingActive = true;
        });
      }
      return;
    case "thinking_reset":
      // Empty-turn retry discarded the prior attempt: drop its reasoning so only
      // the kept turn's thinking shows. On reconnect this frame replays in order
      // between the two thinking bursts, so the end state is the kept turn's only.
      updatePane(paneId, (pane) => {
        pane.liveThinking = "";
      });
      return;
    case "text_fold":
      // The server demoted the streamed answer so far into the reasoning view: a
      // newer text block superseded it. Mirror it — move the bubble text into the
      // thinking card, restart the bubble, and re-anchor live cards to the top of
      // the new (empty) answer. Replays in order on reconnect.
      updatePane(paneId, (pane) => {
        if (pane.liveText) {
          pane.liveThinking =
            (pane.liveThinking ? pane.liveThinking + "\n\n" : "") + pane.liveText;
          pane.liveText = "";
        }
        pane.liveTextBreakPending = false;
        for (const att of pane.liveAttachments) {
          if (typeof att.anchor === "number") att.anchor = 0;
        }
      });
      return;
    case "open": {
      // The first `open` of a send consumes that send's bookkeeping; a replayed
      // one (reattach) finds none and changes nothing.
      const optimisticId = pendingUserMessageIds.get(paneId);
      pendingUserMessageIds.delete(paneId);
      const cleanup = pendingRewindCleanups.get(paneId);
      pendingRewindCleanups.delete(paneId);
      updatePane(paneId, (pane) => {
        if (data?.conversationId) pane.conversationId = data.conversationId;
        if (data?.runId) pane.liveRunId = data.runId;
        pane.liveStatus = "응답 준비 중…";
        adoptUserMessageId(pane, optimisticId, data?.userMessageId);
      });
      if (cleanup) applyRewindCleanup(paneId, cleanup, data?.runId);
      syncHash(true);
      return;
    }
    case "status":
      // While parked on a blocking canvas the SDK's periodic tool_progress
      // ticks keep re-emitting "실행 중: 캔버스 표시" — but the run is waiting on
      // the USER. Keep the waiting label until the park resolves.
      if (data?.label && !awaitingCanvasAnswer(paneId))
        setStatus(paneId, data.label, false);
      return;
    case "plugin":
      if (data?.name) {
        updatePane(paneId, (pane) => {
          const chip = pane.livePlugins.find((p) => p.name === data.name);
          if (chip) chip.status = data.status || chip.status;
          else
            pane.livePlugins.push({
              name: data.name,
              status: data.status || "started",
            });
        });
      }
      return;
    case "agent":
      if (data?.agentId) {
        markTextBreak(paneId);
        // A named (agent-teams) teammate's addressable identity rides its OWN
        // field: the task_started behind every spawn re-announces the card with
        // no name — and with the subagent type a spawn may have omitted — so a
        // name folded into the label was overwritten within milliseconds. A
        // re-emit for a known agent (it went to the background) may carry no
        // naming field at all, and must not rename its card to the placeholder.
        const name =
          typeof data.name === "string" && data.name.trim()
            ? data.name.trim()
            : undefined;
        const described = [data.subagentType, data.description]
          .filter(Boolean)
          .join(" · ");
        const background = data.background === true;
        ensureAgent(
          paneId,
          data.agentId,
          data.parentId || "main",
          described || undefined,
          "running",
          background,
          name,
        );
        const node = readState()
          .chatPanes.find((p) => p.id === paneId)
          ?.liveAgents.find((a) => a.id === data.agentId);
        const label = (node && agentTitle(node)) || "하위 작업";
        setStatus(
          paneId,
          background ? `백그라운드에서 에이전트 실행 중: ${label}` : `에이전트 작업 중: ${label}`,
          true,
        );
      }
      return;
    case "agent_end":
      if (data?.agentId) {
        updatePane(paneId, (pane) => {
          const node = pane.liveAgents.find((a) => a.id === data.agentId);
          if (node) node.status = data.ok === false ? "failed" : "done";
        });
      }
      return;
    case "tool": {
      if (!data?.toolUseId || !data?.name || HIDDEN_TOOLS.has(data.name))
        return;
      markTextBreak(paneId);
      ensureAgent(paneId, data.agentId || "main");
      const label = humanTool(data.name);
      // The server's inputSummary is the source (summarizeToolInput applies the
      // shared per-tool rule first); the shared rule is repeated here so a frame
      // without it still never shows an opaque id (create_share_link → "7일").
      const detail =
        data.inputSummary ||
        mcpToolInputSummary(data.name, data.input) ||
        summarizeInput(data.input) ||
        undefined;
      upsertTool(paneId, {
        id: data.toolUseId,
        agentId: data.agentId || "main",
        kind: "tool",
        label,
        detail,
        status: "running",
      });
      setStatus(paneId, `${label}${detail ? ` · ${detail}` : ""}`, true);
      return;
    }
    case "tool_end":
      if (data?.toolUseId) {
        updatePane(paneId, (pane) => {
          const row = pane.liveTools.find((t) => t.id === data.toolUseId);
          if (!row || row.status === "blocked") return;
          row.status = data.ok === false ? "failed" : "done";
          const detail =
            data.error ||
            data.inputSummary ||
            (data.output ? summarizeInput(data.output) : "");
          if (detail) row.detail = detail;
        });
      }
      return;
    case "bot_task":
      // A 봇 오피스 delegated-task row (bot_tasks). Deliberately its OWN event
      // name rather than a variant of the `task` frames below: those are SDK
      // activity rows keyed on `taskId` and mean something else entirely, and
      // their handler would drop this payload on that guard. The shape check is
      // defensive validation of an untrusted frame, not the discriminator.
      if (isBotTask(data?.task)) upsertBotTask(data.task);
      return;
    case "task":
    case "task_update":
    case "task_end": {
      if (!data?.taskId) return;
      if (event === "task") markTextBreak(paneId);
      const label = taskLabel(data);
      const detail = taskDetail(data) || undefined;
      const status =
        event === "task_end"
          ? data.ok === false
            ? "failed"
            : "done"
          : "running";
      ensureAgent(paneId, data.agentId || "main");
      upsertTask(paneId, {
        id: data.taskId,
        agentId: data.agentId || "main",
        label,
        detail,
        status,
      });
      if (event !== "task_end")
        setStatus(
          paneId,
          [label, detail].filter(Boolean).join(" · ") || "태스크 진행 중",
          true,
        );
      else
        setStatus(
          paneId,
          data.ok === false ? "태스크가 완료되지 못했습니다." : "태스크 완료",
          true,
        );
      return;
    }
    case "blocked":
      if (data?.toolName) handleBlocked(paneId, data);
      return;
    case "memory":
      if (data?.path) handleMemory(paneId, data);
      return;
    case "compact":
      handleCompact(paneId, data);
      return;
    case "permission":
      enqueuePrompt(paneId, "permission", data);
      return;
    case "question":
      enqueuePrompt(paneId, "question", data);
      return;
    case "canvas":
      if (data?.artifactId) handleCanvas(paneId, data);
      return;
    case "browser":
      if (data?.requestId && data?.op) handleBrowserOp(paneId, data);
      return;
    case "file":
      if (data?.attachment?.id) {
        markTextBreak(paneId);
        updateState((state) => {
          const pane = state.chatPanes.find((item) => item.id === paneId);
          if (!pane) return;
          if (!pane.liveAttachments.some((item) => item.id === data.attachment.id)) {
            // Anchor the card at the CURRENT text length so it stays put while
            // later text streams in below it (the persisted message carries the
            // server-stamped equivalent). The event payload never has an anchor
            // (it's stamped after the emit), so this never overwrites one.
            pane.liveAttachments.push({ ...data.attachment, anchor: pane.liveText.length });
          }
          // A live .drawio share pops the side preview panel open by itself —
          // single-pane layout only: split view has no side-panel slot, so the
          // preview would invisibly hijack the slot for later. Other formats
          // keep click-to-open via the file card.
          if (
            !data.attachment.hidden &&
            isDrawioAttachment(data.attachment) &&
            state.chatPanes.length === 1
          ) {
            pane.filePreview = { attachment: data.attachment, slides: [] };
          }
        });
        setStatus(paneId, data.attachment.kind === "file" ? "파일을 공유했습니다." : "이미지를 표시했습니다.", true);
      }
      return;
    case "plan":
      // Plan mode. EnterPlanMode emits a `planning` signal with no plan yet — show a
      // "writing plan…" placeholder so the (tool-row-suppressed) planning phase isn't
      // mistaken for a stalled turn. ExitPlanMode then delivers the real plan, shown
      // live as a plan card; the persisted `response.plan` takes over once the turn
      // finishes.
      if (typeof data?.plan === "string" && data.plan) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          pane.livePlan = data.plan;
          pane.planPending = false;
        });
        setStatus(paneId, "계획을 제출했습니다.", true);
      } else if (data?.planning) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          pane.planPending = true;
        });
        setStatus(paneId, "계획을 작성하는 중…", true);
      } else {
        // Planning ended without a submitted plan (empty ExitPlanMode): clear the
        // placeholder now so it resolves into the avatar's answer instead of
        // lingering until turn end and vanishing with no trace.
        updatePane(paneId, (pane) => {
          pane.planPending = false;
        });
      }
      return;
    case "plan_review":
      // The avatar proposed a plan (ExitPlanMode) and is awaiting the owner's
      // approval. Show the plan as a live card (in case the "plan" event was
      // missed) and surface inline approve/reject controls keyed by requestId.
      if (data?.requestId && !resolvedRequestIds.has(data.requestId)) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          if (typeof data.plan === "string" && data.plan) {
            pane.livePlan = data.plan;
            pane.planPending = false;
          }
          pane.planReview = { requestId: data.requestId, runId: data.runId || "" };
          pane.planReviewSubmitting = false;
        });
        setStatus(paneId, "계획 승인을 기다리는 중…", true);
        notifyPlanReview(paneId);
      }
      return;
    case "prompt_resolved":
      if (data?.requestId) {
        resolvePrompt(data.requestId);
        // A canvas awaiting input is resolved server-side (timeout/cancel/reconnect):
        // lock its form so it can't be re-submitted to a 404.
        updatePane(paneId, (pane) => {
          const canvas = pane.canvases.find(
            (c) => c.requestId === data.requestId,
          );
          if (canvas) canvas.pending = false;
          // A plan awaiting approval was resolved (answered elsewhere / timeout /
          // reconnect): drop the inline controls so they can't 404 on re-submit.
          if (pane.planReview?.requestId === data.requestId) {
            pane.planReview = null;
            pane.planReviewSubmitting = false;
          }
        });
      }
      return;
    case "bg_tasks":
      // Live background-task set (REPLACE semantics): swap, never merge.
      updatePane(paneId, (pane) => {
        pane.backgroundTasks = Array.isArray(data?.tasks) ? data.tasks : [];
      });
      return;
    case "bg_message":
      // A background wake-up turn was persisted server-side → its own bubble.
      if (data?.message?.role === "assistant")
        appendBackgroundMessage(paneId, data.message as StoredMessage);
      return;
    case "bg_end":
      finalizeBackgroundPhase(paneId, "done");
      return;
    case "steer":
      // One frame per state change, journaled server-side and replayed on
      // reattach — every branch below has to be idempotent. The persisted user
      // row rides INSIDE the steer object, on the `delivered` frame only; the
      // other three states omit the key. Nothing type-checks across this gap,
      // and reading the wrong position would silently produce a synthesized
      // bubble that no reload can dedupe against.
      if (data?.steer?.id)
        handleSteer(paneId, data.steer, data.steer.message ?? null);
      return;
    case "turn_end":
      // NOT terminal: the visible turn was sealed as its own message because a
      // steer is pending, and the follow-up turn continues on this same run.
      finalizeTurnSegment(paneId, data);
      return;
    case "done":
      finalizeDone(paneId, data);
      return;
    case "cancelled": {
      // A stop during the background phase KILLS the pending background work:
      // seal the tree with "failed" rows (and persist that) before the normal
      // stopped-bubble handling.
      const pane = readState().chatPanes.find((p) => p.id === paneId);
      if (pane?.backgroundPhase) finalizeBackgroundPhase(paneId, "failed");
      finalizePane(paneId, "중지됨", true);
      adoptTerminalMessageId(paneId, data?.message);
      return;
    }
    case "error": {
      const pane = readState().chatPanes.find((p) => p.id === paneId);
      if (pane?.backgroundPhase) finalizeBackgroundPhase(paneId, "failed");
      finalizeError(paneId, data?.error || "오류가 발생했습니다.");
      return;
    }
    default:
      return;
  }
}

/* ---------- mid-turn messages ("steers") ---------- */

/**
 * Steer ids that have LEFT the queued state (delivered / completed / dropped).
 * One set, two jobs — both of them replay guards, since a reattach re-applies
 * the whole event log: a repeated `steer{dropped}` must not push its text into
 * the composer twice, and the POST's own 200 must not re-add a pending bubble
 * for a steer the stream already resolved while the request was in flight.
 * Bounded like `handledBrowserOps`; ids settle in order, so the oldest goes first.
 */
const settledSteers = new Set<string>();

/** Mark a steer settled, reporting whether THIS call was the first to do so. */
function settleSteer(id: string): boolean {
  if (settledSteers.has(id)) return false;
  settledSteers.add(id);
  if (settledSteers.size > 500)
    settledSteers.delete(settledSteers.values().next().value as string);
  return true;
}

function upsertPendingSteer(pane: ChatPane, steer: SteerPublic): void {
  if (settledSteers.has(steer.id)) return;
  const list = pane.steers || [];
  if (list.some((item) => item.id === steer.id)) return;
  pane.steers = [
    ...list,
    { id: steer.id, text: steer.text, createdAt: steer.createdAt },
  ];
}

function dropPendingSteer(pane: ChatPane, id: string): void {
  if (!pane.steers?.length) return;
  pane.steers = pane.steers.filter((item) => item.id !== id);
}

/**
 * Put a steer's text back where the user typed it. A draft written since the
 * send goes BELOW it: the returned text is the older thought, and appending
 * would bury it under whatever is half-typed.
 */
function restoreSteerDraft(paneId: string, text: string): void {
  updatePane(paneId, (pane) => {
    pane.draft = pane.draft.trim() ? `${text}\n\n${pane.draft}` : text;
  });
}

function handleSteer(
  paneId: string,
  steer: SteerPublic,
  persisted: StoredMessage | null,
): void {
  switch (steer.state) {
    case "queued":
      updatePane(paneId, (pane) => upsertPendingSteer(pane, steer));
      return;
    case "delivered":
      settleSteer(steer.id);
      updatePane(paneId, (pane) => {
        dropPendingSteer(pane, steer.id);
        // The persisted user row when the server has one; otherwise a local
        // stand-in keyed on the steer id, so the transcript still shows what the
        // model was handed after the conversation was deleted mid-run.
        const row: StoredMessage | null =
          persisted?.role === "user"
            ? persisted
            : persisted
              ? null
              : {
                  id: steer.id,
                  conversationId: pane.conversationId,
                  role: "user",
                  content: steer.text,
                  kind: "steer",
                  response: null,
                  createdAt: steer.createdAt,
                };
        // Once per id: a reload loads the row from the conversation and the
        // replayed frame delivers it again.
        if (row && !pane.messages.some((m) => m.id === row.id))
          pane.messages.push(row);
      });
      return;
    case "completed":
      // Informational — the pending bubble is normally gone by now.
      settleSteer(steer.id);
      updatePane(paneId, (pane) => dropPendingSteer(pane, steer.id));
      return;
    case "dropped": {
      updatePane(paneId, (pane) => dropPendingSteer(pane, steer.id));
      // It never reached the model, so the text is the user's again.
      if (!settleSteer(steer.id)) return;
      restoreSteerDraft(paneId, steer.text);
      notify(
        "응답이 끝나 전달되지 않은 메시지를 입력창에 되돌려 두었습니다.",
        "warn",
      );
      return;
    }
    default:
      return;
  }
}

function handleBlocked(paneId: string, data: any): void {
  // `uiReason` is the server's Korean, user-facing explanation. `reason` mirrors
  // the SDK's `decision_reason`, which is model-facing text and may still be
  // English on paths the server hasn't phrased yet — show it only when there is
  // nothing Korean, and tag it as a detail rather than pass it off as the label.
  const ui = String(data.uiReason || "").trim();
  const raw = String(data.reason || "").trim();
  const korean = ui || (/[가-힣]/.test(raw) ? raw : "");
  const reason = korean
    ? `차단됨 · ${korean}`
    : raw
      ? `차단됨 (상세: ${raw})`
      : "읽기 전용이라 차단됨";
  updatePane(paneId, (pane) => {
    const existing = data.toolUseId
      ? pane.liveTools.find((t) => t.id === data.toolUseId)
      : null;
    if (existing) {
      existing.status = "blocked";
      existing.detail = reason;
      return;
    }
    pane.liveTools.push({
      id: data.toolUseId || newId(),
      agentId: data.agentId || "main",
      kind: "blocked",
      label: humanTool(data.toolName),
      detail: reason,
      status: "blocked",
      segment: rowSegment(pane, data.agentId || "main"),
    });
  });
}

// A second-brain capture (successful repo write under wiki/): render a
// dedicated "기억" row next to the tool rows so the saved memory is visible at
// a glance. The server mints the event id, so a reattach's replay dedupes here.
function handleMemory(paneId: string, data: any): void {
  const id = String(data.id || "") || newId();
  const action = data.action === "update" ? "갱신됨" : "추가됨";
  const label = data.scope === "group" ? `그룹 기억 ${action}` : `기억 ${action}`;
  const groupName = String(data.groupName || "").trim();
  const path = String(data.path || "").trim();
  const detail = groupName ? `${groupName} · ${path}` : path;
  updatePane(paneId, (pane) => {
    if (pane.liveTools.some((t) => t.id === id)) return;
    pane.liveTools.push({
      id,
      agentId: "main",
      kind: "memory",
      label,
      detail,
      status: "done",
      segment: rowSegment(pane, "main"),
    });
  });
}

// A context compaction finished (or failed). The live status label for it is
// transient, so this row is the lasting record that the conversation was
// summarized — it rides the activity rows and is persisted with them. The
// server mints the event id, so a reattach's replay dedupes here.
function handleCompact(paneId: string, data: any): void {
  const id = String(data?.id || "") || newId();
  const failed = data?.ok === false;
  const trigger =
    data?.trigger === "auto" ? "자동 요약" : data?.trigger === "manual" ? "수동 요약" : "";
  const preTokens = Number(data?.preTokens) || 0;
  // `error` is the SDK's English detail — a detail, never the row's label.
  const detail = failed
    ? String(data?.error || "").trim().slice(0, 400)
    : [trigger, preTokens > 0 ? `이전 맥락 약 ${formatTokenCount(preTokens)}토큰` : ""]
        .filter(Boolean)
        .join(" · ");
  markTextBreak(paneId);
  ensureAgent(paneId, "main");
  updatePane(paneId, (pane) => {
    if (pane.liveTools.some((t) => t.id === id)) return;
    pane.liveTools.push({
      id,
      agentId: "main",
      kind: "compact",
      label: failed ? "맥락 정리에 실패했습니다" : "대화 맥락이 요약되었습니다",
      detail: detail || undefined,
      status: failed ? "failed" : "done",
      segment: rowSegment(pane, "main"),
    });
  });
}

function taskLabel(data: any): string {
  if (data?.workflowName) return `워크플로 ${data.workflowName}`;
  if (data?.subagentType) return data.subagentType;
  if (data?.taskType) return String(data.taskType).replace(/_/g, " ");
  // No distinguishing name → leave empty; the row's "태스크" badge already labels
  // it, so a "태스크" fallback here would render redundantly next to the badge.
  return "";
}
function taskDetail(data: any): string {
  return (
    data?.summary ||
    data?.description ||
    data?.prompt ||
    data?.lastToolName ||
    data?.error ||
    data?.status ||
    ""
  );
}

/* ---------- activity-tree mutation helpers ---------- */

function ensureAgent(
  paneId: string,
  agentId: string,
  parentId = "main",
  label?: string,
  status?: "running" | "done" | "failed",
  background = false,
  name?: string,
): void {
  updatePane(paneId, (pane) => {
    if (!pane.liveAgents.some((a) => a.id === "main")) {
      pane.liveAgents.push({
        id: "main",
        parentId: "",
        label: "",
        status: "running",
        isMain: true,
      });
    }
    if (agentId === "main") return;
    const existing = pane.liveAgents.find((a) => a.id === agentId);
    if (existing) {
      // The fuller label wins: a re-announce that drops a part the card
      // already shows ("조사" or "general-purpose" under "general-purpose ·
      // 조사") keeps the card's, while one that adds a part (the subagent type
      // a spawn omitted) takes over.
      const covered =
        existing.label === label ||
        existing.label.endsWith(` · ${label}`) ||
        existing.label.startsWith(`${label} · `);
      if (label && !covered) existing.label = label;
      // A name, once known, is never cleared: re-announces carry none.
      if (name) existing.name = name;
      if (status) existing.status = status;
      if (background) existing.background = true;
      return;
    }
    pane.liveAgents.push({
      id: agentId,
      parentId: parentId || "main",
      label: label || "하위 작업",
      status: status || "running",
      isMain: false,
      // A nested agent belongs to its parent's turn, like the parent's own rows.
      segment: rowSegment(pane, parentId || "main"),
      ...(name ? { name } : {}),
      ...(background ? { background: true } : {}),
    });
  });
}

// Rows are stamped with their segment once, at creation: a later update (a
// background shell settling during a wake-up turn) keeps the turn it started in.
function upsertTool(paneId: string, row: LiveToolRow): void {
  updatePane(paneId, (pane) => {
    const existing = pane.liveTools.find((t) => t.id === row.id);
    if (existing) {
      existing.label = row.label;
      if (row.detail !== undefined) existing.detail = row.detail;
      existing.status = row.status;
      existing.kind = row.kind;
    } else {
      pane.liveTools.push({ ...row, segment: rowSegment(pane, row.agentId) });
    }
  });
}

function upsertTask(paneId: string, row: LiveTaskRow): void {
  updatePane(paneId, (pane) => {
    const existing = pane.liveTasks.find((t) => t.id === row.id);
    if (existing) {
      // task_update/task_end frames may omit the naming fields (subagentType/
      // workflowName/taskType), making taskLabel() "" — that must not wipe the
      // label captured at task start.
      if (row.label) existing.label = row.label;
      if (row.detail !== undefined) existing.detail = row.detail;
      existing.status = row.status;
      existing.agentId = row.agentId;
    } else {
      pane.liveTasks.push({ ...row, segment: rowSegment(pane, row.agentId) });
    }
  });
}

/** Mark that activity (a tool/agent/task) interrupted the text stream, so the
 *  next text delta starts a fresh paragraph instead of running onto the line
 *  before the activity. Mirrors the server's `\n\n` join between assistant chunks. */
function markTextBreak(paneId: string): void {
  updatePane(paneId, (pane) => {
    if (pane.liveText && !pane.liveText.endsWith("\n"))
      pane.liveTextBreakPending = true;
    // Tool / agent / task / plan activity interrupts reasoning: stop the pulse.
    pane.thinkingActive = false;
  });
}

function setStatus(paneId: string, label: string, sticky: boolean): void {
  updatePane(paneId, (pane) => {
    const now = Date.now();
    if (
      !sticky &&
      pane.liveStatusStickyUntil &&
      now < pane.liveStatusStickyUntil
    )
      return;
    pane.liveStatus = label;
    pane.liveStatusStickyUntil = sticky ? now + 1500 : 0;
  });
}

function resetLive(pane: ChatPane): void {
  pane.turnFinalized = false;
  pane.liveText = "";
  pane.liveAttachments = [];
  pane.liveTextBreakPending = false;
  pane.liveThinking = "";
  pane.thinkingActive = false;
  pane.livePlan = "";
  pane.planPending = false;
  pane.planReview = null;
  pane.planReviewSubmitting = false;
  pane.liveStatus = "";
  pane.liveAgents = [];
  pane.liveTools = [];
  pane.liveTasks = [];
  pane.livePlugins = [];
  pane.liveStatusStickyUntil = 0;
  pane.backgroundPhase = false;
  pane.backgroundTasks = [];
  pane.backgroundMessageId = null;
  pane.liveSegment = 0;
  pane.segmentMessageIds = [];
  // Pending steers belong to the LIVE turn: a reattach replays every `steer`
  // frame, so the list is rebuilt from the log rather than carried across.
  pane.steers = [];
  pane.steerSending = false;
}

/* ---------- finalizers ---------- */

// Snapshot the live activity tree so the COMPLETED bubble keeps showing what ran
// (otherwise the tree vanishes the instant the run finishes). Normalize any still
// "running" node to the terminal status so it doesn't render a perpetual spinner:
// "done" on a natural finish, "failed" when the run was killed with background
// work still in flight (those tasks really died — "done" would be a lie).
function snapshotActivity(
  pane: ChatPane,
  terminal: "done" | "failed" = "done",
): AgentActivity | undefined {
  if (!pane.liveTools.length && !pane.liveTasks.length) return undefined;
  return sealRows(
    { agents: pane.liveAgents, tools: pane.liveTools, tasks: pane.liveTasks },
    terminal,
  );
}

/** A persisted copy of a live row: the segment stamp is live-only bookkeeping. */
function unstamped<T extends { segment?: number }>(row: T): T {
  const copy = { ...row };
  delete copy.segment;
  return copy;
}

function sealRows(rows: SegmentRows, terminal: "done" | "failed"): AgentActivity {
  return {
    agents: rows.agents.map((a) => ({
      ...unstamped(a),
      status: a.status === "running" ? terminal : a.status,
    })),
    tools: rows.tools.map((t) => ({
      ...unstamped(t),
      status: t.status === "running" ? terminal : t.status,
    })),
    tasks: rows.tasks.map((t) => ({
      ...unstamped(t),
      status: t.status === "running" ? terminal : t.status,
    })),
  };
}

function attachActivity(
  response: AgentResponse | null,
  activity: AgentActivity | undefined,
): void {
  if (response && activity) response.activity = activity;
}

// Keep the plan card on the finished bubble: the server already sets
// `response.plan` on persisted responses, but a client-built response
// (stop/error, or a fallback done without `response`) wouldn't carry it — so
// graft the live plan on when the response is missing one.
function attachPlan(
  response: AgentResponse | null,
  plan: string | undefined,
): void {
  if (response && plan && !response.plan) response.plan = plan;
}

// Same as attachPlan for the reasoning view: the server sets `response.thinking`
// on persisted responses, but a client-built response (stop/error, or a fallback
// done without `response`) wouldn't carry it — graft the live thinking on then.
function attachThinking(
  response: AgentResponse | null,
  thinking: string | undefined,
): void {
  if (response && thinking && !response.thinking) response.thinking = thinking;
}

function finalizeDone(paneId: string, data: any): void {
  // done{background:true}: the SDK session keeps running background work past
  // this point — finalize the bubble but keep the live tree until bg_end.
  if (data?.background) {
    finalizeBackgroundTurn(paneId, data);
    return;
  }
  // Only a turn that actually landed is announced: a reconnect replays the whole
  // event log, and the deduped frame must not re-fire the notification.
  if (finalizeVisibleTurn(paneId, data, false)) notifyTurnComplete(paneId);
}

/**
 * `turn_end`: the visible turn so far was sealed as its own assistant message
 * because a steer is still pending, and the model answers it as a follow-up turn
 * on the SAME run. Identical to `done`'s bubble handling, but the stream stays
 * open — and there is nothing to announce yet, so no OS notification fires.
 */
function finalizeTurnSegment(paneId: string, data: any): void {
  finalizeVisibleTurn(paneId, data, true);
}

/**
 * Seal the visible turn into an assistant message. Shared by `done` (the run is
 * over) and `turn_end` (`segment`: a follow-up turn continues on this run).
 * Returns whether a bubble was actually appended.
 */
function finalizeVisibleTurn(
  paneId: string,
  data: any,
  segment: boolean,
): boolean {
  // A persisted server message id + its activity → persist the
  // snapshot so the completed tool/agent tree survives reload.
  let persistMessageId: string | null = null;
  let persistActivity: AgentActivity | undefined;
  let appended = false;
  updatePane(paneId, (pane) => {
    // A buffered done frame can surface AFTER stopPane already finalized the
    // turn (the click interleaves between frame reads); the stopped bubble is
    // the turn's ending, and the server-persisted message shows on reload.
    if (pane.turnFinalized) return;
    const activity = snapshotActivity(pane);
    const message = data?.message as StoredMessage | undefined;
    // Dedupe by id: a reattach replays the whole event log, and the loaded
    // conversation may already contain this persisted message.
    if (
      message?.role === "assistant" &&
      message.id &&
      pane.messages.some((m) => m.id === message.id)
    ) {
      endLiveTurn(pane, segment);
      return;
    }
    if (message?.role === "assistant") {
      attachActivity(message.response, activity);
      attachPlan(message.response, pane.livePlan);
      attachThinking(message.response, pane.liveThinking);
      pane.messages.push(message);
      appended = true;
      pane.usage = message.response?.usage ?? pane.usage;
      if (message.id && activity) {
        persistMessageId = message.id;
        persistActivity = activity;
      }
    } else if (pane.liveText || data?.response) {
      const response = data?.response as AgentResponse | undefined;
      attachActivity(response ?? null, activity);
      attachPlan(response ?? null, pane.livePlan);
      attachThinking(response ?? null, pane.liveThinking);
      pane.messages.push({
        id: newId(),
        conversationId: pane.conversationId,
        role: "assistant",
        content: response?.text || response?.summary || pane.liveText,
        attachments: pane.liveAttachments.length ? [...pane.liveAttachments] : undefined,
        response: response || null,
        createdAt: new Date().toISOString(),
      });
      appended = true;
      pane.usage = response?.usage ?? pane.usage;
    }
    endLiveTurn(pane, segment);
  });
  if (persistMessageId && persistActivity) {
    // Best effort: the in-session display already works without this; it only adds
    // reload durability.
    api(`/api/messages/${encodeURIComponent(persistMessageId)}/activity`, {
      method: "PUT",
      body: JSON.stringify({ activity: persistActivity }),
    }).catch(() => {});
  }
  return appended;
}

/**
 * Wind the live turn down. `done` ends the stream with it (`clearLive`);
 * `turn_end` keeps `streaming` / `liveRunId` / `abortController` — those belong
 * to the RUN, not to the turn — so the follow-up turn streams into a clean
 * bubble. The pending steer survives the reset by design: it is delivered a beat
 * later and its own frame is what clears it.
 */
function endLiveTurn(pane: ChatPane, segment: boolean): void {
  if (!segment) {
    clearLive(pane);
    return;
  }
  const steers = pane.steers;
  const steerSending = pane.steerSending;
  resetLive(pane);
  pane.steers = steers;
  pane.steerSending = steerSending;
  pane.liveStatus = "이어서 응답 준비 중…";
}

// OS notification when a turn finishes — only fires while the app is backgrounded
// (osNotify gates on document visibility), so it never interrupts active reading.
function notifyTurnComplete(paneId: string): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane) return;
  const last = pane.messages[pane.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  const text = (last.content || "").replace(/\s+/g, " ").trim();
  const body = text
    ? text.length > 140
      ? `${text.slice(0, 140)}…`
      : text
    : "응답이 완료되었습니다.";
  osNotify(
    `${pane.avatar?.alias || pane.avatar?.displayName || "아바타"} · 답변 완료`,
    body,
    `done-${paneId}`,
  );
}

/* ---------- background phase (SDK keeps running after the visible turn) ---------- */

// done{background:true}: push the finalized turn's message, keep the live
// activity tree mounted (its rows keep updating until bg_end), and flip the
// pane into its background phase — the chip renders and the send button stays
// a stop button (killing the run kills the background work).
function finalizeBackgroundTurn(paneId: string, data: any): void {
  let appended = false;
  updatePane(paneId, (pane) => {
    const message = data?.message as StoredMessage | undefined;
    if (
      message?.role === "assistant" &&
      !(message.id && pane.messages.some((m) => m.id === message.id))
    ) {
      attachPlan(message.response, pane.livePlan);
      attachThinking(message.response, pane.liveThinking);
      pane.messages.push(message);
      appended = true;
      pane.usage = message.response?.usage ?? pane.usage;
    }
    pane.backgroundMessageId = message?.id || null;
    // The finalized turn is segment 0: rows created from here on belong to the
    // first wake-up turn, unless a segment-0 agent owns them. Only on ENTERING
    // the phase — a reattach replays this frame after a resetLive, never twice.
    if (!pane.backgroundPhase) {
      pane.segmentMessageIds = [message?.id || ""];
      pane.liveSegment = 1;
    }
    pane.backgroundPhase = true;
    if (Array.isArray(data?.tasks)) pane.backgroundTasks = data.tasks;
    // Clear only the text-ish live state (it moved into the pushed message);
    // agents/tools/tasks/plugins stay so the running rows remain visible.
    pane.liveText = "";
    pane.liveAttachments = [];
    pane.liveTextBreakPending = false;
    pane.liveThinking = "";
    pane.thinkingActive = false;
    pane.livePlan = "";
    pane.planPending = false;
    pane.liveStatus = "백그라운드 작업 진행 중…";
  });
  // The sidebar's background badge should show up the moment the phase starts.
  // Best effort, like the activity PUT: a failed refresh is not the viewer's
  // problem and must not surface as an error on a turn that worked.
  loadConversations().catch(() => {});
  // A reconnect replays this frame; announcing a turn the viewer was already told
  // about would re-fire the notification on every reconnect.
  if (appended) notifyTurnComplete(paneId);
}

// A background wake-up turn was persisted server-side: append it as its own
// assistant bubble. Dedupe by id — a reattach replays the whole event log.
function appendBackgroundMessage(paneId: string, message: StoredMessage): void {
  let appended = false;
  updatePane(paneId, (pane) => {
    // This wake-up turn's rows now have a bubble of their own; later rows start
    // the next segment. Before the dedupe below: a reattach replays the frame
    // onto a transcript that already holds the message, and the segment still
    // has to close.
    const ids = pane.segmentMessageIds ?? [];
    if (pane.backgroundPhase && message.id && !ids.includes(message.id)) {
      const segment = pane.liveSegment ?? ids.length;
      ids[segment] = message.id;
      pane.segmentMessageIds = ids;
      pane.liveSegment = segment + 1;
    }
    if (message.id && pane.messages.some((m) => m.id === message.id)) return;
    pane.messages.push(message);
    pane.usage = message.response?.usage ?? pane.usage;
    // The wake-up turn's streamed tail (text/thinking/attachments) is embodied
    // in the pushed message — reset the live state for the next wake-up so the
    // same content doesn't render twice (live cards + message cards).
    pane.liveText = "";
    pane.liveTextBreakPending = false;
    pane.liveThinking = "";
    pane.thinkingActive = false;
    pane.liveAttachments = [];
    appended = true;
  });
  if (!appended) return;
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const name = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  const text = (message.content || "").replace(/\s+/g, " ").trim();
  osNotify(
    `${name} · 백그라운드 작업 보고`,
    text ? (text.length > 140 ? `${text.slice(0, 140)}…` : text) : "백그라운드 작업이 완료되었습니다.",
    `bg-${paneId}`,
  );
}

// The background phase ended — naturally (bg_end → terminal "done") or by a
// kill (cancelled/error → "failed"). Seal the live tree with that terminal
// status, persist the snapshots, and drop the live rows. Each bubble gets ITS
// OWN rows (lib/activitySegments.ts): the finalized turn keeps its work,
// background agents' late calls included, and every wake-up turn keeps the
// tools it ran — they used to all land on the finalized turn. A kill keeps the
// streamed text tail: the caller's finalizePane / finalizeError persists it as
// the terminal bubble right after this.
function finalizeBackgroundPhase(
  paneId: string,
  terminal: "done" | "failed",
): void {
  const patches: { id: string; activity: AgentActivity }[] = [];
  updatePane(paneId, (pane) => {
    if (!pane.backgroundPhase) return;
    for (const [id, segments] of segmentSealTargets(pane)) {
      const rows = segmentRows(pane, segments);
      if (!hasRows(rows)) continue;
      const activity = sealRows(rows, terminal);
      const target = pane.messages.find((m) => m.id === id);
      if (target?.response) target.response.activity = activity;
      patches.push({ id, activity });
    }
    pane.backgroundPhase = false;
    pane.backgroundTasks = [];
    pane.backgroundMessageId = null;
    pane.liveAgents = [];
    pane.liveTools = [];
    pane.liveTasks = [];
    pane.livePlugins = [];
    if (terminal === "done") clearLive(pane);
  });
  for (const patch of patches) {
    // Best effort, like finalizeDone: display already works without it — this
    // only adds reload durability for the sealed trees.
    api(`/api/messages/${encodeURIComponent(patch.id)}/activity`, {
      method: "PUT",
      body: JSON.stringify({ activity: patch.activity }),
    }).catch(() => {});
  }
}

/**
 * Per pane, the client-minted id of the last stopped/error bubble. A `cancelled`
 * frame carries the row the server persisted for that stop; adopting its id keeps
 * the bubble addressable like every other stored message. Cleared by each send.
 */
const terminalMessageIds = new Map<string, string>();

function adoptTerminalMessageId(paneId: string, persisted: unknown): void {
  const clientId = terminalMessageIds.get(paneId);
  terminalMessageIds.delete(paneId);
  const serverId = (persisted as { id?: unknown } | null | undefined)?.id;
  if (!clientId || typeof serverId !== "string" || !serverId) return;
  updatePane(paneId, (pane) => {
    if (pane.messages.some((m) => m.id === serverId)) return;
    const row = pane.messages.find((m) => m.id === clientId);
    if (row) adoptServerId(row, serverId);
  });
}

// Build a client-side terminal (stop/error) assistant message: a text
// AgentResponse carrying the snapshot activity + live plan, push it, then clear the
// live state. Callers compute their own summary/text/content.
function pushTerminalMessage(
  pane: ChatPane,
  { summary, text, content }: { summary: string; text: string; content: string },
): void {
  const response: AgentResponse = {
    kind: "text",
    runtime: "claude",
    summary,
    text,
  };
  attachActivity(response, snapshotActivity(pane));
  attachPlan(response, pane.livePlan);
  attachThinking(response, pane.liveThinking);
  const id = newId();
  terminalMessageIds.set(pane.id, id);
  pane.messages.push({
    id,
    conversationId: pane.conversationId,
    role: "assistant",
    content,
    attachments: pane.liveAttachments.length ? [...pane.liveAttachments] : undefined,
    response,
    createdAt: new Date().toISOString(),
  });
  clearLive(pane);
  // AFTER clearLive — resetLive clears the marker, and this turn's terminal
  // bubble is exactly what later finalizers must not duplicate.
  pane.turnFinalized = true;
}

function finalizePane(paneId: string, message: string, stopped: boolean): void {
  updatePane(paneId, (pane) => {
    // Idempotent by design: stopPane finalizes at the user's stop, and the loop
    // the abort lands in (send catch, followSendDrop, a cancelled frame) calls
    // this again when the abort surfaces — the second call must not push a
    // second bubble.
    if (pane.turnFinalized) return;
    pushTerminalMessage(pane, {
      summary: stopped ? "중지됨" : "오류",
      text: pane.liveText,
      content: pane.liveText || (stopped ? "(중지됨)" : message),
    });
  });
}

function finalizeError(paneId: string, message: string): void {
  updatePane(paneId, (pane) => {
    pushTerminalMessage(pane, {
      summary: "오류",
      text: pane.liveText || message,
      content: pane.liveText ? `${pane.liveText}\n\n${message}` : message,
    });
  });
  notify(`메시지를 보내지 못했습니다: ${message}`);
}

function clearLive(pane: ChatPane): void {
  resetLive(pane);
  pane.streaming = false;
}

/* ---------- visual canvas (experimental, #50) ---------- */

// A canvas artifact arrived over SSE: upsert by artifact id and bring it to the
// front. `pending` (the run is parked, awaiting the user) is true ONLY for a
// BLOCKING canvas — an async canvas's controls render but don't park the run.
// Browser bridge: the run is PARKED on this operation. Hand it to the
// extension and POST whatever comes back — including failures, so the run
// resumes with a usable reason instead of waiting out its TTL. Replayed frames
// are deduped on requestId: reattaching to a run replays the whole event log,
// and re-executing a click would act on the page twice.
const handledBrowserOps = new Set<string>();

/**
 * Does this op carry a stored secret's plaintext? `type` carries it whole,
 * `fill_form` per field. The PRESENCE of the policy is the marker — never the
 * value, which must not be touched outside the relay below.
 */
function opCarriesSecret(data: any): boolean {
  if (data?.secret) return true;
  const fields = data?.fields;
  return Array.isArray(fields) && fields.some((field: any) => field?.secret);
}

/**
 * Model-facing refusal for an install that predates stored-secret input. An
 * older build does not know `secretText`/`secretValue`, so it would type
 * NOTHING and answer as if it had succeeded — a silent no-op the run cannot
 * distinguish from a login that worked, which is exactly why the value is
 * withheld rather than sent hopefully.
 */
function secretInputUnsupportedReply(version: string | undefined): BridgeReply {
  return {
    ok: false,
    message:
      `The installed Noah browser extension (${version ? `v${version}` : "version unknown"}) predates stored-secret input ` +
      `(needs ${SECRET_INPUT_MIN_EXTENSION_VERSION} or newer), so the secret was NOT typed. ` +
      "Tell the user to update the extension from 설정 → 접근/보안 → 브라우저 브릿지 " +
      "(download the zip again, replace the loaded folder's contents, press ↻ on the extension card), then retry.",
  };
}

/**
 * Hand the op to the extension — but for a secret-carrying op, only after the
 * INSTALLED build has vouched for itself. Nothing in the op reports the
 * extension version, so this probe is the only place it can be read, and it
 * runs BEFORE the plaintext leaves this frame.
 */
async function relayBrowserOp(
  operation: BridgeOperation,
  carriesSecret: boolean,
): Promise<BridgeReply> {
  if (!carriesSecret) return sendToExtension(operation);
  const probe = await readAllowedOrigins();
  // Unreachable or erroring extension: its own reason is the true one (and is
  // already written for the model), so don't overwrite it with a version story.
  if (!probe.ok) return { ok: false, message: probe.message };
  if (!extensionSupportsSecretInput(probe.version)) {
    return secretInputUnsupportedReply(probe.version);
  }
  return sendToExtension(operation);
}

function handleBrowserOp(paneId: string, data: any): void {
  const requestId = String(data.requestId);
  if (handledBrowserOps.has(requestId)) return;
  handledBrowserOps.add(requestId);
  if (handledBrowserOps.size > 500) {
    // Bound the dedupe set; ids are consumed in order, so the oldest is safe to drop.
    handledBrowserOps.delete(handledBrowserOps.values().next().value as string);
  }

  const BROWSER_OP_LABELS: Record<string, string> = {
    navigate: "브라우저를 이동하는 중…",
    navigate_back: "이전 페이지로 돌아가는 중…",
    click: "브라우저를 클릭하는 중…",
    click_at: "화면 좌표를 클릭하는 중…",
    drag: "마우스로 드래그하는 중…",
    type: "브라우저에 입력하는 중…",
    fill_form: "브라우저 폼을 채우는 중…",
    select_option: "옵션을 선택하는 중…",
    press_key: "브라우저에 키를 입력하는 중…",
    hover: "브라우저에서 마우스를 올리는 중…",
    scroll: "브라우저를 스크롤하는 중…",
    wait_for: "페이지 변화를 기다리는 중…",
    read_text: "페이지 본문을 읽는 중…",
    read_cookies: "쿠키를 읽는 중…",
    read_storage: "브라우저 저장소를 읽는 중…",
    screenshot: "브라우저 화면을 캡처하는 중…",
    handle_dialog: "브라우저 대화상자에 응답하는 중…",
    dialog_status: "브라우저 대화상자 상태를 확인하는 중…",
    list_tabs: "브라우저 탭을 확인하는 중…",
    new_tab: "새 탭을 여는 중…",
    select_tab: "탭을 전환하는 중…",
    close_tab: "탭을 닫는 중…",
  };
  // The value itself never reaches a label: only the fact that one rides along,
  // so the user can see the avatar is entering a credential rather than text.
  const carriesSecret = opCarriesSecret(data);
  const label =
    carriesSecret && data.op === "type"
      ? "브라우저에 시크릿을 입력하는 중…"
      : carriesSecret && data.op === "fill_form"
        ? "브라우저 폼을 채우는 중(시크릿 포함)…"
        : data.op === "read_text" && data.expand
          ? "페이지를 스크롤하며 본문을 읽는 중…"
          : (BROWSER_OP_LABELS[String(data.op)] ?? "브라우저 화면을 읽는 중…");
  setStatus(paneId, label, false);

  const operation: BridgeOperation = {
    // The extension coalesces duplicate relays on this id: a run watched from
    // several open Noah tabs delivers this frame to EVERY tab, and the
    // handledBrowserOps dedupe above is a per-tab Set that cannot see them.
    requestId,
    op: data.op,
    url: data.url,
    name: data.name,
    kind: data.kind,
    uid: data.uid,
    x: data.x,
    y: data.y,
    xFraction: data.xFraction,
    yFraction: data.yFraction,
    toUid: data.toUid,
    toX: data.toX,
    toY: data.toY,
    toXFraction: data.toXFraction,
    toYFraction: data.toYFraction,
    text: data.text,
    // Relayed VERBATIM (whole objects, as the server sent them): the policy the
    // extension re-enforces at the keyboard, and the plaintext it types. Both
    // stop here — nothing downstream of this call may read them.
    secret: data.secret,
    secretText: data.secretText,
    submit: Boolean(data.submit),
    clear: Boolean(data.clear),
    keystrokes: Boolean(data.keystrokes),
    key: data.key,
    modifiers: data.modifiers,
    repeat: data.repeat,
    direction: data.direction,
    pixels: data.pixels,
    accept: data.accept,
    promptText: data.promptText,
    textGone: data.textGone,
    timeoutS: data.timeoutS,
    tabId: data.tabId,
    fields: data.fields,
    option: data.option,
    fullPage: data.fullPage,
    offset: data.offset,
    expand: data.expand,
    maxChars: data.maxChars,
  };

  void relayBrowserOp(operation, carriesSecret)
    .then((reply) =>
      api("/api/chat/respond", {
        method: "POST",
        body: JSON.stringify({ runId: data.runId, requestId, value: reply }),
      }),
    )
    .catch(() => {
      // The answer POST itself failed (run ended, network). Nothing to retry —
      // the server's park TTL settles the run on its own.
    });
}

// True while the LIVE run is parked on a blocking canvas: the run resumes only
// via /api/chat/respond, so the user — not the avatar — is the blocker.
function awaitingCanvasAnswer(paneId: string): boolean {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane) return false;
  return pane.canvases.some(
    (c) => c.pending && c.requestId && c.runId && c.runId === pane.liveRunId,
  );
}

function handleCanvas(paneId: string, data: any): void {
  const controls = Array.isArray(data.controls) ? data.controls : undefined;
  const interaction =
    data.interaction === "blocking" || data.interaction === "async"
      ? data.interaction
      : undefined;
  const pending = Boolean(controls && controls.length && interaction !== "async");
  updatePane(paneId, (pane) => {
    const prev = pane.canvases.find((c) => c.id === data.artifactId);
    const entry: PaneCanvas = {
      id: data.artifactId,
      title: data.title || "캔버스",
      content: typeof data.content === "string" ? data.content : "",
      contentType: data.contentType || "markdown",
      controls,
      interaction,
      editable: Boolean(data.editable),
      runId: data.runId || pane.liveRunId || undefined,
      requestId: data.requestId || undefined,
      // Blocking only: an async canvas shows controls but the run isn't parked.
      pending,
      // Refining in place bumps the version client-side too so the version-history
      // button (gated on versionCount > 1) appears WITHOUT a reload. The server is
      // authoritative on reload and may dedup an unchanged re-show, so this can
      // briefly over-count; loadMessages re-hydrates the exact numbers.
      currentVersion: prev ? (prev.currentVersion || 1) + 1 : 1,
      versionCount: prev ? (prev.versionCount || 1) + 1 : 1,
    };
    const idx = pane.canvases.findIndex((c) => c.id === entry.id);
    if (idx >= 0) pane.canvases[idx] = entry;
    else pane.canvases.push(entry);
    pane.activeCanvasId = entry.id;
    // A canvas that ASKS for input must be seen. The file preview owns the side
    // slot while it is open, so an owner who clicked the new deck card would
    // never see the next review round's form (the deck-review loop would stall
    // silently). Clicking the card reopens the preview.
    if (controls?.length) pane.filePreview = null;
  });
  // A blocking canvas parks the run on the USER's answer — say so instead of
  // leaving the last "실행 중: …" tool label implying avatar work.
  if (pending) setStatus(paneId, "캔버스 응답을 기다리는 중…", true);
}

export function setActiveCanvas(paneId: string, canvasId: string): void {
  updatePane(paneId, (pane) => {
    pane.activeCanvasId = canvasId;
  });
}

// Submit the user's response to a canvas's controls. Two paths:
// - BLOCKING (the run is parked, awaiting this answer): POST /api/chat/respond to
//   unblock the parked run, exactly as before.
// - ASYNC / re-submit / post-reload (no live parked run): deliver the answer as a
//   NEW chat turn via sendMessage(canvasSubmission) — naturally double-submit safe.
export async function submitCanvas(
  paneId: string,
  canvasId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  if (!canvas) return;
  const blocking = Boolean(canvas.pending && canvas.requestId && canvas.runId);
  if (blocking) {
    updatePane(paneId, (p) => {
      const c = p.canvases.find((x) => x.id === canvasId);
      if (c) c.submitting = true;
    });
    try {
      await api("/api/chat/respond", {
        method: "POST",
        body: JSON.stringify({
          runId: canvas.runId,
          requestId: canvas.requestId,
          value: { values },
        }),
      });
      updatePane(paneId, (p) => {
        const c = p.canvases.find((x) => x.id === canvasId);
        if (c) {
          c.pending = false;
          c.submitting = false;
          c.submittedValues = values;
        }
      });
      // Move the status line off "기다리는 중" immediately; the resumed run's
      // next event overwrites this.
      setStatus(paneId, "캔버스 응답을 보냈습니다.", true);
    } catch (err) {
      updatePane(paneId, (p) => {
        const c = p.canvases.find((x) => x.id === canvasId);
        if (c) c.submitting = false;
      });
      notify(
        `캔버스 응답을 전송하지 못했습니다: ${(err as Error).message}`,
        "warn",
      );
    }
    return;
  }
  // Async / re-submit: a new turn. Record the answer optimistically so the panel
  // shows "응답 완료"; sendMessage manages the streaming lifecycle.
  if (pane?.streaming) return;
  updatePane(paneId, (p) => {
    const c = p.canvases.find((x) => x.id === canvasId);
    if (c) c.submittedValues = values;
  });
  await sendMessage(paneId, "", { canvasSubmission: { canvasId, values } });
}

// Send the user's edited canvas content back to the avatar as a new turn (#50).
export async function submitCanvasEdit(
  paneId: string,
  canvasId: string,
  editedContent: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane || pane.streaming) return;
  const canvas = pane.canvases.find((c) => c.id === canvasId);
  if (!canvas || !editedContent.trim()) return;
  await sendMessage(paneId, "", {
    canvasSubmission: { canvasId, editedContent },
  });
}

// Cancel a parked BLOCKING canvas's run (so it can proceed past awaitResponse).
// No-op for a non-blocking/display-only canvas. Best-effort: swallows failures
// (the run may have already ended).
async function cancelParkedCanvas(
  canvas: PaneCanvas,
  opts: { deleteCanvas?: boolean } = {},
): Promise<void> {
  if (!(canvas.pending && canvas.requestId && canvas.runId)) return;
  await api("/api/chat/respond", {
    method: "POST",
    body: JSON.stringify({
      runId: canvas.runId,
      requestId: canvas.requestId,
      value: opts.deleteCanvas
        ? { cancelled: true, deleteCanvas: true }
        : { cancelled: true },
    }),
  }).catch(() => {});
}

// Dismiss a canvas's prompt without answering (sends a cancellation so the parked
// run can proceed). For a non-blocking/display-only canvas this just hides locally.
export async function dismissCanvas(
  paneId: string,
  canvasId: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  const parked = Boolean(canvas?.pending && canvas?.requestId && canvas?.runId);
  if (canvas) await cancelParkedCanvas(canvas);
  updatePane(paneId, (p) => {
    const c = p.canvases.find((x) => x.id === canvasId);
    if (c) c.pending = false;
  });
  if (parked) setStatus(paneId, "캔버스 응답을 건너뛰었습니다.", true);
}

function isMissingCanvasError(err: unknown): boolean {
  return (
    (err as Error)?.message?.includes("캔버스를 찾을 수 없습니다.") ?? false
  );
}

// Close a canvas tab. A still-pending BLOCKING canvas must cancel its parked run
// FIRST (else the run hangs on awaitResponse); a persisted canvas is hard-deleted
// server-side; then it's removed locally and the active tab recomputed.
export async function closeCanvas(
  paneId: string,
  canvasId: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  if (!canvas) return;
  // Cancel a parked blocking run before removal.
  await cancelParkedCanvas(canvas, { deleteCanvas: true });
  // Hard-delete if it has been persisted. Greeting-only ephemeral canvases were
  // never stored, so a 404 here is expected and should still close locally.
  try {
    await api(`/api/chat/canvases/${encodeURIComponent(canvasId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (!isMissingCanvasError(err)) {
      notify(`캔버스를 삭제하지 못했습니다: ${(err as Error).message}`, "warn");
      return;
    }
  }
  updatePane(paneId, (p) => {
    const idx = p.canvases.findIndex((c) => c.id === canvasId);
    if (idx < 0) return;
    p.canvases.splice(idx, 1);
    if (p.activeCanvasId === canvasId) {
      const next =
        p.canvases[idx] ||
        p.canvases[idx - 1] ||
        p.canvases[p.canvases.length - 1];
      p.activeCanvasId = next ? next.id : null;
    }
  });
}

// Fetch a canvas's version history for the rollback UI.
export async function fetchCanvasVersions(
  canvasId: string,
): Promise<{ version: number; createdAt: string }[]> {
  // Let the error PROPAGATE: CanvasPanel has a versionsError branch + a retry
  // button that only work if a failure actually throws. Swallowing to [] here
  // rendered a real failure as a silently empty version list.
  const res = await api<{
    versions: { version: number; createdAt: string }[];
  }>(`/api/chat/canvases/${encodeURIComponent(canvasId)}/versions`);
  return res.versions || [];
}

// Roll back a canvas to an earlier version (non-destructive) and update the panel.
export async function rollbackCanvas(
  paneId: string,
  canvasId: string,
  version: number,
): Promise<void> {
  try {
    const res = await api<{ canvas: PaneCanvas }>(
      `/api/chat/canvases/${encodeURIComponent(canvasId)}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    );
    updatePane(paneId, (p) => {
      const idx = p.canvases.findIndex((c) => c.id === canvasId);
      if (idx >= 0) p.canvases[idx] = { ...p.canvases[idx], ...res.canvas };
    });
  } catch (err) {
    notify(`캔버스를 되돌리지 못했습니다: ${(err as Error).message}`, "warn");
  }
}

/* ---------- interactive prompts (permission / question) ---------- */

// requestIds already resolved server-side (replay/prompt_resolved) — skip showing.
const resolvedRequestIds = new Set<string>();

function enqueuePrompt(
  paneId: string,
  kind: "permission" | "question",
  data: any,
): void {
  const requestId = data?.requestId;
  if (!requestId || resolvedRequestIds.has(requestId)) return;
  if (readState().promptQueue.some((p) => p.id === requestId)) return;
  updateState((state) => {
    if (state.promptQueue.some((p) => p.id === requestId)) return;
    state.promptQueue.push({
      id: requestId,
      runId: data.runId || "",
      paneId,
      kind,
      data,
    });
  });
  notifyPrompt(paneId, kind, data);
}

// OS notification when the avatar needs the owner's input (an AskUserQuestion-style
// question or a permission request). Like answer-complete, this only fires while the
// app is backgrounded; in the foreground the prompt modal itself is visible.
function notifyPrompt(
  paneId: string,
  kind: "permission" | "question",
  data: any,
): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const who = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  if (kind === "question") {
    const questions = Array.isArray(data?.payload?.questions)
      ? data.payload.questions
      : null;
    const first =
      questions?.[0]?.question ||
      questions?.[0]?.header ||
      "확인이 필요한 질문이 있습니다.";
    osNotify(`${who} · 질문`, String(first), `prompt-${data.requestId}`);
  } else {
    const tool = humanTool(data?.toolName);
    osNotify(
      `${who} · 확인 필요`,
      `"${tool}" 실행을 승인해 주세요.`,
      `prompt-${data.requestId}`,
    );
  }
}

// OS notification when the avatar's proposed plan is waiting on the owner's
// approval. Like the prompt notifications, only meaningful while backgrounded.
function notifyPlanReview(paneId: string): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const who = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  osNotify(
    `${who} · 계획 승인 필요`,
    "제안한 계획을 검토해 주세요.",
    `plan-${paneId}`,
  );
}

function resolvePrompt(requestId: string): void {
  resolvedRequestIds.add(requestId);
  updateState((state) => {
    state.promptQueue = state.promptQueue.filter((p) => p.id !== requestId);
  });
}

function dropRunPrompts(paneId: string): void {
  updateState((state) => {
    state.promptQueue = state.promptQueue.filter((p) => p.paneId !== paneId);
  });
}

// Submit the owner's response to a prompt. Removes it from the queue on success;
// on failure, surfaces a toast (the run may have already ended).
export async function answerPrompt(
  requestId: string,
  value: unknown,
): Promise<void> {
  const request = readState().promptQueue.find((p) => p.id === requestId);
  if (!request) return;
  try {
    await api("/api/chat/respond", {
      method: "POST",
      body: JSON.stringify({
        runId: request.runId,
        requestId: request.id,
        value,
      }),
    });
    resolvedRequestIds.add(requestId);
    updateState((state) => {
      state.promptQueue = state.promptQueue.filter((p) => p.id !== requestId);
    });
  } catch (err) {
    notify(`응답을 전송하지 못했습니다: ${(err as Error).message}`, "warn");
    throw err;
  }
}

// Submit the owner's plan-approval decision for the pane's pending ExitPlanMode
// review. Unlike answerPrompt, a plan review lives on the pane (inline on the
// plan card), not in the prompt queue. Approve → the avatar implements; reject
// → the optional feedback is fed back to the model so it revises the plan.
export async function respondPlanReview(
  paneId: string,
  behavior: "approved" | "rejected",
  feedback?: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const review = pane?.planReview;
  if (!review || pane?.planReviewSubmitting) return;
  updatePane(paneId, (pane) => {
    pane.planReviewSubmitting = true;
  });
  try {
    await api("/api/chat/respond", {
      method: "POST",
      body: JSON.stringify({
        runId: review.runId,
        requestId: review.requestId,
        value:
          behavior === "approved"
            ? { behavior: "approved" }
            : { behavior: "rejected", feedback: feedback?.trim() || undefined },
      }),
    });
    resolvedRequestIds.add(review.requestId);
    updatePane(paneId, (pane) => {
      pane.planReview = null;
      pane.planReviewSubmitting = false;
    });
    setStatus(
      paneId,
      behavior === "approved"
        ? "계획을 승인했습니다."
        : "계획 수정을 요청했습니다.",
      true,
    );
  } catch (err) {
    updatePane(paneId, (pane) => {
      pane.planReviewSubmitting = false;
    });
    notify(`응답을 전송하지 못했습니다: ${(err as Error).message}`, "warn");
    throw err;
  }
}

/* ---------- helpers ---------- */

/** Rebuild the pane's canvas list from persisted assistant-message responses. */
// Rebuild the panel from the server's canvas artifacts (current version of each),
// the authoritative source on reload (the dedicated canvas tables). On reload there
// is no live run, so pending/runId/requestId stay unset and the form re-enables for
// async/editable canvases (which submit as a new turn, not via a parked run).
function paneCanvasesFromArtifacts(
  canvases: CanvasArtifact[] | undefined,
): PaneCanvas[] {
  const out: PaneCanvas[] = [];
  for (const canvas of canvases || []) {
    const existing = out.findIndex((c) => c.id === canvas.id);
    const entry: PaneCanvas = { ...canvas, pending: false };
    if (existing >= 0) out[existing] = entry;
    else out.push(entry);
  }
  return out;
}

function lastUsage(messages: StoredMessage[]): ChatPane["usage"] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.response?.usage;
    if (usage && (Number(usage.inputTokens) || Number(usage.outputTokens)))
      return usage;
  }
  return null;
}

function updatePane(paneId: string, mutator: (pane: ChatPane) => void): void {
  updateState((state) => {
    const pane = state.chatPanes.find((item) => item.id === paneId);
    if (pane) mutator(pane);
  });
}

// The TRANSCRIPT half of a loadMessages() result: messages, canvases and the usage
// snapshot — never the composer's selections. The messages MERGE into what the
// pane shows (keys and activity snapshots carried by id), so a re-read of an open
// pane re-mounts nothing. The rewind re-reads apply this half alone: the pickers
// stay live while a run streams ("다음 메시지부터 적용됩니다"), and a pick made
// mid-run or before a refused edit must not flip back.
function applyLoadedTranscript(
  target: ChatPane,
  loaded: Awaited<ReturnType<typeof loadMessages>>,
): void {
  target.messages = mergeLoadedMessages(target.messages ?? [], loaded.messages ?? []);
  target.canvases = paneCanvasesFromArtifacts(loaded.canvases);
  target.usage = lastUsage(target.messages);
}

// Apply a loadMessages() result onto a pane/draft target: the transcript plus the
// per-conversation picker selections (falling back to defaults). Shared by the four
// full-load sites (select / split / attachActiveRun / attachRun-404) so they stay
// in lockstep.
function applyLoadedConversation(
  target: ChatPane,
  loaded: Awaited<ReturnType<typeof loadMessages>>,
): void {
  applyLoadedTranscript(target, loaded);
  target.groupKnowledgeOff = loaded.groupKnowledgeOff || [];
  target.modelTier = loaded.selectedModel || undefined;
  target.effort = loaded.selectedEffort || undefined;
  target.mcpToolGroups = loaded.selectedMcpToolGroups ?? [
    ...DEFAULT_MCP_TOOL_GROUPS,
  ];
}
