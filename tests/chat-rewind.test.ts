import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig, MessageAttachment, SdkResumePoint } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { parseSse, signup, withTempDir } from "./helpers.js";

/**
 * Conversation rewind ("여기서부터 다시") and regenerate over the HTTP surface.
 *
 * The agent layer is mocked so a test can SCRIPT a turn (session ids, resume
 * points, turn boundaries) and inspect the exact AgentRequest the route built;
 * the working-repo resolver is mocked so a test can act DURING the turn's one
 * await — the only window in which another writer can race a rewind.
 */
const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  /** Per-turn behavior, consumed in call order; missing → one default point. */
  script: [] as ((
    req: AgentRequest,
    events: AgentEvents,
    store: import("../src/server/store.js").Store,
  ) => Promise<void> | void)[],
  /** Runs inside the turn's working-repo await, consumed in call order. */
  duringRepoResolve: [] as (() => void)[],
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      _pluginRoots: unknown,
      config: AppConfig,
      store: import("../src/server/store.js").Store,
      events: AgentEvents,
    ) => {
      H.requests.push(agentRequest);
      const n = H.requests.length;
      const step = H.script.shift();
      if (step) {
        await step(agentRequest, events, store);
      } else {
        events.onSessionId?.(`sess-run-${n}`);
        events.onResumePoint?.({ sessionId: `sess-run-${n}`, uuid: `uuid-run-${n}` });
      }
      events.onDelta?.(`[mock] ${agentRequest.message}`);
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: `[mock] ${agentRequest.message}`,
      };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

vi.mock("../src/server/activeRepoResolve.js", () => ({
  resolveActiveWorkspaceRepo: vi.fn(async () => {
    await Promise.resolve();
    H.duringRepoResolve.shift()?.();
    return { kind: "none" };
  }),
}));

import { createApp, createServices } from "../src/server/app.js";
import { closeRun, openRun } from "../src/server/agent/runRegistry.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { newShareTokenSalt } from "../src/server/shareLinks.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import { claimRoutineSlot, releaseRoutineSlot } from "../src/server/routineRunRegistry.js";
import type { Store } from "../src/server/store.js";

let tempDir: string;
const getTempDir = withTempDir("rewind", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
  H.script.length = 0;
  H.duringRepoResolve.length = 0;
});

const T0 = Date.parse("2026-09-30T00:00:00.000Z");
/** A deterministic timeline: minute `n` after T0, as the store's ISO format. */
const at = (n: number) => new Date(T0 + n * 60_000).toISOString();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "claude", sessionSecret: "test" });
  return { app: createApp(services), store: services.store, config: services.config };
}
type Booted = ReturnType<typeof boot>;

async function newOwner(t: Booted, username = "owner") {
  const agent = request.agent(t.app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

/** The raw better-sqlite3 handle, for timestamps and columns the API never exposes. */
function dbOf(store: Store) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

interface SeedRow {
  role: "user" | "assistant";
  content: string;
  at: number;
  kind?: "steer" | "queued";
  attachments?: MessageAttachment[];
  resumePoint?: SdkResumePoint;
}

/** Seed a conversation's rows on a fixed timeline; returns the stored messages. */
function seed(store: Store, ownerId: string, conversationId: string, rows: SeedRow[]) {
  store.touchConversation(ownerId, conversationId, ownerId, rows[0]?.content ?? "대화");
  return rows.map((row) => {
    const message = store.addMessage(conversationId, {
      role: row.role,
      content: row.content,
      ...(row.kind ? { kind: row.kind } : {}),
      ...(row.attachments ? { attachments: row.attachments } : {}),
      ...(row.resumePoint ? { resumePoint: row.resumePoint } : {}),
    });
    dbOf(store).prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at(row.at), message.id);
    return { ...message, createdAt: at(row.at) };
  });
}

function resumePointOf(store: Store, messageId: string) {
  return dbOf(store)
    .prepare("SELECT sdk_session_id AS sessionId, sdk_uuid AS uuid FROM messages WHERE id = ?")
    .get(messageId) as { sessionId: string | null; uuid: string | null };
}

function linkFor(store: Store, ownerUserId: string, conversationId: string, fileId: string): string {
  const id = crypto.randomUUID();
  store.createShareLink({
    id,
    ownerUserId,
    conversationId,
    fileId,
    fileName: "deck.pptx",
    slideIds: [],
    tokenHash: crypto.randomBytes(32).toString("hex"),
    tokenSalt: newShareTokenSalt(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return id;
}

function linkExists(store: Store, id: string): boolean {
  return Boolean(dbOf(store).prepare("SELECT 1 FROM share_links WHERE id = ?").get(id));
}

function writeFile(dir: string, name: string, bytes: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const fileCard = (id: string): MessageAttachment => ({
  id,
  kind: "file",
  mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  name: "deck.pptx",
  size: 4,
});
const image = (id: string, hidden = false): MessageAttachment => ({
  id,
  kind: "image",
  mediaType: "image/png",
  name: `${id}.png`,
  ...(hidden ? { hidden: true } : {}),
});

function openFrame(text: string) {
  return parseSse(text).find((frame) => frame.event === "open")!.data as {
    conversationId: string;
    runId: string;
    userMessageId?: string;
  };
}

describe("rewind — store", () => {
  it("plans from/after an anchor and reads the resume point of the row right before it", async () => {
    const t = boot();
    const { id: ownerId } = await newOwner(t);
    const [u1, a1, u2, a2, u3] = seed(t.store, ownerId, "c1", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2, resumePoint: { sessionId: "s1", uuid: "u-a1" } },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4 },
      { role: "user", content: "셋째 질문", at: 5 },
    ]);

    const from = t.store.planConversationRewind(ownerId, "c1", u2.id, "from")!;
    expect(from.anchor.id).toBe(u2.id);
    expect(from.keep.map((m) => m.id)).toEqual([u1.id, a1.id]);
    expect(from.drop.map((m) => m.id)).toEqual([u2.id, a2.id, u3.id]);
    expect(from.resumeAt).toEqual({ sessionId: "s1", uuid: "u-a1" });
    expect(from.cutoffCreatedAt).toBe(at(3));

    const after = t.store.planConversationRewind(ownerId, "c1", u2.id, "after")!;
    expect(after.keep.map((m) => m.id)).toEqual([u1.id, a1.id]);
    expect(after.drop.map((m) => m.id)).toEqual([a2.id, u3.id]);
    // The cutoff is the ANCHOR's time in both modes: the discarded run's side
    // state predates its first answer row.
    expect(after.cutoffCreatedAt).toBe(at(3));

    // The row before the anchor has no point (a2) → the re-run rebuilds from text.
    expect(t.store.planConversationRewind(ownerId, "c1", u3.id, "from")!.resumeAt).toBeNull();
    // First message: nothing kept, nothing to resume.
    const first = t.store.planConversationRewind(ownerId, "c1", u1.id, "from")!;
    expect(first.keep).toEqual([]);
    expect(first.resumeAt).toBeNull();

    // The SDK columns never reach a StoredMessage.
    for (const message of t.store.listMessages(ownerId, "c1")) {
      expect(Object.keys(message)).not.toContain("sdkSessionId");
      expect(JSON.stringify(message)).not.toContain("u-a1");
    }
    // Someone else's conversation / an unknown row → no plan.
    const { id: otherId } = await newOwner(t, "other");
    expect(t.store.planConversationRewind(otherId, "c1", u2.id, "from")).toBeNull();
    expect(t.store.planConversationRewind(ownerId, "c1", "nope", "from")).toBeNull();
    expect(t.store.applyConversationRewind(otherId, "c1", from)).toBe(false);
    expect(t.store.listMessages(ownerId, "c1")).toHaveLength(5);
  });

  it("applies a rewind: exact rows, deck links, bot tasks and canvases from the anchor on, and the session", async () => {
    const t = boot();
    const { id: ownerId } = await newOwner(t);
    const [u1, a1, u2] = seed(t.store, ownerId, "c2", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2, attachments: [fileCard("f1")] },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4, attachments: [fileCard("f2")] },
    ]);
    const keptLink = linkFor(t.store, ownerId, "c2", "f1");
    const droppedLink = linkFor(t.store, ownerId, "c2", "f2");
    t.store.setAgentSessionId(ownerId, "c2", "sess-current");
    const db = dbOf(t.store);
    const task = (title: string, minute: number) => {
      const row = t.store.createBotTask({
        ownerUserId: ownerId,
        agentId: "bot",
        conversationId: "c2",
        title,
        requestText: title,
        status: "running",
      });
      db.prepare("UPDATE bot_tasks SET status = 'done', created_at = ? WHERE id = ?").run(at(minute), row.id);
      return row.id;
    };
    const keptTask = task("이전 작업", 2);
    const droppedTask = task("버려진 작업", 3);
    const canvas = (id: string, content: string) =>
      t.store.upsertCanvasArtifact(ownerId, "c2", { artifactId: id, title: id, content, contentType: "markdown" });
    const stamp = (id: string, version: number, minute: number) => {
      db.prepare("UPDATE canvas_versions SET created_at = ? WHERE artifact_id = ? AND version = ?").run(at(minute), id, version);
    };
    // "refined": shown before the anchor, refined after it → back to v1.
    canvas("refined", "v1");
    db.prepare("UPDATE canvas_artifacts SET created_at = ? WHERE id = 'refined'").run(at(2));
    stamp("refined", 1, 2);
    canvas("refined", "v2");
    stamp("refined", 2, 4);
    // "fresh": first shown by a discarded turn → gone.
    canvas("fresh", "new");
    db.prepare("UPDATE canvas_artifacts SET created_at = ? WHERE id = 'fresh'").run(at(4));
    // "pruned": every version it still has is from after the anchor → untouched.
    canvas("pruned", "late");
    db.prepare("UPDATE canvas_artifacts SET created_at = ? WHERE id = 'pruned'").run(at(1));
    stamp("pruned", 1, 5);

    const plan = t.store.planConversationRewind(ownerId, "c2", u2.id, "from")!;
    // A row appended after planning (a routine's report) survives: delete is by id.
    const late = t.store.addMessage("c2", { role: "assistant", content: "늦게 도착한 보고" });
    expect(t.store.applyConversationRewind(ownerId, "c2", plan)).toBe(true);

    expect(t.store.listMessages(ownerId, "c2").map((m) => m.id)).toEqual([u1.id, a1.id, late.id]);
    expect(linkExists(t.store, keptLink)).toBe(true);
    expect(linkExists(t.store, droppedLink)).toBe(false);
    expect(t.store.getBotTask(keptTask)).not.toBeNull();
    expect(t.store.getBotTask(droppedTask)).toBeNull();
    const canvases = t.store.listCanvasArtifacts(ownerId, "c2");
    expect(canvases.map((c) => c.id).sort()).toEqual(["pruned", "refined"]);
    const refined = canvases.find((c) => c.id === "refined")!;
    expect(refined).toMatchObject({ content: "v1", currentVersion: 1, versionCount: 1 });
    expect(canvases.find((c) => c.id === "pruned")).toMatchObject({ content: "late", currentVersion: 1 });
    // A refine after the rewind appends cleanly on top of the restored version.
    expect(canvas("refined", "v2 again")).toMatchObject({ currentVersion: 2, content: "v2 again" });
    // The session still holds the discarded turns — never resumed again.
    expect(t.store.getAgentSessionId(ownerId, "c2")).toBeNull();
  });

  it("finds the regenerate anchor past steers and round-trips the queued kind", async () => {
    const t = boot();
    const { id: ownerId } = await newOwner(t);
    const [, u2] = seed(t.store, ownerId, "c3", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "user", content: "둘째 질문", at: 2 },
      { role: "assistant", content: "답", at: 3 },
      { role: "user", content: "응답 중 보낸 말", at: 4, kind: "steer" },
      { role: "assistant", content: "후속 답", at: 5 },
    ]);
    expect(t.store.findRegenerateAnchorId(ownerId, "c3")).toBe(u2.id);
    const { id: otherId } = await newOwner(t, "other");
    expect(t.store.findRegenerateAnchorId(otherId, "c3")).toBeNull();

    const queued = t.store.addMessage("c3", { role: "user", content: "대기열 메시지", kind: "queued" });
    expect(queued.kind).toBe("queued");
    expect(t.store.listMessages(ownerId, "c3").at(-1)).toMatchObject({ id: queued.id, kind: "queued" });
    // A queued row is still a user row the regenerate anchor search returns
    // (the route refuses it); steers stay skipped.
    expect(t.store.findRegenerateAnchorId(ownerId, "c3")).toBe(queued.id);

    // markMessageQueued re-marks only an ORDINARY user row.
    const plain = t.store.addMessage("c3", { role: "user", content: "보통 메시지" });
    t.store.markMessageQueued(plain.id);
    const steer = t.store.listMessages(ownerId, "c3").find((m) => m.kind === "steer")!;
    t.store.markMessageQueued(steer.id);
    const rows = t.store.listMessages(ownerId, "c3");
    expect(rows.find((m) => m.id === plain.id)!.kind).toBe("queued");
    expect(rows.find((m) => m.id === steer.id)!.kind).toBe("steer");
    // Ordinary rows keep their exact pre-column shape (no `kind` key at all).
    expect(Object.keys(rows[0])).not.toContain("kind");
  });
});

describe("rewind — edit an earlier message", () => {
  it("replaces the anchor and everything after it, resuming exactly at the previous answer", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [u1, a1, u2] = seed(t.store, owner.id, "e1", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2, resumePoint: { sessionId: "sess-a", uuid: "uuid-a1" } },
      { role: "user", content: "둘째 질문", at: 3 },
      {
        role: "assistant",
        content: "둘째 답",
        at: 4,
        attachments: [fileCard("f2"), image("shown", true)],
        resumePoint: { sessionId: "sess-a", uuid: "uuid-a2" },
      },
    ]);
    const deck = writeFile(chatFilesDir(t.config, "e1"), "f2.pptx", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const shown = writeFile(chatImagesDir(t.config, "e1"), "shown.png", PNG);
    const link = linkFor(t.store, owner.id, "e1", "f2");
    t.store.setAgentSessionId(owner.id, "e1", "sess-a");

    const res = await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "e1", message: "고친 질문", rewindFromMessageId: u2.id })
      .expect(200);

    expect(H.requests).toHaveLength(1);
    const sent = H.requests[0];
    expect(sent.message).toBe("고친 질문");
    expect(sent.resumeSessionId).toBe("sess-a");
    expect(sent.resumeSessionAt).toBe("uuid-a1");
    expect(sent.conversationHistory).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "assistant", content: "첫 답" },
    ]);
    expect(sent.rewind).toEqual({ kind: "edit", discardedMessages: 1 });

    const rows = t.store.listMessages(owner.id, "e1");
    expect(rows.map((m) => m.content)).toEqual(["첫 질문", "첫 답", "고친 질문", "[mock] 고친 질문"]);
    expect(rows.slice(0, 2).map((m) => m.id)).toEqual([u1.id, a1.id]);
    // The replacement is a NEW row, and the open frame names it.
    expect(rows[2].id).not.toBe(u2.id);
    expect(openFrame(res.text).userMessageId).toBe(rows[2].id);
    // The discarded answer's bytes and deck link are gone.
    expect(fs.existsSync(deck)).toBe(false);
    expect(fs.existsSync(shown)).toBe(false);
    expect(linkExists(t.store, link)).toBe(false);
    // The re-run's own session (the fork) is what the next turn resumes, and
    // its answer recorded where it ended.
    expect(t.store.getAgentSessionId(owner.id, "e1")).toBe("sess-run-1");
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: "sess-run-1", uuid: "uuid-run-1" });
  });

  it("rebuilds from the kept text history when the previous answer recorded no point", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [, , u2] = seed(t.store, owner.id, "e2", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4 },
    ]);
    t.store.setAgentSessionId(owner.id, "e2", "sess-current");

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "e2", message: "다른 질문", rewindFromMessageId: u2.id })
      .expect(200);

    const sent = H.requests[0];
    // Never the CURRENT session: its transcript still holds the discarded turn.
    expect(sent.resumeSessionId).toBeUndefined();
    expect(sent.resumeSessionAt).toBeUndefined();
    expect(sent.conversationHistory).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "assistant", content: "첫 답" },
    ]);
  });

  it("keeps the anchor's images on the replacement row and starts a vision re-feed fresh", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [, , u2] = seed(t.store, owner.id, "e3", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2, resumePoint: { sessionId: "sess-a", uuid: "uuid-a1" } },
      { role: "user", content: "이 사진 봐줘", at: 3, attachments: [image("photo")] },
      { role: "assistant", content: "사진 답", at: 4 },
    ]);
    const photo = writeFile(chatImagesDir(t.config, "e3"), "photo.png", PNG);

    // Text left empty on purpose: the anchor's image alone is a valid message.
    const res = await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "e3", message: "", rewindFromMessageId: u2.id })
      .expect(200);
    expect(parseSse(res.text).some((frame) => frame.event === "done")).toBe(true);

    const sent = H.requests[0];
    expect(sent.images).toHaveLength(1);
    // Image blocks and `resume` don't mix (the chat route's image-turn rule).
    expect(sent.resumeSessionId).toBeUndefined();
    const rows = t.store.listMessages(owner.id, "e3");
    expect(rows[2]).toMatchObject({ role: "user", content: "", attachments: [image("photo")] });
    expect(fs.existsSync(photo)).toBe(true);
  });

  it("validates the anchor and the request shape, leaving the thread untouched", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [u1, a1, , steer, , queued] = seed(t.store, owner.id, "e4", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "user", content: "응답 중 보낸 말", at: 4, kind: "steer" },
      { role: "assistant", content: "둘째 답", at: 5 },
      { role: "user", content: "대기열 메시지", at: 6, kind: "queued" },
    ]);
    const other = await newOwner(t, "other");
    const [foreign] = seed(t.store, other.id, "e4-other", [{ role: "user", content: "남의 메시지", at: 1 }]);
    const send = (body: object) =>
      owner.agent.post("/api/chat/stream").send({ avatarId: owner.id, conversationId: "e4", message: "수정", ...body });

    expect((await send({ rewindFromMessageId: "no-such-row" }).expect(404)).body.error).toBe("메시지를 찾을 수 없습니다.");
    expect((await send({ rewindFromMessageId: foreign.id }).expect(404)).body.error).toBe("메시지를 찾을 수 없습니다.");
    expect((await send({ rewindFromMessageId: steer.id }).expect(400)).body.error).toBe("이 메시지에서는 다시 시작할 수 없습니다.");
    expect((await send({ rewindFromMessageId: a1.id }).expect(400)).body.error).toBe("이 메시지에서는 다시 시작할 수 없습니다.");
    expect((await send({ rewindFromMessageId: queued.id }).expect(400)).body.error).toBe(
      "대기열로 보낸 메시지부터는 다시 시작할 수 없습니다.",
    );
    expect((await send({ rewindFromMessageId: u1.id, regenerate: true }).expect(400)).body.error).toBe("요청이 올바르지 않습니다.");
    expect((await send({ rewindFromMessageId: "../etc" }).expect(400)).body.error).toBe("요청이 올바르지 않습니다.");
    expect(
      (
        await send({
          rewindFromMessageId: u1.id,
          images: [{ id: "i1", data: `data:image/png;base64,${PNG.toString("base64")}` }],
        }).expect(400)
      ).body.error,
    ).toBe("다시 시작할 때는 이미지를 새로 첨부할 수 없습니다.");
    expect((await send({ rewindFromMessageId: u1.id, message: "" }).expect(400)).body.error).toBe("메시지를 입력해 주세요.");

    expect(H.requests).toHaveLength(0);
    expect(t.store.listMessages(owner.id, "e4")).toHaveLength(6);
  });

  it("refuses while other work can still write into the thread", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [, , u2] = seed(t.store, owner.id, "e5", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4 },
    ]);
    const rewind = () =>
      owner.agent
        .post("/api/chat/stream")
        .send({ avatarId: owner.id, conversationId: "e5", message: "수정", rewindFromMessageId: u2.id });
    const untouched = () => expect(t.store.listMessages(owner.id, "e5").map((m) => m.content)).toEqual(["첫 질문", "첫 답", "둘째 질문", "둘째 답"]);

    // A live run.
    openRun("live-run", owner.id, { conversationId: "e5" });
    expect((await rewind().expect(409)).body.error).toContain("이미 이 대화의 응답을 생성 중입니다");
    closeRun("live-run");
    untouched();

    // A queued bot task already stored its bubble.
    const queuedTask = t.store.createBotTask({
      ownerUserId: owner.id,
      agentId: "bot",
      conversationId: "e5",
      title: "대기",
      requestText: "대기",
      status: "queued",
    });
    expect((await rewind().expect(409)).body.error).toBe(
      "대기 중인 작업이 있어 지금은 다시 시작할 수 없습니다. 작업이 끝난 뒤 다시 시도해 주세요.",
    );
    dbOf(t.store).prepare("DELETE FROM bot_tasks WHERE id = ?").run(queuedTask.id);
    untouched();

    // A pending external-API task on this thread.
    const { key } = t.store.createAvatarApiKey(owner.id, "ci");
    const apiTask = t.store.acceptAvatarTask(owner.id, key.id, "외부 요청", "e5", null).task;
    expect((await rewind().expect(409)).body.error).toBe("외부 작업이 진행 중이어서 지금은 다시 시작할 수 없습니다.");
    t.store.updateAvatarTask(owner.id, apiTask.id, "cancelled");
    untouched();

    // A run that takes the thread DURING the turn's one await: the raced
    // re-check refuses, and nothing was written.
    H.duringRepoResolve.push(() => openRun("raced-run", owner.id, { conversationId: "e5" }));
    await rewind().expect(409);
    closeRun("raced-run");
    untouched();

    // Work queued during that await is caught by the re-check right before the
    // rewind applies.
    H.duringRepoResolve.push(() => {
      t.store.createBotTask({
        ownerUserId: owner.id,
        agentId: "bot",
        conversationId: "e5",
        title: "경합",
        requestText: "경합",
        status: "queued",
      });
    });
    expect((await rewind().expect(409)).body.error).toContain("대기 중인 작업이 있어");
    untouched();
    expect(H.requests).toHaveLength(0);
  });

  it("moves an auto-derived title to the new first message, never a renamed one", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const titleOf = (conversationId: string) =>
      (dbOf(t.store).prepare("SELECT title FROM conversations WHERE id = ?").get(conversationId) as { title: string }).title;
    const rewindFirst = (conversationId: string, anchorId: string) =>
      owner.agent
        .post("/api/chat/stream")
        .send({ avatarId: owner.id, conversationId, message: "완전히 새로운   첫 질문", rewindFromMessageId: anchorId })
        .expect(200);

    const [auto] = seed(t.store, owner.id, "e7", [
      { role: "user", content: "원래 첫 질문", at: 1 },
      { role: "assistant", content: "원래 답", at: 2 },
    ]);
    expect(titleOf("e7")).toBe("원래 첫 질문");
    await rewindFirst("e7", auto.id);
    expect(titleOf("e7")).toBe("완전히 새로운 첫 질문");

    const [renamed] = seed(t.store, owner.id, "e8", [
      { role: "user", content: "원래 첫 질문", at: 1 },
      { role: "assistant", content: "원래 답", at: 2 },
    ]);
    t.store.renameConversation(owner.id, "e8", "내가 붙인 제목");
    await rewindFirst("e8", renamed.id);
    expect(titleOf("e8")).toBe("내가 붙인 제목");

    // Not the first message → the title is not the rewind's business.
    const [, , later] = seed(t.store, owner.id, "e9", [
      { role: "user", content: "원래 첫 질문", at: 1 },
      { role: "assistant", content: "원래 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
    ]);
    await rewindFirst("e9", later.id);
    expect(titleOf("e9")).toBe("원래 첫 질문");
  });

  it("refuses a plan the thread outgrew during the turn's await instead of applying it", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [, , u2] = seed(t.store, owner.id, "e6", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4 },
    ]);
    const rewind = () =>
      owner.agent
        .post("/api/chat/stream")
        .send({ avatarId: owner.id, conversationId: "e6", message: "수정", rewindFromMessageId: u2.id });
    const drift = "대화 내용이 바뀌어 다시 시작하지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.";
    const contents = () => t.store.listMessages(owner.id, "e6").map((m) => m.content);

    // Another tab's turn ran to completion inside the await: its rows are not
    // in the plan, so applying it would delete by stale ids and leave them.
    H.duringRepoResolve.push(() => {
      t.store.addMessage("e6", { role: "user", content: "다른 탭 질문" });
      t.store.addMessage("e6", { role: "assistant", content: "다른 탭 답" });
    });
    expect((await rewind().expect(409)).body.error).toBe(drift);
    expect(contents()).toEqual(["첫 질문", "첫 답", "둘째 질문", "둘째 답", "다른 탭 질문", "다른 탭 답"]);

    // Another tab's rewind already removed the anchor.
    H.duringRepoResolve.push(() => {
      dbOf(t.store).prepare("DELETE FROM messages WHERE id = ?").run(u2.id);
    });
    expect((await rewind().expect(409)).body.error).toBe(drift);
    expect(H.requests).toHaveLength(0);
  });
});

describe("regenerate", () => {
  it("drops every row after the last ordinary user message and sends its stored text once", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const [u1, a1, u2] = seed(t.store, owner.id, "g1", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2, resumePoint: { sessionId: "sess-a", uuid: "uuid-a1" } },
      { role: "user", content: "둘째 질문", at: 3 },
      // A run with a background phase and a steer's follow-up turn.
      { role: "assistant", content: "본 답변", at: 4, resumePoint: { sessionId: "sess-a", uuid: "uuid-a2" } },
      { role: "assistant", content: "백그라운드 보고", at: 5, resumePoint: { sessionId: "sess-a", uuid: "uuid-a3" } },
      { role: "user", content: "응답 중 보낸 말", at: 6, kind: "steer" },
      { role: "assistant", content: "후속 답", at: 7, resumePoint: { sessionId: "sess-a", uuid: "uuid-a4" } },
    ]);
    // The discarded run's own bot task and canvas predate its first answer row.
    const task = t.store.createBotTask({
      ownerUserId: owner.id,
      agentId: "bot",
      conversationId: "g1",
      title: "작업",
      requestText: "작업",
      status: "running",
    });
    dbOf(t.store).prepare("UPDATE bot_tasks SET status = 'done', created_at = ? WHERE id = ?").run(at(3.5), task.id);
    t.store.upsertCanvasArtifact(owner.id, "g1", { artifactId: "cv", title: "cv", content: "x", contentType: "markdown" });
    dbOf(t.store).prepare("UPDATE canvas_artifacts SET created_at = ? WHERE id = 'cv'").run(at(3.5));

    const res = await owner.agent
      .post("/api/chat/stream")
      // A stale client may send some other text; the stored row wins.
      .send({ avatarId: owner.id, conversationId: "g1", message: "응답 중 보낸 말", regenerate: true })
      .expect(200);

    const sent = H.requests[0];
    expect(sent.message).toBe("둘째 질문");
    // The re-run text appears ONCE: as the message, never also in the history.
    expect(sent.conversationHistory).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "assistant", content: "첫 답" },
    ]);
    expect(sent.resumeSessionId).toBe("sess-a");
    expect(sent.resumeSessionAt).toBe("uuid-a1");
    expect(sent.rewind).toEqual({ kind: "regenerate", discardedMessages: 4 });
    expect(openFrame(res.text).userMessageId).toBe(u2.id);

    const rows = t.store.listMessages(owner.id, "g1");
    expect(rows.map((m) => m.id).slice(0, 3)).toEqual([u1.id, a1.id, u2.id]);
    expect(rows.map((m) => m.content)).toEqual(["첫 질문", "첫 답", "둘째 질문", "[mock] 둘째 질문"]);
    expect(t.store.getBotTask(task.id)).toBeNull();
    expect(t.store.listCanvasArtifacts(owner.id, "g1")).toEqual([]);
  });

  it("refuses a queued anchor and a thread with nothing to re-run", async () => {
    const t = boot();
    const owner = await newOwner(t);
    seed(t.store, owner.id, "g2", [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "user", content: "대기열 메시지", at: 2, kind: "queued" },
      { role: "assistant", content: "첫 답", at: 3 },
    ]);
    const regen = (conversationId: string) =>
      owner.agent.post("/api/chat/stream").send({ avatarId: owner.id, conversationId, message: "x", regenerate: true });
    expect((await regen("g2").expect(400)).body.error).toBe("대기열로 보낸 메시지에는 다시 생성을 쓸 수 없습니다.");
    expect((await regen("g-empty").expect(400)).body.error).toBe("다시 생성할 메시지가 없습니다.");
    expect(t.store.listMessages(owner.id, "g2")).toHaveLength(3);
  });
});

describe("resume points and queued rows", () => {
  it("stamps the latest main-chain point on turn_end, background and wake-up rows", async () => {
    const t = boot();
    const owner = await newOwner(t);
    H.script.push((_req, events) => {
      events.onSessionId?.("sess-x");
      events.onResumePoint?.({ sessionId: "sess-x", uuid: "p1" });
      events.onTurnResult?.({ text: "첫 구간", backgroundTasks: [], steerPending: true });
      events.onResumePoint?.({ sessionId: "sess-x", uuid: "p2" });
      events.onTurnResult?.({ text: "본 답변", backgroundTasks: [{ taskId: "bg-1" }], steerPending: false });
      events.onResumePoint?.({ sessionId: "sess-x", uuid: "p3" });
      events.onTurnResult?.({ text: "백그라운드 보고", backgroundTasks: [], steerPending: false });
    });

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "r1", message: "일 시작" })
      .expect(200);

    const rows = t.store.listMessages(owner.id, "r1");
    expect(rows.map((m) => m.content)).toEqual(["일 시작", "첫 구간", "본 답변", "백그라운드 보고"]);
    expect(resumePointOf(t.store, rows[0].id)).toEqual({ sessionId: null, uuid: null });
    expect(resumePointOf(t.store, rows[1].id)).toEqual({ sessionId: "sess-x", uuid: "p1" });
    expect(resumePointOf(t.store, rows[2].id)).toEqual({ sessionId: "sess-x", uuid: "p2" });
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: "sess-x", uuid: "p3" });
  });

  it("never stamps a point from an abandoned session, nor on an error row", async () => {
    const t = boot();
    const owner = await newOwner(t);
    H.script.push((_req, events) => {
      events.onSessionId?.("sess-first");
      events.onResumePoint?.({ sessionId: "sess-first", uuid: "stale" });
      // A retry: a new session, and nothing new landed in it.
      events.onSessionId?.("sess-retry");
    });
    H.script.push(() => {
      throw new Error("boom");
    });

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "r2", message: "첫 턴" })
      .expect(200);
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "r2", message: "둘째 턴" })
      .expect(200);

    const rows = t.store.listMessages(owner.id, "r2");
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(resumePointOf(t.store, rows[1].id)).toEqual({ sessionId: null, uuid: null });
    expect(rows[3].content).toContain("응답 생성 중 오류가 발생했습니다");
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: null, uuid: null });
  });

  it("names the persisted row in the open frame and marks a raced refusal's row queued", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const res = await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "r3", message: "안녕" })
      .expect(200);
    const rows = t.store.listMessages(owner.id, "r3");
    expect(openFrame(res.text).userMessageId).toBe(rows[0].id);

    // Another run takes the thread while this turn awaits: its row is already
    // written and now sits before that run's answer.
    H.duringRepoResolve.push(() => openRun("raced", owner.id, { conversationId: "r3" }));
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "r3", message: "늦은 메시지" })
      .expect(409);
    closeRun("raced");
    const late = t.store.listMessages(owner.id, "r3").at(-1)!;
    expect(late).toMatchObject({ role: "user", content: "늦은 메시지", kind: "queued" });
  });
});

function resumeLogOf(store: Store, taskId: string): { at: string; pendingQuestion: string | null; reportedOutcome: string | null }[] {
  const row = dbOf(store).prepare("SELECT resume_log FROM bot_tasks WHERE id = ?").get(taskId) as { resume_log: string | null };
  return row.resume_log ? JSON.parse(row.resume_log) : [];
}

describe("rewind — bot tasks a discarded turn resumed", () => {
  it("puts a task back to the parked state of its first resume at/after the cutoff", async () => {
    const t = boot();
    const { id: ownerId } = await newOwner(t);
    t.store.touchConversation(ownerId, "bt", ownerId, "봇 작업");
    const leg = (minute: number, fn: () => void) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(at(minute)));
      try {
        fn();
      } finally {
        vi.useRealTimers();
      }
    };
    let taskId = "";
    leg(1, () => {
      taskId = t.store.createBotTask({
        ownerUserId: ownerId,
        agentId: "bot",
        conversationId: "bt",
        title: "정리",
        requestText: "정리",
        status: "running",
        runId: "run-1",
      }).id;
      t.store.setBotTaskReport(taskId, { outcome: "need_input", summary: "첫 질문?" });
      t.store.finishBotTask(taskId, { status: "waiting_input", model: "m1" });
    });
    // The owner answers (resume #1 at minute 10), the bot asks again.
    leg(10, () => {
      t.store.markBotTaskRunning(taskId, "run-2");
      t.store.setBotTaskReport(taskId, { outcome: "need_input", summary: "둘째 질문?" });
      t.store.finishBotTask(taskId, { status: "waiting_input", model: "m2" });
    });
    // Answered again (resume #2 at minute 20), and finished.
    leg(20, () => {
      t.store.markBotTaskRunning(taskId, "run-3");
      t.store.setBotTaskReport(taskId, { outcome: "done", summary: "끝났습니다" });
      t.store.finishBotTask(taskId, { status: "done", model: "m3" });
    });
    expect(resumeLogOf(t.store, taskId).map((s) => s.pendingQuestion)).toEqual(["첫 질문?", "둘째 질문?"]);
    const snapshot = dbOf(t.store).prepare("SELECT * FROM bot_tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
    const reset = () =>
      dbOf(t.store)
        .prepare("UPDATE bot_tasks SET status = ?, finished_at = ?, pending_question = ?, reported_outcome = ?, result_summary = ?, model = ?, seen_at = ?, resume_log = ? WHERE id = ?")
        .run(snapshot.status, snapshot.finished_at, snapshot.pending_question, snapshot.reported_outcome, snapshot.result_summary, snapshot.model, snapshot.seen_at, snapshot.resume_log, taskId);

    // Cutoff after the last resume: nothing a discarded turn did → untouched.
    t.store.rewindBotTasks("bt", at(25));
    expect(t.store.getBotTask(taskId)).toMatchObject({ status: "done", resultSummary: "끝났습니다" });

    // Cutoff between the resumes: back to the SECOND question, first leg kept.
    t.store.rewindBotTasks("bt", at(15));
    expect(t.store.getBotTask(taskId)).toMatchObject({
      status: "waiting_input",
      pendingQuestion: "둘째 질문?",
      reportedOutcome: "need_input",
      resultSummary: null,
      finishedAt: null,
      runId: null,
      model: "m2",
    });
    expect(resumeLogOf(t.store, taskId).map((s) => s.pendingQuestion)).toEqual(["첫 질문?"]);

    // Cutoff before both: back to the FIRST question.
    reset();
    t.store.rewindBotTasks("bt", at(5));
    expect(t.store.getBotTask(taskId)).toMatchObject({ status: "waiting_input", pendingQuestion: "첫 질문?", model: "m1" });
    expect(resumeLogOf(t.store, taskId)).toEqual([]);
  });

  async function botThread(t: Booted) {
    const owner = await newOwner(t);
    const agent = t.store.createPersonalAgent(owner.id, { displayName: "리서치 봇" });
    const avatarId = personalAgentAvatarId(owner.id, agent.id);
    const send = (body: object) =>
      owner.agent.post("/api/chat/stream").send({ avatarId, conversationId: "bot-thread", ...body }).expect(200);
    // Turn 1: the bot parks on a question.
    H.script.push((req, _events, store) => {
      store.setBotTaskReport(req.personalAgent!.taskId!, { outcome: "need_input", summary: "어느 쪽으로 할까요?" });
    });
    await send({ message: "보고서 정리해줘" });
    // Turn 2: the owner answers; that turn resumes the parked task and finishes it.
    await send({ message: "A안으로" });
    const [task] = t.store.listBotTasksForConversation("bot-thread");
    expect(task.status).toBe("done");
    const answer = t.store.listMessages(owner.id, "bot-thread").find((m) => m.content === "A안으로")!;
    return { owner, send, task, answer };
  }

  it("re-parks the task an edited answer had resumed, so the re-run resumes it instead of opening a duplicate", async () => {
    const t = boot();
    const { send, task, answer } = await botThread(t);

    await send({ message: "B안으로", rewindFromMessageId: answer.id });

    const tasks = t.store.listBotTasksForConversation("bot-thread");
    expect(tasks.map((row) => row.id)).toEqual([task.id]);
    // The re-run resumed the ORIGINAL card…
    expect(H.requests[2].personalAgent?.taskId).toBe(task.id);
    expect(tasks[0].status).toBe("done");
    // …from its restored parked state: the one resume left on the log is the
    // re-run's, taken from the question pending again.
    expect(resumeLogOf(t.store, task.id)).toMatchObject([
      { pendingQuestion: "어느 쪽으로 할까요?", reportedOutcome: "need_input" },
    ]);
  });

  it("does the same for a regenerate of that answer", async () => {
    const t = boot();
    const { send, task } = await botThread(t);

    await send({ message: "x", regenerate: true });

    expect(t.store.listBotTasksForConversation("bot-thread").map((row) => row.id)).toEqual([task.id]);
    expect(H.requests[2].personalAgent?.taskId).toBe(task.id);
    expect(H.requests[2].message).toBe("A안으로");
    expect(resumeLogOf(t.store, task.id)).toHaveLength(1);
  });
});

describe("rewind — routines and error boundaries", () => {
  it("refuses while a routine that writes into the thread runs — at plan time and at the last re-check", async () => {
    const t = boot();
    const owner = await newOwner(t);
    const job = t.store.createRoutineJob(owner.id, { prompt: "일일 점검", minuteOfDay: 0 });
    const [, , u2] = seed(t.store, owner.id, job.conversationId, [
      { role: "user", content: "첫 질문", at: 1 },
      { role: "assistant", content: "첫 답", at: 2 },
      { role: "user", content: "둘째 질문", at: 3 },
      { role: "assistant", content: "둘째 답", at: 4 },
    ]);
    const rewind = () =>
      owner.agent
        .post("/api/chat/stream")
        .send({ avatarId: owner.id, conversationId: job.conversationId, message: "수정", rewindFromMessageId: u2.id });

    claimRoutineSlot(job);
    try {
      expect((await rewind().expect(409)).body.error).toBe("루틴이 실행 중이어서 지금은 다시 시작할 수 없습니다.");
    } finally {
      releaseRoutineSlot(job);
    }
    // A routine that starts DURING the turn's await is caught right before apply.
    H.duringRepoResolve.push(() => claimRoutineSlot(job));
    try {
      expect((await rewind().expect(409)).body.error).toBe("루틴이 실행 중이어서 지금은 다시 시작할 수 없습니다.");
    } finally {
      releaseRoutineSlot(job);
    }
    expect(t.store.listMessages(owner.id, job.conversationId)).toHaveLength(4);
    expect(H.requests).toHaveLength(0);

    // With the routine done, the same rewind goes through.
    await rewind().expect(200);
    expect(t.store.listMessages(owner.id, job.conversationId).map((m) => m.content)).toEqual([
      "첫 질문",
      "첫 답",
      "수정",
      "[mock] 수정",
    ]);
  });

  it("stamps no point on a turn_end or done row whose boundary carried an in-band error", async () => {
    const t = boot();
    const owner = await newOwner(t);
    H.script.push((_req, events) => {
      events.onSessionId?.("sess-e");
      events.onResumePoint?.({ sessionId: "sess-e", uuid: "tool-use" });
      events.onTurnResult?.({ text: "중간", backgroundTasks: [], steerPending: true, errorSubtype: "error_max_turns" });
      events.onResumePoint?.({ sessionId: "sess-e", uuid: "later" });
      events.onTurnResult?.({ text: "끝", backgroundTasks: [], errorSubtype: "error_max_turns" });
    });
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "err-1", message: "많이 해줘" })
      .expect(200);
    const rows = t.store.listMessages(owner.id, "err-1");
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(resumePointOf(t.store, rows[1].id)).toEqual({ sessionId: null, uuid: null });
    expect(resumePointOf(t.store, rows[2].id)).toEqual({ sessionId: null, uuid: null });

    // A clean final boundary after an erroring one still stamps the done row.
    H.script.push((_req, events) => {
      events.onSessionId?.("sess-f");
      events.onResumePoint?.({ sessionId: "sess-f", uuid: "clean" });
      events.onTurnResult?.({ text: "끝", backgroundTasks: [] });
    });
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "err-1", message: "다시" })
      .expect(200);
    expect(resumePointOf(t.store, t.store.listMessages(owner.id, "err-1").at(-1)!.id)).toEqual({
      sessionId: "sess-f",
      uuid: "clean",
    });
  });

  it("stamps no point on background rows whose boundary carried an in-band error", async () => {
    const t = boot();
    const owner = await newOwner(t);
    H.script.push((_req, events) => {
      events.onSessionId?.("sess-b");
      events.onResumePoint?.({ sessionId: "sess-b", uuid: "b1" });
      events.onTurnResult?.({ text: "본 답변", backgroundTasks: [{ taskId: "bg" }], errorSubtype: "error_max_turns" });
      events.onResumePoint?.({ sessionId: "sess-b", uuid: "b2" });
      events.onTurnResult?.({ text: "보고", backgroundTasks: [], errorSubtype: "error_during_execution" });
      events.onResumePoint?.({ sessionId: "sess-b", uuid: "b3" });
      events.onTurnResult?.({ text: "마지막 보고", backgroundTasks: [] });
    });
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "err-2", message: "백그라운드로" })
      .expect(200);
    const rows = t.store.listMessages(owner.id, "err-2");
    expect(rows.map((m) => m.content)).toEqual(["백그라운드로", "본 답변", "보고", "마지막 보고"]);
    expect(resumePointOf(t.store, rows[1].id)).toEqual({ sessionId: null, uuid: null });
    expect(resumePointOf(t.store, rows[2].id)).toEqual({ sessionId: null, uuid: null });
    expect(resumePointOf(t.store, rows[3].id)).toEqual({ sessionId: "sess-b", uuid: "b3" });
  });
});
