import { useEffect, useRef, useState, type ComponentType } from "react";
import AuthView from "./components/AuthView";
import ConfirmationDialog from "./components/ConfirmationDialog";
import { ViewBoundary } from "./components/ErrorBoundary";
import FeatureHintLayer from "./components/FeatureHintLayer";
import NoticeBar from "./components/NoticeBar";
import OnboardingModal from "./components/OnboardingModal";
import PromptModal from "./components/PromptModal";
import Shell from "./components/Shell";
import Toasts from "./components/Toasts";
import WhatsNewModal from "./components/WhatsNewModal";
import { dismissAdminNotice } from "./lib/adminNotice";
import { api, setSessionExpiredHandler } from "./lib/api";
import { selectConversation } from "./lib/chat";
import { cx, useAppState } from "./lib/hooks";
import { loadRailCollapsed, persistRailCollapsed } from "./lib/layout";
import { loadInboxData, startKnowledgeWatch, stopKnowledgeWatch } from "./lib/loaders";
import { applyInitialRoute, installRouteListener, syncHash } from "./lib/nav";
import { Presence } from "./lib/presence";
import { notify, readState, replaceState, updateState } from "./lib/state";
import { applyTheme, getThemePref, watchSystemTheme } from "./lib/theme";
import { unseenReleases, type ReleaseNote } from "../../server/releaseNotes";
import type { BootstrapInfo, User, ViewName } from "./lib/types";

const viewLoaders: Record<ViewName, () => Promise<{ default: ComponentType }>> = {
  explore: () => import("./views/ExploreView"),
  chat: () => import("./views/ChatView"),
  todos: () => import("./views/TodosView"),
  brain: () => import("./views/BrainView"),
  teamBrain: () => import("./views/TeamBrainView"),
  inbox: () => import("./views/InboxView"),
  routines: () => import("./views/RoutinesView"),
  skills: () => import("./views/SkillsView"),
  settings: () => import("./views/SettingsView"),
  admin: () => import("./views/AdminView"),
  share: () => import("./views/ShareView"),
  uiGallery: () => import("./views/UiGalleryView"),
};
const viewCache = new Map<ViewName, ComponentType>();
const viewLabels: Record<ViewName, string> = {
  explore: "탐색",
  chat: "대화",
  todos: "할 일",
  brain: "내 브레인",
  teamBrain: "팀 브레인",
  inbox: "알림",
  routines: "예약 작업",
  skills: "스킬 배우기",
  settings: "내 아바타",
  admin: "관리자",
  share: "공유된 PPT",
  uiGallery: "인라인 UI 갤러리",
};

let themeWatcherInstalled = false;

async function boot(): Promise<void> {
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
    // enterApp() runs from the init guard below once the user is set.
  } catch (err) {
    replaceState({ booted: true, bootError: (err as Error).message, themePref: getThemePref() });
  }
}

export default function App() {
  const state = useAppState();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [whatsNewReleases, setWhatsNewReleases] = useState<ReleaseNote[]>([]);
  const [railCollapsed, setRailCollapsedState] = useState(loadRailCollapsed);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [activeView, setActiveView] = useState<{ name: ViewName | null; component: ComponentType | null }>({
    name: null,
    component: null,
  });
  const activeViewName = useRef<ViewName | null>(null);
  const viewLoadToken = useRef(0);
  const initializedFor = useRef<string | null>(null);
  // A share link is often a colleague's FIRST contact with Noah. The welcome
  // and what's-new modals would open over the deck they were sent (and the
  // welcome's 시작하기 routes to 탐색), so while the app STARTS on the share view
  // both are held back. Nothing is marked seen server-side, so they surface on
  // the first move to another view (or the next load).
  const introDeferred = useRef(false);

  async function loadView(view: ViewName): Promise<void> {
    const token = ++viewLoadToken.current;
    activeViewName.current = view;
    const cached = viewCache.get(view);
    if (cached) {
      setActiveView({ name: view, component: cached });
      return;
    }
    setActiveView({ name: view, component: null });
    const component = (await viewLoaders[view]()).default;
    viewCache.set(view, component);
    if (token === viewLoadToken.current && activeViewName.current === view) setActiveView({ name: view, component });
  }

  function setRailCollapsed(collapsed: boolean): void {
    setRailCollapsedState(collapsed);
    persistRailCollapsed(collapsed);
  }

  function showIntro(user: User): void {
    // First-run welcome shows only while the account has never been onboarded
    // (server-persisted onboardedAt). Set once on signup, so a returning login
    // — even on a new browser — never re-fires it.
    const onboarding = !user.onboardedAt;
    if (onboarding) setShowOnboarding(true);
    // One-time "what's new" after a deploy: releases newer than the account's
    // server-persisted lastSeenRelease. Signup seeds the then-current id, so
    // this fires only for accounts that predate a deploy — onboarding (new
    // accounts) never stacks with it in practice; the guard is belt-and-braces.
    const releases = unseenReleases(user.lastSeenRelease);
    setWhatsNewReleases(releases);
    if (!onboarding && !showOnboardingRef.current && releases.length > 0) setShowWhatsNew(true);
  }
  const showOnboardingRef = useRef(showOnboarding);
  showOnboardingRef.current = showOnboarding;

  // Full post-login initialization: restore route, load the inbox (badges +
  // pending requests), start the knowledge/notification watcher, and show
  // first-run onboarding. Shared by boot and post-login.
  function enterApp(user: User): void {
    applyInitialRoute();
    if (!location.hash) syncHash(true);
    void loadInboxData();
    startKnowledgeWatch();
    if (readState().view === "share") {
      introDeferred.current = true;
      return;
    }
    showIntro(user);
  }

  function dismissOnboarding(): void {
    setShowOnboarding(false);
    // Persist server-side so it never re-appears; optimistically reflect it in
    // state. Fire-and-forget — a failed mark just means it may show once more.
    api<{ user: User }>("/api/me/onboarded", { method: "POST" })
      .then(({ user }) => replaceState({ user }))
      .catch(() => {});
  }

  function dismissWhatsNew(): void {
    setShowWhatsNew(false);
    // Persist server-side (the server stamps ITS current release id — no body);
    // optimistic, fire-and-forget — a failed mark just means it may show once
    // more. Mirrors dismissOnboarding.
    api<{ user: User }>("/api/me/release-seen", { method: "POST" })
      .then(({ user }) => replaceState({ user }))
      .catch(() => {});
  }

  function handleSessionExpired(): void {
    stopKnowledgeWatch();
    introDeferred.current = false;
    updateState((s) => {
      s.user = null;
      s.currentAvatar = null;
      s.chatPanes = [];
      s.activePaneId = null;
      s.conversations = [];
      s.notifications = [];
      s.knowledgeRequests = [];
      s.routineConversations = [];
      s.routineConversationId = "";
      s.routineMessages = [];
      s.promptQueue = [];
    });
    setShowOnboarding(false);
    setShowWhatsNew(false);
    notify("세션이 만료되었습니다. 다시 로그인해 주세요.", "warn");
    // Deep links are dropped so the next login starts clean — except a share
    // link: any signed-in user may open it, and keeping it lets the login
    // screen say why it appeared and the deck reopen right after.
    const keep = location.hash.startsWith("#/share/") ? location.hash : "";
    history.replaceState(null, "", `${location.pathname}${keep}`);
  }
  const sessionExpired = useRef(handleSessionExpired);
  sessionExpired.current = handleSessionExpired;

  // Guards that follow the state, re-checked after every render (each one is a
  // no-op unless its condition newly holds):
  useEffect(() => {
    const user = state.user;
    // When a user logs in from the auth screen (AuthView sets state.user), run
    // the post-login initialization once.
    if (state.booted && user && initializedFor.current !== user.id) {
      initializedFor.current = user.id;
      enterApp(user);
    }
    if (!user) {
      initializedFor.current = null;
      introDeferred.current = false;
    }
    if (introDeferred.current && user && readState().view !== "share") {
      introDeferred.current = false;
      showIntro(user);
    }
    // 설정 → 시작 안내 re-opens the welcome modal on demand. One-shot flag,
    // drained here the way SettingsAccessTab drains browserGuideRequested — but
    // with no view to navigate to, since the modal is a global overlay.
    // Deliberately independent of `onboardedAt`: an already-onboarded owner is
    // exactly who asks for this.
    if (readState().onboardingRequested) {
      updateState((s) => (s.onboardingRequested = false));
      setShowOnboarding(true);
    }
    const current = readState();
    if (current.user && activeViewName.current !== current.view) void loadView(current.view);
  });

  useEffect(() => {
    setSessionExpiredHandler(() => sessionExpired.current());
    const cleanup = installRouteListener((conversationId) => {
      const current = readState();
      const activeConversationId =
        current.chatPanes.find((pane) => pane.id === current.activePaneId)?.conversationId ??
        current.chatPanes[0]?.conversationId;
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
  }, []);

  const unreadCount =
    state.knowledgeRequests.filter((request) => request.status === "open").length +
    state.notifications.filter((notification) => !notification.readAt).length;
  const activeViewLabel = viewLabels[state.view];
  const ActiveView = activeView.component;
  const adminNotice = state.adminNotice;

  let screen;
  if (!state.booted) {
    screen = (
      <div className="app-status-screen" role="status" aria-live="polite" aria-label="앱을 불러오는 중">
        <div className="app-status-card">
          <img className="app-status-mark" src="/icon-192.png" alt="" aria-hidden="true" width="48" height="48" />
          <strong>Noah Almighty</strong>
          <span className="muted">작업 공간을 준비하는 중…</span>
        </div>
      </div>
    );
  } else if (state.bootError) {
    screen = (
      <div className="app-status-screen" role="alert">
        <div className="app-status-card warn-box">
          <strong>앱을 시작하지 못했습니다</strong>
          <span>{state.bootError}</span>
          <button className="primary" type="button" onClick={() => void boot()}>
            다시 시도
          </button>
        </div>
      </div>
    );
  } else if (!state.user) {
    screen = <AuthView bootstrap={state.bootstrap} />;
  } else {
    screen = (
      <section className={cx("workspace", railCollapsed && "rail-collapsed")}>
        <Shell
          user={state.user}
          view={state.view}
          streaming={state.streaming}
          unreadCount={unreadCount}
          themePref={state.themePref}
          railCollapsed={railCollapsed}
          onRailCollapsedChange={setRailCollapsed}
          onMobileRailOpenChange={setMobileRailOpen}
        />
        <main id="main" className="main" tabIndex={-1} inert={mobileRailOpen} aria-busy={!ActiveView}>
          {/* 관리자 공지: above whichever view is open, until this account closes it. */}
          {adminNotice ? (
            <NoticeBar key={adminNotice.id} notice={adminNotice} onDismiss={() => void dismissAdminNotice(adminNotice.id)} />
          ) : null}
          {ActiveView ? (
            <ViewBoundary resetKey={state.view}>
              <ActiveView />
            </ViewBoundary>
          ) : (
            <div className="view-fallback-pad muted" role="status">
              화면을 준비하는 중…
            </div>
          )}
        </main>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {activeViewLabel} 화면
        </div>
      </section>
    );
  }

  return (
    <>
      {screen}

      {/* The bubble at a new feature's own control (#feature-hints). Before the
          dialogs in DOM order: it is not a modal, and an open dialog makes it
          inert like the rest of the page. Keyed by the user so what one account
          dismissed in this session never carries over to the next login. */}
      {state.user ? <FeatureHintLayer key={state.user.id} user={state.user} blocked={showOnboarding || showWhatsNew} /> : null}

      <Presence>
        {showOnboarding && state.user ? (
          <OnboardingModal
            key="onboarding"
            user={state.user}
            confluenceConfigured={state.bootstrap?.confluenceConfigured ?? false}
            githubHost={state.bootstrap?.githubHost ?? "github.com"}
            onClose={dismissOnboarding}
          />
        ) : null}
      </Presence>

      <Presence>
        {showWhatsNew && state.user ? (
          <WhatsNewModal key="whats-new" releases={whatsNewReleases} onClose={dismissWhatsNew} />
        ) : null}
      </Presence>

      {/* Mounted at the app root (not inside ChatView) so input-needed prompts
          surface on ANY view — otherwise a question raised while the owner is on
          explore/inbox/settings would queue invisibly. */}
      {state.user ? <PromptModal /> : null}

      <Toasts />
      <ConfirmationDialog />
    </>
  );
}
