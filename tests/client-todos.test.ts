// @vitest-environment jsdom
// The client half of 할 일: the ONE store slice the tab, the chat overlay and the
// rail badge share. Pins the optimistic-write contract (change first, roll back
// + toast + resync on failure), the snapshot rule (every response's
// {todayKst, counts} wins), stale-load protection, the live refresh when an
// avatar's mcp__todo__* call finishes (and the card motion it alone may
// trigger), and storage-failure tolerance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import {
  avatarChangeFlushing,
  clearCompletedTodos,
  clearDroppedTodos,
  closeTodoWithUndo,
  completeTodoWithUndo,
  createTodo,
  deleteTodo,
  diffAvatarChange,
  dismissTodoOverlay,
  dueLabel,
  emptyTodoActivity,
  emptyTodoState,
  fromWireCounts,
  fromWireTodo,
  isPendingTodo,
  loadTodos,
  matchesTodoFilter,
  matchesTodoQuery,
  noteTodoToolEnd,
  noteTodoToolStart,
  onBeforeAvatarChange,
  overlaySections,
  parseTagInput,
  resetTodoClientState,
  restoreTodoOverlay,
  setTodoOverlayOpen,
  setTodoStatus,
  consumeTodoOverlayFocus,
  takeAvatarDeparture,
  todoActivity,
  todoHiddenArrivalSeq,
  todoFilterCounts,
  todoSectionArrivalSeq,
  todoTodayProgress,
  todoListGroups,
  todoOverlayMode,
  todoOverlayVisible,
  todoSeedText,
  updateTodo,
  TODO_ACTIVITY_MS,
  TODO_ARRIVAL_STAGGER_MS,
  TODO_OVERLAY_PINNED_MIN_WIDTH,
} from "../src/client/src/lib/todos.js";
import {
  loadTodoOverlayCollapsed,
  loadTodoOverlayMinimized,
  loadTodoOverlayOpen,
  persistTodoOverlayCollapsed,
  persistTodoOverlayMinimized,
} from "../src/client/src/lib/layout.js";
import { attachRun } from "../src/client/src/lib/chat.js";
import { startKnowledgeWatch, stopKnowledgeWatch } from "../src/client/src/lib/loaders.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import { isOpenTodo, type TodoCounts, type TodoItem } from "../src/shared/todos.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const TODAY = "2026-10-09";

function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2)}`,
    title: "보고서 초안",
    note: "",
    status: "todo",
    priority: "normal",
    dueDate: null,
    tags: [],
    source: "user",
    sourceConversationId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

/** A closed item as the server stores it: its status plus when it was closed. */
function closed(status: "done" | "dropped", overrides: Partial<TodoItem> = {}): TodoItem {
  return todo({ status, closedAt: "2026-10-08T00:00:00.000Z", ...overrides });
}

function counts(overrides: Partial<TodoCounts> = {}): TodoCounts {
  return { open: 0, inProgress: 0, overdue: 0, dueToday: 0, done: 0, dropped: 0, ...overrides };
}

function countsOf(items: TodoItem[]): TodoCounts {
  return counts({
    open: items.filter(isOpenTodo).length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
    done: items.filter((i) => i.status === "done").length,
    dropped: items.filter((i) => i.status === "dropped").length,
  });
}

function seedTodos(items: TodoItem[], snapshot: Partial<{ todayKst: string; counts: TodoCounts }> = {}) {
  updateState((state) => {
    state.todos = {
      items,
      todayKst: snapshot.todayKst ?? TODAY,
      counts: snapshot.counts ?? countsOf(items),
      loaded: true,
    };
  });
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

type Handler = (url: string, init: RequestInit) => unknown;
function useFetch(handler: Handler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = await handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function lastToast() {
  const items = get(toasts);
  return items[items.length - 1];
}

beforeEach(() => {
  // Module-level load/write bookkeeping must not leak between tests (a test that
  // leaves a write in flight would defer every later fresh read).
  resetTodoClientState();
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: { id: "owner", roles: [] } as never });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("labels due dates against the server's KST today", () => {
    expect(dueLabel("2026-10-09", TODAY)).toBe("오늘");
    expect(dueLabel("2026-10-10", TODAY)).toBe("내일");
    expect(dueLabel("2026-10-06", TODAY)).toBe("3일 지남");
    expect(dueLabel("2026-10-12", TODAY)).toBe("10월 12일 (월)");
    expect(dueLabel("2027-01-04", TODAY)).toBe("2027년 1월 4일 (월)");
  });

  it("filters: 오늘 = overdue + today, 예정 = future, 진행 중, 전체 = open only, 완료 / 드랍 = that closed status", () => {
    const overdue = todo({ dueDate: "2026-10-01" });
    const today = todo({ dueDate: TODAY });
    const later = todo({ dueDate: "2026-11-01" });
    const undated = todo();
    const running = todo({ status: "in_progress", dueDate: "2026-10-02" });
    const done = closed("done", { dueDate: "2026-10-01" });
    const dropped = closed("dropped", { dueDate: TODAY });
    const all = [overdue, today, later, undated, running, done, dropped];
    const pick = (filter: Parameters<typeof matchesTodoFilter>[1]) => all.filter((item) => matchesTodoFilter(item, filter, TODAY));
    // An in-progress item is open: the time filters and 전체 cover it too.
    expect(pick("today")).toEqual([overdue, today, running]);
    expect(pick("upcoming")).toEqual([later]);
    expect(pick("overdue")).toEqual([overdue, running]);
    expect(pick("in_progress")).toEqual([running]);
    expect(pick("all")).toEqual([overdue, today, later, undated, running]);
    expect(pick("done")).toEqual([done]);
    expect(pick("dropped")).toEqual([dropped]);
    // 완료 and 드랍 trust the server's counts — a listing only carries the newest closed items.
    expect(todoFilterCounts(all, counts({ done: 250, dropped: 230 }), TODAY)).toEqual({
      today: 3,
      upcoming: 1,
      overdue: 2,
      in_progress: 1,
      all: 5,
      done: 250,
      dropped: 230,
    });
  });

  it("groups the tab's list: 진행 중 first whatever the due date, then the due buckets; 완료 / 드랍 one group each", () => {
    const items = [
      todo({ id: "run-late", status: "in_progress", dueDate: "2026-10-01" }),
      todo({ id: "run", status: "in_progress" }),
      todo({ id: "late", dueDate: "2026-10-02" }),
      todo({ id: "now", dueDate: TODAY }),
      todo({ id: "soon", dueDate: "2026-10-20" }),
      todo({ id: "someday" }),
    ];
    const groups = (filter: Parameters<typeof todoListGroups>[1], list = items) =>
      todoListGroups(list, filter, TODAY).map((group) => [group.label, group.items.map((item) => item.id)]);
    expect(groups("all")).toEqual([
      ["진행 중", ["run-late", "run"]],
      ["마감 지남", ["late"]],
      ["오늘", ["now"]],
      ["예정", ["soon"]],
      ["날짜 없음", ["someday"]],
    ]);
    expect(groups("in_progress", items.slice(0, 2))).toEqual([["진행 중", ["run-late", "run"]]]);
    expect(groups("done", [closed("done", { id: "d" })])).toEqual([["완료", ["d"]]]);
    expect(groups("dropped", [closed("dropped", { id: "x" })])).toEqual([["드랍", ["x"]]]);
    expect(todoListGroups([], "all", TODAY)).toEqual([]);
  });

  it("searches title, memo and #tags with every token", () => {
    const item = todo({ title: "분기 보고서", note: "재무팀 숫자 확인", tags: ["기획"] });
    expect(matchesTodoQuery(item, "보고서 재무")).toBe(true);
    expect(matchesTodoQuery(item, "#기획")).toBe(true);
    expect(matchesTodoQuery(item, "보고서 인사")).toBe(false);
    expect(matchesTodoQuery(item, "  ")).toBe(true);
  });

  it("parses one tag box: comma/space separated, # optional, duplicates dropped", () => {
    expect(parseTagInput("#기획, 리뷰  기획 #Infra infra")).toEqual(["기획", "리뷰", "Infra"]);
    expect(parseTagInput("")).toEqual([]);
  });

  it("splits the overlay's first 8 open items into 마감 지남 / 오늘 / 다음 in the shared order", () => {
    const items = [
      todo({ id: "u1" }),
      closed("done", { id: "d1" }),
      closed("dropped", { id: "dr1" }),
      todo({ id: "o1", dueDate: "2026-10-02" }),
      todo({ id: "t1", dueDate: TODAY, priority: "high" }),
      todo({ id: "f1", dueDate: "2026-10-20" }),
      ...Array.from({ length: 6 }, (_, i) => todo({ id: `x${i}` })),
    ];
    const { sections, hidden } = overlaySections(items, TODAY);
    expect(sections.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["overdue", ["o1"]],
      ["today", ["t1"]],
      ["next", ["f1", "u1", "x0", "x1", "x2", "x3"]],
    ]);
    expect(hidden).toBe(2);
  });

  it("leads the overlay with 진행 중 — an overdue in-progress item sits only there", () => {
    const items = [
      todo({ id: "o1", dueDate: "2026-10-02" }),
      todo({ id: "run-late", status: "in_progress", dueDate: "2026-10-01" }),
      todo({ id: "run", status: "in_progress" }),
      todo({ id: "u1" }),
    ];
    const { sections, hidden } = overlaySections(items, TODAY);
    expect(sections.map((s) => [s.id, s.label, s.items.map((i) => i.id)])).toEqual([
      ["in_progress", "진행 중", ["run-late", "run"]],
      ["overdue", "마감 지남", ["o1"]],
      ["next", "다음", ["u1"]],
    ]);
    expect(hidden).toBe(0);
    // In-progress items lead the shared order, so they take the card's rows first.
    const crowded = [...Array.from({ length: 8 }, (_, i) => todo({ id: `late${i}`, dueDate: "2026-10-01" })), todo({ id: "run", status: "in_progress" })];
    expect(overlaySections(crowded, TODAY).sections[0]).toMatchObject({ id: "in_progress", items: [expect.objectContaining({ id: "run" })] });
  });

  it("folds a collapsed section to its heading and count, spending none of the row budget on it", () => {
    const items = [
      todo({ id: "run1", status: "in_progress" }),
      todo({ id: "run2", status: "in_progress" }),
      todo({ id: "o1", dueDate: "2026-10-02" }),
      ...Array.from({ length: 8 }, (_, i) => todo({ id: `n${i}` })),
    ];
    const open = overlaySections(items, TODAY);
    expect(open.sections.map((s) => [s.id, s.items.length, s.members.length, s.collapsed])).toEqual([
      ["in_progress", 2, 2, false],
      ["overdue", 1, 1, false],
      ["next", 5, 8, false],
    ]);
    expect(open.hidden).toBe(3);
    // Collapsing 진행 중 frees its two rows for 다음; its heading still counts both.
    const folded = overlaySections(items, TODAY, 8, new Set(["in_progress"]));
    expect(folded.sections.map((s) => [s.id, s.items.length, s.members.length, s.collapsed])).toEqual([
      ["in_progress", 0, 2, true],
      ["overdue", 1, 1, false],
      ["next", 7, 8, false],
    ]);
    expect(folded.hidden).toBe(1);
    // An expanded section past the budget is left out; its items count as hidden.
    const tight = overlaySections(items, TODAY, 2);
    expect(tight.sections.map((s) => s.id)).toEqual(["in_progress"]);
    expect(tight.hidden).toBe(9);
  });

  it("pops a collapsed section's count, not the footer, for an avatar addition inside it", () => {
    const items = [todo({ id: "a", source: "avatar" }), todo({ id: "b" })];
    const marks = { a: { kind: "added" as const, seq: 3, delay: 0 } };
    const folded = overlaySections(items, TODAY, 8, new Set(["next"]));
    expect(todoHiddenArrivalSeq(folded.sections, marks, items)).toBe(0);
    expect(todoSectionArrivalSeq(folded.sections[0], marks)).toBe(3);
    const open = overlaySections(items, TODAY, 1);
    // Expanded: a row it has (a) never pops the section's count.
    expect(todoSectionArrivalSeq(open.sections[0], marks)).toBe(0);
  });

  it("sums up the KST day: completed today against what is still overdue or due today", () => {
    const items = [
      // 2026-10-08T15:30Z is 00:30 KST on the 9th — today; 14:30Z is still the 8th.
      closed("done", { id: "d1", closedAt: "2026-10-08T15:30:00.000Z" }),
      closed("done", { id: "d2", closedAt: "2026-10-08T14:30:00.000Z" }),
      closed("dropped", { id: "x1", closedAt: "2026-10-09T01:00:00.000Z" }),
      todo({ id: "late", dueDate: "2026-10-01" }),
      todo({ id: "now", dueDate: TODAY, status: "in_progress" }),
      todo({ id: "later", dueDate: "2026-10-20" }),
      todo({ id: "undated" }),
    ];
    expect(todoTodayProgress(items, TODAY)).toEqual({ done: 1, left: 2 });
    expect(todoTodayProgress(items, "")).toEqual({ done: 0, left: 0 });
  });

  it("remembers the card's folded sections and minimized state per browser, tolerating junk", () => {
    const known = ["in_progress", "overdue", "today", "next"];
    persistTodoOverlayCollapsed(new Set(["next", "overdue"]));
    expect([...loadTodoOverlayCollapsed(known)].sort()).toEqual(["next", "overdue"]);
    persistTodoOverlayCollapsed(new Set());
    expect(window.localStorage.getItem("noah.todoOverlayCollapsed")).toBeNull();
    window.localStorage.setItem("noah.todoOverlayCollapsed", '["next", 3, "gone"]');
    expect([...loadTodoOverlayCollapsed(known)]).toEqual(["next"]);
    window.localStorage.setItem("noah.todoOverlayCollapsed", "{not json");
    expect(loadTodoOverlayCollapsed(known).size).toBe(0);
    persistTodoOverlayMinimized(true);
    expect(loadTodoOverlayMinimized()).toBe(true);
    persistTodoOverlayMinimized(false);
    expect(window.localStorage.getItem("noah.todoOverlayMinimized")).toBeNull();
  });

  it("picks pinned only on a wide host, popover below it, and a sheet on a narrow viewport", () => {
    expect(todoOverlayMode(TODO_OVERLAY_PINNED_MIN_WIDTH, false)).toBe("pinned");
    expect(todoOverlayMode(TODO_OVERLAY_PINNED_MIN_WIDTH - 1, false)).toBe("popover");
    expect(todoOverlayMode(2000, true)).toBe("sheet");
  });

  it("seeds a delegation with the item and its id, never auto-sent text the avatar must guess", () => {
    const seed = todoSeedText(todo({ id: "abc", title: "배포 점검", dueDate: TODAY, priority: "high", tags: ["ops"], note: "체크리스트 3번까지" }));
    expect(seed).toContain("할 일: 배포 점검");
    expect(seed).toContain("마감 2026-10-09 · 우선순위 높음 · #ops");
    expect(seed).toContain("체크리스트 3번까지");
    expect(seed).toContain("할 일 ID: abc");
    // The owner's own words ask for the status changes — the avatar never guesses them.
    expect(seed).toContain("시작하면 진행 중으로, 끝나면 완료로 표시");
  });
});

describe("optimistic writes", () => {
  it("shows a new item at once, then swaps in the server's row and snapshot", async () => {
    seedTodos([todo({ id: "old", dueDate: TODAY })]);
    const gate = deferred<unknown>();
    const fetchMock = useFetch(async (url, init) => {
      if (url === "/api/me/todos" && init.method === "POST") return gate.promise;
      return undefined;
    });
    const created = createTodo({ title: "  새   할 일 ", priority: "high" });
    const pending = readState().todos.items.find((item) => item.title === "새 할 일");
    expect(pending && isPendingTodo(pending)).toBe(true);
    expect(readState().todos.counts.open).toBe(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ title: "새 할 일", priority: "high", dueDate: null, tags: [] });

    const server = todo({ id: "srv-1", title: "새 할 일", priority: "high", createdAt: "2026-10-09T05:00:00.000Z" });
    gate.resolve(jsonRes({ todo: server, todayKst: "2026-10-10", counts: counts({ open: 2, dueToday: 0, overdue: 1 }) }, 201));
    await expect(created).resolves.toEqual(server);
    const state = readState().todos;
    expect(state.items.map((item) => item.id)).toEqual(["old", "srv-1"]);
    // The server's KST date and counts replace the optimistic ones wholesale.
    expect(state.todayKst).toBe("2026-10-10");
    expect(state.counts).toEqual(counts({ open: 2, overdue: 1 }));
  });

  it("rolls a failed create back and says why in Korean", async () => {
    seedTodos([]);
    useFetch(async () => jsonRes({ error: "열린 할 일은 최대 500개까지 둘 수 있습니다." }, 409));
    await expect(createTodo({ title: "넘침" })).resolves.toBeNull();
    expect(readState().todos.items).toEqual([]);
    expect(readState().todos.counts.open).toBe(0);
    expect(lastToast().message).toBe("할 일을 추가하지 못했습니다: 열린 할 일은 최대 500개까지 둘 수 있습니다.");
  });

  it("completes optimistically and restores the item (then resyncs) when the PATCH fails", async () => {
    const item = todo({ id: "a1", dueDate: TODAY });
    seedTodos([item], { counts: counts({ open: 1, dueToday: 1 }) });
    const gate = deferred<unknown>();
    const fetchMock = useFetch(async (url, init) => {
      if (init.method === "PATCH") return gate.promise;
      if (url === "/api/me/todos") return jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1, dueToday: 1 }) });
      return undefined;
    });
    const result = setTodoStatus("a1", "done");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ status: "done" });
    expect(readState().todos.items[0]).toMatchObject({ status: "done" });
    expect(readState().todos.items[0].closedAt).toBeTruthy();
    expect(readState().todos.counts).toEqual(counts({ open: 0, dueToday: 0, done: 1 }));

    gate.resolve(jsonRes({ error: "서버 내부 오류가 발생했습니다." }, 500));
    await expect(result).resolves.toBeNull();
    expect(readState().todos.items[0]).toEqual(item);
    expect(readState().todos.counts).toMatchObject({ open: 1, dueToday: 1, done: 0 });
    expect(lastToast().message).toContain("할 일을 완료하지 못했습니다");
    await flush();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/me/todos" && !init?.method)).toBe(true);
  });

  it("moves the counts with every status: 진행 중 stays open, 드랍 leaves it, and a failure puts both back", async () => {
    const item = todo({ id: "s1", dueDate: "2026-10-01" });
    seedTodos([item], { counts: counts({ open: 1, overdue: 1, done: 3, dropped: 2 }) });
    const gates: { promise: Promise<unknown>; resolve: (value: unknown) => void }[] = [];
    let stored = item;
    const fetchMock = useFetch(async (url, init) => {
      if (init.method === "PATCH") {
        const gate = deferred<unknown>();
        gates.push(gate);
        return gate.promise;
      }
      // The failure's resync reads what the server really has.
      if (url === "/api/me/todos") return jsonRes({ todos: [stored], todayKst: TODAY, counts: counts({ ...countsOf([stored]), overdue: 1, done: 3, dropped: 2 }) });
      return undefined;
    });
    const started = setTodoStatus("s1", "in_progress");
    // Still open: overdue and open keep it; closedAt stays empty.
    expect(readState().todos.items[0]).toMatchObject({ status: "in_progress", closedAt: null });
    expect(readState().todos.counts).toEqual(counts({ open: 1, inProgress: 1, overdue: 1, done: 3, dropped: 2 }));
    const running = { ...item, status: "in_progress" as const, updatedAt: "2026-10-09T01:00:00.000Z" };
    stored = running;
    gates[0].resolve(jsonRes({ todo: running, todayKst: TODAY, counts: counts({ open: 1, inProgress: 1, overdue: 1, done: 3, dropped: 2 }) }));
    await expect(started).resolves.toEqual(running);

    const drop = setTodoStatus("s1", "dropped");
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ status: "dropped" });
    expect(readState().todos.items[0]).toMatchObject({ status: "dropped" });
    expect(readState().todos.items[0].closedAt).toBeTruthy();
    expect(readState().todos.counts).toEqual(counts({ open: 0, done: 3, dropped: 3 }));
    gates[1].resolve(jsonRes({ error: "서버 내부 오류가 발생했습니다." }, 500));
    await expect(drop).resolves.toBeNull();
    expect(readState().todos.items[0]).toEqual(running);
    expect(readState().todos.counts).toEqual(counts({ open: 1, inProgress: 1, overdue: 1, done: 3, dropped: 2 }));
    expect(lastToast().message).toBe("할 일을 드랍하지 못했습니다: 서버 내부 오류가 발생했습니다.");
  });

  it("names a failed status change after where the item was going (and, back to 시작 전, where it came from)", async () => {
    seedTodos([todo({ id: "t" }), todo({ id: "p", status: "in_progress" }), closed("done", { id: "d" }), closed("dropped", { id: "x" })]);
    useFetch(async (url, init) => {
      if (init.method === "PATCH") return jsonRes({ error: "오류" }, 500);
      if (url === "/api/me/todos") return jsonRes({ todos: readState().todos.items, todayKst: TODAY, counts: countsOf(readState().todos.items) });
      return undefined;
    });
    const failure = async (id: string, status: Parameters<typeof setTodoStatus>[1]) => {
      await setTodoStatus(id, status);
      return lastToast().message;
    };
    expect(await failure("t", "in_progress")).toBe("진행 중으로 바꾸지 못했습니다: 오류");
    expect(await failure("p", "todo")).toBe("시작 전으로 바꾸지 못했습니다: 오류");
    expect(await failure("d", "todo")).toBe("완료를 되돌리지 못했습니다: 오류");
    expect(await failure("x", "todo")).toBe("드랍을 되돌리지 못했습니다: 오류");
    expect(await failure("x", "done")).toBe("할 일을 완료하지 못했습니다: 오류");
  });

  it("resyncs after a failed write even while a poll GET that predates the failure is in flight", async () => {
    const item = todo({ id: "r1" });
    seedTodos([item]);
    const patchGate = deferred<unknown>();
    const pollGate = deferred<unknown>();
    let gets = 0;
    useFetch(async (url, init) => {
      if (init.method === "PATCH") return patchGate.promise;
      if (url === "/api/me/todos" && !init.method) {
        gets += 1;
        return gets === 1
          ? pollGate.promise
          : jsonRes({ todos: [{ ...item, status: "done" }], todayKst: TODAY, counts: counts({ done: 1 }) });
      }
      return undefined;
    });
    const write = setTodoStatus("r1", "done");
    const poll = loadTodos(); // the 60 s poll, started after the write
    // A gateway timeout: the server may still have applied the change.
    patchGate.resolve(jsonRes({ error: "시간 초과" }, 504));
    await expect(write).resolves.toBeNull();
    expect(readState().todos.items[0].status).toBe("todo");
    pollGate.resolve(jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await poll;
    await flush();
    // The poll overlapped the write and was dropped; the failure's fresh read ran behind it.
    expect(gets).toBe(2);
    expect(readState().todos.items[0].status).toBe("done");
  });

  it("defers an owed fresh read until the LAST in-flight write settles, then reads exactly once", async () => {
    const a = todo({ id: "a" });
    const b = todo({ id: "b" });
    const c = todo({ id: "c" });
    seedTodos([a, b, c]);
    const gates = { a: deferred<unknown>(), b: deferred<unknown>(), c: deferred<unknown>() };
    let gets = 0;
    useFetch(async (url, init) => {
      if (init.method === "PATCH") return gates[url.split("/").pop() as "a" | "b" | "c"].promise;
      if (url === "/api/me/todos" && !init.method) {
        gets += 1;
        return jsonRes({ todos: [a, { ...b, status: "done" }, { ...c, status: "done" }], todayKst: TODAY, counts: counts({ open: 1, done: 2 }) });
      }
      return undefined;
    });
    const writeA = setTodoStatus("a", "done");
    const writeB = setTodoStatus("b", "done");
    gates.a.resolve(jsonRes({ error: "서버 오류" }, 500));
    await expect(writeA).resolves.toBeNull();
    await flush();
    // A's resync is owed, but B is still in flight: a GET now would only be dropped as stale.
    expect(gets).toBe(0);
    const writeC = setTodoStatus("c", "done");
    gates.b.resolve(jsonRes({ todo: { ...b, status: "done" }, todayKst: TODAY, counts: counts({ open: 2, done: 1 }) }));
    await writeB;
    await flush();
    expect(gets).toBe(0); // C is still in flight
    gates.c.resolve(jsonRes({ todo: { ...c, status: "done" }, todayKst: TODAY, counts: counts({ open: 1, done: 2 }) }));
    await writeC;
    await flush();
    expect(gets).toBe(1); // the last write to settle started it — one GET, none wasted
    expect(readState().todos.items.map((item) => `${item.id}:${item.status}`).sort()).toEqual(["a:todo", "b:done", "c:done"]);
  });

  it("drops a write's late answer after logout instead of writing into the reset list", async () => {
    seedTodos([todo({ id: "old" })]);
    const deleteGate = deferred<unknown>();
    const createGate = deferred<unknown>();
    useFetch(async (url, init) => {
      if (init.method === "DELETE") return deleteGate.promise;
      if (init.method === "POST") return createGate.promise;
      return jsonRes({ todos: [], todayKst: TODAY, counts: counts() });
    });
    const removal = deleteTodo("old");
    const creation = createTodo({ title: "늦게 도착" });
    stopKnowledgeWatch(); // logout / session expiry resets the slice
    deleteGate.resolve(jsonRes({ error: "서버 오류" }, 500));
    createGate.resolve(jsonRes({ todo: todo({ id: "late" }), todayKst: TODAY, counts: counts({ open: 1 }) }, 201));
    await expect(removal).resolves.toBe(false);
    await expect(creation).resolves.toBeNull();
    // Neither the delete's rollback nor the create's answer lands in the next session.
    expect(readState().todos).toEqual(emptyTodoState());
    expect(get(toasts)).toEqual([]);
  });

  it("drops an item the server no longer has instead of resurrecting it", async () => {
    seedTodos([todo({ id: "gone" })]);
    useFetch(async (url, init) => {
      if (init.method === "PATCH") return jsonRes({ error: "할 일을 찾을 수 없습니다." }, 404);
      if (url === "/api/me/todos") return jsonRes({ todos: [], todayKst: TODAY, counts: counts() });
      return undefined;
    });
    await expect(updateTodo("gone", { title: "새 제목" })).resolves.toBeNull();
    expect(readState().todos.items).toEqual([]);
    expect(lastToast().message).toBe("이미 삭제된 할 일입니다.");
  });

  /** A PATCH server for one item: applies `status` like the routes do and records each body. */
  function statusServer(item: TodoItem) {
    let current = item;
    const patches: unknown[] = [];
    useFetch(async (url, init) => {
      if (init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        current = { ...current, status: body.status, closedAt: isOpenTodo(body) ? null : "2026-10-09T01:00:00.000Z" };
        return jsonRes({ todo: current, todayKst: TODAY, counts: countsOf([current]) });
      }
      return undefined;
    });
    return patches;
  }

  it("offers 되돌리기 after a completion, and the action reopens the item", async () => {
    const item = todo({ id: "u1" });
    seedTodos([item]);
    const patches = statusServer(item);
    await completeTodoWithUndo(item);
    const toast = lastToast();
    expect(toast).toMatchObject({ kind: "ok", actionLabel: "되돌리기" });
    expect(toast.message).toBe("할 일을 완료했습니다 · 보고서 초안");
    toast.action?.();
    await flush();
    await flush();
    expect(patches).toEqual([{ status: "done" }, { status: "todo" }]);
    expect(readState().todos.items[0].status).toBe("todo");
  });

  it("puts back the status the item had: an in-progress item completed or dropped returns to 진행 중", async () => {
    const item = todo({ id: "p1", status: "in_progress" });
    seedTodos([item]);
    const patches = statusServer(item);
    await completeTodoWithUndo(item);
    lastToast().action?.();
    await flush();
    await flush();
    expect(readState().todos.items[0].status).toBe("in_progress");

    await closeTodoWithUndo(readState().todos.items[0], "dropped");
    const toast = lastToast();
    expect(toast).toMatchObject({ kind: "ok", actionLabel: "되돌리기", message: "할 일을 드랍했습니다 · 보고서 초안" });
    toast.action?.();
    await flush();
    await flush();
    expect(patches).toEqual([{ status: "done" }, { status: "in_progress" }, { status: "dropped" }, { status: "in_progress" }]);
    expect(readState().todos.items[0]).toMatchObject({ status: "in_progress", closedAt: null });
    // Dropping it again once it is dropped writes nothing.
    await closeTodoWithUndo(readState().todos.items[0], "dropped");
    expect(patches).toHaveLength(5);
    await closeTodoWithUndo(readState().todos.items[0], "dropped");
    expect(patches).toHaveLength(5);
  });

  it("deletes optimistically, clears the selection, and puts the row back on failure", async () => {
    const item = todo({ id: "del" });
    seedTodos([item]);
    replaceState({ todoSelectedId: "del" });
    useFetch(async (url, init) => {
      if (init.method === "DELETE") return jsonRes({ error: "서버 내부 오류가 발생했습니다." }, 500);
      if (url === "/api/me/todos") return jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) });
      return undefined;
    });
    const result = deleteTodo("del");
    expect(readState().todos.items).toEqual([]);
    expect(readState().todoSelectedId).toBe("");
    await expect(result).resolves.toBe(false);
    expect(readState().todos.items).toEqual([item]);
    expect(lastToast().message).toContain("할 일을 삭제하지 못했습니다");
  });

  it("clears completed items only after the server confirms", async () => {
    seedTodos([todo({ id: "open" }), closed("done", { id: "done" }), closed("dropped", { id: "dropped" })], {
      counts: counts({ open: 1, done: 7, dropped: 1 }),
    });
    replaceState({ todoSelectedId: "done" });
    useFetch(async (url, init) =>
      url === "/api/me/todos/completed" && init.method === "DELETE"
        ? jsonRes({ removed: 7, todayKst: TODAY, counts: counts({ open: 1, dropped: 1 }) })
        : undefined,
    );
    await expect(clearCompletedTodos()).resolves.toBe(7);
    // Only the done rows: a dropped one stays for its own 비우기.
    expect(readState().todos.items.map((item) => item.id)).toEqual(["open", "dropped"]);
    expect(readState().todos.counts).toMatchObject({ done: 0, dropped: 1 });
    expect(readState().todoSelectedId).toBe("");
  });

  it("clears dropped items through their own route, keeping done ones and an open selection", async () => {
    seedTodos([todo({ id: "open" }), closed("done", { id: "done" }), closed("dropped", { id: "dropped" })], {
      counts: counts({ open: 1, done: 1, dropped: 4 }),
    });
    replaceState({ todoSelectedId: "open" });
    const fetchMock = useFetch(async (url, init) =>
      url === "/api/me/todos/dropped" && init.method === "DELETE"
        ? jsonRes({ removed: 4, todayKst: TODAY, counts: counts({ open: 1, done: 1 }) })
        : undefined,
    );
    await expect(clearDroppedTodos()).resolves.toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readState().todos.items.map((item) => item.id)).toEqual(["open", "done"]);
    expect(readState().todos.counts).toMatchObject({ done: 1, dropped: 0 });
    expect(readState().todoSelectedId).toBe("open");
  });

  it("says in Korean which closed items it could not clear", async () => {
    seedTodos([closed("dropped", { id: "dropped" })]);
    useFetch(async () => jsonRes({ error: "서버 오류" }, 500));
    await expect(clearDroppedTodos()).resolves.toBeNull();
    expect(lastToast().message).toBe("드랍 항목을 비우지 못했습니다: 서버 오류");
    expect(readState().todos.items.map((item) => item.id)).toEqual(["dropped"]);
  });

  it("takes a deleted closed item off its own count", async () => {
    seedTodos([closed("dropped", { id: "x" }), closed("done", { id: "d" })], { counts: counts({ done: 5, dropped: 3 }) });
    const gate = deferred<unknown>();
    useFetch(async (url, init) => (init.method === "DELETE" ? gate.promise : undefined));
    const removal = deleteTodo("x");
    expect(readState().todos.counts).toMatchObject({ done: 5, dropped: 2 });
    gate.resolve(jsonRes({ ok: true, todayKst: TODAY, counts: counts({ done: 5, dropped: 2 }) }));
    await expect(removal).resolves.toBe(true);
  });

  it("ignores actions on an unconfirmed (pending) row", async () => {
    seedTodos([todo({ id: "pending-123" })]);
    const fetchMock = useFetch(async () => undefined);
    await expect(setTodoStatus("pending-123", "done")).resolves.toBeNull();
    await expect(deleteTodo("pending-123")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loads", () => {
  it("replaces the slice with the server's list, sorted in the shared order", async () => {
    useFetch(async (url) =>
      url === "/api/me/todos"
        ? jsonRes({
            todos: [
              todo({ id: "undated" }),
              closed("dropped", { id: "dropped", closedAt: "2026-10-07T00:00:00.000Z" }),
              todo({ id: "dated", dueDate: "2026-10-01" }),
              closed("done", { id: "done" }),
              todo({ id: "running", status: "in_progress" }),
            ],
            todayKst: TODAY,
            counts: counts({ open: 3, inProgress: 1, overdue: 1, done: 1, dropped: 1 }),
          })
        : undefined,
    );
    await loadTodos();
    expect(readState().todos).toMatchObject({
      loaded: true,
      todayKst: TODAY,
      counts: counts({ open: 3, inProgress: 1, overdue: 1, done: 1, dropped: 1 }),
    });
    // In progress first, then by due date; closed ones newest close first.
    expect(readState().todos.items.map((item) => item.id)).toEqual(["running", "dated", "undated", "done", "dropped"]);
  });

  it("keeps the list's identity when a re-read changed nothing, so keyed views never reconcile mid-motion", async () => {
    const list = [todo({ id: "a" }), todo({ id: "b", dueDate: TODAY })];
    useFetch(async (url) =>
      url === "/api/me/todos"
        ? jsonRes({ todos: list.map((item) => ({ ...item })), todayKst: TODAY, counts: counts({ open: 2, dueToday: 1 }) })
        : undefined,
    );
    await loadTodos();
    const first = readState().todos.items;
    await loadTodos(); // equal content in fresh objects
    expect(readState().todos.items).toBe(first);
    list[0] = { ...list[0], title: "바뀐 제목", updatedAt: "2026-10-09T05:00:00.000Z" };
    await loadTodos();
    expect(readState().todos.items).not.toBe(first);
    expect(readState().todos.items.find((item) => item.id === "a")?.title).toBe("바뀐 제목");
  });

  it("discards a GET that started before a write, so it cannot undo the optimistic change", async () => {
    const item = todo({ id: "a" });
    seedTodos([item]);
    const staleGet = deferred<unknown>();
    useFetch(async (url, init) => {
      if (url === "/api/me/todos" && !init.method) return staleGet.promise;
      if (init.method === "PATCH") return jsonRes({ todo: { ...item, status: "done" }, todayKst: TODAY, counts: counts({ done: 1 }) });
      return undefined;
    });
    const load = loadTodos();
    await setTodoStatus("a", "done");
    staleGet.resolve(jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await load;
    expect(readState().todos.items[0].status).toBe("done");
    expect(readState().todos.counts.done).toBe(1);
  });

  it("discards a GET that started DURING a write and landed before it settled", async () => {
    // The server may answer that GET before it applies the write, so its list can
    // still hold the old row: applying it would undo the optimistic change until
    // the write's own response lands.
    const item = todo({ id: "a" });
    seedTodos([item], { counts: counts({ open: 1 }) });
    const patch = deferred<unknown>();
    const fetchFn = useFetch(async (url, init) => {
      if (url === "/api/me/todos" && !init.method) return jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) });
      if (init.method === "PATCH") return patch.promise;
      return undefined;
    });
    const completion = setTodoStatus("a", "done");
    await flush();
    expect(readState().todos.items[0].status).toBe("done");
    await loadTodos(); // e.g. the 60 s poll, while the PATCH is still on the way
    expect(readState().todos.items[0].status).toBe("done");
    expect(readState().todos.counts.done).toBe(1);
    patch.resolve(jsonRes({ todo: { ...item, status: "done" }, todayKst: TODAY, counts: counts({ done: 1 }) }));
    await completion;
    await flush();
    expect(readState().todos.items[0].status).toBe("done");
    expect(readState().todos.counts).toEqual(counts({ done: 1 }));
    // A plain poll owes nothing: the write's own response settled the list.
    expect(fetchFn.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method)).toHaveLength(1);
  });

  it("never wedges later loads when a write throws before it is sent", async () => {
    // Every GET that lands while a write is in flight is dropped, so a write that
    // was counted but never settled would freeze the list until logout.
    seedTodos([todo({ id: "a" })]);
    useFetch(async (url, init) =>
      url === "/api/me/todos" && !init.method
        ? jsonRes({ todos: [todo({ id: "a" }), todo({ id: "b" })], todayKst: TODAY, counts: counts({ open: 2 }) })
        : undefined,
    );
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("no uuid");
    });
    await expect(createTodo({ title: "x" })).rejects.toThrow("no uuid");
    uuid.mockRestore();
    await loadTodos();
    expect(readState().todos.items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("shares ONE in-flight GET between overlapping loads (the direct #/todos open used to livelock)", async () => {
    // The boot refresh and the 할 일 tab's own load overlap on a direct #/todos
    // open. When every load invalidated the other, the older answer re-spawned a
    // load that invalidated the newer one — forever.
    const first = deferred<unknown>();
    const fetchFn = useFetch(async (url, init) =>
      url === "/api/me/todos" && !init.method ? first.promise : undefined,
    );
    const boot = loadTodos();
    const view = loadTodos();
    expect(view).toBe(boot);
    first.resolve(jsonRes({ todos: [todo({ id: "a" })], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await Promise.all([boot, view]);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(readState().todos).toMatchObject({ loaded: true });
    expect(readState().todos.items.map((item) => item.id)).toEqual(["a"]);
  });

  it("queues ONE more read when a fresh refresh joins a GET that may predate the avatar's write", async () => {
    seedTodos([todo({ id: "old" })]);
    const firstGet = deferred<unknown>();
    let gets = 0;
    useFetch(async (url, init) => {
      if (url !== "/api/me/todos" || init.method) return undefined;
      gets += 1;
      return gets === 1
        ? firstGet.promise
        : jsonRes({ todos: [todo({ id: "old" }), todo({ id: "added-by-avatar" })], todayKst: TODAY, counts: counts({ open: 2 }) });
    });
    const poll = loadTodos();
    // The avatar's add_todos finishes while the poll's GET is still in flight.
    noteTodoToolStart("tool-1", "mcp__todo__add_todos");
    noteTodoToolEnd("tool-1", true);
    firstGet.resolve(jsonRes({ todos: [todo({ id: "old" })], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await poll;
    await flush();
    expect(gets).toBe(2);
    expect(readState().todos.items.map((item) => item.id).sort()).toEqual(["added-by-avatar", "old"]);
  });

  it("re-reads a never-loaded list that a write overlapped, then stops", async () => {
    const created = todo({ id: "new", title: "새 할 일" });
    const firstGet = deferred<unknown>();
    let gets = 0;
    const fetchFn = useFetch(async (url, init) => {
      if (url === "/api/me/todos" && !init.method) {
        gets += 1;
        return gets === 1 ? firstGet.promise : jsonRes({ todos: [created], todayKst: TODAY, counts: counts({ open: 1 }) });
      }
      if (url === "/api/me/todos" && init.method === "POST") {
        return jsonRes({ todo: created, todayKst: TODAY, counts: counts({ open: 1 }) }, 201);
      }
      return undefined;
    });
    const load = loadTodos();
    await createTodo({ title: "새 할 일" });
    // Predates the write: dropped, and since the list never loaded, read again.
    firstGet.resolve(jsonRes({ todos: [], todayKst: TODAY, counts: counts() }));
    await load;
    await flush();
    expect(gets).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(readState().todos).toMatchObject({ loaded: true });
    expect(readState().todos.items.map((item) => item.id)).toEqual(["new"]);
  });

  it("keeps a deep-linked selection when the watcher starts at boot", async () => {
    // enterApp restores #/todos/<id> BEFORE startKnowledgeWatch runs; the start
    // must not reuse the logout reset and wipe that selection.
    useFetch(async (url) =>
      url === "/api/me/todos"
        ? jsonRes({ todos: [todo({ id: "linked" })], todayKst: TODAY, counts: counts({ open: 1 }) })
        : jsonRes({}),
    );
    replaceState({ todoSelectedId: "linked", todoSearch: "보고" });
    startKnowledgeWatch();
    await flush();
    expect(readState().todoSelectedId).toBe("linked");
    expect(readState().todoSearch).toBe("보고");
    expect(readState().todos.items.map((item) => item.id)).toEqual(["linked"]);
    stopKnowledgeWatch();
    expect(readState().todoSelectedId).toBe("");
  });

  it("starts with the watcher and is wiped (with the tracked tool calls) on logout", async () => {
    useFetch(async (url) =>
      url === "/api/me/todos"
        ? jsonRes({ todos: [todo({ id: "mine" })], todayKst: TODAY, counts: counts({ open: 1 }) })
        : jsonRes({}),
    );
    startKnowledgeWatch();
    await flush();
    expect(readState().todos.items.map((item) => item.id)).toEqual(["mine"]);
    replaceState({ todoSelectedId: "mine", todoSearch: "검색" });
    stopKnowledgeWatch();
    expect(readState().todos).toEqual(emptyTodoState());
    expect(readState().todoSelectedId).toBe("");
    expect(readState().todoSearch).toBe("");
  });
});

describe("a pre-status server (a rollback, or a rebuilt client under the old server process)", () => {
  /** An item as a server from before statuses sends it: `done` / `completedAt` only. */
  function legacy(item: TodoItem) {
    const { status, closedAt, ...rest } = item;
    return { ...rest, done: status === "done", completedAt: closedAt };
  }
  /** Counts without inProgress / dropped. */
  const legacyCounts = { open: 2, overdue: 1, dueToday: 0, done: 1 };

  it("reads done/completedAt items and pre-status counts instead of coming up empty, through loads and writes", async () => {
    const late = todo({ id: "late", dueDate: "2026-10-01" });
    const other = todo({ id: "other" });
    const done = closed("done", { id: "done" });
    const renamed = { ...other, title: "새 제목", updatedAt: "2026-10-09T01:00:00.000Z" };
    const added = todo({ id: "added", title: "새 할 일", createdAt: "2026-10-09T02:00:00.000Z" });
    let list = [late, other, done];
    useFetch(async (url, init) => {
      if (url === "/api/me/todos" && !init.method) return jsonRes({ todos: list.map(legacy), todayKst: TODAY, counts: legacyCounts });
      if (url === "/api/me/todos/other" && init.method === "PATCH") {
        list = [late, renamed, done];
        return jsonRes({ todo: legacy(renamed), todayKst: TODAY, counts: legacyCounts });
      }
      if (url === "/api/me/todos" && init.method === "POST") {
        list = [...list, added];
        return jsonRes({ todo: legacy(added), todayKst: TODAY, counts: { ...legacyCounts, open: 3 } }, 201);
      }
      return undefined;
    });
    await loadTodos();
    let state = readState().todos;
    // Exactly the current shape — statuses read off `done`, closedAt off `completedAt`, no legacy keys.
    expect(state.items).toEqual([late, other, done]);
    expect(state.counts).toEqual(counts({ open: 2, overdue: 1, done: 1 }));
    // So the tab and the card show the open items.
    expect(overlaySections(state.items, TODAY).sections.flatMap((section) => section.items.map((item) => item.id))).toEqual(["late", "other"]);
    expect(todoFilterCounts(state.items, state.counts, TODAY)).toMatchObject({ all: 2, overdue: 1, done: 1, dropped: 0 });
    // A re-read with the same content keeps the list's identity.
    const first = state.items;
    await loadTodos();
    expect(readState().todos.items).toBe(first);

    // A write's answer and a create's are normalized the same way.
    await expect(updateTodo("other", { title: "새 제목" })).resolves.toEqual(renamed);
    await expect(createTodo({ title: "새 할 일" })).resolves.toEqual(added);
    state = readState().todos;
    expect(state.items).toEqual([late, renamed, added, done]);
    expect(state.counts).toEqual(counts({ open: 3, overdue: 1, done: 1 }));
    // And the next poll still sees the same rows, so it changes nothing.
    const settled = state.items;
    await loadTodos();
    expect(readState().todos.items).toBe(settled);
  });

  it("keeps a current server's legacy mirror off the items and fills absent counts with 0", () => {
    const dropped = closed("dropped", { id: "x" });
    // What the current server's toWireTodo sends: the item plus done (= closed) and completedAt.
    expect(fromWireTodo({ ...dropped, done: true, completedAt: dropped.closedAt })).toEqual(dropped);
    expect(Object.keys(fromWireTodo({ ...dropped, done: true, completedAt: dropped.closedAt }))).toEqual(Object.keys(dropped));
    // An unknown status falls back on the done mirror.
    expect(fromWireTodo({ ...legacy(closed("done")), status: "archived" }).status).toBe("done");
    expect(fromWireTodo(legacy(todo())).status).toBe("todo");
    expect(fromWireCounts(undefined)).toEqual(counts());
    expect(fromWireCounts({ open: 4, done: 2 })).toEqual(counts({ open: 4, done: 2 }));
  });
});

describe("live refresh after the avatar's to-do tools", () => {
  it("re-reads the list only when a tracked mcp__todo__* call ends OK", async () => {
    const fetchMock = useFetch(async (url) =>
      url === "/api/me/todos" ? jsonRes({ todos: [], todayKst: TODAY, counts: counts() }) : undefined,
    );
    const gets = () => fetchMock.mock.calls.filter(([url]) => url === "/api/me/todos").length;
    noteTodoToolStart("t1", "mcp__todo__add_todos");
    noteTodoToolStart("t2", "Bash");
    noteTodoToolStart("t3", "mcp__todo__update_todo");
    noteTodoToolEnd("t2", true);
    noteTodoToolEnd("t3", false);
    noteTodoToolEnd("unknown", true);
    await flush();
    expect(gets()).toBe(0);
    noteTodoToolEnd("t1", true);
    await flush();
    expect(gets()).toBe(1);
    // Each call refreshes once: a replayed tool_end is ignored.
    noteTodoToolEnd("t1", true);
    await flush();
    expect(gets()).toBe(1);
  });

  it("is wired into the run stream: a todo tool's tool_end refetches the list", async () => {
    const pane = {
      id: "p1",
      avatar: { id: "owner", alias: "", displayName: "나", isOwn: true } as never,
      conversationId: "conv-1",
      messages: [],
      draft: "",
      streaming: false,
      liveText: "",
      liveAttachments: [],
      liveTextBreakPending: false,
      liveThinking: "",
      thinkingActive: false,
      livePlan: "",
      planPending: false,
      planReview: null,
      planReviewSubmitting: false,
      liveStatus: "",
      liveRunId: null,
      liveAgents: [],
      liveTools: [],
      liveTasks: [],
      livePlugins: [],
      liveStatusStickyUntil: 0,
      groupKnowledgeOff: [],
      mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
      canvases: [],
      activeCanvasId: null,
      stickBottom: true,
      usage: null,
      abortController: null,
    } as unknown as ChatPane;
    updateState((state) => {
      state.chatPanes = [pane];
      state.activePaneId = "p1";
    });
    const enc = new TextEncoder();
    const frames = [
      ["tool", { toolUseId: "tu-1", name: "mcp__todo__add_todos", input: { items: [{ title: "x" }] } }],
      ["tool_end", { toolUseId: "tu-1", ok: true, output: "Added 1" }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let i = 0;
    const fetchMock = useFetch(async (url) => {
      if (url.includes("/api/chat/runs/run-1/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
              else {
                readState().chatPanes[0]?.abortController?.abort();
                controller.close();
              }
            },
          }),
        };
      }
      if (url === "/api/me/todos") return jsonRes({ todos: [todo({ id: "from-avatar", source: "avatar" })], todayKst: TODAY, counts: counts({ open: 1 }) });
      return jsonRes({ ok: true });
    });
    await attachRun("p1", "run-1");
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/me/todos")).toBe(true);
    expect(readState().todos.items.map((item) => item.id)).toEqual(["from-avatar"]);
  });
});

describe("avatar change motion", () => {
  /** A GET-only server whose list the test swaps out, as the avatar's tools would. */
  function listServer(list: () => TodoItem[]) {
    return useFetch(async (url, init) => {
      if (url !== "/api/me/todos" || init.method) return undefined;
      const items = list();
      return jsonRes({ todos: items, todayKst: TODAY, counts: countsOf(items) });
    });
  }

  let toolSeq = 0;
  /** An avatar's to-do tool finishing in the run stream; resolves once the re-read it started has applied. */
  async function avatarTool(name = "mcp__todo__add_todos"): Promise<void> {
    const id = `tu-${(toolSeq += 1)}`;
    noteTodoToolStart(id, name);
    noteTodoToolEnd(id, true);
    await loadTodos(); // joins the fresh read the tool end started
  }

  it("diffs the open list by id: the avatar's new or any reopened → added in display order, edited → changed, deleted or closed → departed", () => {
    const keep = todo({ id: "keep" });
    const edit = todo({ id: "edit" });
    const start = todo({ id: "start" });
    const gone = todo({ id: "gone" });
    const finish = todo({ id: "finish" });
    const drop = todo({ id: "drop", status: "in_progress" });
    const reopen = closed("done", { id: "reopen" });
    const undrop = closed("dropped", { id: "undrop" });
    const oldDone = closed("done", { id: "old-done" });
    const doneToDropped = closed("done", { id: "done-to-dropped" });
    const pending = todo({ id: "pending-1" });
    const later = "2026-10-09T02:00:00.000Z";
    const diff = diffAvatarChange(
      [keep, edit, start, gone, finish, drop, reopen, undrop, oldDone, doneToDropped, pending],
      [
        keep,
        { ...edit, title: "고친 제목", updatedAt: later },
        { ...start, status: "in_progress", updatedAt: later },
        { ...finish, status: "done", closedAt: later },
        { ...drop, status: "dropped", closedAt: later },
        { ...reopen, status: "todo", closedAt: null },
        { ...undrop, status: "in_progress", closedAt: null },
        oldDone,
        // Closed before and after: not on the open list either time.
        { ...doneToDropped, status: "dropped", closedAt: later },
        todo({ id: "new-undated", source: "avatar" }),
        todo({ id: "new-dated", dueDate: "2026-10-02", source: "avatar" }),
        // New rows the same GET carried from elsewhere are not the avatar's.
        todo({ id: "from-routine", source: "routine" }),
        todo({ id: "from-api", source: "api" }),
        todo({ id: "from-other-tab", source: "user" }),
      ],
    );
    expect(diff).toEqual({
      // The shared order: in progress first, then dated, then (same priority and age) by id.
      added: ["undrop", "new-dated", "new-undated", "reopen"],
      changed: ["start", "edit"],
      // An unconfirmed optimistic row never departs: its swap is the viewer's own add.
      departed: ["gone", "finish", "drop"],
    });
  });

  it("marks what the avatar's write changed: rows it added stagger in, edits wash, departures register once, the count pops", async () => {
    const keep = todo({ id: "keep" });
    const edit = todo({ id: "edit" });
    const gone = todo({ id: "gone" });
    seedTodos([keep, edit, gone]);
    listServer(() => [
      keep,
      { ...edit, title: "고친 제목", updatedAt: "2026-10-09T02:00:00.000Z" },
      todo({ id: "a-dated", dueDate: "2026-10-02", source: "avatar" }),
      todo({ id: "a-undated", source: "avatar" }),
    ]);
    await avatarTool();
    expect(get(todoActivity)).toEqual({
      seq: 1,
      pop: 1,
      marks: {
        "a-dated": { kind: "added", seq: 1, delay: 0 },
        "a-undated": { kind: "added", seq: 1, delay: TODO_ARRIVAL_STAGGER_MS },
        edit: { kind: "changed", seq: 1, delay: 0 },
      },
    });
    // The update that applied it is still flushing: the card's sibling glide keys on this.
    expect(avatarChangeFlushing()).toBe(true);
    await flush();
    expect(avatarChangeFlushing()).toBe(false);
    // The leaving row's out: transition asks once; nothing else counts as departed.
    expect(takeAvatarDeparture("gone")).toBe(true);
    expect(takeAvatarDeparture("gone")).toBe(false);
    expect(takeAvatarDeparture("keep")).toBe(false);
  });

  it("caps the stagger at the card's visible rows, and spots an addition the card has no row for", async () => {
    const seeded = Array.from({ length: 8 }, (_, i) => todo({ id: `s${i}`, dueDate: "2026-10-05" }));
    seedTodos(seeded);
    const added = Array.from({ length: 10 }, (_, i) => todo({ id: `n${i}`, dueDate: "2026-10-01", source: "avatar" }));
    listServer(() => [...seeded, ...added]);
    await avatarTool();
    const { marks } = get(todoActivity);
    expect(marks.n0.delay).toBe(0);
    expect(marks.n7.delay).toBe(7 * TODO_ARRIVAL_STAGGER_MS);
    expect(marks.n9.delay).toBe(7 * TODO_ARRIVAL_STAGGER_MS);
    const items = readState().todos.items;
    const { sections } = overlaySections(items, TODAY);
    // The 8 visible rows are all new; n8/n9 fell past them, so the footer pops for change 1.
    expect(todoHiddenArrivalSeq(sections, marks, items)).toBe(1);
    const onlyVisible = Object.fromEntries(Object.entries(marks).filter(([id]) => id !== "n8" && id !== "n9"));
    expect(todoHiddenArrivalSeq(sections, onlyVisible, items)).toBe(0);
    // A later change of the avatar's (an edit) leaves the footer's key on change 1.
    expect(todoHiddenArrivalSeq(sections, { ...marks, s0: { kind: "changed", seq: 2, delay: 0 } }, items)).toBe(1);
  });

  it("stays still for the first load, polls, list_todos, a failed write's resync and the viewer's own edits", async () => {
    let list = [todo({ id: "first" })];
    const fetchMock = listServer(() => list);
    // The first load has nothing to show a change against, even right after a tool end.
    await avatarTool();
    expect(readState().todos.items.map((item) => item.id)).toEqual(["first"]);
    // A poll that brings someone else's change.
    list = [...list, todo({ id: "from-poll" })];
    await loadTodos();
    // The avatar only READ the list.
    list = [...list, todo({ id: "while-listing" })];
    await avatarTool("mcp__todo__list_todos");
    expect(readState().todos.items.map((item) => item.id).sort()).toEqual(["first", "from-poll", "while-listing"]);
    // A failed write: rolled back, then resynced against a list that changed meanwhile.
    fetchMock.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      if (init.method === "PATCH") return jsonRes({ error: "서버 오류" }, 500);
      return jsonRes({ todos: [...list, todo({ id: "after-failure" })], todayKst: TODAY, counts: counts({ open: 4 }) });
    });
    await setTodoStatus("first", "done");
    await flush();
    expect(readState().todos.items.map((item) => item.id)).toContain("after-failure");
    // The viewer's own add, pending row swap included.
    fetchMock.mockImplementation(async () => jsonRes({ todo: todo({ id: "mine" }), todayKst: TODAY, counts: counts({ open: 5 }) }, 201));
    await createTodo({ title: "직접 추가" });
    expect(get(todoActivity)).toEqual(emptyTodoActivity());
    expect(takeAvatarDeparture("first")).toBe(false);
  });

  it("keeps the claim open until a read that started after the avatar's last write applies", async () => {
    seedTodos([todo({ id: "old" })]);
    const pollGet = deferred<unknown>();
    let gets = 0;
    useFetch(async (url, init) => {
      if (url !== "/api/me/todos" || init.method) return undefined;
      gets += 1;
      return gets === 1
        ? pollGet.promise
        : jsonRes({ todos: [todo({ id: "old" }), todo({ id: "added-by-avatar", source: "avatar" })], todayKst: TODAY, counts: counts({ open: 2 }) });
    });
    const poll = loadTodos();
    noteTodoToolStart("tu-x", "mcp__todo__add_todos");
    noteTodoToolEnd("tu-x", true);
    // The poll's answer predates the avatar's write: nothing to show yet.
    pollGet.resolve(jsonRes({ todos: [todo({ id: "old" })], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await poll;
    await flush();
    expect(gets).toBe(2);
    expect(get(todoActivity).marks).toEqual({ "added-by-avatar": { kind: "added", seq: 1, delay: 0 } });
  });

  it("never credits the viewer's own in-flight add to the avatar", async () => {
    seedTodos([todo({ id: "old" })]);
    const post = deferred<unknown>();
    useFetch(async (url, init) => {
      if (init.method === "POST") return post.promise;
      // The server already has the viewer's row while its POST answer is still on the way.
      return jsonRes({ todos: [todo({ id: "old" }), todo({ id: "srv-mine", title: "직접 추가" })], todayKst: TODAY, counts: counts({ open: 2 }) });
    });
    const creation = createTodo({ title: "직접 추가" });
    noteTodoToolStart("tu-y", "mcp__todo__update_todo");
    noteTodoToolEnd("tu-y", true); // deferred behind the write
    await loadTodos(); // a poll lands inside the write
    post.resolve(jsonRes({ todo: todo({ id: "srv-mine", title: "직접 추가" }), todayKst: TODAY, counts: counts({ open: 2 }) }, 201));
    await creation;
    await flush();
    expect(get(todoActivity).marks).toEqual({});
  });

  it("lets a failed re-read close the claim, so the next poll is never shown as the avatar's", async () => {
    seedTodos([todo({ id: "old" })]);
    let failing = true;
    useFetch(async (url, init) => {
      if (url !== "/api/me/todos" || init.method) return undefined;
      if (failing) return jsonRes({ error: "서버 오류" }, 500);
      // The poll brings a row the avatar added in ANOTHER tab's chat — avatar-made,
      // so only the closed claim (not the source rule) keeps it still here.
      return jsonRes({ todos: [todo({ id: "old" }), todo({ id: "other-tab-added", source: "avatar" })], todayKst: TODAY, counts: counts({ open: 2 }) });
    });
    noteTodoToolStart("tu-f", "mcp__todo__add_todos");
    noteTodoToolEnd("tu-f", true);
    await loadTodos().catch(() => {}); // the fresh read it started fails
    failing = false;
    await loadTodos(); // the 60 s poll
    expect(readState().todos.items.map((item) => item.id)).toEqual(["old", "other-tab-added"]);
    expect(get(todoActivity)).toEqual(emptyTodoActivity());
  });

  it("drops a claim nobody could show: a joined poll failed and the queued read never ran", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    seedTodos([todo({ id: "old" })]);
    const pollGet = deferred<unknown>();
    let gets = 0;
    useFetch(async (url, init) => {
      if (url !== "/api/me/todos" || init.method) return undefined;
      gets += 1;
      if (gets === 1) return pollGet.promise;
      return jsonRes({ todos: [todo({ id: "old" }), todo({ id: "later", source: "avatar" })], todayKst: TODAY, counts: counts({ open: 2 }) });
    });
    const poll = loadTodos();
    noteTodoToolStart("tu-j", "mcp__todo__add_todos");
    noteTodoToolEnd("tu-j", true); // joins the poll, which then fails
    pollGet.resolve(jsonRes({ error: "서버 오류" }, 500));
    await poll.catch(() => {});
    vi.advanceTimersByTime(60_000);
    await loadTodos(); // the next poll, a minute later
    expect(readState().todos.items.map((item) => item.id)).toEqual(["later", "old"]);
    expect(get(todoActivity)).toEqual(emptyTodoActivity());
  });

  it("still shows a change whose re-read started right after the tool end, however slow it answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    seedTodos([todo({ id: "old" })]);
    const slowGet = deferred<unknown>();
    useFetch(async (url, init) => (url === "/api/me/todos" && !init.method ? slowGet.promise : undefined));
    noteTodoToolStart("tu-s", "mcp__todo__add_todos");
    noteTodoToolEnd("tu-s", true); // its fresh read starts now…
    vi.advanceTimersByTime(10_000); // …and answers ten seconds later
    slowGet.resolve(jsonRes({ todos: [todo({ id: "old" }), todo({ id: "slow-add", source: "avatar" })], todayKst: TODAY, counts: counts({ open: 2 }) }));
    await loadTodos();
    expect(get(todoActivity).marks).toEqual({ "slow-add": { kind: "added", seq: 1, delay: 0 } });
  });

  it("applies the change even when a before-change listener throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = onBeforeAvatarChange(() => {
      throw new Error("boom");
    });
    try {
      seedTodos([todo({ id: "old" })]);
      listServer(() => [todo({ id: "old" }), todo({ id: "added", source: "avatar" })]);
      await avatarTool();
      expect(readState().todos.items.map((item) => item.id)).toEqual(["added", "old"]);
      expect(get(todoActivity).marks.added).toMatchObject({ kind: "added" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[todos]"), expect.any(Error));
    } finally {
      stop();
    }
  });

  it("closes the flush window and the departure at the viewer's own next write", async () => {
    const leaving = todo({ id: "leaving" });
    const stays = todo({ id: "stays" });
    seedTodos([leaving, stays]);
    listServer(() => [stays, { ...leaving, status: "dropped", closedAt: "2026-10-09T02:00:00.000Z" }]);
    await avatarTool("mcp__todo__update_todo");
    expect(avatarChangeFlushing()).toBe(true);
    useFetch(async (url, init) =>
      init.method === "PATCH" ? jsonRes({ todo: { ...stays, status: "done" }, todayKst: TODAY, counts: counts({ done: 1, dropped: 1 }) }) : undefined,
    );
    // A click handled before the window's timer: the viewer's own completion never glides.
    const own = setTodoStatus("stays", "done");
    expect(avatarChangeFlushing()).toBe(false);
    await own;
    // Reopening the row the avatar dropped makes any later exit of it the viewer's.
    useFetch(async (url, init) =>
      init.method === "PATCH" ? jsonRes({ todo: leaving, todayKst: TODAY, counts: counts({ open: 1, done: 1 }) }) : undefined,
    );
    await setTodoStatus("leaving", "todo");
    expect(takeAvatarDeparture("leaving")).toBe(false);
  });

  it("lets the motion expire after TODO_ACTIVITY_MS, and logout forgets it at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const gone = todo({ id: "gone" });
    seedTodos([gone]);
    listServer(() => [todo({ id: "new", source: "avatar" })]);
    await avatarTool("mcp__todo__delete_todo");
    expect(get(todoActivity)).toMatchObject({ seq: 1, pop: 1, marks: { new: { kind: "added" } } });
    vi.advanceTimersByTime(TODO_ACTIVITY_MS);
    // A card opened (or a composer remounted) now replays nothing; the unconsumed departure is gone too.
    expect(get(todoActivity)).toEqual({ seq: 1, pop: 0, marks: {} });
    expect(takeAvatarDeparture("gone")).toBe(false);

    seedTodos([todo({ id: "again" })]);
    listServer(() => []);
    await avatarTool("mcp__todo__delete_todo");
    expect(get(todoActivity).pop).toBe(2);
    stopKnowledgeWatch();
    expect(get(todoActivity)).toEqual(emptyTodoActivity());
    expect(takeAvatarDeparture("again")).toBe(false);
  });
});

describe("overlay switch", () => {
  it("persists on/off per browser and asks for focus only on an explicit toggle", () => {
    setTodoOverlayOpen(true, { focus: true });
    expect(readState().todoOverlayOpen).toBe(true);
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBe("true");
    expect(loadTodoOverlayOpen()).toBe(true);
    expect(consumeTodoOverlayFocus()).toBe(true);
    expect(consumeTodoOverlayFocus()).toBe(false);
    setTodoOverlayOpen(false);
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBeNull();
    expect(loadTodoOverlayOpen()).toBe(false);
  });

  it("a transient dismissal hides the card for now and never touches the stored preference", () => {
    setTodoOverlayOpen(true);
    dismissTodoOverlay(); // outside click / Escape on a popover or sheet
    expect(readState()).toMatchObject({ todoOverlayOpen: true, todoOverlayDismissed: true });
    expect(todoOverlayVisible(readState())).toBe(false);
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBe("true");
    expect(loadTodoOverlayOpen()).toBe(true); // a reload brings the card back
    restoreTodoOverlay(); // the column widened back to pinned
    expect(todoOverlayVisible(readState())).toBe(true);
    dismissTodoOverlay();
    setTodoOverlayOpen(true, { focus: true }); // the composer toggle shows it again
    expect(todoOverlayVisible(readState())).toBe(true);
    expect(consumeTodoOverlayFocus()).toBe(true);
    dismissTodoOverlay();
    stopKnowledgeWatch(); // logout forgets a dismissal, keeps the per-browser preference
    expect(readState()).toMatchObject({ todoOverlayOpen: true, todoOverlayDismissed: false });
  });

  it("keeps working when storage throws (private mode, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadTodoOverlayOpen()).toBe(false);
    expect(() => setTodoOverlayOpen(true)).not.toThrow();
    expect(readState().todoOverlayOpen).toBe(true);
  });
});
