// Prefetch on intent for the rail's conversation list. Opening a conversation
// waits for its messages (and its avatar) after the click; the rail starts that
// same fetch when the viewer shows intent — a short hover, a press, keyboard
// focus — and the click then reuses the in-flight or just-finished result.
//
// The cache holds RAW fetch results only. Building the pane and applying the
// result stays in lib/chat.ts (`loadPaneForConversation`), so a prefetched open
// and a cold one go through one applier.
import { api } from "./api";
import { loadMessages } from "./loaders";
import { appState, readState } from "./state";
import type { ClientState } from "./state";
import type { AvatarDetail, ConversationSummary } from "./types";

/* ---------- the cache (generic, no app state) ---------- */

export interface PrefetchCacheOptions<A, T> {
  load: (key: string, arg: A) => Promise<T>;
  /** How long a finished prefetch may wait for its click. */
  ttlMs: number;
  /** Finished results kept at once (oldest dropped first). */
  maxEntries: number;
  /** Prefetches allowed in flight at once; one more is simply not started. */
  maxInFlight: number;
  now?: () => number;
}

export interface PrefetchCache<A, T> {
  /** Start a background load unless one is cached or in flight. True = this call started it. */
  prefetch(key: string, arg: A): boolean;
  /**
   * The result for an OPEN: the prefetched one (in flight or finished) when there
   * is one, else a fresh load. The result is handed out ONCE — the caller owns
   * and mutates it — so it leaves the cache here.
   */
  take(key: string, arg: A): Promise<T>;
  /** Something may have changed this key: forget what was fetched for it. */
  invalidate(key: string): void;
  clear(): void;
  peek(key: string): "pending" | "ready" | null;
  readonly size: number;
}

interface PendingEntry<T> {
  state: "pending";
  promise: Promise<T>;
  /** An open is waiting on this request, so its result goes to that open only. */
  claimed: boolean;
  /** Started by a prefetch (before the open asked), not by the open itself. */
  prefetched: boolean;
  /** Invalidated after an open claimed it: the open must not use the result. */
  stale: boolean;
}

interface ReadyEntry<T> {
  state: "ready";
  value: T;
  at: number;
}

export function createPrefetchCache<A, T>(
  options: PrefetchCacheOptions<A, T>,
): PrefetchCache<A, T> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, PendingEntry<T> | ReadyEntry<T>>();

  function fresh(entry: ReadyEntry<T>): boolean {
    return now() - entry.at <= options.ttlMs;
  }

  function dropExpired(): void {
    for (const [key, entry] of entries) {
      if (entry.state === "ready" && !fresh(entry)) entries.delete(key);
    }
  }

  function trim(): void {
    let ready = 0;
    for (const entry of entries.values()) if (entry.state === "ready") ready += 1;
    for (const [key, entry] of entries) {
      if (ready <= options.maxEntries) break;
      if (entry.state !== "ready") continue;
      entries.delete(key);
      ready -= 1;
    }
  }

  function start(key: string, arg: A, claimed: boolean): PendingEntry<T> {
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(options.load(key, arg));
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry: PendingEntry<T> = {
      state: "pending",
      promise,
      claimed,
      prefetched: !claimed,
      stale: false,
    };
    entries.set(key, entry);
    // Attached FIRST, so the cache is already settled when a claiming open's own
    // handler runs. It also keeps a failed prefetch from being an unhandled
    // rejection: a prefetch failure is silent, the open reports its own.
    promise.then(
      (value) => {
        if (entries.get(key) !== entry) return; // invalidated while in flight
        entries.delete(key);
        if (entry.claimed) return; // the open has it
        entries.set(key, { state: "ready", value, at: now() });
        trim();
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return entry;
  }

  function invalidate(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.state === "pending" && entry.claimed) {
      // Stays registered (so nothing starts a second request beside it). A
      // request the OPEN started is exactly what a cold open does today; one
      // that predates the open may predate the change too.
      if (entry.prefetched) entry.stale = true;
      return;
    }
    entries.delete(key);
  }

  /** A load that belongs to one open alone and never touches the cache. */
  function loadAlone(key: string, arg: A): Promise<T> {
    try {
      return Promise.resolve(options.load(key, arg));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return {
    prefetch(key, arg) {
      dropExpired();
      if (entries.has(key)) return false;
      let inFlight = 0;
      for (const entry of entries.values()) {
        if (entry.state === "pending" && !entry.claimed) inFlight += 1;
      }
      if (inFlight >= options.maxInFlight) return false;
      start(key, arg, false);
      return true;
    },

    take(key, arg) {
      const entry = entries.get(key);
      if (entry?.state === "ready") {
        entries.delete(key);
        if (fresh(entry)) return Promise.resolve(entry.value);
      } else if (entry?.state === "pending") {
        // A second open of the same key never shares a result with the first —
        // each pane owns its own message objects.
        if (entry.claimed) return loadAlone(key, arg);
        entry.claimed = true;
        // The prefetch failed, or was invalidated after this open claimed it:
        // load normally, and let THAT load's error be the one the open reports.
        return entry.promise.then(
          (value) => (entry.stale ? start(key, arg, true).promise : value),
          () => start(key, arg, true).promise,
        );
      }
      return start(key, arg, true).promise;
    },

    invalidate,

    clear() {
      for (const key of [...entries.keys()]) invalidate(key);
    },

    peek(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.state === "ready" && !fresh(entry)) return null;
      return entry.state;
    },

    get size() {
      return entries.size;
    },
  };
}

/* ---------- a short dwell before acting on hover / focus ---------- */

export interface IntentDwell {
  /** Run for `key` after the dwell, unless cancelled or re-armed for another key first. */
  arm(key: string): void;
  /** Cancel the pending run (only if it is for `key`, when given). */
  cancel(key?: string): void;
}

export function createIntentDwell(run: (key: string) => void, ms: number): IntentDwell {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = "";
  const cancel = (key?: string): void => {
    if (timer === null || (key !== undefined && key !== pending)) return;
    clearTimeout(timer);
    timer = null;
    pending = "";
  };
  return {
    arm(key) {
      if (timer !== null && pending === key) return;
      cancel();
      pending = key;
      timer = setTimeout(() => {
        timer = null;
        pending = "";
        run(key);
      }, ms);
    },
    cancel,
  };
}

/* ---------- the app's conversation cache ---------- */

/** What opening a conversation fetches: its messages payload and its avatar. */
export interface ConversationLoad {
  loaded: Awaited<ReturnType<typeof loadMessages>>;
  avatar: AvatarDetail;
}

type LoadTarget = Pick<ConversationSummary, "id" | "avatarUserId">;

/** Hover / focus dwell before a prefetch starts. */
export const PREFETCH_DWELL_MS = 120;
// Long enough for hover → read the title → click, short enough that a snapshot
// is never older than a glance; the list reload after every turn clears it anyway.
export const PREFETCH_TTL_MS = 15_000;
export const PREFETCH_MAX_ENTRIES = 4;
export const PREFETCH_MAX_IN_FLIGHT = 2;

async function fetchConversationLoad(
  _key: string,
  conversation: LoadTarget,
): Promise<ConversationLoad> {
  const [loaded, avatarRes] = await Promise.all([
    loadMessages(conversation.id),
    api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(conversation.avatarUserId)}`,
    ),
  ]);
  return { loaded, avatar: avatarRes.avatar };
}

const conversationLoads = createPrefetchCache<LoadTarget, ConversationLoad>({
  load: fetchConversationLoad,
  ttlMs: PREFETCH_TTL_MS,
  maxEntries: PREFETCH_MAX_ENTRIES,
  maxInFlight: PREFETCH_MAX_IN_FLIGHT,
});

/**
 * Start fetching a conversation the viewer is about to open. Never for one that
 * is open in a pane (the pane is the live copy) or has a run answering (a
 * snapshot goes stale while it streams). Failures are silent.
 */
export function prefetchConversation(conversation: ConversationSummary): boolean {
  const state = readState();
  if (!state.user || conversation.activeRun) return false;
  if (state.chatPanes.some((pane) => pane.conversationId === conversation.id)) return false;
  return conversationLoads.prefetch(conversation.id, conversation);
}

/** The load for an OPEN — the prefetched one when there is one. Hands it out once. */
export function takeConversationLoad(conversation: LoadTarget): Promise<ConversationLoad> {
  return conversationLoads.take(conversation.id, conversation);
}

/** Forget what was prefetched for one conversation, or (no id) for all of them. */
export function invalidateConversationPrefetch(conversationId?: string): void {
  if (conversationId === undefined) conversationLoads.clear();
  else conversationLoads.invalidate(conversationId);
}

/** Test/diagnostic view of one conversation's cache slot. */
export function conversationPrefetchState(conversationId: string): "pending" | "ready" | null {
  return conversationLoads.peek(conversationId);
}

// ONE place decides when a snapshot can no longer be trusted, from the store
// every such change already goes through — so a new send/rewind/delete path
// cannot forget to invalidate:
//  - the signed-in user changed (logout, session expiry, another login) → all;
//  - the conversation LIST was replaced (a reload — which follows every finished
//    turn — a delete, 비우기, a rename) → all: a new list is new information
//    about every row, and nothing in it proves a transcript did not move;
//  - a conversation is open in a pane (a turn starting or finishing there, a
//    steer, a rewind / 다시 생성, a canvas answer all happen in a pane) → that one.
// It runs on every store write, token-rate while a run streams, so the common
// case is three comparisons.
let watchedUserId: string | null = null;
let watchedConversations: ClientState["conversations"] | null = null;

appState.subscribe((state) => {
  const userId = state.user?.id ?? null;
  const userChanged = userId !== watchedUserId;
  const listChanged = state.conversations !== watchedConversations;
  watchedUserId = userId;
  watchedConversations = state.conversations;
  if (!conversationLoads.size) return;
  if (userChanged || listChanged) {
    conversationLoads.clear();
    return;
  }
  for (const pane of state.chatPanes) conversationLoads.invalidate(pane.conversationId);
});
