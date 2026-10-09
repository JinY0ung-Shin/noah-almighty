import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { calendarDateWeekday, kstDateString, normalizeCalendarDate } from "../src/server/routineSchedule.js";
import { parseNewTodo, parseTodoPatch } from "../src/server/todos.js";
import {
  MAX_LISTED_DONE_TODOS,
  MAX_OPEN_TODOS,
  MAX_TODO_TITLE_LENGTH,
  compareTodos,
  todoDueBucket,
  type TodoItem,
} from "../src/shared/todos.js";
import { signup, withTempDir } from "./helpers.js";

const dir = withTempDir("todos");
let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function boot() {
  services = createServices({ dataDir: dir(), agentRuntime: "local", sessionSecret: "test" });
  return services;
}

const item = (title: string, extra: Record<string, unknown> = {}) => {
  const parsed = parseNewTodo({ title, ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("todo input parsing", () => {
  it("normalizes a new item and applies defaults", () => {
    expect(parseNewTodo({ title: "  보고서\n 초안   작성 " })).toEqual({
      ok: true,
      value: { title: "보고서 초안 작성", note: "", priority: "normal", dueDate: null, tags: [] },
    });
    expect(
      parseNewTodo({ title: "t", note: " a\r\nb ", priority: "high", dueDate: " 2026-10-09 ", tags: ["#기획", " 기획 ", "Q4 리뷰"] }),
    ).toEqual({
      ok: true,
      value: { title: "t", note: "a\nb", priority: "high", dueDate: "2026-10-09", tags: ["기획", "Q4-리뷰"] },
    });
    // Due date and priority are optional: null/"" mean "none"/"default".
    expect(parseNewTodo({ title: "t", dueDate: "", priority: null })).toMatchObject({
      ok: true,
      value: { dueDate: null, priority: "normal" },
    });
  });

  it("rejects bad fields with a code per field", () => {
    expect(parseNewTodo({})).toEqual({ ok: false, error: "TITLE_REQUIRED" });
    expect(parseNewTodo({ title: "   " })).toEqual({ ok: false, error: "TITLE_REQUIRED" });
    expect(parseNewTodo({ title: "x".repeat(MAX_TODO_TITLE_LENGTH + 1) })).toEqual({ ok: false, error: "TITLE_TOO_LONG" });
    expect(parseNewTodo({ title: "t", note: 3 })).toEqual({ ok: false, error: "INVALID_NOTE" });
    expect(parseNewTodo({ title: "t", note: "x".repeat(4001) })).toEqual({ ok: false, error: "NOTE_TOO_LONG" });
    expect(parseNewTodo({ title: "t", priority: "urgent" })).toEqual({ ok: false, error: "INVALID_PRIORITY" });
    expect(parseNewTodo({ title: "t", dueDate: "2026-02-31" })).toEqual({ ok: false, error: "INVALID_DUE_DATE" });
    expect(parseNewTodo({ title: "t", dueDate: "10/09" })).toEqual({ ok: false, error: "INVALID_DUE_DATE" });
    expect(parseNewTodo({ title: "t", tags: "a,b" })).toEqual({ ok: false, error: "INVALID_TAGS" });
    expect(parseNewTodo({ title: "t", tags: ["a", 1] })).toEqual({ ok: false, error: "INVALID_TAGS" });
    expect(parseNewTodo({ title: "t", tags: ["a", "b", "c", "d", "e", "f"] })).toEqual({ ok: false, error: "INVALID_TAGS" });
    // Duplicates collapse before the cap is counted.
    expect(parseNewTodo({ title: "t", tags: ["a", "A", "b", "c", "d", "e"] })).toMatchObject({ ok: true });
  });

  it("parses a patch: absent keys are untouched, null clears the due date", () => {
    expect(parseTodoPatch({})).toEqual({ ok: false, error: "EMPTY_PATCH" });
    expect(parseTodoPatch({ unknown: 1 })).toEqual({ ok: false, error: "EMPTY_PATCH" });
    expect(parseTodoPatch({ done: "true" })).toEqual({ ok: false, error: "INVALID_DONE" });
    expect(parseTodoPatch({ title: "" })).toEqual({ ok: false, error: "TITLE_REQUIRED" });
    expect(parseTodoPatch({ dueDate: null, done: true })).toEqual({ ok: true, value: { dueDate: null, done: true } });
    expect(parseTodoPatch({ note: "", tags: [] })).toEqual({ ok: true, value: { note: "", tags: [] } });
  });
});

describe("KST calendar helpers", () => {
  it("rolls the KST date over at 15:00 UTC and validates real dates", () => {
    expect(kstDateString(new Date("2026-10-09T14:59:59.000Z"))).toBe("2026-10-09");
    expect(kstDateString(new Date("2026-10-09T15:00:00.000Z"))).toBe("2026-10-10");
    expect(normalizeCalendarDate(" 2028-02-29 ")).toBe("2028-02-29");
    expect(normalizeCalendarDate("2027-02-29")).toBe(null);
    expect(calendarDateWeekday("2026-10-09")).toBe(5);
    expect(calendarDateWeekday("nope")).toBe(null);
  });
});

describe("shared todo ordering", () => {
  const base: TodoItem = {
    id: "x", title: "t", note: "", done: false, priority: "normal", dueDate: null, tags: [],
    source: "user", sourceConversationId: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", completedAt: null,
  };
  it("orders open by due date (dated first), then priority, then age; done newest first", () => {
    const items: TodoItem[] = [
      { ...base, id: "undated-high", priority: "high" },
      { ...base, id: "late", dueDate: "2026-10-20" },
      { ...base, id: "soon-low", dueDate: "2026-10-08", priority: "low" },
      { ...base, id: "soon-high", dueDate: "2026-10-08", priority: "high" },
      { ...base, id: "done-old", done: true, completedAt: "2026-10-02T00:00:00.000Z" },
      { ...base, id: "done-new", done: true, completedAt: "2026-10-05T00:00:00.000Z" },
      { ...base, id: "undated-normal-newer", createdAt: "2026-10-03T00:00:00.000Z" },
    ];
    expect([...items].sort(compareTodos).map((t) => t.id)).toEqual([
      "soon-high", "soon-low", "late", "undated-high", "undated-normal-newer", "done-new", "done-old",
    ]);
    expect(todoDueBucket("2026-10-08", "2026-10-09")).toBe("overdue");
    expect(todoDueBucket("2026-10-09", "2026-10-09")).toBe("today");
    expect(todoDueBucket("2026-10-10", "2026-10-09")).toBe("upcoming");
    expect(todoDueBucket(null, "2026-10-09")).toBe("none");
  });
});

describe("todo store", () => {
  it("creates in caller order, counts against a pinned today, and stamps completion", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const created = store.createTodos(
      owner.id,
      [item("b"), item("a"), item("overdue", { dueDate: "2026-10-01" }), item("today", { dueDate: "2026-10-09" })],
      { source: "avatar" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.todos.map((t) => t.title)).toEqual(["b", "a", "overdue", "today"]);
    expect(created.todos.every((t) => t.source === "avatar" && !t.done)).toBe(true);
    // Undated items keep their insertion order (one batch, stamped in order).
    expect(store.listTodos(owner.id).map((t) => t.title)).toEqual(["overdue", "today", "b", "a"]);
    expect(store.countTodos(owner.id, "2026-10-09")).toEqual({ open: 4, overdue: 1, dueToday: 1, done: 0 });

    const target = created.todos[0];
    const done = store.updateTodo(owner.id, target.id, { done: true });
    expect(done.ok && done.todo.done && typeof done.todo.completedAt === "string").toBe(true);
    // Editing another field keeps the completion stamp.
    const edited = store.updateTodo(owner.id, target.id, { note: "memo" });
    expect(edited.ok && done.ok && edited.todo.completedAt === done.todo.completedAt).toBe(true);
    const reopened = store.updateTodo(owner.id, target.id, { done: false, dueDate: "2026-10-10" });
    expect(reopened.ok && reopened.todo.completedAt === null && reopened.todo.dueDate === "2026-10-10").toBe(true);
    const cleared = store.updateTodo(owner.id, target.id, { dueDate: null });
    expect(cleared.ok && cleared.todo.dueDate === null && cleared.todo.note === "memo").toBe(true);

    expect(store.updateTodo(owner.id, "missing", { done: true })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(store.deleteTodo(owner.id, target.id)).toBe(true);
    expect(store.deleteTodo(owner.id, target.id)).toBe(false);
  });

  it("isolates owners and refuses a batch or a reopen past the open cap", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const mine = store.createTodos(owner.id, [item("mine")], { source: "user" });
    if (!mine.ok) throw new Error("create failed");
    expect(store.getTodo(other.id, mine.todos[0].id)).toBe(null);
    expect(store.updateTodo(other.id, mine.todos[0].id, { done: true })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(store.deleteTodo(other.id, mine.todos[0].id)).toBe(false);
    expect(store.listTodos(other.id)).toEqual([]);

    const fill = Array.from({ length: MAX_OPEN_TODOS - 1 }, (_, i) => item(`fill ${i}`));
    expect(store.createTodos(owner.id, fill, { source: "user" }).ok).toBe(true);
    // All-or-nothing: two more would cross the cap, so neither lands.
    expect(store.createTodos(owner.id, [item("x"), item("y")], { source: "user" })).toEqual({ ok: false, error: "LIMIT" });
    expect(store.countTodos(owner.id, "2026-10-09").open).toBe(MAX_OPEN_TODOS);
    expect(store.updateTodo(owner.id, mine.todos[0].id, { done: true }).ok).toBe(true);
    expect(store.createTodos(owner.id, [item("last")], { source: "user" }).ok).toBe(true);
    // At the cap again, reopening the completed one is refused like a new item.
    expect(store.updateTodo(owner.id, mine.todos[0].id, { done: false })).toEqual({ ok: false, error: "LIMIT" });
  });

  it("lists only the newest completed items and clears all of them", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const batch = store.createTodos(
      owner.id,
      Array.from({ length: MAX_LISTED_DONE_TODOS + 3 }, (_, i) => item(`d${i}`)),
      { source: "user" },
    );
    if (!batch.ok) throw new Error("create failed");
    for (const todo of batch.todos) store.updateTodo(owner.id, todo.id, { done: true });
    store.createTodos(owner.id, [item("open one")], { source: "user" });
    const listed = store.listTodos(owner.id);
    expect(listed[0].title).toBe("open one");
    expect(listed.filter((t) => t.done)).toHaveLength(MAX_LISTED_DONE_TODOS);
    expect(store.countTodos(owner.id, "2026-10-09").done).toBe(MAX_LISTED_DONE_TODOS + 3);
    expect(store.clearCompletedTodos(owner.id)).toBe(MAX_LISTED_DONE_TODOS + 3);
    expect(store.listTodos(owner.id).map((t) => t.title)).toEqual(["open one"]);
  });

  it("drops the source conversation link once it is gone or not the owner's", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    store.touchConversation(owner.id, "conv-owner", owner.id, "hi");
    store.touchConversation(other.id, "conv-other", other.id, "hi");
    const linked = store.createTodos(owner.id, [item("linked")], { source: "avatar", conversationId: "conv-owner" });
    const foreign = store.createTodos(owner.id, [item("foreign")], { source: "avatar", conversationId: "conv-other" });
    if (!linked.ok || !foreign.ok) throw new Error("create failed");
    expect(linked.todos[0].sourceConversationId).toBe("conv-owner");
    expect(foreign.todos[0].sourceConversationId).toBe(null);
    expect(store.deleteConversation(owner.id, "conv-owner")).toBe(true);
    const after = store.getTodo(owner.id, linked.todos[0].id);
    expect(after?.title).toBe("linked");
    expect(after?.sourceConversationId).toBe(null);
  });

  it("is removed with its owner by deleteUser", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.createTodos(owner.id, [item("gone")], { source: "user" });
    expect(store.deleteUser(owner.id)).toBe(true);
    expect(store.listTodos(owner.id)).toEqual([]);
    expect(store.countTodos(owner.id, "2026-10-09").open).toBe(0);
  });
});

describe("/api/me/todos", () => {
  async function setup() {
    const app = createApp(boot());
    const alice = request.agent(app);
    const bob = request.agent(app);
    await signup(alice, "alice").expect(201);
    await signup(bob, "bob").expect(201);
    return { app, alice, bob };
  }

  it("requires a session and never caches", async () => {
    const { app, alice } = await setup();
    await request(app).get("/api/me/todos").expect(401);
    await request(app).post("/api/me/todos").send({ title: "x" }).expect(401);
    // A personal API key (the external task API's Bearer) is never a session here.
    const key = (await alice.post("/api/me/avatar-api-keys").send({ name: "todo-probe" }).expect(201)).body.token as string;
    expect(key).toMatch(/^noah_/);
    await request(app).get("/api/me/todos").set("Authorization", `Bearer ${key}`).expect(401);
    await request(app).post("/api/me/todos").set("Authorization", `Bearer ${key}`).send({ title: "x" }).expect(401);
    const res = await alice.get("/api/me/todos").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      todos: [],
      todayKst: kstDateString(),
      counts: { open: 0, overdue: 0, dueToday: 0, done: 0 },
    });
  });

  it("creates, edits, completes, deletes and clears with a fresh snapshot each time", async () => {
    const { alice } = await setup();
    const today = kstDateString();
    const created = await alice
      .post("/api/me/todos")
      .send({ title: "리뷰 답변", dueDate: today, priority: "high", tags: ["리뷰"] })
      .expect(201);
    expect(created.body.todo).toMatchObject({
      title: "리뷰 답변", dueDate: today, priority: "high", tags: ["리뷰"], done: false, source: "user", sourceConversationId: null,
    });
    expect(created.body.counts).toEqual({ open: 1, overdue: 0, dueToday: 1, done: 0 });
    const id = created.body.todo.id as string;

    const patched = await alice.patch(`/api/me/todos/${id}`).send({ dueDate: null, note: "메모" }).expect(200);
    expect(patched.body.todo).toMatchObject({ dueDate: null, note: "메모" });
    expect(patched.body.counts.dueToday).toBe(0);

    const completed = await alice.patch(`/api/me/todos/${id}`).send({ done: true }).expect(200);
    expect(completed.body.todo.done).toBe(true);
    expect(completed.body.counts).toMatchObject({ open: 0, done: 1 });

    const second = (await alice.post("/api/me/todos").send({ title: "두 번째" }).expect(201)).body.todo.id as string;
    const deleted = await alice.delete(`/api/me/todos/${second}`).expect(200);
    expect(deleted.body).toMatchObject({ ok: true, counts: { open: 0, done: 1 } });
    await alice.delete(`/api/me/todos/${second}`).expect(404);

    // A body-less POST (what a plain cross-page form can send) never clears.
    await alice.post("/api/me/todos/clear-completed").expect(404);
    await alice.post("/api/me/todos/completed").expect(404);
    expect((await alice.get("/api/me/todos").expect(200)).body.counts.done).toBe(1);
    const cleared = await alice.delete("/api/me/todos/completed").expect(200);
    expect(cleared.body).toMatchObject({ removed: 1, counts: { open: 0, done: 0 } });
    expect((await alice.get("/api/me/todos").expect(200)).body.todos).toEqual([]);
  });

  it("answers validation, foreign ids and the open cap in Korean", async () => {
    const { alice, bob } = await setup();
    expect((await alice.post("/api/me/todos").send({ title: " " }).expect(400)).body.error).toBe("할 일 제목을 입력해 주세요.");
    expect((await alice.post("/api/me/todos").send({ title: "t", dueDate: "2026-13-01" }).expect(400)).body.error).toContain("마감일");
    const id = (await alice.post("/api/me/todos").send({ title: "alice only" }).expect(201)).body.todo.id as string;
    expect((await alice.patch(`/api/me/todos/${id}`).send({}).expect(400)).body.error).toBe("변경할 내용이 없습니다.");
    await bob.patch(`/api/me/todos/${id}`).send({ done: true }).expect(404);
    await bob.delete(`/api/me/todos/${id}`).expect(404);
    expect((await bob.get("/api/me/todos").expect(200)).body.todos).toEqual([]);

    const aliceUser = services!.store.getUserByUsername("alice")!;
    services!.store.createTodos(
      aliceUser.id,
      Array.from({ length: MAX_OPEN_TODOS - 1 }, (_, i) => item(`fill ${i}`)),
      { source: "user" },
    );
    expect((await alice.post("/api/me/todos").send({ title: "over" }).expect(409)).body.error).toContain(`${MAX_OPEN_TODOS}개`);
    // At the cap, reopening a completed item is refused in reopen wording, not "add" wording.
    await alice.patch(`/api/me/todos/${id}`).send({ done: true }).expect(200);
    await alice.post("/api/me/todos").send({ title: "last" }).expect(201);
    const reopen = (await alice.patch(`/api/me/todos/${id}`).send({ done: false }).expect(409)).body.error as string;
    expect(reopen).toContain("다시 열 수 없어 아무것도 바뀌지 않았습니다");
    expect(reopen).not.toContain("추가해 주세요");
  });
});
