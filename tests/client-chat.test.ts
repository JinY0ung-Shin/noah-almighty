// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
  addConversationToSplit,
  answerPrompt,
  clearChatHistory,
  closeCanvas,
  closePane,
  dismissCanvas,
  fetchCanvasVersions,
  humanTool,
  newChat,
  openSeededChat,
  PLUGIN_STATUS_LABELS,
  regenerate,
  respondPlanReview,
  rollbackCanvas,
  selectConversation,
  sendMessage,
  sendSteer,
  setActiveCanvas,
  startChatWith,
  startNewChat,
  stopPane,
  submitCanvas,
  submitCanvasEdit,
  summarizeInput,
  attachRun,
  attachActiveRun,
} from "../src/client/src/lib/chat.js";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import { resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { DRAWIO_MEDIA_TYPE } from "../src/client/src/lib/drawioViewer.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ClientState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* fixtures + fetch stubbing                                           */
/* ------------------------------------------------------------------ */

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

/** A fetch that must never be called (for pure no-op assertions). */
function noFetch() {
  const fn = vi.fn(async () => {
    throw new Error("fetch should not have been called");
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
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

/** An SSE response that delivers its frames and then loses the connection. */
function brokenSseRes(frames: Array<[string, unknown]>, reason = "연결이 끊겼습니다") {
  const enc = new TextEncoder();
  const chunks = frames.map(sseFrame);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.error(new Error(reason));
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}) };
}

function body(init: RequestInit): any {
  return init.body ? JSON.parse(String(init.body)) : undefined;
}

/** Let queued microtasks — the best-effort `.catch()` handlers — run. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function waitFor(cond: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

let paneSeq = 0;
function seedPane(overrides: Partial<ChatPane> = {}): string {
  const id = overrides.id ?? `pane${++paneSeq}`;
  const pane = {
    id,
    avatar: { id: "av1", alias: "노아", displayName: "Noah", isOwn: false } as any,
    conversationId: `conv-${id}`,
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveTextBreakPending: false,
    liveThinking: "",
    thinkingActive: false,
    livePlan: "",
    planPending: false,
    planReview: null,
    planReviewSubmitting: false,
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    groupKnowledgeOff: [],
    mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
    canvases: [],
    activeCanvasId: null,
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

/* ------------------------------------------------------------------ */
/* live-state, notification, extension + event-replay harness          */
/* ------------------------------------------------------------------ */

const storeTrackers: Array<() => void> = [];

/**
 * Record a projection of the store on every update. State that only exists WHILE
 * a run streams — the status label, a queued prompt — is wiped the moment the run
 * ends, so it has to be sampled as it happens rather than read afterwards.
 */
function trackState<T>(pick: (state: ClientState) => T): () => T[] {
  const seen: T[] = [];
  storeTrackers.push(appState.subscribe((state) => seen.push(pick(state))));
  return () => seen;
}

/** Every liveStatus a pane showed during a run (it is cleared when the run ends). */
function trackStatus(paneId: string): () => string[] {
  return trackState((state) => state.chatPanes.find((p) => p.id === paneId)?.liveStatus ?? "");
}

interface OsNote {
  title: string;
  body?: string;
  tag?: string;
}

/**
 * Capture OS notifications. osNotify stays silent unless the Notification API
 * exists, permission is granted, AND the app is not the focused window — so all
 * three have to be arranged for a notification to be observable at all.
 */
function useOsNotifications(): OsNote[] {
  const notes: OsNote[] = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      notes.push({ title, body: options.body, tag: options.tag });
    }
    close(): void {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  // notificationsSupported() probes `window`, which under vitest's jsdom is not
  // the same object stubGlobal writes to.
  Object.defineProperty(window, "Notification", {
    value: FakeNotification,
    configurable: true,
    writable: true,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  return notes;
}

/**
 * Stand in for the Noah extension: `chrome.runtime` is the only channel to it.
 * Pass a function to answer per message — a secret op probes `getAllowedOrigins`
 * for the installed version before the op itself is sent.
 */
function useExtension(reply: unknown | ((message: any) => unknown)) {
  const answer = typeof reply === "function" ? (reply as (message: any) => unknown) : () => reply;
  const send = vi.fn((_extensionId: string, message: unknown, cb: (response: unknown) => void) =>
    cb(answer(message)),
  );
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  return send;
}

let eventRunSeq = 0;

/**
 * Replay `frames` into a pane through the real SSE reader (attachRun's reconnect
 * path), so events are applied exactly as a live run applies them. Requests other
 * than the event stream fall through to `rest`, then default to 200 `{ok:true}` —
 * handlers fire best-effort follow-ups (the activity PUT, /api/chat/respond) that
 * no test needs to restate; `calls` records every one of them.
 *
 * The viewer DETACHES once the frames are drained: a replay that stops short of a
 * terminal frame is, to the client, a connection that dropped mid-run, and
 * attachRun would rightly keep reconnecting. "Apply exactly these frames, then
 * stop listening" is what a partial log means in these tests.
 */
async function driveEvents(
  paneId: string,
  frames: Array<[string, unknown]>,
  rest: FetchHandler = () => undefined,
): Promise<{ calls: { url: string; init: RequestInit }[] }> {
  const runId = `evt-run-${++eventRunSeq}`;
  const calls: { url: string; init: RequestInit }[] = [];
  useFetch((url, init) => {
    calls.push({ url, init });
    if (url.includes(`/api/chat/runs/${runId}/events`))
      return sseRes(frames, 200, () =>
        readState().chatPanes.find((p) => p.id === paneId)?.abortController?.abort(),
      );
    const handled = rest(url, init);
    return handled === undefined ? jsonRes({ ok: true }) : handled;
  });
  await attachRun(paneId, runId);
  return { calls };
}

function postedTo(calls: { url: string; init: RequestInit }[], path: string): any[] {
  return calls.filter((c) => c.url === path).map((c) => body(c.init));
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: { id: "owner", roles: [] } as any });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  while (storeTrackers.length) storeTrackers.pop()!();
  delete (window as { Notification?: unknown }).Notification;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("humanTool / summarizeInput / PLUGIN_STATUS_LABELS", () => {
  it("humanTool prefers a known label, unwraps mcp names, else spaces out underscores", () => {
    expect(humanTool(undefined)).toBe("도구");
    expect(humanTool("Bash")).toBe("명령 실행");
    expect(humanTool("mcp__knowledge__request_info")).toBe("정보 요청 기록");
    expect(humanTool("mcp__custom__do_a_thing")).toBe("do a thing");
    expect(humanTool("Raw_Name")).toBe("Raw Name");
  });

  it("summarizeInput picks a recognizable key, then first string, then JSON", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput(42)).toBe("42");
    expect(summarizeInput("hello")).toBe("hello");
    expect(summarizeInput({ command: "ls -la", other: 1 })).toBe("ls -la");
    expect(summarizeInput({ nokey: "first-string" })).toBe("first-string");
    expect(summarizeInput({ a: 1, b: 2 })).toBe(JSON.stringify({ a: 1, b: 2 }));
    expect(summarizeInput("x".repeat(200))).toHaveLength(181); // 180 + ellipsis
  });

  it("PLUGIN_STATUS_LABELS covers the four load states", () => {
    expect(PLUGIN_STATUS_LABELS).toMatchObject({
      started: "불러오는 중",
      installed: "설치됨",
      completed: "사용 준비됨",
      failed: "불러오기 실패",
    });
  });
});

/* ------------------------------------------------------------------ */
/* sendMessage — the streaming pipeline                                */
/* ------------------------------------------------------------------ */

describe("sendMessage streaming pipeline", () => {
  it("drives a full turn: activity tree, thinking, usage, and a persisted snapshot", async () => {
    const id = seedPane();
    const assistantMsg = {
      id: "msg1",
      conversationId: "conv1",
      role: "assistant",
      content: "최종 답변",
      response: {
        kind: "text",
        runtime: "claude",
        text: "최종 답변",
        usage: { inputTokens: 1000, outputTokens: 50, contextWindow: 1_000_000 },
      },
      createdAt: new Date().toISOString(),
    };
    const seen: string[] = [];
    useFetch((url, init) => {
      seen.push(`${(init as any).method || "GET"} ${url}`);
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv1", runId: "run1" }],
          ["status", { label: "작업 중" }],
          ["plugin", { name: "pluginA", status: "started" }],
          ["plugin", { name: "pluginA", status: "completed" }],
          ["agent", { agentId: "sub1", parentId: "main", subagentType: "researcher", description: "조사" }],
          ["tool", { toolUseId: "t1", name: "Bash", agentId: "sub1", input: { command: "ls -la" } }],
          ["tool_end", { toolUseId: "t1", ok: true, output: "file list" }],
          ["task", { taskId: "k1", agentId: "sub1", subagentType: "worker" }],
          ["task_update", { taskId: "k1", subagentType: "worker", summary: "작업 중" }],
          ["task_end", { taskId: "k1", subagentType: "worker", ok: true }],
          ["agent_end", { agentId: "sub1", ok: true }],
          ["thinking", { text: "생각 중" }],
          ["delta", { text: "최종 답변" }],
          ["done", { message: assistantMsg }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url.startsWith("/api/messages/")) return jsonRes({ ok: true });
      return undefined;
    });

    await sendMessage(id, "안녕");

    const p = pane(id);
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]).toMatchObject({ role: "user", content: "안녕" });
    const last = p.messages[1];
    expect(last).toMatchObject({ role: "assistant", content: "최종 답변" });
    expect(p.usage).toMatchObject({ inputTokens: 1000, outputTokens: 50 });

    // The completed bubble keeps a snapshot of the activity that ran.
    const activity = (last.response as any).activity;
    expect(activity.agents.find((a: any) => a.id === "sub1")).toMatchObject({ status: "done" });
    expect(activity.tools[0]).toMatchObject({ label: "명령 실행", detail: "file list", status: "done" });
    expect(activity.tasks[0]).toMatchObject({ label: "worker", status: "done" });
    // The reasoning text is grafted onto the response so the "생각 과정" view survives.
    expect((last.response as any).thinking).toBe("생각 중");

    // Live scratch state is cleared and the pane is idle again.
    expect(p).toMatchObject({ streaming: false, liveText: "", liveThinking: "" });
    expect(p.liveTools).toEqual([]);
    // The snapshot is best-effort persisted to the server.
    expect(seen).toContain("PUT /api/messages/msg1/activity");
    // The POST carried the composer picks + conversation id.
    const post = seen.find((s) => s.startsWith("POST /api/chat/stream"));
    expect(post).toBeTruthy();
  });

  it("keeps the task label when task_update/task_end frames omit the naming fields", async () => {
    const id = seedPane();
    const assistantMsg = {
      id: "msg-task-label",
      conversationId: "conv-task-label",
      role: "assistant",
      content: "끝",
      response: { kind: "text", runtime: "claude", text: "끝" },
      createdAt: new Date().toISOString(),
    };
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv-task-label", runId: "run-tl" }],
          ["task", { taskId: "k1", agentId: "main", subagentType: "worker" }],
          // Real task_update/task_end frames often carry only ids + progress —
          // an empty recomputed label must not wipe the one from task start.
          ["task_update", { taskId: "k1", summary: "진행 상황" }],
          ["task_end", { taskId: "k1", ok: true }],
          ["done", { message: assistantMsg }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url.startsWith("/api/messages/")) return jsonRes({ ok: true });
      return undefined;
    });

    await sendMessage(id, "라벨 유지 확인");

    const last = pane(id).messages.at(-1)!;
    const activity = (last.response as any).activity;
    expect(activity.tasks[0]).toMatchObject({
      label: "worker",
      detail: "진행 상황",
      status: "done",
    });
  });

  it("keeps a live show_file image on a fallback assistant message", async () => {
    const id = seedPane();
    const attachment = {
      id: "generated-1",
      kind: "image",
      mediaType: "image/png",
      name: "result.png",
      caption: "생성 결과",
    };
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv1", runId: "run-file" }],
          ["file", { attachment }],
          ["done", { response: { kind: "text", runtime: "claude", summary: "완료", text: "완료" } }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "이미지 만들어줘");

    const last = pane(id).messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", attachments: [attachment] });
    expect(pane(id).liveAttachments).toEqual([]);
  });

  it("no-ops on an empty text-only send and on the /new slash action", async () => {
    const id = seedPane();
    const fetchFn = noFetch();
    await sendMessage(id, "   ");
    expect(fetchFn).not.toHaveBeenCalled();

    await sendMessage(id, "/new");
    // /new swapped the pane for a fresh one without hitting the network.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes[0].id).not.toBe(id);
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("prompts for missing args on a requiresArgs slash command", async () => {
    const id = seedPane({ avatar: { id: "owner", isOwn: true } as any });
    const fetchFn = noFetch();
    await sendMessage(id, "/remember");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).draft).toBe("/remember ");
    expect(get(toasts).some((t) => t.message.includes("/remember"))).toBe(true);
  });

  it("finalizes an aborted turn as a stopped message", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") throw Object.assign(new Error("abort"), { name: "AbortError" });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "안녕");
    const msgs = pane(id).messages;
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "(중지됨)" });
    expect(pane(id).streaming).toBe(false);
  });

  it("undoes the user bubble and restores the draft when nothing streamed", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({ error: "서버 터짐" }, 500);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "복구될 텍스트");
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).draft).toBe("복구될 텍스트");
    expect(get(toasts).some((t) => t.message.includes("서버 터짐"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* startChatWith / selectConversation / addConversationToSplit         */
/* ------------------------------------------------------------------ */

describe("opening + resuming conversations", () => {
  it("startChatWith opens a fresh pane for an avatar with no prior conversation", async () => {
    useFetch((url) => {
      if (url === "/api/avatars/av9") return jsonRes({ avatar: { id: "av9", alias: "동료", isOwn: false } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startChatWith({ id: "av9" } as any);
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0].avatar.id).toBe("av9");
    expect(s.activePaneId).toBe(s.chatPanes[0].id);
  });

  it("startChatWith bails out when the owner declines the streaming-switch confirm", async () => {
    seedPane({ streaming: true });
    const fetchFn = noFetch();
    const opening = startChatWith({ id: "av9" } as any);
    resolveConfirmation(false);
    await opening;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toHaveLength(1); // unchanged
  });

  it("startChatWith(split) pushes an extra pane", async () => {
    seedPane();
    useFetch((url) => {
      if (url === "/api/avatars/av2") return jsonRes({ avatar: { id: "av2", alias: "둘째", isOwn: false } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startChatWith({ id: "av2" } as any, true);
    expect(readState().chatPanes).toHaveLength(2);
  });

  it("selectConversation loads a stored conversation into a single pane", async () => {
    replaceState({ conversations: [{ id: "c1", avatarUserId: "av1", isRoutine: false } as any] });
    const assistantMsg = { id: "m", role: "assistant", content: "이전 답변", response: null, conversationId: "c1", createdAt: "t" };
    useFetch((url) => {
      if (url.startsWith("/api/messages")) return jsonRes({ messages: [assistantMsg], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("c1");
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0]).toMatchObject({ conversationId: "c1" });
    expect(s.chatPanes[0].messages).toHaveLength(1);
  });

  it("selectConversation just focuses a pane that is already streaming that conversation", async () => {
    const id = seedPane({ conversationId: "c-live", streaming: true });
    const fetchFn = noFetch();
    // switch active pane away, then reselect
    updateState((s) => {
      s.activePaneId = null;
      s.view = "explore";
    });
    await selectConversation("c-live");
    expect(readState()).toMatchObject({ view: "chat", activePaneId: id });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("selectConversation warns when the conversation cannot be found", async () => {
    // Both lists must come back empty: a miss in the chat list falls through to
    // the routine list before the lookup gives up.
    useFetch((url) =>
      url === "/api/conversations" || url === "/api/conversations?kind=routine"
        ? jsonRes({ conversations: [] })
        : undefined,
    );
    await selectConversation("missing");
    expect(get(toasts).some((t) => t.message.includes("대화를 찾을 수 없습니다"))).toBe(true);
  });

  // Routine threads are fetched with kind:"routine" into a SEPARATE state array,
  // and /api/conversations defaults to kind:"chat" — so a lookup that reads only
  // state.conversations reported "대화를 찾을 수 없습니다" for every routine
  // handoff ("일반 대화로 열기") even though the thread exists.
  it("selectConversation opens a routine thread held in routineConversations", async () => {
    replaceState({
      conversations: [],
      routineConversations: [{ id: "r1", avatarUserId: "av1", isRoutine: true } as any],
    });
    const fetchFn = useFetch((url) => {
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("r1");
    expect(readState()).toMatchObject({ view: "chat" });
    expect(readState().chatPanes[0]).toMatchObject({ conversationId: "r1" });
    // Cached locally, so neither conversation list is refetched.
    expect(fetchFn.mock.calls.every(([url]) => !String(url).startsWith("/api/conversations"))).toBe(true);
  });

  it("selectConversation refetches the routine list when neither cache has the thread", async () => {
    replaceState({ conversations: [], routineConversations: [] });
    useFetch((url) => {
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url === "/api/conversations?kind=routine")
        return jsonRes({ conversations: [{ id: "r2", avatarUserId: "av1", isRoutine: true }] });
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("r2");
    expect(readState().chatPanes[0]).toMatchObject({ conversationId: "r2" });
    expect(get(toasts).some((t) => t.message.includes("대화를 찾을 수 없습니다"))).toBe(false);
  });

  it("addConversationToSplit focuses an already-open pane", async () => {
    const id = seedPane({ conversationId: "c-open" });
    const fetchFn = noFetch();
    updateState((s) => {
      s.activePaneId = null;
    });
    await addConversationToSplit("c-open");
    expect(readState().activePaneId).toBe(id);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("addConversationToSplit refuses beyond the 4-pane maximum", async () => {
    for (let i = 0; i < 4; i++) seedPane({ conversationId: `c${i}` });
    const fetchFn = noFetch();
    await addConversationToSplit("brand-new");
    expect(get(toasts).some((t) => t.message.includes("최대 4개"))).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* newChat / clearChatHistory / regenerate                             */
/* ------------------------------------------------------------------ */

describe("pane lifecycle", () => {
  it("newChat replaces the active pane, but not while it streams", () => {
    const streamingId = seedPane({ streaming: true, messages: [{ id: "x" } as any] });
    newChat(streamingId);
    expect(pane(streamingId).messages).toHaveLength(1); // untouched

    const id = seedPane({ messages: [{ id: "y" } as any] });
    newChat(id);
    const fresh = readState().chatPanes.find((p) => p.id !== streamingId && p.id !== id)!;
    expect(readState().chatPanes.some((p) => p.id === id)).toBe(false);
    expect(fresh.messages).toEqual([]);
  });

  it("newChat with no pane id targets the active pane", () => {
    const other = seedPane({ messages: [{ id: "keep" } as any] });
    const active = seedPane({ messages: [{ id: "drop" } as any] });
    newChat();
    const panes = readState().chatPanes;
    expect(panes[0].id).toBe(other);
    expect(panes[0].messages).toHaveLength(1);
    expect(panes[1].id).not.toBe(active);
    expect(panes[1].messages).toEqual([]);
    expect(readState().activePaneId).toBe(panes[1].id);
  });

  it("clearChatHistory deletes conversations and resets matching panes", async () => {
    const id = seedPane({ conversationId: "c1", messages: [{ id: "m" } as any] });
    replaceState({ conversations: [{ id: "c1" } as any, { id: "c2" } as any] });
    useFetch((url, init) =>
      url === "/api/conversations" && (init as any).method === "DELETE"
        ? jsonRes({ deleted: 1, conversationIds: ["c1"] })
        : undefined,
    );
    const deleted = await clearChatHistory();
    expect(deleted).toBe(1);
    expect(readState().conversations.map((c) => c.id)).toEqual(["c2"]);
    // The open pane on the cleared conversation was reset to a fresh pane.
    const replaced = readState().chatPanes[0];
    expect(replaced.id).not.toBe(id);
    expect(replaced.messages).toEqual([]);
  });

  it("clearChatHistory returns 0 when nothing was deleted", async () => {
    seedPane({ conversationId: "c1" });
    useFetch(() => jsonRes({ deleted: 0, conversationIds: [] }));
    expect(await clearChatHistory()).toBe(0);
  });

  it("regenerate re-sends the last user turn and streams a new answer", async () => {
    const id = seedPane({
      messages: [
        { id: "u", role: "user", content: "질문", conversationId: "c", response: null, createdAt: "t" } as any,
        { id: "a", role: "assistant", content: "옛 답변", conversationId: "c", response: null, createdAt: "t" } as any,
      ],
    });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([
          ["open", { conversationId: "c", runId: "r" }],
          ["delta", { text: "새 답변" }],
          ["done", { message: { id: "a2", role: "assistant", content: "새 답변", response: { kind: "text", runtime: "claude", text: "새 답변" }, conversationId: "c", createdAt: "t" } }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    regenerate(id);
    await waitFor(() => !pane(id).streaming && pane(id).messages.length === 2);
    expect(bodies[0].regenerate).toBe(true);
    expect(pane(id).messages.map((m) => m.content)).toEqual(["질문", "새 답변"]);
  });

  it("regenerate is a no-op without a prior user turn", () => {
    const id = seedPane({ messages: [{ id: "a", role: "assistant", content: "x" } as any] });
    const fetchFn = noFetch();
    regenerate(id);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* stopPane / closePane / setActiveCanvas                              */
/* ------------------------------------------------------------------ */

describe("stop / close", () => {
  it("stopPane cancels the run, aborts the stream, and finalizes the stopped bubble at once", async () => {
    const controller = new AbortController();
    const id = seedPane({
      liveRunId: "run5",
      abortController: controller,
      streaming: true,
      liveText: "",
      liveThinking: "접힌 중간 설명",
    });
    const fetchFn = useFetch((url) =>
      url.includes("/cancel") ? jsonRes({ ok: true }) : jsonRes({}),
    );
    await stopPane(id);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat/runs/run5/cancel"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(controller.signal.aborted).toBe(true);
    // The stop itself ends the turn — even a pane on a REATTACHED stream (whose
    // loop tears down without finalizing) keeps a bubble, and a post-fold stop
    // (liveText empty, narration already in the thinking view) keeps its
    // reasoning card instead of vanishing entirely.
    const last = pane(id).messages.at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: "(중지됨)" });
    expect(last.response).toMatchObject({ summary: "중지됨", thinking: "접힌 중간 설명" });
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "" });

    // Idempotent: the abort surfaces in whichever loop was attached and calls
    // finalizePane again — that must not push a second bubble.
    await stopPane(id);
    expect(pane(id).messages).toHaveLength(1);
  });

  it("closePane removes a pane and keeps a fresh one when the last closes", () => {
    const a = seedPane();
    const b = seedPane();
    closePane(b);
    expect(readState().chatPanes.map((p) => p.id)).toEqual([a]);

    closePane(a);
    // currentAvatar remains, so a fresh empty pane replaces the closed one.
    expect(readState().chatPanes).toHaveLength(1);
    expect(readState().chatPanes[0].id).not.toBe(a);
  });

  it("setActiveCanvas swaps the active canvas id", () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any, { id: "cv2" } as any], activeCanvasId: "cv1" });
    setActiveCanvas(id, "cv2");
    expect(pane(id).activeCanvasId).toBe("cv2");
  });
});

/* ------------------------------------------------------------------ */
/* canvas flows                                                        */
/* ------------------------------------------------------------------ */

describe("canvas flows", () => {
  it("submitCanvas unblocks a parked run for a blocking canvas", async () => {
    const id = seedPane({
      canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any],
    });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await submitCanvas(id, "cv1", { color: "red" });
    expect(posted).toMatchObject({ runId: "rn1", requestId: "rq1", value: { values: { color: "red" } } });
    const c = pane(id).canvases[0];
    expect(c).toMatchObject({ pending: false, submitting: false, submittedValues: { color: "red" } });
    expect(pane(id).liveStatus).toBe("캔버스 응답을 보냈습니다.");
  });

  it("submitCanvas surfaces a toast when the parked run rejects", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any] });
    useFetch(() => jsonRes({ error: "닫힌 실행" }, 500));
    await submitCanvas(id, "cv1", {});
    expect(get(toasts).some((t) => t.message.includes("닫힌 실행"))).toBe(true);
    expect(pane(id).canvases[0].submitting).toBe(false);
  });

  it("submitCanvas delivers a non-blocking answer as a new turn", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: false } as any] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([["done", { message: { id: "m", role: "assistant", content: "ok", response: { kind: "text", runtime: "claude", text: "ok" }, conversationId: "c", createdAt: "t" } }]]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await submitCanvas(id, "cv1", { pick: "A" });
    expect(bodies[0].canvasSubmission).toMatchObject({ canvasId: "cv1", values: { pick: "A" } });
    expect(pane(id).canvases[0].submittedValues).toMatchObject({ pick: "A" });
  });

  it("submitCanvasEdit sends the edited content as a new turn", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([["done", { message: { id: "m", role: "assistant", content: "ok", response: { kind: "text", runtime: "claude", text: "ok" }, conversationId: "c", createdAt: "t" } }]]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await submitCanvasEdit(id, "cv1", "고친 내용");
    expect(bodies[0].canvasSubmission).toMatchObject({ canvasId: "cv1", editedContent: "고친 내용" });
  });

  it("dismissCanvas cancels a parked blocking canvas and hides it", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any] });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await dismissCanvas(id, "cv1");
    expect(posted).toMatchObject({ requestId: "rq1", value: { cancelled: true } });
    expect(pane(id).canvases[0].pending).toBe(false);
    expect(pane(id).liveStatus).toBe("캔버스 응답을 건너뛰었습니다.");
  });

  it("closeCanvas deletes the canvas, tolerating a not-found server response", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any, { id: "cv2" } as any], activeCanvasId: "cv1" });
    useFetch((url, init) => {
      if (url.startsWith("/api/chat/canvases/cv1") && (init as any).method === "DELETE") {
        return jsonRes({ error: "캔버스를 찾을 수 없습니다." }, 404);
      }
      return undefined;
    });
    await closeCanvas(id, "cv1");
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv2"]);
    expect(pane(id).activeCanvasId).toBe("cv2");
  });

  it("closeCanvas keeps the canvas when deletion fails for another reason", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any], activeCanvasId: "cv1" });
    useFetch(() => jsonRes({ error: "권한 없음" }, 500));
    await closeCanvas(id, "cv1");
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv1"]);
    expect(get(toasts).some((t) => t.message.includes("권한 없음"))).toBe(true);
  });

  it("fetchCanvasVersions returns the versions, and throws on failure so the panel can show an error", async () => {
    useFetch((url) => (url.includes("/versions") ? jsonRes({ versions: [{ version: 1, createdAt: "t" }] }) : undefined));
    expect(await fetchCanvasVersions("cv1")).toEqual([{ version: 1, createdAt: "t" }]);
    useFetch(() => jsonRes({}, 500));
    await expect(fetchCanvasVersions("cv1")).rejects.toThrow();
  });

  it("rollbackCanvas merges the returned canvas, and toasts on error", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", title: "old" } as any] });
    useFetch((url) => (url.includes("/rollback") ? jsonRes({ canvas: { id: "cv1", title: "rolled back" } }) : undefined));
    await rollbackCanvas(id, "cv1", 2);
    expect(pane(id).canvases[0].title).toBe("rolled back");

    useFetch(() => jsonRes({ error: "되돌리기 실패" }, 500));
    await rollbackCanvas(id, "cv1", 2);
    expect(get(toasts).some((t) => t.message.includes("되돌리기 실패"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* interactive prompts + plan review                                  */
/* ------------------------------------------------------------------ */

describe("prompts + plan review", () => {
  it("answerPrompt posts the owner's response and dequeues the prompt", async () => {
    updateState((s) => {
      s.promptQueue.push({ id: "rq1", runId: "rn1", paneId: "p", kind: "permission", data: {} });
    });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await answerPrompt("rq1", { behavior: "allow" });
    expect(posted).toMatchObject({ runId: "rn1", requestId: "rq1", value: { behavior: "allow" } });
    expect(readState().promptQueue).toHaveLength(0);
  });

  it("answerPrompt is a no-op for an unknown request id", async () => {
    const fetchFn = noFetch();
    await answerPrompt("nope", {});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("answerPrompt rethrows and toasts when the respond call fails", async () => {
    updateState((s) => {
      s.promptQueue.push({ id: "rq2", runId: "rn2", paneId: "p", kind: "question", data: {} });
    });
    useFetch(() => jsonRes({ error: "이미 종료됨" }, 500));
    await expect(answerPrompt("rq2", {})).rejects.toThrow("이미 종료됨");
    expect(get(toasts).some((t) => t.message.includes("이미 종료됨"))).toBe(true);
  });

  it("respondPlanReview approves and clears the inline review", async () => {
    const id = seedPane({ planReview: { requestId: "pr1", runId: "rn1" } });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await respondPlanReview(id, "approved");
    expect(posted).toMatchObject({ requestId: "pr1", value: { behavior: "approved" } });
    expect(pane(id).planReview).toBeNull();
    expect(pane(id).liveStatus).toBe("계획을 승인했습니다.");
  });

  it("respondPlanReview rejects with trimmed feedback", async () => {
    const id = seedPane({ planReview: { requestId: "pr2", runId: "rn2" } });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await respondPlanReview(id, "rejected", "  방향을 바꿔줘  ");
    expect(posted.value).toMatchObject({ behavior: "rejected", feedback: "방향을 바꿔줘" });
  });

  it("respondPlanReview is a no-op without a pending review", async () => {
    const id = seedPane({ planReview: null });
    const fetchFn = noFetch();
    await respondPlanReview(id, "approved");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* attachRun / attachActiveRun                                         */
/* ------------------------------------------------------------------ */

describe("reattaching to a live run", () => {
  it("attachRun replays a run's events into the pane", async () => {
    const id = seedPane({ conversationId: "c1" });
    useFetch((url) => {
      if (url.includes("/api/chat/runs/run1/events")) {
        return sseRes([
          ["delta", { text: "재연결 답변" }],
          ["done", { message: { id: "m", role: "assistant", content: "재연결 답변", response: { kind: "text", runtime: "claude", text: "재연결 답변" }, conversationId: "c1", createdAt: "t" } }],
        ]);
      }
      return undefined;
    });
    await attachRun(id, "run1");
    expect(pane(id).messages.at(-1)).toMatchObject({ role: "assistant", content: "재연결 답변" });
    expect(pane(id).streaming).toBe(false);
  });

  it("attachRun falls back to reloading messages on a 404", async () => {
    const id = seedPane({ conversationId: "c1" });
    const reloaded = { id: "old", role: "assistant", content: "저장된 답변", response: null, conversationId: "c1", createdAt: "t" };
    useFetch((url) => {
      if (url.includes("/events")) return { ok: false, status: 404, body: null, json: async () => ({}) };
      if (url.startsWith("/api/messages")) return jsonRes({ messages: [reloaded], groupKnowledgeOff: [], canvases: [] });
      return undefined;
    });
    await attachRun(id, "run404");
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "저장된 답변" });
  });

  it("attachActiveRun reloads messages when a user turn has no active run", async () => {
    const id = seedPane({
      conversationId: "c1",
      messages: [{ id: "u", role: "user", content: "질문", response: null, conversationId: "c1", createdAt: "t" } as any],
    });
    useFetch((url) => {
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      if (url.startsWith("/api/messages")) {
        return jsonRes({
          messages: [
            { id: "u", role: "user", content: "질문", response: null, conversationId: "c1", createdAt: "t" },
            { id: "a", role: "assistant", content: "완료된 답변", response: null, conversationId: "c1", createdAt: "t" },
          ],
          groupKnowledgeOff: [],
          canvases: [],
        });
      }
      return undefined;
    });
    await attachActiveRun(id);
    expect(pane(id).messages).toHaveLength(2);
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "완료된 답변" });
  });

  it("attachActiveRun reconnects to a run the server still has open", async () => {
    const id = seedPane({ conversationId: "c-live" });
    useFetch((url) => {
      if (url.startsWith("/api/chat/runs?")) return jsonRes({ run: { runId: "run-open" } });
      if (url.includes("/api/chat/runs/run-open/events")) {
        return sseRes([
          ["delta", { text: "이어받은 답변" }],
          ["done", { response: { kind: "text", runtime: "claude", text: "이어받은 답변" } }],
        ]);
      }
      return undefined;
    });
    await attachActiveRun(id);
    expect(pane(id).messages.at(-1)).toMatchObject({ role: "assistant", content: "이어받은 답변" });
    expect(pane(id).streaming).toBe(false);
  });

  it("attachRun warns when the replay stream cannot be read at all", async () => {
    const id = seedPane({ conversationId: "c1" });
    useFetch((url) => (url.includes("/events") ? jsonRes({}, 500) : undefined));
    await attachRun(id, "run-broken");
    expect(get(toasts).some((t) => t.message.includes("진행 중인 응답에 다시 연결하지 못했습니다"))).toBe(true);
    // The pane is handed back idle rather than left stuck on the reconnect status.
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "", abortController: null });
  });
});

/* ------------------------------------------------------------------ */
/* openSeededChat / startNewChat / resume-instead-of-duplicate         */
/* ------------------------------------------------------------------ */

describe("opening a seeded or brand-new chat", () => {
  it("openSeededChat fills the composer with the handoff text without sending it", async () => {
    useFetch((url) => {
      if (url === "/api/avatars/owner") return jsonRes({ avatar: { id: "owner", alias: "내 아바타", isOwn: true } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await openSeededChat("이 알림에 대해 알려줘");
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0]).toMatchObject({ draft: "이 알림에 대해 알려줘", messages: [], streaming: false });
    expect(s.currentAvatar?.id).toBe("owner");
    expect(s.activePaneId).toBe(s.chatPanes[0].id);
    expect(get(toasts).some((t) => t.message.includes("검토 후 보내기"))).toBe(true);
  });

  it("openSeededChat lets the caller phrase its own notice", async () => {
    useFetch((url) => {
      if (url === "/api/avatars/owner") return jsonRes({ avatar: { id: "owner", alias: "내 아바타", isOwn: true } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await openSeededChat("예약 작업을 지금 실행", "예약 작업 내용을 입력창에 담았습니다.");
    expect(get(toasts).some((t) => t.message === "예약 작업 내용을 입력창에 담았습니다.")).toBe(true);
  });

  it("openSeededChat leaves a streaming pane alone when the switch is declined", async () => {
    const id = seedPane({ streaming: true, draft: "원래 초안" });
    const fetchFn = noFetch();
    const opening = openSeededChat("새 주제");
    resolveConfirmation(false);
    await opening;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).draft).toBe("원래 초안");
  });

  it("openSeededChat does nothing when no one is signed in", async () => {
    replaceState({ user: null });
    const fetchFn = noFetch();
    await openSeededChat("주제");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toEqual([]);
  });

  it("startNewChat replaces the active pane with an empty thread", async () => {
    const id = seedPane({ messages: [{ id: "m" } as any], draft: "남은 초안" });
    const fetchFn = noFetch();
    updateState((s) => {
      s.view = "explore";
    });
    await startNewChat();
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0].id).not.toBe(id);
    expect(s.chatPanes[0]).toMatchObject({ messages: [], draft: "" });
    // The avatar is kept, so no avatar lookup is needed.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("startNewChat replaces a streaming pane only once the owner confirms", async () => {
    const id = seedPane({ streaming: true, messages: [{ id: "m" } as any] });
    noFetch();

    const declined = startNewChat();
    resolveConfirmation(false);
    await declined;
    expect(readState().chatPanes[0].id).toBe(id);
    expect(pane(id).messages).toHaveLength(1);

    const accepted = startNewChat();
    resolveConfirmation(true);
    await accepted;
    expect(readState().chatPanes[0].id).not.toBe(id);
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("startNewChat opens the owner's own avatar when nothing is open", async () => {
    useFetch((url) => {
      if (url === "/api/avatars/owner") return jsonRes({ avatar: { id: "owner", alias: "내 아바타", isOwn: true } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startNewChat();
    const s = readState();
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0].avatar.id).toBe("owner");
    expect(s).toMatchObject({ view: "chat", activePaneId: s.chatPanes[0].id });
  });

  it("startNewChat does nothing with no pane and no signed-in user", async () => {
    replaceState({ user: null });
    const fetchFn = noFetch();
    await startNewChat();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toEqual([]);
  });

  it("startChatWith resumes the existing conversation instead of opening a duplicate", async () => {
    replaceState({ conversations: [{ id: "c-old", avatarUserId: "av9", isRoutine: false } as any] });
    useFetch((url) => {
      // A thread that never had canvases or group-knowledge picks omits both keys.
      if (url.startsWith("/api/messages")) return jsonRes({ messages: [] });
      if (url === "/api/avatars/av9") return jsonRes({ avatar: { id: "av9", alias: "동료", isOwn: false } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await startChatWith({ id: "av9" } as any);
    expect(readState().chatPanes).toHaveLength(1);
    expect(readState().chatPanes[0]).toMatchObject({
      conversationId: "c-old",
      groupKnowledgeOff: [],
      canvases: [],
    });
  });

  it("startChatWith ignores a routine thread and starts a fresh conversation", async () => {
    // Routine threads have their own view; resuming one from 탐색 would drop the
    // owner into a scheduled job's transcript.
    replaceState({ conversations: [{ id: "r-only", avatarUserId: "av9", isRoutine: true } as any] });
    useFetch((url) => {
      if (url === "/api/avatars/av9") return jsonRes({ avatar: { id: "av9", alias: "동료", isOwn: false } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startChatWith({ id: "av9" } as any);
    expect(readState().chatPanes[0].conversationId).not.toBe("r-only");
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("addConversationToSplit loads a stored conversation into a second pane", async () => {
    seedPane();
    replaceState({ conversations: [{ id: "c9", avatarUserId: "av9", isRoutine: false } as any] });
    useFetch((url) => {
      if (url.startsWith("/api/messages")) {
        return jsonRes({
          messages: [
            { id: "u", role: "user", content: "질문", response: null, conversationId: "c9", createdAt: "t" },
            {
              id: "a",
              role: "assistant",
              content: "답변",
              conversationId: "c9",
              createdAt: "t",
              response: { kind: "text", runtime: "claude", text: "답변", usage: { inputTokens: 12, outputTokens: 3 } },
            },
            // A later turn that reported no tokens (a stop, a replayed reply) must
            // not blank the badge the previous turn earned.
            {
              id: "a2",
              role: "assistant",
              content: "중지됨",
              conversationId: "c9",
              createdAt: "t",
              response: { kind: "text", runtime: "claude", text: "", usage: { inputTokens: 0, outputTokens: 0 } },
            },
          ],
          groupKnowledgeOff: ["g1"],
          selectedModel: "opus",
          selectedEffort: "high",
          selectedMcpToolGroups: ["git_repo", "web"],
          // The same artifact is persisted once per version; only the last entry
          // (the current version) belongs in the panel.
          canvases: [
            { id: "cv1", title: "초안" },
            { id: "cv1", title: "최종" },
            { id: "cv2", title: "다른 캔버스" },
          ],
        });
      }
      if (url === "/api/avatars/av9") return jsonRes({ avatar: { id: "av9", alias: "동료", isOwn: false } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });

    await addConversationToSplit("c9");

    const s = readState();
    expect(s.chatPanes).toHaveLength(2);
    const added = s.chatPanes[1];
    expect(s.activePaneId).toBe(added.id);
    expect(s.currentAvatar?.id).toBe("av9");
    expect(added).toMatchObject({
      conversationId: "c9",
      groupKnowledgeOff: ["g1"],
      modelTier: "opus",
      effort: "high",
      mcpToolGroups: ["git_repo", "web"],
      activeCanvasId: "cv2",
    });
    expect(added.messages).toHaveLength(3);
    expect(added.canvases).toEqual([
      { id: "cv1", title: "최종", pending: false },
      { id: "cv2", title: "다른 캔버스", pending: false },
    ]);
    // The composer badge picks up the newest turn that actually reported usage.
    expect(added.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  it("addConversationToSplit warns when the conversation is gone", async () => {
    seedPane();
    useFetch((url) =>
      url === "/api/conversations" || url === "/api/conversations?kind=routine"
        ? jsonRes({ conversations: [] })
        : undefined,
    );
    await addConversationToSplit("ghost");
    expect(get(toasts).some((t) => t.message.includes("대화를 찾을 수 없습니다"))).toBe(true);
    expect(readState().chatPanes).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* sendMessage — slash literals, staged images, failure modes           */
/* ------------------------------------------------------------------ */

const STAGED_IMAGE = {
  id: "img1",
  dataUrl: "data:image/png;base64,AAAA",
  name: "shot.png",
  mediaType: "image/png" as const,
};

function doneWith(text: string): Array<[string, unknown]> {
  return [
    [
      "done",
      {
        message: {
          id: newIdLike(),
          role: "assistant",
          content: text,
          conversationId: "c",
          createdAt: "t",
          response: { kind: "text", runtime: "claude", text },
        },
      },
    ],
  ];
}

let doneSeq = 0;
function newIdLike(): string {
  return `done-msg-${++doneSeq}`;
}

describe("sendMessage: slash literals, staged images, failure modes", () => {
  it("sends a typed slash command as its literal text", async () => {
    const id = seedPane({ avatar: { id: "owner", alias: "내 아바타", isOwn: true } as any });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes(doneWith("저장했습니다"));
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "/remember 회의는 화요일");

    // The server expands the command into the agent-facing prompt; the wire and
    // the visible bubble both keep the literal the owner typed.
    expect(bodies[0].message).toBe("/remember 회의는 화요일");
    expect(pane(id).messages[0]).toMatchObject({ role: "user", content: "/remember 회의는 화요일" });

    await sendMessage(id, "/summarize");
    expect(bodies[1].message).toBe("/summarize");
  });

  it("falls back to the status code when a failed send carries no readable message", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({}, 503);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "안녕");
    expect(get(toasts).some((t) => t.message.includes("HTTP 503"))).toBe(true);

    // A proxy's HTML error page is not JSON at all.
    const other = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new Error("not json");
          },
        };
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(other, "안녕");
    expect(get(toasts).some((t) => t.message.includes("HTTP 502"))).toBe(true);
  });

  it("ignores panes it cannot act on", async () => {
    const fetchFn = noFetch();
    await sendMessage("no-such-pane", "안녕");
    const streaming = seedPane({ streaming: true, conversationId: "c1" });
    // A pane that is already streaming has nothing to reattach to.
    await attachActiveRun(streaming);
    await attachActiveRun("no-such-pane");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends staged images on an image-only turn and holds their data URLs for the bubble", async () => {
    const id = seedPane({ pendingImages: [STAGED_IMAGE] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes(doneWith("이미지를 확인했습니다"));
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "");

    expect(bodies[0].images).toEqual([{ id: "img1", data: STAGED_IMAGE.dataUrl }]);
    expect(pane(id).messages[0]).toMatchObject({
      role: "user",
      content: "",
      attachments: [{ id: "img1", kind: "image", mediaType: "image/png", name: "shot.png" }],
    });
    // Held locally so the just-sent bubble renders before the bytes are fetchable.
    expect(pane(id).localImages).toEqual({ img1: STAGED_IMAGE.dataUrl });
    expect(pane(id).pendingImages).toEqual([]);
  });

  it("restores the draft and the staged images when nothing streamed", async () => {
    const id = seedPane({ pendingImages: [STAGED_IMAGE] });
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({ error: "업로드에 실패했습니다." }, 500);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "이 이미지 봐줘");

    expect(pane(id).messages).toEqual([]);
    expect(pane(id).draft).toBe("이 이미지 봐줘");
    // Re-attaching by hand after a failed send would be busywork.
    expect(pane(id).pendingImages).toEqual([STAGED_IMAGE]);
    expect(pane(id).localImages).toEqual({});
    expect(get(toasts).some((t) => t.message.includes("업로드에 실패했습니다."))).toBe(true);
  });

  it("reports an expired session rather than a bare status code", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") return { ok: false, status: 401, json: async () => ({}) };
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "안녕");
    expect(get(toasts).some((t) => t.message.includes("세션이 만료되었습니다"))).toBe(true);
    expect(pane(id).draft).toBe("안녕");
  });

  it("keeps the streamed text as an error bubble when the stream breaks mid-turn", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") return brokenSseRes([["delta", { text: "여기까지 답하다" }]]);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "질문");

    const last = pane(id).messages.at(-1)!;
    expect(last.role).toBe("assistant");
    // Partial work is kept and the failure is appended, not swapped in for it.
    expect(last.content).toBe("여기까지 답하다\n\n연결이 끊겼습니다");
    expect(last.response).toMatchObject({ summary: "오류", text: "여기까지 답하다" });
    expect(pane(id).messages[0]).toMatchObject({ role: "user", content: "질문" });
    expect(get(toasts).some((t) => t.message.includes("메시지를 보내지 못했습니다"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* stream events applied to a pane                                     */
/* ------------------------------------------------------------------ */

describe("stream events applied to a pane", () => {
  it("starts a new paragraph when activity interrupts the text stream", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["delta", { text: "첫 문장" }],
      ["tool", { toolUseId: "t1", name: "Read", input: { file_path: "/a.ts" } }],
      ["delta", { text: "이어지는 문장" }],
    ]);
    expect(pane(id).liveText).toBe("첫 문장\n\n이어지는 문장");
    expect(pane(id).liveTextBreakPending).toBe(false);
    expect(pane(id).liveTools[0]).toMatchObject({ label: "파일 읽기", detail: "/a.ts", status: "running" });
    // Answer text means reasoning handed off.
    expect(pane(id).thinkingActive).toBe(false);
  });

  it("does not double-space when either side already broke the line", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["delta", { text: "끝난 문단\n" }],
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }],
      ["delta", { text: "새 문단" }],
    ]);
    expect(pane(id).liveText).toBe("끝난 문단\n새 문단");

    const other = seedPane();
    await driveEvents(other, [
      ["delta", { text: "문장" }],
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }],
      ["delta", { text: "\n이어서" }],
    ]);
    expect(pane(other).liveText).toBe("문장\n이어서");
  });

  it("thinking_reset drops the discarded attempt's reasoning", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["thinking", { text: "버려질 추론" }],
      ["thinking_reset", {}],
      ["thinking", { text: "남는 추론" }],
    ]);
    expect(pane(id).liveThinking).toBe("남는 추론");
    expect(pane(id).thinkingActive).toBe(true);
  });

  it("text_fold moves the interim narration into the reasoning view and restarts the bubble", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["delta", { text: "중간 설명" }],
      ["text_fold", {}],
      ["delta", { text: "최종 답" }],
    ]);
    // The bubble keeps only the block that came after the fold…
    expect(pane(id).liveText).toBe("최종 답");
    // …and the superseded narration is still readable, in the thinking card.
    expect(pane(id).liveThinking).toContain("중간 설명");
  });

  it("text_fold re-anchors an already-stamped card to the top of the restarted answer", async () => {
    const id = seedPane();
    const attachment = { id: "f1", kind: "file", mediaType: "text/plain", name: "메모.txt" };
    await driveEvents(id, [
      ["delta", { text: "1234" }],
      ["file", { attachment }],
      ["text_fold", {}],
      ["delta", { text: "최종 답" }],
    ]);
    // The text the anchor indexed into is gone from the answer, so the card
    // belongs before the new tail rather than 4 characters into it.
    expect(pane(id).liveAttachments).toEqual([{ ...attachment, anchor: 0 }]);
    expect(pane(id).liveText).toBe("최종 답");
  });

  it("keeps internal orchestration tools out of the activity rows", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "h1", name: "TodoWrite", input: {} }],
      ["tool", { toolUseId: "h2", input: { command: "이름 없는 도구" } }],
      ["tool", { toolUseId: "v1", name: "Bash", input: { command: "ls" } }],
    ]);
    expect(pane(id).liveTools.map((t) => t.id)).toEqual(["v1"]);
  });

  it("a repeated tool frame updates the row instead of adding a second one", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }],
      ["tool", { toolUseId: "t1", name: "Bash", inputSummary: "ls -la" }],
    ]);
    expect(pane(id).liveTools).toHaveLength(1);
    expect(pane(id).liveTools[0]).toMatchObject({ label: "명령 실행", detail: "ls -la", status: "running" });
  });

  it("a generic status label does not overwrite a sticky activity label", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "npm test" } }],
      ["status", { label: "작업 중" }],
    ]);
    expect(statuses()).toContain("명령 실행 · npm test");
    expect(statuses()).not.toContain("작업 중");
  });

  it("blocked explains the block in Korean and outlasts a later tool_end", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "git push" } }],
      ["blocked", { toolUseId: "t1", toolName: "Bash", uiReason: "읽기 전용 도구입니다." }],
      // A tool_end still arrives for the blocked call; it must not report success.
      ["tool_end", { toolUseId: "t1", ok: true, output: "무시되어야 함" }],
    ]);
    expect(pane(id).liveTools).toHaveLength(1);
    expect(pane(id).liveTools[0]).toMatchObject({
      status: "blocked",
      detail: "차단됨 · 읽기 전용 도구입니다.",
    });
  });

  it("blocked tags model-facing English as a detail and has a fallback with no reason", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["blocked", { toolUseId: "b1", toolName: "Bash", reason: "read-only mode" }],
      ["blocked", { toolUseId: "b2", toolName: "Bash", reason: "정책상 허용되지 않습니다." }],
      ["blocked", { toolName: "mcp__repo__write_file" }],
    ]);
    const rows = pane(id).liveTools;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: "b1",
      kind: "blocked",
      label: "명령 실행",
      detail: "차단됨 (상세: read-only mode)",
      status: "blocked",
    });
    expect(rows[1].detail).toBe("차단됨 · 정책상 허용되지 않습니다.");
    expect(rows[2]).toMatchObject({ label: "write file", detail: "읽기 전용이라 차단됨" });
    expect(rows[2].id).toBeTruthy();
  });

  it("memory rows render a capture once per event id", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["memory", { id: "mem1", path: "wiki/회의.md", action: "create" }],
      // A reattach replays the whole log; the same capture must not stack up.
      ["memory", { id: "mem1", path: "wiki/회의.md", action: "create" }],
      ["memory", { id: "mem2", path: "wiki/정책.md", action: "update", scope: "group", groupName: "플랫폼" }],
      // An id-less capture still gets a row (it just cannot be deduped).
      ["memory", { path: "wiki/무제.md" }],
    ]);
    const rows = pane(id).liveTools;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: "memory",
      label: "기억 추가됨",
      detail: "wiki/회의.md",
      status: "done",
      agentId: "main",
    });
    expect(rows[1]).toMatchObject({ label: "그룹 기억 갱신됨", detail: "플랫폼 · wiki/정책.md" });
    expect(rows[2]).toMatchObject({ label: "기억 추가됨", detail: "wiki/무제.md" });
    expect(rows[2].id).toBeTruthy();
  });

  it("compact rows outlive the transient status label, once per event id", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["compact", { id: "cmp1", ok: true, trigger: "auto", preTokens: 152_000 }],
      // A reattach replays the whole log; one compaction stays one row.
      ["compact", { id: "cmp1", ok: true, trigger: "auto", preTokens: 152_000 }],
      ["compact", { id: "cmp2", ok: true, trigger: "manual" }],
      ["compact", { id: "cmp3", ok: true }],
    ]);
    const rows = pane(id).liveTools;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: "compact",
      agentId: "main",
      label: "대화 맥락이 요약되었습니다",
      detail: "자동 요약 · 이전 맥락 약 152K토큰",
      status: "done",
    });
    expect(rows[1]).toMatchObject({ label: "대화 맥락이 요약되었습니다", detail: "수동 요약" });
    // Nothing to say about it — the row itself is the notice.
    expect(rows[2].detail).toBeUndefined();
    // The row needs a main agent node, or the activity card never renders it.
    expect(pane(id).liveAgents.map((a) => a.id)).toEqual(["main"]);
  });

  it("a failed compaction is a failed row carrying the SDK's English detail", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["compact", { id: "cmp-x", ok: false, error: "summary request failed: 429" }],
      ["compact", { id: "cmp-y", ok: false }],
    ]);
    const rows = pane(id).liveTools;
    expect(rows[0]).toMatchObject({
      kind: "compact",
      label: "맥락 정리에 실패했습니다",
      detail: "summary request failed: 429",
      status: "failed",
    });
    expect(rows[1]).toMatchObject({ label: "맥락 정리에 실패했습니다", status: "failed" });
    expect(rows[1].detail).toBeUndefined();
  });

  it("plan mode shows a placeholder while writing, then the submitted plan", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const pending = trackState((s) => s.chatPanes.find((p) => p.id === id)?.planPending ?? false);
    await driveEvents(id, [
      ["plan", { planning: true }],
      ["plan", { plan: "1. 조사\n2. 구현" }],
    ]);
    expect(pending()).toContain(true);
    expect(pane(id)).toMatchObject({ livePlan: "1. 조사\n2. 구현", planPending: false });
    expect(statuses()).toContain("계획을 작성하는 중…");
    expect(statuses()).toContain("계획을 제출했습니다.");
  });

  it("an empty ExitPlanMode clears the writing-plan placeholder", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["plan", { planning: true }],
      ["plan", {}],
    ]);
    expect(pane(id)).toMatchObject({ planPending: false, livePlan: "" });
  });

  it("plan_review surfaces inline controls and notifies the owner", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    await driveEvents(id, [["plan_review", { requestId: "pr-live-1", runId: "rn-live-1", plan: "제안된 계획" }]]);
    expect(pane(id).planReview).toEqual({ requestId: "pr-live-1", runId: "rn-live-1" });
    expect(pane(id)).toMatchObject({ livePlan: "제안된 계획", planPending: false, planReviewSubmitting: false });
    expect(notes).toEqual([
      { title: "노아 · 계획 승인 필요", body: "제안한 계획을 검토해 주세요.", tag: `plan-${id}` },
    ]);
  });

  it("prompt_resolved locks a parked canvas form and drops the plan controls", async () => {
    const id = seedPane();
    await driveEvents(id, [
      [
        "canvas",
        {
          artifactId: "cv-live",
          title: "설문",
          controls: [{ id: "q1" }],
          interaction: "blocking",
          requestId: "rq-live-1",
          runId: "rn-live",
        },
      ],
      ["plan_review", { requestId: "pr-live-2", runId: "rn-live", plan: "계획" }],
      // Resolved server-side (timeout / answered elsewhere / reconnect).
      ["prompt_resolved", { requestId: "rq-live-1" }],
      ["prompt_resolved", { requestId: "pr-live-2" }],
    ]);
    expect(pane(id).canvases[0]).toMatchObject({ id: "cv-live", pending: false, requestId: "rq-live-1" });
    expect(pane(id).planReview).toBeNull();
    expect(pane(id).planReviewSubmitting).toBe(false);
  });

  it("a re-shown canvas replaces its entry and bumps the version count", async () => {
    const id = seedPane();
    await driveEvents(id, [
      // Controls without a parked run: an async canvas renders its form but the
      // run keeps going.
      ["canvas", { artifactId: "cv1", title: "초안", content: "v1", controls: [{ id: "a" }], interaction: "async" }],
      ["canvas", { artifactId: "cv1", title: "다듬은 초안", content: "v2", editable: true }],
      ["canvas", { artifactId: "cv2" }],
      ["canvas", { artifactId: "cv3", controls: [{ id: "b" }], interaction: "blocking", requestId: "rq-b", runId: "rn-b" }],
    ]);
    const canvases = pane(id).canvases;
    expect(canvases.map((c) => c.id)).toEqual(["cv1", "cv2", "cv3"]);
    expect(canvases[0]).toMatchObject({
      title: "다듬은 초안",
      content: "v2",
      editable: true,
      pending: false,
      currentVersion: 2,
      versionCount: 2,
    });
    expect(canvases[1]).toMatchObject({ title: "캔버스", contentType: "markdown", currentVersion: 1 });
    expect(canvases[2]).toMatchObject({ pending: true, requestId: "rq-b", runId: "rn-b" });
    expect(pane(id).activeCanvasId).toBe("cv3");
  });

  it("a shared .drawio pops the side preview and anchors the card to the text so far", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const attachment = { id: "d1", kind: "file", mediaType: DRAWIO_MEDIA_TYPE, name: "구조.drawio" };
    await driveEvents(id, [
      ["delta", { text: "1234" }],
      ["file", { attachment }],
      ["file", { attachment }],
    ]);
    expect(pane(id).liveAttachments).toEqual([{ ...attachment, anchor: 4 }]);
    expect(pane(id).filePreview).toMatchObject({ attachment: { id: "d1" }, slides: [] });
    expect(statuses()).toContain("파일을 공유했습니다.");
  });

  it("a .drawio share stays a card when more than one pane is open", async () => {
    seedPane();
    const id = seedPane();
    const attachment = { id: "d2", kind: "file", mediaType: DRAWIO_MEDIA_TYPE, name: "구조.drawio" };
    await driveEvents(id, [["file", { attachment }]]);
    // Split view has no side-panel slot; the preview would silently hijack it.
    expect(pane(id).filePreview).toBeUndefined();
    expect(pane(id).liveAttachments).toHaveLength(1);
  });

  it("a replayed done frame does not duplicate an already-stored bubble", async () => {
    const stored = {
      id: "m-stored",
      role: "assistant",
      content: "저장된 답변",
      conversationId: "conv-x",
      createdAt: "t",
      response: { kind: "text", runtime: "claude", text: "저장된 답변" },
    };
    const id = seedPane({ messages: [stored as any] });
    await driveEvents(id, [
      ["delta", { text: "재생된 텍스트" }],
      ["done", { message: stored }],
    ]);
    expect(pane(id).messages).toHaveLength(1);
    expect(pane(id).liveText).toBe("");
  });

  it("ignores an event kind it does not know", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["mystery", { text: "?" }],
      ["delta", { text: "정상" }],
    ]);
    expect(pane(id).liveText).toBe("정상");
    expect(pane(id).messages).toEqual([]);
    expect(get(toasts)).toEqual([]);
  });

  it("ignores frames that are missing the field they hinge on", async () => {
    const id = seedPane({ conversationId: "conv-keep" });
    await driveEvents(id, [
      ["delta", {}],
      ["thinking", {}],
      ["open", {}],
      ["status", {}],
      ["plugin", {}],
      ["agent", {}],
      ["agent_end", {}],
      ["agent_end", { agentId: "never-announced" }],
      ["tool_end", {}],
      ["tool_end", { toolUseId: "never-started" }],
      ["task", {}],
      ["blocked", {}],
      ["memory", {}],
      ["canvas", {}],
      ["file", { attachment: {} }],
      ["prompt_resolved", {}],
      ["bg_end", {}],
    ]);
    const p = pane(id);
    // A partial frame must not mint a phantom row or move the conversation.
    expect(p.conversationId).toBe("conv-keep");
    expect(p).toMatchObject({ liveText: "", liveThinking: "" });
    expect(p.liveTools).toEqual([]);
    expect(p.liveTasks).toEqual([]);
    expect(p.liveAgents).toEqual([]);
    expect(p.livePlugins).toEqual([]);
    expect(p.canvases).toEqual([]);
    expect(p.liveAttachments).toEqual([]);
    expect(p.messages).toEqual([]);
  });

  it("a tool from an unannounced agent gets a placeholder node, and a bare repeat keeps its detail", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", agentId: "ghost", input: { command: "ls" } }],
      // Nothing to summarise this time; the detail captured at tool start stands.
      ["tool", { toolUseId: "t1", name: "Bash", agentId: "ghost" }],
    ]);
    const p = pane(id);
    expect(p.liveAgents.map((a) => a.id)).toEqual(["main", "ghost"]);
    expect(p.liveAgents[1]).toMatchObject({
      parentId: "main",
      label: "하위 작업",
      status: "running",
      isMain: false,
    });
    expect(p.liveTools[0]).toMatchObject({ detail: "ls", status: "running" });
  });

  it("a server-set plan and reasoning on the finished response win over the live ones", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["plan", { plan: "라이브 계획" }],
      ["thinking", { text: "라이브 추론" }],
      [
        "done",
        { response: { kind: "text", runtime: "claude", text: "완료", plan: "서버 계획", thinking: "서버 추론" } },
      ],
    ]);
    expect(pane(id).messages.at(-1)!.response).toMatchObject({ plan: "서버 계획", thinking: "서버 추론" });
  });

  it("a done frame with nothing to show leaves the transcript as it was", async () => {
    const id = seedPane({
      messages: [{ id: "u", role: "user", content: "질문", response: null, conversationId: "c", createdAt: "t" } as any],
    });
    const notes = useOsNotifications();
    await driveEvents(id, [["done", {}]]);
    expect(pane(id).messages).toHaveLength(1);
    // Nothing completed, so there is nothing to announce.
    expect(notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* background phase (the SDK keeps working past the visible turn)      */
/* ------------------------------------------------------------------ */

const BG_MESSAGE = {
  id: "bg-msg-1",
  role: "assistant",
  content: "먼저 답합니다",
  conversationId: "conv-x",
  createdAt: "t",
  response: {
    kind: "text",
    runtime: "claude",
    text: "먼저 답합니다",
    usage: { inputTokens: 5, outputTokens: 2 },
  },
};

describe("background phase", () => {
  it("done{background} finalizes the bubble but keeps the activity tree mounted", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const notes = useOsNotifications();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "npm test" } }],
      ["delta", { text: "먼저 답합니다" }],
      ["done", { background: true, message: BG_MESSAGE, tasks: [{ taskId: "bt1", description: "후속 작업" }] }],
    ]);
    const p = pane(id);
    expect(p.messages.at(-1)).toMatchObject({ id: "bg-msg-1", role: "assistant" });
    expect(p).toMatchObject({ backgroundPhase: true, backgroundMessageId: "bg-msg-1" });
    expect(p.backgroundTasks).toEqual([{ taskId: "bt1", description: "후속 작업" }]);
    // Rows keep updating until bg_end; only the text moved into the bubble.
    expect(p.liveTools).toHaveLength(1);
    expect(p).toMatchObject({ liveText: "", liveThinking: "", planPending: false });
    expect(p.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(statuses()).toContain("백그라운드 작업 진행 중…");
    expect(notes.map((n) => n.title)).toContain("노아 · 답변 완료");
  });

  it("bg_tasks replaces the live task set rather than merging into it", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["done", { background: true, message: BG_MESSAGE }],
      ["bg_tasks", { tasks: [{ taskId: "a" }, { taskId: "b" }] }],
      ["bg_tasks", { tasks: [{ taskId: "c" }] }],
    ]);
    expect(pane(id).backgroundTasks).toEqual([{ taskId: "c" }]);
  });

  it("bg_end seals the tree onto the finalized turn and persists the snapshot", async () => {
    const id = seedPane();
    const { calls } = await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "npm test" } }],
      ["task", { taskId: "k9", subagentType: "worker" }],
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["bg_end", {}],
    ]);
    const p = pane(id);
    expect(p).toMatchObject({ backgroundPhase: false, backgroundMessageId: null });
    expect(p.backgroundTasks).toEqual([]);
    expect(p.liveTools).toEqual([]);
    expect(p.liveTasks).toEqual([]);
    // A row still "running" at the end would render a perpetual spinner.
    const sealed = (p.messages.at(-1)!.response as any).activity;
    expect(sealed.tools[0]).toMatchObject({ id: "t1", status: "done" });
    expect(sealed.tasks[0]).toMatchObject({ id: "k9", status: "done" });
    const put = calls.find((c) => c.url.includes("/api/messages/bg-msg-1/activity"));
    expect(put?.init.method).toBe("PUT");
    expect(body(put!.init).activity.tools[0].status).toBe("done");
  });

  it("bg_end with no activity to seal just ends the phase", async () => {
    const id = seedPane();
    const { calls } = await driveEvents(id, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["bg_end", {}],
    ]);
    expect(pane(id).backgroundPhase).toBe(false);
    expect(calls.some((c) => c.url.includes("/activity"))).toBe(false);
  });

  it("a background wake-up turn gets its own bubble, once per message id", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const wake = {
      id: "bg-wake-1",
      role: "assistant",
      content: "백그라운드 결과입니다",
      conversationId: "conv-x",
      createdAt: "t",
      response: { kind: "text", runtime: "claude", text: "백그라운드 결과입니다" },
    };
    await driveEvents(id, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["delta", { text: "스트리밍 꼬리" }],
      ["bg_message", { message: wake }],
      ["bg_message", { message: wake }],
      // Only the avatar's own wake-up turns become bubbles.
      ["bg_message", { message: { ...wake, id: "bg-wake-2", role: "user" } }],
    ]);
    const p = pane(id);
    expect(p.messages.filter((m) => m.id === "bg-wake-1")).toHaveLength(1);
    expect(p.messages.some((m) => m.id === "bg-wake-2")).toBe(false);
    // The streamed tail is embodied in the pushed bubble — it must not render twice.
    expect(p.liveText).toBe("");
    expect(notes.filter((n) => n.title.includes("백그라운드 작업 보고"))).toEqual([
      { title: "노아 · 백그라운드 작업 보고", body: "백그라운드 결과입니다", tag: `bg-${id}` },
    ]);
  });

  it("stopping during the background phase seals the tree as failed and keeps the tail", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "sleep 60" } }],
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["delta", { text: "중단 직전 텍스트" }],
      ["cancelled", {}],
    ]);
    const p = pane(id);
    // Those tasks really died — reporting "done" would be a lie.
    const sealed = (p.messages.find((m) => m.id === "bg-msg-1")!.response as any).activity;
    expect(sealed.tools[0]).toMatchObject({ id: "t1", status: "failed" });
    expect(p.backgroundPhase).toBe(false);
    expect(p.messages.at(-1)).toMatchObject({ content: "중단 직전 텍스트" });
    expect(p.messages.at(-1)!.response).toMatchObject({ summary: "중지됨" });
  });

  it("an error during the background phase fails the tree and reports the error", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "sleep 60" } }],
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["error", { error: "모델이 응답하지 못했습니다." }],
    ]);
    const p = pane(id);
    const sealed = (p.messages.find((m) => m.id === "bg-msg-1")!.response as any).activity;
    expect(sealed.tools[0].status).toBe("failed");
    expect(p.messages.at(-1)).toMatchObject({ content: "모델이 응답하지 못했습니다." });
    expect(p.messages.at(-1)!.response).toMatchObject({ summary: "오류" });
    expect(get(toasts).some((t) => t.message.includes("모델이 응답하지 못했습니다."))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* mid-turn messages ("steers")                                        */
/* ------------------------------------------------------------------ */

/**
 * A `steer` frame. `extra` lands INSIDE the steer object, which is where the
 * persisted user row rides on the `delivered` frame.
 */
function steerFrame(
  id: string,
  state: "queued" | "delivered" | "completed" | "dropped",
  text: string,
  extra: Record<string, unknown> = {},
): [string, unknown] {
  return [
    "steer",
    { steer: { id, text, state, createdAt: "2026-09-21T01:00:00.000Z", followUp: false, ...extra } },
  ];
}

function steerUserRow(id: string, content: string) {
  return {
    id,
    conversationId: "conv-x",
    role: "user",
    content,
    kind: "steer",
    response: null,
    createdAt: "2026-09-21T01:00:01.000Z",
  };
}

describe("mid-turn messages (steers)", () => {
  it("a queued steer becomes a pending row, and its replay does not double it", async () => {
    const id = seedPane();
    await driveEvents(id, [
      steerFrame("s-queue-1", "queued", "이것도 봐 주세요"),
      steerFrame("s-queue-1", "queued", "이것도 봐 주세요"),
    ]);
    expect(pane(id).steers).toEqual([
      { id: "s-queue-1", text: "이것도 봐 주세요", createdAt: "2026-09-21T01:00:00.000Z" },
    ]);
  });

  it("a delivered steer swaps its pending row for the persisted user message, once", async () => {
    const id = seedPane();
    const row = steerUserRow("um-1", "이것도 봐 주세요");
    await driveEvents(id, [
      steerFrame("s-deliver-1", "queued", "이것도 봐 주세요"),
      ["delta", { text: "답변 본문" }],
      steerFrame("s-deliver-1", "delivered", "이것도 봐 주세요", { message: row }),
      // A reattach replays the whole log; the row must not land twice.
      steerFrame("s-deliver-1", "delivered", "이것도 봐 주세요", { message: row }),
      ["done", {}],
    ]);
    const p = pane(id);
    expect(p.steers).toEqual([]);
    expect(p.messages.filter((m) => m.id === "um-1")).toHaveLength(1);
    expect(p.messages.find((m) => m.id === "um-1")).toMatchObject({ role: "user", kind: "steer" });
    // It was handed to the model mid-turn, so it reads BEFORE the answer it changed.
    const userIndex = p.messages.findIndex((m) => m.id === "um-1");
    const lastIndex = p.messages.length - 1;
    expect(userIndex).toBeLessThan(lastIndex);
    expect(p.messages[lastIndex]).toMatchObject({ role: "assistant", content: "답변 본문" });
  });

  it("a delivered steer the server could not persist still shows what the model saw", async () => {
    const id = seedPane();
    await driveEvents(id, [
      steerFrame("s-local-1", "delivered", "대화가 사라져도 보여야 함", { message: null }),
      steerFrame("s-local-1", "delivered", "대화가 사라져도 보여야 함", { message: null }),
    ]);
    const p = pane(id);
    expect(p.messages.filter((m) => m.id === "s-local-1")).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      role: "user",
      kind: "steer",
      content: "대화가 사라져도 보여야 함",
    });
  });

  it("a dropped steer returns its text to the composer exactly once", async () => {
    const id = seedPane({ draft: "이미 쓰고 있던 글" });
    await driveEvents(id, [
      steerFrame("s-drop-1", "queued", "너무 늦은 한마디"),
      steerFrame("s-drop-1", "dropped", "너무 늦은 한마디"),
      steerFrame("s-drop-1", "dropped", "너무 늦은 한마디"),
    ]);
    const p = pane(id);
    expect(p.steers).toEqual([]);
    // The returned text is the older thought, so it goes ABOVE the newer draft.
    expect(p.draft).toBe("너무 늦은 한마디\n\n이미 쓰고 있던 글");
    expect(get(toasts).filter((t) => t.message.includes("되돌려 두었습니다"))).toHaveLength(1);
  });

  it("a completed steer just drops any pending row it still has", async () => {
    const id = seedPane();
    await driveEvents(id, [
      steerFrame("s-complete-1", "queued", "확인 부탁해요"),
      steerFrame("s-complete-1", "completed", "확인 부탁해요"),
    ]);
    expect(pane(id).steers).toEqual([]);
    expect(pane(id).messages).toEqual([]);
  });

  it("turn_end seals the turn so far but keeps the run streaming into a fresh bubble", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const samples = trackState((state) => {
      const p = state.chatPanes.find((item) => item.id === id);
      return p ? { streaming: p.streaming, count: p.messages.length, liveText: p.liveText } : null;
    });
    const first = {
      id: "seg-1",
      conversationId: "conv-x",
      role: "assistant",
      content: "첫 번째 턴",
      createdAt: "t",
      response: { kind: "text", runtime: "claude", text: "첫 번째 턴" },
    };
    await driveEvents(id, [
      ["delta", { text: "첫 번째 턴" }],
      ["turn_end", { message: first, response: first.response }],
      steerFrame("s-turn-1", "delivered", "그럼 이건요?", {
        followUp: true,
        message: steerUserRow("um-turn-1", "그럼 이건요?"),
      }),
      ["delta", { text: "이어지는 턴" }],
      // No message on the final done: the bubble is built from liveText, which
      // proves the second turn started from an empty one.
      ["done", {}],
    ]);
    const p = pane(id);
    expect(p.messages.map((m) => m.content)).toEqual(["첫 번째 턴", "그럼 이건요?", "이어지는 턴"]);
    expect(p.liveText).toBe("");
    // The run never stopped streaming at the boundary — the pane only settles
    // when the reader detaches after the terminal `done`.
    expect(samples().some((s) => s?.streaming === true && s.count === 1 && s.liveText === "")).toBe(true);
    // turn_end is not the end of anything the viewer was waiting for: only the
    // run's real ending is announced, and it carries the SECOND turn's text.
    expect(notes.map((n) => n.body)).toEqual(["이어지는 턴"]);
  });

  it("sendSteer posts to the run, clears the draft and holds the accepted row", async () => {
    const id = seedPane({ streaming: true, liveRunId: "run-77", draft: "중간에 한마디" });
    const fetchFn = useFetch((url) =>
      url === "/api/chat/runs/run-77/message"
        ? jsonRes({
            ok: true,
            steer: {
              id: "s-post-1",
              text: "중간에 한마디",
              state: "queued",
              createdAt: "2026-09-21T02:00:00.000Z",
              followUp: false,
            },
          })
        : undefined,
    );
    await sendSteer(id, "중간에 한마디");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe("/api/chat/runs/run-77/message");
    expect(body(fetchFn.mock.calls[0][1] as RequestInit)).toEqual({ message: "중간에 한마디" });
    const p = pane(id);
    expect(p.draft).toBe("");
    expect(p.steerSending).toBe(false);
    expect(p.steers).toEqual([
      { id: "s-post-1", text: "중간에 한마디", createdAt: "2026-09-21T02:00:00.000Z" },
    ]);
  });

  it("a 410 puts the text back in the composer and shows the server's own reason", async () => {
    const id = seedPane({ streaming: true, liveRunId: "run-78" });
    useFetch(() =>
      jsonRes(
        { error: "응답이 마무리되는 중이라 전달할 수 없습니다. 응답이 끝난 뒤 다시 보내 주세요." },
        410,
      ),
    );
    await sendSteer(id, "늦은 한마디");
    const p = pane(id);
    expect(p.draft).toBe("늦은 한마디");
    expect(p.steerSending).toBe(false);
    expect(get(toasts).some((t) => t.message.includes("응답이 마무리되는 중이라"))).toBe(true);
  });

  it("an external pane never reaches the steer route", async () => {
    const id = seedPane({
      streaming: true,
      liveRunId: "run-79",
      draft: "외부 아바타",
      avatar: { id: "ext-1", alias: "외부", displayName: "External", runtime: "external" } as any,
    });
    const fetchFn = noFetch();
    await sendSteer(id, "외부 아바타");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).draft).toBe("외부 아바타");
  });

  it("a steer needs a live run: no run id, no request", async () => {
    const id = seedPane({ streaming: true, liveRunId: null, draft: "보낼 곳이 없음" });
    const fetchFn = noFetch();
    await sendSteer(id, "보낼 곳이 없음");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* auto-reconnect when a connection drops before its run finishes      */
/* ------------------------------------------------------------------ */

describe("auto-reconnect", () => {
  const RECONNECTING = "연결이 끊겨 다시 연결하는 중…";

  const WAKE_MESSAGE = {
    id: "bg-wake-r",
    role: "assistant",
    content: "백그라운드 보고",
    conversationId: "conv-x",
    createdAt: "t",
    response: { kind: "text", runtime: "claude", text: "백그라운드 보고" },
  };

  /**
   * An events endpoint whose Nth attempt gets `frames(n)`. The stream simply ends
   * after them, which is exactly what a dropped connection looks like from here.
   */
  function useRunEvents(
    runId: string,
    frames: (attempt: number) => Array<[string, unknown]> | unknown,
  ): () => number {
    let attempts = 0;
    useFetch((url) => {
      if (url.includes(`/api/chat/runs/${runId}/events`)) {
        const answer = frames(++attempts);
        return Array.isArray(answer) ? sseRes(answer as Array<[string, unknown]>) : answer;
      }
      return jsonRes({ ok: true });
    });
    return () => attempts;
  }

  it("holds the live region open when the stream dies with the run still working", async () => {
    const id = seedPane();
    const attempts = useRunEvents("run-drop", (n) => {
      const frames: Array<[string, unknown]> = [
        ["tool", { toolUseId: "t1", name: "Bash", input: { command: "npm test" } }],
        ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ];
      // The reattach replays the whole log, and this time carries it to the end.
      if (n > 1) frames.push(["bg_message", { message: WAKE_MESSAGE }], ["bg_end", {}]);
      return frames;
    });

    const running = attachRun(id, "run-drop");
    // Nothing is torn down: the background indicator and its turn stay mounted.
    await waitFor(() => pane(id).liveStatus === RECONNECTING);
    expect(pane(id)).toMatchObject({ streaming: true, backgroundPhase: true });
    expect(pane(id).messages.at(-1)).toMatchObject({ id: "bg-msg-1" });

    // A returning tab retries immediately instead of waiting the backoff out.
    document.dispatchEvent(new Event("visibilitychange"));
    await running;

    expect(attempts()).toBe(2);
    // The replay rebuilt the turn without duplicating it, and the wake-up landed.
    expect(pane(id).messages.filter((m) => m.id === "bg-msg-1")).toHaveLength(1);
    expect(pane(id).messages.at(-1)).toMatchObject({ id: "bg-wake-r" });
    expect(pane(id)).toMatchObject({
      streaming: false,
      backgroundPhase: false,
      liveStatus: "",
      abortController: null,
    });
  });

  it("ends the loop on a terminal frame delivered by the reattach", async () => {
    const id = seedPane({ conversationId: "c-term" });
    const finished = {
      id: "m-term",
      role: "assistant",
      content: "완결된 답변",
      response: { kind: "text", runtime: "claude", text: "완결된 답변" },
      conversationId: "c-term",
      createdAt: "t",
    };
    const attempts = useRunEvents("run-term", (n) =>
      n > 1 ? [["delta", { text: "완결된 답변" }], ["done", { message: finished }]] : [["delta", { text: "완결된" }]],
    );

    const running = attachRun(id, "run-term");
    await waitFor(() => pane(id).liveStatus === RECONNECTING);
    document.dispatchEvent(new Event("visibilitychange"));
    await running;

    expect(attempts()).toBe(2);
    expect(pane(id).messages.filter((m) => m.id === "m-term")).toHaveLength(1);
    expect(pane(id)).toMatchObject({
      streaming: false,
      liveText: "",
      liveStatus: "",
      abortController: null,
    });
  });

  it("stops reconnecting and catches up when the server no longer has the run", async () => {
    const id = seedPane({ conversationId: "c-gone" });
    const saved = { id: "saved", role: "assistant", content: "저장된 답변", response: null, conversationId: "c-gone", createdAt: "t" };
    let attempts = 0;
    useFetch((url) => {
      if (url.includes("/api/chat/runs/run-gone/events")) {
        attempts += 1;
        if (attempts === 1) return sseRes([["delta", { text: "중간까지" }]]);
        return { ok: false, status: 404, body: null, json: async () => ({}) };
      }
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [saved], groupKnowledgeOff: [], canvases: [] });
      return jsonRes({ ok: true });
    });

    const running = attachRun(id, "run-gone");
    await waitFor(() => pane(id).liveStatus === RECONNECTING);
    document.dispatchEvent(new Event("visibilitychange"));
    await running;

    expect(attempts).toBe(2);
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "저장된 답변" });
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "", abortController: null });
  });

  it("stopping during a reconnect wait exits at once and re-reads nothing", async () => {
    const id = seedPane();
    const attempts = useRunEvents("run-stop", () => [["delta", { text: "일부만" }]]);

    const running = attachRun(id, "run-stop");
    await waitFor(() => pane(id).liveStatus === RECONNECTING);
    // The abort has to cut the backoff short — not be noticed once it elapses.
    await stopPane(id);
    await running;

    expect(attempts()).toBe(1);
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "", abortController: null });
    // The reattached loop tears down without finalizing, so the stop itself is
    // what keeps the streamed tail on screen as the stopped bubble.
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "일부만" });
    expect(pane(id).messages.at(-1)!.response).toMatchObject({ summary: "중지됨" });
  });

  it("does not re-announce a turn the viewer was already told about", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const attempts = useRunEvents("run-note", (n) => {
      const frames: Array<[string, unknown]> = [
        ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ];
      if (n > 1) frames.push(["bg_end", {}]);
      return frames;
    });

    const running = attachRun(id, "run-note");
    await waitFor(() => pane(id).liveStatus === RECONNECTING);
    document.dispatchEvent(new Event("visibilitychange"));
    await running;

    expect(attempts()).toBe(2);
    // The replayed done{background} deduped, so it must stay silent.
    expect(notes.filter((n) => n.title.includes("답변 완료"))).toHaveLength(1);
  });

  it("a send whose own stream dies follows the run instead of ending the turn", async () => {
    const id = seedPane();
    const finished = {
      id: "m-send",
      role: "assistant",
      content: "완결된 답변",
      response: { kind: "text", runtime: "claude", text: "완결된 답변" },
      conversationId: "conv-send",
      createdAt: "t",
    };
    let attempts = 0;
    useFetch((url) => {
      if (url === "/api/chat/stream")
        return brokenSseRes([
          ["open", { conversationId: "conv-send", runId: "run-send" }],
          ["delta", { text: "여기까지" }],
        ]);
      if (url.includes("/api/chat/runs/run-send/events")) {
        attempts += 1;
        return sseRes([["delta", { text: "완결된 답변" }], ["done", { message: finished }]]);
      }
      return jsonRes({ ok: true });
    });

    await sendMessage(id, "질문");

    expect(attempts).toBe(1);
    // Not an error bubble: the turn finished on the reattached stream.
    expect(pane(id).messages.map((m) => m.content)).toEqual(["질문", "완결된 답변"]);
    expect(get(toasts)).toEqual([]);
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "" });
  });

  it("a send that never opened is reported, not reconnected to the previous turn's run", async () => {
    // liveRunId outlives the turn that minted it, so a later failed send must not
    // mistake it for "our run is up, reconnect" and swallow the failure.
    const id = seedPane({ liveRunId: "run-from-last-turn" });
    const seen: string[] = [];
    useFetch((url) => {
      seen.push(url);
      if (url === "/api/chat/stream") return jsonRes({}, 503);
      return jsonRes({ ok: true });
    });

    await sendMessage(id, "다시 물어보기");

    expect(seen.some((url) => url.includes("/events"))).toBe(false);
    expect(get(toasts).some((t) => t.message.includes("HTTP 503"))).toBe(true);
    expect(pane(id)).toMatchObject({ draft: "다시 물어보기", messages: [], streaming: false });
  });

  it("a returning tab re-discovers a run the client lost track of entirely", async () => {
    const id = seedPane({ conversationId: "c-wake" });
    useFetch((url) => {
      if (url.startsWith("/api/chat/runs?")) return jsonRes({ run: { runId: "run-wake" } });
      if (url.includes("/api/chat/runs/run-wake/events"))
        return sseRes([
          ["delta", { text: "다시 찾은 답변" }],
          ["done", { response: { kind: "text", runtime: "claude", text: "다시 찾은 답변" } }],
        ]);
      return jsonRes({ ok: true });
    });

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => !pane(id).streaming && pane(id).messages.length > 0);
    expect(pane(id).messages.at(-1)).toMatchObject({ role: "assistant", content: "다시 찾은 답변" });
  });

  it("entering the background phase refreshes the sidebar's conversation list", async () => {
    const id = seedPane();
    const { calls } = await driveEvents(id, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
    ]);
    expect(calls.some((c) => c.url === "/api/conversations")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* browser-bridge relay                                                */
/* ------------------------------------------------------------------ */

describe("browser-bridge relay", () => {
  it("hands a parked op to the extension and posts the reply back exactly once", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const send = useExtension({ ok: true, pageText: "본문", pageTextOffset: 0, pageTextTotal: 10 });
    const op = { requestId: "br-read-1", runId: "rn-b", op: "read_text", expand: true, maxChars: 2000 };
    const { calls } = await driveEvents(id, [
      ["browser", op],
      // A reattach replays the log; re-executing would act on the page twice.
      ["browser", op],
      // Neither an op nor a requestId to answer — nothing to relay.
      ["browser", { requestId: "br-read-2" }],
    ]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ source: "noah", op: "read_text", expand: true, maxChars: 2000 });
    expect(postedTo(calls, "/api/chat/respond")).toEqual([
      { runId: "rn-b", requestId: "br-read-1", value: { ok: true, pageText: "본문", pageTextOffset: 0, pageTextTotal: 10 } },
    ]);
    expect(statuses()).toContain("페이지를 스크롤하며 본문을 읽는 중…");
  });

  it("answers the parked run even with no extension installed", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    // No chrome.runtime at all: the bridge authors its own ok:false reply so the
    // run resumes with a usable reason instead of waiting out its park TTL.
    const { calls } = await driveEvents(id, [
      ["browser", { requestId: "br-snap-1", runId: "rn-s", op: "snapshot" }],
    ]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    const [posted] = postedTo(calls, "/api/chat/respond");
    expect(posted).toMatchObject({ runId: "rn-s", requestId: "br-snap-1" });
    expect(posted.value.ok).toBe(false);
    expect(String(posted.value.message)).toContain("not reachable");
    // An op with no label of its own still says something truthful.
    expect(statuses()).toContain("브라우저 화면을 읽는 중…");
  });

  it("bounds the replay-dedupe set so a long run cannot grow it forever", async () => {
    const id = seedPane();
    const send = useExtension({ ok: true });
    const frames: Array<[string, unknown]> = [];
    for (let i = 0; i < 520; i++) {
      frames.push(["browser", { requestId: `br-bulk-${i}`, runId: "rn-bulk", op: "click", uid: "u1" }]);
    }
    await driveEvents(id, frames);
    expect(send).toHaveBeenCalledTimes(520);

    // Ids are consumed in order, so the oldest are the safe ones to drop: past the
    // cap the first requests are evicted and would run again if replayed.
    send.mockClear();
    await driveEvents(id, [["browser", { requestId: "br-bulk-0", runId: "rn-bulk", op: "click", uid: "u1" }]]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* browser-bridge relay — stored-secret input                          */
/* ------------------------------------------------------------------ */

describe("browser-bridge relay: stored-secret input", () => {
  const POLICY = { name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true };
  const PLAINTEXT = "hunter2secret!";

  /** An extension that reports `version` on the probe and accepts every op. */
  function useVersionedExtension(version?: string) {
    return useExtension((message: any) =>
      message.op === "getAllowedOrigins"
        ? { ok: true, source: "local", patterns: [], ...(version ? { version } : {}) }
        : { ok: true, snapshot: "page" },
    );
  }

  function secretTypeFrame(requestId: string, runId: string) {
    return [
      "browser",
      { requestId, runId, op: "type", uid: "u9", clear: true, secret: POLICY, secretText: PLAINTEXT },
    ] as [string, unknown];
  }

  it("probes the installed build first, then forwards secret + secretText verbatim", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const send = useVersionedExtension("0.28.0");
    const { calls } = await driveEvents(id, [secretTypeFrame("br-sec-1", "rn-sec1")]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    // Order matters: the version is read BEFORE the plaintext leaves the page.
    expect(send.mock.calls.map((c) => (c[1] as any).op)).toEqual(["getAllowedOrigins", "type"]);
    expect(send.mock.calls[1][1]).toMatchObject({
      op: "type",
      uid: "u9",
      clear: true,
      secret: POLICY,
      secretText: PLAINTEXT,
    });
    // NOT in `text`: that is the field a pre-0.28.0 build would have typed blind.
    expect((send.mock.calls[1][1] as any).text).toBeUndefined();

    // The label says a secret is going in; the value itself reaches nothing else.
    expect(statuses()).toContain("브라우저에 시크릿을 입력하는 중…");
    expect(JSON.stringify(statuses())).not.toContain(PLAINTEXT);
    expect(JSON.stringify({ ...pane(id), abortController: null })).not.toContain(PLAINTEXT);
  });

  it("relays a fill_form's secret field whole and labels the turn as carrying one", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const send = useVersionedExtension("0.31.2");
    const fields = [
      { uid: "u1", value: "kim" },
      { uid: "u2", value: "", secret: POLICY, secretValue: PLAINTEXT },
    ];
    const { calls } = await driveEvents(id, [
      ["browser", { requestId: "br-sec-2", runId: "rn-sec2", op: "fill_form", fields, submit: true }],
    ]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    expect(send.mock.calls.map((c) => (c[1] as any).op)).toEqual(["getAllowedOrigins", "fill_form"]);
    expect(send.mock.calls[1][1]).toMatchObject({ op: "fill_form", fields, submit: true });
    expect(statuses()).toContain("브라우저 폼을 채우는 중(시크릿 포함)…");
    expect(JSON.stringify(statuses())).not.toContain(PLAINTEXT);
  });

  it("refuses on a build older than 0.28.0 and never sends the value", async () => {
    const id = seedPane();
    const send = useVersionedExtension("0.27.0");
    const { calls } = await driveEvents(id, [secretTypeFrame("br-sec-3", "rn-sec3")]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    // The probe is the ONLY message the extension ever saw.
    expect(send.mock.calls.map((c) => (c[1] as any).op)).toEqual(["getAllowedOrigins"]);
    const [posted] = postedTo(calls, "/api/chat/respond");
    expect(posted).toMatchObject({ runId: "rn-sec3", requestId: "br-sec-3" });
    expect(posted.value.ok).toBe(false);
    expect(String(posted.value.message)).toContain("v0.27.0");
    expect(String(posted.value.message)).toContain("0.28.0 or newer");
    expect(String(posted.value.message)).toContain("설정 → 접근/보안 → 브라우저 브릿지");
    expect(JSON.stringify(calls.map((c) => c.init.body ?? null))).not.toContain(PLAINTEXT);
  });

  it("refuses when the installed build reports no version at all", async () => {
    const id = seedPane();
    const send = useVersionedExtension(undefined);
    const { calls } = await driveEvents(id, [secretTypeFrame("br-sec-4", "rn-sec4")]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    expect(send.mock.calls.map((c) => (c[1] as any).op)).toEqual(["getAllowedOrigins"]);
    const [posted] = postedTo(calls, "/api/chat/respond");
    expect(posted.value.ok).toBe(false);
    expect(String(posted.value.message)).toContain("version unknown");
    expect(JSON.stringify(calls.map((c) => c.init.body ?? null))).not.toContain(PLAINTEXT);
  });

  it("keeps the extension's own reason when it is unreachable, and still types nothing", async () => {
    const id = seedPane();
    // No chrome.runtime at all — a version story would be a lie here.
    const { calls } = await driveEvents(id, [secretTypeFrame("br-sec-5", "rn-sec5")]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    const [posted] = postedTo(calls, "/api/chat/respond");
    expect(posted.value.ok).toBe(false);
    expect(String(posted.value.message)).toContain("not reachable");
    expect(JSON.stringify(calls.map((c) => c.init.body ?? null))).not.toContain(PLAINTEXT);
  });

  it("leaves an ordinary op alone: no probe, no new label", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    const send = useExtension({ ok: true });
    const { calls } = await driveEvents(id, [
      ["browser", { requestId: "br-plain-1", runId: "rn-plain", op: "fill_form", fields: [{ uid: "u1", value: "kim" }] }],
    ]);
    await waitFor(() => calls.some((c) => c.url === "/api/chat/respond"));

    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][1] as any).op).toBe("fill_form");
    expect(statuses()).toContain("브라우저 폼을 채우는 중…");
  });
});

/* ------------------------------------------------------------------ */
/* interactive prompts raised by a run                                 */
/* ------------------------------------------------------------------ */

describe("interactive prompts raised by a run", () => {
  it("queues permission and question prompts and notifies the owner", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const queued = trackState((s) => s.promptQueue.map((p) => `${p.kind}:${p.id}`).join(","));
    await driveEvents(id, [
      ["permission", { requestId: "pm-1", runId: "rn-p", toolName: "Bash" }],
      ["permission", { requestId: "pm-1", runId: "rn-p", toolName: "Bash" }],
      ["question", { requestId: "qs-1", runId: "rn-p", payload: { questions: [{ question: "어느 쪽으로 갈까요?" }] } }],
      ["permission", { runId: "rn-p", toolName: "Bash" }],
    ]);
    expect(queued()).toContain("permission:pm-1,question:qs-1");
    // One notification each: the duplicate and the id-less frame raised nothing.
    expect(notes).toEqual([
      { title: "노아 · 확인 필요", body: '"명령 실행" 실행을 승인해 주세요.', tag: "prompt-pm-1" },
      { title: "노아 · 질문", body: "어느 쪽으로 갈까요?", tag: "prompt-qs-1" },
    ]);
    // The queue is dropped with the run so nothing can be answered into a dead run.
    expect(readState().promptQueue).toEqual([]);
  });

  it("a question with no readable text still says what it wants", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    await driveEvents(id, [
      ["question", { requestId: "qs-2", runId: "rn-q", payload: { questions: [{ header: "권한" }] } }],
      ["question", { requestId: "qs-3", runId: "rn-q", payload: {} }],
    ]);
    expect(notes.map((n) => n.body)).toEqual(["권한", "확인이 필요한 질문이 있습니다."]);
  });

  it("prompt_resolved takes a queued prompt down and blocks its replay", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const queued = trackState((s) => s.promptQueue.map((p) => p.id).join(","));
    await driveEvents(id, [
      ["permission", { requestId: "pm-2", runId: "rn-r", toolName: "Bash" }],
      ["prompt_resolved", { requestId: "pm-2" }],
      ["permission", { requestId: "pm-2", runId: "rn-r", toolName: "Bash" }],
    ]);
    expect(queued()).toContain("pm-2");
    expect(queued().at(-1)).toBe("");
    // enqueuePrompt is the only thing that notifies, so one note proves the
    // resolved id was never shown a second time.
    expect(notes).toHaveLength(1);
  });

  it("respondPlanReview re-enables the controls and rethrows when the submit fails", async () => {
    const id = seedPane({ planReview: { requestId: "pr-fail", runId: "rn-f" } });
    useFetch(() => jsonRes({ error: "이미 종료된 실행입니다." }, 500));
    await expect(respondPlanReview(id, "rejected", "다시 세워줘")).rejects.toThrow("이미 종료된 실행입니다.");
    // The review stays put so the owner can retry rather than losing the controls.
    expect(pane(id).planReview).toEqual({ requestId: "pr-fail", runId: "rn-f" });
    expect(pane(id).planReviewSubmitting).toBe(false);
    expect(get(toasts).some((t) => t.message.includes("이미 종료된 실행입니다."))).toBe(true);
  });

  it("respondPlanReview sends a rejection with no feedback at all", async () => {
    const id = seedPane({ planReview: { requestId: "pr-bare", runId: "rn-bare" } });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await respondPlanReview(id, "rejected", "   ");
    expect(posted.value).toEqual({ behavior: "rejected" });
    expect(pane(id).planReview).toBeNull();
  });

  it("a plan_review replayed after it was resolved does not come back", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    // A reconnect's plan_review may carry no plan text (the "plan" frame did).
    await driveEvents(id, [
      ["plan_review", { requestId: "pr-gone" }],
      ["prompt_resolved", { requestId: "pr-gone" }],
      ["plan_review", { requestId: "pr-gone" }],
    ]);
    expect(pane(id).planReview).toBeNull();
    expect(pane(id).livePlan).toBe("");
    expect(notes).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* pane defaults, external avatars                                     */
/* ------------------------------------------------------------------ */

describe("composer defaults on a new pane", () => {
  it("seeds a native pane from the owner's remembered picks", async () => {
    replaceState({
      user: {
        id: "owner",
        roles: [],
        modelDefault: "opus",
        effortDefault: "low",
        mcpToolGroupsDefault: ["git_repo"],
        groupKnowledgeOffDefault: ["g7"],
      } as any,
    });
    useFetch((url) => {
      if (url === "/api/avatars/owner") return jsonRes({ avatar: { id: "owner", alias: "내 아바타", isOwn: true } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startNewChat();
    expect(readState().chatPanes[0]).toMatchObject({
      modelTier: "opus",
      effort: "low",
      mcpToolGroups: ["git_repo"],
      groupKnowledgeOff: ["g7"],
    });
  });

  it("leaves an external pane unseeded and sends only its gateway model", async () => {
    replaceState({
      user: { id: "owner", roles: [], modelDefault: "opus", effortDefault: "low" } as any,
    });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/avatars/ext1")
        return jsonRes({ avatar: { id: "ext1", alias: "게이트웨이", isOwn: false, runtime: "external" } });
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes(doneWith("외부 응답"));
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await startChatWith({ id: "ext1" } as any);
    const id = readState().chatPanes[0].id;
    // A native tier alias must never leak into a slot holding a gateway model id.
    expect(pane(id).modelTier).toBeUndefined();
    expect(pane(id).effort).toBeUndefined();

    updateState((s) => {
      const p = s.chatPanes.find((x) => x.id === id)!;
      p.pendingImages = [STAGED_IMAGE];
    });
    await sendMessage(id, "안녕");

    // External avatars run their own stack behind the gateway: the local-only
    // composer settings and the image upload path stay off it.
    expect(bodies[0]).toMatchObject({ avatarId: "ext1", model: "" });
    expect(bodies[0].effort).toBeUndefined();
    expect(bodies[0].groupKnowledgeOff).toBeUndefined();
    expect(bodies[0].mcpToolGroups).toBeUndefined();
    expect(bodies[0].images).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* activity-tree failure arms + terminal frames                        */
/* ------------------------------------------------------------------ */

describe("activity failures and terminal frames", () => {
  it("names an addressable teammate and marks failed agents, tools and tasks", async () => {
    const id = seedPane();
    const statuses = trackStatus(id);
    await driveEvents(id, [
      ["plugin", { name: "pluginA", status: "started" }],
      // A later chip frame with no status keeps the one it had.
      ["plugin", { name: "pluginA" }],
      // A first chip frame with no status starts as "불러오는 중".
      ["plugin", { name: "pluginB" }],
      ["agent", { agentId: "mate", name: "reviewer", subagentType: "code-review" }],
      // The same agent announced again re-labels its node instead of forking one.
      ["agent", { agentId: "mate", name: "reviewer", subagentType: "code-review", description: "2차" }],
      ["agent", { agentId: "anon", parentId: "mate" }],
      ["agent_end", { agentId: "mate", ok: false }],
      ["tool", { toolUseId: "t1", name: "Bash", agentId: "mate", input: { command: "npm test" } }],
      ["tool_end", { toolUseId: "t1", ok: false, error: "종료 코드 1" }],
      // A tool_end with nothing new to say keeps the detail it started with.
      ["tool", { toolUseId: "t2", name: "Grep", input: { pattern: "TODO" } }],
      ["tool_end", { toolUseId: "t2", ok: true }],
      ["task", { taskId: "k1", workflowName: "배포" }],
      ["task", { taskId: "k2", taskType: "code_review" }],
      ["task_update", { taskId: "k2" }],
      ["task_end", { taskId: "k1", workflowName: "배포", ok: false }],
    ]);
    const p = pane(id);
    expect(p.livePlugins).toEqual([
      { name: "pluginA", status: "started" },
      { name: "pluginB", status: "started" },
    ]);
    expect(p.liveAgents.filter((a) => a.id === "mate")).toHaveLength(1);
    expect(p.liveAgents.find((a) => a.id === "mate")).toMatchObject({
      label: "@reviewer · code-review · 2차",
      status: "failed",
      parentId: "main",
    });
    expect(p.liveAgents.find((a) => a.id === "anon")).toMatchObject({ label: "하위 작업", parentId: "mate" });
    expect(p.liveTools[0]).toMatchObject({ status: "failed", detail: "종료 코드 1" });
    expect(p.liveTools[1]).toMatchObject({ status: "done", detail: "TODO" });
    expect(p.liveTasks.map((t) => t.label)).toEqual(["워크플로 배포", "code review"]);
    expect(p.liveTasks[0].status).toBe("failed");
    expect(statuses()).toContain("태스크가 완료되지 못했습니다.");
    // A task frame with nothing to name it still says something.
    expect(statuses()).toContain("태스크 진행 중");
  });

  it("a cancelled frame outside the background phase stops the turn and keeps what it shared", async () => {
    const id = seedPane();
    const attachment = { id: "f1", kind: "file", mediaType: "text/plain", name: "메모.txt" };
    await driveEvents(id, [
      ["file", { attachment }],
      ["cancelled", {}],
    ]);
    const last = pane(id).messages.at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: "(중지됨)" });
    expect(last.response).toMatchObject({ summary: "중지됨" });
    // A file already handed over stays on the stopped bubble.
    expect(last.attachments).toEqual([{ ...attachment, anchor: 0 }]);
  });

  it("an error frame outside the background phase reports the error", async () => {
    const id = seedPane();
    await driveEvents(id, [["error", { error: "도구 실행이 실패했습니다." }]]);
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "도구 실행이 실패했습니다." });
    expect(get(toasts).some((t) => t.message.includes("도구 실행이 실패했습니다."))).toBe(true);

    const other = seedPane();
    await driveEvents(other, [["error", {}]]);
    expect(pane(other).messages.at(-1)).toMatchObject({ content: "오류가 발생했습니다." });
  });

  it("a done frame with no payload still keeps the streamed answer", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["delta", { text: "스트리밍만 된 답변" }],
      ["done", {}],
    ]);
    expect(pane(id).messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "스트리밍만 된 답변",
      response: null,
    });
    expect(pane(id).liveText).toBe("");
  });

  it("the answer-complete notification is trimmed, and says so when there is no text", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const long = "가".repeat(200);
    await driveEvents(id, [
      ["done", { message: { ...BG_MESSAGE, id: "long-1", content: `  ${long}  ` } }],
      ["done", { message: { ...BG_MESSAGE, id: "empty-1", content: "" } }],
    ]);
    expect(notes[0].body).toBe(`${"가".repeat(140)}…`);
    expect(notes[1].body).toBe("응답이 완료되었습니다.");
  });

  it("a background report notification is trimmed the same way", async () => {
    const id = seedPane();
    const notes = useOsNotifications();
    const long = "나".repeat(200);
    await driveEvents(id, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["bg_message", { message: { ...BG_MESSAGE, id: "wake-long", content: long } }],
      ["bg_message", { message: { ...BG_MESSAGE, id: "wake-empty", content: "" } }],
      // A bg_tasks frame with no task list clears the chips.
      ["bg_tasks", {}],
    ]);
    expect(notes.map((n) => n.body).slice(-2)).toEqual([
      `${"나".repeat(140)}…`,
      "백그라운드 작업이 완료되었습니다.",
    ]);
    expect(pane(id).backgroundTasks).toEqual([]);
  });

  it("notifications name the avatar by alias, then display name, then a generic fallback", async () => {
    const notes = useOsNotifications();
    const named = seedPane({ avatar: { id: "av2", displayName: "노아 봇" } as any });
    const frames: Array<[string, unknown]> = [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["bg_message", { message: { ...BG_MESSAGE, id: "wake-named", content: "보고" } }],
      ["permission", { requestId: `nm-${Date.now()}-1`, toolName: "Bash" }],
      ["plan_review", { requestId: `nm-${Date.now()}-2`, plan: "계획" }],
    ];
    await driveEvents(named, frames);
    expect(notes.map((n) => n.title)).toEqual([
      "노아 봇 · 답변 완료",
      "노아 봇 · 백그라운드 작업 보고",
      "노아 봇 · 확인 필요",
      "노아 봇 · 계획 승인 필요",
    ]);

    const seen = notes.length;
    const anon = seedPane({ avatar: {} as any });
    await driveEvents(anon, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["bg_message", { message: { ...BG_MESSAGE, id: "wake-anon", content: "보고" } }],
      ["permission", { requestId: `nm-${Date.now()}-3`, toolName: "Bash" }],
      ["plan_review", { requestId: `nm-${Date.now()}-4`, plan: "계획" }],
    ]);
    expect(notes.slice(seen).map((n) => n.title)).toEqual([
      "아바타 · 답변 완료",
      "아바타 · 백그라운드 작업 보고",
      "아바타 · 확인 필요",
      "아바타 · 계획 승인 필요",
    ]);
  });

  it("a replayed done{background} frame does not duplicate the finalized bubble", async () => {
    const id = seedPane();
    await driveEvents(id, [
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
      ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
    ]);
    expect(pane(id).messages.filter((m) => m.id === "bg-msg-1")).toHaveLength(1);
    expect(pane(id).backgroundPhase).toBe(true);
  });

  it("a background turn with no usage, no response and no message at all still holds together", async () => {
    const bare = seedPane();
    const { calls } = await driveEvents(bare, [
      ["tool", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }],
      ["done", { background: true, message: { id: "bg-thin", role: "assistant", content: "얇은 답변", response: null } }],
      ["bg_end", {}],
    ]);
    expect(pane(bare).usage).toBeNull();
    // Nothing to graft onto in memory, but the snapshot is still persisted.
    expect(pane(bare).messages.at(-1)!.response).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/messages/bg-thin/activity"))).toBe(true);

    const none = seedPane();
    await driveEvents(none, [["done", { background: true }]]);
    expect(pane(none)).toMatchObject({ backgroundPhase: true, backgroundMessageId: null });
    expect(pane(none).messages).toEqual([]);
  });

  it("keeps working when every best-effort follow-up call fails", async () => {
    const id = seedPane();
    const send = useExtension({ ok: true });
    const failEverythingElse: FetchHandler = () => jsonRes({ error: "저장 실패" }, 500);
    const { calls } = await driveEvents(
      id,
      [
        ["tool", { toolUseId: "t1", name: "Bash", input: { command: "ls" } }],
        ["browser", { requestId: "br-fail-1", runId: "rn-fail", op: "click", uid: "u1" }],
        ["done", { background: true, message: structuredClone(BG_MESSAGE) }],
        ["bg_end", {}],
      ],
      failEverythingElse,
    );
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url === "/api/chat/respond")).toBe(true);
    expect(calls.some((c) => c.url.includes("/activity"))).toBe(true);
    // The sealed tree is on the bubble even though persisting it failed.
    expect((pane(id).messages.at(-1)!.response as any).activity.tools[0]).toMatchObject({
      id: "t1",
      status: "done",
    });

    const plain = seedPane();
    await driveEvents(
      plain,
      [
        ["tool", { toolUseId: "t2", name: "Bash", input: { command: "ls" } }],
        ["done", { message: { ...structuredClone(BG_MESSAGE), id: "done-fail-1" } }],
      ],
      failEverythingElse,
    );
    await flush();
    expect((pane(plain).messages.at(-1)!.response as any).activity.tools[0].status).toBe("done");
    // None of it is the viewer's problem, so none of it is surfaced.
    expect(get(toasts)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* guards: canvas panel, stop/close, clear-history                     */
/* ------------------------------------------------------------------ */

describe("guards around the canvas panel and pane lifecycle", () => {
  it("canvas actions on an unknown canvas do nothing", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any] });
    const fetchFn = noFetch();
    await submitCanvas(id, "missing", { a: 1 });
    await submitCanvasEdit(id, "missing", "내용");
    await dismissCanvas(id, "missing");
    await closeCanvas(id, "missing");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv1"]);
  });

  it("canvas submissions wait while the pane is already streaming", async () => {
    const id = seedPane({ streaming: true, canvases: [{ id: "cv1", pending: false } as any] });
    const fetchFn = noFetch();
    await submitCanvas(id, "cv1", { pick: "A" });
    await submitCanvasEdit(id, "cv1", "고친 내용");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("submitCanvasEdit ignores an empty edit", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any] });
    const fetchFn = noFetch();
    await submitCanvasEdit(id, "cv1", "   ");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("dismissCanvas hides a display-only canvas without answering any run", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true } as any] });
    const fetchFn = noFetch();
    await dismissCanvas(id, "cv1");
    // No requestId/runId: there is no parked run to cancel.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).canvases[0].pending).toBe(false);
  });

  it("closing the active canvas falls back to the tab before it, then to none", async () => {
    const id = seedPane({
      canvases: [{ id: "cv1" } as any, { id: "cv2" } as any],
      activeCanvasId: "cv2",
    });
    useFetch(() => jsonRes({ ok: true }));
    await closeCanvas(id, "cv2");
    expect(pane(id).activeCanvasId).toBe("cv1");
    await closeCanvas(id, "cv1");
    expect(pane(id).canvases).toEqual([]);
    expect(pane(id).activeCanvasId).toBeNull();
  });

  it("closing a parked canvas cancels its run and leaves the active tab alone", async () => {
    const id = seedPane({
      canvases: [{ id: "cv1", pending: true, requestId: "rq-c", runId: "rn-c" } as any, { id: "cv2" } as any],
      activeCanvasId: "cv2",
    });
    const posted: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/respond") posted.push(body(init));
      return jsonRes({ ok: true });
    });
    await closeCanvas(id, "cv1");
    // Closing the tab must release the run, not leave it parked on awaitResponse.
    expect(posted).toEqual([
      { runId: "rn-c", requestId: "rq-c", value: { cancelled: true, deleteCanvas: true } },
    ]);
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv2"]);
    expect(pane(id).activeCanvasId).toBe("cv2");
  });

  it("closePane leaves nothing behind when there is no avatar to reopen with", () => {
    const id = seedPane();
    updateState((s) => {
      s.currentAvatar = null;
    });
    closePane(id);
    expect(readState().chatPanes).toEqual([]);
    expect(readState().activePaneId).toBeNull();
  });

  it("a canvas shown with no live run leaves its ids unset and versions the reloaded copy", async () => {
    // Rebuilt from the server on reload, so it carries no version fields yet.
    const id = seedPane({ canvases: [{ id: "cv1", title: "이전" } as any] });
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["canvas", { artifactId: "cv1", title: "새로 표시", content: "본문" }],
          ...doneWith("표시했습니다"),
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "캔버스 보여줘");
    expect(pane(id).canvases[0]).toMatchObject({
      title: "새로 표시",
      content: "본문",
      currentVersion: 2,
      versionCount: 2,
      runId: undefined,
      requestId: undefined,
    });
  });

  it("the version panel tolerates a response with no versions, and an unknown rollback target", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any] });
    useFetch((url) =>
      url.includes("/versions") ? jsonRes({}) : jsonRes({ canvas: { id: "cv1", title: "되돌림" } }),
    );
    expect(await fetchCanvasVersions("cv1")).toEqual([]);
    await rollbackCanvas(id, "unknown-canvas", 2);
    expect(pane(id).canvases).toEqual([{ id: "cv1" }]);
  });

  it("dismissCanvas hides the form even when the cancel POST fails", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true, requestId: "rq-x", runId: "rn-x" } as any] });
    useFetch(() => jsonRes({ error: "이미 종료된 실행입니다." }, 500));
    await dismissCanvas(id, "cv1");
    // The run may simply have ended already; the form must still close.
    expect(pane(id).canvases[0].pending).toBe(false);
    expect(get(toasts)).toEqual([]);
  });

  it("stopPane still stops the local stream when the cancel call fails", async () => {
    const controller = new AbortController();
    const id = seedPane({ liveRunId: "run-x", abortController: controller, streaming: true });
    useFetch(() => jsonRes({ error: "이미 종료된 실행입니다." }, 500));
    await stopPane(id);
    await flush();
    expect(controller.signal.aborted).toBe(true);
    // The server-side cancel failing must not keep the turn hanging: the
    // stopped bubble still lands and the pane is idle.
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "(중지됨)" });
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "" });
    expect(get(toasts)).toEqual([]);
  });

  it("stopPane is a no-op for an unknown pane and needs no run id to abort", async () => {
    const fetchFn = noFetch();
    await stopPane("nope");
    expect(fetchFn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const id = seedPane({ streaming: true, abortController: controller, liveRunId: null });
    await stopPane(id);
    // Nothing to cancel server-side yet, but the local stream still stops and
    // the turn still ends in a stopped bubble.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "(중지됨)" });
    expect(pane(id)).toMatchObject({ streaming: false, liveStatus: "" });
  });

  it("closePane stops a streaming pane on its way out", async () => {
    const controller = new AbortController();
    const a = seedPane();
    const b = seedPane({ streaming: true, liveRunId: "run9", abortController: controller });
    const fetchFn = useFetch(() => jsonRes({ ok: true }));
    closePane(b);
    expect(readState().chatPanes.map((p) => p.id)).toEqual([a]);
    expect(controller.signal.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat/runs/run9/cancel"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clearChatHistory aborts the cleared pane's run and leaves the others alone", async () => {
    const controller = new AbortController();
    const cleared = seedPane({ conversationId: "c1", streaming: true, abortController: controller });
    const kept = seedPane({ conversationId: "c2", messages: [{ id: "m" } as any] });
    replaceState({ conversations: [{ id: "c1" } as any, { id: "c2" } as any] });
    // No `deleted` count in the response: the id list is the fallback.
    useFetch(() => jsonRes({ conversationIds: ["c1"] }));

    expect(await clearChatHistory()).toBe(1);

    expect(controller.signal.aborted).toBe(true);
    expect(readState().chatPanes[0].id).not.toBe(cleared);
    expect(readState().chatPanes[1].id).toBe(kept);
    expect(readState().chatPanes[1].messages).toHaveLength(1);
    // The focused pane survived, so focus does not move.
    expect(readState().activePaneId).toBe(kept);

    // A response that names no conversations at all clears nothing.
    useFetch(() => jsonRes({}));
    expect(await clearChatHistory()).toBe(0);
    expect(readState().chatPanes[1].id).toBe(kept);
  });

  it("regenerate is a no-op while the pane is still streaming", () => {
    const id = seedPane({
      streaming: true,
      messages: [{ id: "u", role: "user", content: "질문" } as any],
    });
    const fetchFn = noFetch();
    regenerate(id);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).messages).toHaveLength(1);
  });
});
