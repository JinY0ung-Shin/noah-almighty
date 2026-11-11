// Inline UI state in localStorage (lib/widgetState.ts): one key per
// (user, conversation, message), a size cap, an LRU of 50 answers, no throw
// when storage is unavailable — and the in-memory handover of a streaming
// answer's state to the stored message it becomes.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WIDGET_STATE_CHARS,
  MAX_WIDGET_STATE_ENTRIES,
  WIDGET_STATE_INDEX_KEY,
  clearLiveWidgetState,
  createWidgetStateSaver,
  loadWidgetState,
  peekLiveWidgetState,
  removeConversationWidgetState,
  removeWidgetState,
  saveWidgetState,
  setLiveWidgetState,
  takeLiveWidgetState,
  widgetStateKey,
} from "../src/client/src/lib/widgetState.js";
import { dataSize, parseWidget, restoreState } from "../src/shared/widget/index.js";

function ref(userId: string | null | undefined, messageId: string, conversationId: string | null = "conv-1") {
  return { userId, conversationId, messageId };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const brokenStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

afterEach(() => vi.useRealTimers());

describe("widgetState", () => {
  it("round-trips a record under a per-user, per-canvas key", () => {
    const storage = memoryStorage();
    const record = { n: { sig: "n = 2", value: 5 }, tags: { sig: 'tags = ["a"]', value: ["a", "b"] } };
    expect(saveWidgetState(ref("u1", "cv1"), record, dataSize, storage)).toBe(true);
    expect([...storage.data.keys()].sort()).toEqual([WIDGET_STATE_INDEX_KEY, "noah:inline-ui:u1:conv-1:cv1"].sort());
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toEqual(record);
    // Another account on the same browser, or another canvas, sees nothing…
    expect(loadWidgetState(ref("u2", "cv1"), storage)).toBeNull();
    expect(loadWidgetState(ref("u1", "cv2"), storage)).toBeNull();
    // …and neither does the SAME canvas id in another conversation (an id the avatar chose and reused).
    expect(loadWidgetState(ref("u1", "cv1", "conv-2"), storage)).toBeNull();
  });

  it("needs a signed-in user, a conversation and a canvas id", () => {
    const storage = memoryStorage();
    expect(saveWidgetState(ref(undefined, "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, storage)).toBe(false);
    expect(saveWidgetState(ref("u1", ""), { n: { sig: "n = 2", value: 5 } }, dataSize, storage)).toBe(false);
    expect(saveWidgetState(ref("u1", "cv1", null), { n: { sig: "n = 2", value: 5 } }, dataSize, storage)).toBe(false);
    expect(widgetStateKey(ref("u1", "cv1", ""))).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(loadWidgetState(ref(null, "cv1"), storage)).toBeNull();
  });

  it("restores only values whose declaration is unchanged", () => {
    const storage = memoryStorage();
    saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 }, note: { sig: 'note = "a"', value: "typed" } }, dataSize, storage);
    const doc = parseWidget(`{@state n = 2}\n{@state note = "b"}\n\n<text>{n} {note}</text>\n`);
    expect(restoreState(doc, loadWidgetState(ref("u1", "cv1"), storage)).values).toMatchObject({ n: 5, note: "b" });
  });

  it("ignores stored data that is not a record of { sig, value }", () => {
    const key = widgetStateKey(ref("u1", "cv1"))!;
    expect(loadWidgetState(ref("u1", "cv1"), memoryStorage({ [key]: "not json" }))).toBeNull();
    expect(loadWidgetState(ref("u1", "cv1"), memoryStorage({ [key]: "[1,2]" }))).toBeNull();
    expect(loadWidgetState(ref("u1", "cv1"), memoryStorage({ [key]: '{"n":5,"m":{"value":1},"ok":{"sig":"ok = 1","value":2}}' }))).toEqual({
      ok: { sig: "ok = 1", value: 2 },
    });
    expect(loadWidgetState(ref("u1", "cv1"), memoryStorage({ [key]: "x".repeat(MAX_WIDGET_STATE_CHARS + 1) }))).toBeNull();
  });

  it("does not store a record over the size cap, and drops what was there", () => {
    const storage = memoryStorage();
    saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, storage);
    const huge = { text: { sig: 'text = ""', value: "가".repeat(MAX_WIDGET_STATE_CHARS) } };
    expect(saveWidgetState(ref("u1", "cv1"), huge, dataSize, storage)).toBe(false);
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("measures a record before serializing it, and never serializes one over the cap", () => {
    const storage = memoryStorage();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const sizes: number[] = [];
      const sizeOf = (value: unknown, limit: number) => {
        sizes.push(limit);
        return dataSize(value, limit);
      };
      const huge = { rows: { sig: "rows = []", value: Array.from({ length: 60_000 }, (_, i) => ({ i, name: "항목" })) } };
      expect(saveWidgetState(ref("u1", "cv1"), huge, sizeOf, storage)).toBe(false);
      expect(sizes).toEqual([MAX_WIDGET_STATE_CHARS]);
      expect(stringify.mock.calls.some(([value]) => value === huge)).toBe(false);

      const small = { n: { sig: "n = 2", value: 5 } };
      expect(saveWidgetState(ref("u1", "cv1"), small, sizeOf, storage)).toBe(true);
      expect(stringify.mock.calls.some(([value]) => value === small)).toBe(true);
      // A size function that cannot answer (the library not loaded) means "do not store".
      expect(saveWidgetState(ref("u1", "cv2"), small, (_value, limit) => limit + 1, storage)).toBe(false);
      expect(loadWidgetState(ref("u1", "cv2"), storage)).toBeNull();
    } finally {
      stringify.mockRestore();
    }
  });

  it("an empty record removes the key", () => {
    const storage = memoryStorage();
    saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, storage);
    expect(saveWidgetState(ref("u1", "cv1"), {}, dataSize, storage)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it("keeps the most recently saved canvases and evicts the oldest", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_WIDGET_STATE_ENTRIES + 3; i++) saveWidgetState(ref("u1", `cv${i}`), { n: { sig: "n = 2", value: i } }, dataSize, storage);
    expect(loadWidgetState(ref("u1", "cv0"), storage)).toBeNull();
    expect(loadWidgetState(ref("u1", "cv2"), storage)).toBeNull();
    expect(loadWidgetState(ref("u1", "cv3"), storage)).toEqual({ n: { sig: "n = 2", value: 3 } });
    // Saving an old canvas again makes it recent.
    saveWidgetState(ref("u1", "cv3"), { n: { sig: "n = 2", value: 33 } }, dataSize, storage);
    saveWidgetState(ref("u1", "new"), { n: { sig: "n = 2", value: 0 } }, dataSize, storage);
    expect(loadWidgetState(ref("u1", "cv3"), storage)).toEqual({ n: { sig: "n = 2", value: 33 } });
    expect(loadWidgetState(ref("u1", "cv4"), storage)).toBeNull();
    expect(JSON.parse(storage.data.get(WIDGET_STATE_INDEX_KEY)!)).toHaveLength(MAX_WIDGET_STATE_ENTRIES);
  });

  it("removes one canvas's state and its index entry", () => {
    const storage = memoryStorage();
    saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, storage);
    saveWidgetState(ref("u1", "cv2"), { n: { sig: "n = 2", value: 6 } }, dataSize, storage);
    removeWidgetState(ref("u1", "cv1"), storage);
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toBeNull();
    expect(JSON.parse(storage.data.get(WIDGET_STATE_INDEX_KEY)!)).toEqual([widgetStateKey(ref("u1", "cv2"))!]);
    removeWidgetState(ref("u1", "cv2"), storage);
    expect(storage.data.size).toBe(0);
  });

  it("forgets every widget of a deleted conversation, and only that conversation's", () => {
    const storage = memoryStorage();
    const record = { n: { sig: "n = 2", value: 5 } };
    saveWidgetState(ref("u1", "cv1", "conv-1"), record, dataSize, storage);
    saveWidgetState(ref("u1", "cv2", "conv-1"), record, dataSize, storage);
    saveWidgetState(ref("u1", "cv1", "conv-10"), record, dataSize, storage); // a longer id with the same start
    saveWidgetState(ref("u2", "cv1", "conv-1"), record, dataSize, storage); // another account
    // A key the index lost track of is still swept when the storage can be enumerated.
    const stray = widgetStateKey(ref("u1", "stray", "conv-1"))!;
    storage.data.set(stray, JSON.stringify(record));
    const enumerable = {
      ...storage,
      get length() {
        return storage.data.size;
      },
      key: (i: number) => [...storage.data.keys()][i] ?? null,
    };

    removeConversationWidgetState("u1", "conv-1", enumerable);
    expect(loadWidgetState(ref("u1", "cv1", "conv-1"), storage)).toBeNull();
    expect(loadWidgetState(ref("u1", "cv2", "conv-1"), storage)).toBeNull();
    expect(storage.data.has(stray)).toBe(false);
    expect(loadWidgetState(ref("u1", "cv1", "conv-10"), storage)).toEqual(record);
    expect(loadWidgetState(ref("u2", "cv1", "conv-1"), storage)).toEqual(record);
    expect(JSON.parse(storage.data.get(WIDGET_STATE_INDEX_KEY)!).sort()).toEqual(
      [widgetStateKey(ref("u1", "cv1", "conv-10"))!, widgetStateKey(ref("u2", "cv1", "conv-1"))!].sort(),
    );

    // Index-only storage (no enumeration), nothing to remove, missing ids, blocked storage: all quiet.
    saveWidgetState(ref("u1", "cv9", "conv-9"), record, dataSize, storage);
    removeConversationWidgetState("u1", "conv-9", storage);
    expect(loadWidgetState(ref("u1", "cv9", "conv-9"), storage)).toBeNull();
    expect(() => {
      removeConversationWidgetState("u1", "conv-none", storage);
      removeConversationWidgetState(null, "conv-1", storage);
      removeConversationWidgetState("u1", "", storage);
      removeConversationWidgetState("u1", "conv-1", brokenStorage);
      removeConversationWidgetState("u1", "conv-1", null);
    }).not.toThrow();
  });

  it("never throws when storage is blocked or missing", () => {
    expect(loadWidgetState(ref("u1", "cv1"), brokenStorage)).toBeNull();
    expect(saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, brokenStorage)).toBe(false);
    expect(() => removeWidgetState(ref("u1", "cv1"), brokenStorage)).not.toThrow();
    expect(loadWidgetState(ref("u1", "cv1"), null)).toBeNull();
    expect(saveWidgetState(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } }, dataSize, null)).toBe(false);
    const saver = createWidgetStateSaver(dataSize, 10, brokenStorage);
    expect(() => {
      saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } });
      saver.flush();
    }).not.toThrow();
  });

  it("debounces saves, flushes on demand and can cancel", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const saver = createWidgetStateSaver(dataSize, 300, storage);
    saver.schedule(ref("u1", "cv1", "conv-saver"), { n: { sig: "n = 2", value: 1 } });
    vi.advanceTimersByTime(200);
    saver.schedule(ref("u1", "cv1", "conv-saver"), { n: { sig: "n = 2", value: 2 } });
    vi.advanceTimersByTime(200);
    expect(loadWidgetState(ref("u1", "cv1", "conv-saver"), storage)).toBeNull(); // the second call restarted the wait
    vi.advanceTimersByTime(100);
    expect(loadWidgetState(ref("u1", "cv1", "conv-saver"), storage)).toEqual({ n: { sig: "n = 2", value: 2 } });

    saver.schedule(ref("u1", "cv1", "conv-saver"), { n: { sig: "n = 2", value: 3 } });
    saver.flush();
    expect(loadWidgetState(ref("u1", "cv1", "conv-saver"), storage)).toEqual({ n: { sig: "n = 2", value: 3 } });

    saver.schedule(ref("u1", "cv1", "conv-saver"), { n: { sig: "n = 2", value: 4 } });
    saver.cancel();
    vi.advanceTimersByTime(1000);
    expect(loadWidgetState(ref("u1", "cv1", "conv-saver"), storage)).toEqual({ n: { sig: "n = 2", value: 3 } });

    // A pending save for one canvas is written before another canvas's replaces it.
    saver.schedule(ref("u1", "cv1", "conv-saver"), { n: { sig: "n = 2", value: 5 } });
    saver.schedule(ref("u1", "cv2", "conv-saver"), { n: { sig: "n = 2", value: 6 } });
    expect(loadWidgetState(ref("u1", "cv1", "conv-saver"), storage)).toEqual({ n: { sig: "n = 2", value: 5 } });
    vi.advanceTimersByTime(300);
    expect(loadWidgetState(ref("u1", "cv2", "conv-saver"), storage)).toEqual({ n: { sig: "n = 2", value: 6 } });
  });
});

describe("a deleted conversation", () => {
  it("is not written to again: a save that was still pending must not bring its key back", () => {
    const storage = memoryStorage();
    const record = { n: { sig: "n = 2", value: 5 } };
    expect(saveWidgetState(ref("u-del", "m-1", "conv-del"), record, dataSize, storage)).toBe(true);
    removeConversationWidgetState("u-del", "conv-del", storage);
    expect(storage.data.size).toBe(0);
    expect(saveWidgetState(ref("u-del", "m-1", "conv-del"), record, dataSize, storage)).toBe(false);
    expect(storage.data.size).toBe(0);
    // Another conversation, and the same conversation id of another account, are unaffected.
    expect(saveWidgetState(ref("u-del", "m-1", "conv-other"), record, dataSize, storage)).toBe(true);
    expect(saveWidgetState(ref("u-two", "m-1", "conv-del"), record, dataSize, storage)).toBe(true);
  });
});

describe("the live handover", () => {
  const record = { n: { sig: "n = 2", value: 9 } };
  const entry = (text: string, over: Record<string, unknown> = {}) => ({ conversationId: "conv-1", runId: "run-1", text, record, focus: null, ...over });

  it("goes to the stored answer that continues the live text — and only once", () => {
    setLiveWidgetState("pane-1", entry("계산기입니다.\n\n{@state n = 2}\n<slider"));
    // Another answer with the same declaration is not that answer.
    expect(takeLiveWidgetState("pane-1", "conv-1", "다른 답변입니다.\n\n{@state n = 2}\n")).toBeNull();
    // Another conversation in the same pane is not either.
    expect(takeLiveWidgetState("pane-1", "conv-2", "계산기입니다.\n\n{@state n = 2}\n<slider label")).toBeNull();
    // The stored message shows the whole answer, or only the part revealed so far: both continue the live text.
    expect(takeLiveWidgetState("pane-1", "conv-1", "계산기입니다.\n\n{@state n = 2}\n<slider label=\"수량\" />")?.record).toEqual(record);
    expect(takeLiveWidgetState("pane-1", "conv-1", "계산기입니다.\n\n{@state n = 2}\n<slider label=\"수량\" />")).toBeNull();
    setLiveWidgetState("pane-1", entry("계산기입니다.\n\n{@state n = 2}\n<slider"));
    expect(takeLiveWidgetState("pane-1", "conv-1", "계산기입니다.")?.record).toEqual(record);
    // Nothing shown yet says nothing about whose it is.
    setLiveWidgetState("pane-1", entry("계산기입니다."));
    expect(takeLiveWidgetState("pane-1", "conv-1", "")).toBeNull();
    clearLiveWidgetState("pane-1");
  });

  it("is left in place for the SAME run's live bubble (the chat view was reopened mid-stream)", () => {
    setLiveWidgetState("pane-1", entry("계산기", { focus: "-12" }));
    expect(peekLiveWidgetState("pane-1", "conv-1", "run-2")).toBeNull();
    expect(peekLiveWidgetState("pane-1", "conv-9", "run-1")).toBeNull();
    expect(peekLiveWidgetState("pane-2", "conv-1", "run-1")).toBeNull();
    expect(peekLiveWidgetState("pane-1", "conv-1", null)).toBeNull();
    expect(peekLiveWidgetState("pane-1", "conv-1", "run-1")).toMatchObject({ record, focus: "-12" });
    expect(peekLiveWidgetState("pane-1", "conv-1", "run-1")).not.toBeNull();
    clearLiveWidgetState("pane-1");
    expect(peekLiveWidgetState("pane-1", "conv-1", "run-1")).toBeNull();
  });
});
