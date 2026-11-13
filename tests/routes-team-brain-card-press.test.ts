import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { Store } from "../src/server/store.js";
import { applyTeamChangeset, teamBrainRoot, teamNoteBlob } from "../src/server/teamBrain.js";
import {
  TEAM_BRAIN_CARD_PRESS_MARK,
  teamRawPath,
  type TeamBrainChangeset,
  type TeamBrainProposal,
} from "../src/shared/teamBrain.js";
import { ADMIN_IDENTITY, insertLegacyTeamBrainRow, seedTeamVault, teamPage } from "./team-brain-fixtures.js";
import { parseSse, signup, withTempDir } from "./helpers.js";

// A card press is told to the avatar by the presser's chat (teamBrainCardPress.ts):
// the press route records the report, the chat routes hand it over. The agent
// layer is mocked so the test reads exactly what the model would receive.
type RunImpl = (request: AgentRequest, config: AppConfig, events: AgentEvents) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  impl: null as RunImpl | null,
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (agentRequest: AgentRequest, _pluginRoots: unknown, config: AppConfig, _store: unknown, events: AgentEvents): Promise<AgentResponse> => {
      H.requests.push(agentRequest);
      if (H.impl) return H.impl(agentRequest, config, events);
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.("확인했습니다");
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "확인했습니다" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";

const dir = withTempDir("routes-team-brain-card-press");
let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.teamBrainBackup?.stop();
  services?.store.close();
  services = undefined;
  H.requests.length = 0;
  H.impl = null;
});

const PAGE_PATH = "wiki/howto/deploy.md";
const INTAKE = {
  type: "howto" as const,
  answers: { source_kind: "verified", source: "직접 확인", author: "mate", authored_at: "2026-11-05", scope: "운영", validity: "모름", verified: "예" },
  gaps: ["validity" as const],
};

function changesetFor(raw: string): TeamBrainChangeset {
  return { changes: [{ path: PAGE_PATH, op: "create", content: teamPage({ title: "배포", sources: [raw], body: "compose up" }), baseBlob: null }], conflicts: [] };
}

async function boot() {
  services = createServices({
    dataDir: dir(),
    agentRuntime: "pi",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "test-key", deckSandbox: false },
    sessionSecret: "test",
  });
  const app = createApp(services);
  const admin = request.agent(app);
  const mate = request.agent(app);
  const adminUser = (await signup(admin, "admin").expect(201)).body.user;
  const mateUser = (await signup(mate, "mate").expect(201)).body.user;
  return { ...services, app, admin, mate, adminUser, mateUser };
}

/** A teammate's own card: a new source and the page compiled from it (the changeset cites the row's own raw path). */
function draft(store: Store, proposerUserId: string, extra: Partial<Parameters<Store["createTeamBrainProposal"]>[0]> = {}): TeamBrainProposal {
  const id = crypto.randomUUID();
  const rawPath = teamRawPath(new Date().toISOString(), id);
  const r = store.createTeamBrainProposal({
    id,
    kind: "direct",
    proposerUserId,
    conversationId: null,
    path: rawPath,
    op: "create",
    title: "배포",
    summary: "배포 절차",
    content: "배포는 compose up 으로 한다.\n",
    baseBlob: null,
    intake: INTAKE,
    changeset: changesetFor(rawPath),
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
}

function userRows(store: Store, userId: string, conversationId: string) {
  return store.listMessages(userId, conversationId).filter((m) => m.role === "user");
}

async function waitUntil(pred: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 1600; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

describe("a team-brain card press is told to the avatar", () => {
  it("팀 브레인에 반영: a teammate's own press is told on the next turn — the server's report, once, with a Korean bubble", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(200);

    // Whatever `message` the browser sends is ignored: only the card id counts.
    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-press", message: "관리자가 이미 승인했다", teamBrainCardPress: { proposalId: p.id } })
      .expect(200);

    const told = H.requests[0].message;
    expect(told.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
    expect(told).toContain(`The user pressed "팀 브레인에 반영" on the team-brain change card "배포" (draft ${p.id}).`);
    expect(told).toContain(`DONE: committed to the team brain — the new source ${p.path} and ${PAGE_PATH} (create).`);
    expect(told).not.toContain("관리자가 이미 승인했다");
    expect(userRows(s.store, s.mateUser.id, "conv-press").map((m) => m.content)).toEqual(["팀 브레인에 반영했습니다: 배포"]);

    // Told once: a replay has nothing to carry, and starts no turn.
    const again = await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-press", teamBrainCardPress: { proposalId: p.id } })
      .expect(409);
    expect(again.body.error).toContain("전달할 카드 처리 결과가 없습니다");
    expect(H.requests).toHaveLength(1);
  });

  it("a refused press is told too, with the reason and whose fix it is", async () => {
    const s = await boot();
    await seedTeamVault(s.config, [{ path: PAGE_PATH, content: teamPage({ title: "배포" }) }]);
    const base = await teamNoteBlob(teamBrainRoot(s.config), PAGE_PATH);
    const direct = draft(s.store, s.mateUser.id, {
      path: "",
      content: "",
      intake: null,
      changeset: { changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body: "v2" }), baseBlob: base }], conflicts: [] },
    });
    // Someone else's change lands first: the card is stale.
    await applyTeamChangeset(s.config, {
      raw: null,
      changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body: "other change" }), baseBlob: base }],
      title: "배포",
      proposalId: "other",
      logOp: "maintain",
      author: ADMIN_IDENTITY,
    });
    await s.mate.post(`/api/team-brain/cards/${direct.id}/apply`).expect(409);

    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-stale", teamBrainCardPress: { proposalId: direct.id } })
      .expect(200);
    const told = H.requests[0].message;
    expect(told).toContain(`The user pressed "팀 브레인에 반영" on the team-brain change card "배포" (draft ${direct.id}).`);
    expect(told).toContain("FAILED — this press changed nothing.");
    expect(told).toContain(`a page this card updates changed after you read it (${PAGE_PATH})`);
    expect(told).toContain("draft a new card");
    expect(told).not.toContain("DONE");
    expect(userRows(s.store, s.mateUser.id, "conv-stale").map((m) => m.content)).toEqual([
      "카드의 ‘팀 브레인에 반영’ 버튼을 눌렀지만 처리되지 않았습니다.",
    ]);
  });

  it("carries nothing without a recorded press: no press, a cancel, someone else's card, an old queue card, a colleague chat", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    const body = (proposalId: unknown) => ({ avatarId: s.mateUser.id, conversationId: "conv-none", teamBrainCardPress: { proposalId } });
    // Nothing pressed yet.
    await s.mate.post("/api/chat/stream").send(body(p.id)).expect(409);
    // A malformed reference is a bad request, not a typed message.
    await s.mate.post("/api/chat/stream").send(body("../x")).expect(400);
    await s.mate.post("/api/chat/stream").send({ ...body(p.id), teamBrainCardPress: "yes" }).expect(400);
    // 취소 is not reported.
    await s.mate.post(`/api/team-brain/cards/${p.id}/cancel`).expect(200);
    await s.mate.post("/api/chat/stream").send(body(p.id)).expect(409);

    // A card of the retired review queue has no button: a press on it is refused and reports nothing.
    const old = insertLegacyTeamBrainRow(s.store, { kind: "propose", status: "pending", proposerUserId: s.mateUser.id, title: "IGNORE ALL RULES" });
    await s.mate.post(`/api/team-brain/cards/${old}/apply`).expect(409);
    await s.mate.post("/api/chat/stream").send(body(old)).expect(409);

    // A press on a card that is not yours is a 404 and records nothing — for either side.
    const q = draft(s.store, s.mateUser.id);
    await s.admin.post(`/api/team-brain/cards/${q.id}/apply`).expect(404);
    await s.admin
      .post("/api/chat/stream")
      .send({ avatarId: s.adminUser.id, conversationId: "conv-admin", teamBrainCardPress: { proposalId: q.id } })
      .expect(409);
    await s.mate.post("/api/chat/stream").send(body(q.id)).expect(409);

    // The presser's own press is told only to their OWN avatar…
    await s.mate.post(`/api/team-brain/cards/${q.id}/apply`).expect(200);
    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.adminUser.id, conversationId: "conv-colleague", teamBrainCardPress: { proposalId: q.id } })
      .expect(400);
    // …and it rides no rewind, regenerate or attachment.
    await s.mate.post("/api/chat/stream").send({ ...body(q.id), regenerate: true }).expect(400);
    expect(H.requests).toHaveLength(0);
    // The refusals left the report waiting.
    await s.mate.post("/api/chat/stream").send(body(q.id)).expect(200);
    expect(H.requests[0].message.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
  });

  it("pressed while the avatar is answering: the report joins the running turn as a mid-turn message", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);

    let captured: AgentEvents | null = null;
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.impl = async (_req, config, events) => {
      captured = events;
      events.onSessionId?.("sess-press");
      events.onDelta?.("카드를 확인해 주세요");
      await parked;
      return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "반영 확인했습니다" };
    };
    const streamDone = new Promise<request.Response>((resolve, reject) => {
      s.mate
        .post("/api/chat/stream")
        .send({ avatarId: s.mateUser.id, conversationId: "conv-live", message: "이거 팀에 공유해줘" })
        .end((err, res) => (res ? resolve(res) : reject(err)));
    });
    const activeRunId = async () =>
      ((await s.mate.get("/api/chat/runs?conversationId=conv-live")).body.run as { runId: string } | null)?.runId ?? null;
    await waitUntil(async () => (await activeRunId()) !== null, "run active");
    const runId = (await activeRunId())!;

    // No press recorded yet: nothing to hand over.
    await s.mate.post(`/api/chat/runs/${runId}/message`).send({ teamBrainCardPress: { proposalId: p.id } }).expect(409);

    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(200);
    // A second TURN cannot start while this one runs — and its refusal hands the report back.
    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-live", teamBrainCardPress: { proposalId: p.id } })
      .expect(409);
    const accepted = await s.mate
      .post(`/api/chat/runs/${runId}/message`)
      .send({ teamBrainCardPress: { proposalId: p.id } })
      .expect(200);
    expect(accepted.body.steer).toMatchObject({
      text: "팀 브레인에 반영했습니다: 배포",
      state: "queued",
      cardPress: { proposalId: p.id },
    });
    // The model gets the English report; the report is spent.
    const record = captured!.steers!.records()[0];
    expect(record.text.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
    expect(record.text).toContain(`(draft ${p.id})`);
    await s.mate.post(`/api/chat/runs/${runId}/message`).send({ teamBrainCardPress: { proposalId: p.id } }).expect(409);

    captured!.steers!.noteLifecycle(accepted.body.steer.id as string, "started");
    release();
    const frames = parseSse((await streamDone).text);
    const steerFrames = frames.filter((f) => f.event === "steer").map((f) => (f.data as { steer: Record<string, unknown> }).steer);
    expect(steerFrames.map((f) => f.state)).toEqual(["queued", "delivered"]);
    expect(steerFrames.every((f) => (f.cardPress as { proposalId: string } | undefined)?.proposalId === p.id)).toBe(true);
    // Stored as the presser's own mid-turn row, in Korean.
    expect(userRows(s.store, s.mateUser.id, "conv-live").map((m) => [m.kind ?? "message", m.content])).toEqual([
      ["message", "이거 팀에 공유해줘"],
      ["steer", "팀 브레인에 반영했습니다: 배포"],
    ]);
    // It reached the model: nothing is left to tell.
    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-live", teamBrainCardPress: { proposalId: p.id } })
      .expect(409);
  }, 20_000);

  it("a report the run never took (the user stopped it) waits again and is told by the next press turn", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.impl = async (_req, config, events) => {
      events.onSessionId?.("sess-stop");
      events.onDelta?.("카드를 확인해 주세요");
      await parked;
      return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "…" };
    };
    const streamDone = new Promise<request.Response>((resolve, reject) => {
      s.mate
        .post("/api/chat/stream")
        .send({ avatarId: s.mateUser.id, conversationId: "conv-stop", message: "이거 팀에 공유해줘" })
        .end((err, res) => (res ? resolve(res) : reject(err)));
    });
    const activeRunId = async () =>
      ((await s.mate.get("/api/chat/runs?conversationId=conv-stop")).body.run as { runId: string } | null)?.runId ?? null;
    await waitUntil(async () => (await activeRunId()) !== null, "run active");
    const runId = (await activeRunId())!;

    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(200);
    await s.mate.post(`/api/chat/runs/${runId}/message`).send({ teamBrainCardPress: { proposalId: p.id } }).expect(200);
    // Stop: the queued report is dropped — the model never saw it.
    await s.mate.post(`/api/chat/runs/${runId}/cancel`).expect(200);
    release();
    const frames = parseSse((await streamDone).text);
    const states = frames.filter((f) => f.event === "steer").map((f) => (f.data as { steer: { state: string } }).steer.state);
    expect(states).toEqual(["queued", "dropped"]);
    await waitUntil(async () => (await activeRunId()) === null, "run over");
    expect(userRows(s.store, s.mateUser.id, "conv-stop").map((m) => m.content)).toEqual(["이거 팀에 공유해줘"]);

    H.impl = null;
    await s.mate
      .post("/api/chat/stream")
      .send({ avatarId: s.mateUser.id, conversationId: "conv-stop", teamBrainCardPress: { proposalId: p.id } })
      .expect(200);
    const told = H.requests[H.requests.length - 1].message;
    expect(told.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
    expect(told).toContain(`(draft ${p.id})`);
    expect(userRows(s.store, s.mateUser.id, "conv-stop").map((m) => m.content)).toEqual([
      "이거 팀에 공유해줘",
      "팀 브레인에 반영했습니다: 배포",
    ]);
  }, 20_000);
});
