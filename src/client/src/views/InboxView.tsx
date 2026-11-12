import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Icon from "../components/Icon";
import InboxKnowledgeRow from "./InboxKnowledgeRow";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx, useAppState } from "../lib/hooks";
import { loadInboxData } from "../lib/loaders";
import { goView } from "../lib/nav";
import { notify, readState, replaceState, updateState } from "../lib/state";
import { timeLabel } from "../lib/format";
import { openSeededChat, selectConversation } from "../lib/chat";
import type { AvatarNotification, KnowledgeRequest } from "../lib/types";

type Filter = "all" | "unread" | "requests" | "notifications";
type InboxItem =
  | { kind: "request"; at: string; request: KnowledgeRequest }
  | { kind: "notification"; at: string; notification: AvatarNotification; isRoutine: boolean };

const emptyTexts: Record<Filter, string> = {
  all: "새 알림이나 정보 요청이 없습니다.",
  requests: "열린 정보 요청이 없습니다.",
  unread: "읽지 않은 알림이 없습니다.",
  notifications: "아바타 알림이 없습니다.",
};

function isRoutineConversation(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId) && readState().routineConversations.some((c) => c.id === conversationId);
}

function notificationDomId(notification: AvatarNotification, part: string): string {
  return `notification-${part}-${notification.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export default function InboxView() {
  const state = useAppState();

  const [loading, setLoading] = useState(true);
  // Per-backend load failures (null when that backend loaded). Partial failures
  // still render whatever did load, with a warn-box listing the failed backends.
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  // True only when EVERYTHING failed — then we blank the list and show retry.
  const [hardError, setHardError] = useState(false);

  // Per-item busy flags (delete in flight) so a row can show aria-busy + disable.
  // Rendered (state) and read by the handlers' re-entry guards (ref).
  const [busyIds, setBusyIdsState] = useState(() => new Set<string>());
  const busyIdsRef = useRef(busyIds);
  const [bulkBusy, setBulkBusyState] = useState(false); // read-all / clear-all in flight
  const bulkBusyRef = useRef(false);
  function setBulkBusy(next: boolean): void {
    bulkBusyRef.current = next;
    setBulkBusyState(next);
  }

  useEffect(() => {
    void load();
    // Once, when the view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRequests = state.knowledgeRequests.filter((r) => r.status === "open");
  const notifications = state.notifications;
  const unread = notifications.filter((n) => !n.readAt);

  // Merged, reverse-chronological list of both backends.
  const items = [
    ...openRequests.map((r): InboxItem => ({ kind: "request", at: r.createdAt || "", request: r })),
    ...notifications.map(
      (n): InboxItem => ({
        kind: "notification",
        at: n.createdAt || "",
        notification: n,
        // Computed here so the "결과 보기" button follows the routine list.
        isRoutine: Boolean(n.conversationId) && state.routineConversations.some((c) => c.id === n.conversationId),
      }),
    ),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  const filter = state.inboxFilter as Filter;
  const filtered =
    filter === "requests"
      ? items.filter((item) => item.kind === "request")
      : filter === "unread"
        ? items.filter((item) => item.kind === "notification" && !item.notification.readAt)
        : filter === "notifications"
          ? items.filter((item) => item.kind === "notification")
          : items;

  const filters = [
    { id: "all" as Filter, label: `전체 ${openRequests.length + notifications.length}` },
    { id: "requests" as Filter, label: `정보 요청 ${openRequests.length}` },
    { id: "unread" as Filter, label: `읽지 않은 알림 ${unread.length}` },
    { id: "notifications" as Filter, label: `알림 ${notifications.length}` },
  ];

  const loadWarnings = [
    requestsError ? "정보 요청" : null,
    notificationsError ? "아바타 알림" : null,
    routinesError ? "예약 작업 결과 링크" : null,
  ].filter((x): x is string => Boolean(x));

  const emptyText =
    items.length && filter !== "all"
      ? `이 필터에 해당하는 항목이 없습니다. ${emptyTexts[filter] || ""}`.trim()
      : emptyTexts[filter] || emptyTexts.all;

  async function load() {
    setLoading(true);
    const result = await loadInboxData();
    setRequestsError(result.requestsError);
    setNotificationsError(result.notificationsError);
    setRoutinesError(result.routinesError);
    setHardError(Boolean(result.requestsError && result.notificationsError));
    setLoading(false);
  }

  // Reload after a mutation; throws on transient failure so callers can warn.
  async function refresh() {
    const result = await loadInboxData();
    setRequestsError(result.requestsError);
    setNotificationsError(result.notificationsError);
    setRoutinesError(result.routinesError);
    if (result.requestsError || result.notificationsError) {
      throw new Error(result.notificationsError || result.requestsError || "목록 새로고침에 실패했습니다");
    }
  }

  function setBusy(id: string, on: boolean) {
    const next = new Set(busyIdsRef.current);
    if (on) next.add(id);
    else next.delete(id);
    busyIdsRef.current = next;
    setBusyIdsState(next);
  }

  function setFilter(id: Filter) {
    updateState((s) => (s.inboxFilter = id));
  }
  function focusFilter(id: Filter): void {
    requestAnimationFrame(() => document.getElementById(`inbox-filter-${id}`)?.focus());
  }
  function onFilterKeydown(event: KeyboardEvent<HTMLButtonElement>, currentId: Filter): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = filters.findIndex((item) => item.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? filters.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + filters.length) % filters.length;
    const next = filters[nextIndex].id;
    setFilter(next);
    focusFilter(next);
  }
  function resetFilter() {
    updateState((s) => (s.inboxFilter = "all"));
  }

  // Mark a notification read: optimistic update + fire-and-forget PATCH, reload
  // on failure. Used by both the row click and the explicit handoffs.
  function markRead(notification: AvatarNotification, toast = false) {
    if (notification.readAt) return;
    replaceState({
      notifications: readState().notifications.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    });
    if (toast) notify("알림을 읽었습니다.", "ok");
    api(`/api/me/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" }).catch(() => load());
  }

  // Whole-row click → open a fresh chat with my own avatar seeded with the topic
  // (and mark read). Inner buttons handle themselves (guarded in the handler).
  async function openNotificationChat(notification: AvatarNotification) {
    if (busyIdsRef.current.has(notification.id)) return;
    setBusy(notification.id, true);
    markRead(notification);
    const seed = `다음은 네가 남긴 알림이야. 이 주제로 이어서 이야기하자.\n\n[${notification.title}]\n${notification.message}`;
    try {
      await openSeededChat(seed);
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setBusy(notification.id, false);
    }
  }

  // Routine results route to the routines view; ordinary conversations open in chat.
  async function openResult(notification: AvatarNotification) {
    if (!notification.conversationId || busyIdsRef.current.has(notification.id)) return;
    setBusy(notification.id, true);
    try {
      markRead(notification);
      if (isRoutineConversation(notification.conversationId)) {
        goView("routines", notification.conversationId);
      } else {
        goView("chat");
        await selectConversation(notification.conversationId);
      }
    } catch (err) {
      notify(`결과를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setBusy(notification.id, false);
    }
  }

  async function deleteNotification(notification: AvatarNotification) {
    if (busyIdsRef.current.has(notification.id)) return;
    setBusy(notification.id, true);
    try {
      await api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, { method: "DELETE" });
    } catch (e) {
      setBusy(notification.id, false);
      notify(`삭제 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify("알림을 삭제했습니다.", "ok");
    } catch (e) {
      setBusy(notification.id, false);
      notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
      return;
    }
    setBusy(notification.id, false);
  }

  async function readAll() {
    const count = unread.length;
    if (!count || bulkBusyRef.current) return;
    setBulkBusy(true);
    try {
      await api("/api/me/notifications/read-all", { method: "POST" });
    } catch (e) {
      setBulkBusy(false);
      notify(`처리 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify(`알림 ${count}개를 읽음 처리했습니다.`, "ok");
    } catch (e) {
      notify(`알림은 읽음 처리했지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
    }
    setBulkBusy(false);
  }

  async function clearAll() {
    const count = notifications.length;
    if (!count || bulkBusyRef.current) return;
    if (!(await confirmAction(`알림 ${count}개를 모두 비울까요? 정보 요청은 삭제되지 않습니다.`))) return;
    setBulkBusy(true);
    try {
      await api("/api/me/notifications", { method: "DELETE" });
    } catch (e) {
      setBulkBusy(false);
      notify(`비우기 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify(`알림 ${count}개를 비웠습니다.`, "ok");
    } catch (e) {
      notify(`알림은 비웠지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
    }
    setBulkBusy(false);
  }

  return (
    <>
      <header className="view-header">
        <div>
          <h1>알림</h1>
          <p>아바타가 남긴 알림과 동료의 정보 요청을 한곳에서 확인하세요</p>
        </div>
        <div className="head-actions">
          {unread.length ? (
            <button className="ghost-sm" type="button" disabled={bulkBusy} onClick={() => void readAll()}>
              {bulkBusy ? "처리 중…" : "알림 모두 읽음"}
            </button>
          ) : null}
          {notifications.length ? (
            <button className="ghost-sm danger" type="button" disabled={bulkBusy} onClick={() => void clearAll()}>
              알림 비우기
            </button>
          ) : null}
        </div>
      </header>

      <div className="view-body scroll-thin inbox-body">
        {loading ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : hardError ? (
          <div className="warn-box" role="alert">
            알림을 불러오지 못했습니다: {notificationsError || requestsError || "네트워크 오류"}{" "}
            <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : (
          <div className="inbox-wrap">
            <section className="settings-card">
              <div className="panel-section-head">
                <div>
                  <h3>알림</h3>
                  <p className="muted">
                    알림을 누르면 그 주제로 내 아바타와 대화할 수 있고, 휴지통으로 삭제합니다. ‘정보 요청’은 답을 적어
                    보내면 아바타가 지식 저장소에 기록합니다.
                  </p>
                </div>
              </div>

              {loadWarnings.length ? (
                <div className="warn-box inbox-load-warning" role="alert">
                  일부 항목({loadWarnings.join(" · ")})을 불러오지 못했습니다. 표시된 목록은 일부만 최신일 수 있습니다.{" "}
                  <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
                    다시 시도
                  </button>
                </div>
              ) : null}

              <div className="inbox-filter seg-control" role="radiogroup" aria-label="알림 필터">
                {filters.map((f, index) => (
                  <button
                    key={index}
                    id={`inbox-filter-${f.id}`}
                    className={cx("seg-btn", filter === f.id && "active")}
                    type="button"
                    role="radio"
                    aria-checked={filter === f.id ? "true" : "false"}
                    tabIndex={filter === f.id ? 0 : -1}
                    onClick={() => setFilter(f.id)}
                    onKeyDown={(event) => onFilterKeydown(event, f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="inbox-list">
                {!filtered.length ? (
                  <div className="empty-note">
                    {emptyText}{" "}
                    {items.length && filter !== "all" ? (
                      <button className="linkish small" type="button" onClick={resetFilter}>
                        전체 보기
                      </button>
                    ) : null}
                  </div>
                ) : (
                  filtered.map((item) => {
                    if (item.kind === "request") {
                      return <InboxKnowledgeRow key={`r:${item.request.id}`} request={item.request} refresh={refresh} />;
                    }
                    const n = item.notification;
                    const busy = busyIds.has(n.id);
                    return (
                      <div
                        key={`n:${n.id}`}
                        className={cx("notification-row clickable", !n.readAt && "unread")}
                        role="group"
                        aria-labelledby={notificationDomId(n, "title")}
                        aria-describedby={notificationDomId(n, "meta")}
                        aria-busy={busy ? "true" : "false"}
                      >
                        <button
                          className="notification-dismiss"
                          type="button"
                          aria-label={`알림 삭제: ${n.title}`}
                          title="알림 삭제"
                          disabled={busy}
                          onClick={() => void deleteNotification(n)}
                        >
                          <Icon name="close" size={16} />
                        </button>
                        <button
                          className="notification-main"
                          type="button"
                          aria-label={`알림 주제로 대화 열기: ${n.title}`}
                          aria-describedby={notificationDomId(n, "meta")}
                          disabled={busy}
                          title="알림 주제로 대화 열기"
                          onClick={() => void openNotificationChat(n)}
                        >
                          <div className="inbox-row-head">
                            <span className="inbox-chip note">알림</span>
                            <strong id={notificationDomId(n, "title")}>{n.title}</strong>
                          </div>
                          <div className="pr-sub" id={notificationDomId(n, "meta")}>
                            {n.avatarDisplayName} · {timeLabel(n.createdAt)}
                          </div>
                          <p>{n.message}</p>
                        </button>
                        {item.isRoutine ? (
                          <div className="kr-actions">
                            <button
                              className="ghost-sm"
                              type="button"
                              aria-label={`예약 작업 결과 보기: ${n.title}`}
                              disabled={busy}
                              onClick={() => void openResult(n)}
                            >
                              {busy ? "여는 중…" : "결과 보기"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
