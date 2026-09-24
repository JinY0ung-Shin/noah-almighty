import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig, BotTask } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { gitInit, parseSse, signup, withTempDir } from "./helpers.js";

/**
 * Delegated bot tasks (내 봇 작업) over the HTTP surface: the chat route's task
 * lifecycle, the queue-instead-of-409 branch, the server-side dispatcher, and
 * the /api/me/bot-tasks board.
 *
 * The agent layer is mocked (the personal-agent-routes pattern) so each test can
 * SCRIPT what a turn does — park on a question, blow up, or hang until the next
 * request arrives — which is the only way to exercise a queue from one process.
 */
const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  /** Per-turn behavior, consumed in call order; missing → resolve immediately. */
  script: [] as ((
    req: AgentRequest,
    events: AgentEvents,
    abort: AbortController | undefined,
  ) => Promise<void> | void)[],
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
      const step = H.script.shift();
      if (step) {
        await step(agentRequest, events, abortController);
      }
      if (abortController?.signal.aborted) {
        throw new Error("Claude Code process aborted by user");
      }
      events.onDelta?.("[mock]");
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: "[mock]",
      };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";
import {
  maybeDispatchNextBotTask,
  startBotTaskDispatcher,
} from "../src/server/botTaskRunner.js";
import { executeChatTurn, resolveChatTarget } from "../src/server/routes/chat.js";
import { executeRoutineJob } from "../src/server/scheduler.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import { acquireActiveRepo, releaseActiveRepo } from "../src/server/activeRepoLock.js";
import { setWorkspaceRepo } from "../src/server/repoWorkspace.js";
import { gitRepoClonePath } from "../src/server/gitRepos.js";

const tempDir = withTempDir("personal-agent-tasks-routes");

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function boot(dir: string, overrides: Partial<AppConfig> = {}) {
  H.requests.length = 0;
  H.script.length = 0;
  const svc = createServices({
    dataDir: path.join(tempDir(), dir),
    agentRuntime: "local",
    sessionSecret: "t",
    ...overrides,
  });
  return { ...svc, app: createApp(svc) };
}

/** Sign up the first user (system admin) and give them one enabled bot. */
async function bootWithBot(dir: string, overrides: Partial<AppConfig> = {}) {
  const services = boot(dir, overrides);
  const admin = request.agent(services.app);
  await signup(admin, "sys-admin").expect(201);
  const ownerId = services.store.getUserByUsername("sys-admin")!.id;
  const agent = services.store.createPersonalAgent(ownerId, {
    displayName: "리서치 봇",
  });
  return {
    ...services,
    admin,
    ownerId,
    agent,
    avatarId: personalAgentAvatarId(ownerId, agent.id),
  };
}

/** Poll until `check` is truthy — the dispatcher runs off the request cycle. */
async function until<T>(check: () => T | null | undefined, label: string): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("delegated bot tasks — chat route", () => {
  it("tracks an attended bot turn as a task and finalizes it done", async () => {
    const { admin, store, ownerId, agent, avatarId } = await bootWithBot("attended");

    const res = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-1", message: "보고서 초안 좀 써줘\n두 번째 줄" })
      .expect(200);

    // PINNED FRAME NAME. It must be `bot_task`, never `task`: the SDK activity
    // relay already owns `task`/`task_update`/`task_end`, and the client's
    // handler for those drops any frame without `data.taskId` — so a rename
    // back would make delegated rows vanish from the live view with every test
    // still green on both sides.
    const events = parseSse(res.text).map((f) => f.event);
    expect(events).toContain("bot_task");
    const taskFrames = parseSse(res.text).filter((f) => f.event === "bot_task");
    expect(taskFrames.length).toBeGreaterThanOrEqual(2); // running, then done
    const first = (taskFrames[0].data as { task: BotTask }).task;
    expect(first).toMatchObject({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-1",
      status: "running",
      // Title mirrors the conversation-title derivation: first line, capped.
      title: "보고서 초안 좀 써줘",
      requestText: "보고서 초안 좀 써줘\n두 번째 줄",
    });
    const last = (taskFrames[taskFrames.length - 1].data as { task: BotTask }).task;
    expect(last).toMatchObject({ id: first.id, status: "done" });
    // The settled card must arrive BEFORE the terminal frame: the client stops
    // reading the stream at `done`, so a task frame behind it is only seen on
    // the next refetch and the card would sit spinning.
    expect(events.lastIndexOf("bot_task")).toBeLessThan(events.indexOf("done"));

    const stored = store.listBotTasksForConversation("bt-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("done");
    expect(stored[0].runId).toBeNull();
    // The frame carries the WHOLE row, keyed to the one the store persisted —
    // the client renders the card straight from it and drops a payload that is
    // missing id/agentId/status.
    expect(first.id).toBe(stored[0].id);
    expect(last).toMatchObject({
      id: stored[0].id,
      agentId: agent.id,
      status: "done",
    });
    // The turn carries its own task id so the bot can report on it.
    expect(H.requests[0].personalAgent).toMatchObject({
      agentId: agent.id,
      ownerUserId: ownerId,
      taskId: first.id,
    });
    // An owner-typed turn is attended: no unattended deadline, no fallback.
    expect(H.requests[0].modelFallback).toBeUndefined();
  });

  it("parks on need_input and RESUMES the same task on the owner's next message", async () => {
    const { admin, store, avatarId } = await bootWithBot("need-input");

    H.script.push((req) => {
      // What mcp__personal_agent__report_task does mid-run.
      store.setBotTaskReport(req.personalAgent!.taskId!, {
        outcome: "need_input",
        summary: "어떤 형식으로 정리할까요?",
      });
    });
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-2", message: "정리해줘" })
      .expect(200);

    const parked = store.listBotTasksForConversation("bt-2");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      status: "waiting_input",
      pendingQuestion: "어떤 형식으로 정리할까요?",
      finishedAt: null,
    });

    // The answer resumes the SAME row rather than opening a second one.
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-2", message: "표로" })
      .expect(200);
    const resumed = store.listBotTasksForConversation("bt-2");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ id: parked[0].id, status: "done" });
    expect(H.requests[1].personalAgent!.taskId).toBe(parked[0].id);
  });

  it("fails the task with the Korean error the thread shows", async () => {
    const { admin, store, avatarId } = await bootWithBot("failure");

    H.script.push(() => {
      throw new Error("boom from the sdk");
    });
    const res = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-3", message: "터뜨려줘" })
      .expect(200);
    const events = parseSse(res.text).map((f) => f.event);
    expect(events).toContain("error");
    // Same ordering rule as the done path — the failed card must precede the
    // frame that ends the client's read — and the same pinned frame name.
    expect(events).toContain("bot_task");
    expect(events.lastIndexOf("bot_task")).toBeLessThan(events.indexOf("error"));

    const [task] = store.listBotTasksForConversation("bt-3");
    expect(task.status).toBe("failed");
    expect(task.error).toContain("응답 생성 중 오류가 발생했습니다");
    expect(task.error).toContain("boom from the sdk");
  });

  it("queues a message sent while the bot is busy instead of 409ing", async () => {
    const { admin, store, agent, avatarId } = await bootWithBot("queue");

    // Hold the first turn open until the second request has been answered.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    H.script.push(() => firstHeld);

    const streaming = admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-4", message: "긴 작업" })
      .then((r) => r);
    await until(
      () => store.listBotTasksForConversation("bt-4").length || null,
      "the first task row",
    );

    // Images cannot ride a queued turn.
    const withImage = await admin
      .post("/api/chat/stream")
      .send({
        avatarId,
        conversationId: "bt-4",
        message: "이것도",
        images: [{ id: "i1", data: PNG }],
      })
      .expect(400);
    expect(withImage.body.error).toContain("이미지 없이 텍스트만");

    const queued = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-4", message: "다음 것도 해줘" })
      .expect(202);
    expect(queued.body.queued).toBe(true);
    expect(queued.body.task).toMatchObject({
      status: "queued",
      agentId: agent.id,
      title: "다음 것도 해줘",
      requestText: "다음 것도 해줘",
      runId: null,
    });
    // The user's message is persisted exactly once, in the order they typed it.
    const messages = store.listMessages(
      store.getUserByUsername("sys-admin")!.id,
      "bt-4",
    );
    expect(messages.filter((m) => m.content === "다음 것도 해줘")).toHaveLength(1);

    releaseFirst();
    await streaming;

    // The server dispatches the queued turn itself — no HTTP client involved.
    const done = await until(() => {
      const rows = store.listBotTasksForConversation("bt-4");
      return rows.length === 2 && rows[1].status === "done" ? rows : null;
    }, "the queued task to run");
    expect(done[1].startedAt).not.toBeNull();
    // The dispatched turn is unattended: it falls back down the tier chain, and
    // it did NOT re-persist the user message.
    const dispatched = H.requests[H.requests.length - 1];
    expect(dispatched.modelFallback).toBe(true);
    expect(dispatched.message).toBe("다음 것도 해줘");
    expect(
      store
        .listMessages(store.getUserByUsername("sys-admin")!.id, "bt-4")
        .filter((m) => m.content === "다음 것도 해줘"),
    ).toHaveLength(1);
  });

  it("429s once the thread's queue is full and keeps 409 for regenerate", async () => {
    const { admin, store, ownerId, agent, avatarId } = await bootWithBot("cap");

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.script.push(() => held);
    const streaming = admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-5", message: "긴 작업" })
      .then((r) => r);
    await until(
      () => store.listBotTasksForConversation("bt-5").length || null,
      "the running task",
    );

    // Regenerate has no queue semantics — the answer it would replace is still
    // being written.
    const regen = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-5", message: "다시", regenerate: true })
      .expect(409);
    expect(regen.body.error).toContain("이미 이 대화의 응답을 생성 중입니다");

    for (let i = 0; i < 20; i += 1) {
      store.createBotTask({
        ownerUserId: ownerId,
        agentId: agent.id,
        conversationId: "bt-5",
        title: `대기 ${i}`,
        requestText: `대기 ${i}`,
        status: "queued",
      });
    }
    const full = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-5", message: "하나 더" })
      .expect(429);
    expect(full.body.error).toContain("대기열이 가득 찼습니다(최대 20개)");

    release();
    await streaming;
  });
});

describe("delegated bot tasks — dispatcher", () => {
  it("fails a queued task whose bot was disabled meanwhile", async () => {
    const { admin, store, ownerId, agent, avatarId } = await bootWithBot("disabled");

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.script.push(() => held);
    const streaming = admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-6", message: "첫 작업" })
      .then((r) => r);
    await until(
      () => store.listBotTasksForConversation("bt-6").length || null,
      "the running task",
    );
    const queued = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-6", message: "두 번째" })
      .expect(202);

    // The bot goes away before the dispatcher can reach the queued item.
    store.updatePersonalAgent(agent.id, { enabled: false });
    release();
    await streaming;

    const failed = await until(() => {
      const row = store.getBotTask(queued.body.task.id as string);
      return row?.status === "failed" ? row : null;
    }, "the undispatchable task to fail");
    expect(failed.error).toContain("봇이 삭제/비활성화되었거나");
    // Nothing was run for it.
    expect(H.requests).toHaveLength(1);
    expect(store.listBotTasks(ownerId)).toHaveLength(2);
  });

  it("drains a MULTI-item backlog rather than stopping after the first", async () => {
    // Regression guard: the settle hook fires from inside the turn the drain is
    // awaiting, so relying on it to re-enter would strand tasks 2..n.
    const { store, ownerId, agent, ...svc } = await bootWithBot("drain");
    const ids = ["하나", "둘", "셋"].map(
      (text) =>
        store.createBotTask({
          ownerUserId: ownerId,
          agentId: agent.id,
          conversationId: "bt-14",
          title: text,
          requestText: text,
          status: "queued",
        }).id,
    );

    startBotTaskDispatcher({
      config: svc.config,
      store,
      observedModel: svc.observedModel,
    });

    await until(
      () =>
        ids.every((id) => store.getBotTask(id)?.status === "done") ? true : null,
      "every queued task to run",
    );
    // In order, one run each.
    expect(H.requests.map((r) => r.message)).toEqual(["하나", "둘", "셋"]);
  });

  it("runs nothing for a task the owner cancelled while it was being popped", async () => {
    const { admin, store, ownerId, agent, avatarId, ...svc } =
      await bootWithBot("cancel-race");
    const doomed = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-15",
      title: "취소될 작업",
      requestText: "취소될 작업",
      status: "queued",
    });
    await admin.post(`/api/me/bot-tasks/${doomed.id}/cancel`).expect(200);

    // The narrow window the dispatcher cannot avoid: it popped this row while
    // it was still `queued`, and the cancel landed during the turn's own
    // pre-flight. Drive it directly, the way the dispatcher would.
    const target = resolveChatTarget({
      store,
      externalAgents: [],
      viewerGroupIds: new Set<string>(),
      viewerUserId: ownerId,
      avatarId,
      hasImages: false,
      ownerOnlyCommand: false,
    });
    expect(target.ok).toBe(true);
    const outcome = await executeChatTurn(
      { config: svc.config, store, observedModel: svc.observedModel },
      {
        ownerUserId: ownerId,
        ownerDisplayName: "sys-admin",
        target: (target as Extract<typeof target, { ok: true }>).target,
        conversationId: "bt-15",
        agentMessage: "취소될 작업",
        displayMessage: "취소될 작업",
        images: [],
        regenerate: false,
        audit: () => {},
        existingBotTaskId: doomed.id,
        skipUserMessagePersist: true,
      },
      { onRunOpen: () => true },
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { reason: "task_gone", status: 409 },
    });
    // Untracked unattended work has no stop button anywhere, so none is started.
    expect(H.requests).toHaveLength(0);
    expect(store.getBotTask(doomed.id)!.status).toBe("cancelled");
    // And the run was released, not stranded (a stranded run 409s the thread
    // for the rest of the process lifetime).
    expect(
      await admin.get("/api/chat/runs?conversationId=bt-15").expect(200),
    ).toMatchObject({ body: { run: null } });

    // The queue moves on: the next item still runs.
    const survivor = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-15",
      title: "살아남을 작업",
      requestText: "살아남을 작업",
      status: "queued",
    });
    await maybeDispatchNextBotTask(
      { config: svc.config, store, observedModel: svc.observedModel },
      ownerId,
      "bt-15",
    );
    expect(store.getBotTask(survivor.id)!.status).toBe("done");
    expect(H.requests.map((r) => r.message)).toEqual(["살아남을 작업"]);
  });

  it("times a dispatched task out with a Korean deadline message", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("timeout", {
      // An explicit override bypasses loadConfig's 1-minute floor.
      botTaskRunTimeoutMs: 40,
    });
    const queued = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-13",
      title: "끝나지 않는 일",
      requestText: "끝나지 않는 일",
      status: "queued",
    });
    // Hang until the run's own deadline aborts us — the shape of a wedged SDK
    // call, which is the only thing this budget exists for.
    H.script.push(
      (_req, _events, abort) =>
        new Promise<void>((resolve) => {
          abort!.signal.addEventListener("abort", () => resolve());
        }),
    );

    startBotTaskDispatcher({
      config: svc.config,
      store,
      observedModel: svc.observedModel,
    });

    const failed = await until(() => {
      const row = store.getBotTask(queued.id);
      return row?.status === "failed" ? row : null;
    }, "the timed-out task");
    // Never the SDK's "aborted by user" — nobody was there to abort it.
    expect(failed.error).toContain("실행 제한 시간");
    expect(failed.error).toContain("작업을 더 작은 단위로 나눠");
    expect(failed.error).not.toContain("aborted by user");
    expect(
      store
        .listMessages(ownerId, "bt-13")
        .some((m) => m.content.includes("실행 제한 시간")),
    ).toBe(true);
  });

  it("sweeps interrupted tasks at boot and drains the backlog", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("boot");

    // What a restart leaves behind: a `running` row whose registry entry is gone.
    const interrupted = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-7",
      title: "중단된 작업",
      requestText: "중단된 작업",
      status: "running",
      runId: "gone",
    });
    const pending = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-7",
      title: "밀린 작업",
      requestText: "밀린 작업",
      status: "queued",
    });

    startBotTaskDispatcher({
      config: svc.config,
      store,
      observedModel: svc.observedModel,
    });

    expect(store.getBotTask(interrupted.id)).toMatchObject({
      status: "failed",
      error: "서버가 재시작되어 작업이 중단되었습니다.",
    });
    const ran = await until(() => {
      const row = store.getBotTask(pending.id);
      return row?.status === "done" ? row : null;
    }, "the pre-seeded queued task to run");
    expect(ran.startedAt).not.toBeNull();
    expect(H.requests.at(-1)!.message).toBe("밀린 작업");
  });
});

/**
 * 봇 루틴: a routine bound to a personal agent fires as a SCHEDULED DELEGATED
 * TASK — the same executeChatTurn + bot_tasks machinery 봇 오피스 uses, in the
 * routine's own composite-bound thread. These drive `executeRoutineJob`
 * directly (the scheduler tick and "지금 실행" both go through it).
 */
describe("봇 루틴 — scheduler", () => {
  it("runs a due bot routine as a delegated task in its own thread", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("routine-direct");
    const job = store.createRoutineJob(ownerId, {
      name: "일일 리서치",
      prompt: "오늘 이슈 정리해줘",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });

    const result = await executeRoutineJob(
      { config: svc.config, store, observedModel: svc.observedModel },
      job,
    );
    expect(result).toEqual({ ok: true });

    // ONE task row, stamped with the routine that fired it — that stamp is both
    // the card's 예약 provenance and the scheduler's dedupe key.
    const tasks = store.listBotTasksForConversation(job.conversationId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      agentId: agent.id,
      status: "done",
      routineJobId: job.id,
      title: "오늘 이슈 정리해줘",
      requestText: "오늘 이슈 정리해줘",
    });
    // It ran as the BOT and unattended — a full owner run wearing the bot's
    // identity, with the delegated-task deadline and the tier fallback.
    const req = H.requests.at(-1)!;
    expect(req.personalAgent).toMatchObject({
      agentId: agent.id,
      ownerUserId: ownerId,
      taskId: tasks[0].id,
    });
    expect(req.modelFallback).toBe(true);
    expect(req.message).toBe("오늘 이슈 정리해줘");
    // markRoutineRun took the task's outcome and rolled the schedule forward.
    const after = store.listRoutineJobs(ownerId, { personalAgentId: agent.id })[0];
    expect(after).toMatchObject({ id: job.id, lastStatus: "success", lastError: null });
    expect(after.nextRunAt).toBeTruthy();
    // The turn is in the thread, once.
    expect(
      store.listMessages(ownerId, job.conversationId).map((m) => m.role),
    ).toEqual(["user", "assistant"]);
  });

  it("maps a FAILED delegated task onto the routine's own error", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("routine-fail");
    const job = store.createRoutineJob(ownerId, {
      prompt: "터뜨려줘",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });
    H.script.push(() => {
      throw new Error("boom from the sdk");
    });

    const result = await executeRoutineJob(
      { config: svc.config, store, observedModel: svc.observedModel },
      job,
    );

    // executeChatTurn finalizes the ROW instead of throwing, so "the turn ran"
    // and "the work succeeded" are different questions — the row answers both.
    const [task] = store.listBotTasksForConversation(job.conversationId);
    expect(task).toMatchObject({ status: "failed", routineJobId: job.id });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(task.error);
    expect(result.error).toContain("boom from the sdk");
    const after = store.getRoutineJob(ownerId, job.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe(task.error);
    // A failed firing never disables a recurring routine.
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBeTruthy();
  });

  it("holds a bot routine to the BOT budget, never the API's longer one", async () => {
    // Only botTaskRunTimeoutMs is shortened (an explicit override bypasses
    // loadConfig's 1-minute floor); the API budget stays at its 5-hour default.
    // A bot routine holds a scheduler slot for its whole run, so reading
    // the API budget here would hang this test instead of timing out.
    const { store, ownerId, agent, ...svc } = await bootWithBot("routine-timeout", {
      botTaskRunTimeoutMs: 40,
    });
    const job = store.createRoutineJob(ownerId, {
      prompt: "끝나지 않는 예약 작업",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });
    H.script.push(
      (_req, _events, abort) =>
        new Promise<void>((resolve) => {
          // The 40 ms deadline is armed before the turn's prelude (plugin and
          // knowledge loading), so on a loaded machine it can fire first.
          if (abort!.signal.aborted) return resolve();
          abort!.signal.addEventListener("abort", () => resolve());
        }),
    );

    const result = await executeRoutineJob(
      { config: svc.config, store, observedModel: svc.observedModel },
      job,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("실행 제한 시간");
    expect(store.getRoutineJob(ownerId, job.id)!.lastStatus).toBe("error");
  });

  it("skips a bot routine whose working repo is open elsewhere, then runs it once it frees", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("routine-repo-locked");
    const services = { config: svc.config, store, observedModel: svc.observedModel };
    const job = store.createRoutineJob(ownerId, {
      prompt: "저장소 점검",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });
    // A bot turn resolves the OWNER's registered repos (request.avatar is the
    // owner's row), so the lock is on the owner's clone of "app". The remote
    // needs a commit: unlike the owner-avatar path, a chat turn whose repo fails
    // to open refuses instead of falling back to scratch.
    const remote = path.join(tempDir(), "routine-repo-locked");
    gitInit(remote);
    store.upsertGitRepo(ownerId, "app", remote, null);
    setWorkspaceRepo(store, job.conversationId, "app");
    const clonePath = gitRepoClonePath(ownerId, "app", svc.config);
    expect(acquireActiveRepo(clonePath, "another-conversation")).toBe(true);
    try {
      const skipped = await executeRoutineJob(services, job);
      expect(skipped).toMatchObject({ ok: false, skipped: true });
      expect(skipped.error).toContain("작업 저장소");
      // The turn refused before writing anything: no task row, no bubble, no
      // recorded outcome — the job stays due for the next tick.
      expect(H.requests).toHaveLength(0);
      expect(store.listBotTasksForConversation(job.conversationId)).toHaveLength(0);
      expect(store.listMessages(ownerId, job.conversationId)).toHaveLength(0);
      expect(store.getRoutineJob(ownerId, job.id)!.lastRunAt).toBeNull();
    } finally {
      releaseActiveRepo(clonePath, "another-conversation");
    }
    await expect(executeRoutineJob(services, job)).resolves.toEqual({ ok: true });
    expect(store.listBotTasksForConversation(job.conversationId)).toMatchObject([
      { status: "done", routineJobId: job.id },
    ]);
  });

  it("ENQUEUES a firing that lands on a busy thread, and skips the next one", async () => {
    const { admin, store, ownerId, agent, avatarId, ...svc } =
      await bootWithBot("routine-busy");
    const services = { config: svc.config, store, observedModel: svc.observedModel };
    const job = store.createRoutineJob(ownerId, {
      prompt: "예약 작업 본문",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });

    // Hold an owner-typed turn open IN THE ROUTINE'S OWN THREAD (it is openable
    // in 봇 오피스 like any other bot thread).
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.script.push(() => held);
    const streaming = admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: job.conversationId, message: "직접 물어보는 중" })
      .then((r) => r);
    await until(
      () => store.listBotTasksForConversation(job.conversationId).length || null,
      "the owner's running task",
    );

    // The firing is QUEUED rather than skipped: a delegated task IS the output,
    // so handing it to the queue is this firing's successful outcome.
    expect(await executeRoutineJob(services, job)).toEqual({ ok: true });
    const queued = store
      .listBotTasksForConversation(job.conversationId)
      .find((t) => t.routineJobId === job.id)!;
    expect(queued).toMatchObject({
      status: "queued",
      requestText: "예약 작업 본문",
      runId: null,
    });
    // The user bubble is written exactly once.
    expect(
      store
        .listMessages(ownerId, job.conversationId)
        .filter((m) => m.content === "예약 작업 본문"),
    ).toHaveLength(1);
    const enqueued = store.getRoutineJob(ownerId, job.id)!;
    expect(enqueued.lastStatus).toBe("success");

    // A second firing while the first still WAITS skips instead of stacking a
    // duplicate — and a skip records no outcome at all, so the job stays due.
    const skipped = await executeRoutineJob(services, enqueued);
    expect(skipped).toMatchObject({ ok: false, skipped: true });
    expect(skipped.error).toContain("대기열");
    expect(
      store
        .listBotTasksForConversation(job.conversationId)
        .filter((t) => t.routineJobId === job.id),
    ).toHaveLength(1);
    expect(store.getRoutineJob(ownerId, job.id)).toMatchObject({
      lastRunAt: enqueued.lastRunAt,
      nextRunAt: enqueued.nextRunAt,
      lastStatus: "success",
    });

    // Once the thread frees up the dispatcher runs the queued firing itself.
    release();
    await streaming;
    const ran = await until(() => {
      const row = store.getBotTask(queued.id);
      return row?.status === "done" ? row : null;
    }, "the queued routine firing to run");
    expect(ran.routineJobId).toBe(job.id);
    expect(H.requests.at(-1)!.message).toBe("예약 작업 본문");
  });

  it("fails closed while the bot is disabled or deleted, keeping the schedule", async () => {
    const { store, ownerId, agent, ...svc } = await bootWithBot("routine-unreachable");
    const services = { config: svc.config, store, observedModel: svc.observedModel };
    const job = store.createRoutineJob(ownerId, {
      prompt: "봇에게 시킴",
      minuteOfDay: 0,
      personalAgentId: agent.id,
    });
    store.updatePersonalAgent(agent.id, { enabled: false });

    const result = await executeRoutineJob(services, job);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("봇이 비활성화되었거나 삭제되어");
    // Nothing ran and nothing was queued behind it.
    expect(H.requests).toHaveLength(0);
    expect(store.listBotTasksForConversation(job.conversationId)).toEqual([]);
    // Fail-closed but RECOVERABLE: the routine keeps its schedule, so the owner
    // re-enabling the bot resumes it at the next firing.
    const parked = store.getRoutineJob(ownerId, job.id)!;
    expect(parked).toMatchObject({ lastStatus: "error", enabled: true });
    expect(parked.nextRunAt).toBeTruthy();

    store.updatePersonalAgent(agent.id, { enabled: true });
    expect(await executeRoutineJob(services, parked)).toEqual({ ok: true });

    // And a DELETED bot — the scheduler may still hold a snapshot of a routine
    // whose row the cascade already removed — refuses the same way, silently.
    store.deletePersonalAgent(agent.id);
    expect(await executeRoutineJob(services, job)).toMatchObject({ ok: false });
    expect(store.getRoutineJob(ownerId, job.id)).toBeNull();
  });

  it("leaves a main-avatar routine on the legacy owner path", async () => {
    const { store, ownerId, ...svc } = await bootWithBot("routine-legacy");
    const job = store.createRoutineJob(ownerId, {
      prompt: "내 아바타 예약",
      minuteOfDay: 0,
    });

    expect(
      await executeRoutineJob(
        { config: svc.config, store, observedModel: svc.observedModel },
        job,
      ),
    ).toEqual({ ok: true });

    // No delegated task, no bot identity: the legacy path writes the pair itself
    // and runs headless as the owner's own avatar.
    expect(store.listBotTasksForConversation(job.conversationId)).toEqual([]);
    expect(H.requests.at(-1)!.personalAgent).toBeUndefined();
    expect(H.requests.at(-1)!.headless).toBe(true);
    expect(
      store.listMessages(ownerId, job.conversationId).map((m) => m.role),
    ).toEqual(["user", "assistant"]);
    expect(store.getRoutineJob(ownerId, job.id)!.lastStatus).toBe("success");
  });
});

describe("delegated bot tasks — /api/me/bot-tasks", () => {
  it("lists the owner's tasks, filters by bot, and 403s a non-admin", async () => {
    const { app, admin, store, ownerId, agent } = await bootWithBot("board");
    const other = store.createPersonalAgent(ownerId, { displayName: "다른 봇" });
    store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-8",
      title: "A",
      requestText: "A",
      status: "queued",
    });
    store.createBotTask({
      ownerUserId: ownerId,
      agentId: other.id,
      conversationId: "bt-9",
      title: "B",
      requestText: "B",
      status: "queued",
    });

    const all = await admin.get("/api/me/bot-tasks").expect(200);
    expect(all.body.tasks).toHaveLength(2);
    const filtered = await admin
      .get(`/api/me/bot-tasks?agentId=${agent.id}`)
      .expect(200);
    expect(filtered.body.tasks.map((t: BotTask) => t.title)).toEqual(["A"]);
    // limit is clamped, never trusted.
    await admin.get("/api/me/bot-tasks?limit=99999").expect(200);

    const plain = request.agent(app);
    await signup(plain, "plain").expect(201);
    await plain.get("/api/me/bot-tasks").expect(403);
    await plain.post("/api/me/bot-tasks/whatever/cancel").expect(403);
  });

  it("reports unseen counts and marks them seen, never across owners", async () => {
    const { app, admin, store, ownerId, agent, avatarId } = await bootWithBot("unseen");
    const other = store.createPersonalAgent(ownerId, { displayName: "다른 봇" });
    const settle = (agentId: string, title: string) => {
      const task = store.createBotTask({
        ownerUserId: ownerId,
        agentId,
        conversationId: `bt-${title}`,
        title,
        requestText: title,
        status: "running",
        runId: `run-${title}`,
      });
      return store.finishBotTask(task.id, { status: "done", resultSummary: title })!;
    };

    const empty = await admin.get("/api/me/bot-tasks/unseen").expect(200);
    expect(empty.body).toEqual({ total: 0, agents: {} });

    settle(agent.id, "A");
    settle(agent.id, "B");
    settle(other.id, "C");
    // Still in flight → not unseen, so the badge never counts work in motion.
    store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-q",
      title: "대기",
      requestText: "대기",
      status: "queued",
    });
    // Another owner's settled row, which must stay entirely out of my board.
    const otherOwner = request.agent(app);
    await signup(otherOwner, "other-owner").expect(201);
    const otherOwnerId = store.getUserByUsername("other-owner")!.id;
    const theirs = store.createBotTask({
      ownerUserId: otherOwnerId,
      agentId: agent.id,
      conversationId: "bt-theirs",
      title: "남의 것",
      requestText: "남의 것",
      status: "running",
      runId: "run-theirs",
    });
    store.finishBotTask(theirs.id, { status: "done" });

    const counts = await admin.get("/api/me/bot-tasks/unseen").expect(200);
    expect(counts.body).toEqual({
      total: 3,
      agents: { [agent.id]: 2, [other.id]: 1 },
    });

    // A narrowed stamp answers the badges that SURVIVE it — the client
    // replaces its whole state from this response, not just the cleared lane.
    const narrowed = await admin
      .post("/api/me/bot-tasks/seen")
      .send({ agentId: other.id })
      .expect(200);
    expect(narrowed.body).toEqual({ total: 2, agents: { [agent.id]: 2 } });

    // Unknown body fields are ignored; no agentId clears the whole board.
    const all = await admin
      .post("/api/me/bot-tasks/seen")
      .send({ nope: 1 })
      .expect(200);
    expect(all.body).toEqual({ total: 0, agents: {} });
    expect(store.countUnseenBotTasks(otherOwnerId).total).toBe(1);

    // An ATTENDED turn settles UNSEEN too: only the client saying "I looked"
    // clears a badge, never the run that produced it.
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-16", message: "지금 해줘" })
      .expect(200);
    const afterTurn = await admin.get("/api/me/bot-tasks/unseen").expect(200);
    expect(afterTurn.body).toEqual({ total: 1, agents: { [agent.id]: 1 } });

    // The phase-1 feature gate holds on both.
    const plain = request.agent(app);
    await signup(plain, "plain").expect(201);
    await plain.get("/api/me/bot-tasks/unseen").expect(403);
    await plain.post("/api/me/bot-tasks/seen").expect(403);
  });

  it("cancels queued and parked tasks, stops a running one, and 409s terminals", async () => {
    const { app, admin, store, ownerId, agent, avatarId } = await bootWithBot("cancel");

    // Unknown id and another owner's row are both the same 404 shape.
    await admin.post("/api/me/bot-tasks/ghost/cancel").expect(404);
    const other = request.agent(app);
    await signup(other, "other").expect(201);
    const otherId = store.getUserByUsername("other")!.id;
    const otherTask = store.createBotTask({
      ownerUserId: otherId,
      agentId: agent.id,
      conversationId: "bt-x",
      title: "남의 것",
      requestText: "남의 것",
      status: "queued",
    });
    const notMine = await admin
      .post(`/api/me/bot-tasks/${otherTask.id}/cancel`)
      .expect(404);
    expect(notMine.body.error).toContain("작업을 찾을 수 없습니다");

    const queued = store.createBotTask({
      ownerUserId: ownerId,
      agentId: agent.id,
      conversationId: "bt-10",
      title: "대기",
      requestText: "대기",
      status: "queued",
    });
    const cancelledQueued = await admin
      .post(`/api/me/bot-tasks/${queued.id}/cancel`)
      .expect(200);
    expect(cancelledQueued.body.task.status).toBe("cancelled");
    // A terminal row refuses a second cancel.
    const again = await admin
      .post(`/api/me/bot-tasks/${queued.id}/cancel`)
      .expect(409);
    expect(again.body.error).toContain("이미 종료된 작업입니다");

    // A parked (waiting_input) task is abandonable the same way.
    H.script.push((req) => {
      store.setBotTaskReport(req.personalAgent!.taskId!, {
        outcome: "need_input",
        summary: "어느 쪽으로 할까요?",
      });
    });
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-11", message: "물어봐줘" })
      .expect(200);
    const parked = store.listBotTasksForConversation("bt-11")[0];
    expect(parked.status).toBe("waiting_input");
    const abandoned = await admin
      .post(`/api/me/bot-tasks/${parked.id}/cancel`)
      .expect(200);
    expect(abandoned.body.task).toMatchObject({
      status: "cancelled",
      // The question stays on the card so the abandoned work still reads.
      pendingQuestion: "어느 쪽으로 할까요?",
    });

    // A RUNNING task is stopped through the run registry: the route answers
    // `stopping`, and the turn's own finalize writes the cancelled row.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.script.push(() => held);
    const streaming = admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "bt-12", message: "오래 걸리는 일" })
      .then((r) => r);
    const running = await until(() => {
      const [row] = store.listBotTasksForConversation("bt-12");
      return row?.status === "running" ? row : null;
    }, "the running task");
    expect(running.runId).not.toBeNull();
    const stopping = await admin
      .post(`/api/me/bot-tasks/${running.id}/cancel`)
      .expect(200);
    expect(stopping.body.stopping).toBe(true);
    release();
    await streaming;
    expect(store.getBotTask(running.id)!.status).toBe("cancelled");
  });
});
