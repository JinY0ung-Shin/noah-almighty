// Inline UI state — what the viewer changed in the controls of an answer — kept
// on the SERVER, per viewer (`PUT /api/conversations/:id/ui-states/:messageId`,
// returned with the messages as `inlineUiStates`), so a slider position or a
// picked tab survives a reload and shows on the viewer's other devices. The
// avatar hears what changed in its LATEST answer at the start of its next turn
// (server side: `takeInlineUiStateForTurn`).
//
// One record per (user, conversation, message): the UI is part of one stored
// answer, and its state belongs to that answer. A record carries the
// declaration each value was stored under (`sig`); `restoreState` applies a
// value only while that declaration is unchanged.
//
// In this page: an in-memory copy, filled from the messages response
// (`primeWidgetStates`, called by `loadMessages` before the messages are shown,
// so a remount does not jump) and by every save. `localStorage` holds only what
// the server has not CONFIRMED yet (a failed or interrupted request; the
// pre-server values of this browser): it is uploaded the next time the
// conversation loads and dropped once the server has it. The user id is in
// every key so two accounts sharing a browser never see each other's values.
//
// An answer that is still streaming has no message id yet: its state stays in
// memory and is handed to the stored message when the turn ends (the live
// handover at the bottom).
//
// Every storage access is wrapped: with storage blocked (private window, site
// data cleared, quota) the server and the in-memory copy still work.
import {
  MAX_INLINE_UI_STATE_ANSWERS,
  MAX_INLINE_UI_STATE_CHARS,
  normalizeInlineUiStateRecord,
  type InlineUiStateTimes,
  type InlineUiStatesByMessage,
} from "../../../shared/inlineUiState";
import type { StoredState } from "../../../shared/widget/index";

export const WIDGET_STATE_PREFIX = "noah:inline-ui:";
/** Keys of the retired canvas `widget` type (never written again; swept once per page load). */
export const LEGACY_WIDGET_STATE_PREFIX = "noah:canvas-widget";
/** Most-recently-saved keys, oldest first — what gets evicted past the limit. */
export const WIDGET_STATE_INDEX_KEY = "noah:inline-ui-index";
export const MAX_WIDGET_STATE_CHARS = MAX_INLINE_UI_STATE_CHARS;
export const MAX_WIDGET_STATE_ENTRIES = MAX_INLINE_UI_STATE_ANSWERS;
export const WIDGET_STATE_SAVE_DELAY_MS = 300;
/** A request body up to this size goes out with `keepalive` (browsers cap keepalive bodies at 64 KiB in total). */
export const WIDGET_STATE_KEEPALIVE_CHARS = 60_000;
/** Answers held in this page's memory, across conversations. */
const MAX_MEMORY_ENTRIES = 2_000;

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

/* ---------- the server ---------- */

/**
 * What a save request came to: `ok` (stored), `gone` (refused for good — the
 * message or conversation is gone, the record too large: nothing to retry) or
 * `failed` (offline, a server error, a lost session: kept to try again).
 */
export type WidgetStatePutResult = "ok" | "gone" | "failed";
export type WidgetStateTransport = (
  target: { conversationId: string; messageId: string },
  record: WidgetStateRecord,
  /** A REPLAYED save: when it was made, on the server's clock (the server refuses it if it holds a newer one). */
  replayedAt?: number,
) => Promise<WidgetStatePutResult>;

const fetchTransport: WidgetStateTransport = async ({ conversationId, messageId }, record, replayedAt) => {
  try {
    const body = JSON.stringify(replayedAt === undefined ? { values: record } : { values: record, replayedAt });
    // Plain fetch, not `api()`: a failure here must not toast, and a 401 must
    // not log the viewer out from a background save. `keepalive` lets the last
    // save of a closing tab finish (small bodies only — the browser's cap).
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/ui-states/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body,
        keepalive: body.length <= WIDGET_STATE_KEEPALIVE_CHARS,
      },
    );
    if (response.ok) return "ok";
    // 409: the server already holds a NEWER value than this replayed one — ours is dropped.
    return response.status === 400 || response.status === 404 || response.status === 409 || response.status === 413 ? "gone" : "failed";
  } catch {
    return "failed";
  }
};

let transport: WidgetStateTransport = fetchTransport;

/** Replace how records reach the server (tests); null restores the real one. */
export function setWidgetStateTransport(next: WidgetStateTransport | null): void {
  transport = next ?? fetchTransport;
}

// Requests per answer go out one after another, so an older record can never
// land after a newer one.
const inflight = new Map<string, Promise<void>>();

function upload(
  ref: WidgetStateRef,
  key: string,
  record: WidgetStateRecord,
  at: number,
  storage: StorageLike | null,
  replayedAt?: number,
): Promise<void> {
  const target = { conversationId: ref.conversationId as string, messageId: ref.messageId as string };
  const previous = inflight.get(key);
  // With nothing in flight the request starts NOW (synchronously), so a save
  // flushed right before the UI sends a chat message reaches the server first.
  const send = () => (replayedAt === undefined ? transport(target, record) : transport(target, record, replayedAt));
  const sent = previous ? previous.then(send) : send();
  const job = sent
    .then((result) => {
      // Confirmed (or refused for good): the local copy of THIS record is not needed any more.
      if (result !== "failed" && storage) dropLocalIf(storage, key, at);
    })
    .catch(() => {});
  inflight.set(key, job);
  void job.then(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  return job;
}

/** Wait for every request this module has sent (tests). */
export async function settleWidgetStateRequests(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight.values()]);
}

/* ---------- this page's copy ---------- */

const memory = new Map<string, WidgetStateRecord>();
// Answers saved in this page load: a later reload of the messages must not put
// the server's older copy over what the viewer just set.
const touched = new Set<string>();

function remember(key: string, record: WidgetStateRecord | null): void {
  memory.delete(key);
  if (record) memory.set(key, record);
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
}

/** Forget this page's copy and every pending request (tests; a sign-out). */
export function resetWidgetStateMemory(): void {
  memory.clear();
  touched.clear();
  inflight.clear();
  forgotten.clear();
}

// Conversations deleted in this page load (`user:conversation`): a debounced
// save of an answer that was on screen can still be pending when its
// conversation goes, and writing it would resurrect what was just removed.
const forgotten = new Set<string>();

/** Which widget a stored record belongs to. Any missing part means "do not store". */
export interface WidgetStateRef {
  userId: string | null | undefined;
  conversationId: string | null | undefined;
  /** The stored assistant message the UI is part of. */
  messageId: string | null | undefined;
}

/** The storage key, or null when the ref is incomplete (signed out, a conversation not created yet). */
export function widgetStateKey(ref: WidgetStateRef): string | null {
  if (!ref.userId || !ref.conversationId || !ref.messageId) return null;
  return `${WIDGET_STATE_PREFIX}${ref.userId}:${ref.conversationId}:${ref.messageId}`;
}

/* ---------- localStorage: what the server has not confirmed ---------- */

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

/**
 * A local entry: `{ at, values }` written by this build (`at` = when it was
 * saved), or a bare record left by the build that kept state in this browser
 * only (`at` 0: the server's copy, when it has one, wins over it).
 */
function readLocal(storage: StorageLike, key: string): { at: number; record: WidgetStateRecord } | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_WIDGET_STATE_CHARS + 100) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const wrapped = parsed as { at?: unknown; values?: unknown };
    const isWrapped = typeof wrapped.at === "number" && wrapped.values !== undefined;
    const record = normalizeInlineUiStateRecord(isWrapped ? wrapped.values : parsed) as WidgetStateRecord | null;
    if (!record || Object.keys(record).length === 0) return null;
    return { at: isWrapped ? (wrapped.at as number) : 0, record };
  } catch {
    return null;
  }
}

function writeLocal(storage: StorageLike, key: string, raw: string, at: number): void {
  try {
    storage.setItem(key, `{"at":${at},"values":${raw}}`);
    const index = readIndex(storage).filter((k) => k !== key);
    index.push(key);
    while (index.length > MAX_WIDGET_STATE_ENTRIES) {
      const oldest = index.shift();
      if (oldest) storage.removeItem(oldest);
    }
    writeIndex(storage, index);
  } catch {
    /* the server copy is what counts */
  }
}

function dropLocal(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
    const index = readIndex(storage);
    if (index.includes(key)) writeIndex(storage, index.filter((k) => k !== key));
  } catch {
    /* nothing to clean up */
  }
}

/** Drop the local entry only if it is still the one saved at `at` (a newer save keeps its own). */
function dropLocalIf(storage: StorageLike, key: string, at: number): void {
  const local = readLocal(storage, key);
  if (!local || local.at === at) dropLocal(storage, key);
}

/** Every local key of one conversation: the index's, and any an enumerable storage still holds. */
function localKeysOf(storage: StorageLike, prefix: string): string[] {
  const keys = new Set(readIndex(storage).filter((key) => key.startsWith(prefix)));
  try {
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(prefix)) keys.add(key);
      }
    }
  } catch {
    /* the index is enough */
  }
  return [...keys];
}

/* ---------- the API the answer view uses ---------- */

/**
 * Take the server's records for one conversation (the `inlineUiStates` of the
 * messages response) into this page, BEFORE its messages are drawn. An answer
 * saved in this page load keeps what was set here. Then what this browser
 * holds that the server has not confirmed is settled — the NEWER value wins:
 * - an entry this build wrote (a request that failed or was cut off) is
 *   uploaded only when it is newer than the server's copy (`times`, on the
 *   server's clock; this browser's `at` is moved onto that clock with
 *   `serverNow`), and the server checks that again (409 = it holds a newer
 *   one). Older than the server's copy — another device saved after it — it is
 *   dropped and the server's value stays. Without `times` (an older server) it
 *   is uploaded as before.
 * - a bare entry left by the browser-only build is uploaded only where the
 *   server has nothing (the one-time move of existing values to the server)
 *   and dropped otherwise.
 * `states` undefined (an older server) changes nothing.
 */
export function primeWidgetStates(
  userId: string | null | undefined,
  conversationId: string | null | undefined,
  states: InlineUiStatesByMessage | null | undefined,
  storage: StorageLike | null = defaultStorage(),
  meta: { times?: InlineUiStateTimes | null; serverNow?: number | null } = {},
): void {
  if (!userId || !conversationId || !states || typeof states !== "object") return;
  if (forgotten.has(`${userId}:${conversationId}`)) return;
  for (const [messageId, raw] of Object.entries(states)) {
    const key = widgetStateKey({ userId, conversationId, messageId });
    const record = normalizeInlineUiStateRecord(raw) as WidgetStateRecord | null;
    if (!key || !record || Object.keys(record).length === 0 || touched.has(key)) continue;
    remember(key, record);
  }
  if (!storage) return;
  const prefix = `${WIDGET_STATE_PREFIX}${userId}:${conversationId}:`;
  for (const key of localKeysOf(storage, prefix)) {
    const messageId = key.slice(prefix.length);
    const local = readLocal(storage, key);
    if (!messageId || !local) {
      dropLocal(storage, key);
      continue;
    }
    const onServer = Object.prototype.hasOwnProperty.call(states, messageId);
    if (local.at === 0 && onServer) {
      dropLocal(storage, key);
      continue;
    }
    // This browser's save time on the server's clock (the skew measured now; a
    // response without `serverNow` leaves it as it is).
    const skew = typeof meta.serverNow === "number" && Number.isFinite(meta.serverNow) ? meta.serverNow - Date.now() : 0;
    const localAt = local.at + skew;
    const serverAt = meta.times && typeof meta.times[messageId] === "number" ? meta.times[messageId] : null;
    if (onServer && serverAt !== null && serverAt > localAt) {
      // The server's copy was saved after this one (another device): it stays.
      dropLocal(storage, key);
      continue;
    }
    if (!touched.has(key)) remember(key, local.record);
    void upload({ userId, conversationId, messageId }, key, local.record, local.at, storage, meta.times ? localAt : undefined);
  }
}

/** The record for one answer, or null (nothing stored, unreadable, or not a record). */
export function loadWidgetState(ref: WidgetStateRef, storage: StorageLike | null = defaultStorage()): WidgetStateRecord | null {
  const key = widgetStateKey(ref);
  if (!key) return null;
  const held = memory.get(key);
  if (held) return Object.keys(held).length ? held : null;
  // Not primed (the messages came from an older server, or a request failed): what this browser kept.
  return storage ? (readLocal(storage, key)?.record ?? null) : null;
}

/**
 * Save one answer's record (an empty one removes it) — here at once, on the
 * server through a request. Returns whether the record is now held; a record
 * over the size cap is not saved and whatever was saved before is removed (a
 * stale value is worse than none). The size is measured with `sizeOf` BEFORE
 * anything is serialized: a state can hold megabytes, and a save runs on every
 * settled change. Until the server confirms it, the record also waits in
 * localStorage (the next load uploads it).
 */
export function saveWidgetState(
  ref: WidgetStateRef,
  record: WidgetStateRecord,
  sizeOf: SizeOf,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const key = widgetStateKey(ref);
  if (!key) return false;
  // A save that was still pending when the conversation was deleted must not bring it back.
  if (forgotten.has(`${ref.userId}:${ref.conversationId}`)) return false;

  const empty = Object.keys(record).length === 0;
  let raw = "";
  try {
    raw = empty || sizeOf(record, MAX_WIDGET_STATE_CHARS) > MAX_WIDGET_STATE_CHARS ? "" : JSON.stringify(record);
  } catch {
    raw = "";
  }
  touched.add(key);
  const at = Date.now();
  if (!raw || raw.length > MAX_WIDGET_STATE_CHARS) {
    remember(key, null);
    if (storage) dropLocal(storage, key);
    void upload(ref, key, {}, at, null);
    return false;
  }
  remember(key, record);
  if (storage) writeLocal(storage, key, raw, at);
  void upload(ref, key, record, at, storage);
  return true;
}

/**
 * Forget one answer's record in this browser (the message was removed, or a
 * client-made id was replaced by the server's). The server's rows go with
 * their message.
 */
export function removeWidgetState(ref: WidgetStateRef, storage: StorageLike | null = defaultStorage()): void {
  const key = widgetStateKey(ref);
  if (!key) return;
  remember(key, null);
  if (storage) dropLocal(storage, key);
}

/**
 * Forget the UI state of one conversation in this browser (the conversation was
 * deleted; the server deleted its rows with it): this page's copy, its local
 * keys and their index entries. A save still pending for it is never sent.
 */
export function removeConversationWidgetState(
  userId: string | null | undefined,
  conversationId: string | null | undefined,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!userId || !conversationId) return;
  forgotten.add(`${userId}:${conversationId}`);
  if (forgotten.size > 500) forgotten.delete(forgotten.values().next().value as string);
  const prefix = `${WIDGET_STATE_PREFIX}${userId}:${conversationId}:`;
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  if (!storage) return;
  for (const key of localKeysOf(storage, prefix)) dropLocal(storage, key);
}

export interface WidgetStateSaver {
  /** Save `record` after the delay; a later call replaces a pending one. */
  schedule(ref: WidgetStateRef, record: WidgetStateRecord): void;
  /** Save a pending record now (the tab is going away, or the UI is sending a message). */
  flush(): void;
  /** Drop a pending save without writing it. */
  cancel(): void;
}

/** A debounced writer: setters fire per keystroke / per slider step, the server is written once they settle. */
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
      // A pending save for ANOTHER answer must not be lost to this one.
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

/**
 * Remove what the retired canvas `widget` type left in this browser. Its keys
 * named canvases that no longer draw; nothing reads them. Once per page load.
 */
let legacySwept = false;
export function sweepLegacyWidgetState(storage: StorageLike | null = defaultStorage()): void {
  if (legacySwept || !storage) return;
  legacySwept = true;
  try {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") return;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(LEGACY_WIDGET_STATE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    /* nothing to clean up */
  }
}

/* ---------- the live handover ---------- */

// What the viewer changed in an answer that is STILL STREAMING (it has no
// message id, so nothing is stored). When the turn ends the live bubble goes and
// the stored message is mounted in its place: it takes this record over, so a
// slider moved mid-answer does not jump back. One entry per pane, in memory.
//
// The entry says WHOSE it is — the run that streamed it and the answer text it
// was set in — because the stored message that mounts next is not always that
// answer: leaving the chat view and coming back mid-stream remounts every older
// message first. Only the same run's live bubble, or a stored answer whose text
// continues that text, may take it.
export interface LiveWidgetState {
  conversationId: string | null;
  runId: string | null;
  /** The live answer's text when the entry was last written. */
  text: string;
  record: WidgetStateRecord;
  /** The control that had the focus (its key in the view), to give it back after the remount. */
  focus?: string | null;
}

const liveHandover = new Map<string, LiveWidgetState>();

export function setLiveWidgetState(paneId: string, entry: LiveWidgetState): void {
  liveHandover.set(paneId, entry);
}

/** The same run's entry, left in place: a live bubble that was remounted mid-stream continues from it. */
export function peekLiveWidgetState(paneId: string, conversationId: string | null | undefined, runId: string | null | undefined): LiveWidgetState | null {
  const entry = liveHandover.get(paneId);
  return entry && runId && entry.runId === runId && entry.conversationId === (conversationId || null) ? entry : null;
}

/**
 * The live answer's entry for the stored message it became, removed as it is
 * returned: same pane and conversation, and `text` (what the stored message
 * shows — all of it, or the part revealed so far) continues or is continued by
 * the text the entry was written in.
 */
export function takeLiveWidgetState(paneId: string, conversationId: string | null | undefined, text: string): LiveWidgetState | null {
  const entry = liveHandover.get(paneId);
  if (!entry || entry.conversationId !== (conversationId || null)) return null;
  const overlap = Math.min(entry.text.length, text.length);
  if (overlap === 0 || entry.text.slice(0, overlap) !== text.slice(0, overlap)) return null;
  liveHandover.delete(paneId);
  return entry;
}

export function clearLiveWidgetState(paneId: string): void {
  liveHandover.delete(paneId);
}
