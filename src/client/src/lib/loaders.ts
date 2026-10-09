import { api, refreshMe } from "./api";
import { goView } from "./nav";
import { notify, readState, replaceState, updateState } from "./state";
import { emptyTodoState, refreshTodos, resetTodoClientState } from "./todos";
import type {
  AdminGroupSummary,
  AdminPresence,
  AdminStats,
  AdminUserSummary,
  AuditEvent,
  AvatarNotification,
  AvatarSummary,
  CanvasArtifact,
  ConversationSummary,
  KnowledgeRequest,
  Plugin,
  RoutineJob,
  StoredMessage,
} from "./types";

export async function loadAvatars(force = false): Promise<AvatarSummary[]> {
  let shouldLoad = false;
  updateState((state) => {
    shouldLoad = force || (!state.avatarsLoaded && !state.avatarsLoading);
    if (shouldLoad) state.avatarsLoading = true;
  });
  if (!shouldLoad) return [];
  try {
    const { avatars } = await api<{ avatars: AvatarSummary[] }>("/api/avatars");
    // A body without the key degrades to "no avatars" instead of breaking every
    // view that reads the list.
    const list = avatars ?? [];
    replaceState({ avatars: list, avatarsLoaded: true, avatarsLoading: false });
    return list;
  } catch (err) {
    updateState((state) => {
      state.avatarsLoading = false;
    });
    throw err;
  }
}

export async function loadConversations(kind: "chat" | "routine" | "all" = "chat"): Promise<ConversationSummary[]> {
  const path = kind === "chat" ? "/api/conversations" : `/api/conversations?kind=${kind}`;
  const { conversations } = await api<{ conversations: ConversationSummary[] }>(path);
  if (kind === "routine") replaceState({ routineConversations: conversations });
  else replaceState({ conversations });
  return conversations;
}

export async function loadMessages(
  conversationId: string,
): Promise<{
  messages: StoredMessage[];
  groupKnowledgeOff: string[];
  selectedModel?: string | null;
  selectedEffort?: string | null;
  selectedMcpToolGroups?: import("../../../shared/mcpToolGroups").McpToolGroupId[] | null;
  canvases?: CanvasArtifact[];
}> {
  return api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
}

export async function loadSettingsData(): Promise<void> {
  const [me, plugins, requests] = await Promise.all([
    refreshMe(),
    api<{ plugins: Plugin[] }>("/api/me/plugins"),
    api<{ requests: KnowledgeRequest[] }>("/api/me/knowledge/requests"),
  ]);
  void me;
  replaceState({ plugins: plugins.plugins, knowledgeRequests: requests.requests });
}

export interface InboxLoadResult {
  requestsError: string | null;
  notificationsError: string | null;
  routinesError: string | null;
}

// Best-effort: render whatever loaded and report per-backend failures instead of
// throwing, so one failing backend doesn't blank the whole inbox.
export async function loadInboxData(): Promise<InboxLoadResult> {
  const [requests, notifications, routines] = await Promise.allSettled([
    api<{ requests: KnowledgeRequest[] }>("/api/me/knowledge/requests"),
    api<{ notifications: AvatarNotification[] }>("/api/me/notifications"),
    loadConversations("routine"),
  ]);
  if (requests.status === "fulfilled") replaceState({ knowledgeRequests: requests.value.requests });
  if (notifications.status === "fulfilled") replaceState({ notifications: notifications.value.notifications });
  syncInboxBaseline();
  return {
    requestsError: requests.status === "rejected" ? (requests.reason as Error).message : null,
    notificationsError: notifications.status === "rejected" ? (notifications.reason as Error).message : null,
    routinesError: routines.status === "rejected" ? (routines.reason as Error).message : null,
  };
}

// Open-request / unread-notification counts we've already nudged about, so the
// toast fires only on genuinely NEW items — not on every poll. Mirrors the old
// loaders.js announce baselines.
let lastAnnouncedRequestCount = 0;
let lastAnnouncedNotificationCount = 0;

function openRequestCount(): number {
  return readState().knowledgeRequests.filter((r) => r.status === "open").length;
}
function unreadNotificationCount(): number {
  return readState().notifications.filter((n) => !n.readAt).length;
}
function syncInboxBaseline(): void {
  lastAnnouncedRequestCount = openRequestCount();
  lastAnnouncedNotificationCount = unreadNotificationCount();
}

// Reload open requests + toast when the count grew since we last nudged — the
// in-app "alarm" for gaps the avatar logged via request_info while the owner was
// elsewhere. Keeps the current state on transient failure.
export async function refreshKnowledgeStatus({ announce = false } = {}): Promise<void> {
  if (!readState().user) return;
  try {
    const { requests } = await api<{ requests: KnowledgeRequest[] }>("/api/me/knowledge/requests");
    replaceState({ knowledgeRequests: requests });
  } catch {
    return;
  }
  const open = openRequestCount();
  if (announce && open > lastAnnouncedRequestCount) {
    notify(`아직 답하지 못한 정보 요청이 ${open}건 있어요. ‘알림’에서 확인해 주세요.`, "info", {
      actionLabel: "알림 열기",
      action: () => goView("inbox"),
    });
  }
  lastAnnouncedRequestCount = open;
}

export async function refreshNotificationStatus({ announce = false } = {}): Promise<void> {
  if (!readState().user) return;
  try {
    const { notifications } = await api<{ notifications: AvatarNotification[] }>("/api/me/notifications");
    replaceState({ notifications });
  } catch {
    return;
  }
  const unread = unreadNotificationCount();
  if (announce && unread > lastAnnouncedNotificationCount) {
    notify(`새 아바타 알림이 ${unread}건 있습니다. ‘알림’에서 확인해 주세요.`, "info", {
      actionLabel: "알림 열기",
      action: () => goView("inbox"),
    });
  }
  lastAnnouncedNotificationCount = unread;
}

/**
 * Live "who's here now" for the admin rail badge. Non-admins skip the request
 * entirely (the route would 403). Failures are swallowed: the badge keeps its
 * last value rather than flashing an error at someone who didn't ask for it.
 */
export async function refreshAdminPresence(): Promise<void> {
  if (!readState().user?.roles?.includes("admin")) return;
  try {
    const { presence } = await api<{ presence: AdminPresence }>("/api/admin/presence");
    replaceState({ adminPresence: presence });
  } catch {
    /* ignore */
  }
}

// Poll while the tab is visible (cheap once/min) and refresh the moment the owner
// returns to the tab, so a colleague's new question surfaces without a reload.
// This same tick is what keeps `users.last_seen_at` warm for an idle-but-open
// tab, which is exactly what the presence window above is measured against —
// so presence rides along here instead of adding a second timer.
let knowledgeWatchTimer: number | null = null;
function onKnowledgeVisible(): void {
  if (!document.hidden) {
    void refreshKnowledgeStatus({ announce: true });
    void refreshNotificationStatus({ announce: true });
    void refreshAdminPresence();
    // The to-do list rides the same tick: routines and external-task runs edit it
    // with no chat stream open, so this is how their changes reach the overlay.
    void refreshTodos();
  }
}
/** Stop the poll only. Leaves the account's state alone (startKnowledgeWatch reuses it on boot). */
function clearKnowledgeWatch(): void {
  if (knowledgeWatchTimer != null) {
    window.clearInterval(knowledgeWatchTimer);
    knowledgeWatchTimer = null;
  }
  document.removeEventListener("visibilitychange", onKnowledgeVisible);
  lastAnnouncedRequestCount = 0;
  lastAnnouncedNotificationCount = 0;
}
export function startKnowledgeWatch(): void {
  // NOT stopKnowledgeWatch(): its account reset would wipe what boot already
  // restored from the URL (a #/todos/<id> deep link's selection).
  clearKnowledgeWatch();
  knowledgeWatchTimer = window.setInterval(onKnowledgeVisible, 60000);
  document.addEventListener("visibilitychange", onKnowledgeVisible);
  // Knowledge/notification counts arrive with loadInboxData at boot; presence has
  // no such loader, so seed it here instead of leaving the badge blank for a minute.
  // The 할 일 list (rail badge + chat overlay) is seeded the same way.
  void refreshAdminPresence();
  void refreshTodos();
}
/** Stop the poll AND forget the account's state — the logout / session-expiry / teardown path. */
export function stopKnowledgeWatch(): void {
  clearKnowledgeWatch();
  // Don't leave another account's presence list (or to-do list) in state.
  resetTodoClientState();
  replaceState({
    adminPresence: null,
    todos: emptyTodoState(),
    todoSelectedId: "",
    todoSearch: "",
    todoOverlayDismissed: false,
  });
}

export async function loadRoutinesData(): Promise<void> {
  const [routines, conversations] = await Promise.all([
    api<{ routines: RoutineJob[] }>("/api/me/routines"),
    loadConversations("routine"),
  ]);
  replaceState({ routines: routines.routines, routineConversations: conversations });
}

export async function loadRoutineMessages(conversationId: string): Promise<void> {
  const { messages } = await loadMessages(conversationId);
  replaceState({ routineMessages: messages });
}

export async function loadAdminOverview(): Promise<void> {
  const [stats, system, users, audit] = await Promise.all([
    api<{ stats: AdminStats }>("/api/admin/stats"),
    api<Record<string, unknown>>("/api/admin/system"),
    api<{ users: AdminUserSummary[] }>("/api/admin/users"),
    api<{ audit: AuditEvent[] }>("/api/audit"),
  ]);
  replaceState({ adminStats: stats.stats, adminSystem: system, adminUsers: users.users, audit: audit.audit });
}

export async function loadAdminGroups(): Promise<void> {
  const { groups } = await api<{ groups: AdminGroupSummary[] }>("/api/admin/groups");
  replaceState({ adminGroups: groups });
}

// The full user roster alone — the 그룹 view's AdminGroupRow member picker
// browses $appState.adminUsers, without pulling the rest of loadAdminOverview.
export async function loadAdminUsers(): Promise<void> {
  const { users } = await api<{ users: AdminUserSummary[] }>("/api/admin/users");
  replaceState({ adminUsers: users });
}
