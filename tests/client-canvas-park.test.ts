// @vitest-environment jsdom
// A PARKED blocking canvas across conversation switches. Two things must hold:
//  1. returning to the conversation rebuilds the selection buttons (pending +
//     requestId + runId) from the run's replayed event log, and
//  2. the return itself must not HANG — selectConversation only kicks the
//     reattach off, and leaving again aborts the dropped pane's event stream.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectConversation } from "../src/client/src/lib/chat.js";
import { resolveSideTab } from "../src/client/src/lib/sidePanel.js";
import { appState, readState, replaceState } from "../src/client/src/lib/state.js";

const PRISTINE = structuredClone(readState());

type FetchHandler = (url: string, init: RequestInit) => unknown;

function useFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

function streamFrom(chunks: string[], onDrained?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else {
        onDrained?.();
        controller.close();
      }
    },
  });
}

// A run that stays PARKED: the frames arrive once and the stream then never
// closes, exactly like a server waiting out a blocking canvas. Real fetch errors
// the body when the request aborts, so the abort is wired here too — otherwise
// the reader would keep waiting on a connection the client already dropped.
function parkedStreamFrom(
  chunks: string[],
  signal: AbortSignal | null | undefined,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
    },
    pull(controller) {
      if (sent) return new Promise<void>(() => {});
      sent = true;
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
    },
  });
}

function sseFrame([event, data]: [string, unknown]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseRes(frames: Array<[string, unknown]>, status = 200, onDrained?: () => void) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: streamFrom(frames.map(sseFrame), onDrained),
    json: async () => ({}),
  };
}

function parkedSseRes(
  frames: Array<[string, unknown]>,
  signal: AbortSignal | null | undefined,
) {
  return {
    ok: true,
    status: 200,
    body: parkedStreamFrom(frames.map(sseFrame), signal),
    json: async () => ({}),
  };
}

const replayFrames: Array<[string, unknown]> = [
  ["open", { conversationId: "c-park", avatarId: "av1", runId: "run-park" }],
  ["status", { label: "실행 중: 캔버스 표시" }],
  [
    "canvas",
    {
      runId: "run-park",
      requestId: "rq-park",
      artifactId: "cv-park",
      title: "질문",
      content: "하나를 고르세요",
      contentType: "markdown",
      controls: [
        {
          type: "buttons",
          id: "pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      interaction: "blocking",
      editable: false,
    },
  ],
];

function seedConversations(): void {
  replaceState({
    conversations: [
      { id: "c-park", avatarUserId: "av1", isRoutine: false } as any,
      { id: "c-other", avatarUserId: "av1", isRoutine: false } as any,
    ],
  });
}

function parkedCanvas() {
  const pane = readState().chatPanes.find((p) => p.conversationId === "c-park");
  return pane?.canvases.find((c) => c.id === "cv-park") ?? null;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  replaceState({ user: { id: "owner", roles: [] } as any });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parked blocking canvas across conversation switches", () => {
  it("restores the canvas form (pending + ids) after leaving and returning", async () => {
    seedConversations();

    useFetch((url) => {
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1")
        return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs?conversationId=c-park"))
        return jsonRes({ run: { runId: "run-park" } });
      if (url.startsWith("/api/chat/runs?"))
        return jsonRes({ run: null });
      if (url.includes("/api/chat/runs/run-park/events"))
        return sseRes(replayFrames, 200, () => {
          // Drained short of a terminal frame = dropped connection; abort so the
          // reconnect loop ends instead of backing off forever.
          readState()
            .chatPanes.find((p) => p.conversationId === "c-park")
            ?.abortController?.abort();
        });
      return jsonRes({ ok: true });
    });

    // Step 1: user goes to ANOTHER conversation (c-other) — pane replaced.
    await selectConversation("c-other");
    expect(readState().chatPanes[0].conversationId).toBe("c-other");

    // Step 2: user returns to the parked conversation. The reattach runs in the
    // background now, so the replayed canvas shows up a few ticks later.
    await selectConversation("c-park");
    await waitFor(() => parkedCanvas() !== null);

    const pane = readState().chatPanes.find((p) => p.conversationId === "c-park")!;
    expect(pane).toBeTruthy();
    const canvas = parkedCanvas();
    expect(canvas, "canvas should be rebuilt from replay").toBeTruthy();
    expect(canvas).toMatchObject({
      pending: true,
      requestId: "rq-park",
      runId: "run-park",
      interaction: "blocking",
    });
    expect(canvas!.controls?.length).toBe(1);
    // …and it is the tab the side panel shows.
    expect(resolveSideTab(pane)).toEqual({ kind: "canvas", id: "cv-park" });
  });

  it("resolves the open while the run stays parked, and aborts the stream on leaving", async () => {
    seedConversations();

    let eventsSignal: AbortSignal | null = null;
    useFetch((url, init) => {
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1")
        return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs?conversationId=c-park"))
        return jsonRes({ run: { runId: "run-park" } });
      if (url.startsWith("/api/chat/runs?"))
        return jsonRes({ run: null });
      if (url.includes("/api/chat/runs/run-park/events")) {
        eventsSignal = init.signal ?? null;
        return parkedSseRes(replayFrames, init.signal);
      }
      return jsonRes({ ok: true });
    });

    // The run never ends, so awaiting the reattach here would hold the sidebar's
    // per-conversation busy lock (and its disabled button) for the whole park.
    await expect(
      Promise.race([
        selectConversation("c-park").then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
      ]),
    ).resolves.toBe("resolved");

    // The reattach still lands: it just runs past the caller now.
    await waitFor(() => parkedCanvas() !== null);
    expect(eventsSignal).toBeTruthy();
    expect(eventsSignal!.aborted).toBe(false);

    // Leaving drops the pane — its reader loop must be cut, not left holding the
    // SSE connection. (The server run is untouched: only /cancel ends a run.)
    await selectConversation("c-other");
    expect(readState().chatPanes.map((p) => p.conversationId)).toEqual([
      "c-other",
    ]);
    expect(eventsSignal!.aborted).toBe(true);
  });
});
