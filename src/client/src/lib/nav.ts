import { get } from "svelte/store";
import { appState, updateState } from "./state";
import type { ClientState } from "./state";
import type { AdminTab, SettingsTab, ViewName } from "./types";

// Views a non-admin may not open at all, so a typed/bookmarked hash lands on
// 탐색 instead of an empty screen.
const ADMIN_ONLY_VIEWS: ViewName[] = ["admin"];

function viewDenied(view: ViewName, state: ClientState): boolean {
  return ADMIN_ONLY_VIEWS.includes(view) && !state.user?.roles?.includes("admin");
}

const VIEW_ROUTES: ViewName[] = ["explore", "chat", "todos", "brain", "inbox", "routines", "groups", "skills", "settings", "admin", "share"];
const SETTINGS_TABS: SettingsTab[] = ["profile", "access", "knowledge"];
const ADMIN_TABS: AdminTab[] = [
  "overview",
  "users",
  "external-agents",
  "access",
  "system",
  "audit",
];

let applyingRoute = false;

export function routeFromHash(): { view: ViewName | null; arg: string | null } {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  // Legacy: the 그룹 tab moved out of 내 아바타/관리자 into its own left-rail
  // view — old bookmarks land on the merged #/groups view.
  if ((view === "settings" || view === "admin") && arg === "groups") {
    return { view: "groups", arg: null };
  }
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
  if (state.view === "brain") {
    return state.brainSource && state.brainSource !== "personal"
      ? `#/brain/${encodeURIComponent(state.brainSource)}`
      : "#/brain";
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
    if (view === "brain") state.brainSource = arg || "personal";
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
    if (view === "brain") state.brainSource = arg || "personal";
    if (view === "share") state.shareToken = arg || "";
  });
  // Rewrite a legacy groups alias in place so it never enters history (Back
  // would otherwise bounce through #/settings/groups → same view).
  const [rawView, rawArg] = location.hash.replace(/^#\/?/, "").split("/");
  if ((rawView === "settings" || rawView === "admin") && rawArg === "groups") {
    history.replaceState(null, "", "#/groups");
  }
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
      if (view === "brain") state.brainSource = arg || "personal";
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
