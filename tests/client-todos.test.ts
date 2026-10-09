// @vitest-environment jsdom
// The client half of 할 일: the ONE store slice the tab, the chat overlay and the
// rail badge share. Pins the optimistic-write contract (change first, roll back
// + toast + resync on failure), the snapshot rule (every response's
// {todayKst, counts} wins), stale-load protection, the live refresh when an
// avatar's mcp__todo__* call finishes, and storage-failure tolerance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import {
  clearCompletedTodos,
  completeTodoWithUndo,
  createTodo,
  deleteTodo,
  dismissTodoOverlay,
  dueLabel,
  emptyTodoState,
  isPendingTodo,
  loadTodos,
  matchesTodoFilter,
  matchesTodoQuery,
  noteTodoToolEnd,
  noteTodoToolStart,
  overlaySections,
  parseTagInput,
  resetTodoClientState,
  restoreTodoOverlay,
  setTodoDone,
  setTodoOverlayOpen,
  consumeTodoOverlayFocus,
  todoFilterCounts,
  todoOverlayMode,
  todoOverlayVisible,
  todoSeedText,
  updateTodo,
  TODO_OVERLAY_PINNED_MIN_WIDTH,
} from "../src/client/src/lib/todos.js";
import { loadTodoOverlayOpen } from "../src/client/src/lib/layout.js";
import { attachRun } from "../src/client/src/lib/chat.js";
import { startKnowledgeWatch, stopKnowledgeWatch } from "../src/client/src/lib/loaders.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { TodoCounts, TodoItem } from "../src/shared/todos.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const TODAY = "2026-10-09";

function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2)}`,
    title: "보고서 초안",
    note: "",
    done: false,
    priority: "normal",
    dueDate: null,
    tags: [],
    source: "user",
    sourceConversationId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function counts(overrides: Partial<TodoCounts> = {}): TodoCounts {
  return { open: 0, overdue: 0, dueToday: 0, done: 0, ...overrides };
}

function seedTodos(items: TodoItem[], snapshot: Partial<{ todayKst: string; counts: TodoCounts }> = {}) {
  updateState((state) => {
    state.todos = {
      items,
      todayKst: snapshot.todayKst ?? TODAY,
      counts: snapshot.counts ?? counts({ open: items.filter((i) => !i.done).length, done: items.filter((i) => i.done).length }),
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

  it("filters: 오늘 = overdue + today, 예정 = future, 전체 = open only, 완료 = done", () => {
    const overdue = todo({ dueDate: "2026-10-01" });
    const today = todo({ dueDate: TODAY });
    const later = todo({ dueDate: "2026-11-01" });
    const undated = todo();
    const done = todo({ done: true, dueDate: "2026-10-01" });
    const all = [overdue, today, later, undated, done];
    const pick = (filter: Parameters<typeof matchesTodoFilter>[1]) => all.filter((item) => matchesTodoFilter(item, filter, TODAY));
    expect(pick("today")).toEqual([overdue, today]);
    expect(pick("upcoming")).toEqual([later]);
    expect(pick("overdue")).toEqual([overdue]);
    expect(pick("all")).toEqual([overdue, today, later, undated]);
    expect(pick("done")).toEqual([done]);
    // 완료 trusts the server's count — a listing only carries the newest done items.
    expect(todoFilterCounts(all, counts({ done: 250 }), TODAY)).toEqual({ today: 2, upcoming: 1, overdue: 1, all: 4, done: 250 });
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
      todo({ id: "d1", done: true }),
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
    const result = setTodoDone("a1", true);
    expect(readState().todos.items[0]).toMatchObject({ done: true });
    expect(readState().todos.items[0].completedAt).toBeTruthy();
    expect(readState().todos.counts).toEqual(counts({ open: 0, dueToday: 0, done: 1 }));

    gate.resolve(jsonRes({ error: "서버 내부 오류가 발생했습니다." }, 500));
    await expect(result).resolves.toBeNull();
    expect(readState().todos.items[0]).toEqual(item);
    expect(readState().todos.counts).toMatchObject({ open: 1, dueToday: 1, done: 0 });
    expect(lastToast().message).toContain("할 일을 완료하지 못했습니다");
    await flush();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/me/todos" && !init?.method)).toBe(true);
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
          : jsonRes({ todos: [{ ...item, done: true }], todayKst: TODAY, counts: counts({ done: 1 }) });
      }
      return undefined;
    });
    const write = setTodoDone("r1", true);
    const poll = loadTodos(); // the 60 s poll, started after the write
    // A gateway timeout: the server may still have applied the change.
    patchGate.resolve(jsonRes({ error: "시간 초과" }, 504));
    await expect(write).resolves.toBeNull();
    expect(readState().todos.items[0].done).toBe(false);
    pollGate.resolve(jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await poll;
    await flush();
    // The poll overlapped the write and was dropped; the failure's fresh read ran behind it.
    expect(gets).toBe(2);
    expect(readState().todos.items[0].done).toBe(true);
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
        return jsonRes({ todos: [a, { ...b, done: true }, { ...c, done: true }], todayKst: TODAY, counts: counts({ open: 1, done: 2 }) });
      }
      return undefined;
    });
    const writeA = setTodoDone("a", true);
    const writeB = setTodoDone("b", true);
    gates.a.resolve(jsonRes({ error: "서버 오류" }, 500));
    await expect(writeA).resolves.toBeNull();
    await flush();
    // A's resync is owed, but B is still in flight: a GET now would only be dropped as stale.
    expect(gets).toBe(0);
    const writeC = setTodoDone("c", true);
    gates.b.resolve(jsonRes({ todo: { ...b, done: true }, todayKst: TODAY, counts: counts({ open: 2, done: 1 }) }));
    await writeB;
    await flush();
    expect(gets).toBe(0); // C is still in flight
    gates.c.resolve(jsonRes({ todo: { ...c, done: true }, todayKst: TODAY, counts: counts({ open: 1, done: 2 }) }));
    await writeC;
    await flush();
    expect(gets).toBe(1); // the last write to settle started it — one GET, none wasted
    expect(readState().todos.items.map((item) => `${item.id}:${item.done}`).sort()).toEqual(["a:false", "b:true", "c:true"]);
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

  it("offers 되돌리기 after a completion, and the action reopens the item", async () => {
    const item = todo({ id: "u1" });
    seedTodos([item]);
    const patches: unknown[] = [];
    useFetch(async (url, init) => {
      if (init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        const next = { ...item, done: body.done, completedAt: body.done ? "2026-10-09T01:00:00.000Z" : null };
        return jsonRes({ todo: next, todayKst: TODAY, counts: counts({ open: body.done ? 0 : 1, done: body.done ? 1 : 0 }) });
      }
      return undefined;
    });
    await completeTodoWithUndo(item);
    const toast = lastToast();
    expect(toast).toMatchObject({ kind: "ok", actionLabel: "되돌리기" });
    expect(toast.message).toContain("보고서 초안");
    toast.action?.();
    await flush();
    await flush();
    expect(patches).toEqual([{ done: true }, { done: false }]);
    expect(readState().todos.items[0].done).toBe(false);
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
    seedTodos([todo({ id: "open" }), todo({ id: "done", done: true })], { counts: counts({ open: 1, done: 7 }) });
    replaceState({ todoSelectedId: "done" });
    useFetch(async (url, init) =>
      url === "/api/me/todos/completed" && init.method === "DELETE"
        ? jsonRes({ removed: 7, todayKst: TODAY, counts: counts({ open: 1 }) })
        : undefined,
    );
    await expect(clearCompletedTodos()).resolves.toBe(7);
    expect(readState().todos.items.map((item) => item.id)).toEqual(["open"]);
    expect(readState().todos.counts.done).toBe(0);
    expect(readState().todoSelectedId).toBe("");
  });

  it("ignores actions on an unconfirmed (pending) row", async () => {
    seedTodos([todo({ id: "pending-123" })]);
    const fetchMock = useFetch(async () => undefined);
    await expect(setTodoDone("pending-123", true)).resolves.toBeNull();
    await expect(deleteTodo("pending-123")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loads", () => {
  it("replaces the slice with the server's list, sorted in the shared order", async () => {
    useFetch(async (url) =>
      url === "/api/me/todos"
        ? jsonRes({
            todos: [todo({ id: "undated" }), todo({ id: "dated", dueDate: "2026-10-01" }), todo({ id: "done", done: true })],
            todayKst: TODAY,
            counts: counts({ open: 2, overdue: 1, done: 1 }),
          })
        : undefined,
    );
    await loadTodos();
    expect(readState().todos).toMatchObject({ loaded: true, todayKst: TODAY, counts: counts({ open: 2, overdue: 1, done: 1 }) });
    expect(readState().todos.items.map((item) => item.id)).toEqual(["dated", "undated", "done"]);
  });

  it("discards a GET that started before a write, so it cannot undo the optimistic change", async () => {
    const item = todo({ id: "a" });
    seedTodos([item]);
    const staleGet = deferred<unknown>();
    useFetch(async (url, init) => {
      if (url === "/api/me/todos" && !init.method) return staleGet.promise;
      if (init.method === "PATCH") return jsonRes({ todo: { ...item, done: true }, todayKst: TODAY, counts: counts({ done: 1 }) });
      return undefined;
    });
    const load = loadTodos();
    await setTodoDone("a", true);
    staleGet.resolve(jsonRes({ todos: [item], todayKst: TODAY, counts: counts({ open: 1 }) }));
    await load;
    expect(readState().todos.items[0].done).toBe(true);
    expect(readState().todos.counts.done).toBe(1);
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
