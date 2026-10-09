import crypto from "node:crypto";
import {
  MAX_LISTED_DONE_TODOS,
  MAX_OPEN_TODOS,
  TODO_SOURCES,
  compareTodos,
  isTodoPriority,
  type TodoCounts,
  type TodoItem,
  type TodoSource,
} from "../../shared/todos.js";
import type { NewTodo, TodoPatch } from "../todos.js";
import { type Constructor, type StoreBase, now, parseNameList } from "./internal.js";

// 할 일 storage (see the todo_items table comment in internal.ts). Input is
// validated BEFORE it gets here (`../todos.ts`), so this mixin only enforces the
// per-user open cap, which must be checked inside the write transaction.

interface TodoRow {
  id: string;
  title: string;
  note: string;
  done: number;
  priority: string;
  due_date: string | null;
  tags_json: string;
  source: string;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// The source conversation is surfaced only while it still exists and belongs to
// the item's owner: deleting a conversation cuts the link without any cascade on
// the many conversation-deleting paths, and the item itself stays.
const TODO_SELECT = `SELECT t.id, t.title, t.note, t.done, t.priority, t.due_date, t.tags_json, t.source,
    CASE WHEN c.id IS NULL THEN NULL ELSE t.source_conversation_id END AS source_conversation_id,
    t.created_at, t.updated_at, t.completed_at
  FROM todo_items t
  LEFT JOIN conversations c ON c.id = t.source_conversation_id AND c.owner_user_id = t.owner_user_id`;

function toTodo(row: TodoRow): TodoItem {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    done: row.done === 1,
    priority: isTodoPriority(row.priority) ? row.priority : "normal",
    dueDate: row.due_date,
    tags: parseNameList(row.tags_json) ?? [],
    source: (TODO_SOURCES as readonly string[]).includes(row.source) ? (row.source as TodoSource) : "user",
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface TodoCreateMeta {
  source: TodoSource;
  /** The owner's conversation an avatar run added the items from. */
  conversationId?: string | null;
}

export type TodoCreateResult = { ok: true; todos: TodoItem[] } | { ok: false; error: "LIMIT" };
export type TodoUpdateResult = { ok: true; todo: TodoItem } | { ok: false; error: "NOT_FOUND" | "LIMIT" };

export function withTodos<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Todos extends Base {
    /** Every open item plus the newest completed ones, in the shared display order. */
    listTodos(ownerUserId: string): TodoItem[] {
      const open = this.db
        .prepare(`${TODO_SELECT} WHERE t.owner_user_id = ? AND t.done = 0`)
        .all(ownerUserId) as TodoRow[];
      const done = this.db
        .prepare(`${TODO_SELECT} WHERE t.owner_user_id = ? AND t.done = 1 ORDER BY t.completed_at DESC LIMIT ?`)
        .all(ownerUserId, MAX_LISTED_DONE_TODOS) as TodoRow[];
      return [...open, ...done].map(toTodo).sort(compareTodos);
    }

    getTodo(ownerUserId: string, id: string): TodoItem | null {
      const row = this.db
        .prepare(`${TODO_SELECT} WHERE t.owner_user_id = ? AND t.id = ?`)
        .get(ownerUserId, id) as TodoRow | undefined;
      return row ? toTodo(row) : null;
    }

    /** Counts against a KST calendar date (`kstDateString()`), passed in so tests can pin "today". */
    countTodos(ownerUserId: string, todayKst: string): TodoCounts {
      const open = "SELECT COUNT(*) AS c FROM todo_items WHERE owner_user_id = ? AND done = 0";
      return {
        open: this.count(open, ownerUserId),
        overdue: this.count(`${open} AND due_date IS NOT NULL AND due_date < ?`, ownerUserId, todayKst),
        dueToday: this.count(`${open} AND due_date = ?`, ownerUserId, todayKst),
        done: this.count("SELECT COUNT(*) AS c FROM todo_items WHERE owner_user_id = ? AND done = 1", ownerUserId),
      };
    }

    /** Insert all items or none: a batch that would cross MAX_OPEN_TODOS is refused whole. */
    createTodos(ownerUserId: string, items: NewTodo[], meta: TodoCreateMeta): TodoCreateResult {
      return this.db.transaction((): TodoCreateResult => {
        const open = this.count(
          "SELECT COUNT(*) AS c FROM todo_items WHERE owner_user_id = ? AND done = 0",
          ownerUserId,
        );
        if (open + items.length > MAX_OPEN_TODOS) return { ok: false, error: "LIMIT" };
        const insert = this.db.prepare(
          `INSERT INTO todo_items (id, owner_user_id, title, note, done, priority, due_date, tags_json,
             source, source_conversation_id, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        const ids: string[] = [];
        // One timestamp per batch, so the shared order (oldest first) keeps the
        // caller's order — the id tiebreak alone would shuffle it.
        const createdAt = now();
        items.forEach((item, index) => {
          const id = crypto.randomUUID();
          const stamp = new Date(Date.parse(createdAt) + index).toISOString();
          insert.run(
            id,
            ownerUserId,
            item.title,
            item.note,
            item.priority,
            item.dueDate,
            JSON.stringify(item.tags),
            meta.source,
            meta.conversationId ?? null,
            stamp,
            stamp,
          );
          ids.push(id);
        });
        return { ok: true, todos: ids.map((id) => this.getTodo(ownerUserId, id)!) };
      }).immediate();
    }

    updateTodo(ownerUserId: string, id: string, patch: TodoPatch): TodoUpdateResult {
      return this.db.transaction((): TodoUpdateResult => {
        const current = this.getTodo(ownerUserId, id);
        if (!current) return { ok: false, error: "NOT_FOUND" };
        // Reopening counts toward the open cap like a new item does.
        if (patch.done === false && current.done) {
          const open = this.count(
            "SELECT COUNT(*) AS c FROM todo_items WHERE owner_user_id = ? AND done = 0",
            ownerUserId,
          );
          if (open >= MAX_OPEN_TODOS) return { ok: false, error: "LIMIT" };
        }
        const stamp = now();
        const done = patch.done ?? current.done;
        const completedAt = done === current.done ? current.completedAt : done ? stamp : null;
        this.db
          .prepare(
            `UPDATE todo_items SET title = ?, note = ?, done = ?, priority = ?, due_date = ?, tags_json = ?,
               updated_at = ?, completed_at = ?
             WHERE owner_user_id = ? AND id = ?`,
          )
          .run(
            patch.title ?? current.title,
            patch.note ?? current.note,
            done ? 1 : 0,
            patch.priority ?? current.priority,
            patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
            JSON.stringify(patch.tags ?? current.tags),
            stamp,
            completedAt,
            ownerUserId,
            id,
          );
        return { ok: true, todo: this.getTodo(ownerUserId, id)! };
      }).immediate();
    }

    deleteTodo(ownerUserId: string, id: string): boolean {
      return this.db.prepare("DELETE FROM todo_items WHERE owner_user_id = ? AND id = ?").run(ownerUserId, id).changes > 0;
    }

    /** 완료 항목 비우기: removes every completed item (listed or not); returns how many. */
    clearCompletedTodos(ownerUserId: string): number {
      return this.db.prepare("DELETE FROM todo_items WHERE owner_user_id = ? AND done = 1").run(ownerUserId).changes;
    }
  };
}
