import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";
import AvatarImage from "./AvatarImage";
import Icon from "./Icon";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { addConversationToSplit, clearChatHistory, forgetConversationWidgets, newChat, selectConversation, startNewChat } from "../lib/chat";
import { groupConversationsByDate, localDayStart, msUntilNextLocalDay } from "../lib/conversationGroups";
import type { ConversationGroup } from "../lib/conversationGroups";
import { createIntentDwell, prefetchConversation, PREFETCH_DWELL_MS } from "../lib/conversationPrefetch";
import { featureHintAnchor } from "../lib/featureHints";
import type { IntentDwell } from "../lib/conversationPrefetch";
import { timeLabel } from "../lib/format";
import { cx, useAppState, useLatest, useWindowEvent } from "../lib/hooks";
import { loadConversations, stopKnowledgeWatch } from "../lib/loaders";
import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";
import { goView } from "../lib/nav";
import { Presence, useTransition } from "../lib/presence";
import { teamBrainBadgeCount, teamBrainBadgeTitle } from "../lib/teamBrain";
import { trapTab } from "../lib/modalBehavior";
import { notify, readState, replaceState, updateState } from "../lib/state";
import { setThemePref } from "../lib/theme";
import type { ThemePref } from "../lib/theme";
import { quartOut, slide } from "../lib/transition";
import type { TransitionConfig } from "../lib/transition";
import type { ConversationSummary, User, ViewName } from "../lib/types";
import type { FeatureHintAnchor } from "../../../server/releaseNotes";

export interface ShellProps {
  user: User;
  view: ViewName;
  streaming?: boolean;
  unreadCount?: number;
  themePref?: ThemePref;
  railCollapsed?: boolean;
  onRailCollapsedChange?: (collapsed: boolean) => void;
  onMobileRailOpenChange?: (open: boolean) => void;
}

type RailGroup = ConversationGroup<ConversationSummary>;

// `hint`: this entry is the on-screen home of a feature hint (#feature-hints).
const nav: ReadonlyArray<{ view: ViewName; label: string; icon: string; hint?: FeatureHintAnchor }> = [
  { view: "explore", label: "탐색", icon: "compass" },
  { view: "chat", label: "대화", icon: "chat" },
  { view: "todos", label: "할 일", icon: "check-square" },
  { view: "brain", label: "내 브레인", icon: "network", hint: "nav-brain" },
  { view: "teamBrain", label: "팀 브레인", icon: "users", hint: "nav-teamBrain" },
  { view: "inbox", label: "알림", icon: "bell" },
  { view: "routines", label: "예약 작업", icon: "clock" },
  { view: "skills", label: "스킬 배우기", icon: "sparkles" },
  { view: "settings", label: "내 아바타", icon: "user" },
];

const themeLabels: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };
const themeIcons: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };
const themeOrder: ThemePref[] = ["system", "light", "dark"];

// Live-run badge text from the last conversation-list load ("" = idle).
function activeRunLabel(conversation: ConversationSummary): string {
  return conversation.activeRun ? "응답 생성 중" : "";
}

function conversationDomId(id: string, suffix: string): string {
  return `conversation-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${suffix}`;
}

function conversationTitle(conversation: ConversationSummary): string {
  return conversation.title || conversation.avatarDisplayName || "제목 없는 대화";
}

const NO_EXIT: TransitionConfig = { duration: 0 };

const px = (value: string): number => Number.parseFloat(value) || 0;
const rowGapOf = (element: Element | null): number => (element ? px(getComputedStyle(element).rowGap) : 0);

// Fades while the height closes, so what is below rises with it instead of
// jumping; `trailing` is the space after the node that goes away with it (the
// list's gap). A FLIP of the siblings is deliberately not used here — the list
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

// Drag a conversation onto the chat workbench to add it as a split pane. The
// chat-id MIME lets the drop zone (ChatView) accept only our payload.
const CONV_DND_MIME = "application/x-noah-conversation";

// Minute-granularity only — the window is a few minutes wide, so anything
// finer would just flicker.
function presenceAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 1 ? "방금" : `${minutes}분 전`;
}

/**
 * A value that is both RENDERED and read LATER (after an await, in a timer, in
 * a listener registered once): state for the render, plus a ref the setter
 * writes first, so code that runs later — or later in the same tick — reads
 * what was last assigned, not what the render that created it saw.
 */
function useLiveState<T>(initial: T | (() => T)): [T, { readonly current: T }, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const [set] = useState(() => (next: T): void => {
    ref.current = next;
    setValue(() => next);
  });
  return [value, ref, set];
}

/** What a conversation row needs from the rail besides its own row state. */
interface RailRowActions {
  renameInput: RefObject<HTMLInputElement | null>;
  hoverIntent: IntentDwell;
  focusIntent: IntentDwell;
  conversationOut(node: Element, id: string): () => TransitionConfig;
  onConvDragStart(event: ReactDragEvent<HTMLElement>, conversation: ConversationSummary): void;
  onRowPointerEnter(event: ReactPointerEvent<HTMLElement>, id: string): void;
  onRowPress(event: ReactPointerEvent<HTMLElement>, id: string): void;
  openConversation(conversation: ConversationSummary): Promise<void>;
  addToSplit(conversation: ConversationSummary, event: SyntheticEvent): Promise<void>;
  startRename(conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>): void;
  deleteConversation(conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>): Promise<void>;
  commitRename(conversation: ConversationSummary): Promise<void>;
  cancelRename(): void;
  setRenameValue(value: string): void;
  clearRenameError(): void;
}

interface ConversationRowProps {
  conversation: ConversationSummary;
  active: boolean;
  renaming: boolean;
  renameValue: string;
  renameError: string;
  /** This row's rename is being saved. */
  renameBusy: boolean;
  rowBusy: boolean;
  rowStreaming: boolean;
  paneCount: number;
  rail: RailRowActions;
}

function ConversationRow({
  conversation,
  active,
  renaming,
  renameValue,
  renameError,
  renameBusy,
  rowBusy,
  rowStreaming,
  paneCount,
  rail,
}: ConversationRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useTransition(rowRef, { out: (node) => rail.conversationOut(node, conversation.id) });

  // The rename input's `autofocus`, as the app has always had it: marked on the
  // element, and focused one microtask after it appears — only when nothing
  // else holds the focus (the button that opened it is gone by then).
  const renameInput = rail.renameInput;
  useLayoutEffect(() => {
    if (!renaming) return;
    const input = renameInput.current;
    if (!input) return;
    input.autofocus = true;
    queueMicrotask(() => {
      if (document.activeElement === document.body) input.focus();
    });
  }, [renaming, renameInput]);

  const liveLabel = activeRunLabel(conversation);
  const openLabel = liveLabel
    ? `대화 열기: ${conversationTitle(conversation)} · ${liveLabel}`
    : `대화 열기: ${conversationTitle(conversation)}`;

  return (
    <div
      ref={rowRef}
      className={cx("conv-item", active && "active", renaming && "editing", rowBusy && "busy")}
      aria-busy={rowBusy ? "true" : "false"}
      role="listitem"
      draggable={!renaming && !rowBusy}
      onDragStart={(event) => rail.onConvDragStart(event, conversation)}
      onPointerEnter={(event) => rail.onRowPointerEnter(event, conversation.id)}
      onPointerLeave={() => rail.hoverIntent.cancel(conversation.id)}
      onFocus={() => rail.focusIntent.arm(conversation.id)}
      onBlur={() => rail.focusIntent.cancel(conversation.id)}
    >
      {renaming ? (
        <div className="conv-edit-wrap">
          <input
            className="conv-rename"
            ref={renameInput}
            value={renameValue}
            placeholder="대화 이름"
            aria-label="대화 이름"
            aria-describedby={conversationDomId(conversation.id, "rename-status")}
            aria-invalid={renameError ? "true" : undefined}
            title="Enter 저장 · Esc 취소"
            disabled={renameBusy}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              rail.setRenameValue(event.currentTarget.value);
              rail.clearRenameError();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void rail.commitRename(conversation);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                rail.cancelRename();
              }
            }}
            onBlur={() => void rail.commitRename(conversation)}
          />
          <span
            id={conversationDomId(conversation.id, "rename-status")}
            className={cx("conv-edit-status", Boolean(renameError) && "invalid")}
            role="status"
            aria-live="polite"
          >
            {renameBusy ? "저장 중…" : renameError ? `이름 변경 실패: ${renameError}` : "Enter 저장 · Esc 취소"}
          </span>
        </div>
      ) : (
        <>
          <button
            className="conv-open"
            type="button"
            title={openLabel}
            aria-label={openLabel}
            aria-current={active ? "true" : undefined}
            disabled={rowBusy}
            onPointerDown={(event) => rail.onRowPress(event, conversation.id)}
            onClick={() => void rail.openConversation(conversation)}
          >
            <span className="conv-name">{conversationTitle(conversation)}</span>
            <span className="conv-time">
              {conversation.avatarDisplayName} · {timeLabel(conversation.updatedAt)}
            </span>
            {liveLabel ? (
              // The run is still going with this conversation closed; the
              // button's aria-label carries the same words (its label
              // overrides this content for screen readers).
              <span className="conv-live" title={liveLabel}>
                <span className="conv-live-dot" aria-hidden="true"></span>
                <span className="conv-live-text">{liveLabel}</span>
              </span>
            ) : null}
          </button>
          <div className="conv-acts">
            <button
              className="conv-act"
              type="button"
              aria-label={`분할 대화에 추가: ${conversationTitle(conversation)}`}
              title={paneCount >= 4 ? "분할 대화는 최대 4개" : "분할 대화에 추가"}
              disabled={paneCount >= 4 || rowBusy}
              onPointerDown={(event) => rail.onRowPress(event, conversation.id)}
              onClick={(event) => void rail.addToSplit(conversation, event)}
            >
              <Icon name="columns" size={15} />
            </button>
            <button
              className="conv-act"
              type="button"
              aria-label={`대화 이름 바꾸기: ${conversationTitle(conversation)}`}
              title="이름 바꾸기"
              disabled={rowBusy}
              onClick={(event) => rail.startRename(conversation, event)}
            >
              <Icon name="edit" size={15} />
            </button>
            <button
              className="conv-act danger"
              type="button"
              aria-label={`대화 삭제: ${conversationTitle(conversation)}`}
              title={rowStreaming ? "응답 중인 대화는 삭제할 수 없습니다" : "삭제"}
              disabled={rowBusy || rowStreaming}
              onClick={(event) => void rail.deleteConversation(conversation, event)}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ConversationGroupSectionProps {
  id: RailGroup["id"];
  label: string;
  groupOut(node: Element, id: RailGroup["id"]): () => TransitionConfig;
  /** The group's rows, keyed by conversation id. */
  children: ReactNode;
}

function ConversationGroupSection({ id, label, groupOut, children }: ConversationGroupSectionProps) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  useTransition(groupRef, { out: (node) => groupOut(node, id) });
  return (
    <div className="conv-group" ref={groupRef}>
      {/* A real heading, not a control: never focusable or clickable. */}
      <h3 className="conv-group-label" id={`rail-conversation-group-${id}`}>
        {label}
      </h3>
      <div className="conv-group-list" role="list" aria-labelledby={`rail-conversation-group-${id}`}>
        {/* A row's exit is local to THIS list: it plays when the row leaves a
            group that stays, not when the whole group goes. */}
        <Presence>{children}</Presence>
      </div>
    </div>
  );
}

export default function Shell({
  user,
  view,
  streaming = false,
  unreadCount = 0,
  themePref = "system",
  railCollapsed = false,
  onRailCollapsedChange = () => {},
  onMobileRailOpenChange = () => {},
}: ShellProps) {
  const state = useAppState();
  const onRailCollapsedChangeRef = useLatest(onRailCollapsedChange);
  const onMobileRailOpenChangeRef = useLatest(onMobileRailOpenChange);

  const [railOpen, railOpenRef, setRailOpenValue] = useLiveState(false);
  const railElement = useRef<HTMLElement | null>(null);
  const railToggle = useRef<HTMLButtonElement | null>(null);
  const railDismiss = useRef<HTMLButtonElement | null>(null);
  const railBackdrop = useRef<HTMLButtonElement | null>(null);
  const [railSpringing, setRailSpringing] = useState(false);
  const cancelRailSpring = useRef<() => void>(() => {});
  const [desktopRailMedia] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 861px)") : null,
  );
  const [desktopRail, desktopRailRef, setDesktopRail] = useLiveState(desktopRailMedia?.matches ?? true);
  const [conversationQuery, setConversationQuery] = useState("");
  const conversationSearchInput = useRef<HTMLInputElement | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState("");
  const [renamingId, renamingIdRef, setRenamingId] = useLiveState("");
  const [renameValue, renameValueRef, setRenameValue] = useLiveState("");
  const [renameError, setRenameError] = useState("");
  const renameInput = useRef<HTMLInputElement | null>(null);
  const [renamingBusyId, renamingBusyIdRef, setRenamingBusyId] = useLiveState("");
  const [busyConversationIds, busyConversationIdsRef, setBusyConversationIds] = useLiveState(() => new Set<string>());
  const [clearingConversations, clearingConversationsRef, setClearingConversations] = useLiveState(false);
  const [logoutBusy, logoutBusyRef, setLogoutBusy] = useLiveState(false);

  // The 할 일 badge counts what needs attention now — overdue + due today — not
  // every open item; the tooltip spells the split out.
  const todoCounts = state.todos.counts;
  const todoBadgeCount = todoCounts.overdue + todoCounts.dueToday;
  // 팀 브레인 badge: my decided-but-unseen team-brain proposals + (admins) pending reviews.
  const teamBrainBadge = teamBrainBadgeCount(state.teamBrainStatus);
  const todoBadgeTitle = [
    todoCounts.overdue ? `마감 지남 ${todoCounts.overdue}개` : "",
    todoCounts.dueToday ? `오늘 마감 ${todoCounts.dueToday}개` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const themeLabel = `테마: ${themeLabels[themePref]}`;
  const themeIcon = themeIcons[themePref];
  const activeConversationId = state.chatPanes.find((pane) => pane.id === state.activePaneId)?.conversationId ?? null;
  // The same array for as long as the query is the same (the memo below keys on it).
  const conversationTokens = useMemo(
    () => conversationQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [conversationQuery],
  );
  // Both steps hand back the SAME array while their inputs are the ones it was
  // built from: the app state re-emits on every store write (token-rate while a
  // run streams), and the list only changes when the conversations array is
  // replaced or the query is. Every writer replaces the array — never edit a row
  // in place.
  const railFilterMemo = useRef<{ source: ConversationSummary[]; tokens: string[]; list: ConversationSummary[] } | null>(null);
  function filterRailConversations(source: ConversationSummary[], tokens: string[]): ConversationSummary[] {
    const memo = railFilterMemo.current;
    if (memo && memo.source === source && memo.tokens === tokens) return memo.list;
    const list = source
      .filter((conversation) => !conversation.isRoutine)
      .filter((conversation) => {
        if (!tokens.length) return true;
        const hay = [conversation.title, conversation.avatarDisplayName].filter(Boolean).join(" ").toLowerCase();
        return tokens.every((token) => hay.includes(token));
      });
    railFilterMemo.current = { source, tokens, list };
    return list;
  }
  const railConversations = filterRailConversations(state.conversations, conversationTokens);

  // Date groups (오늘 / 어제 / 지난 7일 / 지난 30일 / 그 이전). `groupNow` moves only
  // when the LOCAL DATE does (the midnight timer below, or the tab coming back),
  // so an app left open overnight regroups without a reload.
  const [groupNow, groupNowRef, setGroupNow] = useLiveState(() => Date.now());
  const groupMemo = useRef<{ list: ConversationSummary[]; now: number; groups: RailGroup[] } | null>(null);
  function groupRailConversations(list: ConversationSummary[], now: number): RailGroup[] {
    const memo = groupMemo.current;
    if (memo && memo.list === list && memo.now === now) return memo.groups;
    const groups = groupConversationsByDate(list, now);
    groupMemo.current = { list, now, groups };
    return groups;
  }
  const conversationGroups = groupRailConversations(railConversations, groupNow);
  const conversationGroupsRef = useLatest(conversationGroups);
  const chatConversationCount = state.conversations.filter((conversation) => !conversation.isRoutine).length;
  const chatConversationCountRef = useLatest(chatConversationCount);
  const conversationResultStatus = conversationsLoading
    ? "대화 목록을 불러오는 중입니다."
    : conversationsError
      ? "대화 목록을 불러오지 못했습니다."
      : conversationQuery.trim()
        ? `검색 결과 ${railConversations.length}개, 전체 대화 ${chatConversationCount}개입니다.`
        : `저장된 대화 ${chatConversationCount}개입니다.`;

  // Everything below that runs LATER than the render that created it (after an
  // await, from a timer, a spring, or a listener registered once) reads the
  // rail's state through the refs above, never through the render's own values.

  // A layout effect, not a passive one: the first paint already shows the list
  // as loading, as it always has.
  useLayoutEffect(() => {
    void refreshConversations();
    const syncRailLayout = (event: MediaQueryListEvent) => {
      setDesktopRail(event.matches);
      if (desktopRailRef.current && railOpenRef.current) {
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
      if (localDayStart(now) !== localDayStart(groupNowRef.current)) setGroupNow(now);
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
      if (railOpenRef.current) onMobileRailOpenChangeRef.current(false);
    };
    // Mount/unmount only: everything read in here is a ref or a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshConversations() {
    setConversationsLoading(true);
    setConversationsError("");
    try {
      await loadConversations();
    } catch (err) {
      setConversationsError((err as Error).message);
    } finally {
      setConversationsLoading(false);
    }
  }

  async function logout() {
    if (logoutBusyRef.current) return;
    setLogoutBusy(true);
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
    const next = new Set(busyConversationIdsRef.current);
    if (on) next.add(id);
    else next.delete(id);
    setBusyConversationIds(next);
  }

  function isConversationBusy(id: string): boolean {
    return busyConversationIdsRef.current.has(id) || renamingBusyIdRef.current === id;
  }

  function startRename(conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
    if (isConversationBusy(conversation.id)) return;
    setRenamingId(conversation.id);
    setRenameValue(conversation.title || "");
    setRenameError("");
  }

  function cancelRename() {
    if (renamingBusyIdRef.current) return;
    setRenamingId("");
    setRenameValue("");
    setRenameError("");
  }

  // A failed rename hands the focus back to its input — once the input is
  // enabled again, which is one commit after the failure is recorded.
  const refocusRename = useRef(false);
  useLayoutEffect(() => {
    if (!refocusRename.current || renamingBusyId) return;
    refocusRename.current = false;
    renameInput.current?.focus();
  });

  async function commitRename(conversation: ConversationSummary) {
    if (renamingBusyIdRef.current === conversation.id) return;
    const title = renameValueRef.current.trim();
    if (!title || title === conversation.title) {
      cancelRename();
      return;
    }
    setRenamingBusyId(conversation.id);
    setRenameError("");
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
      setRenamingId("");
      setRenameValue("");
    } catch (err) {
      const message = (err as Error).message;
      setRenameError(message);
      notify(`이름 변경 실패: ${message}`, "warn");
      refocusRename.current = true;
    } finally {
      setRenamingBusyId("");
    }
  }

  // Rows the viewer just deleted ONE AT A TIME — the only rows that leave with
  // motion. A reorder, a move between date groups, a search filter and 전체 삭제
  // all stay instant: this list is core navigation. Plain Sets on purpose — the
  // gate is read when the exit STARTS, never by the markup
  // (docs/architecture/client.md, conditional motion on a keyed list).
  const [deletedConversationIds] = useState(() => new Set<string>());
  // A deletion that empties its date group removes the whole group (heading
  // included). The row's own exit is local to the group's list and does not run
  // then, so the GROUP leaves the same way instead.
  const [emptiedGroupIds] = useState(() => new Set<RailGroup["id"]>());

  // Both exits are DEFERRED (return a function) so the gate is asked when the
  // node actually leaves.
  function conversationOut(node: Element, id: string) {
    return (): TransitionConfig => {
      if (!deletedConversationIds.delete(id) || prefersReducedMotion()) return NO_EXIT;
      return collapseOut(node, rowGapOf(node.parentElement));
    };
  }

  function groupOut(node: Element, id: RailGroup["id"]) {
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

  async function deleteConversation(conversation: ConversationSummary, event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
    if (isConversationBusy(conversation.id)) return;
    if (readState().chatPanes.some((pane) => pane.conversationId === conversation.id && pane.streaming)) {
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
    const openPane = readState().chatPanes.find((pane) => pane.conversationId === conversation.id);
    // Marked before the row is removed; forgotten shortly after in case the row
    // was not on screen (filtered out by a search) and never asked.
    deletedConversationIds.add(conversation.id);
    const group = conversationGroupsRef.current.find((candidate) => candidate.items.some((item) => item.id === conversation.id));
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
    if (clearingConversationsRef.current || !chatConversationCountRef.current) return;
    if (readState().chatPanes.some((pane) => pane.streaming)) {
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
    setClearingConversations(true);
    try {
      const deleted = await clearChatHistory();
      notify(deleted ? `${deleted}개의 대화를 비웠습니다.` : "비울 대화가 없습니다.", "ok");
    } catch (err) {
      notify(`전체 비우기 실패: ${(err as Error).message}`, "warn");
    } finally {
      setClearingConversations(false);
    }
  }

  function setRailOpen(open: boolean) {
    if (railOpenRef.current === open) return;
    setRailOpenValue(open);
    onMobileRailOpenChangeRef.current(open);
  }

  function cancelRailAnimation(): void {
    cancelRailSpring.current();
    cancelRailSpring.current = () => {};
    setRailSpringing(false);
  }

  function railWidth(): number {
    return Math.max(1, railElement.current?.getBoundingClientRect().width ?? 320);
  }

  function canAnimateRail(): boolean {
    return !prefersReducedMotion() && (railElement.current?.getBoundingClientRect().width ?? 0) > 0;
  }

  function currentRailX(): number {
    const rail = railElement.current;
    if (!rail) return 0;
    const transform = getComputedStyle(rail).transform;
    if (!transform || transform === "none") return 0;
    try {
      return new DOMMatrixReadOnly(transform).m41;
    } catch {
      return 0;
    }
  }

  function setRailVisual(x: number): void {
    const rail = railElement.current;
    if (!rail) return;
    const width = railWidth();
    const progress = Math.max(0, Math.min(1, 1 + x / width));
    rail.style.transform = `translate3d(${x}px, 0, 0)`;
    rail.style.visibility = "visible";
    const backdrop = railBackdrop.current;
    if (backdrop) {
      backdrop.style.opacity = String(progress);
      backdrop.style.pointerEvents = progress > 0.02 ? "auto" : "none";
    }
  }

  function clearRailVisual(): void {
    railElement.current?.style.removeProperty("transform");
    railElement.current?.style.removeProperty("visibility");
    railBackdrop.current?.style.removeProperty("opacity");
    railBackdrop.current?.style.removeProperty("pointer-events");
    setRailSpringing(false);
  }

  function springRail(from: number, target: number, initialVelocity: number, complete: () => void): void {
    cancelRailAnimation();
    setRailSpringing(true);
    cancelRailSpring.current = springValue({
      from,
      to: target,
      velocity: initialVelocity,
      response: 0.3,
      dampingRatio: Math.abs(initialVelocity) > 120 ? 0.86 : 1,
      onUpdate: setRailVisual,
      onComplete: () => {
        cancelRailSpring.current = () => {};
        complete();
      },
    });
  }

  function finishRailClose(restoreFocus: boolean): void {
    // The rail must have LOST its `open` class before the spring's inline
    // styles are dropped (one microtask later), or it would be painted fully
    // open for a frame. This runs from a spring/pointer callback, where React
    // would otherwise render in a later task — so the close is flushed here.
    flushSync(() => setRailOpen(false));
    queueMicrotask(clearRailVisual);
    if (restoreFocus) requestAnimationFrame(() => railToggle.current?.focus());
  }

  function closeRail(restoreFocus = false) {
    if (desktopRailRef.current || !railOpenRef.current || !canAnimateRail()) {
      cancelRailAnimation();
      setRailOpen(false);
      clearRailVisual();
      if (restoreFocus) requestAnimationFrame(() => railToggle.current?.focus());
      return;
    }
    const from = currentRailX();
    springRail(from, -railWidth(), 0, () => finishRailClose(restoreFocus));
  }

  function openRail() {
    if (desktopRailRef.current) {
      onRailCollapsedChangeRef.current(false);
      requestAnimationFrame(() => railDismiss.current?.focus());
      return;
    }
    if (railOpenRef.current) return;
    setRailSpringing(true);
    setRailOpen(true);
    requestAnimationFrame(() => {
      if (!canAnimateRail()) {
        clearRailVisual();
        railDismiss.current?.focus();
        return;
      }
      const from = -railWidth();
      setRailVisual(from);
      springRail(from, 0, 0, () => {
        clearRailVisual();
        railDismiss.current?.focus();
      });
    });
  }

  function startRailDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (desktopRailRef.current || !railOpenRef.current || !railElement.current) return;
    event.preventDefault();
    event.stopPropagation();
    cancelRailAnimation();
    setRailSpringing(true);
    const handle = event.currentTarget;
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

  function startRailEdgeDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (desktopRailRef.current || railOpenRef.current || !railElement.current) return;
    event.preventDefault();
    cancelRailAnimation();
    setRailOpen(true);
    setRailSpringing(true);
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
          railDismiss.current?.focus();
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
    if (desktopRailRef.current) onRailCollapsedChangeRef.current(true);
    else closeRail(true);
    if (desktopRailRef.current) requestAnimationFrame(() => railToggle.current?.focus());
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
    if (renamingIdRef.current === id || isConversationBusy(id)) return;
    // Looked up when the dwell ENDS, so the run state is the list's current one.
    const conversation = readState().conversations.find((item) => item.id === id);
    if (conversation) prefetchConversation(conversation);
  }
  // One pair per rail, made on the first render: `prefetchRow` reads refs only,
  // so that render's copy stays right.
  const [hoverIntent] = useState(() => createIntentDwell(prefetchRow, PREFETCH_DWELL_MS));
  const [focusIntent] = useState(() => createIntentDwell(prefetchRow, PREFETCH_DWELL_MS));

  function onRowPointerEnter(event: ReactPointerEvent<HTMLElement>, id: string): void {
    // Touch has no hover — its pointerenter is the start of a tap or a scroll.
    if (event.pointerType === "touch") return;
    hoverIntent.arm(id);
  }

  // A press on the open / split button needs no dwell. Not for touch: there a
  // press is as often the start of a list scroll, and tap → click leaves no gap
  // to win.
  function onRowPress(event: ReactPointerEvent<HTMLElement>, id: string): void {
    if (event.pointerType === "touch" || event.button) return;
    hoverIntent.cancel(id);
    prefetchRow(id);
  }

  function clearConversationSearch(): void {
    setConversationQuery("");
    conversationSearchInput.current?.focus();
  }

  function onConvDragStart(event: ReactDragEvent<HTMLElement>, conversation: ConversationSummary) {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(CONV_DND_MIME, conversation.id);
    event.dataTransfer.setData("text/plain", conversationTitle(conversation));
    event.dataTransfer.effectAllowed = "copy";
  }

  // Touch/keyboard-friendly alternative to dragging: add directly to the split.
  async function addToSplit(conversation: ConversationSummary, event: SyntheticEvent) {
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

  const paneCount = state.chatPanes.length;

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
    if (!desktopRailRef.current && railOpenRef.current && event.key === "Escape") {
      event.preventDefault();
      dismissRail();
      return;
    }
    if (!desktopRailRef.current && railOpenRef.current && event.key === "Tab") {
      // Shared trap (also applies the aria-hidden/display/visibility + tabindex=-1
      // filtering the hand-rolled copy lacked).
      trapTab(event, railElement.current);
    }
  }
  useWindowEvent("keydown", handleKeydown);

  const railExpanded = desktopRail ? !railCollapsed : railOpen;

  // ---- Admin presence badge (rail footer) ----------------------------------
  // Deliberately the smallest possible surface: one line that expands in place.
  // The count excludes the viewer, so "접속 2" means two OTHER people are here.
  const [presenceOpen, setPresenceOpen] = useState(false);
  const isAdmin = Boolean(user.roles?.includes("admin"));
  const presentOthers = (state.adminPresence?.users ?? []).filter((u) => u.id !== user.id);
  // Server-owned window, rendered in whole hours once it reaches one — "최근 60분"
  // is not how anyone says it.
  const presenceWindow = (() => {
    const minutes = state.adminPresence?.windowMinutes ?? 60;
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
  })();

  const rowActions: RailRowActions = {
    renameInput,
    hoverIntent,
    focusIntent,
    conversationOut,
    onConvDragStart,
    onRowPointerEnter,
    onRowPress,
    openConversation,
    addToSplit,
    startRename,
    deleteConversation,
    commitRename,
    cancelRename,
    setRenameValue,
    clearRenameError: () => setRenameError(""),
  };

  return (
    <>
      {!desktopRail && !railOpen ? (
        <div className="rail-edge-swipe" aria-hidden="true" onPointerDown={startRailEdgeDrag}></div>
      ) : null}

      <button
        ref={railToggle}
        className="icon-button rail-toggle rail-open-toggle"
        type="button"
        aria-label="메뉴 열기"
        aria-controls="rail"
        aria-expanded={railExpanded ? "true" : "false"}
        inert={railOpen && !desktopRail}
        title="메뉴"
        onClick={openRail}
      >
        <Icon name="menu" />
      </button>

      <aside
        ref={railElement}
        className={cx("rail", railOpen && "open", railSpringing && "rail-springing")}
        id="rail"
        aria-label="대화 목록"
        aria-hidden={railExpanded ? undefined : "true"}
        inert={!railExpanded}
      >
        <button className="rail-grabber" type="button" aria-label="메뉴를 왼쪽으로 끌어 닫기" onPointerDown={startRailDrag}>
          <span aria-hidden="true"></span>
        </button>
        <div className="rail-head">
          <div className="rail-brand-row">
            <button className="rail-brand" type="button" title="홈으로 이동" onClick={() => navigate("explore")}>
              <img className="mark" src="/icon-192.png" alt="" aria-hidden="true" width="34" height="34" />
              <span>
                <span className="name">Noah Almighty</span>
              </span>
            </button>
            <button
              ref={railDismiss}
              className="icon-button rail-dismiss"
              type="button"
              aria-label={desktopRail ? "왼쪽 메뉴 접기" : "메뉴 닫기"}
              aria-controls="rail"
              title={desktopRail ? "왼쪽 메뉴 접기" : "메뉴 닫기"}
              onClick={dismissRail}
            >
              <Icon name={desktopRail ? "panel-left-close" : "close"} size={18} />
            </button>
          </div>

          <nav className="rail-nav" aria-label="주 메뉴">
            {nav.map((item, index) => (
              <button
                key={index}
                ref={item.hint ? featureHintAnchor(item.hint) : undefined}
                className={cx("nav-item", view === item.view && "active")}
                type="button"
                aria-current={view === item.view ? "page" : undefined}
                onClick={() => navigate(item.view)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.view === "inbox" && unreadCount > 0 ? <span className="nav-badge">{unreadCount}</span> : null}
                {item.view === "todos" && todoBadgeCount > 0 ? (
                  <span className="nav-badge" title={todoBadgeTitle}>
                    {todoBadgeCount}
                  </span>
                ) : null}
                {item.view === "teamBrain" && teamBrainBadge > 0 ? (
                  <span className="nav-badge" title={teamBrainBadgeTitle(state.teamBrainStatus)}>
                    {teamBrainBadge}
                  </span>
                ) : null}
              </button>
            ))}

            {isAdmin ? (
              <button
                className={cx("nav-item", view === "admin" && "active")}
                type="button"
                aria-current={view === "admin" ? "page" : undefined}
                onClick={() => navigate("admin")}
              >
                <Icon name="shield" />
                <span>관리자</span>
              </button>
            ) : null}
          </nav>

          <button
            className="new-chat"
            type="button"
            title="현재 아바타와 새 대화를 시작합니다 (대화가 없으면 내 아바타)"
            onClick={() => {
              void startNewChat();
              closeRail();
            }}
          >
            <Icon name="plus" />
            <span>새 대화</span>
          </button>
        </div>

        <div className="rail-history">
          <div className="rail-section-row">
            <div className="rail-section-label">
              내 대화 <span className="rail-section-count">{chatConversationCount}</span>
            </div>
            <button
              className="rail-clear-history"
              type="button"
              aria-label="모든 일반 대화 비우기"
              title="모든 일반 대화 비우기"
              disabled={conversationsLoading || clearingConversations || chatConversationCount === 0}
              onClick={() => void clearConversations()}
            >
              <Icon name="trash" size={13} />
              <span>{clearingConversations ? "비우는 중…" : "비우기"}</span>
            </button>
          </div>
          <div className="conv-list-wrap">
            <div className="conv-search-wrap">
              <input
                ref={conversationSearchInput}
                className="conv-search"
                type="search"
                placeholder={conversationsLoading ? "대화 불러오는 중" : "대화 검색"}
                aria-label="대화 검색"
                aria-controls="rail-conversation-list"
                aria-describedby="rail-conversation-status"
                disabled={conversationsLoading}
                value={conversationQuery}
                onChange={(event) => setConversationQuery(event.currentTarget.value)}
              />
              {conversationQuery ? (
                <button
                  className="conv-search-clear"
                  type="button"
                  aria-label="대화 검색어 지우기"
                  title="검색어 지우기"
                  onClick={clearConversationSearch}
                >
                  <Icon name="close" size={14} />
                </button>
              ) : null}
            </div>
            <div id="rail-conversation-status" className="sr-only" role="status" aria-live="polite">
              {conversationResultStatus}
            </div>
            {/* No list role here: each date group below is its own list, labelled by
                its heading. */}
            <div id="rail-conversation-list" className="conv-list scroll-thin">
              {conversationsLoading ? (
                <div className="conv-empty" role="status">
                  불러오는 중…
                </div>
              ) : conversationsError ? (
                <div className="conv-empty" role="alert">
                  대화를 불러오지 못했습니다.{" "}
                  <button
                    className="linkish small rail-retry"
                    type="button"
                    disabled={conversationsLoading}
                    onClick={() => void refreshConversations()}
                  >
                    다시 시도
                  </button>
                </div>
              ) : !railConversations.length ? (
                <div className="conv-empty">{conversationQuery ? "검색 결과가 없습니다." : "아직 저장된 대화가 없습니다."}</div>
              ) : (
                // A group's exit is local to this list too: leaving this branch
                // (the empty state, a reload) takes everything away at once.
                <Presence>
                  {conversationGroups.map((group) => (
                    <ConversationGroupSection key={group.id} id={group.id} label={group.label} groupOut={groupOut}>
                      {group.items.map((conversation) => {
                        const renaming = renamingId === conversation.id;
                        return (
                          <ConversationRow
                            key={conversation.id}
                            conversation={conversation}
                            active={conversation.id === activeConversationId}
                            renaming={renaming}
                            renameValue={renameValue}
                            renameError={renameError}
                            renameBusy={renamingBusyId === conversation.id}
                            rowBusy={busyConversationIds.has(conversation.id) || renamingBusyId === conversation.id}
                            rowStreaming={state.chatPanes.some((pane) => pane.conversationId === conversation.id && pane.streaming)}
                            paneCount={paneCount}
                            rail={rowActions}
                          />
                        );
                      })}
                    </ConversationGroupSection>
                  ))}
                </Presence>
              )}
            </div>
          </div>
        </div>

        <div className="rail-footer">
          {streaming ? (
            <div className="rail-streaming-note">
              <span className="spinner"></span>
              <span>응답 중</span>
            </div>
          ) : null}
          {isAdmin && state.adminPresence ? (
            <div className="rail-presence">
              <button
                className="rail-presence-toggle"
                type="button"
                aria-expanded={presenceOpen}
                aria-controls="rail-presence-list"
                title={`최근 ${presenceWindow} 안에 활동한 다른 사용자 ${presentOthers.length}명 (관리자만 보입니다)`}
                onClick={() => setPresenceOpen((open) => !open)}
              >
                <span className={cx("rail-presence-dot", presentOthers.length === 0 && "alone")} aria-hidden="true"></span>
                <span>접속 {presentOthers.length}</span>
                <Icon name={presenceOpen ? "chevron-down" : "chevron-right"} size={13} />
              </button>
              {presenceOpen ? (
                <div id="rail-presence-list" className="rail-presence-list scroll-thin">
                  {!presentOthers.length ? (
                    <div className="rail-presence-empty">최근 {presenceWindow} 동안 나 혼자 있었습니다.</div>
                  ) : (
                    presentOthers.map((person) => (
                      <div className="rail-presence-item" key={person.id}>
                        <AvatarImage user={person} size={20} />
                        <span className="rail-presence-name">{person.displayName || person.username}</span>
                        <span className="rail-presence-age">{presenceAge(person.lastSeenAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="rail-user-row">
            <button className="rail-me" type="button" title="내 아바타 설정" onClick={() => navigate("settings")}>
              <AvatarImage user={user} size={34} />
              <span className="meta">
                <b>{user.alias || user.displayName}</b> <span>@{user.username}</span>
              </span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={themeLabel}
              title={`${themeLabel} (클릭하여 변경)`}
              onClick={cycleTheme}
            >
              <Icon name={themeIcon} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="로그아웃"
              title="로그아웃"
              disabled={logoutBusy}
              onClick={() => void logout()}
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <button
        ref={railBackdrop}
        className={cx("rail-backdrop", railOpen && "open")}
        type="button"
        aria-label="메뉴 닫기"
        aria-hidden={railOpen ? undefined : "true"}
        tabIndex={-1}
        onClick={() => closeRail(true)}
      ></button>
    </>
  );
}
