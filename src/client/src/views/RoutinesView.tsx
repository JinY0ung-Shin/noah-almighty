// The routines tab is the single home for routines: a two-pane workspace whose
// left side MANAGES them (add/edit/toggle/run + search/filter) and whose right
// side shows the selected routine's per-run result transcript.
//
// Layout direction (2026-07 redesign): the panes are FLAT — no card-in-card.
// The old screen nested view-body → settings-card → bordered box → run block →
// bubble, so every level added its own border+padding and the content ended up
// adrift in unexplained gutters. Now each pane owns one padded surface and the
// rows/runs sit directly on it.
//
// Information direction: a scheduler's job is to answer "무엇이 언제?" at a
// glance, so the row leads with the schedule + a RELATIVE next-run ("내일 오전
// 9:00", "3시간 후") and demotes the last outcome to a second, quieter line.
// Grouping (예정 / 일시 정지 / 지난 실행) is always on and replaces the old
// 반복/1회성 type filter, which duplicated what the groups already say.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Icon from "../components/Icon";
import Toggle from "../components/Toggle";
import RoutineModal from "../components/RoutineModal";
import RoutineRunBlock, { RoutineMarkdown } from "../components/RoutineRunBlock";
import { api } from "../lib/api";
import { countdownLabel, formatRoutineSchedule, relativeDayTimeLabel, routineTitle } from "../lib/format";
import { cx, useAppState } from "../lib/hooks";
import { loadRoutineMessages, loadRoutinesData } from "../lib/loaders";
import { scrollToStart } from "../lib/motion";
import { openSeededChat, selectConversation } from "../lib/chat";
import { Presence } from "../lib/presence";
import { notify, readState, replaceState, updateState } from "../lib/state";
import type { RoutineJob, RoutinePreset, StoredMessage } from "../lib/types";

type FilterId = "all" | "enabled" | "paused" | "completed" | "error";

const FILTER_DEFS: { id: FilterId; label: string; match: (r: RoutineJob) => boolean }[] = [
  { id: "all", label: "전체", match: () => true },
  { id: "enabled", label: "사용 중", match: (r) => r.enabled },
  { id: "paused", label: "일시 정지", match: (r) => !r.enabled && !r.completedAt },
  { id: "completed", label: "완료", match: (r) => Boolean(r.completedAt) },
  { id: "error", label: "실패", match: (r) => r.lastStatus === "error" },
];

// Starter cards on the zero-routine empty state. An empty scheduler can't show
// what it's for, so it offers three concrete jobs that open the create modal
// pre-filled instead of a blank form.
const PRESETS: { label: string; hint: string; preset: RoutinePreset }[] = [
  {
    label: "아침 브리핑",
    hint: "매일 오전 9시",
    preset: {
      name: "아침 브리핑",
      prompt: "오늘 확인해야 할 일정과 어제 이후 달라진 것들을 3줄로 요약해줘.",
      scheduleKind: "daily",
      time: "09:00",
    },
  },
  {
    label: "주간 회고 초안",
    hint: "매주 금요일 오후 6시",
    preset: {
      name: "주간 회고 초안",
      prompt: "이번 주에 한 일과 남은 일을 훑어서 회고 초안을 만들어줘.",
      scheduleKind: "weekly",
      daysOfWeek: [5],
      time: "18:00",
    },
  },
  {
    label: "한 번만 리마인더",
    hint: "지정한 날짜에 한 번",
    preset: {
      name: "",
      prompt: "이날 확인해야 할 일을 정리해서 알려줘.",
      scheduleKind: "once",
      time: "09:00",
    },
  },
];

const routineActionStatusId = "routine-action-status";

// Draggable split between the manage list (left) and the result panel (right).
// The width is a per-browser preference persisted to localStorage; CSS clamps it
// to [SIDE_MIN, SIDE_MAX] as a backstop so a stale value can never break layout.
const SIDE_MIN = 280;
const SIDE_MAX = 620;
const SIDE_DEFAULT = 360;
const SIDE_STORAGE_KEY = "noah.routineSideWidth";

function clampWidth(n: number): number {
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, n));
}
function loadSideWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDE_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return clampWidth(n);
  } catch {
    /* localStorage may be unavailable (private mode) — fall back to default. */
  }
  return SIDE_DEFAULT;
}

type RoutineRun = { prompt: StoredMessage | null; responses: StoredMessage[]; at: string | null };

// Group the alternating user/assistant transcript into runs: each user message
// starts a new run; the assistant message(s) after belong to it.
function groupRoutineRuns(messages: StoredMessage[]): RoutineRun[] {
  const out: RoutineRun[] = [];
  let current: RoutineRun | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      current = { prompt: m, responses: [], at: m.createdAt || null };
      out.push(current);
    } else {
      if (!current) {
        current = { prompt: null, responses: [], at: m.createdAt || null };
        out.push(current);
      }
      current.responses.push(m);
      if (m.createdAt) current.at = m.createdAt;
    }
  }
  return out;
}

function routineDomId(routine: RoutineJob, part: string): string {
  return `routine-${part}-${routine.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

// One row's derived display state, kept in one place so the markup stays flat.
// `sched` + `tail` are split so the recurrence can stay bold while the whole
// line remains ONE non-wrapping text run that truncates instead of breaking
// mid-value.
function rowView(routine: RoutineJob, at: Date) {
  const completed = Boolean(routine.completedAt);
  const errored = routine.lastStatus === "error";
  const nextAt = !completed && routine.enabled ? routine.nextRunAt : null;
  const schedule = formatRoutineSchedule(routine).replace(" (KST)", "");
  const next = nextAt ? relativeDayTimeLabel(nextAt, at) : "";
  const once = routine.scheduleKind === "once";
  // A one-time job's schedule IS its next run, so printing both would say the
  // same date twice in one line.
  const rest = once
    ? next || schedule.replace(/^한 번 · /, "")
    : next
      ? `다음 ${next}`
      : routine.enabled
        ? ""
        : "일시 정지됨";
  // The countdown only earns its space when the date label can't be read as a
  // distance: "내일 오전 9:00" already says "about a day", but "8. 14. (금)"
  // doesn't. Sub-hour runs always get it — that's when urgency matters.
  const soon = nextAt ? countdownLabel(nextAt, at) : "";
  const spelledDay = next.startsWith("오늘") || next.startsWith("내일");
  return {
    completed,
    errored,
    title: routineTitle(routine),
    sched: once ? "한 번" : schedule,
    // Carried WITH its separator, so the space before the "·" is part of the value.
    tail: rest ? ` · ${rest}` : "",
    countdown: !spelledDay || /^곧$|분 후$/.test(soon) ? soon : "",
    last: routine.lastRunAt || routine.completedAt || "",
    lastLabel: relativeDayTimeLabel(routine.lastRunAt || routine.completedAt || "", at),
  };
}

/**
 * State that is shown AND read later by code that outlives the render which
 * started it (an `await`, a drag): the ref always holds the latest value.
 */
function useLiveState<T>(initial: T | (() => T)): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  }).current;
  return [value, set, ref];
}

export default function RoutinesView() {
  const state = useAppState();

  const [loading, setLoading] = useState(true);
  const [loadBusy, setLoadBusy, loadBusyRef] = useLiveState(false);
  const [error, setError] = useState("");
  const [messageLoadError, setMessageLoadError] = useState("");
  const [modalRoutine, setModalRoutine] = useState<RoutineJob | null>(null);
  const [modalPreset, setModalPreset] = useState<RoutinePreset | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyRoutineId, setBusyRoutineId, busyRoutineIdRef] = useLiveState("");
  const [resultBusyId, setResultBusyId, resultBusyIdRef] = useLiveState("");
  const [routineActionStatus, setRoutineActionStatus] = useState("");
  const [openingConversation, setOpeningConversation, openingConversationRef] = useLiveState(false);
  const resultEl = useRef<HTMLElement | null>(null);
  // Re-derived on every load/run so relative labels ("3시간 후") don't go stale
  // while the tab sits open; recomputed cheaply, never on a timer.
  const [now, setNow] = useState(() => new Date());
  const [sideWidth, setSideWidth, sideWidthRef] = useLiveState(loadSideWidth);

  function persistSideWidth(): void {
    try {
      window.localStorage.setItem(SIDE_STORAGE_KEY, String(Math.round(sideWidthRef.current)));
    } catch {
      /* ignore persistence failures */
    }
  }
  function resetSideWidth(): void {
    setSideWidth(SIDE_DEFAULT);
    persistSideWidth();
  }
  function onSplitterPointerDown(event: ReactPointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startW = sideWidthRef.current;
    const onMove = (ev: PointerEvent) => {
      setSideWidth(clampWidth(startW + (ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      persistSideWidth();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer stream (touch interruption, gesture takeover) must also
    // release the listeners + the body cursor/user-select lock.
    window.addEventListener("pointercancel", onUp);
    document.body.classList.add("col-resizing");
  }
  function onSplitterKeydown(event: ReactKeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      setSideWidth(clampWidth(sideWidthRef.current - step));
      event.preventDefault();
      persistSideWidth();
    } else if (event.key === "ArrowRight") {
      setSideWidth(clampWidth(sideWidthRef.current + step));
      event.preventDefault();
      persistSideWidth();
    } else if (event.key === "Home") {
      resetSideWidth();
      event.preventDefault();
    } else if (event.key === "End") {
      setSideWidth(SIDE_MAX);
      event.preventDefault();
      persistSideWidth();
    }
  }

  useEffect(() => {
    void load();
    // Never strand the drag cursor/user-select lock if the view unmounts mid-resize.
    return () => document.body.classList.remove("col-resizing");
    // Runs once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const routines = state.routines;
  const filterId = (FILTER_DEFS.some((f) => f.id === state.routineFilter) ? state.routineFilter : "all") as FilterId;
  const activeFilter = FILTER_DEFS.find((f) => f.id === filterId) ?? FILTER_DEFS[0];
  const query = state.routineSearch.trim().toLowerCase();
  const filteredByTab = routines.filter(activeFilter.match);
  const filtered = query
    ? filteredByTab.filter((r) => {
        const haystack = [
          routineTitle(r),
          r.prompt || "",
          formatRoutineSchedule(r),
          r.enabled ? "사용 중" : "일시 정지",
          r.lastStatus === "error" ? "실패" : "완료",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : filteredByTab;

  // Always-on grouping. 예정 is ordered by when it actually fires next (the
  // question the group answers); 지난 실행 by most recently finished.
  const listGroups = [
    {
      id: "upcoming",
      label: "예정",
      collapsible: false,
      routines: filtered
        .filter((r) => !r.completedAt && r.enabled)
        .sort((a, b) => (a.nextRunAt || "9999").localeCompare(b.nextRunAt || "9999")),
    },
    {
      id: "paused",
      label: "일시 정지",
      collapsible: false,
      routines: filtered.filter((r) => !r.completedAt && !r.enabled),
    },
    {
      id: "history",
      label: "지난 실행",
      collapsible: true,
      routines: filtered
        .filter((r) => Boolean(r.completedAt))
        .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    },
  ].filter((g) => g.routines.length);

  const filterCounts = FILTER_DEFS.reduce(
    (acc, f) => {
      acc[f.id] = routines.filter(f.match).length;
      return acc;
    },
    {} as Record<FilterId, number>,
  );
  // 실패/완료 only earn a chip once they can actually match something — a filter
  // for an empty set is chrome, and dropping it keeps the row on one line.
  const visibleFilters = FILTER_DEFS.filter(
    (f) => (f.id !== "completed" && f.id !== "error") || f.id === filterId || filterCounts[f.id] > 0,
  );
  const enabledCount = routines.filter((r) => r.enabled && !r.completedAt).length;
  const errorCount = routines.filter((r) => r.lastStatus === "error").length;
  const nextUp =
    routines
      .filter((r) => r.enabled && !r.completedAt && r.nextRunAt)
      .sort((a, b) => (a.nextRunAt || "").localeCompare(b.nextRunAt || ""))[0] || null;
  // The header subtitle carries the whole screen's state in one line, which is
  // what a scheduler is actually asked most often ("뭐가 언제 돌지?").
  const headerSummary = !routines.length
    ? "한 번만 또는 반복해서 아바타가 스스로 실행할 작업과 결과를 관리하세요"
    : [`사용 중 ${enabledCount}개`, nextUp ? `다음 실행 ${relativeDayTimeLabel(nextUp.nextRunAt, now)}` : "예정된 실행 없음"].join(" · ");
  const countLabel = filtered.length === routines.length ? `${routines.length}개` : `${filtered.length} / ${routines.length}개`;
  const filterLabel = (id: FilterId) => FILTER_DEFS.find((f) => f.id === id)?.label || "전체";

  const selectedConv = state.routineConversations.find((c) => c.id === state.routineConversationId) || null;
  const selectedRoutine = selectedConv ? routines.find((r) => r.conversationId === selectedConv.id) || null : null;
  const currentPrompt = (selectedRoutine?.prompt || "").trim();
  const promptOneLine = currentPrompt.replace(/\s+/g, " ").trim();
  const runs = groupRoutineRuns(state.routineMessages);

  async function load(): Promise<void> {
    if (loadBusyRef.current) return;
    setLoadBusy(true);
    setLoading(true);
    setError("");
    setMessageLoadError("");
    try {
      await loadRoutinesData();
    } catch (err) {
      setError((err as Error).message || "네트워크 오류");
      setLoading(false);
      setLoadBusy(false);
      return;
    }
    setNow(new Date());
    // Pin a sensible selection: keep the current one if still present, else first.
    const convs = readState().routineConversations;
    let convId = readState().routineConversationId;
    if (convId && !convs.some((c) => c.id === convId)) convId = convs[0]?.id || "";
    else if (!convId && convs.length) convId = convs[0].id;
    updateState((state) => (state.routineConversationId = convId));
    if (convId) {
      try {
        await loadRoutineMessages(convId);
      } catch (err) {
        setMessageLoadError((err as Error).message || "네트워크 오류");
        replaceState({ routineMessages: [] });
      }
    } else {
      replaceState({ routineMessages: [] });
    }
    setLoading(false);
    setLoadBusy(false);
  }

  function setFilter(id: FilterId): void {
    updateState((state) => (state.routineFilter = id));
  }
  function focusFilter(id: FilterId): void {
    requestAnimationFrame(() => document.getElementById(`routine-filter-${id}`)?.focus());
  }
  // Roving tabindex over the RENDERED chips — walking FILTER_DEFS would land
  // focus on a chip that isn't in the DOM.
  function onFilterKeydown(event: ReactKeyboardEvent, currentId: FilterId): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const defs = visibleFilters;
    const currentIndex = defs.findIndex((item) => item.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? defs.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + defs.length) % defs.length;
    const next = defs[nextIndex].id;
    setFilter(next);
    focusFilter(next);
  }

  function clearSearch(): void {
    updateState((state) => (state.routineSearch = ""));
  }

  function openModal(routine: RoutineJob | null, preset: RoutinePreset | null = null): void {
    setModalRoutine(routine);
    setModalPreset(routine ? null : preset);
    setModalOpen(true);
  }

  function closeModal(): void {
    setModalOpen(false);
    setModalRoutine(null);
    setModalPreset(null);
  }

  // Stacked (narrow) layout puts the result pane below the fold, so a selection
  // that only changes off-screen content reads as "nothing happened".
  function revealResultWhenStacked(): void {
    if (typeof window === "undefined" || !resultEl.current) return;
    if (!window.matchMedia?.("(max-width: 980px)").matches) return;
    scrollToStart(resultEl.current);
  }

  async function selectResult(routine: RoutineJob): Promise<void> {
    if (resultBusyIdRef.current || busyRoutineIdRef.current === routine.id) return;
    const wasActive = readState().routineConversationId === routine.conversationId;
    setResultBusyId(routine.id);
    setRoutineActionStatus(`"${routineTitle(routine)}" 예약 작업 결과를 불러오는 중입니다.`);
    updateState((state) => (state.routineConversationId = routine.conversationId));
    setMessageLoadError("");
    let loaded = true;
    try {
      await loadRoutineMessages(routine.conversationId);
    } catch (err) {
      loaded = false;
      const message = (err as Error).message || "네트워크 오류";
      setMessageLoadError(message);
      setRoutineActionStatus(`예약 작업 결과 불러오기 실패: ${message}`);
      replaceState({ routineMessages: [] });
    } finally {
      setResultBusyId("");
    }
    const title = routineTitle(routine);
    if (loaded) {
      setRoutineActionStatus(wasActive ? `"${title}" 예약 작업 결과를 보고 있습니다.` : `"${title}" 예약 작업 결과를 표시했습니다.`);
    }
    revealResultWhenStacked();
  }

  async function toggleRoutine(routine: RoutineJob, next: boolean): Promise<void> {
    const title = routineTitle(routine);
    setRoutineActionStatus(`"${title}" 예약 작업을 ${next ? "사용" : "일시 정지"}하는 중입니다.`);
    try {
      await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
    } catch (err) {
      const status = `변경 실패: ${(err as Error).message}`;
      setRoutineActionStatus(status);
      notify(status);
      throw err;
    }
    try {
      await loadRoutinesData();
      setNow(new Date());
      const status = `"${title}" 예약 작업을 ${next ? "사용" : "일시 정지"}했습니다.`;
      setRoutineActionStatus(status);
      notify(status, "ok");
    } catch (err) {
      const status = `예약 작업 상태는 변경했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      setRoutineActionStatus(status);
      notify(status, "warn");
    }
  }

  // "지금 실행" hands the routine's prompt to a NORMAL chat instead of firing the
  // headless run (POST /api/me/routines/:id/run). A headless run streams to
  // nobody and only persists its messages when it finishes, so the old behavior
  // left the owner watching a spinner for as long as the run took, with no
  // output, no activity tree, and no way to answer a question prompt. Seeded
  // and NOT sent, so the prompt can be edited for this one-off run first.
  async function runFromButton(routine: RoutineJob): Promise<void> {
    if (busyRoutineIdRef.current) return;
    setBusyRoutineId(routine.id);
    setRoutineActionStatus(`"${routineTitle(routine)}" 예약 작업 프롬프트로 대화를 여는 중입니다.`);
    try {
      await openSeededChat(routine.prompt, "예약 작업 프롬프트를 입력창에 넣었습니다. 검토 후 보내기를 누르세요.");
    } catch (err) {
      const status = `대화를 열지 못했습니다: ${(err as Error).message}`;
      setRoutineActionStatus(status);
      notify(status);
    } finally {
      setBusyRoutineId("");
    }
  }

  function onModalSaved(): void {
    void load();
  }

  function onModalDeleted(detail: { routine: RoutineJob }): void {
    const routine = detail.routine;
    replaceState({
      routines: readState().routines.filter((r) => r.id !== routine.id),
      routineConversations: readState().routineConversations.filter((c) => c.routineId !== routine.id),
    });
    if (readState().routineConversationId === routine.conversationId) {
      updateState((state) => (state.routineConversationId = ""));
      replaceState({ routineMessages: [] });
    }
    void load();
  }

  async function openAsConversation(): Promise<void> {
    if (!selectedConv || openingConversationRef.current) return;
    setOpeningConversation(true);
    try {
      await selectConversation(selectedConv.id);
    } catch (err) {
      notify(`일반 대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setOpeningConversation(false);
    }
  }

  return (
    <>
      <header className="view-header">
        <div className="title">
          <h1>예약 작업</h1>
          <p>
            {headerSummary}
            {errorCount ? <span className="routine-head-alert">{` · 실패 ${errorCount}개`}</span> : null}
          </p>
        </div>
        <div className="head-actions">
          <button className="primary small routine-add-btn" type="button" onClick={() => openModal(null)}>
            <Icon name="plus" size={16} />
            <span>예약 작업 추가</span>
          </button>
        </div>
      </header>

      <div className="view-body routines-body">
        {/* Progress/outcome narration lives in one off-screen live region; the
            visible feedback is the toast + each control's own busy label, so the
            list never reflows because a status line appeared above it. */}
        <div id={routineActionStatusId} className="sr-only" role="status" aria-live="polite">
          {routineActionStatus}
        </div>

        {loading ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : error ? (
          <div className="warn-box" role="alert">
            예약 작업 정보를 불러오지 못했습니다: {error}{" "}
            <button className="linkish" type="button" disabled={loadBusy} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : (
          // With zero routines there is nothing to manage, so the split disappears
          // and the whole width goes to onboarding instead of parking an empty
          // list column next to an empty result column.
          <div
            className={cx("routine-workspace", !routines.length && "solo")}
            style={{ "--routine-side-w": `${sideWidth}px` } as CSSProperties}
          >
            {/* ===== Left: manage pane ===== */}
            {routines.length ? (
              <>
                <section className="routine-pane routine-side" aria-label="내 예약 작업">
                  <div className="routine-side-tools">
                    <div className="routine-search-row">
                      <span className="routine-search-wrap">
                        <input
                          className="routine-search"
                          type="search"
                          placeholder="이름·프롬프트·주기 검색"
                          aria-label="예약 작업 검색"
                          value={state.routineSearch}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            updateState((state) => (state.routineSearch = value));
                          }}
                        />
                      </span>{" "}
                      <span className="routine-count muted nowrap">{countLabel}</span>
                    </div>
                    {/* Each chip spells its own aria-label: the count lives in an
                        inline span the accname algorithm would glue on as "완료1". */}
                    <div className="routine-filter-chips" role="radiogroup" aria-label="예약 작업 상태">
                      {visibleFilters.map((f) => {
                        const active = filterId === f.id;
                        const count = filterCounts[f.id];
                        return (
                          <button
                            key={f.id}
                            id={`routine-filter-${f.id}`}
                            className={cx("routine-chip", active && "active", f.id === "error" && count > 0 && "danger")}
                            type="button"
                            role="radio"
                            aria-checked={active ? "true" : "false"}
                            aria-label={`${f.label} ${count}`}
                            tabIndex={active ? 0 : -1}
                            data-value={f.id}
                            onClick={() => setFilter(f.id)}
                            onKeyDown={(event) => onFilterKeydown(event, f.id)}
                          >
                            {f.label}
                            <span className="routine-chip-n">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="routine-manage-list scroll-thin">
                    {!filtered.length ? (
                      <div className="routine-empty tall">
                        <h3>{query ? "검색 결과가 없습니다" : `${filterLabel(filterId)} 작업이 없습니다`}</h3>
                        <p>
                          {query ? <>“{state.routineSearch.trim()}”에 맞는 예약 작업을 찾지 못했습니다.</> : "다른 상태를 골라 보세요."}
                        </p>
                        <div className="routine-empty-actions">
                          {query ? (
                            <button className="ghost-sm" type="button" onClick={clearSearch}>
                              검색어 지우기
                            </button>
                          ) : null}{" "}
                          {filterId !== "all" ? (
                            <button className="ghost-sm" type="button" onClick={() => setFilter("all")}>
                              전체 보기
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      listGroups.map((group) =>
                        group.collapsible ? (
                          <details key={group.id} className="routine-group" open={filterId === "completed" || Boolean(query)}>
                            <summary className="routine-group-head">
                              <span className="routine-group-chevron" aria-hidden="true"></span> <span>{group.label}</span>{" "}
                              <span className="routine-group-n">{group.routines.length}</span>
                            </summary>
                            <div className="routine-group-items">
                              {group.routines.map((routine) => {
                                const v = rowView(routine, now);
                                const active = state.routineConversationId === routine.conversationId;
                                return (
                                  <div
                                    key={routine.id}
                                    className={cx("routine-row is-done", active && "active")}
                                    aria-current={active ? "true" : undefined}
                                  >
                                    <button
                                      className="routine-row-main"
                                      type="button"
                                      aria-label={`예약 작업 결과 보기: ${v.title}`}
                                      disabled={Boolean(resultBusyId)}
                                      onClick={() => void selectResult(routine)}
                                    >
                                      <span className="routine-row-title">
                                        <span className="routine-row-name">{v.title}</span> <span className="tag">1회</span>
                                      </span>{" "}
                                      <span className="routine-row-when">
                                        <span className="routine-row-when-text" title={v.sched + v.tail}>
                                          <span className="routine-row-sched">{v.sched}</span>
                                          {v.tail}
                                        </span>
                                      </span>{" "}
                                      <span className="routine-row-last">
                                        <span className={`routine-mark ${v.errored ? "err" : "ok"}`} aria-hidden="true"></span>{" "}
                                        {v.errored ? "실패" : "완료"} · {v.lastLabel}
                                      </span>
                                    </button>
                                    <div className="routine-row-side">
                                      <div className="routine-row-acts">
                                        <button
                                          className="routine-icon-btn"
                                          type="button"
                                          title="편집"
                                          aria-label={`예약 작업 편집: ${v.title}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            openModal(routine);
                                          }}
                                        >
                                          <Icon name="edit" size={15} />
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        ) : (
                          <div key={group.id} className="routine-group">
                            <div className="routine-group-head static">
                              <span>{group.label}</span> <span className="routine-group-n">{group.routines.length}</span>
                            </div>
                            <div className="routine-group-items">
                              {group.routines.map((routine) => {
                                const v = rowView(routine, now);
                                const active = state.routineConversationId === routine.conversationId;
                                const busy = busyRoutineId === routine.id || resultBusyId === routine.id;
                                return (
                                  <div
                                    key={routine.id}
                                    className={cx("routine-row", active && "active", !routine.enabled && "paused", v.errored && "failed")}
                                    aria-current={active ? "true" : undefined}
                                    aria-busy={busy ? "true" : undefined}
                                  >
                                    <button
                                      className="routine-row-main"
                                      type="button"
                                      aria-label={active ? `선택된 예약 작업 결과: ${v.title}` : `예약 작업 결과 보기: ${v.title}`}
                                      aria-describedby={`${routineDomId(routine, "meta")}${v.errored && routine.lastError ? ` ${routineDomId(routine, "error")}` : ""} ${routineActionStatusId}`}
                                      disabled={busyRoutineId === routine.id || Boolean(resultBusyId)}
                                      onClick={() => void selectResult(routine)}
                                    >
                                      <span className="routine-row-title">
                                        <span className="routine-row-name">{v.title}</span>{" "}
                                        {routine.scheduleKind === "once" ? <span className="tag">1회</span> : null}
                                      </span>{" "}
                                      <span className="routine-row-when" id={routineDomId(routine, "meta")}>
                                        <span className="routine-row-when-text" title={v.sched + v.tail}>
                                          <span className="routine-row-sched">{v.sched}</span>
                                          {v.tail}
                                        </span>{" "}
                                        {v.countdown ? <span className="routine-row-in">{v.countdown}</span> : null}
                                      </span>{" "}
                                      <span className="routine-row-last">
                                        {v.last ? (
                                          <>
                                            <span className={`routine-mark ${v.errored ? "err" : "ok"}`} aria-hidden="true"></span> 최근{" "}
                                            {v.lastLabel} · {v.errored ? "실패" : "성공"}
                                          </>
                                        ) : (
                                          <>
                                            <span className="routine-mark idle" aria-hidden="true"></span> 아직 실행되지 않음
                                          </>
                                        )}
                                      </span>{" "}
                                      {v.errored && routine.lastError ? (
                                        <span className="routine-row-error" id={routineDomId(routine, "error")}>
                                          {routine.lastError}
                                        </span>
                                      ) : null}
                                    </button>
                                    <div className="routine-row-side">
                                      <div className="routine-row-acts">
                                        <button
                                          className="routine-icon-btn"
                                          type="button"
                                          title="지금 실행 — 대화창에 프롬프트를 넣어 엽니다"
                                          aria-label={`예약 작업 지금 실행: ${v.title}`}
                                          aria-describedby={routineActionStatusId}
                                          disabled={busyRoutineId === routine.id}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void runFromButton(routine);
                                          }}
                                        >
                                          {busyRoutineId === routine.id ? (
                                            <span className="routine-spinner" aria-hidden="true"></span>
                                          ) : (
                                            <Icon name="play" size={14} />
                                          )}
                                        </button>{" "}
                                        <button
                                          className="routine-icon-btn"
                                          type="button"
                                          title="편집"
                                          aria-label={`예약 작업 편집: ${v.title}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            openModal(routine);
                                          }}
                                        >
                                          <Icon name="edit" size={15} />
                                        </button>
                                      </div>{" "}
                                      <Toggle
                                        on={routine.enabled}
                                        label={`예약 작업 사용: ${v.title}`}
                                        onChange={(next) => toggleRoutine(routine, next)}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ),
                      )
                    )}
                  </div>
                </section>

                {/* Drag to resize the two panels; double-click (or Home) to reset.
                    role="separator" + tabindex + arrow keys IS the WAI-ARIA window-splitter
                    pattern. */}
                <div
                  className="routine-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="패널 너비 조절"
                  aria-valuenow={Math.round(sideWidth)}
                  aria-valuemin={SIDE_MIN}
                  aria-valuemax={SIDE_MAX}
                  aria-valuetext={`${Math.round(sideWidth)}px`}
                  tabIndex={0}
                  title="드래그해서 너비 조절 · 더블클릭으로 초기화"
                  onPointerDown={onSplitterPointerDown}
                  onKeyDown={onSplitterKeydown}
                  onDoubleClick={resetSideWidth}
                >
                  <span className="routine-splitter-grip" aria-hidden="true"></span>
                </div>
              </>
            ) : null}

            {/* ===== Right: result pane ===== */}
            <section className="routine-pane routine-result" aria-label="예약 작업 결과" ref={resultEl}>
              {selectedConv ? (
                <>
                  <div className="routine-result-head">
                    <div className="routine-result-id">
                      <h2>{selectedRoutine ? routineTitle(selectedRoutine) : selectedConv.title}</h2>
                      <p className="muted">
                        {selectedRoutine ? (
                          <>
                            {formatRoutineSchedule(selectedRoutine).replace(" (KST)", "")}{" "}
                            {selectedRoutine.enabled && selectedRoutine.nextRunAt ? (
                              <>· 다음 {relativeDayTimeLabel(selectedRoutine.nextRunAt, now)}</>
                            ) : null}
                          </>
                        ) : (
                          selectedConv.avatarDisplayName
                        )}
                      </p>
                    </div>
                    <div className="head-actions">
                      {selectedRoutine && !selectedRoutine.completedAt ? (
                        <button
                          className="ghost-sm"
                          type="button"
                          disabled={busyRoutineId === selectedRoutine.id}
                          onClick={() => void runFromButton(selectedRoutine)}
                        >
                          {busyRoutineId === selectedRoutine.id ? "여는 중…" : "지금 실행"}
                        </button>
                      ) : null}{" "}
                      <button className="ghost-sm" type="button" disabled={openingConversation} onClick={() => void openAsConversation()}>
                        {openingConversation ? "여는 중…" : "일반 대화로 열기"}
                      </button>
                    </div>
                  </div>

                  {currentPrompt ? (
                    // The instruction is context, not content: one clamped line by
                    // default, expandable when the reader actually wants it.
                    <details className="routine-prompt">
                      <summary className="routine-prompt-head">
                        <span className="routine-prompt-chevron" aria-hidden="true"></span>{" "}
                        <span className="routine-prompt-label">지시</span> <span className="routine-prompt-peek">{promptOneLine}</span>
                      </summary>
                      <RoutineMarkdown className="routine-prompt-body md" source={currentPrompt} />
                    </details>
                  ) : null}
                </>
              ) : null}

              <div className="routine-runs scroll-thin">
                {!selectedConv ? (
                  routines.length ? (
                    <div className="routine-empty tall">
                      <span className="routine-empty-icon" aria-hidden="true">
                        <Icon name="activity" size={20} />
                      </span>
                      <h3>확인할 실행 결과가 없습니다</h3>
                      <p>왼쪽에서 예약 작업을 고르거나, 하나를 지금 실행하면 결과가 여기에 표시됩니다.</p>
                      <div className="routine-empty-actions">
                        <button
                          className="ghost-sm"
                          type="button"
                          aria-describedby={routineActionStatusId}
                          disabled={busyRoutineId === routines[0].id}
                          onClick={() => void runFromButton(routines[0])}
                        >
                          첫 예약 작업 지금 실행
                        </button>
                      </div>
                    </div>
                  ) : (
                    // Zero routines: the pane earns its space by teaching what a
                    // routine IS, with one-click starting points.
                    <div className="routine-onboard">
                      <span className="routine-empty-icon" aria-hidden="true">
                        <Icon name="clock" size={20} />
                      </span>
                      <h3>아바타에게 반복 업무를 맡겨 보세요</h3>
                      <p>
                        정해진 시각이 되면 아바타가 스스로 실행하고, 결과를 이 화면에 쌓아 둡니다. 예시를 고르면 내용이 채워진 채로 열려요.
                      </p>
                      <div className="routine-preset-grid">
                        {PRESETS.map((item, index) => (
                          <button key={index} className="routine-preset" type="button" onClick={() => openModal(null, item.preset)}>
                            <span className="routine-preset-label">{item.label}</span>{" "}
                            <span className="routine-preset-hint">{item.hint}</span>{" "}
                            <span className="routine-preset-body">{item.preset.prompt}</span>
                          </button>
                        ))}
                      </div>
                      <button className="primary small" type="button" onClick={() => openModal(null)}>
                        <Icon name="plus" size={16} />
                        <span>직접 만들기</span>
                      </button>
                    </div>
                  )
                ) : messageLoadError ? (
                  <div className="warn-box" role="alert">
                    예약 작업 결과를 불러오지 못했습니다: {messageLoadError}{" "}
                    <button className="linkish" type="button" disabled={loadBusy} onClick={() => void load()}>
                      다시 시도
                    </button>
                  </div>
                ) : !state.routineMessages.length ? (
                  <div className="routine-empty tall">
                    <span className="routine-empty-icon" aria-hidden="true">
                      <Icon name="activity" size={20} />
                    </span>
                    <h3>아직 실행 기록이 없습니다</h3>
                    <p>예정된 시각이 되면 자동으로 실행됩니다. 지금 바로 확인하고 싶다면 한 번 실행해 보세요.</p>
                    {selectedRoutine ? (
                      <div className="routine-empty-actions">
                        <button
                          className="ghost-sm"
                          type="button"
                          aria-describedby={routineActionStatusId}
                          disabled={busyRoutineId === selectedRoutine.id}
                          onClick={() => void runFromButton(selectedRoutine)}
                        >
                          지금 실행
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  runs.map((_, i) => {
                    const reverseIndex = runs.length - 1 - i;
                    const r = runs[reverseIndex];
                    return (
                      <RoutineRunBlock
                        key={i}
                        run={r}
                        runNumber={reverseIndex + 1}
                        expanded={reverseIndex === runs.length - 1}
                        currentPrompt={currentPrompt}
                        now={now}
                        runBusy={Boolean(selectedRoutine && busyRoutineId === selectedRoutine.id)}
                        onRun={selectedRoutine ? () => void runFromButton(selectedRoutine) : null}
                      />
                    );
                  })
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      <Presence>
        {modalOpen && (
          <RoutineModal
            key="routine-modal"
            routine={modalRoutine}
            preset={modalPreset}
            onClose={closeModal}
            onSaved={onModalSaved}
            onDeleted={onModalDeleted}
            onRunNow={(detail) => void runFromButton(detail.routine)}
          />
        )}
      </Presence>
    </>
  );
}
