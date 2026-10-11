import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { calendarDateWeekday, kstDateString, normalizeCalendarDate } from "../src/server/routineSchedule.js";
import type { Store } from "../src/server/store.js";
import { parseNewTodo, parseTodoPatch } from "../src/server/todos.js";
import {
  MAX_LISTED_CLOSED_TODOS,
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
  vi.useRealTimers();
  services?.store.close();
  services = undefined;
});

/** The raw better-sqlite3 handle, for the `done` mirror and columns the API never exposes. */
function rawDb(store: Store): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

const ZERO_COUNTS = { open: 0, inProgress: 0, overdue: 0, dueToday: 0, done: 0, dropped: 0 };

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
      value: { title: "보고서 초안 작성", note: "", status: "todo", priority: "normal", dueDate: null, tags: [] },
    });
    expect(
      parseNewTodo({ title: "t", note: " a\r\nb ", priority: "high", dueDate: " 2026-10-09 ", tags: ["#기획", " 기획 ", "Q4 리뷰"] }),
    ).toEqual({
      ok: true,
      value: { title: "t", note: "a\nb", status: "todo", priority: "high", dueDate: "2026-10-09", tags: ["기획", "Q4-리뷰"] },
    });
    // Due date, priority and status are optional: null/"" mean "none"/"default".
    expect(parseNewTodo({ title: "t", dueDate: "", priority: null, status: "" })).toMatchObject({
      ok: true,
      value: { dueDate: null, priority: "normal", status: "todo" },
    });
  });

  it("creates an item open only: todo or in progress", () => {
    expect(parseNewTodo({ title: "t", status: "in_progress" })).toMatchObject({ ok: true, value: { status: "in_progress" } });
    expect(parseNewTodo({ title: "t", status: "done" })).toEqual({ ok: false, error: "INVALID_STATUS" });
    expect(parseNewTodo({ title: "t", status: "dropped" })).toEqual({ ok: false, error: "INVALID_STATUS" });
    expect(parseNewTodo({ title: "t", status: "paused" })).toEqual({ ok: false, error: "INVALID_STATUS" });
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
    expect(parseTodoPatch({ title: "" })).toEqual({ ok: false, error: "TITLE_REQUIRED" });
    expect(parseTodoPatch({ dueDate: null, status: "in_progress" })).toEqual({
      ok: true,
      value: { dueDate: null, status: "in_progress" },
    });
    expect(parseTodoPatch({ status: "dropped" })).toEqual({ ok: true, value: { status: "dropped" } });
    expect(parseTodoPatch({ status: "paused" })).toEqual({ ok: false, error: "INVALID_STATUS" });
    expect(parseTodoPatch({ status: null })).toEqual({ ok: false, error: "INVALID_STATUS" });
    expect(parseTodoPatch({ note: "", tags: [] })).toEqual({ ok: true, value: { note: "", tags: [] } });
  });

  it("maps the legacy done flag an older bundle still sends onto a status", () => {
    expect(parseTodoPatch({ done: true })).toEqual({ ok: true, value: { status: "done" } });
    expect(parseTodoPatch({ done: false, note: "n" })).toEqual({ ok: true, value: { note: "n", status: "todo" } });
    expect(parseTodoPatch({ done: "true" })).toEqual({ ok: false, error: "INVALID_DONE" });
    // Both at once is ambiguous, whether they agree or not.
    expect(parseTodoPatch({ status: "done", done: true })).toEqual({ ok: false, error: "INVALID_STATUS" });
    expect(parseTodoPatch({ status: "todo", done: true })).toEqual({ ok: false, error: "INVALID_STATUS" });
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
    id: "x", title: "t", note: "", status: "todo", priority: "normal", dueDate: null, tags: [],
    source: "user", sourceConversationId: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", closedAt: null,
  };
  it("orders open by due date (dated first), then priority, then age; closed newest first", () => {
    const items: TodoItem[] = [
      { ...base, id: "undated-high", priority: "high" },
      { ...base, id: "late", dueDate: "2026-10-20" },
      { ...base, id: "soon-low", dueDate: "2026-10-08", priority: "low" },
      { ...base, id: "soon-high", dueDate: "2026-10-08", priority: "high" },
      { ...base, id: "done-old", status: "done", closedAt: "2026-10-02T00:00:00.000Z" },
      { ...base, id: "done-new", status: "done", closedAt: "2026-10-05T00:00:00.000Z" },
      { ...base, id: "dropped-mid", status: "dropped", closedAt: "2026-10-03T00:00:00.000Z" },
      { ...base, id: "undated-normal-newer", createdAt: "2026-10-03T00:00:00.000Z" },
    ];
    // Done and dropped interleave by when they were closed.
    expect([...items].sort(compareTodos).map((t) => t.id)).toEqual([
      "soon-high", "soon-low", "late", "undated-high", "undated-normal-newer", "done-new", "dropped-mid", "done-old",
    ]);
    expect(todoDueBucket("2026-10-08", "2026-10-09")).toBe("overdue");
    expect(todoDueBucket("2026-10-09", "2026-10-09")).toBe("today");
    expect(todoDueBucket("2026-10-10", "2026-10-09")).toBe("upcoming");
    expect(todoDueBucket(null, "2026-10-09")).toBe("none");
  });

  it("puts in-progress items first, whatever their due date", () => {
    const items: TodoItem[] = [
      { ...base, id: "overdue-todo", dueDate: "2026-10-01", priority: "high" },
      { ...base, id: "undated-progress", status: "in_progress" },
      { ...base, id: "dated-progress", status: "in_progress", dueDate: "2026-10-30" },
      { ...base, id: "dropped", status: "dropped", closedAt: "2026-10-05T00:00:00.000Z" },
    ];
    expect([...items].sort(compareTodos).map((t) => t.id)).toEqual([
      "dated-progress", "undated-progress", "overdue-todo", "dropped",
    ]);
  });
});

describe("todo store", () => {
  it("creates in caller order, counts against a pinned today, and stamps closing", () => {
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
    expect(created.todos.every((t) => t.source === "avatar" && t.status === "todo" && t.closedAt === null)).toBe(true);
    // Undated items keep their insertion order (one batch, stamped in order).
    expect(store.listTodos(owner.id).map((t) => t.title)).toEqual(["overdue", "today", "b", "a"]);
    expect(store.countTodos(owner.id, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 4, overdue: 1, dueToday: 1 });

    const target = created.todos[0];
    const done = store.updateTodo(owner.id, target.id, { status: "done" });
    expect(done.ok && done.todo.status === "done" && typeof done.todo.closedAt === "string").toBe(true);
    // Editing another field keeps the closing stamp.
    const edited = store.updateTodo(owner.id, target.id, { note: "memo" });
    expect(edited.ok && done.ok && edited.todo.closedAt === done.todo.closedAt).toBe(true);
    const reopened = store.updateTodo(owner.id, target.id, { status: "todo", dueDate: "2026-10-10" });
    expect(reopened.ok && reopened.todo.closedAt === null && reopened.todo.dueDate === "2026-10-10").toBe(true);
    const cleared = store.updateTodo(owner.id, target.id, { dueDate: null });
    expect(cleared.ok && cleared.todo.dueDate === null && cleared.todo.note === "memo").toBe(true);

    expect(store.updateTodo(owner.id, "missing", { status: "done" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(store.deleteTodo(owner.id, target.id)).toBe(true);
    expect(store.deleteTodo(owner.id, target.id)).toBe(false);
  });

  it("moves through every status: in progress first, closing stamped, the done mirror in step", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const created = store.createTodos(
      owner.id,
      [item("overdue plain", { dueDate: "2026-10-01" }), item("started", { status: "in_progress" })],
      { source: "user" },
    );
    if (!created.ok) throw new Error("create failed");
    const [plain, started] = created.todos;
    expect(started).toMatchObject({ status: "in_progress", closedAt: null });
    // In progress leads the list, even ahead of an overdue item.
    expect(store.listTodos(owner.id).map((t) => t.title)).toEqual(["started", "overdue plain"]);
    expect(store.countTodos(owner.id, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 2, inProgress: 1, overdue: 1 });
    const mirror = (id: string) =>
      rawDb(store).prepare("SELECT status, done, completed_at FROM todo_items WHERE id = ?").get(id);

    vi.setSystemTime(new Date("2026-10-09T02:00:00.000Z"));
    expect(store.updateTodo(owner.id, started.id, { status: "dropped" })).toMatchObject({
      ok: true,
      todo: { status: "dropped", closedAt: "2026-10-09T02:00:00.000Z" },
    });
    expect(mirror(started.id)).toEqual({ status: "dropped", done: 1, completed_at: "2026-10-09T02:00:00.000Z" });
    expect(store.countTodos(owner.id, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 1, overdue: 1, dropped: 1 });

    // Closed → closed re-stamps: it is when the item reached its current status.
    vi.setSystemTime(new Date("2026-10-09T03:00:00.000Z"));
    expect(store.updateTodo(owner.id, started.id, { status: "done" })).toMatchObject({
      ok: true,
      todo: { status: "done", closedAt: "2026-10-09T03:00:00.000Z" },
    });
    expect(store.countTodos(owner.id, "2026-10-09")).toMatchObject({ open: 1, done: 1, dropped: 0 });

    // Back to open clears the stamp and the mirror; todo ↔ in progress never stamps.
    expect(store.updateTodo(owner.id, started.id, { status: "in_progress" })).toMatchObject({
      ok: true,
      todo: { status: "in_progress", closedAt: null },
    });
    expect(mirror(started.id)).toEqual({ status: "in_progress", done: 0, completed_at: null });
    expect(store.updateTodo(owner.id, plain.id, { status: "in_progress" })).toMatchObject({
      ok: true,
      todo: { status: "in_progress", closedAt: null },
    });
    expect(mirror(plain.id)).toEqual({ status: "in_progress", done: 0, completed_at: null });
    expect(store.countTodos(owner.id, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 2, inProgress: 2, overdue: 1 });
  });

  it("isolates owners and refuses a batch or a reopen past the open cap", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const mine = store.createTodos(owner.id, [item("mine")], { source: "user" });
    if (!mine.ok) throw new Error("create failed");
    expect(store.getTodo(other.id, mine.todos[0].id)).toBe(null);
    expect(store.updateTodo(other.id, mine.todos[0].id, { status: "done" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(store.deleteTodo(other.id, mine.todos[0].id)).toBe(false);
    expect(store.listTodos(other.id)).toEqual([]);

    const fill = Array.from({ length: MAX_OPEN_TODOS - 1 }, (_, i) => item(`fill ${i}`));
    expect(store.createTodos(owner.id, fill, { source: "user" }).ok).toBe(true);
    // All-or-nothing: two more would cross the cap, so neither lands.
    expect(store.createTodos(owner.id, [item("x"), item("y")], { source: "user" })).toEqual({ ok: false, error: "LIMIT" });
    expect(store.countTodos(owner.id, "2026-10-09").open).toBe(MAX_OPEN_TODOS);
    expect(store.updateTodo(owner.id, mine.todos[0].id, { status: "done" }).ok).toBe(true);
    expect(store.createTodos(owner.id, [item("last")], { source: "user" }).ok).toBe(true);
    // At the cap again, reopening the completed one is refused like a new item.
    expect(store.updateTodo(owner.id, mine.todos[0].id, { status: "todo" })).toEqual({ ok: false, error: "LIMIT" });
  });

  it("counts in-progress items toward the open cap and reopens a dropped item like a done one", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const mine = store.createTodos(owner.id, [item("mine")], { source: "user" });
    if (!mine.ok) throw new Error("create failed");
    const id = mine.todos[0].id;
    const fill = Array.from({ length: MAX_OPEN_TODOS - 1 }, (_, i) => item(`fill ${i}`, i % 2 ? { status: "in_progress" } : {}));
    expect(store.createTodos(owner.id, fill, { source: "user" }).ok).toBe(true);
    expect(store.countTodos(owner.id, "2026-10-09")).toMatchObject({
      open: MAX_OPEN_TODOS,
      inProgress: Math.floor((MAX_OPEN_TODOS - 1) / 2),
    });
    expect(store.createTodos(owner.id, [item("over", { status: "in_progress" })], { source: "user" })).toEqual({
      ok: false,
      error: "LIMIT",
    });
    // Open → open is no reopen: allowed at the cap.
    expect(store.updateTodo(owner.id, id, { status: "in_progress" }).ok).toBe(true);
    expect(store.updateTodo(owner.id, id, { status: "dropped" }).ok).toBe(true);
    expect(store.createTodos(owner.id, [item("last")], { source: "user" }).ok).toBe(true);
    // Back at the cap: a dropped item cannot come back to any open status...
    expect(store.updateTodo(owner.id, id, { status: "in_progress" })).toEqual({ ok: false, error: "LIMIT" });
    expect(store.updateTodo(owner.id, id, { status: "todo", note: "kept?" })).toEqual({ ok: false, error: "LIMIT" });
    expect(store.getTodo(owner.id, id)).toMatchObject({ status: "dropped", note: "" });
    // ...while closed → closed is not a reopen.
    expect(store.updateTodo(owner.id, id, { status: "done" })).toMatchObject({ ok: true, todo: { status: "done" } });
  });

  it("lists the newest done and dropped items separately and clears each status alone", () => {
    const { store } = boot();
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const done = store.createTodos(
      owner.id,
      Array.from({ length: MAX_LISTED_CLOSED_TODOS + 3 }, (_, i) => item(`d${i}`)),
      { source: "user" },
    );
    if (!done.ok) throw new Error("create failed");
    for (const todo of done.todos) store.updateTodo(owner.id, todo.id, { status: "done" });
    const dropped = store.createTodos(
      owner.id,
      Array.from({ length: MAX_LISTED_CLOSED_TODOS + 2 }, (_, i) => item(`x${i}`)),
      { source: "user" },
    );
    if (!dropped.ok) throw new Error("create failed");
    for (const todo of dropped.todos) store.updateTodo(owner.id, todo.id, { status: "dropped" });
    store.createTodos(owner.id, [item("open one")], { source: "user" });
    const listed = store.listTodos(owner.id);
    expect(listed[0].title).toBe("open one");
    // A long completion history never crowds out the dropped items.
    expect(listed.filter((t) => t.status === "done")).toHaveLength(MAX_LISTED_CLOSED_TODOS);
    expect(listed.filter((t) => t.status === "dropped")).toHaveLength(MAX_LISTED_CLOSED_TODOS);
    expect(store.countTodos(owner.id, "2026-10-09")).toMatchObject({
      open: 1,
      done: MAX_LISTED_CLOSED_TODOS + 3,
      dropped: MAX_LISTED_CLOSED_TODOS + 2,
    });
    expect(store.clearClosedTodos(owner.id, "dropped")).toBe(MAX_LISTED_CLOSED_TODOS + 2);
    expect(store.countTodos(owner.id, "2026-10-09")).toMatchObject({ open: 1, done: MAX_LISTED_CLOSED_TODOS + 3, dropped: 0 });
    expect(store.clearClosedTodos(owner.id, "done")).toBe(MAX_LISTED_CLOSED_TODOS + 3);
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

describe("todo status migration", () => {
  /** todo_items exactly as the pre-status build created it (no status column, the done index). */
  const PRE_STATUS_TABLE = `
    DROP INDEX IF EXISTS idx_todo_items_owner_status;
    DROP TABLE todo_items;
    CREATE TABLE todo_items (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal',
      due_date TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'user',
      source_conversation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX idx_todo_items_owner ON todo_items(owner_user_id, done, due_date);
  `;
  const T0 = "2026-10-01T00:00:00.000Z";
  const T1 = "2026-10-05T00:00:00.000Z";

  /** Boot once for the owner, close, let `edit` change the DB file by hand, then boot again on it. */
  function reboot(edit: (raw: Database.Database, ownerId: string) => void, seed?: (store: Store, ownerId: string) => void) {
    const first = boot();
    const owner = first.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    seed?.(first.store, owner.id);
    first.store.close();
    services = undefined;
    const raw = new Database(first.config.dbPath);
    edit(raw, owner.id);
    raw.close();
    return { store: boot().store, ownerId: owner.id };
  }

  it("upgrades a pre-status DB: done rows become done, the rest todo, and swaps the index", () => {
    const { store, ownerId } = reboot((raw, ownerId) => {
      raw.exec(PRE_STATUS_TABLE);
      const insert = raw.prepare(
        "INSERT INTO todo_items (id, owner_user_id, title, done, due_date, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run("open-row", ownerId, "열린 일", 0, "2026-10-01", T0, T0, null);
      insert.run("done-row", ownerId, "끝난 일", 1, null, T0, T1, T1);
    });
    expect(store.getTodo(ownerId, "open-row")).toMatchObject({ status: "todo", closedAt: null });
    expect(store.getTodo(ownerId, "done-row")).toMatchObject({ status: "done", closedAt: T1 });
    expect(store.countTodos(ownerId, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 1, overdue: 1, done: 1 });
    const indexes = (
      rawDb(store).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todo_items'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toContain("idx_todo_items_owner_status");
    expect(indexes).not.toContain("idx_todo_items_owner");
    // The upgraded rows are ordinary rows from here on.
    expect(store.updateTodo(ownerId, "done-row", { status: "dropped" })).toMatchObject({ ok: true, todo: { status: "dropped" } });
  });

  it("repairs rows a rolled-back build changed through done alone, and leaves consistent ones be", () => {
    const ids: Record<string, string> = {};
    const { store, ownerId } = reboot(
      (raw) => {
        // What a pre-status build does: it reads and writes done + completed_at only.
        raw.prepare("UPDATE todo_items SET done = 1, completed_at = ? WHERE id = ?").run(T1, ids.started); // completed it
        raw.prepare("UPDATE todo_items SET done = 0, completed_at = NULL WHERE id = ?").run(ids.reopened); // it read as done
        raw.prepare("UPDATE todo_items SET status = 'archived' WHERE id IN (?, ?)").run(ids.oddOpen, ids.oddClosed);
      },
      (store, ownerId) => {
        const created = store.createTodos(
          ownerId,
          ["started", "reopened", "dropped", "progress", "oddOpen", "oddClosed"].map((title) =>
            item(title, title === "started" || title === "progress" ? { status: "in_progress" } : {}),
          ),
          { source: "user" },
        );
        if (!created.ok) throw new Error("create failed");
        for (const todo of created.todos) ids[todo.title] = todo.id;
        store.updateTodo(ownerId, ids.reopened, { status: "dropped" });
        store.updateTodo(ownerId, ids.dropped, { status: "dropped" });
        store.updateTodo(ownerId, ids.oddClosed, { status: "done" });
      },
    );
    expect(store.getTodo(ownerId, ids.started)).toMatchObject({ status: "done", closedAt: T1 });
    expect(store.getTodo(ownerId, ids.reopened)).toMatchObject({ status: "todo", closedAt: null });
    expect(store.getTodo(ownerId, ids.dropped)?.status).toBe("dropped");
    expect(store.getTodo(ownerId, ids.progress)?.status).toBe("in_progress");
    // An unknown status takes its value from the mirror.
    expect(store.getTodo(ownerId, ids.oddOpen)?.status).toBe("todo");
    expect(store.getTodo(ownerId, ids.oddClosed)?.status).toBe("done");
    expect(store.countTodos(ownerId, "2026-10-09")).toEqual({ ...ZERO_COUNTS, open: 3, inProgress: 1, done: 2, dropped: 1 });
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
    expect(res.body).toEqual({ todos: [], todayKst: kstDateString(), counts: ZERO_COUNTS });
  });

  it("creates, edits, completes, deletes and clears with a fresh snapshot each time", async () => {
    const { alice } = await setup();
    const today = kstDateString();
    const created = await alice
      .post("/api/me/todos")
      .send({ title: "리뷰 답변", dueDate: today, priority: "high", tags: ["리뷰"] })
      .expect(201);
    expect(created.body.todo).toMatchObject({
      title: "리뷰 답변", dueDate: today, priority: "high", tags: ["리뷰"], status: "todo", closedAt: null, source: "user", sourceConversationId: null,
    });
    expect(created.body.counts).toEqual({ ...ZERO_COUNTS, open: 1, dueToday: 1 });
    const id = created.body.todo.id as string;

    const patched = await alice.patch(`/api/me/todos/${id}`).send({ dueDate: null, note: "메모" }).expect(200);
    expect(patched.body.todo).toMatchObject({ dueDate: null, note: "메모" });
    expect(patched.body.counts.dueToday).toBe(0);

    const completed = await alice.patch(`/api/me/todos/${id}`).send({ status: "done" }).expect(200);
    expect(completed.body.todo.status).toBe("done");
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

  it("moves items through 진행 중 and 드랍, and clears dropped items alone", async () => {
    const { alice } = await setup();
    const started = await alice.post("/api/me/todos").send({ title: "진행 중인 일", status: "in_progress" }).expect(201);
    expect(started.body.todo).toMatchObject({ status: "in_progress", closedAt: null });
    expect(started.body.counts).toEqual({ ...ZERO_COUNTS, open: 1, inProgress: 1 });
    const closedOnCreate = (await alice.post("/api/me/todos").send({ title: "x", status: "done" }).expect(400)).body.error;
    expect(closedOnCreate).toContain("시작 전이나 진행 중으로만");
    const finished = (await alice.post("/api/me/todos").send({ title: "끝낼 일" }).expect(201)).body.todo.id as string;
    await alice.patch(`/api/me/todos/${finished}`).send({ status: "done" }).expect(200);

    const id = started.body.todo.id as string;
    const dropped = await alice.patch(`/api/me/todos/${id}`).send({ status: "dropped" }).expect(200);
    expect(dropped.body.todo).toMatchObject({ status: "dropped" });
    expect(typeof dropped.body.todo.closedAt).toBe("string");
    expect(dropped.body.counts).toEqual({ ...ZERO_COUNTS, done: 1, dropped: 1 });
    expect((await alice.patch(`/api/me/todos/${id}`).send({ status: "paused" }).expect(400)).body.error).toContain("상태는");
    expect((await alice.patch(`/api/me/todos/${id}`).send({ status: "todo", done: false }).expect(400)).body.error).toContain(
      "상태는",
    );

    await alice.post("/api/me/todos/dropped").expect(404);
    const cleared = await alice.delete("/api/me/todos/dropped").expect(200);
    expect(cleared.body).toMatchObject({ removed: 1, counts: { ...ZERO_COUNTS, done: 1 } });
    const left = (await alice.get("/api/me/todos").expect(200)).body.todos as TodoItem[];
    expect(left.map((todo) => [todo.title, todo.status])).toEqual([["끝낼 일", "done"]]);
  });

  it("keeps an already-open tab on an older bundle working: legacy done on the wire and in a patch", async () => {
    const { alice } = await setup();
    const created = (await alice.post("/api/me/todos").send({ title: "옛 탭" }).expect(201)).body.todo;
    expect(created).toMatchObject({ status: "todo", done: false, completedAt: null });
    const id = created.id as string;
    const listed = (await alice.get("/api/me/todos").expect(200)).body.todos[0];
    expect(listed).toMatchObject({ status: "todo", done: false, completedAt: null });
    // The older bundle completes and reopens with `done`.
    const completed = (await alice.patch(`/api/me/todos/${id}`).send({ done: true }).expect(200)).body.todo;
    expect(completed).toMatchObject({ status: "done", done: true });
    expect(completed.completedAt).toBe(completed.closedAt);
    await alice.patch(`/api/me/todos/${id}`).send({ status: "in_progress" }).expect(200);
    // A dropped item reads as done there, so it leaves that tab's open list too.
    const dropped = (await alice.patch(`/api/me/todos/${id}`).send({ status: "dropped" }).expect(200)).body.todo;
    expect(dropped).toMatchObject({ status: "dropped", done: true });
    const reopened = (await alice.patch(`/api/me/todos/${id}`).send({ done: false }).expect(200)).body.todo;
    expect(reopened).toMatchObject({ status: "todo", done: false, closedAt: null, completedAt: null });
  });

  it("answers validation, foreign ids and the open cap in Korean", async () => {
    const { alice, bob } = await setup();
    expect((await alice.post("/api/me/todos").send({ title: " " }).expect(400)).body.error).toBe("할 일 제목을 입력해 주세요.");
    expect((await alice.post("/api/me/todos").send({ title: "t", dueDate: "2026-13-01" }).expect(400)).body.error).toContain("마감일");
    const id = (await alice.post("/api/me/todos").send({ title: "alice only" }).expect(201)).body.todo.id as string;
    expect((await alice.patch(`/api/me/todos/${id}`).send({}).expect(400)).body.error).toBe("변경할 내용이 없습니다.");
    await bob.patch(`/api/me/todos/${id}`).send({ status: "done" }).expect(404);
    await bob.delete(`/api/me/todos/${id}`).expect(404);
    expect((await bob.get("/api/me/todos").expect(200)).body.todos).toEqual([]);

    const aliceUser = services!.store.getUserByUsername("alice")!;
    services!.store.createTodos(
      aliceUser.id,
      Array.from({ length: MAX_OPEN_TODOS - 1 }, (_, i) => item(`fill ${i}`)),
      { source: "user" },
    );
    expect((await alice.post("/api/me/todos").send({ title: "over" }).expect(409)).body.error).toContain(`${MAX_OPEN_TODOS}개`);
    // At the cap, reopening a closed item is refused in reopen wording, not "add" wording.
    await alice.patch(`/api/me/todos/${id}`).send({ status: "dropped" }).expect(200);
    await alice.post("/api/me/todos").send({ title: "last" }).expect(201);
    const reopen = (await alice.patch(`/api/me/todos/${id}`).send({ status: "in_progress" }).expect(409)).body.error as string;
    expect(reopen).toContain("다시 열 수 없어 아무것도 바뀌지 않았습니다");
    expect(reopen).not.toContain("추가해 주세요");
  });
});
