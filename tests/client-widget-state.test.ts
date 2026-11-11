// Canvas widget state in localStorage (lib/widgetState.ts): one key per
// (user, conversation, canvas), a size cap, an LRU of 50 canvases, and no throw
// when storage is unavailable.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WIDGET_STATE_CHARS,
  MAX_WIDGET_STATE_ENTRIES,
  WIDGET_STATE_INDEX_KEY,
  createWidgetStateSaver,
  loadWidgetState,
  removeWidgetState,
  saveWidgetState,
  widgetStateKey,
} from "../src/client/src/lib/widgetState.js";
import { dataSize, parseWidget, restoreState } from "../src/shared/widget/index.js";

function ref(userId: string | null | undefined, canvasId: string, conversationId: string | null = "conv-1") {
  return { userId, conversationId, canvasId };
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
    expect([...storage.data.keys()].sort()).toEqual([WIDGET_STATE_INDEX_KEY, "noah:canvas-widget:u1:conv-1:cv1"].sort());
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
    saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 1 } });
    vi.advanceTimersByTime(200);
    saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 2 } });
    vi.advanceTimersByTime(200);
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toBeNull(); // the second call restarted the wait
    vi.advanceTimersByTime(100);
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toEqual({ n: { sig: "n = 2", value: 2 } });

    saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 3 } });
    saver.flush();
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toEqual({ n: { sig: "n = 2", value: 3 } });

    saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 4 } });
    saver.cancel();
    vi.advanceTimersByTime(1000);
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toEqual({ n: { sig: "n = 2", value: 3 } });

    // A pending save for one canvas is written before another canvas's replaces it.
    saver.schedule(ref("u1", "cv1"), { n: { sig: "n = 2", value: 5 } });
    saver.schedule(ref("u1", "cv2"), { n: { sig: "n = 2", value: 6 } });
    expect(loadWidgetState(ref("u1", "cv1"), storage)).toEqual({ n: { sig: "n = 2", value: 5 } });
    vi.advanceTimersByTime(300);
    expect(loadWidgetState(ref("u1", "cv2"), storage)).toEqual({ n: { sig: "n = 2", value: 6 } });
  });
});
