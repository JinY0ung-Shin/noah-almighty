// @vitest-environment jsdom
// Prefetch on intent (lib/conversationPrefetch.ts): the rail starts a
// conversation's load on hover/press/focus and the open reuses that one request.
// Three layers: the generic cache, the dwell timer, and the wiring into the real
// open paths (selectConversation / addConversationToSplit) and the store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addConversationToSplit,
  clearChatHistory,
  selectConversation,
} from "../src/client/src/lib/chat.js";
import {
  conversationPrefetchState,
  createIntentDwell,
  createPrefetchCache,
  invalidateConversationPrefetch,
  prefetchConversation,
  PREFETCH_MAX_ENTRIES,
  PREFETCH_TTL_MS,
} from "../src/client/src/lib/conversationPrefetch.js";
import { readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import type { ConversationSummary } from "../src/client/src/lib/types.js";
import { get } from "../src/client/src/lib/store.js";

/* ------------------------------------------------------------------ */
/* the generic cache                                                   */
/* ------------------------------------------------------------------ */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(opts: { ttlMs?: number; maxEntries?: number; maxInFlight?: number } = {}) {
  const calls: Array<{ key: string; d: Deferred<string> }> = [];
  let clock = 1_000;
  const cache = createPrefetchCache<null, string>({
    load: (key) => {
      const d = deferred<string>();
      calls.push({ key, d });
      return d.promise;
    },
    ttlMs: opts.ttlMs ?? 100,
    maxEntries: opts.maxEntries ?? 2,
    maxInFlight: opts.maxInFlight ?? 2,
    now: () => clock,
  });
  return {
    cache,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPrefetchCache", () => {
  it("an open that arrives while the prefetch is in flight reuses that request", async () => {
    const { cache, calls } = harness();
    expect(cache.prefetch("a", null)).toBe(true);
    expect(cache.peek("a")).toBe("pending");
    const taken = cache.take("a", null);
    expect(calls).toHaveLength(1);
    calls[0].d.resolve("A1");
    expect(await taken).toBe("A1");
    // Handed to the open — nothing stays behind.
    expect(cache.peek("a")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("an open after the prefetch finished uses the result ONCE", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    calls[0].d.resolve("A1");
    await flush();
    expect(cache.peek("a")).toBe("ready");
    expect(await cache.take("a", null)).toBe("A1");
    expect(calls).toHaveLength(1);
    // The pane owns (and mutates) what it took: a later open loads again.
    const second = cache.take("a", null);
    expect(calls).toHaveLength(2);
    calls[1].d.resolve("A2");
    expect(await second).toBe("A2");
  });

  it("never starts a second request beside one that is cached or in flight", async () => {
    const { cache, calls } = harness();
    expect(cache.prefetch("a", null)).toBe(true);
    expect(cache.prefetch("a", null)).toBe(false);
    calls[0].d.resolve("A1");
    await flush();
    expect(cache.prefetch("a", null)).toBe(false);
    expect(calls).toHaveLength(1);
    // …nor beside an open's OWN load.
    const own = cache.take("b", null);
    expect(cache.prefetch("b", null)).toBe(false);
    expect(calls).toHaveLength(2);
    calls[1].d.resolve("B1");
    expect(await own).toBe("B1");
    expect(cache.size).toBe(1); // only "a" is cached; an open's result is never kept
  });

  it("drops a finished result after the TTL", async () => {
    const { cache, calls, advance } = harness({ ttlMs: 100 });
    cache.prefetch("a", null);
    calls[0].d.resolve("A1");
    await flush();
    advance(101);
    expect(cache.peek("a")).toBeNull();
    const taken = cache.take("a", null);
    expect(calls).toHaveLength(2);
    calls[1].d.resolve("A2");
    expect(await taken).toBe("A2");
  });

  it("keeps at most maxEntries finished results, oldest dropped first", async () => {
    const { cache, calls } = harness({ maxEntries: 2, maxInFlight: 9 });
    for (const key of ["a", "b", "c"]) cache.prefetch(key, null);
    for (const [i, key] of ["a", "b", "c"].entries()) {
      calls[i].d.resolve(key.toUpperCase());
      await flush();
    }
    expect(cache.peek("a")).toBeNull();
    expect(cache.peek("b")).toBe("ready");
    expect(cache.peek("c")).toBe("ready");
    expect(cache.size).toBe(2);
  });

  it("does not start a prefetch past maxInFlight, and an open still loads", async () => {
    const { cache, calls } = harness({ maxInFlight: 2 });
    expect(cache.prefetch("a", null)).toBe(true);
    expect(cache.prefetch("b", null)).toBe(true);
    expect(cache.prefetch("c", null)).toBe(false);
    expect(calls).toHaveLength(2);
    const taken = cache.take("c", null);
    expect(calls.map((call) => call.key)).toEqual(["a", "b", "c"]);
    calls[2].d.resolve("C1");
    expect(await taken).toBe("C1");
  });

  it("an invalidated prefetch is never used — finished or still in flight", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    calls[0].d.resolve("stale");
    await flush();
    cache.invalidate("a");
    expect(cache.peek("a")).toBeNull();

    cache.prefetch("b", null);
    cache.invalidate("b");
    calls[1].d.resolve("stale too");
    await flush();
    expect(cache.peek("b")).toBeNull(); // the late result was not cached

    const taken = cache.take("a", null);
    expect(calls).toHaveLength(3);
    calls[2].d.resolve("fresh");
    expect(await taken).toBe("fresh");
  });

  it("an invalidation after the open claimed a PREFETCHED request makes the open load again", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    const taken = cache.take("a", null);
    cache.invalidate("a");
    // Still registered: nothing may start a second request beside it meanwhile.
    expect(cache.prefetch("a", null)).toBe(false);
    calls[0].d.resolve("older than the change");
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].d.resolve("fresh");
    expect(await taken).toBe("fresh");
  });

  it("an invalidation during an open's OWN load changes nothing (a cold open today)", async () => {
    const { cache, calls } = harness();
    const taken = cache.take("a", null);
    cache.invalidate("a");
    cache.clear();
    calls[0].d.resolve("A1");
    expect(await taken).toBe("A1");
    expect(calls).toHaveLength(1);
  });

  it("a failed prefetch is silent, and the next open loads and reports its own error", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    calls[0].d.reject(new Error("prefetch failed"));
    await flush(); // no unhandled rejection
    expect(cache.peek("a")).toBeNull();
    const taken = cache.take("a", null);
    expect(calls).toHaveLength(2);
    calls[1].d.reject(new Error("open failed"));
    await expect(taken).rejects.toThrow("open failed");
    expect(cache.size).toBe(0);
  });

  it("an open that claimed a prefetch which then fails loads normally", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    const taken = cache.take("a", null);
    calls[0].d.reject(new Error("prefetch failed"));
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].d.resolve("A2");
    expect(await taken).toBe("A2");
  });

  it("two opens of the same key never share one result object", async () => {
    const { cache, calls } = harness();
    cache.prefetch("a", null);
    const first = cache.take("a", null);
    const second = cache.take("a", null);
    expect(calls).toHaveLength(2);
    calls[0].d.resolve("for the first");
    calls[1].d.resolve("for the second");
    expect(await first).toBe("for the first");
    expect(await second).toBe("for the second");
  });

  it("clear forgets everything that no open is waiting on", async () => {
    const { cache, calls } = harness({ maxInFlight: 9 });
    cache.prefetch("a", null);
    calls[0].d.resolve("A1");
    await flush();
    cache.prefetch("b", null);
    cache.clear();
    expect(cache.size).toBe(0);
    calls[1].d.resolve("B1");
    await flush();
    expect(cache.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* the dwell                                                           */
/* ------------------------------------------------------------------ */

describe("createIntentDwell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after the dwell, not before", () => {
    const run = vi.fn();
    const dwell = createIntentDwell(run, 120);
    dwell.arm("a");
    vi.advanceTimersByTime(119);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("a pointer that leaves before the dwell ends starts nothing", () => {
    const run = vi.fn();
    const dwell = createIntentDwell(run, 120);
    dwell.arm("a");
    vi.advanceTimersByTime(60);
    dwell.cancel("a");
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });

  it("moving to another row restarts the dwell for THAT row only", () => {
    const run = vi.fn();
    const dwell = createIntentDwell(run, 120);
    dwell.arm("a");
    vi.advanceTimersByTime(100);
    dwell.arm("b");
    // A late leave event of the row that is no longer pending is ignored.
    dwell.cancel("a");
    vi.advanceTimersByTime(119);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("re-arming the pending row does not push its dwell back", () => {
    const run = vi.fn();
    const dwell = createIntentDwell(run, 120);
    dwell.arm("a");
    vi.advanceTimersByTime(100);
    dwell.arm("a");
    vi.advanceTimersByTime(20);
    expect(run).toHaveBeenCalledExactlyOnceWith("a");
  });
});

/* ------------------------------------------------------------------ */
/* wired into the real open paths and the store                        */
/* ------------------------------------------------------------------ */

const PRISTINE = structuredClone(readState());

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

const summary = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  avatarUserId: "av1",
  avatarDisplayName: "노아",
  title: id,
  updatedAt: "2026-11-11T03:00:00.000Z",
  isRoutine: false,
  routineId: null,
  routinePrompt: null,
  activeRun: null,
  ...extra,
});

/** A server with two conversations; counts requests per kind and can hold messages back. */
function useServer(opts: { failMessages?: () => boolean; hold?: boolean } = {}) {
  const counts = { messages: 0, avatars: 0, runs: 0, list: 0 };
  const held: Array<() => void> = [];
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("/api/messages")) {
      counts.messages += 1;
      const id = new URL(url, "http://x").searchParams.get("conversationId");
      if (opts.hold) await new Promise<void>((resolve) => held.push(resolve));
      if (opts.failMessages?.()) return jsonRes({ error: "boom" }, 500);
      return jsonRes({
        messages: [{ id: `m-${id}`, role: "assistant", content: `${id}의 답변`, response: null, conversationId: id, createdAt: "t" }],
        canvases: [],
        selectedModel: "deepseek/v3",
      });
    }
    if (url.startsWith("/api/avatars/")) {
      counts.avatars += 1;
      return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
    }
    if (url.startsWith("/api/chat/runs")) {
      counts.runs += 1;
      return jsonRes({ run: null });
    }
    if (url === "/api/conversations" && init.method === "DELETE") {
      return jsonRes({ deleted: 2, conversationIds: ["c1", "c2"] });
    }
    if (url === "/api/conversations") {
      counts.list += 1;
      return jsonRes({ conversations: [summary("c1"), summary("c2")] });
    }
    throw new Error(`unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { counts, releaseAll: () => held.splice(0).forEach((release) => release()) };
}

async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

describe("conversation prefetch wired into the open paths", () => {
  beforeEach(() => {
    replaceState(structuredClone(PRISTINE));
    replaceState({ user: { id: "owner-1" } as any, conversations: [summary("c1"), summary("c2")] });
    invalidateConversationPrefetch();
    toasts.set([]);
  });
  afterEach(() => {
    invalidateConversationPrefetch();
    vi.unstubAllGlobals();
  });

  it("a prefetched open issues no second request and builds the same pane a cold open builds", async () => {
    const { counts } = useServer();
    expect(prefetchConversation(readState().conversations[0])).toBe(true);
    await waitFor(() => conversationPrefetchState("c1") === "ready");
    expect(counts).toMatchObject({ messages: 1, avatars: 1 });

    await selectConversation("c1");
    expect(counts).toMatchObject({ messages: 1, avatars: 1 });
    const warm = readState().chatPanes[0];
    expect(readState().chatPanes).toHaveLength(1);
    expect(conversationPrefetchState("c1")).toBeNull();

    // The cold open of the other conversation, for comparison.
    await selectConversation("c2");
    expect(counts).toMatchObject({ messages: 2, avatars: 2 });
    const cold = readState().chatPanes[0];
    for (const pane of [warm, cold]) {
      expect(pane).toMatchObject({ model: "deepseek/v3", stickBottom: true, streaming: false, sideTab: null });
      expect(pane.messages).toHaveLength(1);
      expect(pane.avatar.id).toBe("av1");
    }
    expect(warm.messages[0].content).toBe("c1의 답변");
    expect(readState().view).toBe("chat");
  });

  it("a click during the prefetch waits on that one request", async () => {
    const { counts, releaseAll } = useServer({ hold: true });
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => counts.messages === 1);
    const opening = selectConversation("c1");
    await new Promise((r) => setTimeout(r, 5));
    expect(counts.messages).toBe(1);
    expect(readState().chatPanes).toHaveLength(0);
    releaseAll();
    await opening;
    expect(counts).toMatchObject({ messages: 1, avatars: 1 });
    expect(readState().chatPanes[0].conversationId).toBe("c1");
    // The reattach probe is still fired after the open, exactly as on a cold one.
    await waitFor(() => counts.runs === 1);
  });

  it("the split-view open reuses a prefetch too", async () => {
    const { counts } = useServer();
    await selectConversation("c1");
    prefetchConversation(readState().conversations[1]);
    await waitFor(() => conversationPrefetchState("c2") === "ready");
    const before = { ...counts };
    await addConversationToSplit("c2");
    expect(counts.messages).toBe(before.messages);
    expect(counts.avatars).toBe(before.avatars);
    expect(readState().chatPanes.map((pane) => pane.conversationId)).toEqual(["c1", "c2"]);
    expect(readState().activePaneId).toBe(readState().chatPanes[1].id);
  });

  it("never prefetches a conversation that is open in a pane, has a run, or without a signed-in user", async () => {
    const { counts } = useServer();
    await selectConversation("c1");
    const base = counts.messages;
    expect(prefetchConversation(summary("c1"))).toBe(false);
    expect(prefetchConversation(summary("c2", { activeRun: {} }))).toBe(false);
    replaceState({ user: null });
    expect(prefetchConversation(summary("c2"))).toBe(false);
    expect(counts.messages).toBe(base);
  });

  it("a replaced conversation list (reload, delete, rename) drops every prefetched result", async () => {
    const { counts } = useServer();
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => conversationPrefetchState("c1") === "ready");
    replaceState({ conversations: [...readState().conversations] });
    expect(conversationPrefetchState("c1")).toBeNull();
    await selectConversation("c1");
    expect(counts.messages).toBe(2);
  });

  it("a list replaced while the prefetch is in flight discards its late result", async () => {
    const { counts, releaseAll } = useServer({ hold: true });
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => counts.messages === 1);
    replaceState({ conversations: [...readState().conversations] });
    releaseAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(conversationPrefetchState("c1")).toBeNull();
  });

  it("an unrelated store write keeps the cache; a pane holding the conversation drops it", async () => {
    useServer();
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => conversationPrefetchState("c1") === "ready");
    updateState((state) => {
      state.view = "explore";
    });
    expect(conversationPrefetchState("c1")).toBe("ready");
    // Anything that moves a transcript happens in a pane (a turn starting or
    // finishing, a steer, a rewind, 다시 생성).
    updateState((state) => {
      state.chatPanes = [{ id: "p1", conversationId: "c1", streaming: true, messages: [] } as any];
    });
    expect(conversationPrefetchState("c1")).toBeNull();
  });

  it("logout or another user drops everything", async () => {
    useServer();
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => conversationPrefetchState("c1") === "ready");
    replaceState({ user: { id: "someone-else" } as any });
    expect(conversationPrefetchState("c1")).toBeNull();

    prefetchConversation(readState().conversations[1]);
    await waitFor(() => conversationPrefetchState("c2") === "ready");
    replaceState({ user: null });
    expect(conversationPrefetchState("c2")).toBeNull();
  });

  it("비우기 drops everything", async () => {
    useServer();
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => conversationPrefetchState("c1") === "ready");
    await clearChatHistory();
    expect(conversationPrefetchState("c1")).toBeNull();
    expect(readState().conversations).toHaveLength(0);
  });

  it("a prefetch failure toasts nothing; the click then loads normally and reports its own error", async () => {
    let fail = true;
    const { counts } = useServer({ failMessages: () => fail });
    prefetchConversation(readState().conversations[0]);
    await waitFor(() => counts.messages === 1 && conversationPrefetchState("c1") === null);
    expect(get(toasts)).toHaveLength(0);

    await expect(selectConversation("c1")).rejects.toThrow();
    expect(counts.messages).toBe(2);
    expect(readState().chatPanes).toHaveLength(0);

    fail = false;
    await selectConversation("c1");
    expect(counts.messages).toBe(3);
    expect(readState().chatPanes[0].conversationId).toBe("c1");
  });

  it("holds only a handful of results", async () => {
    const ids = Array.from({ length: PREFETCH_MAX_ENTRIES + 2 }, (_, i) => `k${i}`);
    replaceState({ conversations: ids.map((id) => summary(id)) });
    useServer();
    for (const id of ids) {
      expect(prefetchConversation(summary(id))).toBe(true);
      await waitFor(() => conversationPrefetchState(id) === "ready");
    }
    const cached = ids.filter((id) => conversationPrefetchState(id) === "ready");
    expect(cached).toEqual(ids.slice(-PREFETCH_MAX_ENTRIES));
    expect(PREFETCH_MAX_ENTRIES).toBeLessThanOrEqual(6);
    expect(PREFETCH_TTL_MS).toBeLessThanOrEqual(30_000);
  });
});
