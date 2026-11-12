// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "../src/client/src/lib/store.js";

import { attachRun, reportTeamBrainCardPress, sendMessage } from "../src/client/src/lib/chat.js";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

// A team-brain card's confirm button was pressed: the pane tells the avatar
// (lib/chat.ts reportTeamBrainCardPress). Only the card id leaves the browser.

const PRISTINE = structuredClone(readState());
const BUBBLE = "팀 브레인에 반영했습니다: 배포";

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

function sseRes(frames: Array<[string, unknown]>, onDrained?: () => void) {
  const enc = new TextEncoder();
  const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else {
        onDrained?.();
        controller.close();
      }
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}) };
}

const DONE: [string, unknown] = [
  "done",
  { message: { id: "m", role: "assistant", content: "ok", response: { kind: "text", runtime: "pi", text: "ok" }, conversationId: "c", createdAt: "t" } },
];

function body(init: RequestInit): any {
  return init.body ? JSON.parse(String(init.body)) : undefined;
}

async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

let paneSeq = 0;
function seedPane(overrides: Partial<ChatPane> = {}): string {
  const id = `press-pane${++paneSeq}`;
  const pane = {
    id,
    avatar: { id: "owner", alias: "노아", displayName: "Noah", isOwn: true } as any,
    conversationId: `conv-${id}`,
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveTextBreakPending: false,
    liveThinking: "",
    thinkingActive: false,
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
    canvases: [],
    sideTab: null,
    stickBottom: true,
    usage: null,
    abortController: null,
    ...overrides,
  } as ChatPane;
  updateState((s) => {
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
    s.currentAvatar = pane.avatar;
  });
  return id;
}

function pane(id: string): ChatPane {
  return readState().chatPanes.find((p) => p.id === id)!;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: { id: "owner", roles: [] } as any });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reportTeamBrainCardPress", () => {
  it("an idle pane: the press is a turn of its own, naming only the card, and the composer is left alone", async () => {
    const staged = { id: "img-1", dataUrl: "data:image/png;base64,AAAA", mediaType: "image/png", name: "a.png" };
    const id = seedPane({ draft: "쓰던 글", pendingImages: [staged] as any });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([DONE]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await reportTeamBrainCardPress(id, "card-1", BUBBLE);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].teamBrainCardPress).toEqual({ proposalId: "card-1" });
    expect(bodies[0].conversationId).toBe(pane(id).conversationId);
    expect(bodies[0].images).toBeUndefined();
    expect(bodies[0].canvasSubmission).toBeUndefined();
    // The viewer sees what they did as their own bubble; what they were composing stays.
    expect(pane(id).messages.find((m) => m.role === "user")?.content).toBe(BUBBLE);
    expect(pane(id).draft).toBe("쓰던 글");
    expect(pane(id).pendingImages).toEqual([staged]);
  });

  it("while the avatar is answering: the report joins the running turn, and no new turn starts", async () => {
    const id = seedPane({ streaming: true, liveRunId: "run-9", draft: "쓰던 글" });
    const fetchFn = useFetch((url) =>
      url === "/api/chat/runs/run-9/message"
        ? jsonRes({ ok: true, steer: { id: "s-press-1", text: BUBBLE, state: "queued", createdAt: "2026-11-11T00:00:00.000Z", followUp: false, cardPress: { proposalId: "card-1" } } })
        : undefined,
    );
    await reportTeamBrainCardPress(id, "card-1", BUBBLE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(body(fetchFn.mock.calls[0][1] as RequestInit)).toEqual({ teamBrainCardPress: { proposalId: "card-1" } });
    expect(pane(id).steers).toEqual([{ id: "s-press-1", text: BUBBLE, createdAt: "2026-11-11T00:00:00.000Z" }]);
    expect(pane(id).draft).toBe("쓰던 글");
  });

  it("a turn that was already wrapping up: the report waits for it to end, then goes out as its own turn", async () => {
    const id = seedPane({ streaming: true, liveRunId: "run-10" });
    const calls: string[] = [];
    const bodies: any[] = [];
    useFetch((url, init) => {
      calls.push(url);
      if (url === "/api/chat/runs/run-10/message") return jsonRes({ error: "응답이 마무리되는 중이라 전달할 수 없습니다." }, 410);
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([DONE]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    const reported = reportTeamBrainCardPress(id, "card-1", BUBBLE);
    await waitFor(() => calls.includes("/api/chat/runs/run-10/message"));
    await new Promise((r) => setTimeout(r, 5));
    // Still answering: nothing else is sent, and the refusal is not shown as an error.
    expect(calls).toEqual(["/api/chat/runs/run-10/message"]);
    expect(get(toasts)).toEqual([]);
    updateState((s) => {
      s.chatPanes.find((p) => p.id === id)!.streaming = false;
    });
    await reported;
    expect(bodies).toHaveLength(1);
    expect(bodies[0].teamBrainCardPress).toEqual({ proposalId: "card-1" });
    expect(pane(id).messages.find((m) => m.role === "user")?.content).toBe(BUBBLE);
  });

  it("gives up when the pane moves to another conversation before the turn ends", async () => {
    const id = seedPane({ streaming: true, liveRunId: null });
    const fetchFn = useFetch(() => undefined);
    const reported = reportTeamBrainCardPress(id, "card-1", BUBBLE);
    updateState((s) => {
      const p = s.chatPanes.find((item) => item.id === id)!;
      p.conversationId = "another-conversation";
      p.streaming = false;
    });
    await reported;
    expect(fetchFn).not.toHaveBeenCalled();
    // A pane that is gone is a no-op too.
    await reportTeamBrainCardPress("no-such-pane", "card-1", BUBBLE);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a dropped press report is not handed to the composer: it goes out again as its own turn once the run is over", async () => {
    const id = seedPane({ draft: "쓰던 글" });
    const frame = (state: string) => [
      "steer",
      { steer: { id: "s-press-2", text: BUBBLE, state, createdAt: "2026-11-11T00:00:00.000Z", followUp: false, cardPress: { proposalId: "card-2" } } },
    ] as [string, unknown];
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url.includes("/api/chat/runs/run-11/events"))
        return sseRes([frame("queued"), frame("dropped"), frame("dropped")], () => pane(id)?.abortController?.abort());
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([DONE]);
      }
      return jsonRes({ ok: true, conversations: [] });
    });
    await attachRun(id, "run-11");
    await waitFor(() => bodies.length > 0);
    // Once, however often the frame is replayed.
    await new Promise((r) => setTimeout(r, 5));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].teamBrainCardPress).toEqual({ proposalId: "card-2" });
    expect(bodies[0].message).toBe(BUBBLE);
    expect(pane(id).draft).toBe("쓰던 글");
    expect(pane(id).steers ?? []).toEqual([]);
    expect(get(toasts).some((t) => t.message.includes("입력창에 되돌려"))).toBe(false);
  });

  it("a press turn the server has nothing for is undone quietly — no error toast, no bubble, the composer untouched", async () => {
    const id = seedPane({ draft: "쓰던 글" });
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({ error: "아바타에게 전달할 카드 처리 결과가 없습니다." }, 409);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await reportTeamBrainCardPress(id, "card-1", BUBBLE);
    expect(get(toasts)).toEqual([]);
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).draft).toBe("쓰던 글");
    expect(pane(id).streaming).toBe(false);
  });

  it("waits for the running turn's own teardown: the press turn it then starts keeps its live state", async () => {
    // A stream the test drives frame by frame, so the turn's `done` and the end
    // of its response body are two separate moments — as on a real connection.
    const enc = new TextEncoder();
    const controlled = () => {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      return {
        res: { ok: true, status: 200, body: stream, json: async () => ({}) },
        push: (event: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
        close: () => ctl.close(),
      };
    };
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const id = seedPane();
    const conversationId = pane(id).conversationId;
    const first = controlled();
    const second = controlled();
    const streams = [first, second];
    const streamBodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        streamBodies.push(body(init));
        return streams.shift()!.res;
      }
      // The turn is wrapping up: it takes no mid-turn message any more.
      if (url.endsWith("/message")) return jsonRes({ error: "응답이 마무리되는 중이라 전달할 수 없습니다." }, 410);
      return jsonRes({ conversations: [] });
    });

    const turn1 = sendMessage(id, "이거 팀에 공유해줘");
    await tick();
    first.push("open", { conversationId, avatarId: "owner", runId: "run-1" });
    await tick();
    expect(pane(id).liveRunId).toBe("run-1");

    const reported = reportTeamBrainCardPress(id, "card-1", BUBBLE);
    await tick();
    // `done` lands, but the response body is still open: the send loop has not torn down yet.
    first.push("done", DONE[1]);
    await tick();
    expect(pane(id).streaming).toBe(false);
    expect(streamBodies).toHaveLength(1);
    first.close();
    await turn1;
    await tick();

    // Now the press turn is out, and it is a live turn like any other.
    expect(streamBodies).toHaveLength(2);
    expect(streamBodies[1].teamBrainCardPress).toEqual({ proposalId: "card-1" });
    second.push("open", { conversationId, avatarId: "owner", runId: "run-2", userMessageId: "srv-user-2" });
    await tick();
    const live = pane(id);
    expect(live.streaming).toBe(true);
    expect(live.abortController).not.toBeNull();
    expect(live.liveRunId).toBe("run-2");
    // The optimistic bubble adopted the server's row id.
    expect(live.messages.filter((m) => m.role === "user").map((m) => [m.id, m.content])).toEqual([
      [expect.any(String), "이거 팀에 공유해줘"],
      ["srv-user-2", BUBBLE],
    ]);
    second.push("done", DONE[1]);
    second.close();
    await reported;
    expect(pane(id).streaming).toBe(false);
  });
});
