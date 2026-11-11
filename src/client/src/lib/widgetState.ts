// Canvas `widget` state in the browser's localStorage, so a slider position or
// a picked tab survives a reload on THIS device. The avatar never sees it —
// only what a `<submit>` sends reaches the conversation.
//
// One key per (user, conversation, canvas): the user id is in the key so two
// accounts sharing a browser never see each other's values, and the
// conversation id because a canvas id can be one the AVATAR chose (`canvasId`)
// and used again in another conversation. A stored entry carries the
// declaration it was stored under (`sig`); `restoreState` applies it only while
// that declaration is unchanged, so a refined widget starts changed variables
// from their new initializers.
//
// Every access is wrapped: with storage blocked (private window, site data
// cleared, quota) the widget simply keeps its state in memory.
import type { StoredState } from "../../../shared/widget/index";

export const WIDGET_STATE_PREFIX = "noah:canvas-widget:";
/** Most-recently-saved keys, oldest first — what gets evicted past the limit. */
export const WIDGET_STATE_INDEX_KEY = "noah:canvas-widget-index";
export const MAX_WIDGET_STATE_CHARS = 200_000;
export const MAX_WIDGET_STATE_ENTRIES = 50;
export const WIDGET_STATE_SAVE_DELAY_MS = 300;

export type WidgetStateRecord = Record<string, StoredState>;
/**
 * The shared library's `dataSize`: a value's approximate JSON length WITHOUT
 * serializing it, giving up once it passes `limit`. Passed in rather than
 * imported, so this module (loaded with every chat) does not pull the lazily
 * loaded widget library in with it.
 */
export type SizeOf = (value: unknown, limit: number) => number;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "length" | "key">>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Which widget a stored record belongs to. Any missing part means "do not store". */
export interface WidgetStateRef {
  userId: string | null | undefined;
  conversationId: string | null | undefined;
  canvasId: string | null | undefined;
}

/** The storage key, or null when the ref is incomplete (signed out, a conversation not created yet). */
export function widgetStateKey(ref: WidgetStateRef): string | null {
  if (!ref.userId || !ref.conversationId || !ref.canvasId) return null;
  return `${WIDGET_STATE_PREFIX}${ref.userId}:${ref.conversationId}:${ref.canvasId}`;
}

function readIndex(storage: StorageLike): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(WIDGET_STATE_INDEX_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string" && k.startsWith(WIDGET_STATE_PREFIX)) : [];
  } catch {
    return [];
  }
}

function writeIndex(storage: StorageLike, keys: string[]): void {
  try {
    if (keys.length) storage.setItem(WIDGET_STATE_INDEX_KEY, JSON.stringify(keys));
    else storage.removeItem(WIDGET_STATE_INDEX_KEY);
  } catch {
    /* the index is only housekeeping */
  }
}

/** The stored record for one canvas, or null (nothing stored, unreadable, or not a record). */
export function loadWidgetState(ref: WidgetStateRef, storage: StorageLike | null = defaultStorage()): WidgetStateRecord | null {
  const key = widgetStateKey(ref);
  if (!key || !storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_WIDGET_STATE_CHARS) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: WidgetStateRecord = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { sig, value } = entry as { sig?: unknown; value?: unknown };
      if (typeof sig !== "string") continue;
      out[name] = { sig, value };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Store one canvas's record (an empty one removes the key) and keep at most
 * MAX_WIDGET_STATE_ENTRIES canvases, dropping the least recently saved. Returns
 * whether the record is now stored; a record over the size cap is not written
 * and whatever was stored before is removed (a stale value is worse than none).
 * The size is measured with `sizeOf` BEFORE anything is serialized: a state can
 * hold megabytes, and a save runs on every settled change.
 */
export function saveWidgetState(
  ref: WidgetStateRef,
  record: WidgetStateRecord,
  sizeOf: SizeOf,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const key = widgetStateKey(ref);
  if (!key || !storage) return false;
  try {
    const empty = Object.keys(record).length === 0;
    const raw = empty || sizeOf(record, MAX_WIDGET_STATE_CHARS) > MAX_WIDGET_STATE_CHARS ? "" : JSON.stringify(record);
    if (!raw || raw.length > MAX_WIDGET_STATE_CHARS) {
      removeWidgetState(ref, storage);
      return false;
    }
    storage.setItem(key, raw);
    const index = readIndex(storage).filter((k) => k !== key);
    index.push(key);
    while (index.length > MAX_WIDGET_STATE_ENTRIES) {
      const oldest = index.shift();
      if (oldest) storage.removeItem(oldest);
    }
    writeIndex(storage, index);
    return true;
  } catch {
    return false;
  }
}

/** Forget one canvas's stored state (the canvas was deleted). */
export function removeWidgetState(ref: WidgetStateRef, storage: StorageLike | null = defaultStorage()): void {
  const key = widgetStateKey(ref);
  if (!key || !storage) return;
  try {
    storage.removeItem(key);
    const index = readIndex(storage);
    if (index.includes(key)) writeIndex(storage, index.filter((k) => k !== key));
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Forget every widget of one conversation (the conversation was deleted): its
 * keys and their index entries. The index names them; a storage that can be
 * enumerated is swept as well, so a key the index lost track of goes too.
 */
export function removeConversationWidgetState(
  userId: string | null | undefined,
  conversationId: string | null | undefined,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!userId || !conversationId || !storage) return;
  const prefix = `${WIDGET_STATE_PREFIX}${userId}:${conversationId}:`;
  try {
    const index = readIndex(storage);
    const doomed = new Set(index.filter((key) => key.startsWith(prefix)));
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(prefix)) doomed.add(key);
      }
    }
    if (doomed.size === 0) return;
    for (const key of doomed) storage.removeItem(key);
    writeIndex(storage, index.filter((key) => !doomed.has(key)));
  } catch {
    /* nothing to clean up */
  }
}

export interface WidgetStateSaver {
  /** Save `record` after the delay; a later call replaces a pending one. */
  schedule(ref: WidgetStateRef, record: WidgetStateRecord): void;
  /** Write a pending save now (the tab is going away). */
  flush(): void;
  /** Drop a pending save without writing it. */
  cancel(): void;
}

/** A debounced writer: setters fire per keystroke / per slider step, storage is written once they settle. */
export function createWidgetStateSaver(
  sizeOf: SizeOf,
  delayMs = WIDGET_STATE_SAVE_DELAY_MS,
  storage: StorageLike | null = defaultStorage(),
): WidgetStateSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { ref: WidgetStateRef; record: WidgetStateRecord } | null = null;
  const write = () => {
    timer = null;
    const job = pending;
    pending = null;
    if (job) saveWidgetState(job.ref, job.record, sizeOf, storage);
  };
  return {
    schedule(ref, record) {
      if (timer !== null) clearTimeout(timer);
      // A pending save for ANOTHER canvas must not be lost to this one.
      if (pending && widgetStateKey(pending.ref) !== widgetStateKey(ref)) write();
      pending = { ref, record };
      timer = setTimeout(write, delayMs);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
      write();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
