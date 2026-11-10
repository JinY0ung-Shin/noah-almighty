import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import type { AgentEvents, CompactEvent } from "../src/server/agent/events.js";
import { parseSse, signup, withTempDir } from "./helpers.js";

/**
 * `/compact [what to keep]`: a typed chat message that runs NO model turn — the
 * run asks pi-gateway to summarize the conversation's session and the route
 * composes the bubble. The agent layer is mocked: a compact request answers
 * with the scripted outcome (`H.compact`), every other request like a turn.
 */
type CompactScript = { kind: "event"; event: CompactEvent; next?: string } | { kind: "throw" } | { kind: "hang" };
const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  compact: { kind: "throw" } as CompactScript,
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      _pluginRoots: unknown,
      config: AppConfig,
      _store: unknown,
      events: AgentEvents,
      abortController?: AbortController,
    ) => {
      H.requests.push(agentRequest);
      if (agentRequest.compact) {
        const script = H.compact;
        if (script.kind === "throw") throw new Error("pi exploded");
        if (script.kind === "hang") {
          events.onStatus?.("맥락 정리 중…");
          // Runs until the user's stop aborts it (what the pi client does).
          return new Promise<never>((_resolve, reject) => {
            abortController?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        events.onStatus?.("맥락 정리 중…");
        if (script.next) {
          events.onSessionId?.(script.next);
          events.onResumePoint?.({ sessionId: script.next, uuid: script.next });
        }
        events.onCompact?.(script.event);
        return {
          kind: "text",
          runtime: config.agentRuntime,
          summary: "맥락 정리",
          text: "",
          ...(script.event.postTokens ? { usage: { inputTokens: script.event.postTokens, outputTokens: 0, contextWindow: 200_000 } } : {}),
        } satisfies AgentResponse;
      }
      const n = H.requests.length;
      events.onSessionId?.(`resp_s_9${n}`);
      events.onResumePoint?.({ sessionId: `resp_s_9${n}`, uuid: `resp_s_9${n}` });
      events.onDelta?.(`[mock] ${agentRequest.message}`);
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: `[mock] ${agentRequest.message}`,
      } satisfies AgentResponse;
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices, expandChatSlashCommand } from "../src/server/app.js";
import { compactResultText } from "../src/server/routes/chat.js";
import { getActiveRunForConversation } from "../src/server/agent/runRegistry.js";

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
).toString("base64")}`;

const OK: CompactScript = {
  kind: "event",
  event: { ok: true, trigger: "manual", preTokens: 28_200, postTokens: 1_900 },
  next: "resp_s_4",
};
const refusedBy = (reason: NonNullable<CompactEvent["reason"]>): CompactScript => ({
  kind: "event",
  event: { ok: false, trigger: "manual", reason },
});

let tempDir: string;
const getTempDir = withTempDir("chat-compact", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
  H.compact = { kind: "throw" };
});

async function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "pi", pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false }, sessionSecret: "test" });
  const app = createApp(services);
  const agent = request.agent(app);
  const res = await signup(agent, "owner").expect(201);
  return { app, store: services.store, agent, ownerId: res.body.user.id as string };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** A thread with one answered turn whose pi session sits at `resp_s_3`. */
function seedThread(store: Booted["store"], userId: string, conversationId: string, avatarId = userId) {
  store.touchConversation(userId, conversationId, avatarId, "첫 질문");
  store.addMessage(conversationId, { role: "user", content: "첫 질문" });
  store.addMessage(conversationId, { role: "assistant", content: "첫 답", resumePoint: { sessionId: "resp_s_3", uuid: "resp_s_3" } });
  store.setAgentSessionId(userId, conversationId, "resp_s_3");
}

const send = (agent: Booted["agent"], avatarId: string, conversationId: string, message: string, extra: Record<string, unknown> = {}) =>
  agent.post("/api/chat/stream").send({ avatarId, conversationId, message, ...extra });
const frames = (res: { text: string }, event: string) => parseSse(res.text).filter((f) => f.event === event).map((f) => f.data as any);
const contents = (store: Booted["store"], userId: string, conversationId: string) =>
  store.listMessages(userId, conversationId).map((m) => m.content);

describe("/compact", () => {
  it("expands to a compaction, not a prompt", () => {
    expect(expandChatSlashCommand("/compact")).toEqual({ message: "/compact", compact: { instructions: "" } });
    expect(expandChatSlashCommand("  /compact 결정 사항 위주로  ")).toEqual({
      message: "  /compact 결정 사항 위주로  ",
      compact: { instructions: "결정 사항 위주로" },
    });
    expect(expandChatSlashCommand("/COMPACT").compact).toEqual({ instructions: "" });
    // Only the command itself — not a word that starts with it.
    expect(expandChatSlashCommand("/compacting 이 뭐야").compact).toBeUndefined();
  });

  it("summarizes the session: the bubble says how far it shrank and the conversation moves onto the summary", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c1");
    H.compact = OK;
    const res = await send(agent, ownerId, "c1", "/compact 결정 위주로").expect(200);

    expect(H.requests).toHaveLength(1);
    expect(H.requests[0]).toMatchObject({ compact: { instructions: "결정 위주로" }, resumeSessionId: "resp_s_3" });
    expect(H.requests[0]!.resumeSessionAt).toBeUndefined();
    const text = "대화 맥락을 요약해 정리했습니다 (약 28.2K → 1.9K 토큰). 이후 대화는 요약본과 최근 대화를 바탕으로 이어집니다.";
    expect(contents(store, ownerId, "c1")).toEqual(["첫 질문", "첫 답", "/compact 결정 위주로", text]);
    expect(frames(res, "compact")).toEqual([{ id: expect.any(String), ok: true, trigger: "manual", preTokens: 28_200, postTokens: 1_900 }]);
    const done = frames(res, "done")[0];
    expect(done.message.content).toBe(text);
    // The context badge reads the summarized size.
    expect(done.response.usage).toMatchObject({ inputTokens: 1_900, contextWindow: 200_000 });
    expect(store.getAgentSessionId(ownerId, "c1")).toBe("resp_s_4");

    // The next turn continues the summary…
    await send(agent, ownerId, "c1", "다음 질문").expect(200);
    expect(H.requests.at(-1)).toMatchObject({ message: "다음 질문", resumeSessionId: "resp_s_4" });
    expect(H.requests.at(-1)!.compact).toBeUndefined();
    // …and editing that message branches from the summary too.
    const next = store.listMessages(ownerId, "c1").find((m) => m.content === "다음 질문")!;
    await send(agent, ownerId, "c1", "고친 질문", { rewindFromMessageId: next.id }).expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_4", resumeSessionAt: "resp_s_4" });
  });

  it("a rewind onto the /compact row continues from the UNSUMMARIZED history", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c2");
    H.compact = OK;
    await send(agent, ownerId, "c2", "/compact").expect(200);
    const compactRow = store.listMessages(ownerId, "c2").find((m) => m.content === "/compact")!;
    await send(agent, ownerId, "c2", "다른 질문", { rewindFromMessageId: compactRow.id }).expect(200);
    expect(H.requests.at(-1)).toMatchObject({ message: "다른 질문", resumeSessionId: "resp_s_3", resumeSessionAt: "resp_s_3" });
    expect(contents(store, ownerId, "c2")).toEqual(["첫 질문", "첫 답", "다른 질문", "[mock] 다른 질문"]);
  });

  it("works in a colleague's avatar chat as well (the viewer's own conversation)", async () => {
    const { app, store, ownerId } = await boot();
    const mate = request.agent(app);
    const mateId = (await signup(mate, "mate").expect(201)).body.user.id as string;
    seedThread(store, mateId, "c-mate", ownerId);
    H.compact = OK;
    await send(mate, ownerId, "c-mate", "/compact").expect(200);
    expect(H.requests[0]).toMatchObject({ compact: { instructions: "" }, viewerUserId: mateId, viewerIsOwner: false });
    expect(store.getAgentSessionId(mateId, "c-mate")).toBe("resp_s_4");
  });

  it("nothing to summarize yet: a plain note, no activity row, and the session stays where it was", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c3");
    H.compact = refusedBy("nothing");
    const res = await send(agent, ownerId, "c3", "/compact").expect(200);
    expect(frames(res, "compact")).toEqual([]);
    expect(frames(res, "done")[0].message.content).toBe(compactResultText({ ok: false, trigger: "manual", reason: "nothing" }));
    expect(contents(store, ownerId, "c3").at(-1)).toContain("맥락을 정리하지 않았습니다");
    expect(store.getAgentSessionId(ownerId, "c3")).toBe("resp_s_3");

    // The untouched session is what the next turn continues and what an edit branches from.
    await send(agent, ownerId, "c3", "다음 질문").expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_3" });
    const next = store.listMessages(ownerId, "c3").find((m) => m.content === "다음 질문")!;
    await send(agent, ownerId, "c3", "고친 질문", { rewindFromMessageId: next.id }).expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_3", resumeSessionAt: "resp_s_3" });
  });

  it("a failed compaction says so in Korean, leaves a failed row and keeps the session", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c4");
    for (const reason of ["lost", "busy", "failed"] as const) {
      H.compact = refusedBy(reason);
      const res = await send(agent, ownerId, "c4", "/compact").expect(200);
      expect(frames(res, "compact")).toEqual([{ id: expect.any(String), ok: false, trigger: "manual", reason }]);
      expect(frames(res, "done")[0].message.content).toBe(compactResultText({ ok: false, trigger: "manual", reason }));
      expect(store.getAgentSessionId(ownerId, "c4")).toBe("resp_s_3");
    }
    // A run that threw: the error bubble is the same Korean failure, never the raw detail.
    H.compact = { kind: "throw" };
    const res = await send(agent, ownerId, "c4", "/compact").expect(200);
    expect(frames(res, "error")).toEqual([{ error: "맥락 정리에 실패했습니다. 잠시 후 다시 시도해 주세요." }]);
    expect(contents(store, ownerId, "c4").at(-1)).toBe("맥락 정리에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    expect(store.getAgentSessionId(ownerId, "c4")).toBe("resp_s_3");

    // Every one of those rows carries the point its /compact row sat on, so an
    // edit of the next message still branches from the untouched session.
    await send(agent, ownerId, "c4", "다음 질문").expect(200);
    const next = store.listMessages(ownerId, "c4").find((m) => m.content === "다음 질문")!;
    await send(agent, ownerId, "c4", "고친 질문", { rewindFromMessageId: next.id }).expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_3", resumeSessionAt: "resp_s_3" });
  });

  it("a stopped /compact keeps the session and is not a stopped ANSWER", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c8");
    H.compact = { kind: "hang" };
    const pending = send(agent, ownerId, "c8", "/compact").then((res) => res);
    await vi.waitFor(() => expect(getActiveRunForConversation(ownerId, "c8")).not.toBeNull());
    const runId = getActiveRunForConversation(ownerId, "c8")!.runId;
    // No steer channel: a message cannot be folded into a compaction.
    await agent.post(`/api/chat/runs/${runId}/message`).send({ message: "하나 더" }).expect(409);
    await agent.post(`/api/chat/runs/${runId}/cancel`).expect(200);
    const res = await pending;
    expect(frames(res, "cancelled")).toHaveLength(1);
    expect(contents(store, ownerId, "c8")).toEqual(["첫 질문", "첫 답", "/compact", "(중지됨)"]);
    expect(store.getAgentSessionId(ownerId, "c8")).toBe("resp_s_3");

    // The next turn continues the untouched session and restates no "stopped answer"…
    await send(agent, ownerId, "c8", "다음 질문").expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_3" });
    expect(H.requests.at(-1)!.stoppedAnswer).toBeUndefined();
    // …and an edit of it branches from the point the /compact row sat on.
    const next = store.listMessages(ownerId, "c8").find((m) => m.content === "다음 질문")!;
    await send(agent, ownerId, "c8", "고친 질문", { rewindFromMessageId: next.id }).expect(200);
    expect(H.requests.at(-1)).toMatchObject({ resumeSessionId: "resp_s_3", resumeSessionAt: "resp_s_3" });
  });

  it("a /compact after a stopped answer does not hide that answer from the next turn", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c9");
    store.addMessage("c9", { role: "user", content: "긴 질문" });
    store.addMessage("c9", {
      role: "assistant",
      content: "부분 답변",
      response: { kind: "text", runtime: "pi", summary: "중지됨", text: "부분 답변" },
    });
    H.compact = refusedBy("nothing");
    await send(agent, ownerId, "c9", "/compact").expect(200);
    await send(agent, ownerId, "c9", "이어서").expect(200);
    expect(H.requests.at(-1)).toMatchObject({ message: "이어서", stoppedAnswer: "부분 답변" });
  });

  it("is refused before any write or run when there is nothing it could summarize", async () => {
    const { store, agent, ownerId } = await boot();
    H.compact = OK;
    // A conversation with no messages at all.
    const fresh = await send(agent, ownerId, "c5", "/compact").expect(400);
    expect(fresh.body.error).toBe("아직 정리할 대화 맥락이 없습니다.");
    // Messages, but no pi session (its last turn failed, or it predates pi).
    seedThread(store, ownerId, "c6");
    for (const session of [null, "0b5e7a4c-sdk-session"]) {
      store.setAgentSessionId(ownerId, "c6", session);
      const res = await send(agent, ownerId, "c6", "/compact").expect(400);
      expect(res.body.error).toBe("지금은 정리할 대화 맥락이 없습니다. 메시지를 하나 보낸 뒤 다시 시도해 주세요.");
    }
    expect(H.requests).toHaveLength(0);
    expect(contents(store, ownerId, "c6")).toEqual(["첫 질문", "첫 답"]);
  });

  it("takes no image, is never an edit's new text, and is never regenerated", async () => {
    const { store, agent, ownerId } = await boot();
    seedThread(store, ownerId, "c7");
    H.compact = OK;
    const image = await send(agent, ownerId, "c7", "/compact", { images: [PNG_DATA_URL] }).expect(400);
    expect(image.body.error).toBe("/compact에는 이미지를 첨부할 수 없습니다.");
    const first = store.listMessages(ownerId, "c7")[0]!;
    const edit = await send(agent, ownerId, "c7", "/compact", { rewindFromMessageId: first.id }).expect(400);
    expect(edit.body.error).toBe("/compact는 수정해서 보낼 수 없습니다. 새 메시지로 보내 주세요.");
    expect(H.requests).toHaveLength(0);

    await send(agent, ownerId, "c7", "/compact 결정 위주로").expect(200);
    const regen = await send(agent, ownerId, "c7", "/compact 결정 위주로", { regenerate: true }).expect(400);
    expect(regen.body.error).toBe("/compact는 다시 생성할 수 없습니다.");
    expect(H.requests).toHaveLength(1);
    expect(contents(store, ownerId, "c7")).toHaveLength(4);
  });

  it("is refused as a mid-turn message", async () => {
    const { agent } = await boot();
    const res = await agent.post("/api/chat/runs/any-run/message").send({ message: "/compact 결정 위주로" }).expect(400);
    expect(res.body.error).toBe("/compact는 응답이 끝난 뒤에 보내 주세요.");
    // Any other slash-leading steer keeps the ordinary answer.
    await agent.post("/api/chat/runs/any-run/message").send({ message: "/summarize" }).expect(404);
  });
});

describe("compactResultText", () => {
  it("shows the figures only when both are known and the context actually shrank", () => {
    expect(compactResultText({ ok: true, trigger: "manual", preTokens: 900, postTokens: 400 })).toContain("(약 900 → 400 토큰)");
    expect(compactResultText({ ok: true, trigger: "manual", preTokens: 900 })).not.toContain("토큰)");
    expect(compactResultText({ ok: true, trigger: "manual", preTokens: 900, postTokens: 1_200 })).not.toContain("토큰)");
    expect(compactResultText(null)).toBe("맥락 정리에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  });
});
