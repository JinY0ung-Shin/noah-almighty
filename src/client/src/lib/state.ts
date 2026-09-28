import { get, writable } from "svelte/store";
import type {
  AdminGroupSummary,
  AdminPresence,
  AdminStats,
  AdminTab,
  AdminUserSummary,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  BootstrapInfo,
  BotTask,
  ChatLayout,
  ChatPane,
  ConversationSummary,
  KnowledgeRequest,
  Plugin,
  PromptRequest,
  RoutineJob,
  SettingsTab,
  Toast,
  User,
  ViewName,
} from "./types";

/**
 * Unseen delegated-task counts, exactly as `GET /api/me/bot-tasks/unseen`
 * answers them: settled tasks (완료/실패/입력 대기) the owner has not looked at
 * yet, `total` across every bot plus a per-`personal_agents.id` breakdown. The
 * server has no named type for the shape, so this is its one client-side name —
 * `POST /api/me/bot-tasks/seen` answers the same object.
 */
export interface BotTaskUnseen {
  total: number;
  agents: Record<string, number>;
}

export interface ClientState {
  booted: boolean;
  bootError: string;
  bootstrap: BootstrapInfo | null;
  user: User | null;
  view: ViewName;
  settingsTab: SettingsTab;
  adminTab: AdminTab;
  /** Active source on the brain (knowledge-graph) view: "personal" or "group:<id>". */
  brainSource: string;
  /** Bot selected in 봇 오피스 (`personal_agents.id`); "" = none picked yet. */
  botsAgentId: string;
  /**
   * Token of the share link the share view shows (`#/share/<token>`); "" when
   * none. It lives here, not only in the hash, because currentRoute() rebuilds
   * the hash from state on every syncHash — without it the link would be lost.
   */
  shareToken: string;
  /** File name of the deck the share view shows, for the tab title; "" until it loads. */
  shareTitle: string;
  /**
   * Delegated bot tasks across ALL of the owner's bots, newest first. Fed by
   * 봇 오피스's poll AND by the run stream's `task` frames, so the roster's
   * status dots stay right even while the owner is reading another bot's thread.
   */
  botTasks: BotTask[];
  /**
   * What the rail's 봇 오피스 badge counts. Replaced wholesale from the two
   * bot-task endpoints (never merged) so a narrowed 읽음 stamp can still drop the
   * badges it cleared, and left at zero for anyone the feature is closed to.
   */
  botTaskUnseen: BotTaskUnseen;
  avatars: AvatarSummary[];
  avatarsLoaded: boolean;
  avatarsLoading: boolean;
  exploreQuery: string;
  currentAvatar: AvatarDetail | null;
  chatPanes: ChatPane[];
  activePaneId: string | null;
  chatLayout: ChatLayout;
  conversations: ConversationSummary[];
  plugins: Plugin[];
  knowledgeRequests: KnowledgeRequest[];
  notifications: AvatarNotification[];
  inboxFilter: "all" | "unread" | "requests" | "notifications";
  routines: RoutineJob[];
  routineConversations: ConversationSummary[];
  routineConversationId: string;
  routineMessages: import("./types").StoredMessage[];
  routineSearch: string;
  routineTypeFilter: "all" | "recurring" | "once";
  routineFilter: "all" | "enabled" | "paused" | "completed" | "error";
  adminUsers: AdminUserSummary[];
  adminGroups: AdminGroupSummary[];
  adminUserFilter: "all" | "admins" | "suspended" | "group" | "sessions";
  adminUserSearch: string;
  adminGroupSearch: string;
  adminStats: AdminStats | null;
  adminSystem: Record<string, unknown> | null;
  /** Live "who's here now" for the admin-only rail badge; null until first poll. */
  adminPresence: AdminPresence | null;
  audit: AuditEvent[];
  /** Interactive permission/question prompts awaiting the owner (one shown at a time). */
  promptQueue: PromptRequest[];
  /**
   * One-shot deep link from the what's-new dialog: the 권한·연결 tab opens the
   * browser-bridge install guide on its next activation, then clears this.
   */
  browserGuideRequested: boolean;
  /**
   * One-shot re-open of the first-run onboarding modal, set by the 시작 안내
   * settings card. App.svelte consumes and clears it — the modal is a global
   * overlay, so unlike browserGuideRequested this carries no view change, and
   * it is independent of `user.onboardedAt` (already-onboarded owners re-open
   * it on demand).
   */
  onboardingRequested: boolean;
  splitAvatarId: string;
  streaming: boolean;
  themePref: "system" | "light" | "dark";
}

export const appState = writable<ClientState>({
  booted: false,
  bootError: "",
  bootstrap: null,
  user: null,
  view: "explore",
  settingsTab: "profile",
  adminTab: "overview",
  brainSource: "personal",
  botsAgentId: "",
  shareToken: "",
  shareTitle: "",
  botTasks: [],
  botTaskUnseen: { total: 0, agents: {} },
  avatars: [],
  avatarsLoaded: false,
  avatarsLoading: false,
  exploreQuery: "",
  currentAvatar: null,
  chatPanes: [],
  activePaneId: null,
  chatLayout: "vertical",
  conversations: [],
  plugins: [],
  knowledgeRequests: [],
  notifications: [],
  inboxFilter: "all",
  routines: [],
  routineConversations: [],
  routineConversationId: "",
  routineMessages: [],
  routineSearch: "",
  routineTypeFilter: "all",
  routineFilter: "all",
  adminUsers: [],
  adminGroups: [],
  adminUserFilter: "all",
  adminUserSearch: "",
  adminGroupSearch: "",
  adminStats: null,
  adminSystem: null,
  adminPresence: null,
  audit: [],
  promptQueue: [],
  browserGuideRequested: false,
  onboardingRequested: false,
  splitAvatarId: "",
  streaming: false,
  themePref: "system",
});

export const toasts = writable<Toast[]>([]);

interface ToastTimer {
  remainingMs: number;
  startedAt: number;
  timeoutId: number | null;
}

const toastTimers = new Map<string, ToastTimer>();

function clearToastTimer(id: string): void {
  const timer = toastTimers.get(id);
  if (timer?.timeoutId != null) window.clearTimeout(timer.timeoutId);
  toastTimers.delete(id);
}

function scheduleToastTimer(id: string, timer: ToastTimer): void {
  if (timer.remainingMs <= 0) {
    dismissToast(id);
    return;
  }
  timer.startedAt = Date.now();
  timer.timeoutId = window.setTimeout(() => dismissToast(id), timer.remainingMs);
  toastTimers.set(id, timer);
}

export function readState(): ClientState {
  return get(appState);
}

export function updateState(mutator: (state: ClientState) => void): void {
  appState.update((state) => {
    mutator(state);
    state.streaming = state.chatPanes.some((pane) => pane.streaming);
    return state;
  });
}

export function replaceState(patch: Partial<ClientState>): void {
  appState.update((state) => {
    const next = { ...state, ...patch };
    next.streaming = next.chatPanes.some((pane) => pane.streaming);
    return next;
  });
}

export function newId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function activePane(): ChatPane | null {
  const state = readState();
  return state.chatPanes.find((pane) => pane.id === state.activePaneId) ?? state.chatPanes[0] ?? null;
}

export function notify(message: string, kind: Toast["kind"] = "warn", opts: Partial<Toast> = {}): void {
  const toast: Toast = { id: newId(), message, kind, ...opts };
  const durationMs = opts.durationMs ?? (opts.action ? 9000 : kind === "warn" ? 7000 : 5000);
  let droppedIds: string[] = [];
  toasts.update((items) => {
    const kept = items.slice(-3);
    const keptIds = new Set(kept.map((item) => item.id));
    droppedIds = items.filter((item) => !keptIds.has(item.id)).map((item) => item.id);
    return [...kept, toast];
  });
  for (const id of droppedIds) clearToastTimer(id);
  scheduleToastTimer(toast.id, { remainingMs: durationMs, startedAt: Date.now(), timeoutId: null });
  if (typeof document !== "undefined" && document.hidden) pauseToast(toast.id);
}

export function dismissToast(id: string): void {
  clearToastTimer(id);
  toasts.update((items) => items.filter((item) => item.id !== id));
}

/** Keep actionable feedback available while the user is reading or interacting with it. */
export function pauseToast(id: string): void {
  const timer = toastTimers.get(id);
  if (!timer || timer.timeoutId == null) return;
  window.clearTimeout(timer.timeoutId);
  timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
  timer.timeoutId = null;
}

export function resumeToast(id: string): void {
  const timer = toastTimers.get(id);
  if (!timer || timer.timeoutId != null) return;
  scheduleToastTimer(id, timer);
}

export function setDocumentTitle(): void {
  const state = readState();
  if (state.streaming) {
    document.title = "● 응답 중 · Noah Almighty";
    return;
  }
  if (!state.user) {
    document.title = "Noah Almighty";
    return;
  }
  const titles: Record<ViewName, string> = {
    explore: "탐색",
    chat: activePane()?.avatar.alias || activePane()?.avatar.displayName || "대화",
    bots: "봇 오피스",
    brain: "지식 그래프",
    inbox: "알림",
  routines: "예약 작업",
    groups: "그룹",
    skills: "스킬 배우기",
    settings: "내 아바타",
    admin: "관리자",
    // From state, not set by the view: this subscriber rewrites the title on
    // EVERY store emission (the knowledge poll included), so a title the view
    // wrote to document.title directly would be gone within a minute.
    share: state.shareTitle || "공유된 PPT",
  };
  document.title = `${titles[state.view] || "Noah Almighty"} · Noah Almighty`;
}

appState.subscribe(() => {
  if (typeof document !== "undefined") setDocumentTitle();
});
