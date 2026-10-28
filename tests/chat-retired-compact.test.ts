import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig, SdkResumePoint } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

/**
 * The manual `/compact` is retired: typed, it is refused like `/new`; an older
 * thread's `/compact` row still loads, refuses 다시 생성 (it no longer expands)
 * and can be EDITED into an ordinary message. The agent layer is mocked so a
 * test can read back whether any run was started at all.
 */
const H = vi.hoisted(() => ({ requests: [] as AgentRequest[] }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      _pluginRoots: unknown,
      config: AppConfig,
      _store: unknown,
      events: AgentEvents,
    ) => {
      H.requests.push(agentRequest);
      const n = H.requests.length;
      events.onSessionId?.(`sess-run-${n}`);
      events.onResumePoint?.({ sessionId: `sess-run-${n}`, uuid: `uuid-run-${n}` });
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

const RETIRED = "/compact는 더 이상 지원하지 않습니다. 대화가 길어지면 맥락은 자동으로 정리됩니다.";

let tempDir: string;
const getTempDir = withTempDir("retired-compact", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
});

async function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "claude", sessionSecret: "test" });
  const app = createApp(services);
  const agent = request.agent(app);
  const res = await signup(agent, "owner").expect(201);
  return { store: services.store, agent, ownerId: res.body.user.id as string };
}

/** An older thread whose latest turn was a native /compact (pre-retirement shape). */
function seedLegacyThread(store: Awaited<ReturnType<typeof boot>>["store"], ownerId: string, conversationId: string) {
  store.touchConversation(ownerId, conversationId, ownerId, "첫 질문");
  store.addMessage(conversationId, { role: "user", content: "첫 질문" });
  const point: SdkResumePoint = { sessionId: "sess-a", uuid: "uuid-a1" };
  store.addMessage(conversationId, { role: "assistant", content: "첫 답", resumePoint: point });
  const compactRow = store.addMessage(conversationId, { role: "user", content: "/compact 결정 위주로" });
  store.addMessage(conversationId, {
    role: "assistant",
    content: "대화 맥락을 요약해 정리했습니다 (약 18.0K → 1.4K 토큰). 이후 대화는 요약본을 바탕으로 이어집니다.",
    resumePoint: { sessionId: "sess-fork", uuid: "stdout-uuid" },
  });
  store.setAgentSessionId(ownerId, conversationId, "sess-fork");
  return { compactRow };
}

describe("retired /compact", () => {
  it("no longer expands: it is a Korean refusal, like /new", () => {
    for (const text of ["/compact", "  /compact 결정 사항 위주로  ", "/COMPACT"]) {
      expect(expandChatSlashCommand(text)).toEqual({ message: text, error: RETIRED });
    }
    // Only the command itself — not a word that starts with it.
    expect(expandChatSlashCommand("/compacting 이 뭐야").error).toBeUndefined();
  });

  it("refuses a typed /compact before any write or run", async () => {
    const { store, agent, ownerId } = await boot();
    seedLegacyThread(store, ownerId, "c1");
    const res = await agent
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "c1", message: "/compact 결정 위주로" })
      .expect(400);
    expect(res.body.error).toBe(RETIRED);
    expect(H.requests).toHaveLength(0);
    expect(store.listMessages(ownerId, "c1")).toHaveLength(4);
  });

  it("keeps a legacy /compact row readable and refuses to regenerate it", async () => {
    const { store, agent, ownerId } = await boot();
    seedLegacyThread(store, ownerId, "c2");
    const listed = await agent.get("/api/messages").query({ conversationId: "c2" }).expect(200);
    expect((listed.body.messages as Array<{ content: string }>).map((m) => m.content)).toContain(
      "/compact 결정 위주로",
    );
    const regen = await agent
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "c2", message: "/compact 결정 위주로", regenerate: true })
      .expect(400);
    expect(regen.body.error).toBe(RETIRED);
    expect(H.requests).toHaveLength(0);
    expect(store.listMessages(ownerId, "c2").map((m) => m.content)).toEqual([
      "첫 질문",
      "첫 답",
      "/compact 결정 위주로",
      expect.stringContaining("대화 맥락을 요약해 정리했습니다"),
    ]);
  });

  it("lets an edit turn a legacy /compact row into an ordinary message", async () => {
    const { store, agent, ownerId } = await boot();
    const { compactRow } = seedLegacyThread(store, ownerId, "c3");
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "c3", message: "다른 질문", rewindFromMessageId: compactRow.id })
      .expect(200);
    const sent = H.requests.at(-1)!;
    expect(sent.message).toBe("다른 질문");
    // The kept history ends at the previous answer, in its own session.
    expect(sent.resumeSessionId).toBe("sess-a");
    expect(sent.resumeSessionAt).toBe("uuid-a1");
    expect(store.listMessages(ownerId, "c3").map((m) => m.content)).toEqual([
      "첫 질문",
      "첫 답",
      "다른 질문",
      "[mock] 다른 질문",
    ]);
  });

  it("treats a mid-turn /compact like any other steer (no special refusal)", async () => {
    const { agent } = await boot();
    // No such run: the ordinary not-found answer, not a /compact-specific 400.
    await agent.post("/api/chat/runs/any-run/message").send({ message: "/compact" }).expect(404);
  });
});
