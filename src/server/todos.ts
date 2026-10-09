// To-do input validation, shared by the HTTP routes (`routes/todos.ts`) and the
// avatar's tools (`agent/todoTools.ts`). Raw API/MCP input → a normalized value
// or a `TodoInputError` CODE; each caller maps the code to its own channel
// (Korean `apiError` vs English tool text), mirroring `parseRoutineSchedule`.
// Pure module, no DB access.

import {
  DEFAULT_TODO_PRIORITY,
  MAX_TODO_NOTE_LENGTH,
  MAX_TODO_TAG_LENGTH,
  MAX_TODO_TAGS,
  MAX_TODO_TITLE_LENGTH,
  isTodoPriority,
  type TodoPriority,
} from "../shared/todos.js";
import { normalizeCalendarDate } from "./routineSchedule.js";

export type TodoInputError =
  | "TITLE_REQUIRED"
  | "TITLE_TOO_LONG"
  | "INVALID_NOTE"
  | "NOTE_TOO_LONG"
  | "INVALID_PRIORITY"
  | "INVALID_DUE_DATE"
  | "INVALID_TAGS"
  | "INVALID_DONE"
  | "EMPTY_PATCH";

export interface NewTodo {
  title: string;
  note: string;
  priority: TodoPriority;
  dueDate: string | null;
  tags: string[];
}

/** A partial edit: an absent key leaves the field alone; `dueDate: null` clears it. */
export interface TodoPatch {
  title?: string;
  note?: string;
  priority?: TodoPriority;
  dueDate?: string | null;
  tags?: string[];
  done?: boolean;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: TodoInputError };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: TodoInputError): Parsed<T> => ({ ok: false, error });

function parseTitle(raw: unknown): Parsed<string> {
  // A title is one line: newlines and runs of whitespace collapse to one space.
  const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!title) return fail("TITLE_REQUIRED");
  return title.length > MAX_TODO_TITLE_LENGTH ? fail("TITLE_TOO_LONG") : ok(title);
}

function parseNote(raw: unknown): Parsed<string> {
  if (raw === undefined || raw === null) return ok("");
  if (typeof raw !== "string") return fail("INVALID_NOTE");
  const note = raw.replace(/\r\n?/g, "\n").trim();
  return note.length > MAX_TODO_NOTE_LENGTH ? fail("NOTE_TOO_LONG") : ok(note);
}

function parsePriority(raw: unknown): Parsed<TodoPriority> {
  if (raw === undefined || raw === null || raw === "") return ok(DEFAULT_TODO_PRIORITY);
  return isTodoPriority(raw) ? ok(raw) : fail("INVALID_PRIORITY");
}

function parseDueDate(raw: unknown): Parsed<string | null> {
  if (raw === undefined || raw === null || raw === "") return ok(null);
  const date = normalizeCalendarDate(raw);
  return date ? ok(date) : fail("INVALID_DUE_DATE");
}

/**
 * Tags: strings only; a leading "#" is dropped, inner whitespace becomes "-",
 * each is capped at MAX_TODO_TAG_LENGTH, and duplicates collapse
 * case-insensitively. More than MAX_TODO_TAGS distinct tags is an error rather
 * than a silent drop, so a caller learns which tags it actually kept.
 */
function parseTags(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) return fail("INVALID_TAGS");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return fail("INVALID_TAGS");
    const tag = item.trim().replace(/^#+/, "").trim().replace(/\s+/g, "-").slice(0, MAX_TODO_TAG_LENGTH);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.length > MAX_TODO_TAGS ? fail("INVALID_TAGS") : ok(out);
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function parseNewTodo(raw: unknown): Parsed<NewTodo> {
  const body = record(raw);
  const title = parseTitle(body.title);
  if (!title.ok) return title;
  const note = parseNote(body.note);
  if (!note.ok) return note;
  const priority = parsePriority(body.priority);
  if (!priority.ok) return priority;
  const dueDate = parseDueDate(body.dueDate);
  if (!dueDate.ok) return dueDate;
  const tags = parseTags(body.tags);
  if (!tags.ok) return tags;
  return ok({ title: title.value, note: note.value, priority: priority.value, dueDate: dueDate.value, tags: tags.value });
}

export function parseTodoPatch(raw: unknown): Parsed<TodoPatch> {
  const body = record(raw);
  const patch: TodoPatch = {};
  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (body.note !== undefined) {
    const note = parseNote(body.note);
    if (!note.ok) return note;
    patch.note = note.value;
  }
  if (body.priority !== undefined) {
    const priority = parsePriority(body.priority);
    if (!priority.ok) return priority;
    patch.priority = priority.value;
  }
  if (body.dueDate !== undefined) {
    const dueDate = parseDueDate(body.dueDate);
    if (!dueDate.ok) return dueDate;
    patch.dueDate = dueDate.value;
  }
  if (body.tags !== undefined) {
    const tags = parseTags(body.tags);
    if (!tags.ok) return tags;
    patch.tags = tags.value;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") return fail("INVALID_DONE");
    patch.done = body.done;
  }
  return Object.keys(patch).length ? ok(patch) : fail("EMPTY_PATCH");
}
