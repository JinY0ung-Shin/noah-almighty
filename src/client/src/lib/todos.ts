// Client side of the 할 일 list (`src/shared/todos.ts` is the contract). ONE store
// slice (`appState.todos`) feeds the 할 일 tab, the chat overlay and the rail
// badge, so a change made in any of them shows in the others at once.
//
// Every write is optimistic: the list changes first, the request follows, and a
// failure puts the previous item back (plus a resync GET) with a Korean toast.
// Every response's {todayKst, counts} then replaces the snapshot, so the counts
// and the overdue/today buckets always come from the server's KST clock.

import { writable } from "svelte/store";
import { ApiError, api } from "./api";
import { persistTodoOverlayOpen } from "./layout";
import { goView } from "./nav";
import { newId, notify, readState, updateState } from "./state";
import type { TodoFilter, TodoState } from "./types";
import { calendarDateWeekday } from "../../../server/routineSchedule";
import {
  TODO_TOOL_PREFIX,
  compareTodos,
  isTodoToolName,
  todoDueBucket,
  type TodoCounts,
  type TodoItem,
  type TodoListResponse,
  type TodoPriority,
  type TodoSnapshot,
  type TodoSource,
} from "../../../shared/todos";

export function emptyTodoState(): TodoState {
  return { items: [], todayKst: "", counts: { open: 0, overdue: 0, dueToday: 0, done: 0 }, loaded: false };
}

/* ---------- labels ---------- */

export const TODO_PRIORITY_LABELS: Record<TodoPriority, string> = { high: "높음", normal: "보통", low: "낮음" };

const SOURCE_TITLES: Record<TodoSource, string> = {
  user: "직접 추가한 할 일",
  avatar: "아바타가 대화에서 추가한 할 일",
  routine: "예약 작업 실행 중 아바타가 추가한 할 일",
  api: "외부 작업 API 실행 중 아바타가 추가한 할 일",
};

export function todoSourceTitle(source: TodoSource): string {
  return SOURCE_TITLES[source] ?? SOURCE_TITLES.user;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function dayNumber(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000 : null;
}

/** "2026-10-12" → "10월 12일 (월)" (with the year when it differs from today's). */
export function dueDateText(dueDate: string, todayKst = ""): string {
  const [year, month, day] = dueDate.split("-");
  const weekday = calendarDateWeekday(dueDate);
  const base = `${Number(month)}월 ${Number(day)}일${weekday === null ? "" : ` (${WEEKDAYS[weekday]})`}`;
  return todayKst && !todayKst.startsWith(`${year}-`) ? `${year}년 ${base}` : base;
}

/** The due chip: 오늘 / 내일 / N일 지남, else the date itself. Measured against the server's KST today. */
export function dueLabel(dueDate: string, todayKst: string): string {
  const due = dayNumber(dueDate);
  const today = dayNumber(todayKst);
  if (due === null || today === null) return dueDateText(dueDate, todayKst);
  const diff = due - today;
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff < 0) return `${-diff}일 지남`;
  return dueDateText(dueDate, todayKst);
}

/* ---------- filters ---------- */

export const TODO_FILTERS: { id: TodoFilter; label: string }[] = [
  { id: "today", label: "오늘" },
  { id: "upcoming", label: "예정" },
  { id: "overdue", label: "마감 지남" },
  { id: "all", label: "전체" },
  { id: "done", label: "완료" },
];

export function isTodoFilter(value: unknown): value is TodoFilter {
  return TODO_FILTERS.some((filter) => filter.id === value);
}

/** 오늘 = overdue + due today, 예정 = future-dated, 전체 = every OPEN item, 완료 = done. */
export function matchesTodoFilter(item: TodoItem, filter: TodoFilter, todayKst: string): boolean {
  if (filter === "done") return item.done;
  if (item.done) return false;
  const bucket = todoDueBucket(item.dueDate, todayKst);
  if (filter === "today") return bucket === "overdue" || bucket === "today";
  if (filter === "upcoming") return bucket === "upcoming";
  if (filter === "overdue") return bucket === "overdue";
  return true;
}

export function matchesTodoQuery(item: TodoItem, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = [item.title, item.note, ...item.tags.map((tag) => `#${tag}`)].join(" ").toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

/**
 * Chip counts. Open-item chips count the list itself (every open item is
 * listed); 완료 uses the server's count, since a listing carries only the newest
 * completed items.
 */
export function todoFilterCounts(items: TodoItem[], counts: TodoCounts, todayKst: string): Record<TodoFilter, number> {
  const out: Record<TodoFilter, number> = { today: 0, upcoming: 0, overdue: 0, all: 0, done: counts.done };
  for (const item of items) {
    if (item.done) continue;
    out.all += 1;
    const bucket = todoDueBucket(item.dueDate, todayKst);
    if (bucket === "overdue") {
      out.overdue += 1;
      out.today += 1;
    } else if (bucket === "today") out.today += 1;
    else if (bucket === "upcoming") out.upcoming += 1;
  }
  return out;
}

/** Tags typed into one text box: comma/space separated, "#" optional, duplicates dropped. */
export function parseTagInput(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,，\s]+/)) {
    const tag = raw.replace(/^#+/, "").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/* ---------- chat overlay ---------- */

/** Items the chat overlay lists at most; the rest sit behind "전체 보기". */
export const TODO_OVERLAY_LIMIT = 8;

/**
 * The narrowest host (`.chat-body`) that pins the card. While pinned, the
 * transcript pads its right side by clamp(24, 2×328 + 800 + 24 − W, 328) — 328 =
 * card 300 + its 16px right offset + a 12px gap, 24 = the transcript's own side
 * padding, 800 = `--transcript-max` (the `:global(.chat-body:has(...))` rule in
 * TodoOverlay.svelte). From W = 1456 up nothing moves; down to 1152 the full
 * 800px column shifts left to clear the card; below that the column narrows to
 * W − 352 with the card 12px beside it — 648px at this threshold, the narrowest
 * a pinned layout gives the conversation. Narrower hosts (split panes, an open
 * side panel, a small window) get the popover instead.
 */
export const TODO_OVERLAY_PINNED_MIN_WIDTH = 1000;

export type TodoOverlayMode = "pinned" | "popover" | "sheet";

/** pinned (wide column, persistent) / popover (narrow column, transient) / sheet (≤860px viewport). */
export function todoOverlayMode(hostWidth: number, narrowViewport: boolean): TodoOverlayMode {
  if (narrowViewport) return "sheet";
  return hostWidth >= TODO_OVERLAY_PINNED_MIN_WIDTH ? "pinned" : "popover";
}

export interface TodoOverlaySection {
  id: "overdue" | "today" | "next";
  label: string;
  items: TodoItem[];
}

/** The overlay's first `limit` OPEN items in the shared order, split into 마감 지남 / 오늘 / 다음. */
export function overlaySections(
  items: TodoItem[],
  todayKst: string,
  limit = TODO_OVERLAY_LIMIT,
): { sections: TodoOverlaySection[]; hidden: number } {
  const open = items.filter((item) => !item.done).sort(compareTodos);
  const shown = open.slice(0, limit);
  const bucketOf = (item: TodoItem) => todoDueBucket(item.dueDate, todayKst);
  const sections: TodoOverlaySection[] = [
    { id: "overdue" as const, label: "마감 지남", items: shown.filter((item) => bucketOf(item) === "overdue") },
    { id: "today" as const, label: "오늘", items: shown.filter((item) => bucketOf(item) === "today") },
    {
      id: "next" as const,
      label: "다음",
      items: shown.filter((item) => bucketOf(item) === "upcoming" || bucketOf(item) === "none"),
    },
  ].filter((section) => section.items.length);
  return { sections, hidden: open.length - shown.length };
}

let overlayFocusRequested = false;

/**
 * The EXPLICIT switch — the composer toggle and the card's close button: turns
 * the per-browser preference on/off (persisted) and clears any transient
 * dismissal. `focus` asks a transient card (popover/sheet) to take focus, so
 * Escape can hand it back to the toggle — set only on an explicit toggle click,
 * never when a persisted "on" re-opens it after a reload.
 */
export function setTodoOverlayOpen(open: boolean, options: { focus?: boolean } = {}): void {
  overlayFocusRequested = open && Boolean(options.focus);
  updateState((state) => {
    state.todoOverlayOpen = open;
    state.todoOverlayDismissed = false;
  });
  persistTodoOverlayOpen(open);
}

/**
 * A TRANSIENT dismissal of the popover/sheet (outside click, Escape, leaving for
 * the 할 일 tab, or a mount whose first measured layout is transient without a
 * toggle click): hides the card for now and keeps the preference, so the layout
 * widening back to pinned — or the toggle — brings it back. Never persisted.
 */
export function dismissTodoOverlay(): void {
  if (readState().todoOverlayDismissed) return;
  updateState((state) => {
    state.todoOverlayDismissed = true;
  });
}

/** Pinned never honours a transient dismissal: the persistent card returns when the column widens again. */
export function restoreTodoOverlay(): void {
  if (!readState().todoOverlayDismissed) return;
  updateState((state) => {
    state.todoOverlayDismissed = false;
  });
}

/** What the composer toggle shows as pressed: switched on AND not transiently dismissed. */
export function todoOverlayVisible(state: { todoOverlayOpen: boolean; todoOverlayDismissed: boolean }): boolean {
  return state.todoOverlayOpen && !state.todoOverlayDismissed;
}

/** One-shot: true once after `setTodoOverlayOpen(true, {focus: true})`. */
export function consumeTodoOverlayFocus(): boolean {
  const requested = overlayFocusRequested;
  overlayFocusRequested = false;
  return requested;
}

/** Open the 할 일 tab with one item selected in its editor. */
export function openTodoInTab(id: string): void {
  goView("todos", id);
}

/** What 아바타에게 맡기기 puts in the composer of a NEW chat with the viewer's own avatar (never auto-sent). */
export function todoSeedText(item: TodoItem): string {
  const meta = [
    item.dueDate ? `마감 ${item.dueDate}` : "",
    item.priority !== "normal" ? `우선순위 ${TODO_PRIORITY_LABELS[item.priority]}` : "",
    item.tags.map((tag) => `#${tag}`).join(" "),
  ].filter(Boolean);
  const lines = ["다음 할 일을 진행해줘.", "", `할 일: ${item.title}`];
  if (meta.length) lines.push(meta.join(" · "));
  if (item.note) lines.push("", item.note);
  lines.push("", `(할 일 ID: ${item.id} — 끝나면 이 할 일을 완료로 표시하거나 메모를 갱신해줘.)`);
  return lines.join("\n");
}

/* ---------- store writes ---------- */

const PENDING_PREFIX = "pending-";

/** An optimistic insert the server has not confirmed yet: it has no real id, so no action may target it. */
export function isPendingTodo(item: TodoItem): boolean {
  return item.id.startsWith(PENDING_PREFIX);
}

// Load/write coordination. Writes bump `writeSeq` when they START and again when
// they SETTLE, and a GET is stale on arrival when `writeSeq` moved during it (a
// write began or settled) OR a write is still in flight when it lands (one that
// began BEFORE it: the server may have answered the GET before applying that
// write). Either way a GET that overlapped any part of a write must not overwrite
// the optimistic list — the write's own response, or the next poll, settles it
// instead. Loads never bump it, and concurrent loads share
// ONE in-flight GET, so two loads can never invalidate each other: when every
// load bumped a shared epoch, the boot refresh and the 할 일 tab's own load
// (a direct #/todos open) re-spawned each other forever. `sessionEpoch` voids a
// GET that outlived its session (logout / expiry).
let writeSeq = 0;
let sessionEpoch = 0;
let inFlightLoad: Promise<void> | null = null;
// A FRESH read was requested while a GET was in flight (an avatar's write just
// landed, a failed write must resync): that GET may predate it, so exactly one
// more read runs behind it instead of the request riding the stale one.
let reloadQueued = false;
// Writes still awaiting their response. A GET that lands while one is in flight
// is dropped as stale; re-reading while writes are still in flight would only be
// dropped again, so the LAST write to settle starts an owed fresh read instead.
let writesInFlight = 0;
let pendingFreshRead = false;
/** GETs one load may chain (stale re-reads + queued fresh reads); the poll covers anything beyond. */
const MAX_LOAD_ROUNDS = 4;
// The avatar's writes, for the card's motion: every successful add/update/delete
// tool end bumps `avatarEndsSeen`, and a load COVERS the ends counted when its GET
// started — applied or failed. While some end is uncovered (and recent), an
// applied load diffs against the slice it replaces and hands the changes to the
// card — so a GET that predates the last end (a poll it joined) keeps the claim
// open for the read queued behind it. Only a GET that STARTED within
// TODO_CLAIM_MAX_AGE_MS of the last end may honour a claim: a slow re-read still
// animates, but once the read that should have shown it failed, a poll a minute
// later never passes someone else's changes off as the avatar's.
let avatarEndsSeen = 0;
let avatarEndsCovered = 0;
let lastAvatarEndAt = 0;
const TODO_CLAIM_MAX_AGE_MS = 5000;
// Read by the card's out: transition when a row STARTS to leave. Deliberately not
// reactive: a removed keyed row only ever sees the params of its last render, so
// a store would still say "not the avatar" at that moment. id → expiry (ms).
const avatarDepartures = new Map<string, number>();
// Open only while the update that applies an avatar's change flushes (Svelte
// flushes in a microtask, each-block animations in the next); closed by a timer,
// and at once by the viewer's own next write — so their edit never glides.
let avatarFlushOpen = false;

/**
 * Call it right before the write's `try`, after the optimistic change: its
 * `finally` must always reach endWrite. A write that never settles would leave
 * `writesInFlight` stuck, and every later GET would be dropped as stale.
 */
function beginWrite(): number {
  avatarFlushOpen = false;
  writeSeq += 1;
  writesInFlight += 1;
  return sessionEpoch;
}

/**
 * Returns true when it started the owed fresh read (so a caller need not request
 * another). A write from a previous session (settling after logout / expiry,
 * which zeroed the counter) no longer counts.
 */
function endWrite(session: number): boolean {
  writeSeq += 1;
  if (session !== sessionEpoch) return false;
  writesInFlight = Math.max(0, writesInFlight - 1);
  if (writesInFlight === 0 && pendingFreshRead) {
    pendingFreshRead = false;
    void refreshTodos({ fresh: true });
    return true;
  }
  return false;
}

/**
 * A read that must start AFTER now (an avatar's tool_end, a failed write's
 * resync). While writes are in flight it would only be dropped as stale, so the
 * last write to settle starts it instead.
 */
function requestFreshRead(): void {
  if (writesInFlight > 0) {
    pendingFreshRead = true;
    return;
  }
  void refreshTodos({ fresh: true });
}

/** A write's response still belongs to the session that sent it (not after logout / session expiry). */
function sameSession(session: number): boolean {
  return session === sessionEpoch && Boolean(readState().user);
}

function mutate(change: (todos: TodoState) => void): void {
  avatarFlushOpen = false;
  updateState((state) => {
    const next: TodoState = { ...state.todos, items: [...state.todos.items] };
    change(next);
    next.items.sort(compareTodos);
    state.todos = next;
  });
}

function applySnapshot(todos: TodoState, snapshot: Partial<TodoSnapshot> | undefined): void {
  if (snapshot?.todayKst) todos.todayKst = snapshot.todayKst;
  if (snapshot?.counts) todos.counts = { ...snapshot.counts };
}

/** Optimistic counts: open-based ones from the list (every open item is listed), done adjusted by delta. */
function recount(todos: TodoState, doneDelta = 0): void {
  let open = 0;
  let overdue = 0;
  let dueToday = 0;
  for (const item of todos.items) {
    if (item.done) continue;
    open += 1;
    const bucket = todoDueBucket(item.dueDate, todos.todayKst);
    if (bucket === "overdue") overdue += 1;
    else if (bucket === "today") dueToday += 1;
  }
  todos.counts = { open, overdue, dueToday, done: Math.max(0, todos.counts.done + doneDelta) };
}

/** The same rows, in the same order, with the same content. */
function sameTodoItems(a: TodoItem[], b: TodoItem[]): boolean {
  return a.length === b.length && a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
}

/** One GET: applied, dropped as stale (a write overlapped it), or void (its session ended). */
async function loadOnce(): Promise<"applied" | "stale" | "void"> {
  const seq = writeSeq;
  const session = sessionEpoch;
  const avatarEndsAtStart = avatarEndsSeen;
  const startedAt = Date.now();
  let body: TodoListResponse;
  try {
    body = await api<TodoListResponse>("/api/me/todos");
  } catch (err) {
    if (sameSession(session)) avatarEndsCovered = Math.max(avatarEndsCovered, avatarEndsAtStart);
    throw err;
  }
  if (!sameSession(session)) return "void";
  if (seq !== writeSeq || writesInFlight > 0) return "stale";
  const previous = readState().todos;
  const fetched = [...(body.todos ?? [])].sort(compareTodos);
  // A re-read that changed nothing (a poll, the queued read after parallel tool
  // calls) keeps the list's identity: views keyed on it must not reconcile —
  // that would cut the card's running glides short mid-motion.
  const items = sameTodoItems(previous.items, fetched) ? previous.items : fetched;
  const avatarClaim = avatarEndsSeen > avatarEndsCovered && startedAt - lastAvatarEndAt <= TODO_CLAIM_MAX_AGE_MS;
  avatarEndsCovered = Math.max(avatarEndsCovered, avatarEndsAtStart);
  // Never on the first load (no list to show the change against). A load that
  // gets this far overlapped none of the viewer's own writes (it would be stale),
  // so an optimistic row of theirs — no server id yet — never reads as the avatar's.
  if (avatarClaim && previous.loaded) noteAvatarChange(diffAvatarChange(previous.items, items));
  updateState((state) => {
    state.todos = {
      items,
      todayKst: body.todayKst ?? "",
      counts: body.counts ? { ...body.counts } : emptyTodoState().counts,
      loaded: true,
    };
  });
  return "applied";
}

export interface TodoLoadOptions {
  /**
   * The read must START after this call — the caller knows the server just
   * changed (an avatar's mcp__todo__* call ended, a write failed). Joining an
   * in-flight GET then queues one more read behind it rather than trusting it.
   */
  fresh?: boolean;
}

/** Load the list; concurrent callers share the one in-flight load (and its rejection). */
export function loadTodos(options: TodoLoadOptions = {}): Promise<void> {
  if (!readState().user) return Promise.resolve();
  if (inFlightLoad) {
    if (options.fresh) reloadQueued = true;
    return inFlightLoad;
  }
  reloadQueued = false;
  let wantFresh = Boolean(options.fresh);
  // Declared before the body runs: its `finally` compares against it.
  let load: Promise<void> | null = null;
  load = (async () => {
    try {
      for (let round = 0; round < MAX_LOAD_ROUNDS; round += 1) {
        const result = await loadOnce();
        if (result === "void") return;
        if (reloadQueued) {
          // A fresh read joined this one: whatever it got may predate the trigger.
          reloadQueued = false;
          wantFresh = true;
        } else if (result === "applied") {
          return;
        } else if (!wantFresh && readState().todos.loaded) {
          // Stale, but nobody needs newer data: the write's own response settles it.
          return;
        }
        // A read is still owed. While writes are in flight it would be dropped
        // again, so the last write to settle starts it (endWrite).
        if (writesInFlight > 0) {
          pendingFreshRead = true;
          return;
        }
      }
    } finally {
      if (inFlightLoad === load) inFlightLoad = null;
    }
  })();
  inFlightLoad = load;
  return load;
}

/** Best-effort reload (polls, live avatar edits): keeps the current list on failure. */
export async function refreshTodos(options: TodoLoadOptions = {}): Promise<void> {
  try {
    await loadTodos(options);
  } catch {
    /* keep what is shown; the next poll retries */
  }
}

export interface TodoDraft {
  title: string;
  note?: string;
  priority?: TodoPriority;
  dueDate?: string | null;
  tags?: string[];
}

export async function createTodo(draft: TodoDraft): Promise<TodoItem | null> {
  const title = draft.title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  const stamp = new Date().toISOString();
  const temp: TodoItem = {
    id: `${PENDING_PREFIX}${newId()}`,
    title,
    note: draft.note?.trim() ?? "",
    done: false,
    priority: draft.priority ?? "normal",
    dueDate: draft.dueDate || null,
    tags: draft.tags ?? [],
    source: "user",
    sourceConversationId: null,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: null,
  };
  mutate((todos) => {
    todos.items.push(temp);
    recount(todos);
  });
  const session = beginWrite();
  try {
    const body = await api<{ todo: TodoItem } & TodoSnapshot>("/api/me/todos", {
      method: "POST",
      body: JSON.stringify({
        title,
        note: temp.note || undefined,
        priority: temp.priority,
        dueDate: temp.dueDate,
        tags: temp.tags,
      }),
    });
    if (!sameSession(session)) return null;
    mutate((todos) => {
      todos.items = todos.items.filter((item) => item.id !== temp.id && item.id !== body.todo.id);
      todos.items.push(body.todo);
      applySnapshot(todos, body);
    });
    return body.todo;
  } catch (err) {
    if (!sameSession(session)) return null;
    mutate((todos) => {
      todos.items = todos.items.filter((item) => item.id !== temp.id);
      recount(todos);
    });
    notify(`할 일을 추가하지 못했습니다: ${(err as Error).message}`);
    return null;
  } finally {
    endWrite(session);
  }
}

export interface TodoChanges {
  title?: string;
  note?: string;
  priority?: TodoPriority;
  /** null clears the due date. */
  dueDate?: string | null;
  tags?: string[];
  done?: boolean;
}

function applyChanges(item: TodoItem, changes: TodoChanges): TodoItem {
  const stamp = new Date().toISOString();
  const next: TodoItem = { ...item, ...changes, updatedAt: stamp };
  if (changes.done !== undefined && changes.done !== item.done) next.completedAt = changes.done ? stamp : null;
  return next;
}

async function writeTodo(id: string, changes: TodoChanges, failure: string): Promise<TodoItem | null> {
  const before = readState().todos.items.find((item) => item.id === id);
  if (!before || isPendingTodo(before)) return null;
  // The viewer's own edit: if this row leaves the card now, it is not the avatar's exit.
  avatarDepartures.delete(id);
  let failed = false;
  const optimistic = applyChanges(before, changes);
  const doneDelta = optimistic.done === before.done ? 0 : optimistic.done ? 1 : -1;
  mutate((todos) => {
    todos.items = todos.items.map((item) => (item.id === id ? optimistic : item));
    recount(todos, doneDelta);
  });
  const session = beginWrite();
  try {
    const body = await api<{ todo: TodoItem } & TodoSnapshot>(`/api/me/todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    if (!sameSession(session)) return null;
    mutate((todos) => {
      todos.items = todos.items.filter((item) => item.id !== id);
      todos.items.push(body.todo);
      applySnapshot(todos, body);
    });
    return body.todo;
  } catch (err) {
    if (!sameSession(session)) return null;
    const gone = err instanceof ApiError && err.status === 404;
    mutate((todos) => {
      todos.items = gone
        ? todos.items.filter((item) => item.id !== id)
        : todos.items.map((item) => (item.id === id ? before : item));
      recount(todos, -doneDelta);
    });
    notify(gone ? "이미 삭제된 할 일입니다." : `${failure}: ${(err as Error).message}`);
    failed = true;
    return null;
  } finally {
    // The re-read starts only after the write settled, or it would arrive stale;
    // never a second one when endWrite just started the owed read.
    const endedWithRead = endWrite(session);
    if (failed && !endedWithRead) requestFreshRead();
  }
}

export function updateTodo(id: string, changes: TodoChanges): Promise<TodoItem | null> {
  return writeTodo(id, changes, "할 일을 저장하지 못했습니다");
}

export function setTodoDone(id: string, done: boolean): Promise<TodoItem | null> {
  return writeTodo(id, { done }, done ? "할 일을 완료하지 못했습니다" : "완료를 되돌리지 못했습니다");
}

/** Complete with a 되돌리기 toast — the overlay's and the list's checkbox action. */
export async function completeTodoWithUndo(item: TodoItem): Promise<void> {
  const done = await setTodoDone(item.id, true);
  if (!done) return;
  notify(`할 일을 완료했습니다 · ${item.title}`, "ok", {
    actionLabel: "되돌리기",
    action: () => void setTodoDone(item.id, false),
  });
}

export async function deleteTodo(id: string): Promise<boolean> {
  const before = readState().todos.items.find((item) => item.id === id);
  if (!before || isPendingTodo(before)) return false;
  avatarDepartures.delete(id);
  let reread = false;
  mutate((todos) => {
    todos.items = todos.items.filter((item) => item.id !== id);
    recount(todos, before.done ? -1 : 0);
  });
  if (readState().todoSelectedId === id) {
    updateState((state) => {
      state.todoSelectedId = "";
    });
  }
  const session = beginWrite();
  try {
    const body = await api<{ ok: boolean } & TodoSnapshot>(`/api/me/todos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (sameSession(session)) mutate((todos) => applySnapshot(todos, body));
    return true;
  } catch (err) {
    if (!sameSession(session)) return false;
    reread = true;
    if (err instanceof ApiError && err.status === 404) return true;
    mutate((todos) => {
      todos.items.push(before);
      recount(todos, before.done ? 1 : 0);
    });
    notify(`할 일을 삭제하지 못했습니다: ${(err as Error).message}`);
    return false;
  } finally {
    const endedWithRead = endWrite(session);
    if (reread && !endedWithRead) requestFreshRead();
  }
}

/** 완료 항목 비우기 — not optimistic: a bulk delete waits for the server. Returns the removed count. */
export async function clearCompletedTodos(): Promise<number | null> {
  const session = beginWrite();
  try {
    const body = await api<{ removed: number } & TodoSnapshot>("/api/me/todos/completed", { method: "DELETE" });
    if (!sameSession(session)) return null;
    const selected = readState().todos.items.find((item) => item.id === readState().todoSelectedId);
    mutate((todos) => {
      todos.items = todos.items.filter((item) => !item.done);
      applySnapshot(todos, body);
    });
    if (selected?.done) {
      updateState((state) => {
        state.todoSelectedId = "";
      });
    }
    return body.removed;
  } catch (err) {
    if (sameSession(session)) notify(`완료 항목을 비우지 못했습니다: ${(err as Error).message}`);
    return null;
  } finally {
    endWrite(session);
  }
}

/* ---------- live avatar edits ---------- */

// `mcp__todo__*` calls seen in a run stream, toolUseId → tool name. When one ends
// OK the avatar may have changed the list, so it is re-read — the stream itself
// never carries the items. Bounded: an aborted run never sends its tool_end.
const trackedTodoTools = new Map<string, string>();
const MAX_TRACKED_TODO_TOOLS = 64;
/** The one read-only to-do tool: its re-read can show no change of the avatar's. */
const TODO_READ_TOOL = `${TODO_TOOL_PREFIX}list_todos`;

export function noteTodoToolStart(toolUseId: string, name: unknown): void {
  if (!toolUseId || !isTodoToolName(name)) return;
  trackedTodoTools.set(toolUseId, name as string);
  if (trackedTodoTools.size > MAX_TRACKED_TODO_TOOLS) {
    const oldest = trackedTodoTools.keys().next().value;
    if (oldest !== undefined) trackedTodoTools.delete(oldest);
  }
}

export function noteTodoToolEnd(toolUseId: string, ok: boolean): void {
  const name = trackedTodoTools.get(toolUseId);
  if (name === undefined) return;
  trackedTodoTools.delete(toolUseId);
  if (!ok) return;
  if (name !== TODO_READ_TOOL) {
    avatarEndsSeen += 1;
    lastAvatarEndAt = Date.now();
  }
  requestFreshRead();
}

/* ---------- avatar change motion ---------- */

// What the chat card animates: ONLY changes an avatar's own add/update/delete
// made (loadOnce diffs the re-read after its tool end against the slice it
// replaces) — never the first load, a poll, a failed write's resync, a pending
// row's swap or the viewer's own edits. Rows it added rise in with an accent
// wash, rows it edited get the wash, rows it deleted or completed slide out,
// and the composer's count pops.

/** How long one change's motion may play (stagger + rise + the 1.2 s wash fit inside); after it a remount replays nothing. */
export const TODO_ACTIVITY_MS = 1600;
/** Delay between rows one change added, top to bottom; capped at the card's visible rows. */
export const TODO_ARRIVAL_STAGGER_MS = 40;

export interface TodoMark {
  /** `added`: new or reopened — the row rises in; `changed`: edited and still open — the wash only. */
  kind: "added" | "changed";
  /** The change it belongs to (`TodoActivity.seq`). */
  seq: number;
  /** Its stagger delay in ms, fixed when the change landed. */
  delay: number;
}

export interface TodoActivity {
  /** Bumps once per applied avatar change. */
  seq: number;
  /** Rows the avatar just added or edited, by id, until their motion has played. */
  marks: Record<string, TodoMark>;
  /** The composer count's pop: the latest change's seq while it is fresh, else 0. */
  pop: number;
}

export function emptyTodoActivity(): TodoActivity {
  return { seq: 0, marks: {}, pop: 0 };
}

/** Motion state for the chat card and the composer count (never persisted). */
export const todoActivity = writable<TodoActivity>(emptyTodoActivity());

let activitySeq = 0;
const activityTimers = new Set<ReturnType<typeof setTimeout>>();
const beforeAvatarChangeListeners = new Set<() => void>();

/**
 * Run `listener` right BEFORE an avatar's change is applied — the DOM still shows
 * the old list (the card holds its height for the motion). Returns the unsubscribe.
 */
export function onBeforeAvatarChange(listener: () => void): () => void {
  beforeAvatarChangeListeners.add(listener);
  return () => beforeAvatarChangeListeners.delete(listener);
}

export interface TodoListDiff {
  /** New or reopened open items, in the shared display order. */
  added: string[];
  /** Open before and after, but edited. */
  changed: string[];
  /** Open before, now deleted or completed. */
  departed: string[];
}

/**
 * What an avatar's change did to the OPEN list, by id. A brand-new item counts
 * only when the avatar created it (`source`): a GET that applies while a claim is
 * open can also carry a routine's, the task API's or another tab's new rows. A
 * reopened row leaves no such trail, nor does an edit or a removal. An
 * unconfirmed optimistic row never counts: its swap is the viewer's own add.
 */
export function diffAvatarChange(before: TodoItem[], after: TodoItem[]): TodoListDiff {
  const previous = new Map<string, TodoItem>();
  for (const item of before) if (!isPendingTodo(item)) previous.set(item.id, item);
  const next = new Map(after.map((item) => [item.id, item]));
  const diff: TodoListDiff = { added: [], changed: [], departed: [] };
  for (const item of [...after].sort(compareTodos)) {
    if (item.done) continue;
    const old = previous.get(item.id);
    if (!old) {
      if (item.source === "avatar") diff.added.push(item.id);
    } else if (old.done) {
      diff.added.push(item.id);
    } else if (
      old.updatedAt !== item.updatedAt ||
      old.title !== item.title ||
      old.dueDate !== item.dueDate ||
      old.priority !== item.priority
    ) {
      diff.changed.push(item.id);
    }
  }
  for (const old of previous.values()) {
    if (old.done) continue;
    const now = next.get(old.id);
    if (!now || now.done) diff.departed.push(old.id);
  }
  return diff;
}

function noteAvatarChange(diff: TodoListDiff): void {
  if (!diff.added.length && !diff.changed.length && !diff.departed.length) return;
  for (const listener of beforeAvatarChangeListeners) {
    // Motion only: a listener that throws must never keep the server's list out.
    try {
      listener();
    } catch (err) {
      console.warn("[todos] a before-change listener failed; the change applies without it", err);
    }
  }
  const now = Date.now();
  for (const id of diff.departed) avatarDepartures.set(id, now + TODO_ACTIVITY_MS);
  // A row that came back is no longer leaving.
  for (const id of [...diff.added, ...diff.changed]) avatarDepartures.delete(id);
  avatarFlushOpen = true;
  setTimeout(() => {
    avatarFlushOpen = false;
  }, 0);
  const seq = (activitySeq += 1);
  todoActivity.update((activity) => {
    const marks = { ...activity.marks };
    diff.added.forEach((id, index) => {
      marks[id] = { kind: "added", seq, delay: Math.min(index, TODO_OVERLAY_LIMIT - 1) * TODO_ARRIVAL_STAGGER_MS };
    });
    for (const id of diff.changed) marks[id] = { kind: "changed", seq, delay: 0 };
    for (const id of diff.departed) delete marks[id];
    return { seq, marks, pop: seq };
  });
  const timer = setTimeout(() => {
    activityTimers.delete(timer);
    todoActivity.update((activity) => ({
      seq: activity.seq,
      marks: Object.fromEntries(Object.entries(activity.marks).filter(([, mark]) => mark.seq !== seq)),
      pop: activity.pop === seq ? 0 : activity.pop,
    }));
    const expired = Date.now();
    for (const [id, until] of avatarDepartures) if (until <= expired) avatarDepartures.delete(id);
  }, TODO_ACTIVITY_MS);
  activityTimers.add(timer);
}

/** One-shot: whether the avatar's change just removed this row from the open list (the card's out: transition). */
export function takeAvatarDeparture(id: string): boolean {
  const until = avatarDepartures.get(id);
  avatarDepartures.delete(id);
  return until !== undefined && until > Date.now();
}

/** Whether the update now flushing applies an avatar's change (the card's sibling glide and section fades). */
export function avatarChangeFlushing(): boolean {
  return avatarFlushOpen;
}

/**
 * The change (seq) of the newest row the avatar added that sits past the card's
 * visible rows — the 전체 보기 footer pops for it — else 0. Keyed on that change
 * alone, so a later edit of the avatar's never re-pops it.
 */
export function todoHiddenArrivalSeq(
  sections: TodoOverlaySection[],
  marks: Record<string, TodoMark>,
  items: TodoItem[],
): number {
  const shown = new Set(sections.flatMap((section) => section.items.map((item) => item.id)));
  let seq = 0;
  for (const item of items) {
    const mark = marks[item.id];
    if (!item.done && mark?.kind === "added" && !shown.has(item.id)) seq = Math.max(seq, mark.seq);
  }
  return seq;
}

/** Logout/session expiry: forget tracked tool calls and void in-flight loads (the slice itself is reset by the caller). */
export function resetTodoClientState(): void {
  trackedTodoTools.clear();
  sessionEpoch += 1;
  inFlightLoad = null;
  writesInFlight = 0;
  reloadQueued = false;
  pendingFreshRead = false;
  overlayFocusRequested = false;
  avatarEndsSeen = 0;
  avatarEndsCovered = 0;
  lastAvatarEndAt = 0;
  avatarDepartures.clear();
  avatarFlushOpen = false;
  activitySeq = 0;
  for (const timer of activityTimers) clearTimeout(timer);
  activityTimers.clear();
  todoActivity.set(emptyTodoActivity());
}
