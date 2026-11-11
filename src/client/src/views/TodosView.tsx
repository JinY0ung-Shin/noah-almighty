// 할 일 tab: the detailed home of the viewer's work to-do list. Left = the add
// form, status chips, search and the grouped list; right = the selected item's
// editor. It deliberately reuses the 예약 작업 view's workspace/pane/chip/search/
// group classes (50-platform-views.css) — the same work-list language and the
// same ≤980px stacking from ONE stylesheet — and scopes only the to-do rows,
// forms and chips (TodosView.css). The data is the shared `appState.todos` slice
// (lib/todos.ts), which the chat overlay and the rail badge read too.
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import Icon from "../components/Icon";
import { openSeededChat, selectConversation } from "../lib/chat";
import { confirmAction } from "../lib/confirm";
import { relativeDayTimeLabel } from "../lib/format";
import { cx, useAppState, useLatest } from "../lib/hooks";
import { scrollToStart } from "../lib/motion";
import { goView, syncHash } from "../lib/nav";
import { notify, readState, updateState } from "../lib/state";
import {
  TODO_FILTERS,
  TODO_PRIORITY_LABELS,
  TODO_STATUS_LABELS,
  clearCompletedTodos,
  clearDroppedTodos,
  closeTodoWithUndo,
  createTodo,
  deleteTodo,
  dueDateText,
  dueLabel,
  isPendingTodo,
  isTodoFilter,
  loadTodos,
  matchesTodoFilter,
  matchesTodoQuery,
  parseTagInput,
  setTodoStatus,
  todoFilterCounts,
  todoListGroups,
  todoSeedText,
  todoSourceTitle,
  updateTodo,
  type TodoChanges,
} from "../lib/todos";
import type { TodoFilter, TodoItem, TodoPriority, TodoStatus } from "../lib/types";
import {
  MAX_LISTED_CLOSED_TODOS,
  MAX_TODO_NOTE_LENGTH,
  MAX_TODO_TITLE_LENGTH,
  TODO_PRIORITIES,
  TODO_STATUSES,
  isOpenTodo,
  todoDueBucket,
} from "../../../shared/todos";
import "./TodosView.css";

/** The empty list's heading for a filter with nothing in it. */
const EMPTY_FILTER_TITLES: Record<TodoFilter, string> = {
  today: "오늘 할 일이 없습니다",
  upcoming: "예정된 할 일이 없습니다",
  overdue: "마감 지난 할 일이 없습니다",
  in_progress: "진행 중인 할 일이 없습니다",
  all: "열린 할 일이 없습니다",
  done: "완료한 할 일이 없습니다",
  dropped: "드랍한 할 일이 없습니다",
};

interface FormValues {
  title: string;
  note: string;
  due: string;
  priority: TodoPriority;
  tags: string;
}

/** The add form's fields. */
type NewItem = Omit<FormValues, "note">;
const EMPTY_NEW_ITEM: NewItem = { title: "", due: "", priority: "normal", tags: "" };

/**
 * Editor state, loaded from the selected item. A remote change (poll, avatar)
 * reloads it only while nothing is typed, so a refresh never eats an edit.
 */
interface EditorForm {
  forId: string;
  values: FormValues;
  // What the form was loaded from. save() sends only the fields the user changed
  // relative to THIS — never relative to the live item, or a field the avatar
  // (or another tab) changed meanwhile would be written back with the stale
  // form value.
  base: FormValues;
  dirty: boolean;
}

const EMPTY_VALUES: FormValues = { title: "", note: "", due: "", priority: "normal", tags: "" };
const EMPTY_FORM: EditorForm = { forId: "", values: EMPTY_VALUES, base: EMPTY_VALUES, dirty: false };

function formFromItem(item: TodoItem): FormValues {
  return { title: item.title, note: item.note, due: item.dueDate ?? "", priority: item.priority, tags: item.tags.join(", ") };
}

function sameForm(a: FormValues, b: FormValues): boolean {
  return a.title === b.title && a.note === b.note && a.due === b.due && a.priority === b.priority && a.tags === b.tags;
}

/** The form for `item`: untouched while the user's edits to that item are unsaved, else (re)loaded from it. */
function syncForm(form: EditorForm, item: TodoItem | null): EditorForm {
  if (!item) return form.forId === "" && !form.dirty ? form : { ...form, forId: "", dirty: false };
  if (item.id === form.forId && form.dirty) return form;
  const base = formFromItem(item);
  // Same content: keep the object, so syncing on every render settles.
  if (item.id === form.forId && sameForm(base, form.base) && sameForm(base, form.values)) return form;
  return { forId: item.id, values: base, base, dirty: false };
}

/** The item the editor shows right now (read from the store, for code that runs after an await). */
function selectedNow(): TodoItem | null {
  const state = readState();
  return state.todos.items.find((item) => item.id === state.todoSelectedId) ?? null;
}

/** The editor's stamp: when it was closed (완료/드랍), else when it was added. */
function detailStamp(item: TodoItem): string {
  if (item.status === "done" && item.closedAt) return `완료 ${relativeDayTimeLabel(item.closedAt)}`;
  if (item.status === "dropped" && item.closedAt) return `드랍 ${relativeDayTimeLabel(item.closedAt)}`;
  return `추가 ${relativeDayTimeLabel(item.createdAt)}`;
}

function setFilter(id: TodoFilter) {
  updateState((state) => {
    state.todoFilter = id;
  });
}

// Roving tabindex over the chips, mirroring the 예약 작업 filters.
function onFilterKeydown(event: KeyboardEvent, currentId: TodoFilter): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = TODO_FILTERS.findIndex((filter) => filter.id === currentId);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? TODO_FILTERS.length - 1
        : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + TODO_FILTERS.length) %
          TODO_FILTERS.length;
  const next = TODO_FILTERS[nextIndex].id;
  setFilter(next);
  requestAnimationFrame(() => document.getElementById(`todo-filter-${next}`)?.focus());
}

function clearSearch() {
  updateState((state) => {
    state.todoSearch = "";
  });
}

// A row's checkbox: checking completes any item that is not done (an
// in-progress or dropped one too); unchecking a done one reopens it as 시작 전.
function toggle(item: TodoItem, checked: boolean) {
  if (checked) void closeTodoWithUndo(item, "done");
  else void setTodoStatus(item.id, "todo");
}

async function clearDone() {
  const total = readState().todos.counts.done;
  if (!total) return;
  const confirmed = await confirmAction(`완료한 할 일 ${total}개를 모두 삭제할까요? 되돌릴 수 없습니다.`, {
    title: "완료 항목을 비울까요?",
    confirmLabel: "비우기",
    tone: "danger",
  });
  if (!confirmed) return;
  const removed = await clearCompletedTodos();
  if (removed !== null) notify(`완료 항목 ${removed}개를 비웠습니다.`, "ok");
}

async function clearDropped() {
  const total = readState().todos.counts.dropped;
  if (!total) return;
  const confirmed = await confirmAction(`드랍한 할 일 ${total}개를 모두 삭제할까요? 되돌릴 수 없습니다.`, {
    title: "드랍 항목을 비울까요?",
    confirmLabel: "비우기",
    tone: "danger",
  });
  if (!confirmed) return;
  const removed = await clearDroppedTodos();
  if (removed !== null) notify(`드랍 항목 ${removed}개를 비웠습니다.`, "ok");
}

export default function TodosView() {
  const state = useAppState();

  // Each flag is shown in the markup AND guards a re-entry of its async action,
  // so it is state for the render and a ref for the guard.
  const [loading, setLoadingState] = useState(false);
  const loadingRef = useRef(false);
  const [loadError, setLoadError] = useState("");
  const detailEl = useRef<HTMLElement | null>(null);
  const listEl = useRef<HTMLDivElement | null>(null);

  // Add form.
  const [newItem, setNewItemState] = useState<NewItem>(EMPTY_NEW_ITEM);
  const newItemRef = useRef(newItem);
  const newTitleEl = useRef<HTMLInputElement | null>(null);
  function setNewItem(next: NewItem) {
    newItemRef.current = next;
    setNewItemState(next);
  }

  // The editor's form lives in a ref (with a re-render on every change): code
  // that continues after an await reads and writes the latest form whatever
  // React has rendered since.
  const formRef = useRef<EditorForm>(EMPTY_FORM);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [saving, setSavingState] = useState(false);
  const savingRef = useRef(false);
  const [delegating, setDelegatingState] = useState(false);
  const delegatingRef = useRef(false);
  const [openingSource, setOpeningSourceState] = useState(false);
  const openingSourceRef = useRef(false);
  // The item whose status write (the detail panel's 상태 control) is in flight:
  // a further pick waits for it, so two PATCHes for one item never race (an
  // earlier answer would briefly put the older status back).
  const [statusSavingId, setStatusSavingIdState] = useState("");
  const statusSavingIdRef = useRef("");
  // The 상태 button Tab lands on (roving tabindex): the item's status, until the
  // arrow keys move focus elsewhere in the group.
  const [statusFocusState, setStatusFocus] = useState<TodoStatus>("todo");
  const [statusFocusFor, setStatusFocusFor] = useState("");

  function setLoading(next: boolean) {
    loadingRef.current = next;
    setLoadingState(next);
  }
  function setSaving(next: boolean) {
    savingRef.current = next;
    setSavingState(next);
  }
  function setDelegating(next: boolean) {
    delegatingRef.current = next;
    setDelegatingState(next);
  }
  function setOpeningSource(next: boolean) {
    openingSourceRef.current = next;
    setOpeningSourceState(next);
  }
  function setStatusSavingId(next: string) {
    statusSavingIdRef.current = next;
    setStatusSavingIdState(next);
  }

  async function load() {
    if (loadingRef.current) return;
    setLoading(true);
    setLoadError("");
    try {
      await loadTodos();
    } catch (err) {
      setLoadError((err as Error).message || "네트워크 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const todos = state.todos;
  const items = todos.items;
  const todayKst = todos.todayKst;
  const counts = todos.counts;
  const filterId = (isTodoFilter(state.todoFilter) ? state.todoFilter : "all") as TodoFilter;
  const query = state.todoSearch;
  const filterCounts = todoFilterCounts(items, counts, todayKst);
  const filtered = items.filter((item) => matchesTodoFilter(item, filterId, todayKst) && matchesTodoQuery(item, query));
  // Open filters: 진행 중 first, then the due buckets (the order the shared sort
  // already gives); 완료 and 드랍 are one newest-first group each.
  const groups = todoListGroups(filtered, filterId, todayKst);
  const listedDone = items.filter((item) => item.status === "done").length;
  const listedDropped = items.filter((item) => item.status === "dropped").length;
  const selected = items.find((item) => item.id === state.todoSelectedId) ?? null;
  const headerSummary = !todos.loaded
    ? "업무 할 일을 모아 두고 마감과 우선순위로 관리하세요"
    : `열린 할 일 ${counts.open}개${counts.inProgress ? ` · 진행 중 ${counts.inProgress}개` : ""} · 오늘 마감 ${counts.dueToday}개`;
  const countLabel = query.trim() ? `${filtered.length}개 찾음` : `${filtered.length}개`;
  const emptyList = counts.open === 0 && counts.done === 0 && counts.dropped === 0 && !items.length;

  // The form follows the selected item on every render (the original re-ran this
  // on every store write): reloaded from it unless the user's edits are unsaved.
  formRef.current = syncForm(formRef.current, selected);
  const form = formRef.current;
  function setForm(update: (form: EditorForm) => EditorForm) {
    formRef.current = update(formRef.current);
    rerender();
  }
  const dirty = form.dirty;

  // Another item, or a new status (applied here, or by the avatar): Tab lands on
  // the status the item has now.
  const statusFocusKey = selected ? `${selected.id}:${selected.status}` : "";
  let statusFocus = statusFocusState;
  if (statusFocusKey !== statusFocusFor) {
    setStatusFocusFor(statusFocusKey);
    if (selected) {
      statusFocus = selected.status;
      setStatusFocus(selected.status);
    }
  }

  const filteredRef = useLatest(filtered);

  function editValue(change: Partial<FormValues>) {
    setForm((current) => ({ ...current, values: { ...current.values, ...change }, dirty: true }));
  }

  function markDirty() {
    setForm((current) => (current.dirty ? current : { ...current, dirty: true }));
  }

  // The date field's native `change` (a commit without a preceding `input`) only
  // marks the form dirty, as before; React's onChange is the `input` event.
  const dueInputRef = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    const onChange = () => markDirty();
    node.addEventListener("change", onChange);
    return () => node.removeEventListener("change", onChange);
    // markDirty only touches refs and setters, so the first one stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    const current = newItemRef.current;
    const title = current.title.trim();
    if (!title) {
      newTitleEl.current?.focus();
      return;
    }
    // Clear first so the next item can be typed right away; a failure puts the
    // text back (createTodo already toasts why).
    const draft = { title, priority: current.priority, dueDate: current.due || null, tags: parseTagInput(current.tags) };
    setNewItem(EMPTY_NEW_ITEM);
    const created = await createTodo(draft);
    if (!created && !newItemRef.current.title) {
      setNewItem({ title: draft.title, due: draft.dueDate ?? "", priority: draft.priority, tags: draft.tags.join(", ") });
    }
    // The add box is always mounted, so focusing it waits for no re-render.
    newTitleEl.current?.focus();
  }

  // The editor's 상태 control applies at once — on a click, Enter or Space (the
  // buttons' own activation) — outside the form's dirty/save cycle, like the
  // checkbox it replaced. Closing (완료/드랍) offers 되돌리기.
  async function chooseStatus(item: TodoItem, status: TodoStatus) {
    if (statusSavingIdRef.current === item.id || item.status === status || isPendingTodo(item)) return;
    setStatusSavingId(item.id);
    try {
      if (status === "done" || status === "dropped") await closeTodoWithUndo(item, status);
      else await setTodoStatus(item.id, status);
    } finally {
      if (statusSavingIdRef.current === item.id) setStatusSavingId("");
    }
  }

  // Manual activation over a roving tabindex: arrows and Home/End only MOVE
  // focus among the 상태 buttons — passing over a status never writes it, toasts
  // or re-sorts the list, so 시작 전 → 드랍 is one write. Applying is the focused
  // button's own click / Enter / Space.
  function onStatusKeydown(event: KeyboardEvent, from: TodoStatus): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = TODO_STATUSES.indexOf(from);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TODO_STATUSES.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + TODO_STATUSES.length) %
            TODO_STATUSES.length;
    const next = TODO_STATUSES[nextIndex];
    setStatusFocus(next);
    document.getElementById(`todo-status-${next}`)?.focus();
  }

  // Stacked (narrow) layout puts the editor below the list; reveal it so a
  // selection does not read as "nothing happened".
  function revealDetailWhenStacked(): void {
    if (typeof window === "undefined" || !detailEl.current) return;
    if (!window.matchMedia?.("(max-width: 980px)").matches) return;
    scrollToStart(detailEl.current);
  }

  async function select(item: TodoItem) {
    if (isPendingTodo(item) || item.id === readState().todoSelectedId) return;
    if (
      formRef.current.dirty &&
      !(await confirmAction("저장하지 않은 변경 사항이 있습니다. 버리고 다른 할 일을 열까요?", {
        title: "변경 사항을 버릴까요?",
        confirmLabel: "버리기",
        tone: "danger",
      }))
    )
      return;
    setForm((current) => ({ ...current, dirty: false }));
    updateState((draft) => {
      draft.todoSelectedId = item.id;
    });
    syncHash(true);
    // The editor shows the new item before it is measured and scrolled to.
    flushSync(() => {});
    revealDetailWhenStacked();
  }

  async function save() {
    const item = selectedNow();
    if (!item || savingRef.current) return;
    const { values, base } = formRef.current;
    const title = values.title.replace(/\s+/g, " ").trim();
    if (!title) {
      notify("할 일 제목을 입력해 주세요.");
      return;
    }
    const changes: TodoChanges = {};
    if (title !== base.title.replace(/\s+/g, " ").trim()) changes.title = title;
    const note = values.note.trim();
    if (note !== base.note.trim()) changes.note = note;
    const dueDate = values.due || null;
    if (dueDate !== (base.due || null)) changes.dueDate = dueDate;
    if (values.priority !== base.priority) changes.priority = values.priority;
    const tags = parseTagInput(values.tags);
    if (tags.join("\n") !== parseTagInput(base.tags).join("\n")) changes.tags = tags;
    if (!Object.keys(changes).length) {
      setForm((current) => syncForm({ ...current, dirty: false }, selectedNow()));
      return;
    }
    // What was sent: typing that continues while the PATCH is in flight must
    // survive its answer.
    const sent = values;
    setSaving(true);
    const saved = await updateTodo(item.id, changes);
    setSaving(false);
    if (!saved) return;
    // The editor moved on (버리기 → another item) while this PATCH was in flight:
    // the form now belongs to THAT item, so its base and dirty flag stay its own.
    if (formRef.current.forId !== item.id) {
      notify("할 일을 저장했습니다.", "ok");
      return;
    }
    if (sameForm(formRef.current.values, sent)) {
      setForm((current) => syncForm({ ...current, dirty: false }, selectedNow()));
    } else {
      // Newer edits are still in the form: keep them (and the dirty flag), and
      // diff the next save against what the server now has.
      setForm((current) => ({ ...current, base: formFromItem(saved) }));
    }
    notify("할 일을 저장했습니다.", "ok");
  }

  function clearDue() {
    editValue({ due: "" });
  }

  async function delegate() {
    const item = selectedNow();
    if (!item || delegatingRef.current) return;
    setDelegating(true);
    try {
      await openSeededChat(todoSeedText(item), "할 일 내용을 입력창에 넣었습니다. 검토 후 보내기를 누르세요.");
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setDelegating(false);
    }
  }

  async function openSource() {
    const item = selectedNow();
    if (!item?.sourceConversationId || openingSourceRef.current) return;
    setOpeningSource(true);
    try {
      if (item.source === "routine") goView("routines", item.sourceConversationId);
      else {
        goView("chat");
        await selectConversation(item.sourceConversationId);
      }
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setOpeningSource(false);
    }
  }

  async function remove(item: TodoItem) {
    const confirmed = await confirmAction(`“${item.title}” 할 일을 삭제할까요? 되돌릴 수 없습니다.`, {
      title: "할 일을 삭제할까요?",
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (!confirmed) return;
    // Where the row sat, so focus can land on its neighbour once it is gone.
    const index = filteredRef.current.findIndex((entry) => entry.id === item.id);
    if (await deleteTodo(item.id)) {
      syncHash(true);
      notify("할 일을 삭제했습니다.", "ok");
      // The list without the row is in the DOM before the neighbour is looked up.
      flushSync(() => {});
      const list = listEl.current;
      const rows = list ? Array.from(list.querySelectorAll<HTMLButtonElement>(".todo-row-main:not(:disabled)")) : [];
      (rows[Math.min(Math.max(index, 0), rows.length - 1)] ?? newTitleEl.current)?.focus();
    }
  }

  function onAddSubmit(event: FormEvent) {
    event.preventDefault();
    void add();
  }

  function onSaveSubmit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  return (
    <>
      <header className="view-header cmp-todos-view">
        <div className="title">
          <h1>할 일</h1>
          <p>
            {headerSummary}
            {todos.loaded && counts.overdue ? <span className="todo-head-alert">{` · 마감 지남 ${counts.overdue}개`}</span> : null}
          </p>
        </div>
      </header>

      <div className="view-body routines-body todos-body cmp-todos-view">
        {!todos.loaded && loadError ? (
          <div className="warn-box" role="alert">
            할 일을 불러오지 못했습니다: {loadError}{" "}
            <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : !todos.loaded ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : (
          <div className="routine-workspace todo-workspace">
            {/* ===== Left: add + filter + list ===== */}
            <section className="routine-pane todo-list-pane" aria-label="할 일 목록">
              <form className="todo-add" aria-label="할 일 추가" onSubmit={onAddSubmit}>
                <div className="todo-add-main">
                  <label className="field todo-add-title">
                    <span className="sr-only">새 할 일 제목</span>
                    <input
                      ref={newTitleEl}
                      type="text"
                      placeholder="할 일을 입력하고 Enter"
                      maxLength={MAX_TODO_TITLE_LENGTH}
                      value={newItem.title}
                      onChange={(event) => setNewItem({ ...newItemRef.current, title: event.currentTarget.value })}
                    />
                  </label>
                  <button className="primary small todo-add-btn" type="submit" disabled={!newItem.title.trim()}>
                    <Icon name="plus" size={16} />
                    <span>추가</span>
                  </button>
                </div>
                <div className="todo-add-extra">
                  <label className="field">
                    <span>마감일 (선택)</span>
                    <input
                      type="date"
                      value={newItem.due}
                      onChange={(event) => setNewItem({ ...newItemRef.current, due: event.currentTarget.value })}
                    />
                  </label>
                  <label className="field">
                    <span>우선순위</span>
                    <select
                      value={newItem.priority}
                      onChange={(event) => setNewItem({ ...newItemRef.current, priority: event.currentTarget.value as TodoPriority })}
                    >
                      {TODO_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {TODO_PRIORITY_LABELS[priority]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>태그 (선택)</span>
                    <input
                      type="text"
                      placeholder="쉼표로 구분"
                      value={newItem.tags}
                      onChange={(event) => setNewItem({ ...newItemRef.current, tags: event.currentTarget.value })}
                    />
                  </label>
                </div>
              </form>

              <div className="routine-side-tools">
                <div className="routine-search-row">
                  <span className="routine-search-wrap">
                    <input
                      className="routine-search"
                      type="search"
                      placeholder="제목·메모·태그 검색"
                      aria-label="할 일 검색"
                      value={state.todoSearch}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        updateState((draft) => {
                          draft.todoSearch = value;
                        });
                      }}
                    />
                  </span>
                  <span className="routine-count muted nowrap">{countLabel}</span>
                </div>
                {/* Each chip spells its own aria-label: the count is an inline span the
                    accname algorithm would glue on as "완료1". Named 필터, not 상태: the
                    editor's 상태 control is the item's own status. */}
                <div className="routine-filter-chips" role="radiogroup" aria-label="할 일 필터">
                  {TODO_FILTERS.map((filter) => {
                    const active = filterId === filter.id;
                    const count = filterCounts[filter.id];
                    return (
                      <button
                        key={filter.id}
                        id={`todo-filter-${filter.id}`}
                        className={cx("routine-chip", active && "active", filter.id === "overdue" && count > 0 && "danger")}
                        type="button"
                        role="radio"
                        aria-checked={active ? "true" : "false"}
                        aria-label={`${filter.label} ${count}`}
                        tabIndex={active ? 0 : -1}
                        onClick={() => setFilter(filter.id)}
                        onKeyDown={(event) => onFilterKeydown(event, filter.id)}
                      >
                        {filter.label}
                        <span className="routine-chip-n">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="routine-manage-list todo-manage-list scroll-thin" ref={listEl}>
                {emptyList && !query.trim() ? (
                  <div className="routine-empty tall">
                    <span className="routine-empty-icon" aria-hidden="true">
                      <Icon name="check-square" size={20} />
                    </span>
                    <h3>아직 할 일이 없습니다</h3>
                    <p>
                      위 입력창에 적어 두거나, 대화에서 아바타에게 “할 일에 넣어줘”라고 부탁해 보세요. 내 아바타와의 대화에서는 /todo로도 추가할 수
                      있어요.
                    </p>
                  </div>
                ) : !filtered.length ? (
                  <div className="routine-empty tall">
                    <h3>{query.trim() ? "검색 결과가 없습니다" : EMPTY_FILTER_TITLES[filterId]}</h3>
                    <p>{query.trim() ? `“${query.trim()}”에 맞는 할 일을 찾지 못했습니다.` : "다른 필터를 골라 보세요."}</p>
                    <div className="routine-empty-actions">
                      {query.trim() ? (
                        <button className="ghost-sm" type="button" onClick={clearSearch}>
                          검색어 지우기
                        </button>
                      ) : null}
                      {filterId !== "all" ? (
                        <button className="ghost-sm" type="button" onClick={() => setFilter("all")}>
                          전체 보기
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <>
                    {groups.map((group) => (
                      <div className="routine-group" key={group.id}>
                        <div className="routine-group-head static">
                          <span>{group.label}</span>
                          <span className="routine-group-n">{group.items.length}</span>
                        </div>
                        <ul className="routine-group-items todo-items">
                          {group.items.map((item) => {
                            const bucket = todoDueBucket(item.dueDate, todayKst);
                            const open = isOpenTodo(item);
                            const active = state.todoSelectedId === item.id;
                            const pending = isPendingTodo(item);
                            return (
                              <li
                                key={item.id}
                                className={cx(
                                  "todo-row",
                                  active && "active",
                                  item.status === "done" && "done",
                                  item.status === "dropped" && "dropped",
                                  open && bucket === "overdue" && "overdue",
                                )}
                                aria-busy={pending ? "true" : undefined}
                              >
                                {/* The label is only the touch-sized hit area; the name is the checkbox's own. */}
                                <label className="todo-check-hit">
                                  <input
                                    className="todo-check"
                                    type="checkbox"
                                    checked={item.status === "done"}
                                    disabled={pending}
                                    aria-label={item.status === "done" ? `완료 취소: ${item.title}` : `완료: ${item.title}`}
                                    onChange={(event) => toggle(item, event.currentTarget.checked)}
                                  />
                                </label>
                                {/* Named by its visible content (title, then due/priority/tags),
                                    so a screen reader hears the same row a sighted user scans. */}
                                <button
                                  className="todo-row-main"
                                  type="button"
                                  disabled={pending}
                                  aria-current={active ? "true" : undefined}
                                  onClick={() => void select(item)}
                                >
                                  <span className="todo-row-title">{item.title}</span>{" "}
                                  {item.status === "in_progress" ||
                                  item.dueDate ||
                                  item.priority !== "normal" ||
                                  item.tags.length ||
                                  item.source !== "user" ||
                                  item.note ? (
                                    <span className="todo-row-meta">
                                      {item.status === "in_progress" ? (
                                        <span className="tag todo-status" data-status="in_progress">
                                          {TODO_STATUS_LABELS.in_progress}
                                        </span>
                                      ) : null}{" "}
                                      {item.dueDate ? (
                                        <span
                                          className="tag todo-due"
                                          data-bucket={open ? bucket : "closed"}
                                          title={dueDateText(item.dueDate, todayKst)}
                                        >
                                          {dueLabel(item.dueDate, todayKst)}
                                        </span>
                                      ) : null}{" "}
                                      {item.priority !== "normal" ? (
                                        <span className="tag todo-priority" data-priority={item.priority}>
                                          {`우선순위 ${TODO_PRIORITY_LABELS[item.priority]}`}
                                        </span>
                                      ) : null}{" "}
                                      {item.tags.map((tag) => (
                                        <span className="tag" key={tag}>
                                          {`#${tag}`}
                                        </span>
                                      ))}{" "}
                                      {item.source !== "user" ? (
                                        <span className="tag accent" title={todoSourceTitle(item.source)}>
                                          아바타
                                        </span>
                                      ) : null}{" "}
                                      {item.note ? (
                                        <span className="todo-row-note" title="메모 있음">
                                          <Icon name="file" size={12} />
                                        </span>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                    {filterId === "done" && counts.done > listedDone ? (
                      <p className="muted todo-done-note">최근 완료한 {MAX_LISTED_CLOSED_TODOS}개만 표시합니다.</p>
                    ) : filterId === "dropped" && counts.dropped > listedDropped ? (
                      <p className="muted todo-done-note">최근 드랍한 {MAX_LISTED_CLOSED_TODOS}개만 표시합니다.</p>
                    ) : null}
                  </>
                )}
              </div>

              {filterId === "done" && counts.done > 0 ? (
                <div className="todo-list-foot">
                  <button className="ghost-sm danger" type="button" onClick={() => void clearDone()}>
                    완료 항목 비우기
                  </button>
                </div>
              ) : filterId === "dropped" && counts.dropped > 0 ? (
                <div className="todo-list-foot">
                  <button className="ghost-sm danger" type="button" onClick={() => void clearDropped()}>
                    드랍 항목 비우기
                  </button>
                </div>
              ) : null}
            </section>

            {/* ===== Right: editor ===== */}
            <section
              className={cx("routine-pane todo-detail-pane", !selected && "is-empty")}
              aria-label="할 일 상세"
              ref={detailEl}
            >
              {selected ? (
                <form className="todo-detail" aria-label="할 일 편집" onSubmit={onSaveSubmit}>
                  <div className="todo-detail-head">
                    {/* Applies at once (chooseStatus), never through 저장. A group of
                        pressed-state buttons, not a radiogroup: moving focus never
                        selects (manual activation), so the semantics say so. */}
                    <div className="field todo-detail-status">
                      <span id="todo-status-label">상태</span>
                      <div
                        className="seg-control todo-status-control"
                        role="group"
                        aria-labelledby="todo-status-label"
                        aria-busy={statusSavingId === selected.id ? "true" : undefined}
                      >
                        {TODO_STATUSES.map((status) => {
                          const current = selected.status === status;
                          return (
                            <button
                              key={status}
                              id={`todo-status-${status}`}
                              className={cx("seg-btn", current && "active")}
                              type="button"
                              aria-pressed={current ? "true" : "false"}
                              tabIndex={statusFocus === status ? 0 : -1}
                              onClick={() => void chooseStatus(selected, status)}
                              onKeyDown={(event) => onStatusKeydown(event, status)}
                            >
                              {TODO_STATUS_LABELS[status]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <span className="muted todo-detail-stamp">{detailStamp(selected)}</span>
                  </div>
                  <label className="field">
                    <span>제목</span>
                    <input
                      type="text"
                      maxLength={MAX_TODO_TITLE_LENGTH}
                      value={form.values.title}
                      onChange={(event) => editValue({ title: event.currentTarget.value })}
                    />
                  </label>
                  <label className="field">
                    <span>메모</span>
                    <textarea
                      className="todo-note-input"
                      rows={6}
                      maxLength={MAX_TODO_NOTE_LENGTH}
                      placeholder="자세한 내용, 링크, 진행 상황"
                      value={form.values.note}
                      onChange={(event) => editValue({ note: event.currentTarget.value })}
                    />
                  </label>
                  <div className="todo-detail-grid">
                    <div className="todo-detail-due">
                      <label className="field">
                        <span>마감일</span>
                        <input
                          ref={dueInputRef}
                          type="date"
                          value={form.values.due}
                          onChange={(event) => editValue({ due: event.currentTarget.value })}
                        />
                      </label>
                      {form.values.due ? (
                        <button className="linkish small" type="button" onClick={clearDue}>
                          마감 없음
                        </button>
                      ) : null}
                    </div>
                    <label className="field">
                      <span>우선순위</span>
                      <select
                        value={form.values.priority}
                        onChange={(event) => editValue({ priority: event.currentTarget.value as TodoPriority })}
                      >
                        {TODO_PRIORITIES.map((priority) => (
                          <option key={priority} value={priority}>
                            {TODO_PRIORITY_LABELS[priority]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    <span>태그</span>
                    <input
                      type="text"
                      placeholder="쉼표로 구분 (최대 5개)"
                      value={form.values.tags}
                      onChange={(event) => editValue({ tags: event.currentTarget.value })}
                    />
                  </label>
                  <div className="todo-detail-actions">
                    <button className="primary small" type="submit" disabled={!dirty || saving}>
                      {saving ? "저장 중…" : "저장"}
                    </button>
                    <button className="ghost-sm" type="button" disabled={delegating} onClick={() => void delegate()}>
                      아바타에게 맡기기
                    </button>
                    {selected.sourceConversationId ? (
                      <button className="ghost-sm" type="button" disabled={openingSource} onClick={() => void openSource()}>
                        출처 대화 열기
                      </button>
                    ) : null}
                    <button className="ghost-sm danger" type="button" onClick={() => void remove(selected)}>
                      삭제
                    </button>
                  </div>
                  {selected.source !== "user" ? <p className="muted todo-detail-source">{todoSourceTitle(selected.source)}</p> : null}
                </form>
              ) : (
                <div className="routine-empty tall">
                  <span className="routine-empty-icon" aria-hidden="true">
                    <Icon name="check-square" size={20} />
                  </span>
                  <h3>할 일을 골라 보세요</h3>
                  <p>목록에서 할 일을 고르면 메모·마감일·우선순위를 고치거나 아바타에게 맡길 수 있어요.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
