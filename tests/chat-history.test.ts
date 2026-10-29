import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse } from "../src/server/types.js";
import { signup, withTempDir } from "./helpers.js";

const capturedRequests = vi.hoisted(() => [] as AgentRequest[]);

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(async (agentRequest: AgentRequest, _pluginRoots, config, _store, events) => {
    capturedRequests.push(agentRequest);
    events.onSessionId?.(`mock-session-${capturedRequests.length}`);
    events.onDelta?.(`[mock] ${agentRequest.message}`);
    return {
      kind: "text",
      runtime: config.agentRuntime,
      summary: "mock",
      text: `[mock] ${agentRequest.message}`,
    } satisfies AgentResponse;
  }),
}));

import { createApp, createServices } from "../src/server/app.js";

let tempDir: string;
const getTempDir = withTempDir("history", () => {
  tempDir = getTempDir();
  capturedRequests.length = 0;
});

describe("chat history fallback", () => {
  it("passes stored messages when no pi session exists after a stopped first turn", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "owner").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-stopped-first";

    services.store.touchConversation(ownerId, conversationId, ownerId, "첫 요청: 일정 정리");
    services.store.addMessage(conversationId, { role: "user", content: "첫 요청: 일정 정리" });
    services.store.addMessage(conversationId, {
      role: "assistant",
      content: "(중지됨)",
      response: { kind: "text", runtime: "pi", summary: "중지됨", text: "" },
    });

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId, message: "계속해" })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].resumeSessionId).toBeUndefined();
    expect(capturedRequests[0].conversationHistory).toEqual([
      { role: "user", content: "첫 요청: 일정 정리" },
    ]);
  });

  it("continues the stored pi session while still carrying history as a self-heal fallback", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "resumer").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-has-session";

    services.store.touchConversation(ownerId, conversationId, ownerId, "첫 요청");
    services.store.addMessage(conversationId, { role: "user", content: "첫 요청" });
    services.store.setAgentSessionId(ownerId, conversationId, "sess-existing");

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId, message: "이어서" })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].resumeSessionId).toBe("sess-existing");
    // History rides along even on a continued turn: buildUserPrompt does NOT
    // inject it while continuing (guarded on resumeSessionId), but runPiAgent
    // needs it to self-heal a lost pi session by starting a new one.
    expect(capturedRequests[0].conversationHistory).toEqual([{ role: "user", content: "첫 요청" }]);
  });

  it("persists and reuses the conversation MCP tool-group selection", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "tool-picker").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-mcp-tools";

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId,
        message: "Confluence만 써줘",
        mcpToolGroups: ["confluence"],
      })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].mcpToolGroups).toEqual(["confluence", "system"]);

    const saved = await owner.get(`/api/messages?conversationId=${conversationId}`).expect(200);
    expect(saved.body.selectedMcpToolGroups).toEqual(["confluence"]);

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId, message: "이어서" })
      .expect(200);

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[1].mcpToolGroups).toEqual(["confluence", "system"]);
  });
});

describe("chat image attachments", () => {
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const PNG_URL = `data:image/png;base64,${PNG_B64}`;

  it("stores an attachment, feeds the model image blocks, and serves it owner-scoped", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "shutterbug").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-with-image";

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId,
        message: "이 이미지 봐줘",
        images: [{ id: "shot-1", name: "shot.png", data: PNG_URL }],
      })
      .expect(200);

    // The model received the image as a structured block this turn.
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);

    // The user message persisted with the attachment metadata.
    const msgsRes = await owner.get(`/api/messages?conversationId=${conversationId}`).expect(200);
    const userMsg = (msgsRes.body.messages as { role: string; attachments?: unknown[] }[]).find((m) => m.role === "user");
    expect(userMsg?.attachments).toEqual([{ id: "shot-1", kind: "image", mediaType: "image/png", name: "shot.png" }]);

    // The serving endpoint returns the image to the owner…
    const imgRes = await owner.get(`/api/conversations/${conversationId}/images/shot-1`).expect(200);
    expect(imgRes.headers["content-type"]).toContain("image/png");
    expect(imgRes.body.length).toBeGreaterThan(0);

    // …but not to a different user.
    const stranger = request.agent(app);
    await signup(stranger, "stranger").expect(201);
    await stranger.get(`/api/conversations/${conversationId}/images/shot-1`).expect(404);
  });

  it("continues the stored session on an image turn, carrying the images and the text history", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "visual-followup").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-image-followup";

    services.store.touchConversation(ownerId, conversationId, ownerId, "이전 요청");
    services.store.addMessage(conversationId, { role: "user", content: "이전 요청" });
    services.store.addMessage(conversationId, {
      role: "assistant",
      content: "이전 답변",
      response: { kind: "text", runtime: "pi", summary: "", text: "이전 답변" },
    });
    services.store.setAgentSessionId(ownerId, conversationId, "sess-existing-image");

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId,
        message: "이번 이미지를 봐줘",
        images: [{ id: "followup-shot", data: PNG_URL }],
      })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    // pi continues the session on an image turn too (the removed SDK runner
    // had to restart from text history); the history still rides along as the
    // runner's self-heal fallback.
    expect(capturedRequests[0].resumeSessionId).toBe("sess-existing-image");
    expect(capturedRequests[0].conversationHistory).toEqual([
      { role: "user", content: "이전 요청" },
      { role: "assistant", content: "이전 답변" },
    ]);
    expect(capturedRequests[0].images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
  });

  it("rejects an unsafe supplied conversation id before image persistence", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "pathcheck").expect(201);
    const ownerId = ownerRes.body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId: "../../outside",
        message: "hi",
        images: [{ id: "shot-1", data: PNG_URL }],
      })
      .expect(400);

    expect(capturedRequests).toHaveLength(0);
  });

  it("rejects an oversized image before streaming", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "bigpic").expect(201);
    const ownerId = ownerRes.body.user.id as string;

    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-big", message: "hi", images: [`data:image/png;base64,${big}`] })
      .expect(400);
    expect(capturedRequests).toHaveLength(0);
  });
});
