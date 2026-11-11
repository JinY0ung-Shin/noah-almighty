import { get } from "./store";
import { appState, updateState } from "./state";
import type { ClientState } from "./state";
import type { AdminTab, SettingsTab, ViewName } from "./types";

// Views a non-admin may not open at all, so a typed/bookmarked hash lands on
// 탐색 instead of an empty screen.
const ADMIN_ONLY_VIEWS: ViewName[] = ["admin"];

function viewDenied(view: ViewName, state: ClientState): boolean {
  return ADMIN_ONLY_VIEWS.includes(view) && !state.user?.roles?.includes("admin");
}

const VIEW_ROUTES: ViewName[] = ["explore", "chat", "todos", "brain", "teamBrain", "inbox", "routines", "skills", "settings", "admin", "share", "uiGallery"];
const SETTINGS_TABS: SettingsTab[] = ["profile", "access", "knowledge"];
const ADMIN_TABS: AdminTab[] = [
  "overview",
  "users",
  "mcp",
  "access",
  "system",
  "tools",
  "team_brain",
  "audit",
];

let applyingRoute = false;

export function routeFromHash(): { view: ViewName | null; arg: string | null } {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  let decoded: string | null = null;
  try {
    decoded = arg ? decodeURIComponent(arg) : null;
  } catch {
    decoded = null;
  }
  return { view: VIEW_ROUTES.includes(view as ViewName) ? (view as ViewName) : null, arg: decoded };
}

export function currentRoute(): string {
  const state = get(appState);
  if (state.view === "chat") {
    const pane = state.chatPanes.find((item) => item.id === state.activePaneId) ?? state.chatPanes[0];
    return pane?.conversationId ? `#/chat/${encodeURIComponent(pane.conversationId)}` : "#/chat";
  }
  if (state.view === "settings") return `#/settings/${state.settingsTab}`;
  if (state.view === "admin") return `#/admin/${state.adminTab}`;
  if (state.view === "routines") {
    return state.routineConversationId ? `#/routines/${encodeURIComponent(state.routineConversationId)}` : "#/routines";
  }
  if (state.view === "todos") {
    return state.todoSelectedId ? `#/todos/${encodeURIComponent(state.todoSelectedId)}` : "#/todos";
  }
  // The token IS the page. A syncHash from anywhere (a run stream's `open`
  // frame, a conversation switch) must write it back, or the URL collapses to
  // "#/share" and a reload or Back loses the link.
  if (state.view === "share") {
    return state.shareToken ? `#/share/${encodeURIComponent(state.shareToken)}` : "#/share";
  }
  return `#/${state.view}`;
}

export function syncHash(replace = false): void {
  const state = get(appState);
  if (applyingRoute || !state.user) return;
  const target = currentRoute();
  if (location.hash === target) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
}

export function goView(view: ViewName, arg?: string): void {
  updateState((state) => {
    if (viewDenied(view, state)) view = "explore";
    state.view = view;
    if (view === "settings" && isSettingsTab(arg)) state.settingsTab = arg;
    if (view === "admin" && isAdminTab(arg)) state.adminTab = arg;
    if (view === "routines" && arg) state.routineConversationId = arg;
    if (view === "todos" && arg) state.todoSelectedId = arg;
    if (view === "share") state.shareToken = arg || "";
  });
  syncHash();
}

export function applyInitialRoute(): void {
  const { view, arg } = routeFromHash();
  updateState((state) => {
    if (!view) return;
    if (viewDenied(view, state)) {
      state.view = "explore";
      return;
    }
    state.view = view;
    if (view === "settings" && isSettingsTab(arg)) state.settingsTab = arg;
    if (view === "admin" && isAdminTab(arg)) state.adminTab = arg;
    if (view === "routines" && arg) state.routineConversationId = arg;
    if (view === "todos" && arg) state.todoSelectedId = arg;
    if (view === "share") state.shareToken = arg || "";
  });
}

export function installRouteListener(onChatRoute?: (conversationId: string) => void): () => void {
  const handler = () => {
    const { view, arg } = routeFromHash();
    if (!view) return;
    applyingRoute = true;
    updateState((state) => {
      if (viewDenied(view, state)) {
        state.view = "explore";
        return;
      }
      state.view = view;
      if (view === "settings" && isSettingsTab(arg)) state.settingsTab = arg;
      if (view === "admin" && isAdminTab(arg)) state.adminTab = arg;
      if (view === "routines" && arg) state.routineConversationId = arg;
      if (view === "todos" && arg) state.todoSelectedId = arg;
      // A second share link opened while the viewer is mounted: ShareView
      // refetches on the token change itself (same pure-state pattern).
      if (view === "share") state.shareToken = arg || "";
    });
    applyingRoute = false;
    if (view === "chat" && arg) onChatRoute?.(arg);
  };
  window.addEventListener("popstate", handler);
  window.addEventListener("hashchange", handler);
  return () => {
    window.removeEventListener("popstate", handler);
    window.removeEventListener("hashchange", handler);
  };
}

function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

function isAdminTab(value: string | null | undefined): value is AdminTab {
  return ADMIN_TABS.includes(value as AdminTab);
}
