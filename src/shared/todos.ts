// 할 일: ONE persistent work to-do list per user, edited from the 할 일 tab, the
// chat overlay, and the owner's own avatar (`mcp__todo__*`). This module is the
// contract the server routes, the MCP tools and the client share. Import-free
// leaf: it is bundled into the browser, so it must not import anything.

export const TODO_PRIORITIES = ["high", "normal", "low"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export const DEFAULT_TODO_PRIORITY: TodoPriority = "normal";

/**
 * Who created an item: the owner in the UI (`user`), or the owner's avatar in an
 * interactive chat (`avatar`), a scheduled routine (`routine`) or an
 * external-task-API run (`api`).
 */
export const TODO_SOURCES = ["user", "avatar", "routine", "api"] as const;
export type TodoSource = (typeof TODO_SOURCES)[number];

export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_NOTE_LENGTH = 4000;
export const MAX_TODO_TAGS = 5;
export const MAX_TODO_TAG_LENGTH = 30;
/** Open items one user may hold — bounds the list, the tool output and the prompt's counts. */
export const MAX_OPEN_TODOS = 500;
/** Completed items a listing returns (newest first); older ones stay stored until cleared. */
export const MAX_LISTED_DONE_TODOS = 200;
/** Items one add call may create (the avatar's batch add). */
export const MAX_TODOS_PER_ADD = 20;

export interface TodoItem {
  id: string;
  title: string;
  /** Free-form memo (markdown); "" when empty. */
  note: string;
  done: boolean;
  priority: TodoPriority;
  /** Due date as a KST calendar date (`YYYY-MM-DD`) — date only, never a time — or null. */
  dueDate: string | null;
  tags: string[];
  source: TodoSource;
  /**
   * The owner's conversation the avatar added the item from. Null when there is
   * none, and again once that conversation is deleted (the item itself stays).
   */
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TodoCounts {
  open: number;
  /** Open items due before today (KST). */
  overdue: number;
  /** Open items due today (KST). */
  dueToday: number;
  done: number;
}

/**
 * Every to-do response carries the server's KST "today" with the counts, so the
 * client buckets items by comparing date strings instead of deriving the date.
 */
export interface TodoSnapshot {
  todayKst: string;
  counts: TodoCounts;
}

export interface TodoListResponse extends TodoSnapshot {
  todos: TodoItem[];
}

export function isTodoPriority(value: unknown): value is TodoPriority {
  return (TODO_PRIORITIES as readonly unknown[]).includes(value);
}

/** Prefix of the avatar's to-do tools; the client refreshes the list when one finishes. */
export const TODO_TOOL_PREFIX = "mcp__todo__";

export function isTodoToolName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(TODO_TOOL_PREFIX);
}

export type TodoDueBucket = "overdue" | "today" | "upcoming" | "none";

/** Where an item's due date falls relative to KST today (`YYYY-MM-DD` strings compare in date order). */
export function todoDueBucket(dueDate: string | null, todayKst: string): TodoDueBucket {
  if (!dueDate) return "none";
  if (dueDate < todayKst) return "overdue";
  return dueDate === todayKst ? "today" : "upcoming";
}

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The ONE display order, shared by the server listing and the client so an
 * optimistic insert lands where a reload puts it: open before done; open items
 * by due date (dated first, earliest — so overdue — first), then priority, then
 * oldest first; done items newest completion first.
 */
export function compareTodos(a: TodoItem, b: TodoItem): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.done) {
    return (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || a.id.localeCompare(b.id);
  }
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}
