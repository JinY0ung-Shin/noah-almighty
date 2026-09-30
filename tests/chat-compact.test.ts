import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig, ExternalAgentConfig, SdkResumePoint } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

/**
 * Native `/compact` over the HTTP surface. The agent layer is mocked (the
 * chat-rewind pattern) so a test can script what the CLI's compact run reports
 * — the compact event, the fork's session id, the last chain entry — and read
 * back the exact AgentRequest the route built.
 */
type Step = (
  req: AgentRequest,
  events: AgentEvents,
  abort: AbortController | undefined,
) => Promise<Partial<AgentResponse> | void> | Partial<AgentResponse> | void;

const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  events: [] as AgentEvents[],
  script: [] as Step[],
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
      H.events.push(events);
      const n = H.requests.length;
      const step = H.script.shift();
      const override = step
        ? await step(agentRequest, events, abortController)
        : (() => {
            events.onSessionId?.(`sess-run-${n}`);
            events.onResumePoint?.({ sessionId: `sess-run-${n}`, uuid: `uuid-run-${n}` });
            events.onDelta?.(`[mock] ${agentRequest.message}`);
          })();
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: agentRequest.compact ? "" : `[mock] ${agentRequest.message}`,
        ...(override ?? {}),
      } satisfies AgentResponse;
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices, expandChatSlashCommand } from "../src/server/app.js";
import { compactResultText } from "../src/server/routes/chat.js";
import { cancelRun, getActiveRunForConversation } from "../src/server/agent/runRegistry.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import type { Store } from "../src/server/store.js";

let tempDir: string;
const getTempDir = withTempDir("compact", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
  H.events.length = 0;
  H.script.length = 0;
});

function boot(overrides: Partial<AppConfig> = {}) {
  const services = createServices({ dataDir: tempDir, agentRuntime: "claude", sessionSecret: "test", ...overrides });
  return { app: createApp(services), store: services.store };
}
type Booted = ReturnType<typeof boot>;

async function newOwner(t: Booted, username = "owner") {
  const agent = request.agent(t.app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

function dbOf(store: Store) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function resumePointOf(store: Store, messageId: string) {
  return dbOf(store)
    .prepare("SELECT sdk_session_id AS sessionId, sdk_uuid AS uuid FROM messages WHERE id = ?")
    .get(messageId) as { sessionId: string | null; uuid: string | null };
}

/** A thread with one finished turn and the SDK session it left. */
function seedThread(store: Store, ownerId: string, conversationId: string, sessionId: string | null = "sess-a") {
  store.touchConversation(ownerId, conversationId, ownerId, "첫 질문");
  const u1 = store.addMessage(conversationId, { role: "user", content: "첫 질문" });
  const point: SdkResumePoint = { sessionId: sessionId ?? "sess-a", uuid: "uuid-a1" };
  const a1 = store.addMessage(conversationId, { role: "assistant", content: "첫 답", resumePoint: point });
  if (sessionId) store.setAgentSessionId(ownerId, conversationId, sessionId);
  return { u1, a1 };
}

/** The compact run the spike observed: a fork session, the boundary, the last chain entry. */
const compactRun =
  (event: Parameters<NonNullable<AgentEvents["onCompact"]>>[0] | null, usage?: AgentResponse["usage"]): Step =>
  (_req, events) => {
    events.onSessionId?.("sess-fork");
    events.onResumePoint?.({ sessionId: "sess-fork", uuid: "boundary-uuid" });
    if (event) events.onCompact?.(event);
    events.onResumePoint?.({ sessionId: "sess-fork", uuid: "stdout-uuid" });
    return usage ? { usage } : undefined;
  };

const SUCCESS_TAIL = "이후 대화는 요약본을 바탕으로 이어집니다.";

describe("/compact — slash expansion", () => {
  it("turns the command into a native compaction and keeps the literal", () => {
    expect(expandChatSlashCommand("/compact")).toEqual({ message: "/compact", compact: { instructions: "" } });
    expect(expandChatSlashCommand("  /compact 결정 사항 위주로  ")).toEqual({
      message: "  /compact 결정 사항 위주로  ",
      compact: { instructions: "결정 사항 위주로" },
    });
    expect(expandChatSlashCommand("/COMPACT")).toMatchObject({ compact: { instructions: "" } });
    expect(expandChatSlashCommand("/compacting 이 뭐야").compact).toBeUndefined();
    expect(expandChatSlashCommand("compact 해줘").compact).toBeUndefined();
  });
});

describe("/compact — the bubble text", () => {
  it("shows the token figures only when the summary shrank, and says a too-short thread in Korean", () => {
    expect(compactResultText({ ok: true, trigger: "manual", preTokens: 18_049, postTokens: 1_378 })).toBe(
      `대화 맥락을 요약해 정리했습니다 (약 18.0K → 1.4K 토큰). ${SUCCESS_TAIL}`,
    );
    // Re-compacting a short thread can GROW it — no "1.4K → 2.0K" boast.
    expect(compactResultText({ ok: true, trigger: "manual", preTokens: 1_400, postTokens: 2_000 })).toBe(
      `대화 맥락을 요약해 정리했습니다. ${SUCCESS_TAIL}`,
    );
    expect(compactResultText({ ok: false, error: "Not enough messages to compact." })).toBe(
      "아직 정리할 만큼 대화가 쌓이지 않아 맥락을 정리하지 않았습니다.",
    );
    expect(compactResultText({ ok: false, error: "boom" })).toBe("맥락 정리에 실패했습니다: boom");
    expect(compactResultText(null)).toBe("맥락 정리에 실패했습니다.");
  });
});

describe("/compact — the run", () => {
  it("runs the command against the conversation's session, with no steer channel and no rewind", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c1");
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 18049, postTokens: 1378 }));

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c1", message: "/compact 결정 사항 위주로" })
      .expect(200);

    expect(H.requests).toHaveLength(1);
    const sent = H.requests[0];
    expect(sent.compact).toEqual({ instructions: "결정 사항 위주로" });
    expect(sent.resumeSessionId).toBe("sess-a");
    expect(sent.resumeSessionAt).toBeUndefined();
    expect(sent.rewind).toBeUndefined();
    expect(H.events[0].steers).toBeUndefined();
  });

  it("persists the pair, moves onto the fork's session and stamps the run's last chain entry", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c2");
    const usage = { inputTokens: 14671, outputTokens: 0, contextWindow: 200000 };
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 18049, postTokens: 1378 }, usage));

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c2", message: "/compact" })
      .expect(200);

    const rows = t.store.listMessages(owner.id, "c2");
    expect(rows.slice(2).map((m) => [m.role, m.content])).toEqual([
      ["user", "/compact"],
      ["assistant", `대화 맥락을 요약해 정리했습니다 (약 18.0K → 1.4K 토큰). ${SUCCESS_TAIL}`],
    ]);
    // The context badge reads the post-compaction occupancy off the row.
    expect(rows[3].response?.usage).toMatchObject(usage);
    expect(t.store.getAgentSessionId(owner.id, "c2")).toBe("sess-fork");
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: "sess-fork", uuid: "stdout-uuid" });
  });

  it("states figures only when the event carried both, with plain digits under a thousand", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c3");
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 950, postTokens: 120 }));
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 2400 }));
    const compact = () =>
      owner.agent.post("/api/chat/stream").send({ avatarId: owner.id, conversationId: "c3", message: "/compact" }).expect(200);

    await compact();
    await compact();
    const answers = t.store.listMessages(owner.id, "c3").filter((m) => m.role === "assistant").slice(1);
    expect(answers.map((m) => m.content)).toEqual([
      `대화 맥락을 요약해 정리했습니다 (약 950 → 120 토큰). ${SUCCESS_TAIL}`,
      `대화 맥락을 요약해 정리했습니다. ${SUCCESS_TAIL}`,
    ]);
  });

  it("keeps the old session and stamps the kept point when the compaction failed or never happened", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c4");
    H.script.push(compactRun({ ok: false, error: "Not enough messages to compact." }));
    H.script.push(compactRun(null));
    const compact = () =>
      owner.agent.post("/api/chat/stream").send({ avatarId: owner.id, conversationId: "c4", message: "/compact" }).expect(200);

    await compact();
    await compact();
    const rows = t.store.listMessages(owner.id, "c4").slice(2);
    expect(rows.map((m) => m.content)).toEqual([
      "/compact",
      "아직 정리할 만큼 대화가 쌓이지 않아 맥락을 정리하지 않았습니다.",
      "/compact",
      "맥락 정리에 실패했습니다.",
    ]);
    // Both runs compacted nothing the conversation moved onto: the fork is
    // abandoned, and the next ordinary turn resumes the original session. Each
    // failed row carries the point its /compact row sat on (the previous
    // answer's, in that untouched session) — chained through the first failure.
    expect(t.store.getAgentSessionId(owner.id, "c4")).toBe("sess-a");
    expect(resumePointOf(t.store, rows[1].id)).toEqual({ sessionId: "sess-a", uuid: "uuid-a1" });
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: "sess-a", uuid: "uuid-a1" });
  });

  it("keeps a rewind right after a failed compaction exact", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c7");
    H.script.push(compactRun({ ok: false, error: "compaction failed" }));
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c7", message: "/compact" })
      .expect(200);
    // An ordinary turn after it resumes the original session as usual…
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c7", message: "다음 질문" })
      .expect(200);
    expect(H.requests[1].resumeSessionId).toBe("sess-a");
    const next = t.store.listMessages(owner.id, "c7").find((m) => m.content === "다음 질문")!;

    // …and editing it resumes EXACTLY where the failed /compact sat, not from text.
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c7", message: "고친 질문", rewindFromMessageId: next.id })
      .expect(200);
    expect(H.requests[2]).toMatchObject({ resumeSessionId: "sess-a", resumeSessionAt: "uuid-a1" });
  });

  it("stamps a failed compaction with nothing when the row before it recorded no point", async () => {
    const t = boot();
    const owner = await newOwner(t);
    t.store.touchConversation(owner.id, "c8", owner.id, "첫 질문");
    t.store.addMessage("c8", { role: "user", content: "첫 질문" });
    t.store.addMessage("c8", { role: "assistant", content: "첫 답" });
    t.store.setAgentSessionId(owner.id, "c8", "sess-a");
    H.script.push(compactRun({ ok: false, error: "compaction failed" }));
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c8", message: "/compact" })
      .expect(200);
    const last = t.store.listMessages(owner.id, "c8").at(-1)!;
    expect(last.content).toBe("맥락 정리에 실패했습니다: compaction failed");
    expect(resumePointOf(t.store, last.id)).toEqual({ sessionId: null, uuid: null });
  });

  it("words a thrown run as a failed compaction and never drops the session", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c5");
    H.script.push(() => {
      throw new Error("Claude Code returned an error result: No conversation found with session ID: sess-a");
    });
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c5", message: "/compact" })
      .expect(200);
    const last = t.store.listMessages(owner.id, "c5").at(-1)!;
    expect(last.content).toBe(
      "맥락 정리에 실패했습니다: Claude Code returned an error result: No conversation found with session ID: sess-a",
    );
    expect(t.store.getAgentSessionId(owner.id, "c5")).toBe("sess-a");
    expect(resumePointOf(t.store, last.id)).toEqual({ sessionId: "sess-a", uuid: "uuid-a1" });

    // A stopped compaction ran on a fork too: the session stays.
    H.script.push(
      (_req, _events, abort) =>
        new Promise<never>((_resolve, reject) => {
          abort?.signal.addEventListener("abort", () => reject(new Error("Claude Code process aborted by user")));
          const run = getActiveRunForConversation(owner.id, "c5");
          if (run) cancelRun(run.runId, owner.id);
        }),
    );
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c5", message: "/compact" })
      .expect(200);
    const stopped = t.store.listMessages(owner.id, "c5").at(-1)!;
    expect(stopped.content).toBe("(중지됨)");
    expect(t.store.getAgentSessionId(owner.id, "c5")).toBe("sess-a");
    // Chained: the row before this /compact is the failed one, which kept the point.
    expect(resumePointOf(t.store, stopped.id)).toEqual({ sessionId: "sess-a", uuid: "uuid-a1" });
  });
});

describe("/compact — refusals", () => {
  it("refuses before any write: no session yet, images, or an edit into /compact", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const send = (conversationId: string, body: object) =>
      owner.agent.post("/api/chat/stream").send({ avatarId: owner.id, conversationId, message: "/compact", ...body });

    // A thread whose last turn was stopped or failed lost its session: sending
    // one message restores it, and the refusal says so.
    const STOPPED = "지금은 정리할 대화 맥락이 없습니다. 메시지를 하나 보낸 뒤 다시 시도해 주세요.";
    seedThread(t.store, owner.id, "fresh", null);
    expect((await send("fresh", {}).expect(400)).body.error).toBe(STOPPED);
    // A brand-new conversation simply has nothing yet.
    expect((await send("never-used", {}).expect(400)).body.error).toBe("아직 정리할 대화 맥락이 없습니다.");

    const { u1 } = seedThread(t.store, owner.id, "has-session");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect(
      (await send("has-session", { images: [{ id: "i1", data: `data:image/png;base64,${png}` }] }).expect(400)).body.error,
    ).toBe("/compact에는 이미지를 첨부할 수 없습니다.");
    expect((await send("has-session", { rewindFromMessageId: u1.id }).expect(400)).body.error).toBe(
      "/compact는 수정해서 보낼 수 없습니다. 새 메시지로 보내 주세요.",
    );

    // A session cleared DURING the turn's await (another turn ended in between)
    // is caught by the re-read before the first write.
    const { store } = t;
    const repoResolve = await import("../src/server/activeRepoResolve.js");
    const spy = vi.spyOn(repoResolve, "resolveActiveWorkspaceRepo").mockImplementationOnce(async () => {
      store.setAgentSessionId(owner.id, "has-session", null);
      return { kind: "none" };
    });
    expect((await send("has-session", {}).expect(400)).body.error).toBe(STOPPED);
    spy.mockRestore();

    expect(H.requests).toHaveLength(0);
    expect(t.store.listMessages(owner.id, "fresh")).toHaveLength(2);
    expect(t.store.listMessages(owner.id, "has-session")).toHaveLength(2);
    expect(t.store.listMessages(owner.id, "never-used")).toHaveLength(0);
  });

  it("refuses an external avatar's conversation", async () => {
    const external: ExternalAgentConfig = {
      id: "research",
      displayName: "Research Agent",
      alias: "리서처",
      bio: "외부 조사 에이전트",
      persona: "",
      intro: "",
      hashtags: [],
      endpoint: "http://127.0.0.1:9/v1/agents/messages",
      agent: "claude",
      model: "gateway-model",
      system: "",
      apiKey: "gateway-secret",
    };
    const t = boot({ externalAgents: [external] });
    const viewer = await newOwner(t, "viewer");
    const group = t.store.createGroup({ name: "ext-viewers" });
    t.store.addGroupMember(group.id, viewer.id);
    external.visibleToGroupIds = [group.id];

    const res = await viewer.agent
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "ext-1", message: "/compact" })
      .expect(400);
    expect(res.body.error).toBe("외부 아바타 대화에서는 /compact를 사용할 수 없습니다.");
    expect(H.requests).toHaveLength(0);
  });

  it("refuses a mid-turn /compact before it can reach the CLI", async () => {
    const t = boot();
    const owner = await newOwner(t);
    for (const text of ["/compact", "/compact 결정 위주로", "  /COMPACT  "]) {
      const res = await owner.agent.post("/api/chat/runs/any-run/message").send({ message: text }).expect(400);
      expect(res.body.error).toBe("/compact는 응답이 끝난 뒤에 보내 주세요.");
    }
    // Not the command: an ordinary steer (here: no such run).
    await owner.agent.post("/api/chat/runs/any-run/message").send({ message: "/compacting 은 뭐야" }).expect(404);
  });

  it("refuses a regenerate of a /compact row, but lets an edit turn it into an ordinary message", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seedThread(t.store, owner.id, "c6");
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 18049, postTokens: 1378 }));
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c6", message: "/compact" })
      .expect(200);

    const regen = await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c6", message: "/compact", regenerate: true })
      .expect(400);
    expect(regen.body.error).toBe("/compact는 다시 생성할 수 없습니다.");

    // The edit's kept history ends BEFORE the compaction, so it resumes the
    // original (never compacted) session at the previous answer.
    const compactRow = t.store.listMessages(owner.id, "c6").find((m) => m.content === "/compact")!;
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "c6", message: "다른 질문", rewindFromMessageId: compactRow.id })
      .expect(200);
    const sent = H.requests.at(-1)!;
    expect(sent.compact).toBeUndefined();
    expect(sent.resumeSessionId).toBe("sess-a");
    expect(sent.resumeSessionAt).toBe("uuid-a1");
    expect(t.store.listMessages(owner.id, "c6").map((m) => m.content)).toEqual([
      "첫 질문",
      "첫 답",
      "다른 질문",
      "[mock] 다른 질문",
    ]);
  });

  it("never queues a /compact behind a busy bot, and never touches a parked task", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const agent = t.store.createPersonalAgent(owner.id, { displayName: "리서치 봇" });
    const avatarId = personalAgentAvatarId(owner.id, agent.id);
    const send = (message: string) =>
      owner.agent.post("/api/chat/stream").send({ avatarId, conversationId: "bot", message });

    // Turn 1: the bot parks on a question (and leaves a session).
    H.script.push((req, events) => {
      events.onSessionId?.("sess-bot");
      t.store.setBotTaskReport(req.personalAgent!.taskId!, { outcome: "need_input", summary: "어느 쪽?" });
    });
    await send("정리해줘").expect(200);
    const [parked] = t.store.listBotTasksForConversation("bot");
    expect(parked.status).toBe("waiting_input");

    // A /compact now opens no card and leaves the parked question alone.
    H.script.push(compactRun({ ok: true, trigger: "manual", preTokens: 3000, postTokens: 900 }));
    await send("/compact").expect(200);
    expect(t.store.listBotTasksForConversation("bot")).toEqual([parked]);
    expect(H.requests[1].personalAgent?.taskId).toBeUndefined();

    // While a turn runs, a /compact is refused outright — never queued.
    let release: () => void = () => {};
    H.script.push(() => new Promise<void>((resolve) => (release = resolve)));
    const running = send("A안으로").then((r) => r);
    for (let i = 0; i < 200 && !getActiveRunForConversation(owner.id, "bot"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const busy = await send("/compact").expect(409);
    expect(busy.body.error).toBe("봇이 작업 중일 때는 /compact를 쓸 수 없어요. 작업이 끝난 뒤 다시 시도해 주세요.");
    expect(t.store.countQueuedBotTasks("bot")).toBe(0);
    release();
    await running;
  });
});
