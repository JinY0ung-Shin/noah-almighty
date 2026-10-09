import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { kstDateString } from "../routineSchedule.js";
import type { Store } from "../store.js";
import { parseNewTodo, parseTodoPatch, type TodoInputError } from "../todos.js";
import {
  MAX_OPEN_TODOS,
  MAX_TODO_NOTE_LENGTH,
  MAX_TODO_TAGS,
  MAX_TODO_TAG_LENGTH,
  MAX_TODO_TITLE_LENGTH,
  type TodoSnapshot,
} from "../../shared/todos.js";
import { apiError, type RouterDeps } from "./_shared.js";

/** User-facing (Korean) messages for the shared validation codes; the tools keep an English map. */
export const KOREAN_TODO_ERROR: Record<TodoInputError, string> = {
  TITLE_REQUIRED: "할 일 제목을 입력해 주세요.",
  TITLE_TOO_LONG: `할 일 제목은 ${MAX_TODO_TITLE_LENGTH}자 이하로 입력해 주세요.`,
  INVALID_NOTE: "메모 형식이 올바르지 않습니다.",
  NOTE_TOO_LONG: `메모는 ${MAX_TODO_NOTE_LENGTH}자 이하로 입력해 주세요.`,
  INVALID_PRIORITY: "우선순위는 높음·보통·낮음 중 하나여야 합니다.",
  INVALID_DUE_DATE: "마감일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.",
  INVALID_TAGS: `태그는 ${MAX_TODO_TAG_LENGTH}자 이하로 최대 ${MAX_TODO_TAGS}개까지 넣을 수 있습니다.`,
  INVALID_DONE: "완료 여부 값이 올바르지 않습니다.",
  EMPTY_PATCH: "변경할 내용이 없습니다.",
};

export const TODO_LIMIT_MESSAGE = `열린 할 일은 최대 ${MAX_OPEN_TODOS}개까지 둘 수 있습니다. 완료하거나 정리한 뒤 다시 추가해 주세요.`;
/** The only way an edit hits the cap is reopening a completed item. */
export const TODO_REOPEN_LIMIT_MESSAGE = `열린 할 일이 이미 최대 ${MAX_OPEN_TODOS}개라 다시 열 수 없어 아무것도 바뀌지 않았습니다. 다른 할 일을 완료하거나 정리한 뒤 다시 시도해 주세요.`;
const TODO_NOT_FOUND_MESSAGE = "할 일을 찾을 수 없습니다.";

/** The counts and KST "today" every response carries (see `TodoSnapshot`). */
export function todoSnapshot(store: Store, ownerUserId: string): TodoSnapshot {
  const todayKst = kstDateString();
  return { todayKst, counts: store.countTodos(ownerUserId, todayKst) };
}

// ---- 할 일 (the signed-in user's own work to-do list) -------------------
// Session-only and strictly self-scoped: every query is keyed by the caller's
// own id, so there is no cross-user read or write to gate.
export function createTodosRouter({ store }: RouterDeps): Router {
  const router = Router();
  router.use("/api/me/todos", requireAuth(store), (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/api/me/todos", (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    res.json({ todos: store.listTodos(userId), ...todoSnapshot(store, userId) });
  });

  router.post("/api/me/todos", (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const parsed = parseNewTodo(req.body);
    if (!parsed.ok) {
      apiError(res, 400, KOREAN_TODO_ERROR[parsed.error]);
      return;
    }
    const created = store.createTodos(userId, [parsed.value], { source: "user" });
    if (!created.ok) {
      apiError(res, 409, TODO_LIMIT_MESSAGE);
      return;
    }
    res.status(201).json({ todo: created.todos[0], ...todoSnapshot(store, userId) });
  });

  // 완료 항목 비우기. A DELETE, never a body-less POST: a plain HTML form on
  // another same-site intranet page can send a simple POST with the Lax session
  // cookie, while a DELETE always needs a CORS preflight. Registered BEFORE
  // `/api/me/todos/:id` so "completed" is never read as an item id.
  router.delete("/api/me/todos/completed", (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const removed = store.clearCompletedTodos(userId);
    res.json({ removed, ...todoSnapshot(store, userId) });
  });

  router.patch("/api/me/todos/:id", (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const parsed = parseTodoPatch(req.body);
    if (!parsed.ok) {
      apiError(res, 400, KOREAN_TODO_ERROR[parsed.error]);
      return;
    }
    const updated = store.updateTodo(userId, req.params.id, parsed.value);
    if (!updated.ok) {
      if (updated.error === "NOT_FOUND") apiError(res, 404, TODO_NOT_FOUND_MESSAGE);
      else apiError(res, 409, TODO_REOPEN_LIMIT_MESSAGE);
      return;
    }
    res.json({ todo: updated.todo, ...todoSnapshot(store, userId) });
  });

  router.delete("/api/me/todos/:id", (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    if (!store.deleteTodo(userId, req.params.id)) {
      apiError(res, 404, TODO_NOT_FOUND_MESSAGE);
      return;
    }
    res.json({ ok: true, ...todoSnapshot(store, userId) });
  });

  return router;
}
