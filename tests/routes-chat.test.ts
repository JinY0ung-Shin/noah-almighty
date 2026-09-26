import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRequest,
  AgentResponse,
  AppConfig,
  ConversationSummary,
  ExternalAgentConfig,
} from "../src/server/types.js";
import type { AgentEvents, BrowserResult, FileOutputResult } from "../src/server/agent/events.js";
import type { Store } from "../src/server/store.js";
import { makeBareRemote, parseSse, signup, withTempDir } from "./helpers.js";
import {
  chatFilesDir,
  MAX_CHAT_FILES_PER_MESSAGE,
  MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE,
  MAX_SHARED_SCREENSHOTS_PER_MESSAGE,
} from "../src/server/chatFiles.js";
import { chatImagesDir, MAX_CHAT_IMAGES_PER_MESSAGE, resolveStoredImage } from "../src/server/chatImages.js";
import { renderDocumentPreviews } from "../src/server/deckRender.js";
import { getActiveRunForConversation } from "../src/server/agent/runRegistry.js";
import { formatDurationKo, MAX_STEER_LENGTH } from "../src/server/routes/chat.js";

// Shared control surface for the mocked agent layer. `impl`, when set, fully
// drives a turn (fires the events callbacks the route wires); otherwise a default
// mock streams one delta and returns. `retryable` steers isRetryableModelError so
// the chat error branch can be exercised both ways.
type RunImpl = (
  request: AgentRequest,
  pluginRoots: unknown,
  config: AppConfig,
  store: unknown,
  events: AgentEvents,
  abortController: AbortController,
) => Promise<AgentResponse>;

/** Same idea as RunImpl, for the gateway-backed (external avatar) turn. */
type ExternalRunImpl = (
  request: { message: string; conversationHistory?: unknown },
  external: ExternalAgentConfig,
  events: AgentEvents,
  abortController?: AbortController,
) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  impl: null as RunImpl | null,
  retryable: false,
  // External avatars run behind a gateway: mocked at the same network seam the
  // SDK is mocked at, so the route's own relay/fan-out is what gets tested.
  externalImpl: null as ExternalRunImpl | null,
  externalRequests: [] as { message: string; external: ExternalAgentConfig }[],
  probeModels: null as string[] | null,
  // Server-side preview rendering shells out to soffice/pdftoppm, which no test
  // box has. [] reproduces the missing-toolchain result; a non-empty value
  // stands in for a successful render.
  previewPages: [] as Buffer[],
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      pluginRoots: unknown,
      config: AppConfig,
      store: unknown,
      events: AgentEvents,
      abortController: AbortController,
    ): Promise<AgentResponse> => {
      H.requests.push(agentRequest);
      if (H.impl) {
        return H.impl(agentRequest, pluginRoots, config, store, events, abortController);
      }
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.(`[mock] ${agentRequest.message}`);
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: `[mock] ${agentRequest.message}`,
      };
    },
  ),
  isRetryableModelError: vi.fn(() => H.retryable),
}));

vi.mock("../src/server/agent/externalAgent.js", () => ({
  runExternalAgent: vi.fn(
    async (
      agentRequest: { message: string; conversationHistory?: unknown },
      external: ExternalAgentConfig,
      events: AgentEvents,
      abortController?: AbortController,
    ): Promise<AgentResponse> => {
      H.externalRequests.push({ message: agentRequest.message, external });
      if (!H.externalImpl) {
        throw new Error("no externalImpl configured for this test");
      }
      return H.externalImpl(agentRequest, external, events, abortController);
    },
  ),
  probeExternalAgentGateway: vi.fn(async () => {
    if (!H.probeModels) {
      throw new Error("gateway unreachable");
    }
    return { models: H.probeModels, durationMs: 1 };
  }),
}));

// Only the toolchain shell-out is replaced; isPreviewableExtension and the rest
// of the module stay real.
vi.mock("../src/server/deckRender.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/deckRender.js")>()),
  renderDocumentPreviews: vi.fn(async () => H.previewPages),
}));

import { createApp, createServices } from "../src/server/app.js";
import { acquireActiveRepo, releaseActiveRepo } from "../src/server/activeRepoLock.js";
import { gitRepoClonePath } from "../src/server/gitRepos.js";
import { workspaceDirFor } from "../src/server/workspace.js";

let tempDir: string;
const getTempDir = withTempDir("routes-chat", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
  H.impl = null;
  H.retryable = false;
  H.externalImpl = null;
  H.externalRequests.length = 0;
  H.probeModels = null;
  H.previewPages = [];
});

function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "claude", sessionSecret: "test" });
  return { services, app: createApp(services), store: services.store, config: services.config };
}

/** Extract the session cookie(s) from a signup response for raw-http reuse. */
function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((c) => c.split(";")[0]).join("; ");
}

/** The id of the newest assistant message in a conversation. */
function lastAssistantId(store: Store, ownerId: string, conversationId: string): string {
  const found = [...store.listMessages(ownerId, conversationId)].reverse().find((m) => m.role === "assistant");
  if (!found) throw new Error("expected an assistant message");
  return found.id;
}

async function waitUntil(pred: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
  for (let i = 0; i < 1600; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

// Parked-run + interactive tests hold an SSE stream open and poll; coverage
// instrumentation slows them well past the 5s default, so give them headroom.
const LIVE = 20_000;

/** The active-run snapshot for a conversation, or null. */
async function activeRun(
  agent: ReturnType<typeof request.agent>,
  conversationId: string,
): Promise<{ runId: string; pendingCount: number; background?: boolean } | null> {
  const res = await agent.get(`/api/chat/runs?conversationId=${conversationId}`);
  return (
    (res.body.run as { runId: string; pendingCount: number; background?: boolean } | null) ?? null
  );
}

/** Dispatch a chat-stream POST in the background; resolves when the run closes. */
function fireStream(agent: ReturnType<typeof request.agent>, body: object): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    agent
      .post("/api/chat/stream")
      .send(body)
      .end((err, res) => (res ? resolve(res) : reject(err)));
  });
}

/** A plain JSON POST over a dedicated socket to the same listening server. */
function postJson(
  port: number,
  cookie: string,
  path: string,
  body: object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

interface SseFrame {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** `parseSse` types frame data as unknown; these tests read known payloads. */
function frameData(frame: { data: unknown }): SseFrame["data"] {
  return frame.data as SseFrame["data"];
}

function parseFrameBlock(block: string): SseFrame | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event) return null;
  return { event, data: data ? JSON.parse(data) : undefined };
}

/**
 * Open an SSE request over a REAL socket so frames can be read WHILE the run is
 * parked (supertest buffers the whole body, so it can't answer interactive
 * prompts mid-turn). `onFrame` fires per frame as it arrives.
 */
function streamRaw(
  port: number,
  cookie: string,
  path: string,
  method: "POST" | "GET",
  body: object | null,
  onFrame: (f: SseFrame) => void,
): Promise<{ status: number; frames: SseFrame[] }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        // A dedicated socket (no global keep-alive pool) so a finished SSE stream
        // is closed cleanly and can't leak a stale socket into the next test.
        agent: false,
        headers: {
          cookie,
          ...(payload != null
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const frames: SseFrame[] = [];
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const frame = parseFrameBlock(block);
            if (frame) {
              frames.push(frame);
              onFrame(frame);
            }
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, frames }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Minimal byte sequences whose magic matches what the publish helpers sniff. */
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 1)]);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** The same 1x1 PNG as an upload payload (what the composer POSTs). */
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const PPTX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(64, 1)]);

/**
 * Run one turn over a real socket, standing in for the user's browser: every
 * parked `browser` frame is answered with `replyFor(frame.data)` through
 * /api/chat/respond, the way the Noah tab relays the extension's outcome.
 * Returns the SSE frames plus the op payloads the route put on the wire.
 */
async function runWithBridge(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: object,
  replyFor: (data: SseFrame["data"]) => object,
): Promise<{ frames: SseFrame[]; relayed: SseFrame["data"][] }> {
  const relayed: SseFrame["data"][] = [];
  const answers: Promise<{ status: number }>[] = [];
  let frames: SseFrame[] = [];
  await withServer(app, async (port) => {
    frames = (
      await streamRaw(port, cookie, "/api/chat/stream", "POST", body, (frame) => {
        if (frame.event !== "browser") return;
        relayed.push(frame.data);
        answers.push(
          postJson(port, cookie, "/api/chat/respond", {
            runId: frame.data.runId,
            requestId: frame.data.requestId,
            value: replyFor(frame.data),
          }),
        );
      })
    ).frames;
    for (const answer of await Promise.all(answers)) expect(answer.status).toBe(200);
  });
  return { frames, relayed };
}

/** A fake turn that streams a partial then parks until the SDK is aborted. */
const parkUntilAborted: RunImpl = async (_req, _pr, config, _store, events, ac) => {
  events.onSessionId?.("sess-parked");
  events.onDelta?.("부분 답변");
  await new Promise<never>((_resolve, reject) => {
    if (ac.signal.aborted) return reject(new Error("aborted"));
    ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { kind: "text", runtime: config.agentRuntime, summary: "x", text: "x" };
};

// ---------------------------------------------------------------------------

describe("activity-snapshot persistence (PUT /api/messages/:id/activity)", () => {
  it("sanitizes + caps + normalizes a client activity snapshot before storing it", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "act").expect(201)).body.user.id as string;

    // A default turn leaves an assistant message with a response to attach onto.
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-act", message: "안녕" }).expect(200);
    const messageId = lastAssistantId(store, ownerId, "conv-act");

    const activity = {
      agents: [
        { id: "a1", parentId: "", label: "메인", status: "running", isMain: true }, // running → done
        { id: "a2", parentId: "a1", label: "sub", status: "failed", isMain: false },
        { id: "a3", parentId: "a1", label: "sub2", status: "weird" }, // unknown → done
        ...Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, parentId: "a1", label: "x", status: "done" })),
      ],
      tools: [
        { id: "t1", agentId: "a1", kind: "tool", label: "Read", detail: "file.ts", status: "done" },
        { id: "t2", agentId: "", kind: "blocked", label: "Bash", status: "blocked" }, // agentId → main
        { id: "t3", agentId: "a1", kind: "task", label: "legacy task row", status: "running" }, // legacy → tasks
        { id: "t4", kind: "weird", label: "w", status: "weird" }, // kind → tool, status → done, agentId → main
        { id: "t5", agentId: "main", kind: "memory", label: "기억 추가됨", detail: "wiki/people/kim.md", status: "done" }, // 기억 chip source — kind survives
        { id: "t6", agentId: "main", kind: "compact", label: "대화 맥락이 요약되었습니다", detail: "자동 요약 · 이전 맥락 약 152K토큰", status: "done" }, // compaction notice — kind survives
      ],
      tasks: [
        { id: "k1", agentId: "a1", label: "task1", detail: "d", status: "running" },
        { id: "k2", label: "task2", status: "failed" },
        { id: "k3", label: "task3", status: "done" },
      ],
    };

    await owner.put(`/api/messages/${messageId}/activity`).send({ activity }).expect(200).expect({ ok: true });

    const stored = store.listMessages(ownerId, "conv-act").find((m) => m.id === messageId)!.response!.activity!;
    expect(stored.agents).toHaveLength(60); // capped from 73
    expect(stored.agents[0].status).toBe("done"); // running normalized on persist
    expect(stored.agents[1].status).toBe("failed");
    expect(stored.agents[2].status).toBe("done"); // unknown normalized
    // The legacy `kind:"task"` tool row is filtered out of tools and merged into tasks.
    expect(stored.tools.map((t) => t.id).sort()).toEqual(["t1", "t2", "t4", "t5", "t6"]);
    expect(stored.tools.find((t) => t.id === "t2")).toMatchObject({ kind: "blocked", agentId: "main" });
    expect(stored.tools.find((t) => t.id === "t4")).toMatchObject({ kind: "tool", agentId: "main", status: "done" });
    // kind:"memory" must survive the round-trip — the reload-time 기억 summary
    // chip is rebuilt from these persisted rows.
    expect(stored.tools.find((t) => t.id === "t5")).toMatchObject({
      kind: "memory",
      label: "기억 추가됨",
      detail: "wiki/people/kim.md",
    });
    // Same for kind:"compact" — it is the only lasting record that the
    // conversation was summarized mid-turn.
    expect(stored.tools.find((t) => t.id === "t6")).toMatchObject({
      kind: "compact",
      label: "대화 맥락이 요약되었습니다",
      detail: "자동 요약 · 이전 맥락 약 152K토큰",
      status: "done",
    });
    expect(stored.tasks!.map((t) => t.id).sort()).toEqual(["k1", "k2", "k3", "t3"]);
    expect(stored.tasks!.find((t) => t.id === "k1")).toMatchObject({ status: "running", agentId: "a1" });
    expect(stored.tasks!.find((t) => t.id === "k2")).toMatchObject({ status: "failed", agentId: "main" });
  });

  it("clears the activity when the snapshot has no tools or tasks (agents only)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "act2").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-act2", message: "hi" }).expect(200);
    const messageId = lastAssistantId(store, ownerId, "conv-act2");

    await owner
      .put(`/api/messages/${messageId}/activity`)
      .send({ activity: { agents: [{ id: "a1", label: "only", status: "done" }], tools: [], tasks: [] } })
      .expect(200)
      .expect({ ok: true });

    expect(store.listMessages(ownerId, "conv-act2").find((m) => m.id === messageId)!.response!.activity).toBeUndefined();

    // A non-object activity payload is rejected by the sanitizer and also clears.
    await owner.put(`/api/messages/${messageId}/activity`).send({ activity: 42 }).expect(200).expect({ ok: true });
    expect(store.listMessages(ownerId, "conv-act2").find((m) => m.id === messageId)!.response!.activity).toBeUndefined();
  });

  it("404s activity for an unknown message id", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "act3").expect(201);
    await owner.put("/api/messages/does-not-exist/activity").send({ activity: { tools: [{ id: "t", label: "x" }] } }).expect(404);
  });
});

describe("slash-command expansion at the route boundary", () => {
  it("rejects /new with a Korean error before streaming", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "slash").expect(201)).body.user.id as string;
    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/new" }).expect(400);
    expect(res.body.error).toContain("/new");
    expect(H.requests).toHaveLength(0); // never reached the agent
  });

  it("rejects an argument-less owner-only command (/remember) with its error", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "slash2").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/remember" }).expect(400);
    expect(H.requests).toHaveLength(0);
  });

  it("blocks an owner-only command (/learn) sent to someone else's avatar", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "owner-learn").expect(201)).body.user.id as string;

    const teammate = request.agent(app);
    const teammateId = (await signup(teammate, "teammate-learn").expect(201)).body.user.id as string;
    // Group co-membership is the only reach to someone else's avatar now (it
    // also elevates the viewer — irrelevant here: the ownerOnly slash guard
    // keys on IDENTITY, not elevation).
    const group = store.createGroup({ name: "learn-group" });
    store.addGroupMember(group.id, ownerId);
    store.addGroupMember(group.id, teammateId);

    const res = await teammate.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/learn" }).expect(403);
    expect(res.body.error).toContain("내 아바타");
    expect(H.requests).toHaveLength(0);
  });
});

describe("discovery + listing edge cases", () => {
  it("lists the owner's registered git repos (name/repo/branch only)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gitrepos").expect(201)).body.user.id as string;
    store.upsertGitRepo(ownerId, "beta", "acme/beta", "dev");
    store.upsertGitRepo(ownerId, "alpha", "acme/alpha", null);

    const res = await owner.get("/api/me/git-repos").expect(200);
    expect(res.body.repos).toEqual([
      { name: "alpha", repo: "acme/alpha", branch: null },
      { name: "beta", repo: "acme/beta", branch: "dev" },
    ]);
  });

  it("returns an empty message list when no conversationId is supplied", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "nomsg").expect(201);
    const res = await owner.get("/api/messages").expect(200);
    expect(res.body).toEqual({ messages: [] });
  });
});

describe("canvas version history endpoints", () => {
  async function seedCanvas(store: Store, ownerId: string) {
    store.touchConversation(ownerId, "conv-cv", ownerId, "seed");
    store.upsertCanvasArtifact(ownerId, "conv-cv", { artifactId: "cv1", title: "v1", content: "one", contentType: "markdown" });
    // A changed body appends a second version.
    store.upsertCanvasArtifact(ownerId, "conv-cv", { artifactId: "cv1", title: "v2", content: "two", contentType: "markdown" });
  }

  it("lists versions, rolls back, and validates the version input", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvowner").expect(201)).body.user.id as string;
    await seedCanvas(store, ownerId);

    const versions = await owner.get("/api/chat/canvases/cv1/versions").expect(200);
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    await owner.post("/api/chat/canvases/cv1/rollback").send({ version: 0 }).expect(400);
    await owner.post("/api/chat/canvases/cv1/rollback").send({ version: "x" }).expect(400);
    await owner.post("/api/chat/canvases/unknown/rollback").send({ version: 1 }).expect(404);

    const rolled = await owner.post("/api/chat/canvases/cv1/rollback").send({ version: 1 }).expect(200);
    expect(rolled.body.canvas.content).toBe("one"); // rollback re-appends v1's body as the new current
    expect(rolled.body.canvas.currentVersion).toBe(3);
  });

  it("deletes a canvas and 404s an unknown one", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvdel").expect(201)).body.user.id as string;
    await seedCanvas(store, ownerId);

    await owner.delete("/api/chat/canvases/unknown").expect(404);
    await owner.delete("/api/chat/canvases/cv1").expect(200).expect({ ok: true });
    expect(store.getCanvasArtifact(ownerId, "cv1")).toBeNull();
  });
});

describe("chat-stream request validation", () => {
  it("rejects a non-array mcpToolGroups payload", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "mcpbad").expect(201)).body.user.id as string;
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "c", message: "hi", mcpToolGroups: "confluence" })
      .expect(400);
    expect(H.requests).toHaveLength(0);
  });

  it("409s a supplied conversation id owned by another user", async () => {
    const { app } = boot();
    const alice = request.agent(app);
    const aliceId = (await signup(alice, "alice").expect(201)).body.user.id as string;
    await alice.post("/api/chat/stream").send({ avatarId: aliceId, conversationId: "shared-conv", message: "내 대화" }).expect(200);

    const bob = request.agent(app);
    const bobId = (await signup(bob, "bob").expect(201)).body.user.id as string;
    H.requests.length = 0;
    await bob.post("/api/chat/stream").send({ avatarId: bobId, conversationId: "shared-conv", message: "끼어들기" }).expect(409);
    expect(H.requests).toHaveLength(0);
  });

  it("stages image uploads as workspace FILES when the deployment model has no vision", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
      visionEnabled: false,
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "novision").expect(201)).body.user.id as string;
    H.requests.length = 0;
    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId: "conv-nv",
        message: "이거 봐줘",
        images: [{ name: "cat.png", data: PNG_DATA_URL }],
      })
      .expect(200);

    // The upload is accepted; the model gets PATHS, never image content blocks.
    expect(H.requests).toHaveLength(1);
    const r = H.requests[0];
    expect(r.images).toBeUndefined();
    expect(r.imageFiles).toHaveLength(1);
    expect(r.imageFiles![0].mediaType).toBe("image/png");
    expect(r.imageFiles![0].name).toBe("cat.png");
    const staged = r.imageFiles![0].path;
    expect(path.isAbsolute(staged)).toBe(true);
    expect(staged.startsWith(path.join(workspaceDirFor(services.config, ownerId, "conv-nv"), "attachments") + path.sep)).toBe(true);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged)).toEqual(PNG_BYTES);
    // The prompt note is added by buildUserPrompt at prompt time, so the request
    // message itself is untouched.
    expect(r.message).toBe("이거 봐줘");
    // The bubble still renders the attachment exactly as in vision mode.
    const stored = services.store.listMessages(ownerId, "conv-nv").find((m) => m.role === "user");
    expect(stored?.attachments).toHaveLength(1);
    expect(stored?.attachments?.[0].kind).toBe("image");
  });

  it("picks image content blocks vs staged files by the per-tier vision policy of this turn's model", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
    });
    services.store.setModelVisionPolicy({ sonnet: false });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "tiervision").expect(201)).body.user.id as string;

    H.requests.length = 0;
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-tv", message: "이미지", model: "sonnet", images: [PNG_DATA_URL] })
      .expect(200);
    expect(H.requests).toHaveLength(1);
    const textOnly = H.requests[0];
    expect(textOnly.images).toBeUndefined();
    expect(textOnly.imageFiles).toHaveLength(1);
    expect(textOnly.imageFiles![0].mediaType).toBe("image/png");
    const staged = textOnly.imageFiles![0].path;
    expect(path.isAbsolute(staged)).toBe(true);
    expect(staged.startsWith(path.join(workspaceDirFor(services.config, ownerId, "conv-tv"), "attachments") + path.sep)).toBe(true);
    expect(fs.readFileSync(staged)).toEqual(PNG_BYTES);

    // A vision tier (no explicit entry → inherits the on default) still feeds the
    // model image content blocks, with no staged copy.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-tv2", message: "이미지", model: "opus", images: [PNG_DATA_URL] })
      .expect(200);
    expect(H.requests).toHaveLength(2);
    expect(H.requests[1].images).toHaveLength(1);
    expect(H.requests[1].imageFiles).toBeUndefined();
  });

  it("serves 404 for a missing image on the owner's own conversation", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "imgmiss").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-img", message: "hi" }).expect(200);
    // Owner matches, but the image id doesn't resolve to a stored file.
    await owner.get("/api/conversations/conv-img/images/ghost").expect(404);
  });

  it("serves a stored generated file as an owner-only attachment download", async () => {
    const { app, config } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "filedl").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-file", message: "hi" }).expect(200);

    // Seed the on-disk store the way onShareFile would (metadata rides the message row).
    const dir = chatFilesDir(config, "conv-file");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deck-1.pdf"), "%PDF-1.4 test");

    await owner.get("/api/conversations/conv-file/files/ghost").expect(404);
    const res = await owner
      .get("/api/conversations/conv-file/files/deck-1")
      .query({ name: "주간 보고.pdf" })
      .expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment;");
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("주간 보고.pdf"));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    // Another user never reaches the bytes — same 404 shape as the image route.
    const bob = request.agent(app);
    await signup(bob, "filedl2").expect(201);
    await bob.get("/api/conversations/conv-file/files/deck-1").expect(404);
  });
});

describe("working-repo resolution failures (before SSE)", () => {
  it("self-heals a dangling working-repo pointer instead of dead-ending the conversation", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "reponf").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-repo", ownerId, "seed");
    store.setConversationWorkingRepo("conv-repo", "ghost-repo"); // not in git_repositories

    // Removing the opened repo leaves working_repo dangling; the turn must proceed
    // in the scratch workspace and clear the stale pointer, not 400 forever.
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-repo", message: "작업" }).expect(200);
    expect(store.getConversationWorkingRepo("conv-repo")).toBeNull();
    expect(H.requests).toHaveLength(1);
  });

  it("409s when another conversation holds the working-repo clone lock", async () => {
    const { store, config, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "repolock").expect(201)).body.user.id as string;
    store.upsertGitRepo(ownerId, "myrepo", "acme/myrepo", null);
    store.touchConversation(ownerId, "conv-lock", ownerId, "seed");
    store.setConversationWorkingRepo("conv-lock", "myrepo");

    const clonePath = gitRepoClonePath(ownerId, "myrepo", config);
    expect(acquireActiveRepo(clonePath, "another-conversation")).toBe(true);
    try {
      const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-lock", message: "작업" }).expect(409);
      expect(res.body.error).toContain("다른 대화");
      expect(H.requests).toHaveLength(0);
    } finally {
      releaseActiveRepo(clonePath, "another-conversation");
    }
  });
});

describe("per-conversation preferences persist + feed the agent", () => {
  it("stores the owner's model/effort/group-knowledge choices and passes them this turn", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "prefs").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId: "conv-prefs",
        message: "hi",
        model: "sonnet",
        effort: "medium",
        groupKnowledgeOff: ["g1", "g2", 5], // the non-string is filtered out
      })
      .expect(200);

    expect(H.requests[0].modelTier).toBe("sonnet");
    expect(H.requests[0].effort).toBe("medium");

    const msgs = await owner.get("/api/messages?conversationId=conv-prefs").expect(200);
    expect(msgs.body.selectedModel).toBe("sonnet");
    expect(msgs.body.selectedEffort).toBe("medium");
    expect(msgs.body.groupKnowledgeOff).toEqual(["g1", "g2"]);
  });

  it("drops system messages from the reconstructed conversation history", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "syshist").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-sys", ownerId, "이전 요청");
    store.addMessage("conv-sys", { role: "user", content: "이전 요청" });
    store.addMessage("conv-sys", { role: "system", content: "시스템 노트" });
    store.addMessage("conv-sys", {
      role: "assistant",
      content: "이전 답변",
      response: { kind: "text", runtime: "claude", summary: "", text: "이전 답변" },
    });

    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-sys", message: "이어서" }).expect(200);
    expect(H.requests[0].conversationHistory).toEqual([
      { role: "user", content: "이전 요청" },
      { role: "assistant", content: "이전 답변" },
    ]);
  });
});

describe("canvas submission turns (#50)", () => {
  it("formats a values submission for the agent and shows a Korean bubble", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvsub").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-sub", ownerId, "seed");
    store.upsertCanvasArtifact(ownerId, "conv-sub", { artifactId: "cv-title", title: "내 차트", content: "x", contentType: "markdown" });

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-sub", canvasSubmission: { canvasId: "cv-title", values: { color: "red" } } })
      .expect(200);

    expect(H.requests[0].message).toContain('the canvas "내 차트" (id: cv-title)');
    expect(H.requests[0].message).toContain("- color: red");
    const userMsg = store.listMessages(ownerId, "conv-sub").find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("캔버스 응답을 보냈습니다.");
  });

  it("formats an edited-content submission (untitled canvas)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvedit").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-edit", canvasSubmission: { canvasId: "cv-none", editedContent: "수정된 내용" } })
      .expect(200);

    expect(H.requests[0].message).toContain("The user edited the canvas (id: cv-none) content to:");
    expect(H.requests[0].message).toContain("수정된 내용");
    const userMsg = store.listMessages(ownerId, "conv-edit").find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("캔버스를 수정해 보냈습니다.");
  });

  it("ignores a canvasSubmission that carries neither values nor edited content", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvnoop").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop", message: "실제 메시지", canvasSubmission: { canvasId: "x" } })
      .expect(200);
    expect(H.requests[0].message).toBe("실제 메시지"); // treated as a normal turn

    // A non-object canvasSubmission is likewise ignored.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop2", message: "또 다른 메시지", canvasSubmission: 5 })
      .expect(200);
    expect(H.requests[1].message).toBe("또 다른 메시지");

    // An object canvasSubmission missing a canvasId is ignored too.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop3", message: "세번째 메시지", canvasSubmission: { values: { x: 1 } } })
      .expect(200);
    expect(H.requests[2].message).toBe("세번째 메시지");
  });
});

describe("SSE event fan-out", () => {
  it("forwards every non-blocking event as an SSE frame and persists plan + thinking", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "fanout").expect(201)).body.user.id as string;

    H.impl = async (agentRequest, _pr, config, _store, events) => {
      events.onSessionId?.("sess-nb");
      events.onModel?.("claude-test-model");
      events.onStatus?.("작업 중");
      events.onDelta?.("답변 ");
      events.onThinking?.("throwaway");
      events.onThinkingReset?.();
      events.onThinking?.("final thinking");
      events.onPlugin?.({ status: "installed", name: "p1" });
      events.onToolStart?.({ toolUseId: "t1", name: "Read", agentId: "main", inputSummary: "file.ts" });
      events.onToolEnd?.({ toolUseId: "t1", ok: true });
      events.onTaskStart?.({ taskId: "k1", description: "task" });
      events.onTaskUpdate?.({ taskId: "k1", status: "running" });
      events.onTaskEnd?.({ taskId: "k1", ok: true, status: "done" });
      events.onAgentStart?.({ agentId: "a1", parentId: "main", subagentType: "explore", description: "sub" });
      events.onAgentEnd?.({ agentId: "a1", ok: true });
      events.onBlocked?.({ toolName: "Bash", agentId: "main", reason: "read-only" });
      events.onPlan?.({ plan: "", planning: true });
      events.onPlan?.({ plan: "THE PLAN" });
      await events.onCanvas?.({ artifactId: "c1", title: "T", content: "# hi", contentType: "markdown", awaitInput: false });
      const generatedPath = path.join(agentRequest.cwd!, "generated.png");
      fs.writeFileSync(generatedPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
      const shown = await events.onFile?.({ path: generatedPath, caption: "생성 결과" });
      expect(shown?.behavior).toBe("shown");
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "final answer" };
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-fan", message: "가라" }).expect(200);
    const frames = parseSse(res.text);
    const events = frames.map((f) => f.event);
    for (const name of [
      "open", "delta", "thinking", "thinking_reset", "status", "plugin", "tool", "tool_end",
      "task", "task_update", "task_end", "agent", "agent_end", "blocked", "plan", "canvas", "file", "done",
    ]) {
      expect(events).toContain(name);
    }
    const planFrames = frames.filter((f) => f.event === "plan");
    expect(planFrames).toHaveLength(2);
    expect(planFrames.some((f) => (f.data as { planning?: boolean }).planning === true)).toBe(true);
    expect(planFrames.some((f) => (f.data as { plan?: string }).plan === "THE PLAN")).toBe(true);

    const doneData = frames.find((f) => f.event === "done")!.data as { response: AgentResponse };
    expect(doneData.response.plan).toBe("THE PLAN");
    expect(doneData.response.thinking).toBe("final thinking"); // reset dropped the throwaway
    expect(doneData.response.text).toBe("final answer");
    const stored = store.listMessages(ownerId, "conv-fan").find((message) => message.role === "assistant");
    expect(stored?.attachments?.[0]).toMatchObject({ mediaType: "image/png", caption: "생성 결과" });

    // The non-blocking canvas was recorded to the dedicated tables.
    expect(store.getCanvasArtifact(ownerId, "c1")?.title).toBe("T");
    // Session id persisted for the next turn's resume.
    expect(store.getAgentSessionId(ownerId, "conv-fan")).toBe("sess-nb");
  });

  it("folds interim narration into the reasoning view and re-anchors the cards it left behind", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "textfold").expect(201)).body.user.id as string;

    H.impl = async (agentRequest, _pr, config, _store, events) => {
      events.onDelta?.("중간 설명");
      const generatedPath = path.join(agentRequest.cwd!, "mid.png");
      fs.writeFileSync(generatedPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
      const shown = await events.onFile?.({ path: generatedPath });
      // The real runner stamps the anchor off its live text accumulator; stand in
      // for that here so the fold has an anchor to move.
      if (shown?.behavior === "shown") shown.attachment.anchor = "중간 설명".length;
      events.onTextFold?.("중간 설명");
      events.onDelta?.("최종 답");
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "최종 답" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-fold", message: "가라" })
      .expect(200);
    const frames = parseSse(res.text);
    expect(frames.map((f) => f.event)).toContain("text_fold");

    const doneData = frames.find((f) => f.event === "done")!.data as { response: AgentResponse };
    expect(doneData.response.text).toBe("최종 답");
    // Same information, moved: out of the answer, into the collapsible reasoning card.
    expect(doneData.response.thinking).toBe("중간 설명");

    const stored = store.listMessages(ownerId, "conv-fold").find((message) => message.role === "assistant");
    expect(stored?.content).toBe("최종 답");
    expect(stored?.response?.thinking).toBe("중간 설명");
    // The text that anchor indexed into is no longer part of the answer.
    expect(stored?.attachments?.[0].anchor).toBe(0);
  });
});

describe("interactive prompts answered over /api/chat/respond", () => {
  it("delivers approve/allow/answer/submit decisions back to the run", async () => {
    const { services, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "interact").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    H.impl = async (_req, _pr, config, _store, events) => {
      const perm = await events.onPermission!({ toolUseId: "tu1", toolName: "Bash", input: { command: "ls" }, agentId: "main" });
      const q = await events.onQuestion!({ dialogKind: "ask", payload: { question: "고를래?" } });
      const plan = await events.onPlanReview!({ plan: "PLAN TEXT" });
      const canvas = await events.onCanvas!({
        artifactId: "cvpos",
        title: "T",
        content: "body",
        contentType: "markdown",
        controls: [{ type: "text", id: "a" }],
        awaitInput: true,
        interaction: "blocking",
      });
      events.onDelta?.(JSON.stringify({ perm, q, plan, canvas }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ANSWERED" };
    };

    await withServer(app, async (port) => {
      const responses: Promise<{ status: number }>[] = [];
      const answer = (d: { runId: string; requestId: string }, value: object) =>
        responses.push(postJson(port, cookie, "/api/chat/respond", { runId: d.runId, requestId: d.requestId, value }));

      const { frames } = await streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-int", message: "가라" }, (frame) => {
        if (frame.event === "permission") answer(frame.data, { behavior: "allow" });
        else if (frame.event === "question") answer(frame.data, { result: { choice: "A" } });
        else if (frame.event === "plan_review") answer(frame.data, { behavior: "approved" });
        else if (frame.event === "canvas") answer(frame.data, { values: { a: "typed" } });
      });

      for (const r of await Promise.all(responses)) expect(r.status).toBe(200);
      const delta = frames.find((f) => f.event === "delta")!;
      expect(JSON.parse(delta.data.text)).toEqual({
        perm: { behavior: "allow" },
        q: { behavior: "completed", result: { choice: "A" } },
        plan: { behavior: "approved" },
        canvas: { behavior: "submitted", values: { a: "typed" } },
      });
      expect(frames.some((f) => f.event === "done")).toBe(true);
      // The submitted canvas persisted with the user's values.
      expect(services.store.getCanvasArtifact(ownerId, "cvpos")?.submittedValues).toEqual({ a: "typed" });
    });
  }, LIVE);

  it("delivers deny/cancel/reject/delete decisions back to the run", async () => {
    const { services, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "interact2").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    H.impl = async (_req, _pr, config, _store, events) => {
      const perm = await events.onPermission!({ toolUseId: "tu1", toolName: "Bash", input: {}, agentId: "main" });
      const q = await events.onQuestion!({ dialogKind: "ask", payload: {} });
      const plan = await events.onPlanReview!({ plan: "P" });
      const canvasControls = [{ type: "text" as const, id: "a" }];
      // Two canvases: one the user DELETES, one they DISMISS (cancel) — distinct branches.
      const canvasDel = await events.onCanvas!({ artifactId: "cvdel", title: "T", content: "c", contentType: "markdown", controls: canvasControls, awaitInput: true, interaction: "blocking" });
      const canvasCancel = await events.onCanvas!({ artifactId: "cvcancel", title: "T", content: "c", contentType: "markdown", controls: canvasControls, awaitInput: true, interaction: "blocking" });
      events.onDelta?.(JSON.stringify({ perm, q, plan, canvasDel, canvasCancel }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "done" };
    };

    await withServer(app, async (port) => {
      const responses: Promise<{ status: number }>[] = [];
      const answer = (d: { runId: string; requestId: string }, value: object) =>
        responses.push(postJson(port, cookie, "/api/chat/respond", { runId: d.runId, requestId: d.requestId, value }));
      let canvasSeen = 0;

      const { frames } = await streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-int2", message: "가라" }, (frame) => {
        if (frame.event === "permission") answer(frame.data, { behavior: "deny" });
        else if (frame.event === "question") answer(frame.data, { cancelled: true });
        else if (frame.event === "plan_review") answer(frame.data, { behavior: "rejected", feedback: "다시" });
        else if (frame.event === "canvas") answer(frame.data, ++canvasSeen === 1 ? { deleteCanvas: true } : { cancelled: true });
      });

      await Promise.all(responses);
      const delta = frames.find((f) => f.event === "delta")!;
      expect(JSON.parse(delta.data.text)).toEqual({
        perm: { behavior: "deny" },
        q: { behavior: "cancelled" },
        plan: { behavior: "rejected", feedback: "다시" },
        canvasDel: { behavior: "cancelled" },
        canvasCancel: { behavior: "cancelled" },
      });
      // deleteCanvas removed the artifact; a plain cancel still records it (no values).
      expect(services.store.getCanvasArtifact(ownerId, "cvdel")).toBeNull();
      const cancelled = services.store.getCanvasArtifact(ownerId, "cvcancel");
      expect(cancelled?.submittedValues).toBeUndefined();
    });
  }, LIVE);
});

describe("cancellation + run registry", () => {
  it("stops a parked run, persists the streamed partial, and rejects a concurrent turn", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cancel").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-cancel", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-cancel")) !== null, "run active");
    const run = (await activeRun(owner, "conv-cancel"))!;

    // A second POST to the same conversation is refused while one is streaming.
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-cancel", message: "동시 요청" }).expect(409);
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200).expect({ ok: true });

    expect(parseSse((await streamDone).text).some((f) => f.event === "cancelled")).toBe(true);
    // The partial the user watched is persisted (not an empty stub).
    const assistant = store.listMessages(ownerId, "conv-cancel").find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("부분 답변");
    expect(assistant.response?.summary).toBe("중지됨");
  }, LIVE);

  it("persists the post-fold block with its head intact when stopped", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "foldcancel").expect(201)).body.user.id as string;
    // The runners fold BEFORE dispatching the delta that triggered it, so the
    // route sees the fold ahead of the new block's first chunk. In that order
    // foldedTextOffset lands at the START of "최종 답"; behind the chunk it would
    // land past its head and the stop would persist a clipped answer forever.
    H.impl = async (_req, _pr, config, _store, events, ac) => {
      events.onDelta?.("중간 설명");
      events.onTextFold?.("중간 설명");
      events.onDelta?.("최종 답");
      await new Promise<never>((_resolve, reject) => {
        if (ac.signal.aborted) return reject(new Error("aborted"));
        ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { kind: "text", runtime: config.agentRuntime, summary: "x", text: "x" };
    };

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-foldcancel", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-foldcancel")) !== null, "run active");
    const run = (await activeRun(owner, "conv-foldcancel"))!;
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200);
    await streamDone;

    const assistant = store.listMessages(ownerId, "conv-foldcancel").find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("최종 답");
    expect(assistant.response?.thinking).toContain("중간 설명");
  }, LIVE);

  it("replays the buffered events to a late watcher on the run-events endpoint", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "watch").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);
    H.impl = parkUntilAborted;

    await withServer(app, async (port) => {
      let runId = "";
      // The main stream parks after emitting an open + delta.
      const mainDone = streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-watch", message: "느린 요청" }, (f) => {
        if (f.event === "open") runId = f.data.runId as string;
      });
      await waitUntil(() => runId !== "", "main run open");

      // A watcher that connects LATE must be replayed the frames it missed.
      const watcher: string[] = [];
      const watcherDone = streamRaw(port, cookie, `/api/chat/runs/${runId}/events`, "GET", null, (f) => watcher.push(f.event));
      await waitUntil(() => watcher.includes("delta"), "watcher replayed the missed delta");

      await owner.post(`/api/chat/runs/${runId}/cancel`).send({}).expect(200);
      await Promise.all([mainDone, watcherDone]);
      expect(watcher).toContain("open"); // replayed
      expect(watcher).toContain("cancelled"); // live
    });
  }, LIVE);

  it("cancels the four blocking prompts at once when the run is stopped", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cancelprompts").expect(201)).body.user.id as string;

    H.impl = async (_req, _pr, config, _store, events, ac) => {
      const [plan, perm, q, canvas] = await Promise.all([
        events.onPlanReview!({ plan: "p" }),
        events.onPermission!({ toolUseId: "tu", toolName: "Bash", input: {}, agentId: "main" }),
        events.onQuestion!({ dialogKind: "ask", payload: {} }),
        events.onCanvas!({ artifactId: "cvc", title: "T", content: "c", contentType: "markdown", controls: [{ type: "text", id: "a" }], awaitInput: true, interaction: "blocking" }),
      ]);
      events.onDelta?.(JSON.stringify({ plan, perm, q, canvas }));
      if (ac.signal.aborted) throw new Error("aborted");
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "x" };
    };

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-cp", message: "질문들" });
    await waitUntil(async () => ((await activeRun(owner, "conv-cp"))?.pendingCount ?? 0) === 4, "four prompts parked");
    const run = (await activeRun(owner, "conv-cp"))!;
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200);

    const frames = parseSse((await streamDone).text);
    for (const name of ["plan_review", "permission", "question", "canvas", "cancelled"]) {
      expect(frames.map((f) => f.event)).toContain(name);
    }
    // The stop resolved the permission prompt WITHOUT an answer — the decision
    // must say so (unanswered), not read as an explicit user refusal.
    const delta = frames.find((f) => f.event === "delta")!.data as { text: string };
    expect(JSON.parse(delta.text).perm).toEqual({ behavior: "deny", unanswered: true });
  }, LIVE);

  it("cancels the in-flight run when its conversation is deleted", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "delone").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-del1", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-del1")) !== null, "run active");

    await owner.delete("/api/conversations/conv-del1").expect(200).expect({ ok: true });
    // Persistence is skipped once the conversation row is gone (FK would reject).
    expect(parseSse((await streamDone).text).some((f) => f.event === "cancelled")).toBe(true);
    expect(store.listMessages(ownerId, "conv-del1")).toEqual([]);
  }, LIVE);

  it("cancels in-flight runs when all chat conversations are bulk-deleted", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "delall").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-del-all", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-del-all")) !== null, "run active");

    const res = await owner.delete("/api/conversations").expect(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.conversationIds).toContain("conv-del-all");
    await streamDone; // the aborted run unwinds and closes
  }, LIVE);
});

describe("chat error handling", () => {
  it("surfaces a non-retryable agent failure as an error frame + persisted message", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "err1").expect(201)).body.user.id as string;
    H.retryable = false;
    H.impl = async () => {
      throw new Error("boom failure");
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-err1", message: "가라" }).expect(200);
    const errData = parseSse(res.text).find((f) => f.event === "error")!.data as { error: string };
    expect(errData.error).toContain("boom failure");

    const assistant = store.listMessages(ownerId, "conv-err1").find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("boom failure");
    expect(assistant.response).toBeNull(); // plain error keeps the null-response shape
  });

  it("nudges the user to switch models on a retryable failure, keeping the streamed partial + plan + thinking", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "err2").expect(201)).body.user.id as string;
    H.retryable = true;
    H.impl = async (_req, _pr, _config, _store, events) => {
      events.onDelta?.("부분 결과");
      events.onPlan?.({ plan: "PLAN" });
      events.onThinking?.("생각");
      throw new Error("overloaded");
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-err2", message: "가라" }).expect(200);
    const errData = parseSse(res.text).find((f) => f.event === "error")!.data as { error: string };
    expect(errData.error).toContain("일시적으로"); // Korean model-switch nudge, not the raw SDK error

    const assistant = store.listMessages(ownerId, "conv-err2").find((m) => m.role === "assistant")!;
    expect(assistant.content.startsWith("부분 결과")).toBe(true);
    expect(assistant.response?.plan).toBe("PLAN");
    expect(assistant.response?.thinking).toBe("생각");
  });
});

describe("run-registry endpoint validation", () => {
  it("validates /api/chat/runs and the runId endpoints", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "regval").expect(201);

    await owner.get("/api/chat/runs").expect(400); // no conversationId
    const noRun = await owner.get("/api/chat/runs?conversationId=nothing").expect(200);
    expect(noRun.body.run).toBeNull();
    await owner.get("/api/chat/runs/unknown/events").expect(404);
    await owner.post("/api/chat/runs/unknown/cancel").send({}).expect(404);
  });

  it("validates /api/chat/respond inputs and rejects unknown runs", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "respval").expect(201);

    await owner.post("/api/chat/respond").send({}).expect(400); // missing runId/requestId
    await owner.post("/api/chat/respond").send({ runId: "a", requestId: "b", value: "not-an-object" }).expect(400);
    await owner.post("/api/chat/respond").send({ runId: "a", requestId: "b", value: { behavior: "allow" } }).expect(404);
  });
});

describe("browser-bridge relay (onBrowser)", () => {
  it("puts the whole op on the wire, audits a scrubbed url, and bounds every untrusted reply field", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridge").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(
        await events.onBrowser!({
          op: "press_key",
          uid: "u-7",
          url: "https://intranet.example.com/start",
          x: 12,
          y: 34,
          xFraction: 0.5,
          yFraction: 0.25,
          toUid: "u-9",
          toX: 56,
          toY: 78,
          toXFraction: 0.75,
          toYFraction: 0.1,
          key: "Enter",
          modifiers: ["Control", "Shift"],
          repeat: 3,
          fields: [
            { uid: "f1", value: "a" },
            { uid: "f2", value: "b" },
          ],
          option: "선택지",
          clear: true,
          expand: true,
          maxChars: 4000,
        }),
      );
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    const { relayed } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-bridge", message: "브라우저" },
      () => ({
        ok: true,
        // Credentials in userinfo and a token in the query string must not reach
        // the audit table an admin can read.
        url: "https://user:hunter2@intranet.example.com/wiki/page?token=abc123",
        title: "위키 문서",
        snapshot: "s".repeat(200_050),
        snapshotError: "e".repeat(1_100),
        note: "n".repeat(600),
        landedOn: "l".repeat(400),
        pageText: "p".repeat(200_050),
        pageTextOffset: -5, // negative offsets are not trusted
        tabs: [
          { tabId: "t1", title: "T1", url: "https://a.example.com", current: true },
          { tabId: 5, title: "numeric id" }, // dropped: tabId must be a string
          "not-an-object", // dropped
          { tabId: "t2" }, // missing fields default rather than fail
        ],
        dialog: { message: "정말 삭제할까요?" }, // no type → alert
      }),
    );

    // Every wire field the five hand-synced layers agreed on rides the frame.
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      op: "press_key",
      uid: "u-7",
      url: "https://intranet.example.com/start",
      x: 12,
      y: 34,
      xFraction: 0.5,
      yFraction: 0.25,
      toUid: "u-9",
      toX: 56,
      toY: 78,
      toXFraction: 0.75,
      toYFraction: 0.1,
      key: "Enter",
      modifiers: ["Control", "Shift"],
      repeat: 3,
      fields: [
        { uid: "f1", value: "a" },
        { uid: "f2", value: "b" },
      ],
      option: "선택지",
      clear: true,
      expand: true,
      maxChars: 4000,
      // Fields this op doesn't carry are explicitly nulled, never undefined.
      text: null,
      direction: null,
      accept: null,
      fullPage: null,
    });

    const result = results[0];
    expect(result.behavior).toBe("ok");
    if (result.behavior !== "ok") return;
    expect(result.snapshot).toHaveLength(200_000);
    expect(result.snapshotError).toHaveLength(1_000);
    expect(result.note).toHaveLength(500);
    expect(result.landedOn).toHaveLength(300);
    expect(result.pageText?.text).toHaveLength(200_000);
    expect(result.pageText?.offset).toBe(0);
    // `total` reports the page's real length, not the truncated chunk's.
    expect(result.pageText?.total).toBe(200_050);
    expect(result.tabs).toEqual([
      { tabId: "t1", title: "T1", url: "https://a.example.com", current: true },
      { tabId: "t2", title: "", url: "", current: false },
    ]);
    expect(result.dialog).toEqual({ type: "alert", message: "정말 삭제할까요?", defaultPrompt: undefined });

    const audit = store.listAudit(ownerId, true).find((e) => e.action === "browser_press_key")!;
    expect(audit.detail).toContain("op=press_key");
    expect(audit.detail).toContain("uid=u-7");
    expect(audit.detail).toContain("at=(12,34)");
    expect(audit.detail).toContain("rel=(0.5,0.25)");
    expect(audit.detail).toContain("key=Control+Shift+Enter x3");
    expect(audit.detail).toContain("fields=2");
    expect(audit.detail).toContain("option=선택지");
    expect(audit.detail).toContain("clear");
    expect(audit.detail).toContain("expand");
    // The url the op LANDED on wins over the requested one, scrubbed to scheme/host/path.
    expect(audit.detail).toContain("url=https://intranet.example.com/wiki/page");
    expect(audit.detail).not.toContain("hunter2");
    expect(audit.detail).not.toContain("token=abc123");
  }, LIVE);

  it("relays a stored secret on its OWN fields, keeps the frame out of replay, and redacts the reply", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgesecret").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const PW = "hunter2-corp-secret";
    const results: BrowserResult[] = [];
    // Replay-buffer size at three points of the turn. A parked op costs ONE
    // `prompt_resolved` frame on top of its own `browser` frame, so a normal op
    // adds two and a secret-carrying one adds only the resolve.
    const eventCounts: number[] = [];
    const countNow = () => getActiveRunForConversation(ownerId, "conv-secret")!.eventCount;
    H.impl = async (_req, _pr, config, _store, events) => {
      eventCounts.push(countNow());
      results.push(
        await events.onBrowser!({
          op: "type",
          uid: "e1",
          secret: { name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true },
          secretText: PW,
          submit: true,
        }),
      );
      eventCounts.push(countNow());
      results.push(await events.onBrowser!({ op: "click", uid: "e2" }));
      eventCounts.push(countNow());
      results.push(
        await events.onBrowser!({
          op: "fill_form",
          fields: [
            { uid: "f1", value: "j.kim" },
            {
              uid: "f2",
              value: "",
              secret: { name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true },
              secretValue: PW,
            },
          ],
        }),
      );
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    const { relayed } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-secret", message: "로그인" },
      () => ({
        ok: true,
        url: "https://jira.corp.com/login",
        title: "로그인",
        // A page that echoed the typed value straight back into its own DOM.
        snapshot: `[e1] textbox = "${PW}"`,
        note: `Secret entered; the field reads "${PW}".`,
      }),
    );

    // The policy and the plaintext ride their own fields; `text` stays null so
    // an extension that predates secret input types nothing.
    expect(relayed[0]).toMatchObject({
      op: "type",
      uid: "e1",
      secret: { name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true },
      secretText: PW,
      text: null,
    });
    expect(relayed[2]).toMatchObject({
      op: "fill_form",
      fields: [
        { uid: "f1", value: "j.kim" },
        { uid: "f2", value: "", secret: { name: "LOGIN_PW" }, secretValue: PW },
      ],
      secret: null,
      secretText: null,
    });

    // Replay buffer: the secret frame is NOT kept (+1 for its prompt_resolved),
    // the plain click IS (+2).
    expect(eventCounts[1] - eventCounts[0]).toBe(1);
    expect(eventCounts[2] - eventCounts[1]).toBe(2);

    // The extension's reply is redacted BEFORE the tool result is built, so the
    // page's echo of the password never reaches the model turn.
    const typed = results[0];
    expect(typed.behavior).toBe("ok");
    if (typed.behavior !== "ok") return;
    expect(typed.snapshot).not.toContain(PW);
    expect(typed.snapshot).toContain("[REDACTED:LOGIN_PW]");
    expect(typed.note).not.toContain(PW);
    expect(typed.note).toContain("[REDACTED:LOGIN_PW]");

    // Audit rows carry the NAME only — never the value, and never the text.
    const rows = store.listAudit(ownerId, true);
    const typeRow = rows.find((e) => e.action === "browser_type")!;
    expect(typeRow.detail).toContain("secret=LOGIN_PW");
    expect(typeRow.detail).not.toContain(PW);
    const fillRow = rows.find((e) => e.action === "browser_fill_form")!;
    expect(fillRow.detail).toContain("secrets=[LOGIN_PW]");
    expect(fillRow.detail).toContain("fields=2");
    expect(fillRow.detail).not.toContain(PW);
    // The plain op is untouched by any of this.
    expect(rows.find((e) => e.action === "browser_click")!.detail).not.toContain("secret");
  }, LIVE);

  it("read_cookies relays, returns the cookies to the tool, and audits by NAME + count never value", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgecookie").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(await events.onBrowser!({ op: "read_cookies", name: "session" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    const { relayed } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-cookie", message: "쿠키" },
      () => ({
        ok: true,
        // userinfo + query token must be scrubbed from the audit row.
        url: "https://user:hunter2@intra.example.com/app?token=abc123",
        title: "앱",
        cookies: [
          {
            name: "session",
            value: "httponly-secret-value",
            domain: "intra.example.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            expires: 1900000000,
          },
          { value: "no-name" }, // dropped: name must be a string
        ],
      }),
    );

    // The op — with its name filter — rode the wire.
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ op: "read_cookies", name: "session" });

    // The cookie VALUES come back to the tool (the accepted design), bounded and
    // shape-validated (the nameless entry dropped).
    const result = results[0];
    expect(result.behavior).toBe("ok");
    if (result.behavior !== "ok") return;
    expect(result.cookies).toEqual([
      {
        name: "session",
        value: "httponly-secret-value",
        domain: "intra.example.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        expires: 1900000000,
      },
    ]);

    // The audit row carries the host + cookie NAME + count, and NEVER a value.
    const audit = store
      .listAudit(ownerId, true)
      .find((e) => e.action === "browser_read_cookies")!;
    expect(audit.detail).toContain("cookies=1");
    expect(audit.detail).toContain("names=[session]");
    expect(audit.detail).toContain("url=https://intra.example.com/app");
    expect(audit.detail).not.toContain("httponly-secret-value");
    expect(audit.detail).not.toContain("hunter2");
    expect(audit.detail).not.toContain("token=abc123");
  }, LIVE);

  it("read_storage relays kind, returns entries to the tool, and audits by KEY + count never value", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgestorage").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(await events.onBrowser!({ op: "read_storage", kind: "local", name: "auth" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    const { relayed } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-storage", message: "저장소" },
      () => ({
        ok: true,
        // userinfo + query token must be scrubbed from the audit row.
        url: "https://user:hunter2@intra.example.com/app?token=abc123",
        title: "앱",
        storageKind: "local",
        storage: [
          { key: "auth", value: "jwt-secret-value" },
          { value: "no-key" }, // dropped: key must be a string
        ],
      }),
    );

    // The op — with its kind + name filter — rode the wire.
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ op: "read_storage", kind: "local", name: "auth" });

    // The entry VALUES come back to the tool (the accepted design), bounded and
    // shape-validated (the keyless entry dropped).
    const result = results[0];
    expect(result.behavior).toBe("ok");
    if (result.behavior !== "ok") return;
    expect(result.storageKind).toBe("local");
    expect(result.storage).toEqual([{ key: "auth", value: "jwt-secret-value" }]);

    // The audit row carries the storage kind + entry KEY + count, NEVER a value.
    const audit = store
      .listAudit(ownerId, true)
      .find((e) => e.action === "browser_read_storage")!;
    expect(audit.detail).toContain("storage=local");
    expect(audit.detail).toContain("entries=1");
    expect(audit.detail).toContain("keys=[auth]");
    expect(audit.detail).toContain("url=https://intra.example.com/app");
    expect(audit.detail).not.toContain("jwt-secret-value");
    expect(audit.detail).not.toContain("hunter2");
    expect(audit.detail).not.toContain("token=abc123");
  }, LIVE);

  it("keeps snapshot/wait_for/dialog_status out of the audit trail and records unknown/unparseable urls", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgeaudit").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    H.impl = async (_req, _pr, config, _store, events) => {
      // The first two fire between every step and the third is a pure status
      // read the agent makes when it is confused — auditing any of them would
      // bury the rows an admin actually wants.
      await events.onBrowser!({ op: "snapshot" });
      await events.onBrowser!({ op: "wait_for", text: "완료", timeoutS: 5 });
      await events.onBrowser!({ op: "dialog_status" });
      await events.onBrowser!({ op: "click", uid: "u-1" });
      await events.onBrowser!({ op: "hover", uid: "u-2" });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-bridge2", message: "브라우저" },
      (data) =>
        data.op === "hover"
          ? { ok: true, url: "::::not a url::::" }
          : { ok: true }, // click: no url anywhere
    );

    const actions = store.listAudit(ownerId, true).map((e) => e.action);
    expect(actions).not.toContain("browser_snapshot");
    expect(actions).not.toContain("browser_wait_for");
    expect(actions).not.toContain("browser_dialog_status");
    expect(actions).toContain("browser_click");
    expect(actions).toContain("browser_hover");
    const rows = store.listAudit(ownerId, true);
    expect(rows.find((e) => e.action === "browser_click")!.detail).toContain("url=(unknown)");
    expect(rows.find((e) => e.action === "browser_hover")!.detail).toContain("url=(unparseable)");
  }, LIVE);

  it("reports an extension refusal to the model, translating an old build's 'unsupported operation'", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgerefuse").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(await events.onBrowser!({ op: "click", uid: "gone" }));
      results.push(await events.onBrowser!({ op: "fill_form", fields: [{ uid: "f", value: "v" }] }));
      results.push(await events.onBrowser!({ op: "select_option", uid: "s", option: "A" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-bridge3", message: "브라우저" },
      (data) => {
        if (data.op === "click") return { ok: false, message: "Element uid gone is not on the page." };
        if (data.op === "fill_form") return { ok: false, message: "Unsupported operation: fill_form" };
        return { ok: false }; // refused without saying why
      },
    );

    expect(results.map((r) => r.behavior)).toEqual(["error", "error", "error"]);
    const messages = results.map((r) => (r.behavior === "error" ? r.message : ""));
    expect(messages[0]).toBe("Element uid gone is not on the page.");
    // The old build can't explain itself, so the route translates for it.
    expect(messages[1]).toContain("Unsupported operation: fill_form");
    expect(messages[1]).toContain("OLDER build than this server");
    expect(messages[1]).toContain("브라우저 브릿지");
    expect(messages[2]).toContain("refused the operation without a reason");
  }, LIVE);

  it("reads bridge silence as an absent bridge, not a refusal, when the run is stopped mid-op", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "bridgesilent").expect(201)).body.user.id as string;

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, _config, _store, events) => {
      results.push(await events.onBrowser!({ op: "navigate", url: "https://intranet.example.com" }));
      throw new Error("aborted");
    };

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-bridge4", message: "이동" });
    await waitUntil(async () => ((await activeRun(owner, "conv-bridge4"))?.pendingCount ?? 0) === 1, "browser op parked");
    const run = (await activeRun(owner, "conv-bridge4"))!;
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200);
    await streamDone;

    expect(results[0].behavior).toBe("error");
    if (results[0].behavior !== "error") return;
    expect(results[0].message).toContain("The browser bridge did not respond");
    expect(results[0].message).toContain("attach a tab");
  }, LIVE);

  it("auto-shares a screenshot as a file card plus hidden slide, and refuses an oversized capture", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgeshot").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(await events.onBrowser!({ op: "screenshot" })); // shared
      results.push(await events.onBrowser!({ op: "screenshot", fullPage: true })); // publish fails
      results.push(await events.onBrowser!({ op: "screenshot", uid: "u-1" })); // too large to relay
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "본 화면" };
    };

    const { frames } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-shot", message: "화면 캡처" },
      (data) => {
        if (data.uid === "u-1") return { ok: true, imageBase64: "A".repeat(8_000_001) };
        if (data.fullPage) return { ok: true, imageBase64: Buffer.from("<html>nope</html>").toString("base64") };
        return { ok: true, imageBase64: JPEG_BYTES.toString("base64"), title: "사내 포털" };
      },
    );

    // 1) The user gets the same bytes the model saw, as a download card + slide.
    const first = results[0];
    expect(first.behavior).toBe("ok");
    if (first.behavior !== "ok") return;
    expect(first.shareNote).toContain("also shared with the user as a file card");
    expect(first.sharedAttachments).toHaveLength(2);
    expect(first.sharedAttachments![0]).toMatchObject({ kind: "file", name: "스크린샷 - 사내 포털.jpg" });
    expect(first.sharedAttachments![1]).toMatchObject({ kind: "image", hidden: true });
    const fileFrames = frames.filter((f) => f.event === "file");
    expect(fileFrames).toHaveLength(2);
    // The attachments ride the persisted assistant message too, so a reload
    // shows what the user already saw live.
    const assistant = store.listMessages(ownerId, "conv-shot").find((m) => m.role === "assistant")!;
    expect(assistant.attachments?.map((a) => a.kind)).toEqual(["file", "image"]);

    // 2) Unpublishable bytes still answer the tool call — the note keeps the
    //    model's self-knowledge honest about what the user actually got.
    const second = results[1];
    expect(second.behavior).toBe("ok");
    if (second.behavior !== "ok") return;
    expect(second.shareNote).toContain("could NOT be shared");

    // 3) A runaway payload fails the ONE tool call rather than the turn.
    expect(results[2].behavior).toBe("error");
    if (results[2].behavior !== "error") return;
    expect(results[2].message).toContain("too large to relay");
  }, LIVE);

  it("whitelists the screenshot mime type and passes explicit dialog/read_text metadata through", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgemeta").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const results: BrowserResult[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      results.push(await events.onBrowser!({ op: "screenshot" }));
      results.push(await events.onBrowser!({ op: "screenshot", fullPage: true }));
      results.push(await events.onBrowser!({ op: "read_text", offset: 100, maxChars: 500 }));
      results.push(await events.onBrowser!({ op: "handle_dialog", accept: true, promptText: "홍길동" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ok" };
    };

    const { relayed } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-meta", message: "브라우저" },
      (data) => {
        if (data.op === "read_text") {
          return { ok: true, pageText: "본문 일부", pageTextOffset: 100, pageTextTotal: 5000 };
        }
        if (data.op === "handle_dialog") {
          return { ok: true, dialog: { type: "prompt", message: "이름을 입력하세요", defaultPrompt: "기본값" } };
        }
        return data.fullPage
          ? { ok: true, imageBase64: PNG_BYTES.toString("base64"), imageMimeType: "image/png" }
          : // A semi-trusted extension must not choose the mime type freely: the
            // string lands in an API image block.
            { ok: true, imageBase64: JPEG_BYTES.toString("base64"), imageMimeType: "image/svg+xml" };
      },
    );

    expect(relayed[2]).toMatchObject({ op: "read_text", offset: 100, maxChars: 500 });
    expect(relayed[3]).toMatchObject({ op: "handle_dialog", accept: true, promptText: "홍길동" });

    const [jpeg, png, text, dialog] = results;
    expect(jpeg.behavior === "ok" && jpeg.image?.mimeType).toBe("image/jpeg"); // coerced
    expect(png.behavior === "ok" && png.image?.mimeType).toBe("image/png"); // whitelisted
    expect(text.behavior === "ok" && text.pageText).toEqual({ text: "본문 일부", offset: 100, total: 5000 });
    expect(dialog.behavior === "ok" && dialog.dialog).toEqual({
      type: "prompt",
      message: "이름을 입력하세요",
      defaultPrompt: "기본값",
    });
  }, LIVE);

  it("stops auto-sharing screenshots once the per-turn budget is spent", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "bridgebudget").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const notes: (string | undefined)[] = [];
    H.impl = async (_req, _pr, config, _store, events) => {
      for (let i = 0; i < MAX_SHARED_SCREENSHOTS_PER_MESSAGE + 1; i++) {
        const result = await events.onBrowser!({ op: "screenshot" });
        notes.push(result.behavior === "ok" ? result.shareNote : "ERROR");
      }
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "많이 봄" };
    };

    await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-budget", message: "계속 캡처" },
      () => ({ ok: true, imageBase64: JPEG_BYTES.toString("base64") }),
    );

    expect(notes).toHaveLength(MAX_SHARED_SCREENSHOTS_PER_MESSAGE + 1);
    for (const note of notes.slice(0, MAX_SHARED_SCREENSHOTS_PER_MESSAGE)) {
      expect(note).toContain("also shared with the user");
    }
    // The capture still succeeds; only the sharing stops, and the model is told
    // the user has NOT seen it.
    expect(notes[MAX_SHARED_SCREENSHOTS_PER_MESSAGE]).toContain("was NOT shared with the user");
    expect(notes[MAX_SHARED_SCREENSHOTS_PER_MESSAGE]).toContain(
      `already shared ${MAX_SHARED_SCREENSHOTS_PER_MESSAGE} screenshots`,
    );
  }, LIVE);
});

describe("publishing images and documents mid-turn (onFile / onShareFile)", () => {
  it("keeps separate per-turn budgets for visible and hidden image publishes", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "showfile").expect(201)).body.user.id as string;

    const shown: FileOutputResult[] = [];
    const hidden: FileOutputResult[] = [];
    let visibleOverflow!: FileOutputResult;
    let hiddenOverflow!: FileOutputResult;
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      fs.writeFileSync(path.join(agentRequest.cwd!, "shot.png"), PNG_BYTES);
      for (let i = 0; i < MAX_CHAT_IMAGES_PER_MESSAGE; i++) {
        shown.push(await events.onFile!({ path: "shot.png", caption: `장면 ${i}` }));
      }
      visibleOverflow = await events.onFile!({ path: "shot.png" });
      // Hidden publishes only cost disk (canvas slide embeds), so a whole deck
      // fits in one turn after the visible budget is already spent.
      for (let i = 0; i < MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE; i++) {
        hidden.push(await events.onFile!({ path: "shot.png", hidden: true }));
      }
      hiddenOverflow = await events.onFile!({ path: "shot.png", hidden: true });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "그림들" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-showfile", message: "그려줘" })
      .expect(200);

    expect(shown.every((r) => r.behavior === "shown")).toBe(true);
    expect(shown[0]).toMatchObject({
      behavior: "shown",
      url: expect.stringContaining("/api/conversations/conv-showfile/images/"),
    });
    expect(hidden.every((r) => r.behavior === "shown" && r.attachment.hidden === true)).toBe(true);

    expect(visibleOverflow.behavior).toBe("error");
    if (visibleOverflow.behavior !== "error") return;
    expect(visibleOverflow.message).toContain(`already showed ${MAX_CHAT_IMAGES_PER_MESSAGE} images`);
    expect(hiddenOverflow.behavior).toBe("error");
    if (hiddenOverflow.behavior !== "error") return;
    expect(hiddenOverflow.message).toContain(
      `already published ${MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE} hidden images`,
    );

    const total = MAX_CHAT_IMAGES_PER_MESSAGE + MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE;
    expect(parseSse(res.text).filter((f) => f.event === "file")).toHaveLength(total);
    const assistant = store.listMessages(ownerId, "conv-showfile").find((m) => m.role === "assistant")!;
    expect(assistant.attachments).toHaveLength(total);
  });

  it("maps a show_file publish failure to model-facing guidance", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "showfail").expect(201)).body.user.id as string;

    const results: FileOutputResult[] = [];
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      // Real file, but parked one level above the run cwd and the scratch workspace.
      fs.writeFileSync(path.join(agentRequest.cwd!, "..", "outside.png"), PNG_BYTES);
      results.push(await events.onFile!({ path: "ghost.png" }));
      results.push(await events.onFile!({ path: "../outside.png" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "실패" };
    };

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-showfail", message: "보여줘" })
      .expect(200);

    const messages = results.map((r) => (r.behavior === "error" ? r.message : "SHOWN"));
    expect(messages[0]).toBe("The image file does not exist.");
    // Not a bare refusal — it tells the model the copy-then-retry recipe.
    expect(messages[1]).toContain("must stay inside the current working directory");
    expect(messages[1]).toContain("cp /tmp/image.png");
  });

  it("redirects a share_file outside the roots; for a .pptx it keeps the converter's renders (copy the deck folder)", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "sharefail").expect(201)).body.user.id as string;

    const results: FileOutputResult[] = [];
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      // Real files, parked one level above the run cwd and the scratch workspace.
      fs.writeFileSync(path.join(agentRequest.cwd!, "..", "outside.pptx"), PPTX_BYTES);
      fs.writeFileSync(path.join(agentRequest.cwd!, "..", "outside.pdf"), PDF_BYTES);
      results.push(await events.onShareFile!({ path: "../outside.pptx" }));
      results.push(await events.onShareFile!({ path: "../outside.pdf" }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "실패" };
    };

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-sharefail", message: "공유해줘" })
      .expect(200);

    const [deckMsg, pdfMsg] = results.map((r) => (r.behavior === "error" ? r.message : "SHOWN"));
    for (const m of [deckMsg, pdfMsg]) {
      expect(m).toContain("must stay inside the current working directory");
      expect(m).toContain('cp /tmp/deck.pptx "$PWD/deck.pptx"');
    }
    // a converter deck's renders sit in <name>.preview/ next to the .pptx: the redirect must not strand them
    expect(deckMsg).toContain("copy its WHOLE deck folder instead");
    expect(deckMsg).toContain(".preview/ folder next to it");
    expect(pdfMsg).not.toContain("deck folder");
  });

  it("shares documents up to the per-turn cap, attaching server-rendered previews", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "sharefile").expect(201)).body.user.id as string;
    H.previewPages = [Buffer.from("page-1"), Buffer.from("page-2")];

    const results: FileOutputResult[] = [];
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      const cwd = agentRequest.cwd!;
      fs.writeFileSync(path.join(cwd, "report.pdf"), PDF_BYTES);
      fs.writeFileSync(path.join(cwd, "notes.md"), "# 회의록");
      fs.writeFileSync(path.join(cwd, "deck.pptx"), PPTX_BYTES);
      fs.writeFileSync(path.join(cwd, "tool.exe"), PPTX_BYTES);
      results.push(await events.onShareFile!({ path: "report.pdf", name: "주간 보고" })); // previewable
      results.push(await events.onShareFile!({ path: "ghost.pptx" })); // NOT_FOUND
      results.push(await events.onShareFile!({ path: "tool.exe" })); // UNSUPPORTED
      results.push(await events.onShareFile!({ path: "notes.md" })); // no previews
      results.push(await events.onShareFile!({ path: "deck.pptx" })); // previewable
      results.push(await events.onShareFile!({ path: "notes.md" })); // over the cap
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "문서들" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-sharefile", message: "문서 만들어줘" })
      .expect(200);

    expect(results.map((r) => r.behavior)).toEqual([
      "shown",
      "error",
      "error",
      "shown",
      "shown",
      "error",
    ]);
    // A previewable document carries its auto-rendered pages; other types don't.
    expect(results[0]).toMatchObject({
      behavior: "shown",
      previews: 2,
      url: expect.stringContaining("/api/conversations/conv-sharefile/files/"),
    });
    expect(results[0].behavior === "shown" && results[0].attachment.name).toBe("주간 보고.pdf");
    expect(results[3]).toMatchObject({ behavior: "shown", previews: 0 });
    expect(results[4]).toMatchObject({ behavior: "shown", previews: 2 });

    const errors = results.map((r) => (r.behavior === "error" ? r.message : ""));
    expect(errors[1]).toBe("The file does not exist.");
    expect(errors[2]).toContain(".pptx");
    expect(errors[2]).toContain("no Bash or Markdown workaround");
    expect(errors[5]).toContain(`already shared ${MAX_CHAT_FILES_PER_MESSAGE} files`);

    // 3 download cards + 4 hidden preview slides ride the message and the stream.
    const fileFrames = parseSse(res.text).filter((f) => f.event === "file");
    expect(fileFrames).toHaveLength(7);
    const assistant = store.listMessages(ownerId, "conv-sharefile").find((m) => m.role === "assistant")!;
    expect(assistant.attachments!.filter((a) => a.kind === "file")).toHaveLength(3);
    expect(assistant.attachments!.filter((a) => a.kind === "image" && a.hidden)).toHaveLength(4);
  });

  it("keeps the screenshot auto-share out of the share_file document budget", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "shotdoc").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    const shares: FileOutputResult[] = [];
    const notes: (string | undefined)[] = [];
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      fs.writeFileSync(path.join(agentRequest.cwd!, "notes.md"), "# 회의록");
      const capture = async () => {
        const result = await events.onBrowser!({ op: "screenshot" });
        notes.push(result.behavior === "ok" ? result.shareNote : "ERROR");
      };
      // Interleaved: each capture publishes a kind:"file" card of its own, which
      // must leave the document cap untouched.
      for (let i = 0; i < MAX_CHAT_FILES_PER_MESSAGE; i++) {
        await capture();
        shares.push(await events.onShareFile!({ path: "notes.md" }));
      }
      shares.push(await events.onShareFile!({ path: "notes.md" })); // over the document cap
      // A spent document cap does not stop capturing either: the browsing loop
      // runs on to its OWN budget.
      for (let i = MAX_CHAT_FILES_PER_MESSAGE; i <= MAX_SHARED_SCREENSHOTS_PER_MESSAGE; i++) {
        await capture();
      }
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "캡처와 문서" };
    };

    await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-shotdoc", message: "캡처하고 문서도" },
      () => ({ ok: true, imageBase64: JPEG_BYTES.toString("base64") }),
    );

    // Every document still lands after the captures that preceded it…
    expect(shares.slice(0, MAX_CHAT_FILES_PER_MESSAGE).every((r) => r.behavior === "shown")).toBe(true);
    // …and the cap still fires, counting share_file calls alone.
    const overflow = shares[MAX_CHAT_FILES_PER_MESSAGE];
    expect(overflow.behavior).toBe("error");
    if (overflow.behavior !== "error") return;
    expect(overflow.message).toContain(`already shared ${MAX_CHAT_FILES_PER_MESSAGE} files`);

    // The capture budget is likewise spent by captures alone.
    expect(notes).toHaveLength(MAX_SHARED_SCREENSHOTS_PER_MESSAGE + 1);
    expect(notes.filter((n) => n?.includes("also shared with the user"))).toHaveLength(
      MAX_SHARED_SCREENSHOTS_PER_MESSAGE,
    );
    expect(notes[MAX_SHARED_SCREENSHOTS_PER_MESSAGE]).toContain("was NOT shared with the user");

    const assistant = store.listMessages(ownerId, "conv-shotdoc").find((m) => m.role === "assistant")!;
    expect(assistant.attachments!.filter((a) => a.kind === "file")).toHaveLength(
      MAX_SHARED_SCREENSHOTS_PER_MESSAGE + MAX_CHAT_FILES_PER_MESSAGE,
    );
  }, LIVE);

  it("still delivers a previewable document when the render toolchain produces nothing", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "nopreview").expect(201)).body.user.id as string;
    H.previewPages = []; // no soffice/pdftoppm in this deployment

    let shared!: FileOutputResult;
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      fs.writeFileSync(path.join(agentRequest.cwd!, "report.pdf"), PDF_BYTES);
      shared = await events.onShareFile!({ path: "report.pdf" });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "문서" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-nopreview", message: "보고서" })
      .expect(200);

    // Previews are best-effort: the download card still lands, just bare.
    expect(shared).toMatchObject({ behavior: "shown", previews: 0 });
    expect(parseSse(res.text).filter((f) => f.event === "file")).toHaveLength(1);
  });

  it("refuses to publish anything once the conversation is deleted mid-run", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "gonefile").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    let image!: FileOutputResult;
    let file!: FileOutputResult;
    let capture!: BrowserResult;
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      fs.writeFileSync(path.join(agentRequest.cwd!, "shot.png"), PNG_BYTES);
      fs.writeFileSync(path.join(agentRequest.cwd!, "deck.pptx"), PPTX_BYTES);
      // The user closed the conversation while the avatar was still working.
      expect(store.deleteConversation(ownerId, "conv-gone")).toBe(true);
      image = await events.onFile!({ path: "shot.png" });
      file = await events.onShareFile!({ path: "deck.pptx" });
      capture = await events.onBrowser!({ op: "screenshot" });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "늦었다" };
    };

    const { frames } = await runWithBridge(
      app,
      cookie,
      { avatarId: ownerId, conversationId: "conv-gone", message: "작업" },
      () => ({ ok: true, imageBase64: JPEG_BYTES.toString("base64") }),
    );

    expect(image).toEqual({
      behavior: "error",
      message: "The conversation no longer exists, so the image cannot be shown.",
    });
    expect(file).toEqual({
      behavior: "error",
      message: "The conversation no longer exists, so the file cannot be shared.",
    });
    // The capture itself still succeeds — only the user-facing copy is skipped.
    expect(capture.behavior).toBe("ok");
    if (capture.behavior !== "ok") return;
    expect(capture.shareNote).toContain("the conversation no longer exists");
    expect(capture.sharedAttachments).toBeUndefined();

    // Nothing was persisted, and the turn still completes cleanly.
    const done = frames.find((f) => f.event === "done")!;
    expect(done.data.message).toBeNull();
    expect(store.listMessages(ownerId, "conv-gone")).toEqual([]);
  }, LIVE);
});

describe("share_file deck previews from the converter's hash-bound sidecar", () => {
  const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

  /**
   * What `deck.sh build` leaves in the workspace (the sidecar contract,
   * docs/architecture/pptx-converter.md): `<deck>/<deck>.pptx`
   * plus `<deck>/<deck>.preview/` holding the renders and, written last,
   * `manifest.json` bound to the pptx bytes. `boundTo` overrides the digest the
   * manifest claims (a later edit of the .pptx = stale).
   */
  function writeConverterDeck(
    cwd: string,
    name: string,
    slides: { file: string; bytes: Buffer; mediaType: "image/png" | "image/jpeg"; title?: string }[],
    opts: { boundTo?: Buffer; profile?: "embedded" | "malgun" } = {},
  ): string {
    const deckDir = path.join(cwd, name);
    const previewDir = path.join(deckDir, `${name}.preview`);
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(deckDir, `${name}.pptx`), PPTX_BYTES);
    fs.writeFileSync(path.join(previewDir, ".gitignore"), "*\n");
    for (const slide of slides) fs.writeFileSync(path.join(previewDir, slide.file), slide.bytes);
    fs.writeFileSync(
      path.join(previewDir, "manifest.json"),
      JSON.stringify({
        format: "noah-deck-preview",
        version: 1,
        generator: "noah-pptx-converter/1.0.0",
        pptx: `${name}.pptx`,
        pptxSha256: sha256(opts.boundTo ?? PPTX_BYTES),
        profile: opts.profile ?? "embedded",
        createdAt: "2026-09-26T03:00:00Z",
        slideCount: slides.length,
        slides: slides.map((slide, i) => ({
          index: i + 1,
          file: slide.file,
          mediaType: slide.mediaType,
          sha256: sha256(slide.bytes),
          width: 1920,
          height: 1080,
          ...(slide.title ? { title: slide.title } : {}),
        })),
      }),
    );
    return deckDir;
  }

  const SLIDES = [
    { file: "slide-01.png", bytes: PNG_BYTES, mediaType: "image/png" as const, title: "3분기 실적 요약" },
    { file: "slide-02.jpg", bytes: JPEG_BYTES, mediaType: "image/jpeg" as const },
  ];

  it("attaches the converter's renders to the card instead of LibreOffice pages", async () => {
    const { store, app, config } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "deckconv").expect(201)).body.user.id as string;
    H.previewPages = [Buffer.from("lo-page")]; // what LibreOffice WOULD produce
    vi.mocked(renderDocumentPreviews).mockClear();

    let shared!: FileOutputResult;
    H.impl = async (agentRequest, _pr, cfg, _store, events) => {
      writeConverterDeck(agentRequest.cwd!, "q3-review", SLIDES);
      shared = await events.onShareFile!({ path: "q3-review/q3-review.pptx", name: "3분기 보고.pptx" });
      return { kind: "text", runtime: cfg.agentRuntime, summary: "s", text: "덱 완성" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-deckconv", message: "PPT 만들어줘" })
      .expect(200);

    expect(shared).toMatchObject({
      behavior: "shown",
      previews: 2,
      previewSource: "converter",
      previewTotal: 2,
      deckSidecar: { status: "loaded", profile: "embedded" },
    });
    // The converter's renders replace the LibreOffice pass entirely.
    expect(vi.mocked(renderDocumentPreviews).mock.calls.length).toBe(0);

    // SSE: the card first, then the slides in deck order, linked to the card.
    const streamed = parseSse(res.text)
      .filter((f) => f.event === "file")
      .map((f) => frameData(f).attachment);
    expect(streamed).toHaveLength(3);
    const card = streamed[0];
    expect(card).toMatchObject({ kind: "file", name: "3분기 보고.pptx" });
    expect(shared.behavior === "shown" && shared.attachment.id).toBe(card.id);
    expect(streamed.slice(1)).toEqual([
      expect.objectContaining({
        kind: "image",
        hidden: true,
        parentId: card.id,
        mediaType: "image/png",
        name: "슬라이드 1 – 3분기 실적 요약",
      }),
      expect.objectContaining({ kind: "image", hidden: true, parentId: card.id, mediaType: "image/jpeg", name: "슬라이드 2" }),
    ]);
    // The stored slide bytes are the converter's renders, byte for byte.
    const first = resolveStoredImage(config, "conv-deckconv", streamed[1].id)!;
    expect(first.mediaType).toBe("image/png");
    expect(fs.readFileSync(first.path).equals(PNG_BYTES)).toBe(true);
    const second = resolveStoredImage(config, "conv-deckconv", streamed[2].id)!;
    expect(fs.readFileSync(second.path).equals(JPEG_BYTES)).toBe(true);

    // …and they persist on the assistant message exactly as streamed.
    const assistant = store.listMessages(ownerId, "conv-deckconv").find((m) => m.role === "assistant")!;
    expect(assistant.attachments!.map((a) => a.id)).toEqual(streamed.map((a) => a.id));
  });

  it("falls back to LibreOffice pages when the .pptx changed after the build", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "deckstale").expect(201)).body.user.id as string;
    H.previewPages = [Buffer.from("lo-1"), Buffer.from("lo-2"), Buffer.from("lo-3")];
    vi.mocked(renderDocumentPreviews).mockClear();

    let shared!: FileOutputResult;
    H.impl = async (agentRequest, _pr, cfg, _store, events) => {
      // The sidecar describes an EARLIER build; the .pptx was edited since.
      writeConverterDeck(agentRequest.cwd!, "q3-review", SLIDES, { boundTo: Buffer.from("an earlier build") });
      shared = await events.onShareFile!({ path: "q3-review/q3-review.pptx" });
      return { kind: "text", runtime: cfg.agentRuntime, summary: "s", text: "덱" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-deckstale", message: "PPT" })
      .expect(200);

    expect(shared).toMatchObject({
      behavior: "shown",
      previews: 3,
      previewSource: "libreoffice",
      deckSidecar: { status: "stale", detail: expect.any(String) },
    });
    expect(shared).not.toHaveProperty("previewTotal");
    expect(vi.mocked(renderDocumentPreviews).mock.calls.length).toBe(1);
    const slides = parseSse(res.text)
      .filter((f) => f.event === "file")
      .map((f) => frameData(f).attachment)
      .slice(1);
    // The trusted LibreOffice path, not the agent's renders.
    expect(slides.map((a) => a.name)).toEqual(["slide-1.png", "slide-2.png", "slide-3.png"]);
  });

  it("finds the sidecar next to the real file when the shared path is a symlink", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "decklink").expect(201)).body.user.id as string;
    vi.mocked(renderDocumentPreviews).mockClear();

    let shared!: FileOutputResult;
    H.impl = async (agentRequest, _pr, cfg, _store, events) => {
      const deckDir = writeConverterDeck(agentRequest.cwd!, "q3-review", SLIDES, { profile: "malgun" });
      fs.mkdirSync(path.join(agentRequest.cwd!, "out"));
      fs.symlinkSync(path.join(deckDir, "q3-review.pptx"), path.join(agentRequest.cwd!, "out", "final.pptx"));
      shared = await events.onShareFile!({ path: "out/final.pptx", name: "최종.pptx" });
      return { kind: "text", runtime: cfg.agentRuntime, summary: "s", text: "덱" };
    };

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-decklink", message: "PPT" })
      .expect(200);

    expect(shared).toMatchObject({
      behavior: "shown",
      previews: 2,
      previewSource: "converter",
      deckSidecar: { status: "loaded", profile: "malgun" },
    });
    expect(vi.mocked(renderDocumentPreviews).mock.calls.length).toBe(0);
  });

  it("reports a rejected sidecar and keeps the non-pptx shares sidecar-free", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "deckbad").expect(201)).body.user.id as string;
    H.previewPages = []; // no LibreOffice toolchain either

    let deck!: FileOutputResult;
    let pdf!: FileOutputResult;
    H.impl = async (agentRequest, _pr, cfg, _store, events) => {
      const deckDir = writeConverterDeck(agentRequest.cwd!, "q3-review", SLIDES);
      // A render rewritten after the manifest: the whole set is rejected.
      fs.writeFileSync(path.join(deckDir, "q3-review.preview", "slide-02.jpg"), Buffer.concat([JPEG_BYTES, Buffer.from("x")]));
      fs.writeFileSync(path.join(agentRequest.cwd!, "report.pdf"), PDF_BYTES);
      deck = await events.onShareFile!({ path: "q3-review/q3-review.pptx" });
      pdf = await events.onShareFile!({ path: "report.pdf" });
      return { kind: "text", runtime: cfg.agentRuntime, summary: "s", text: "문서" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-deckbad", message: "PPT" })
      .expect(200);

    expect(deck).toMatchObject({
      behavior: "shown",
      previews: 0,
      deckSidecar: { status: "invalid", detail: "slide 2's render does not match its sha256" },
    });
    expect(deck).not.toHaveProperty("previewSource");
    expect(pdf).toMatchObject({ behavior: "shown", previews: 0 });
    expect(pdf).not.toHaveProperty("deckSidecar");
    // Only the two download cards: no partial set of agent renders.
    expect(parseSse(res.text).filter((f) => f.event === "file")).toHaveLength(2);
  });

  it("falls back cleanly when the renders cannot be stored", async () => {
    const { app, config } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "deckdisk").expect(201)).body.user.id as string;
    H.previewPages = [];
    vi.mocked(renderDocumentPreviews).mockClear();
    // Block the conversation's image dir with a FILE: every hidden-image write fails.
    fs.mkdirSync(path.join(config.dataDir, "chat-images"), { recursive: true });
    fs.writeFileSync(chatImagesDir(config, "conv-deckdisk"), "not a directory");

    let shared!: FileOutputResult;
    H.impl = async (agentRequest, _pr, cfg, _store, events) => {
      writeConverterDeck(agentRequest.cwd!, "q3-review", SLIDES);
      shared = await events.onShareFile!({ path: "q3-review/q3-review.pptx" });
      return { kind: "text", runtime: cfg.agentRuntime, summary: "s", text: "덱" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-deckdisk", message: "PPT" })
      .expect(200);

    // The card still lands; the sidecar was valid, but nothing could be
    // attached, so the LibreOffice pass ran (and produced nothing here).
    expect(shared).toMatchObject({ behavior: "shown", previews: 0, deckSidecar: { status: "loaded" } });
    expect(shared).not.toHaveProperty("previewSource");
    expect(vi.mocked(renderDocumentPreviews).mock.calls.length).toBe(1);
    expect(parseSse(res.text).filter((f) => f.event === "file")).toHaveLength(1);
  });
});

describe("SDK-native background phase", () => {
  it("finalizes the visible turn at the first background boundary and delivers wake-ups as new messages", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "bgphase").expect(201)).body.user.id as string;

    const tasks = [{ taskId: "t1", taskType: "local_bash", description: "빌드 실행" }];
    let releaseBackground!: () => void;
    const backgroundParked = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });

    H.impl = async (_req, _pr, config, _store, events) => {
      events.onSessionId?.("sess-bg");
      events.onDelta?.("바로 보이는 답변");
      events.onThinking?.("첫 생각");
      // A boundary with NO live background tasks is an ordinary turn — the
      // post-await done path owns it, so nothing is persisted here.
      events.onTurnResult?.({ text: "바로 보이는 답변", backgroundTasks: [] });

      events.onBackgroundTasks?.({ tasks });
      events.onTurnResult?.({
        text: "바로 보이는 답변",
        backgroundTasks: tasks,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      await backgroundParked;

      // Background phase: the live set empties, one pure bookkeeping boundary
      // passes (no text, no attachments → no message), then a real wake-up turn.
      events.onBackgroundTasks?.({ tasks: [] });
      events.onTurnResult?.({ text: "   ", backgroundTasks: [] });
      events.onDelta?.("빌드가 끝났습니다");
      events.onThinking?.("두번째 생각");
      events.onTurnResult?.({ text: "빌드가 끝났습니다", backgroundTasks: [] });
      return { kind: "text", runtime: config.agentRuntime, summary: "집계", text: "집계 응답" };
    };

    const streamDone = fireStream(owner, {
      avatarId: ownerId,
      conversationId: "conv-bg",
      message: "빌드 돌려줘",
    });
    await waitUntil(
      async () => (await activeRun(owner, "conv-bg"))?.background === true,
      "run marked as background",
    );

    // The visible turn is already persisted, so a new typed message is refused
    // with the background-specific reason (not the generic "생성 중").
    const conflict = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-bg", message: "하나 더" })
      .expect(409);
    expect(conflict.body.error).toContain("백그라운드 작업");
    expect(conflict.body.error).toContain("중지 버튼");

    // The session id is persisted at the finalize boundary — the phase can
    // outlive the tab, and the next turn must resume this transcript.
    expect(store.getAgentSessionId(ownerId, "conv-bg")).toBe("sess-bg");

    releaseBackground();
    const frames = parseSse((await streamDone).text);

    const done = frames.filter((f) => f.event === "done");
    expect(done).toHaveLength(1); // the aggregate response is NOT re-persisted
    expect(frameData(done[0]).background).toBe(true);
    expect(frameData(done[0]).tasks).toEqual(tasks);
    expect(frameData(done[0]).response).toMatchObject({
      text: "바로 보이는 답변",
      thinking: "첫 생각",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(frames.filter((f) => f.event === "bg_tasks").map((f) => frameData(f).tasks)).toEqual([tasks, []]);
    const bgMessages = frames.filter((f) => f.event === "bg_message");
    expect(bgMessages).toHaveLength(1); // the bookkeeping boundary produced none
    expect(frameData(bgMessages[0]).message.content).toBe("빌드가 끝났습니다");
    expect(frames.some((f) => f.event === "bg_end")).toBe(true);

    const assistants = store.listMessages(ownerId, "conv-bg").filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.content)).toEqual(["바로 보이는 답변", "빌드가 끝났습니다"]);
    expect(assistants[0].response?.summary).toBe("Claude Agent SDK 실행이 완료되었습니다.");
    // Each report carries only ITS OWN tail of the streamed reasoning.
    expect(assistants[1].response).toMatchObject({ summary: "백그라운드 작업 보고", thinking: "두번째 생각" });
  }, LIVE);
});

describe("mid-turn user messages (steers)", () => {
  it("404s a message for a run that does not exist", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "steer404").expect(201);
    const res = await owner
      .post("/api/chat/runs/no-such-run/message")
      .send({ message: "안녕" })
      .expect(404);
    expect(res.body.error).toBe("진행 중인 실행을 찾을 수 없습니다.");
  });

  it("rejects an empty message and one past the length cap before touching the run", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "steerbad").expect(201);
    // Validated ahead of the run lookup, so an unknown run still 400s here.
    const empty = await owner
      .post("/api/chat/runs/whatever/message")
      .send({ message: "   " })
      .expect(400);
    expect(empty.body.error).toBe("메시지를 입력해 주세요.");
    const missing = await owner.post("/api/chat/runs/whatever/message").send({}).expect(400);
    expect(missing.body.error).toBe("메시지를 입력해 주세요.");
    const long = await owner
      .post("/api/chat/runs/whatever/message")
      .send({ message: "가".repeat(MAX_STEER_LENGTH + 1) })
      .expect(400);
    expect(long.body.error).toBe("메시지가 너무 깁니다.");
  });

  it("accepts a message mid-run, persists it on DELIVERY, and reports both states over SSE", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "steerlive").expect(201)).body.user.id as string;

    let captured: AgentEvents | null = null;
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    H.impl = async (_req, _pr, config, _store, events) => {
      captured = events;
      events.onSessionId?.("sess-steer");
      events.onDelta?.("확인 중");
      await parked;
      return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "바꿔서 처리했습니다" };
    };

    const streamDone = fireStream(owner, {
      avatarId: ownerId,
      conversationId: "conv-steer",
      message: "a.ts 봐줘",
    });
    await waitUntil(async () => (await activeRun(owner, "conv-steer")) !== null, "run active");
    const run = (await activeRun(owner, "conv-steer"))!;

    const accepted = await owner
      .post(`/api/chat/runs/${run.runId}/message`)
      .send({ message: "  사실 b.ts부터 봐줘  " })
      .expect(200);
    expect(accepted.body.ok).toBe(true);
    expect(accepted.body.steer).toMatchObject({
      id: expect.any(String),
      // The server trims before anything else sees it.
      text: "사실 b.ts부터 봐줘",
      state: "queued",
      followUp: false,
      createdAt: expect.any(String),
    });

    // Nothing is persisted at accept time — a message the model never receives
    // must not show up in the transcript.
    expect(store.listMessages(ownerId, "conv-steer").filter((m) => m.role === "user")).toHaveLength(1);

    // The CLI reports it reached the model.
    captured!.steers!.noteLifecycle(accepted.body.steer.id as string, "started");
    release();
    const frames = parseSse((await streamDone).text);

    const steerFrames = frames.filter((f) => f.event === "steer");
    expect(steerFrames.map((f) => frameData(f).steer.state)).toEqual(["queued", "delivered"]);
    expect(frameData(steerFrames[0]).steer.id).toBe(accepted.body.steer.id);
    // The persisted row rides INSIDE the steer object, and only on `delivered`
    // — one object per frame, never a sibling field.
    expect(frameData(steerFrames[0]).steer.message).toBeUndefined();
    expect(frameData(steerFrames[0]).message).toBeUndefined();
    const delivered = frameData(steerFrames[1]).steer;
    expect(delivered).toMatchObject({ state: "delivered", followUp: false });
    expect(delivered.message).toMatchObject({ role: "user", content: "사실 b.ts부터 봐줘", kind: "steer" });

    // The persisted row sits BETWEEN the original user turn and the answer, so
    // a reload reads the thread in the order it happened.
    const rows = store.listMessages(ownerId, "conv-steer");
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "a.ts 봐줘"],
      ["user", "사실 b.ts부터 봐줘"],
      ["assistant", "바꿔서 처리했습니다"],
    ]);
    expect(rows[1].kind).toBe("steer");
    expect(rows[1].id).toBe(delivered.message.id);
    // The POST body's `steer` is the same projection WITHOUT the row, so a
    // client can key both off the same id.
    expect(accepted.body.steer.message).toBeUndefined();
    expect("kind" in rows[0]).toBe(false);
  }, LIVE);

  it("closes the visible turn with turn_end when a steer outlived it, keeping the run open", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "steerturn").expect(201)).body.user.id as string;

    let sawActiveAfterTurnEnd = false;
    H.impl = async (agentRequest, _pr, config, _store, events) => {
      fs.writeFileSync(path.join(agentRequest.cwd!, "shot.png"), PNG_BYTES);
      events.onSessionId?.("sess-turnend");
      events.onDelta?.("첫 답변");
      events.onThinking?.("첫 생각");
      await events.onFile!({ path: "shot.png", caption: "첫 장면" });
      // The viewer's message arrived too late to fold in: the run stays open
      // and the CLI runs it as a follow-up turn.
      events.onTurnResult?.({ text: "첫 답변", backgroundTasks: [], steerPending: true });
      // Still live for the client — no `done` yet.
      sawActiveAfterTurnEnd = getActiveRunForConversation(ownerId, "conv-turnend") !== null;
      events.onDelta?.("이어서 답변");
      events.onThinking?.("두번째 생각");
      await events.onFile!({ path: "shot.png", caption: "두번째 장면" });
      events.onTurnResult?.({ text: "이어서 답변", backgroundTasks: [], steerPending: false });
      return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "이어서 답변" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-turnend", message: "봐줘" })
      .expect(200);
    const frames = parseSse(res.text);

    expect(sawActiveAfterTurnEnd).toBe(true);
    const turnEnd = frames.filter((f) => f.event === "turn_end");
    expect(turnEnd).toHaveLength(1);
    expect(frameData(turnEnd[0]).response).toMatchObject({ text: "첫 답변", thinking: "첫 생각" });
    expect(frameData(turnEnd[0]).message.content).toBe("첫 답변");
    // turn_end is NOT terminal: the follow-up turn's answer is the run's done.
    const done = frames.filter((f) => f.event === "done");
    expect(done).toHaveLength(1);
    expect(frames.indexOf(turnEnd[0])).toBeLessThan(frames.indexOf(done[0]));
    expect(frameData(done[0]).message.content).toBe("이어서 답변");

    // Two assistant rows, each carrying only ITS OWN tail of reasoning + cards.
    const assistants = store.listMessages(ownerId, "conv-turnend").filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.content)).toEqual(["첫 답변", "이어서 답변"]);
    expect(assistants[0].response?.thinking).toBe("첫 생각");
    expect(assistants[1].response?.thinking).toBe("두번째 생각");
    expect(assistants[0].attachments?.map((a) => a.caption)).toEqual(["첫 장면"]);
    expect(assistants[1].attachments?.map((a) => a.caption)).toEqual(["두번째 장면"]);
    // The session id is persisted at the boundary — the follow-up turn is the
    // same transcript and the next turn has to resume it.
    expect(store.getAgentSessionId(ownerId, "conv-turnend")).toBe("sess-turnend");
  }, LIVE);

  it("409s a mid-turn message on an external gateway avatar's run", async () => {
    const external: ExternalAgentConfig = {
      id: "research",
      displayName: "Research Agent",
      alias: "리서처",
      bio: "외부 조사 에이전트",
      persona: "공개 소개",
      intro: "외부 Gateway에서 실행됩니다.",
      hashtags: ["research"],
      endpoint: "https://gateway.example.com/v1/agents/messages",
      agent: "claude",
      apiKey: "gateway-secret",
      visibleToGroupIds: [],
    };
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
      externalAgents: [external],
    });
    const app = createApp(services);
    const viewer = request.agent(app);
    const viewerId = (await signup(viewer, "steerext").expect(201)).body.user.id as string;
    const group = services.store.createGroup({ name: "ext-viewers" });
    services.store.addGroupMember(group.id, viewerId);
    external.visibleToGroupIds = [group.id];

    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refused: { status: number; error: string } | null = null;
    H.externalImpl = async (_req, _ext, events) => {
      events.onDelta?.("외부 답변");
      const runId = getActiveRunForConversation(viewerId, "conv-steerext")!.runId;
      const res = await viewer.post(`/api/chat/runs/${runId}/message`).send({ message: "중간에" });
      refused = { status: res.status, error: res.body.error };
      release();
      await parked;
      return { kind: "text", runtime: "external", summary: "완료", text: "외부 답변" };
    };

    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "conv-steerext", message: "조사해줘" })
      .expect(200);

    // A stateless gateway turn has no live stdin to fold a message into, so the
    // capability is refused rather than silently dropped.
    expect(refused).toEqual({
      status: 409,
      error: "이 대화에서는 응답 중에 메시지를 보낼 수 없습니다.",
    });
  }, LIVE);

  it("410s a mid-turn message once the run was stopped, and reports the queued one as dropped", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "steerstop").expect(201)).body.user.id as string;
    // Park on the abort like parkUntilAborted, then HOLD: the run must still be
    // in the registry (cancelled, not yet closed) while the test probes it, or
    // the second POST would race the SSE socket's teardown and 404 instead.
    let unhold!: () => void;
    const held = new Promise<void>((resolve) => {
      unhold = resolve;
    });
    H.impl = async (_req, _pr, _config, _store, events, ac) => {
      events.onDelta?.("부분 답변");
      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) return resolve();
        ac.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await held;
      throw new Error("aborted");
    };

    const streamDone = fireStream(owner, {
      avatarId: ownerId,
      conversationId: "conv-steerstop",
      message: "느린 요청",
    });
    await waitUntil(async () => (await activeRun(owner, "conv-steerstop")) !== null, "run active");
    const run = (await activeRun(owner, "conv-steerstop"))!;

    const accepted = await owner
      .post(`/api/chat/runs/${run.runId}/message`)
      .send({ message: "전달되지 않을 메시지" })
      .expect(200);
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200);

    const refused = await owner
      .post(`/api/chat/runs/${run.runId}/message`)
      .send({ message: "중지 후" })
      .expect(410);
    expect(refused.body.error).toBe(
      "응답이 마무리되는 중이라 전달할 수 없습니다. 응답이 끝난 뒤 다시 보내 주세요.",
    );

    unhold();
    const frames = parseSse((await streamDone).text);
    const steerFrames = frames.filter((f) => f.event === "steer");
    expect(steerFrames.map((f) => frameData(f).steer.state)).toEqual(["queued", "dropped"]);
    expect(frameData(steerFrames[1]).steer.id).toBe(accepted.body.steer.id);
    // The drop lands BEFORE the terminal frame, so the client can retire the
    // pending bubble before it stops reading.
    const cancelled = frames.find((f) => f.event === "cancelled")!;
    expect(frames.indexOf(steerFrames[1])).toBeLessThan(frames.indexOf(cancelled));
    // It never reached the model, so it is not in the transcript.
    expect(
      store.listMessages(ownerId, "conv-steerstop").some((m) => m.kind === "steer"),
    ).toBe(false);
  }, LIVE);
});

describe("conversation list live-run state", () => {
  /** The `activeRun` field GET /api/conversations attaches to each row. */
  async function activeRunRows(
    agent: ReturnType<typeof request.agent>,
  ): Promise<Map<string, ConversationSummary["activeRun"]>> {
    const res = await agent.get("/api/conversations").expect(200);
    const rows = res.body.conversations as ConversationSummary[];
    return new Map(rows.map((row) => [row.id, row.activeRun]));
  }

  it("marks the conversation whose run is live and clears it when the run closes", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "convrun").expect(201)).body.user.id as string;

    // A finished turn — its row must read as idle, not merely absent.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-idle", message: "안녕" })
      .expect(200);

    let release!: () => void;
    const parked = new Promise<void>((resolve) => (release = resolve));
    H.impl = async (_req, _pr, config, _store, events) => {
      events.onDelta?.("생각 중");
      await parked;
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "다 했습니다" };
    };

    const streamDone = fireStream(owner, {
      avatarId: ownerId,
      conversationId: "conv-live",
      message: "오래 걸리는 일",
    });
    await waitUntil(async () => Boolean(await activeRun(owner, "conv-live")), "run registered");

    const live = await activeRunRows(owner);
    expect(live.get("conv-idle")).toBeNull();
    expect(live.get("conv-live")).toEqual({ background: false });

    release();
    await streamDone;
    expect((await activeRunRows(owner)).get("conv-live")).toBeNull();
  }, LIVE);

  it("flags a row whose run has entered the background phase", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "convbgrun").expect(201)).body.user.id as string;

    const tasks = [{ taskId: "t1", taskType: "local_bash", description: "빌드 실행" }];
    let release!: () => void;
    const parked = new Promise<void>((resolve) => (release = resolve));
    H.impl = async (_req, _pr, config, _store, events) => {
      events.onDelta?.("바로 보이는 답변");
      events.onBackgroundTasks?.({ tasks });
      events.onTurnResult?.({ text: "바로 보이는 답변", backgroundTasks: tasks });
      await parked;
      events.onBackgroundTasks?.({ tasks: [] });
      return { kind: "text", runtime: config.agentRuntime, summary: "집계", text: "집계 응답" };
    };

    const streamDone = fireStream(owner, {
      avatarId: ownerId,
      conversationId: "conv-bgrow",
      message: "빌드 돌려줘",
    });
    await waitUntil(
      async () => (await activeRun(owner, "conv-bgrow"))?.background === true,
      "run marked as background",
    );

    expect((await activeRunRows(owner)).get("conv-bgrow")).toEqual({ background: true });

    release();
    await streamDone;
  }, LIVE);
});

describe("second-brain memory notices", () => {
  it("emits a 기억 row per note write, each with its own replay-stable id", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "memnote").expect(201)).body.user.id as string;

    H.impl = async (_req, _pr, config, _store, events) => {
      events.onMemory?.({ scope: "personal", action: "add", path: "wiki/people/kim.md" });
      events.onMemory?.({ scope: "group", action: "update", path: "wiki/rules.md", groupName: "플랫폼" });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "기억했습니다" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-mem", message: "기억해줘" })
      .expect(200);

    const memory = parseSse(res.text).filter((f) => f.event === "memory");
    expect(memory).toHaveLength(2);
    expect(memory[0].data).toMatchObject({ scope: "personal", action: "add", path: "wiki/people/kim.md" });
    expect(memory[1].data).toMatchObject({ scope: "group", action: "update", groupName: "플랫폼" });
    // The client dedupes replayed rows by this id, so the two must differ.
    expect(frameData(memory[0]).id).toEqual(expect.any(String));
    expect(frameData(memory[0]).id).not.toBe(frameData(memory[1]).id);
  });
});

describe("context compaction notices", () => {
  it("relays a completed and a failed compaction, each with a replay-stable id", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "compactnote").expect(201)).body.user.id as string;

    H.impl = async (_req, _pr, config, _store, events) => {
      events.onCompact?.({ ok: true, trigger: "auto", preTokens: 152_000 });
      events.onCompact?.({ ok: false, error: "summary request failed" });
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "계속합니다" };
    };

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-compact", message: "긴 대화" })
      .expect(200);

    const compact = parseSse(res.text).filter((f) => f.event === "compact");
    expect(compact).toHaveLength(2);
    expect(compact[0].data).toMatchObject({ ok: true, trigger: "auto", preTokens: 152_000 });
    expect(compact[1].data).toMatchObject({ ok: false, error: "summary request failed" });
    expect(frameData(compact[0]).id).toEqual(expect.any(String));
    expect(frameData(compact[0]).id).not.toBe(frameData(compact[1]).id);
  });
});

describe("external avatar turns", () => {
  /** A gateway-backed avatar; `visibleToGroupIds` is filled in per test. */
  function externalAvatar(): ExternalAgentConfig {
    return {
      id: "research",
      displayName: "Research Agent",
      alias: "리서처",
      bio: "외부 조사 에이전트",
      persona: "공개 소개",
      intro: "외부 Gateway에서 실행됩니다.",
      hashtags: ["research"],
      endpoint: "https://gateway.example.com/v1/agents/messages",
      agent: "claude",
      model: "gateway-default",
      apiKey: "gateway-secret",
      visibleToGroupIds: [],
    };
  }

  /** Boot an app where `external` is reachable by the (only) signed-up viewer. */
  async function bootWithExternal(username: string) {
    const external = externalAvatar();
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
      externalAgents: [external],
    });
    const app = createApp(services);
    const viewer = request.agent(app);
    const viewerId = (await signup(viewer, username).expect(201)).body.user.id as string;
    const group = services.store.createGroup({ name: "ext-viewers" });
    services.store.addGroupMember(group.id, viewerId);
    external.visibleToGroupIds = [group.id];
    return { services, app, viewer, viewerId, external, store: services.store };
  }

  it("fans out every gateway event and keeps the turn out of local SDK state", async () => {
    const { store, viewer, viewerId } = await bootWithExternal("extfan");

    H.externalImpl = async (_req, _external, events) => {
      events.onStatus?.("조사 중");
      events.onPlugin?.({ status: "installed", name: "gateway-plugin" });
      events.onToolStart?.({ toolUseId: "t1", name: "WebSearch", agentId: "main" });
      events.onToolEnd?.({ toolUseId: "t1", ok: true });
      events.onTaskStart?.({ taskId: "k1", description: "조사" });
      events.onTaskUpdate?.({ taskId: "k1", status: "running" });
      events.onTaskEnd?.({ taskId: "k1", ok: true, status: "done" });
      events.onAgentStart?.({ agentId: "a1", parentId: "main", subagentType: "explore" });
      events.onAgentEnd?.({ agentId: "a1", ok: true });
      events.onBlocked?.({ toolName: "Bash", agentId: "main", reason: "read-only" });
      events.onMemory?.({ scope: "personal", action: "add", path: "wiki/외부.md" });
      events.onCompact?.({ ok: true, trigger: "auto", preTokens: 120_000 });
      events.onPlan?.({ plan: "", planning: true });
      events.onPlan?.({ plan: "외부 계획" });
      events.onThinking?.("외부 생각");
      events.onDelta?.("외부 답변");
      // A gateway session id must never become Noah continuation state, so the
      // route wires no onSessionId at all for external runs.
      expect(events.onSessionId).toBeUndefined();
      expect(events.onModel).toBeUndefined();
      return { kind: "text", runtime: "external", summary: "완료", text: "외부 답변" };
    };

    const res = await viewer
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "conv-ext", message: "조사해줘" })
      .expect(200);

    const frames = parseSse(res.text);
    const names = frames.map((f) => f.event);
    for (const name of [
      "open", "status", "plugin", "tool", "tool_end", "task", "task_update", "task_end",
      "agent", "agent_end", "blocked", "memory", "compact", "plan", "thinking", "delta", "done",
    ]) {
      expect(names).toContain(name);
    }
    expect(frames.filter((f) => f.event === "plan")).toHaveLength(2);
    expect(frameData(frames.find((f) => f.event === "memory")!).id).toEqual(expect.any(String));

    const done = frames.find((f) => f.event === "done")!.data as { response: AgentResponse };
    expect(done.response.plan).toBe("외부 계획");
    expect(done.response.thinking).toBe("외부 생각");

    const assistant = store.listMessages(viewerId, "conv-ext").find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("외부 답변");
    // Stateless by contract: nothing to resume next turn.
    expect(store.getAgentSessionId(viewerId, "conv-ext")).toBeNull();
    expect(store.listAudit(viewerId, true).some((e) => e.detail === "chat with Research Agent (external)")).toBe(true);
  });

  it("sends the viewer-picked gateway model, falling back to the admin default", async () => {
    const { viewer } = await bootWithExternal("extmodel");
    H.externalImpl = async (_req, _external, events) => {
      events.onDelta?.("답");
      return { kind: "text", runtime: "external", summary: "완료", text: "답" };
    };

    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "conv-extm", message: "질문", model: "gateway-alt" })
      .expect(200);
    expect(H.externalRequests[0].external.model).toBe("gateway-alt");

    // No pick this turn → the conversation's stored pick still applies.
    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "conv-extm", message: "또" })
      .expect(200);
    expect(H.externalRequests[1].external.model).toBe("gateway-alt");

    // A brand-new conversation with no pick keeps the admin-configured default.
    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: "external:research", conversationId: "conv-extm2", message: "새 대화" })
      .expect(200);
    expect(H.externalRequests[2].external.model).toBe("gateway-default");
  });

  it("502s the composer model catalog when the gateway probe fails", async () => {
    const { viewer } = await bootWithExternal("extcatalog");

    H.probeModels = null; // the mocked probe throws
    const failed = await viewer.get("/api/avatars/external:research/models").expect(502);
    expect(failed.body.error).toContain("Gateway 모델 목록");

    // A recovered gateway is probed again (the failure was never cached).
    H.probeModels = ["claude-sonnet-5", "claude-opus-5"];
    const ok = await viewer.get("/api/avatars/external:research/models").expect(200);
    expect(ok.body).toEqual({
      models: ["claude-sonnet-5", "claude-opus-5"],
      defaultModel: "gateway-default",
    });
  });
});

describe("group shared agents in the chat routes", () => {
  it("lists a group agent's skills from the group repo only, and hides it from non-members", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gaowner").expect(201)).body.user.id as string;
    const group = store.createGroup({ name: "플랫폼" });
    store.addGroupMember(group.id, ownerId);
    const agent = store.createGroupAgent(group.id, { displayName: "팀 비서" })!;
    const avatarId = `group:${group.id}:${agent.id}`;

    // The group has no shared repo yet, so there is nothing to list — the
    // viewer's OWN avatar skills must not leak into a group-agent panel.
    await owner.get(`/api/avatars/${avatarId}/skills`).expect(200).expect({ skills: [] });
    // Group agents use the bootstrap tier picker, not a gateway catalog.
    await owner
      .get(`/api/avatars/${avatarId}/models`)
      .expect(200)
      .expect({ models: [], defaultModel: null });

    const outsider = request.agent(app);
    await signup(outsider, "gaoutsider").expect(201);
    await outsider.get(`/api/avatars/${avatarId}/skills`).expect(404);
  });
});

describe("knowledge-repo load failures degrade to a status frame", () => {
  it("still runs the turn when the owner's personal knowledge repo cannot be loaded", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "repowarn").expect(201)).body.user.id as string;
    store.setKnowledgeRepo(ownerId, path.join(tempDir, "missing", "knowledge.git"), null);

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-warn", message: "안녕" })
      .expect(200);

    const warnings = parseSse(res.text).filter(
      (f) => f.event === "status" && String((f.data as { label: string }).label).startsWith("플러그인 경고"),
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0].data as { label: string }).label).toContain("불러오기 실패");
    // The failure costs the avatar its standing memory, not the turn.
    expect(H.requests).toHaveLength(1);
    expect(H.requests[0].knowledgeMemory).toMatchObject({ personal: null });
  });

  it("reports a failed group repo on a group shared-agent turn", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gawarn").expect(201)).body.user.id as string;
    const group = store.createGroup({ name: "플랫폼" });
    store.addGroupMember(group.id, ownerId);
    store.setGroupKnowledgeRepo(group.id, path.join(tempDir, "missing", "group.git"), null);
    const agent = store.createGroupAgent(group.id, { displayName: "팀 비서" })!;

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: `group:${group.id}:${agent.id}`, conversationId: "conv-gawarn", message: "안녕" })
      .expect(200);

    const warnings = parseSse(res.text).filter(
      (f) => f.event === "status" && String((f.data as { label: string }).label).startsWith("플러그인 경고"),
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0].data as { label: string }).label).toContain("불러오기 실패");
    // The run still carries the group-agent kind (group resources only).
    expect(H.requests[0].groupAgent).toMatchObject({
      groupId: group.id,
      agentId: agent.id,
      groupName: "플랫폼",
    });
    // A group-agent run never resolves a personal working repo or trust list.
    expect(H.requests[0].trustedViaGroups).toEqual([]);
    expect(H.requests[0].activeRepoName).toBeUndefined();
  });
});

describe("admin MCP tool policy clamps the run", () => {
  it("runs with the intersection of the composer choice and the group policy, storing the raw choice", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "policyuser").expect(201)).body.user.id as string;
    const group = store.createGroup({ name: "policy" });
    store.addGroupMember(group.id, ownerId);
    store.setGroupAllowedMcpToolGroups(group.id, ["confluence"]);

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId: "conv-policy",
        message: "작업",
        mcpToolGroups: ["confluence", "git_repo"],
      })
      .expect(200);

    // The RUN is clamped…
    expect(H.requests[0].mcpToolGroups).toEqual(["confluence", "system"]);
    // …while the conversation keeps the user's untouched choice, so lifting the
    // policy later restores it.
    const msgs = await owner.get("/api/messages?conversationId=conv-policy").expect(200);
    expect(msgs.body.selectedMcpToolGroups).toEqual(["confluence", "git_repo"]);
  });
});

describe("working-repo resolution (opened repo becomes the run cwd)", () => {
  it("runs inside the opened repo's clone and frees the per-clone lock afterwards", async () => {
    const { store, config, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "repoopen").expect(201)).body.user.id as string;
    const remote = makeBareRemote(path.join(tempDir, "work-remote.git"));
    store.upsertGitRepo(ownerId, "workrepo", remote, null);
    store.touchConversation(ownerId, "conv-open", ownerId, "seed");
    store.setConversationWorkingRepo("conv-open", "workrepo");

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-open", message: "코드 고쳐줘" })
      .expect(200);

    const clonePath = gitRepoClonePath(ownerId, "workrepo", config);
    expect(H.requests[0].cwd).toBe(clonePath);
    expect(H.requests[0].activeRepoName).toBe("workrepo");
    // The scratch workspace stays writable alongside the clone.
    expect(H.requests[0].additionalDirs).toHaveLength(1);
    expect(H.requests[0].additionalDirs![0]).toContain("conv-open");
    expect(fs.existsSync(path.join(clonePath, ".git"))).toBe(true);

    // The run released the serialization lock on its way out.
    expect(acquireActiveRepo(clonePath, "later-conversation")).toBe(true);
    releaseActiveRepo(clonePath, "later-conversation");
  });

  it("502s before SSE when the opened repo cannot be cloned", async () => {
    const { store, config, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "repobroken").expect(201)).body.user.id as string;
    store.upsertGitRepo(ownerId, "brokenrepo", path.join(tempDir, "missing", "nope.git"), null);
    store.touchConversation(ownerId, "conv-broken", ownerId, "seed");
    store.setConversationWorkingRepo("conv-broken", "brokenrepo");

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-broken", message: "작업" })
      .expect(502);
    expect(res.body.error).toContain("저장소 작업공간을 열지 못했습니다");
    expect(H.requests).toHaveLength(0);

    // The failed attempt must not strand the per-clone lock.
    const clonePath = gitRepoClonePath(ownerId, "brokenrepo", config);
    expect(acquireActiveRepo(clonePath, "later-conversation")).toBe(true);
    releaseActiveRepo(clonePath, "later-conversation");
  });

  // NOTE: the post-clone re-check (`racedRun`) needs two POSTs to interleave
  // around the internal `await resolveActiveWorkspaceRepo`. A two-request
  // version of this test passes in isolation but goes load-sensitive when the
  // chat files run together, so the branch is left uncovered rather than
  // flaky-covered.
});

describe("formatDurationKo", () => {
  it("renders an unattended-run budget in minutes, hours, or both", () => {
    expect(formatDurationKo(30 * 60_000)).toBe("30분");
    expect(formatDurationKo(60 * 60_000)).toBe("1시간");
    expect(formatDurationKo(90 * 60_000)).toBe("1시간 30분");
    expect(formatDurationKo(300 * 60_000)).toBe("5시간");
  });
});
