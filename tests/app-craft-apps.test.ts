import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import type { AgentEvents, CraftPreviewResult } from "../src/server/agent/events.js";
import { parseSse, signup, withTempDir } from "./helpers.js";
import { startFakeRunner, TINY_PNG, type FakeRunner } from "./fake-craft-runner.js";
import { MAX_CRAFT_PREVIEWS_PER_MESSAGE } from "../src/server/chatFiles.js";
import { __resetCraftRunnerForTests, craftSessionId, refreshCraftRunnerHealth } from "../src/server/craftRunner.js";

// Coverage: the HTTP half of Craft apps — the admin switch + audit, the
// admin-only `craftApps` field of GET /api/me, the chat route's
// onCraftPreview (cards + hidden slides + `craft_preview` SSE, the per-run
// cap, the interactive-own-avatar gate) and the purge cascade on conversation
// delete. The agent layer is mocked; tests/agent-craft-apps.test.ts covers it.

type RunImpl = (request: AgentRequest, events: AgentEvents, config: AppConfig) => Promise<AgentResponse>;
const H = vi.hoisted(() => ({ impl: null as RunImpl | null, requests: [] as AgentRequest[], events: [] as AgentEvents[] }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (agentRequest: AgentRequest, _roots: unknown, config: AppConfig, _store: unknown, events: AgentEvents): Promise<AgentResponse> => {
      H.requests.push(agentRequest);
      H.events.push(events);
      if (H.impl) return H.impl(agentRequest, events, config);
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "ok" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";

const SECRET = "control-secret";
let tempDir: string;
const getTempDir = withTempDir("app-craft-apps", () => {
  tempDir = getTempDir();
  H.impl = null;
  H.requests.length = 0;
  H.events.length = 0;
  __resetCraftRunnerForTests();
});
let runner: FakeRunner | null = null;
afterEach(async () => {
  await runner?.close();
  runner = null;
});

function boot(opts: { configured?: boolean } = {}) {
  const services = createServices({
    dataDir: path.join(tempDir, "data"),
    agentRuntime: "claude",
    sessionSecret: "test",
    ...(opts.configured === false ? {} : { craftExchangeDir: path.join(tempDir, "ex"), craftControlSecret: SECRET }),
  });
  return { app: createApp(services), store: services.store, config: services.config };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

describe("Craft apps admin switch + GET /api/me", () => {
  it("PUT /api/admin/craft-apps: admin only, validated, audited, reported by /api/admin/system", async () => {
    const { app, store } = boot();
    const admin = await newUser(app, "root");
    const member = await newUser(app, "member");
    await member.agent.put("/api/admin/craft-apps").send({ enabled: true }).expect(403);
    await admin.agent.put("/api/admin/craft-apps").send({ enabled: "yes" }).expect(400);
    expect(store.isCraftAppsEnabled()).toBe(false);
    const system = (await admin.agent.get("/api/admin/system").expect(200)).body.system;
    expect(system.craftAppsEnabled).toBe(false);
    expect(system.craftApps).toMatchObject({ enabled: false, configured: true });

    const on = await admin.agent.put("/api/admin/craft-apps").send({ enabled: true }).expect(200);
    expect(on.body.craftAppsEnabled).toBe(true);
    expect(store.isCraftAppsEnabled()).toBe(true);
    await admin.agent.put("/api/admin/craft-apps").send({ enabled: false }).expect(200);
    expect(
      store.listAudit(admin.id, false).filter((row) => row.action === "set_craft_apps_enabled").map((row) => row.detail).sort(),
    ).toEqual(["craft apps = off", "craft apps = on"]);
  });

  it("GET /api/me: admins get craftApps (per-app status from the runner), everyone else does not", async () => {
    const { app, store, config } = boot();
    const admin = await newUser(app, "root");
    const member = await newUser(app, "member");
    store.setCraftAppsEnabled(true);
    // Runner down: enabled (switch + config) but every app unavailable.
    const down = (await admin.agent.get("/api/me").expect(200)).body;
    expect(down.craftApps).toMatchObject({ enabled: true, runnerReachable: false });
    expect(down.craftApps.apps.map((a: { status: string }) => a.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    runner = await startFakeRunner(path.join(tempDir, "ex"), {
      secret: SECRET,
      apps: [
        { id: "photocraft", version: "0.16.0", status: "ready", tools: 20 },
        { id: "figcraft", version: "0.11.2", status: "failed", error: "self-test failed", tools: 0 },
      ],
    });
    __resetCraftRunnerForTests();
    await refreshCraftRunnerHealth(config);
    const up = (await admin.agent.get("/api/me").expect(200)).body.craftApps;
    expect(up.apps).toEqual([
      { id: "photocraft", status: "ready", version: "0.16.0" },
      { id: "vectorcraft", status: "unavailable" },
      { id: "designcraft", status: "unavailable" },
      { id: "figcraft", status: "failed", version: "0.11.2" },
    ]);
    expect((await member.agent.get("/api/me").expect(200)).body.craftApps).toBeUndefined();
  });

  it("not configured → enabled:false even with the switch on", async () => {
    const { app, store } = boot({ configured: false });
    const admin = await newUser(app, "root");
    store.setCraftAppsEnabled(true);
    expect((await admin.agent.get("/api/me").expect(200)).body.craftApps).toMatchObject({ enabled: false, configured: false });
  });
});

describe("chat route: Craft previews", () => {
  const previewImpl =
    (count: number, results: CraftPreviewResult[]): RunImpl =>
    async (_request, events, config) => {
      for (let i = 0; i < count; i += 1) {
        if (!events.onCraftPreview) break;
        results.push(
          await events.onCraftPreview({
            app: "photocraft",
            tool: "render_preview",
            images: [{ buffer: TINY_PNG, mediaType: "image/png" }],
            anchor: 0,
          }),
        );
      }
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "done" };
    };

  it("own-avatar chat: card + hidden slide + craft_preview per image, capped per run, persisted on the message", async () => {
    const { app, store } = boot();
    const admin = await newUser(app, "root");
    const results: CraftPreviewResult[] = [];
    H.impl = previewImpl(MAX_CRAFT_PREVIEWS_PER_MESSAGE + 2, results);
    const res = await admin.agent
      .post("/api/chat/stream")
      .send({ avatarId: admin.id, conversationId: "conv-craft", message: "편집해줘" })
      .expect(200);
    const frames = parseSse(res.text);
    const previews = frames.filter((frame) => frame.event === "craft_preview");
    expect(previews).toHaveLength(MAX_CRAFT_PREVIEWS_PER_MESSAGE);
    const first = previews[0]!.data as { app: string; attachmentId: string; runId: string };
    expect(first.app).toBe("photocraft");
    const files = frames.filter((frame) => frame.event === "file").map((frame) => (frame.data as { attachment: { id: string; hidden?: boolean; parentId?: string; name?: string } }).attachment);
    const card = files.find((attachment) => attachment.id === first.attachmentId)!;
    expect(card.name).toBe("PhotoCraft 미리보기.png");
    expect(files.some((attachment) => attachment.hidden && attachment.parentId === card.id)).toBe(true);
    expect(results.at(-1)).toMatchObject({ published: [], skipped: 1 });
    const saved = store.listMessageAttachments(admin.id, "conv-craft").flat();
    expect(saved.filter((attachment) => attachment.kind === "file")).toHaveLength(MAX_CRAFT_PREVIEWS_PER_MESSAGE);
  });

  it("a colleague's chat with someone else's avatar gets no onCraftPreview", async () => {
    const { app } = boot();
    const admin = await newUser(app, "root");
    const other = await newUser(app, "other");
    await admin.agent.post("/api/admin/groups").send({ name: "G" }).expect(200).then(async (created) => {
      const groupId = created.body.group.id as string;
      for (const username of ["root", "other"]) {
        await admin.agent.post(`/api/admin/groups/${groupId}/members`).send({ username }).expect(200);
      }
    });
    await other.agent
      .post("/api/chat/stream")
      .send({ avatarId: admin.id, conversationId: "conv-colleague", message: "안녕" })
      .expect(200);
    expect(H.events.at(-1)?.onCraftPreview).toBeUndefined();
  });
});

describe("conversation delete → Craft purge", () => {
  it("purges a conversation that had a session (inbox exists), skips one that never did, at both delete routes", async () => {
    const { app } = boot();
    const admin = await newUser(app, "root");
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    for (const id of ["conv-a", "conv-b", "conv-c"]) {
      await admin.agent.post("/api/chat/stream").send({ avatarId: admin.id, conversationId: id, message: "hi" }).expect(200);
    }
    const inbox = (id: string) => path.join(tempDir, "ex", "inbox", craftSessionId(id));
    fs.mkdirSync(inbox("conv-a"), { recursive: true });
    fs.mkdirSync(inbox("conv-c"), { recursive: true });
    await admin.agent.delete("/api/conversations/conv-a").expect(200);
    await admin.agent.delete("/api/conversations/conv-b").expect(200);
    const purged = async (count: number) => {
      for (let i = 0; i < 100 && runner!.ops.filter((op) => op.op === "purge").length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return runner!.ops.filter((op) => op.op === "purge").map((op) => op.payload.sid);
    };
    expect(await purged(1)).toEqual([craftSessionId("conv-a")]);
    expect(fs.existsSync(inbox("conv-a"))).toBe(false);
    await admin.agent.delete("/api/conversations").expect(200);
    expect(await purged(2)).toEqual([craftSessionId("conv-a"), craftSessionId("conv-c")]);
    // No pending marker left once the runner took them.
    const pendingDir = path.join(tempDir, "data", "runtime", "craft-purge");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []).toEqual([]);
  });

  it("a purge the runner cannot take now leaves a marker that a later good probe retries", async () => {
    const { app, config } = boot();
    const admin = await newUser(app, "root");
    await admin.agent.post("/api/chat/stream").send({ avatarId: admin.id, conversationId: "conv-x", message: "hi" }).expect(200);
    fs.mkdirSync(path.join(tempDir, "ex", "inbox", craftSessionId("conv-x")), { recursive: true });
    await admin.agent.delete("/api/conversations/conv-x").expect(200);
    const marker = path.join(tempDir, "data", "runtime", "craft-purge", craftSessionId("conv-x"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(marker)).toBe(true);
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    __resetCraftRunnerForTests();
    await refreshCraftRunnerHealth(config);
    for (let i = 0; i < 100 && fs.existsSync(marker); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.ops.filter((op) => op.op === "purge").map((op) => op.payload.sid)).toEqual([craftSessionId("conv-x")]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
