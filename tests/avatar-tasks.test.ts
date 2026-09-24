import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

const H = vi.hoisted(() => ({ requests: [] as AgentRequest[], script: [] as ((events: AgentEvents, abort?: AbortController) => Promise<void> | void)[] }));
vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(async (req: AgentRequest, _roots: unknown, config: AppConfig, _store: unknown, events: AgentEvents, abort?: AbortController) => {
    H.requests.push(req);
    await H.script.shift()?.(events, abort);
    if (abort?.signal.aborted) throw new Error("aborted");
    events.onDelta?.("작업 결과");
    return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "작업 결과" };
  }),
  isRetryableModelError: vi.fn(() => false),
}));
import { createApp, createServices } from "../src/server/app.js";
import { __avatarTaskRetryStateForTests, dispatchAvatarTasks, startAvatarTaskDispatcher } from "../src/server/avatarTaskRunner.js";
import { cancelAllRuns, openRun, closeRun, awaitResponse, emitRunEvent, getActiveRunForConversation, getRunPrompts } from "../src/server/agent/runRegistry.js";
import { Store } from "../src/server/store.js";
import { BACKGROUND_TURN_PLACEHOLDER } from "../src/server/routes/chat.js";
import { AVATAR_TASK_RESTART_ERROR } from "../src/server/store.js";
import { readSystemManual } from "../src/server/agent/systemManual.js";

const dir = withTempDir("avatar-tasks");
let current: ReturnType<typeof createServices> | undefined;
afterEach(async () => {
  cancelAllRuns();
  await new Promise(resolve => setTimeout(resolve, 20));
  current?.store.close();
  current = undefined;
});
async function boot() {
  H.requests = []; H.script = [];
  const services = createServices({ dataDir: path.join(dir(), "data"), agentRuntime: "local", sessionSecret: "test", avatarTaskRunTimeoutMs: 1000 });
  current = services;
  const app = createApp(services);
  const owner = request.agent(app);
  const user = (await signup(owner, "owner").expect(201)).body.user;
  const created = (await owner.post("/api/me/avatar-api-keys").send({ name: "monitor" }).expect(201)).body;
  const call = (method: "get" | "post", url: string) => request(app)[method](url).set("Authorization", `Bearer ${created.token}`);
  return { services, app, owner, user, created, call };
}
const endpoint = "/api/v1/avatar/tasks";

describe("avatar task API", () => {
  it("executes the manual's submit, poll, respond and cancel examples against the API", async () => {
    const { call, services, user } = await boot();
    const guide = readSystemManual("external-tasks").text;
    const examples = [...guide.matchAll(/~~~bash\n([\s\S]*?)\n~~~/g)].map(match => match[1]);
    expect(examples).toHaveLength(4);
    // Parse only the documented curl subset; never execute documentation as
    // shell code. Requests use the real router, queue and response registry.
    function example(index: number, taskId = "") {
      const command = examples[index];
      expect(command).toContain('-H "Authorization: Bearer $NOAH_API_KEY"');
      const url = /"\$NOAH_URL([^"]+)"/.exec(command)![1].replace("$TASK_ID", taskId);
      const json = /-d '([^']+)'/.exec(command)?.[1];
      const body = json ? JSON.parse(json) : undefined;
      const method = body || command.includes("-X POST") ? "post" : "get";
      const req = call(method, url);
      const idempotency = /'Idempotency-Key: ([^']+)'/.exec(command)?.[1];
      if (idempotency) req.set("Idempotency-Key", idempotency);
      return { req, body };
    }
    let answer: unknown;
    H.script.push(async events => {
      answer = await events.onQuestion?.({ dialogKind: "question", payload: { question: "어느 서비스인가요?" } });
    });
    const submit = example(0);
    const task = (await submit.req.send(submit.body).expect(202)).body.task;
    const replay = example(0);
    expect((await replay.req.send(replay.body).expect(200)).body.task.id).toBe(task.id);
    dispatchAvatarTasks(services);
    let pending: any;
    await vi.waitFor(async () => {
      pending = (await example(1, task.id).req.expect(200)).body.task;
      expect(pending.status).toBe("waiting_input");
    });
    const respond = example(2, task.id);
    respond.body.requestId = pending.pendingRequests[0].data.requestId;
    await respond.req.send(respond.body).expect(200);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    expect(answer).toEqual({ behavior: "completed", result: { service: "A" } });
    expect((await example(1, task.id).req.expect(200)).body.task.result.text).toBe("작업 결과");
    const queued = (await call("post", endpoint).send({ message: "next task", conversationId: task.conversationId }).expect(202)).body.task;
    await example(3, queued.id).req.expect(200);
    expect((await example(1, queued.id).req.expect(200)).body.task.status).toBe("cancelled");
  });

  it("shows a token only at creation, scopes it to task APIs, and revokes it", async () => {
    const { owner, call, created, app, services, user } = await boot();
    const listed = await owner.get("/api/me/avatar-api-keys").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
    expect(JSON.stringify(listed.body)).not.toContain("token_hash");
    await request(app).post(endpoint).send({ message: "hello" }).expect(401);
    await owner.post(endpoint).send({ message: "hello" }).expect(401);
    await call("post", "/api/me/avatar-api-keys").send({ name: "forbidden" }).expect(401);
    await call("get", endpoint).expect(200);
    services.store.setSuspended(user.id, true);
    await call("get", endpoint).expect(401);
    services.store.setSuspended(user.id, false);
    services.store.revokeAvatarApiKey(user.id, created.key.id);
    await call("get", endpoint).expect(401);
  });

  it("accepts arbitrary instructions asynchronously and persists the real owner chat result", async () => {
    const { call, services, user } = await boot();
    const accepted = await call("post", endpoint).send({ message: "내 문서를 정리해 줘" }).expect(202);
    const task = accepted.body.task;
    expect(task.status).toBe("queued");
    expect(H.requests).toHaveLength(0);
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    const done = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
    expect(done.result.text).toBe("작업 결과");
    expect(H.requests[0]).toMatchObject({ message: "내 문서를 정리해 줘", viewerUserId: user.id, viewerIsOwner: true });
    expect(services.store.listRoutineJobs(user.id)).toHaveLength(0);
    expect(services.store.listMessages(user.id, task.conversationId).map(m => m.role)).toEqual(["user", "assistant"]);
    const next = (await call("post", endpoint).send({ message: "이어서 요약해 줘", conversationId: task.conversationId }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, next.id)?.status).toBe("succeeded"));
    expect(services.store.listMessages(user.id, task.conversationId)).toHaveLength(4);
  });

  it("prevents duplicate execution and rejects changed payloads for an idempotency key", async () => {
    const { call, services, user } = await boot();
    const first = await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "do this" }).expect(202);
    const replay = await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "do this" }).expect(200);
    expect(replay.body.task.id).toBe(first.body.task.id);
    await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "different" }).expect(409);
    expect(services.store.listAvatarTasks(user.id)).toHaveLength(1);
  });

  it("blocks cross-owner tasks, thread reuse, and arbitrary target/permission input", async () => {
    const { call, app, services, user } = await boot();
    const other = services.store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const otherKey = services.store.createAvatarApiKey(other.id, "other");
    const task = (await call("post", endpoint).send({ message: "private" }).expect(202)).body.task;
    for (const suffix of ["", "/cancel", "/respond"]) {
      const method = suffix ? "post" : "get";
      await request(app)[method](`${endpoint}/${task.id}${suffix}`).set("Authorization", `Bearer ${otherKey.token}`).send({}).expect(404);
    }
    services.store.touchConversation(other.id, "other-thread", other.id, "Other");
    services.store.touchConversation(user.id, "peer-thread", other.id, "Peer");
    for (const conversationId of ["other-thread", "peer-thread", "nonexistent"]) {
      await call("post", endpoint).send({ message: "do it", conversationId }).expect(404);
    }
    await call("post", endpoint).send({ message: "do it", avatarId: other.id }).expect(400);
    await call("post", endpoint).send({ message: "do it", autoApprove: true }).expect(400);
    await call("post", endpoint).send({ message: "한".repeat(22000) }).expect(400);
  });

  it("queues behind an active conversation and supports queued cancellation", async () => {
    const { call, services, user } = await boot();
    services.store.touchConversation(user.id, "busy-thread", user.id, "Busy");
    openRun("busy-run", user.id, { conversationId: "busy-thread" });
    try {
      const task = (await call("post", endpoint).send({ message: "queued", conversationId: "busy-thread" }).expect(202)).body.task;
      dispatchAvatarTasks(services);
      expect(H.requests).toHaveLength(0);
      await call("post", `${endpoint}/${task.id}/cancel`).expect(200);
      expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled");
    } finally { closeRun("busy-run"); }
  });

  it("surfaces questions and lets the external caller answer the same run", async () => {
    const { call, services, user } = await boot();
    let answer: unknown;
    H.script.push(async events => {
      answer = await events.onQuestion?.({ dialogKind: "question", payload: { question: "어느 서비스인가요?" } });
    });
    const task = (await call("post", endpoint).send({ message: "분석해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    let pending: any;
    await vi.waitFor(async () => {
      pending = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
      expect(pending.status).toBe("waiting_input");
    });
    await call("post", `${endpoint}/${task.id}/respond`).send({ requestId: pending.pendingRequests[0].data.requestId, value: { result: { service: "A" } } }).expect(200);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    expect(answer).toEqual({ behavior: "completed", result: { service: "A" } });
    await call("post", `${endpoint}/${task.id}/respond`).send({ requestId: pending.pendingRequests[0].data.requestId, value: {} }).expect(409);
  });

  it("records SDK failures and deadline expiry as failures, not successful acceptance", async () => {
    const { call, services, user } = await boot();
    H.script.push(() => { throw new Error("test failure"); });
    const task = (await call("post", endpoint).send({ message: "fail" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, task.id)?.error).toContain("test failure");
    services.config.avatarTaskRunTimeoutMs = 30;
    H.script.push(async (_events, abort) => new Promise<void>(resolve => abort!.signal.addEventListener("abort", () => resolve(), { once: true })));
    const timed = (await call("post", endpoint).send({ message: "hang" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, timed.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, timed.id)?.error).toContain("제한 시간");
  });

  it("rechecks revoked keys before dispatch and limits outstanding requests", async () => {
    const { call, services, user, created } = await boot();
    for (let i = 0; i < 20; i++) await call("post", endpoint).send({ message: `task ${i}` }).expect(202);
    await call("post", endpoint).send({ message: "overflow" }).expect(429);
    services.store.revokeAvatarApiKey(user.id, created.key.id);
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.listAvatarTasks(user.id).some(t => t.status === "failed")).toBe(true));
    expect(H.requests).toHaveLength(0);
  });

  it("keeps permission checks interactive and can cancel a waiting run", async () => {
    const { call, services, user } = await boot();
    let answer: unknown;
    H.script.push(async events => {
      answer = await events.onPermission?.({ agentId: "owner", toolUseId: "tool-1", toolName: "Bash", input: { command: "echo test" } });
    });
    const task = (await call("post", endpoint).send({ message: "도구를 사용해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(async () => {
      const pending = (await call("get", `${endpoint}/${task.id}`)).body.task;
      expect(pending.pendingRequests[0]?.event).toBe("permission");
    });
    await call("post", `${endpoint}/${task.id}/cancel`).expect(200);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled"));
    expect(answer).toEqual({ behavior: "deny", unanswered: true });
  });

  it("releases unanswered questions when the execution deadline expires", async () => {
    const { call, services, user } = await boot();
    services.config.avatarTaskRunTimeoutMs = 30;
    H.script.push(async events => { await events.onQuestion?.({ dialogKind: "question", payload: {} }); });
    const task = (await call("post", endpoint).send({ message: "질문해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, task.id)?.error).toContain("제한 시간");
  });

  it("persists queued tasks across reopening and fails interrupted runs on startup", async () => {
    const { call, services, user } = await boot();
    const queued = (await call("post", endpoint).send({ message: "queued" }).expect(202)).body.task;
    const interrupted = (await call("post", endpoint).send({ message: "interrupted" }).expect(202)).body.task;
    services.store.claimAvatarTask(user.id, interrupted.id);
    services.store.close();
    const reopened = { ...services, store: new Store(services.config) };
    current = reopened;
    const stop = startAvatarTaskDispatcher(reopened);
    try {
      expect(reopened.store.getAvatarTask(user.id, interrupted.id)?.status).toBe("failed");
      await vi.waitFor(() => expect(reopened.store.getAvatarTask(user.id, queued.id)?.status).toBe("succeeded"));
    } finally { stop(); }
    reopened.store.deleteUser(user.id);
    expect(reopened.store.listAvatarTasks(user.id)).toEqual([]);
    expect(reopened.store.listAvatarApiKeys(user.id)).toEqual([]);
  });

  it("cancels a task claimed for dispatch but not yet opened as a run", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "취소" }).expect(202)).body.task;
    expect(services.store.claimAvatarTask(user.id, task.id)).toBe(true);
    const claimed = services.store.getAvatarTask(user.id, task.id)!;
    expect(claimed.status).toBe("running");
    expect(claimed.runId).toBeNull();
    await call("post", `${endpoint}/${task.id}/cancel`).expect(200);
    expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled");
  });

  it("abandons the turn when the cancel lands in the claimed window", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "중단" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    // Lands before the prelude's first await resumes, so onRunOpen sees it.
    services.store.updateAvatarTask(user.id, task.id, "cancelled");
    // The instruction bubble is written BEFORE onRunOpen: it stays with no reply,
    // exactly like an interactive stop pressed before the first token.
    await vi.waitFor(() => expect(services.store.listMessages(user.id, task.conversationId).map(m => m.role)).toEqual(["user"]));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(H.requests).toHaveLength(0);
    expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled");
    expect(getActiveRunForConversation(user.id, task.conversationId)).toBeFalsy();
  });

  it("drops queued tasks with the conversation they belong to", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "정리" }).expect(202)).body.task;
    expect(services.store.deleteConversation(user.id, task.conversationId)).toBe(true);
    expect(services.store.getAvatarTask(user.id, task.id)).toBeNull();
  });

  it("audits acceptance and the run itself under the task action, never plain chat", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "감사 기록" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    const actions = services.store.listAudit(user.id, false).map(entry => entry.action);
    expect(actions).toContain("avatar_api_task_accept");
    expect(actions).toContain("avatar_api_task");
    expect(actions).not.toContain("chat");
  });

  it("reports a graceful shutdown as a restart failure, not a cancellation", async () => {
    const { call, services, user } = await boot();
    services.config.avatarTaskRunTimeoutMs = 60_000;
    H.script.push(async (_events, abort) => new Promise<void>(resolve => abort!.signal.addEventListener("abort", () => resolve(), { once: true })));
    const task = (await call("post", endpoint).send({ message: "재시작" }).expect(202)).body.task;
    const stop = startAvatarTaskDispatcher(services);
    try {
      await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.runId).toBeTruthy());
      stop();
      cancelAllRuns();
      await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
      expect(services.store.getAvatarTask(user.id, task.id)?.error).toBe(AVATAR_TASK_RESTART_ERROR);
    } finally { stop(); }
  });

  it("backs off before re-dispatching a task the thread refused", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "재시도" }).expect(202)).body.task;
    // Take the thread DURING the turn's async prelude — after its first busy
    // check, before openRun — so the turn refuses with 409 and the runner requeues.
    const addMessage = services.store.addMessage.bind(services.store);
    let raced = false;
    services.store.addMessage = (...args: Parameters<typeof addMessage>) => {
      if (!raced) { raced = true; openRun("busy", user.id, { conversationId: task.conversationId }); }
      return addMessage(...args);
    };
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("queued"));
    services.store.addMessage = addMessage;
    closeRun("busy");
    expect(H.requests).toHaveLength(0);
    dispatchAvatarTasks(services);
    expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("queued");
    expect(H.requests).toHaveLength(0);
    dispatchAvatarTasks(services, Date.now() + 61_000);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    // The refused turn already wrote the instruction bubble; the retry must not repeat it.
    expect(services.store.listMessages(user.id, task.conversationId).map(m => m.role)).toEqual(["user", "assistant"]);
  });

  it("returns the whole background phase, not the placeholder the visible turn ended on", async () => {
    const { call, services, user } = await boot();
    // First result boundary with live background tasks finalizes the visible turn
    // (done + background:true); the second is a wake-up report (bg_message).
    H.script.push(events => {
      events.onTurnResult?.({ text: "우선 조사를 시작합니다", backgroundTasks: [{ taskId: "t1", taskType: "subagent", description: "조사" }] });
      events.onTurnResult?.({ text: "조사 결과를 보고합니다", backgroundTasks: [] });
    });
    const task = (await call("post", endpoint).send({ message: "오래 걸리는 조사" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    const done = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
    expect(done.result.text).toContain("우선 조사를 시작합니다");
    expect(done.result.text).toContain("조사 결과를 보고합니다");
    expect(done.result.summary).toBe("백그라운드 작업 보고");
    expect(services.store.listMessages(user.id, task.conversationId).map(m => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("drops the background placeholder when the visible segment streamed nothing", async () => {
    const { call, services, user } = await boot();
    // An empty first segment makes chat.ts fall back to BACKGROUND_TURN_PLACEHOLDER
    // for the visible reply; the stored result must be the report alone.
    H.script.push(events => {
      events.onTurnResult?.({ text: "", backgroundTasks: [{ taskId: "t1", taskType: "subagent", description: "조사" }] });
      events.onTurnResult?.({ text: "최종 보고", backgroundTasks: [] });
    });
    const task = (await call("post", endpoint).send({ message: "조용한 조사" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    const done = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
    expect(done.result.text).toBe("최종 보고");
    expect(done.result.text).not.toContain(BACKGROUND_TURN_PLACEHOLDER);
  });

  it("stops re-queuing a task the thread never frees, and reports the refusal", async () => {
    const { call, services, user } = await boot();
    const task = (await call("post", endpoint).send({ message: "영원히 대기" }).expect(202)).body.task;
    // An hour of refusals already happened; this one must settle the task.
    __avatarTaskRetryStateForTests(services).set(task.id, { at: 0, attempts: 60 });
    const addMessage = services.store.addMessage.bind(services.store);
    let raced = false;
    services.store.addMessage = (...args: Parameters<typeof addMessage>) => {
      if (!raced) { raced = true; openRun("busy", user.id, { conversationId: task.conversationId }); }
      return addMessage(...args);
    };
    try {
      dispatchAvatarTasks(services);
      await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
      expect(services.store.getAvatarTask(user.id, task.id)?.error).toContain("이미 이 대화의 응답을 생성 중입니다");
      expect(__avatarTaskRetryStateForTests(services).has(task.id)).toBe(false);
    } finally { services.store.addMessage = addMessage; closeRun("busy"); }
  });

  it("prunes a thread the task auto-created, but never one that already has messages", async () => {
    const { call, services, user } = await boot();
    const fresh = (await call("post", endpoint).send({ message: "빈 대화" }).expect(202)).body.task;
    await call("post", `${endpoint}/${fresh.id}/cancel`).expect(200);
    expect(services.store.getConversationAvatarId(user.id, fresh.conversationId)).toBeNull();
    services.store.touchConversation(user.id, "keep-thread", user.id, "Keep");
    services.store.addMessage("keep-thread", { role: "user", content: "이전 대화" });
    const continued = (await call("post", endpoint).send({ message: "이어서", conversationId: "keep-thread" }).expect(202)).body.task;
    await call("post", `${endpoint}/${continued.id}/cancel`).expect(200);
    expect(services.store.getConversationAvatarId(user.id, "keep-thread")).toBe(user.id);
    expect(services.store.listMessages(user.id, "keep-thread")).toHaveLength(1);
  });

  it("seeds a server-minted thread from the owner's composer defaults, never over its own", async () => {
    const { call, services, user } = await boot();
    services.store.setChatDefaults(user.id, { model: "haiku", effort: "low", mcpToolGroups: ["web"] });
    const fresh = (await call("post", endpoint).send({ message: "기본값" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, fresh.id)?.status).toBe("succeeded"));
    expect(H.requests[0]).toMatchObject({ modelTier: "haiku", effort: "low", mcpToolGroups: ["web", "system"] });
    // A non-null request is persisted onto the thread, exactly as a first
    // interactive turn would leave it.
    expect(services.store.getConversationMcpToolGroups(user.id, fresh.conversationId)).toEqual(["web"]);
    expect(services.store.getConversationModel(user.id, fresh.conversationId)).toBe("haiku");
    // The thread's OWN selection outranks the owner default on the next task.
    services.store.setConversationModel(user.id, fresh.conversationId, "sonnet");
    services.store.setConversationMcpToolGroups(user.id, fresh.conversationId, ["canvas"]);
    const next = (await call("post", endpoint).send({ message: "이어서", conversationId: fresh.conversationId }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, next.id)?.status).toBe("succeeded"));
    expect(H.requests[1]).toMatchObject({ modelTier: "sonnet", mcpToolGroups: ["canvas", "system"] });
  });

  it("treats a blank Idempotency-Key as no key at all", async () => {
    const { call } = await boot();
    await call("post", endpoint).set("Idempotency-Key", "").send({ message: "빈 헤더" }).expect(202);
  });

  it("measures a response value in bytes, so Korean payloads hit the same cap", async () => {
    const { call } = await boot();
    const task = (await call("post", endpoint).send({ message: "응답 크기" }).expect(202)).body.task;
    // ~30k UTF-16 chars but ~90KB of UTF-8 — under the old .length cap, over this one.
    await call("post", `${endpoint}/${task.id}/respond`).send({ requestId: "r", value: { result: "한".repeat(30000) } }).expect(400);
  });

  it("keeps a pruned-eligible thread while a sibling task still needs it", async () => {
    const { call, services, user } = await boot();
    const first = (await call("post", endpoint).send({ message: "첫 번째" }).expect(202)).body.task;
    const second = (await call("post", endpoint).send({ message: "두 번째", conversationId: first.conversationId }).expect(202)).body.task;
    await call("post", `${endpoint}/${first.id}/cancel`).expect(200);
    expect(services.store.getConversationAvatarId(user.id, first.conversationId)).toBe(user.id);
    await call("post", `${endpoint}/${second.id}/cancel`).expect(200);
    expect(services.store.getConversationAvatarId(user.id, first.conversationId)).toBeNull();
  });

  it("throttles the key's last-used stamp so status polls stay read-only", async () => {
    const { services, user, created } = await boot();
    expect(services.store.authenticateAvatarApiKey(created.token)).toBeTruthy();
    const first = services.store.listAvatarApiKeys(user.id)[0].lastUsedAt;
    expect(first).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(services.store.authenticateAvatarApiKey(created.token)).toBeTruthy();
    expect(services.store.listAvatarApiKeys(user.id)[0].lastUsedAt).toBe(first);
  });

  it("exposes only outstanding prompts, never secret browser events", async () => {
    openRun("prompts", "owner");
    emitRunEvent("prompts", "browser", { secretText: "secret", requestId: "b" }, { replay: false });
    emitRunEvent("prompts", "question", { requestId: "q", payload: {} });
    const response = awaitResponse("prompts", "q");
    expect(getRunPrompts("prompts", "owner")).toHaveLength(1);
    expect(getRunPrompts("prompts", "other")).toEqual([]);
    closeRun("prompts"); await response;
  });
});
