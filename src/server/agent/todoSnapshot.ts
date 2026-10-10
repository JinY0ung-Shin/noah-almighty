// The 할 일 snapshot the system prompt states: the owner's list FROZEN at a
// conversation's first to-do-capable turn and never refreshed (user decision
// 2026-10-10). The append is re-rendered on every turn (`snapshot: false`), so
// anything in it that moved between turns would invalidate the cached prompt
// prefix and re-bill the whole history; a value written once per conversation
// cannot move. The live state stays where caching does not care:
// describe_system and the header of every to-do tool result.
import logger from "../logger.js";
import type { Store } from "../store.js";
import type { TodoPromptSnapshot } from "../types.js";
import { kstDateString, normalizeCalendarDate } from "../routineSchedule.js";
import { isTodoPriority, TODO_SOURCES } from "../../shared/todos.js";

const agentLogger = logger.child({ module: "agent" });

/** Open items the snapshot lists; the rest are counted, not shown. */
export const TODO_SNAPSHOT_ITEM_LIMIT = 20;

/** The owner's list right now: counts against today's KST date plus the first open items in the shared display order. */
export function takeTodoPromptSnapshot(store: Store, ownerUserId: string, now: Date = new Date()): TodoPromptSnapshot {
  const todayKst = kstDateString(now);
  const { open, overdue, dueToday } = store.countTodos(ownerUserId, todayKst);
  const items = store
    .listTodos(ownerUserId)
    .filter((todo) => !todo.done)
    .slice(0, TODO_SNAPSHOT_ITEM_LIMIT)
    .map(({ title, dueDate, priority, source }) => ({ title, dueDate, priority, source }));
  return { takenAt: now.toISOString(), todayKst, counts: { open, overdue, dueToday }, items };
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isCalendarDate = (value: unknown): value is string => normalizeCalendarDate(value) === value;

/**
 * A canonical `toISOString()` instant with a four-digit year — what
 * `takeTodoPromptSnapshot` writes. Anything looser could still pass
 * `Date.parse` and then throw in the KST formatting (an extended-year instant
 * overflows once the offset is added) on every turn of the conversation.
 */
function isTakenAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** A stored snapshot, or null when the stored text is not one — an unreadable value never reaches the prompt. */
export function parseTodoPromptSnapshot(raw: string | null): TodoPromptSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { takenAt, todayKst, counts, items } = value as Record<string, unknown>;
  if (!isTakenAt(takenAt) || !isCalendarDate(todayKst)) return null;
  if (!counts || typeof counts !== "object" || !Array.isArray(items)) return null;
  const { open, overdue, dueToday } = counts as Record<string, unknown>;
  if (!isCount(open) || !isCount(overdue) || !isCount(dueToday)) return null;
  const parsed: TodoPromptSnapshot["items"] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const { title, dueDate, priority, source } = item as Record<string, unknown>;
    if (typeof title !== "string" || !(dueDate === null || isCalendarDate(dueDate)) || !isTodoPriority(priority)) {
      return null;
    }
    if (!(TODO_SOURCES as readonly unknown[]).includes(source)) return null;
    parsed.push({ title, dueDate, priority, source: source as TodoPromptSnapshot["items"][number]["source"] });
  }
  return { takenAt, todayKst, counts: { open, overdue, dueToday }, items: parsed };
}

/**
 * This conversation's frozen snapshot: taken (and stored) on its first
 * to-do-capable turn, read back unchanged on every later one. Null when the
 * conversation row does not exist under this owner, when the stored value is
 * unreadable, or when the read fails — the block is a convenience, so a broken
 * to-do read never fails the turn (nothing was stored; a later turn retries).
 * The chat route and the task-API submit create the row before the run, and a
 * routine's row exists from the routine's creation; a routine whose thread was
 * deleted re-creates it only AFTER its next run, so that one run goes without
 * a block and the following run takes the snapshot.
 */
export function resolveConversationTodoSnapshot(
  store: Store,
  ownerUserId: string,
  conversationId: string,
  now: Date = new Date(),
): TodoPromptSnapshot | null {
  try {
    return parseTodoPromptSnapshot(
      store.ensureConversationTodoSnapshot(ownerUserId, conversationId, () =>
        JSON.stringify(takeTodoPromptSnapshot(store, ownerUserId, now)),
      ),
    );
  } catch (err) {
    agentLogger.warn({ err, avatarId: ownerUserId, conversationId }, "to-do prompt snapshot unavailable; run continues without it");
    return null;
  }
}
