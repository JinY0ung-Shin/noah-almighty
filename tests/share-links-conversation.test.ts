import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { closeRun, openRun } from "../src/server/agent/runRegistry.js";
import type { Store } from "../src/server/store.js";
import type { AgentResponse, MessageAttachment } from "../src/server/types.js";
import {
  PPTX_MEDIA_TYPE,
  SHARE_LINK_GONE_MESSAGE,
  type ShareLinkSummary,
  type ShareViewMessage,
  type ShareViewPayload,
} from "../src/shared/shareLinks.js";
import { signup, withTempDir } from "./helpers.js";

// Conversation share links: a READ-ONLY link to a conversation up to the last
// message stored when its owner pressed. The file-link half of the feature is
// tests/share-links.test.ts; this file pins what a conversation link shows,
// what it never shows, and when it dies.

let tempDir: string;
const getTempDir = withTempDir("share-links-conversation", () => {
  tempDir = getTempDir();
});

function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "share-secret" });
  return { services, app: createApp(services), store: services.store, config: services.config };
}
type Booted = ReturnType<typeof boot>;
type Agent = ReturnType<typeof request.agent>;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(64, 1)]);

async function newUser(app: Booted["app"], username: string): Promise<{ agent: Agent; id: string }> {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

function dbOf(store: Store) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}
function linkRows(store: Store): number {
  return (dbOf(store).prepare("SELECT COUNT(*) AS n FROM share_links").get() as { n: number }).n;
}

function image(t: Booted, conversationId: string, over: Partial<MessageAttachment> = {}): MessageAttachment {
  const id = crypto.randomUUID();
  const dir = chatImagesDir(t.config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.png`), PNG);
  return { id, kind: "image", mediaType: "image/png", name: "그림.png", ...over };
}
function file(
  t: Booted,
  conversationId: string,
  ext: "pptx" | "pdf" | "png",
  over: Partial<MessageAttachment> = {},
): MessageAttachment {
  const id = crypto.randomUUID();
  const dir = chatFilesDir(t.config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = ext === "pptx" ? PPTX : ext === "pdf" ? PDF : PNG;
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), bytes);
  const mediaType = ext === "pptx" ? PPTX_MEDIA_TYPE : ext === "pdf" ? "application/pdf" : "image/png";
  return { id, kind: "file", mediaType, name: `파일.${ext}`, size: bytes.length, ...over };
}
function answer(text: string, over: Partial<AgentResponse> = {}): AgentResponse {
  return { kind: "text", runtime: "local", summary: "요약", text, ...over };
}

function createLink(agent: Agent, conversationId: string, body: object = {}) {
  return agent.post(`/api/conversations/${conversationId}/share-links`).send(body);
}
function open(agent: Agent, token: unknown) {
  return agent.post("/api/share/open").send({ token });
}
function tokenOf(url: string | null): string {
  const match = /#\/share\/([A-Za-z0-9_-]{43})$/.exec(url ?? "");
  if (!match) throw new Error(`not a share url: ${url}`);
  return match[1];
}
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}
/** The ticket prefix of a payload's asset URLs (`/api/share/t/<ticket>`). */
function ticketBase(url: string): string {
  const match = /^(\/api\/share\/t\/[^/]+)\//.exec(url);
  if (!match) throw new Error(`not a ticket url: ${url}`);
  return match[1];
}

/** Owner + a plain two-message conversation. */
async function seeded(conversationId = "conv-1") {
  const t = boot();
  const owner = await newUser(t.app, "owner");
  const viewer = await newUser(t.app, "viewer");
  t.store.touchConversation(owner.id, conversationId, owner.id, "분기 실적 정리");
  t.store.addMessage(conversationId, { role: "user", content: "분기 실적 정리해 줘" });
  t.store.addMessage(conversationId, { role: "assistant", content: "정리했습니다.", response: answer("**정리**했습니다.") });
  return { t, owner, viewer, conversationId };
}

describe("conversation share links — create", () => {
  it("links the conversation as it stands: reuse while active, listed by kind, audited without the title", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    const res = await createLink(owner.agent, conversationId).expect(201);
    const link = res.body.link as ShareLinkSummary;
    expect(res.body.created).toBe(true);
    expect(link).toMatchObject({
      kind: "conversation",
      conversationId,
      fileId: "",
      fileName: "분기 실적 정리",
      messageCount: 2,
      includesFiles: false,
      slideCount: 0,
      expired: false,
    });
    const token = tokenOf(link.url);

    // One active link per conversation: asking again hands it back unchanged.
    const again = await createLink(owner.agent, conversationId, { expiresInDays: 30, includeFiles: true }).expect(200);
    expect(again.body.created).toBe(false);
    expect(again.body.link).toMatchObject({ id: link.id, includesFiles: false, expiresAt: link.expiresAt });

    const listed = (await owner.agent.get(`/api/me/share-links?conversationId=${conversationId}&kind=conversation`).expect(200))
      .body as ShareLinkSummary[];
    expect(listed.map((l) => l.id)).toEqual([link.id]);
    expect((await owner.agent.get(`/api/me/share-links?conversationId=${conversationId}&kind=file`).expect(200)).body).toEqual([]);
    expect((await owner.agent.get("/api/me/share-links").expect(200)).body).toHaveLength(1);

    const audits = t.store.listAudit(owner.id, true).filter((a) => a.action === "share_link_create");
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toBe(`link ${link.id} conversation ${conversationId} 2 messages 7d`);
    expect(audits[0].detail).not.toContain("분기");

    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    expect(payload).toMatchObject({ kind: "conversation", fileName: "분기 실적 정리", slides: [], downloadUrl: "" });
    expect(payload.conversation!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "분기 실적 정리해 줘"],
      ["assistant", "**정리**했습니다."],
    ]);

    await owner.agent.delete(`/api/me/share-links/${link.id}`).expect(204);
    await open(viewer.agent, token).expect(404);
    const revoked = t.store.listAudit(owner.id, true).find((a) => a.action === "share_link_revoke");
    expect(revoked?.detail).toBe(`link ${link.id} conversation ${conversationId}`);
  });

  it("never shows what is said after the link was made", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    const link = (await createLink(owner.agent, conversationId).expect(201)).body.link as ShareLinkSummary;
    t.store.addMessage(conversationId, { role: "user", content: "이건 공유한 뒤에 한 말" });
    t.store.addMessage(conversationId, { role: "assistant", content: "비공개 답", response: answer("비공개 답") });

    const payload = (await open(viewer.agent, tokenOf(link.url)).expect(200)).body as ShareViewPayload;
    expect(payload.conversation!.messages).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("공유한 뒤");
    expect(JSON.stringify(payload)).not.toContain("비공개 답");
    // The owner's list still counts the shared range, not the conversation.
    const [listed] = (await owner.agent.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(listed.messageCount).toBe(2);
  });

  it("refuses bad input, an empty conversation, a running turn and anyone but the owner", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    expect((await createLink(owner.agent, conversationId, { expiresInDays: 3 }).expect(400)).body.error).toBe(
      "유효 기간은 1일, 7일, 30일 중에서 선택해 주세요.",
    );
    expect((await createLink(owner.agent, conversationId, { includeFiles: "yes" }).expect(400)).body.error).toBe(
      "파일 포함 여부가 올바르지 않습니다.",
    );
    for (const [agent, cid] of [
      [viewer.agent, conversationId],
      [owner.agent, "no-such-conversation"],
    ] as const) {
      expect((await createLink(agent, cid).expect(404)).body.error).toBe("대화를 찾을 수 없습니다.");
    }
    await request(t.app).post(`/api/conversations/${conversationId}/share-links`).expect(401);

    t.store.touchConversation(owner.id, "conv-empty", owner.id, "");
    expect((await createLink(owner.agent, "conv-empty").expect(400)).body.error).toBe("아직 공유할 메시지가 없습니다.");

    openRun("run-live", owner.id, { conversationId, avatarId: owner.id });
    try {
      expect((await createLink(owner.agent, conversationId).expect(409)).body.error).toBe(
        "응답이 끝난 뒤에 공유 링크를 만들 수 있습니다.",
      );
    } finally {
      closeRun("run-live");
    }
    expect(linkRows(t.store)).toBe(0);
  });
});

describe("conversation share links — what a recipient gets", () => {
  it("sends the text of both sides and the visible attachments — never the reasoning, the activity, a system row or anything hidden", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const cid = "conv-rich";
    t.store.touchConversation(owner.id, cid, owner.id, "풍부한 대화");
    const pasted = image(t, cid, { name: "붙여넣은 그림.png" });
    const upload = file(t, cid, "pdf", { name: "내 문서.pdf", uploaded: true });
    t.store.addMessage(cid, { role: "user", content: "이 자료 봐 줘", attachments: [pasted, upload] });
    t.store.addMessage(cid, { role: "system", content: "SYSTEM-ONLY-NOTE" });
    const shown = image(t, cid, { name: "차트.png", caption: "매출 추이", anchor: 3, width: 640, height: 480 });
    const deck = file(t, cid, "pptx", { name: "보고.pptx", anchor: 5 });
    const slide = image(t, cid, { name: "슬라이드 1 – 표지", hidden: true, parentId: deck.id });
    const brainCard: MessageAttachment = { id: crypto.randomUUID(), kind: "team_brain", mediaType: "application/x-team-brain" };
    t.store.addMessage(cid, {
      role: "assistant",
      content: "content-fallback",
      response: answer("답변 본문", {
        thinking: "SECRET-THINKING",
        plan: "SECRET-PLAN",
        activity: { agents: [{ id: "main" }], tools: [{ name: "SECRET-TOOL" }], tasks: [] } as never,
      }),
      attachments: [shown, deck, slide, brainCard],
    });
    t.store.addMessage(cid, {
      role: "user",
      content: "팀원 아바타의 답",
      kind: "consultation",
      consultation: { id: "ask-12345678", username: "minsu", displayName: "김민수" },
    });
    t.store.addMessage(cid, { role: "user", content: "중간에 보낸 말", kind: "steer" });
    t.store.addMessage(cid, {
      role: "assistant",
      content: "실패",
      response: answer("실행 중 오류가 났습니다.", { summary: "오류" }),
    });

    const link = (await createLink(owner.agent, cid).expect(201)).body.link as ShareLinkSummary;
    const res = await open(viewer.agent, tokenOf(link.url)).expect(200);
    const payload = res.body as ShareViewPayload;
    const raw = JSON.stringify(payload);
    for (const secret of ["SECRET-THINKING", "SECRET-PLAN", "SECRET-TOOL", "SYSTEM-ONLY-NOTE", "content-fallback", slide.id, brainCard.id, "team_brain"]) {
      expect(raw, secret).not.toContain(secret);
    }
    const conversation = payload.conversation!;
    expect(conversation).toMatchObject({ conversationId: cid, includesFiles: false });
    expect(conversation.avatarName).toBeTruthy();
    const base = ticketBase(conversation.messages[0].attachments[0].url!);
    const strip = (m: ShareViewMessage) => ({ ...m, id: undefined, createdAt: undefined });
    expect(conversation.messages.map(strip)).toEqual([
      {
        role: "user",
        content: "이 자료 봐 줘",
        attachments: [
          { id: pasted.id, kind: "image", name: "붙여넣은 그림.png", mediaType: "image/png", url: `${base}/images/${pasted.id}` },
          // A file the user attached: a name, never a download.
          { id: upload.id, kind: "file", name: "내 문서.pdf", mediaType: "application/pdf", size: PDF.length },
        ],
      },
      {
        role: "assistant",
        content: "답변 본문",
        attachments: [
          {
            id: shown.id,
            kind: "image",
            name: "차트.png",
            mediaType: "image/png",
            caption: "매출 추이",
            anchor: 3,
            width: 640,
            height: 480,
            url: `${base}/images/${shown.id}`,
          },
          // Shared without its files: the card is a name.
          { id: deck.id, kind: "file", name: "보고.pptx", mediaType: PPTX_MEDIA_TYPE, size: PPTX.length, anchor: 5 },
        ],
      },
      { role: "user", kind: "consultation", speaker: "김민수", content: "팀원 아바타의 답", attachments: [] },
      { role: "user", kind: "steer", content: "중간에 보낸 말", attachments: [] },
      { role: "assistant", content: "실행 중 오류가 났습니다.", errored: true, attachments: [] },
    ].map((m) => ({ ...m, id: undefined, createdAt: undefined })));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves the visible images of the shared range, and nothing else by id", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const stranger = await newUser(t.app, "stranger");
    const cid = "conv-images";
    t.store.touchConversation(owner.id, cid, owner.id, "그림");
    const visible = image(t, cid);
    const deck = file(t, cid, "pptx");
    const slide = image(t, cid, { hidden: true, parentId: deck.id });
    const placed = image(t, cid, { hidden: true });
    t.store.addMessage(cid, { role: "user", content: "그려 줘" });
    t.store.addMessage(cid, {
      role: "assistant",
      content: "",
      response: answer(`여기 있습니다.\n<image src="/api/conversations/${cid}/images/${placed.id}" alt="배치한 그림" />`),
      attachments: [visible, deck, slide, placed],
    });
    // A later answer (still in range) places an image an EARLIER turn published hidden.
    const earlierHidden = image(t, cid, { hidden: true });
    const neverPlaced = image(t, cid, { hidden: true });
    t.store.addMessage(cid, { role: "user", content: "그 그림 다시 보여 줘", attachments: [] });
    t.store.addMessage(cid, { role: "assistant", content: "", response: answer("준비 중"), attachments: [earlierHidden, neverPlaced] });
    t.store.addMessage(cid, {
      role: "assistant",
      content: "",
      response: answer(`<image src="/api/conversations/${cid}/images/${earlierHidden.id}" alt="앞에서 만든 그림" />`),
    });
    // …a user's message naming a hidden image's address places nothing (only an answer draws it).
    t.store.addMessage(cid, { role: "user", content: `/api/conversations/${cid}/images/${neverPlaced.id}` });
    const link = (await createLink(owner.agent, cid).expect(201)).body.link as ShareLinkSummary;
    // Said — and shown — after the link was made.
    const later = image(t, cid);
    t.store.addMessage(cid, { role: "assistant", content: "나중", response: answer("나중"), attachments: [later] });
    // Another conversation of the same owner.
    t.store.touchConversation(owner.id, "conv-other", owner.id, "다른 대화");
    const foreign = image(t, "conv-other");
    t.store.addMessage("conv-other", { role: "assistant", content: "", response: answer("다른"), attachments: [foreign] });

    const payload = (await open(viewer.agent, tokenOf(link.url)).expect(200)).body as ShareViewPayload;
    const shownAtts = payload.conversation!.messages[1].attachments;
    // The hidden renders are not listed; the placed one is reached only through the answer's own text.
    expect(shownAtts.map((att) => att.id)).toEqual([visible.id, deck.id]);
    const base = ticketBase(shownAtts[0].url!);

    const ok = await viewer.agent.get(`${base}/images/${visible.id}`).buffer(true).parse(binary).expect(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["cache-control"]).toBe("private, no-cache");
    expect(Buffer.compare(ok.body as Buffer, PNG)).toBe(0);
    // A hidden image the answer's own text places is part of what it shows.
    await viewer.agent.get(`${base}/images/${placed.id}`).expect(200);
    // …and so is one a LATER answer in the range places.
    await viewer.agent.get(`${base}/images/${earlierHidden.id}`).expect(200);
    await viewer.agent.get(`${base}/images/${neverPlaced.id}`).expect(404);

    for (const id of [slide.id, later.id, foreign.id, deck.id, crypto.randomUUID(), "..%2F..%2Fetc"]) {
      const res = await viewer.agent.get(`${base}/images/${id}`).expect(404);
      expect(res.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    }
    // A conversation link has no deck routes, and its files are not shared.
    await viewer.agent.get(`${base}/download`).expect(404);
    await viewer.agent.get(`${base}/slides/1`).expect(404);
    await viewer.agent.get(`${base}/files/${deck.id}`).expect(404);
    // The ticket is the viewer's: nobody else's session can use it.
    await stranger.agent.get(`${base}/images/${visible.id}`).expect(404);
    await request(t.app).get(`${base}/images/${visible.id}`).expect(401);
  });

  it("downloads the avatar's files only when the owner shared them — never an upload or a screenshot card", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const cid = "conv-files";
    t.store.touchConversation(owner.id, cid, owner.id, "파일");
    const upload = file(t, cid, "pdf", { name: "내 문서.pdf", uploaded: true });
    t.store.addMessage(cid, { role: "user", content: "봐 줘", attachments: [upload] });
    const report = file(t, cid, "pdf", { name: "보고서" });
    const shot = file(t, cid, "png", { name: "스크린샷.png" });
    const hiddenFile = file(t, cid, "pdf", { name: "숨김.pdf", hidden: true });
    t.store.addMessage(cid, { role: "assistant", content: "", response: answer("여기"), attachments: [report, shot, hiddenFile] });

    const link = (await createLink(owner.agent, cid, { includeFiles: true }).expect(201)).body.link as ShareLinkSummary;
    expect(link.includesFiles).toBe(true);
    expect(t.store.listAudit(owner.id, true).find((a) => a.action === "share_link_create")?.detail).toContain(
      "2 messages with files 7d",
    );
    const later = file(t, cid, "pdf", { name: "나중.pdf" });
    t.store.addMessage(cid, { role: "assistant", content: "", response: answer("나중"), attachments: [later] });

    const payload = (await open(viewer.agent, tokenOf(link.url)).expect(200)).body as ShareViewPayload;
    expect(payload.conversation!.includesFiles).toBe(true);
    const [userMessage, answerMessage] = payload.conversation!.messages;
    expect(userMessage.attachments[0].url).toBeUndefined();
    const cards = answerMessage.attachments;
    expect(cards.map((att) => [att.id, Boolean(att.url)])).toEqual([
      [report.id, true],
      [shot.id, false],
    ]);
    const base = ticketBase(cards[0].url!);

    const res = await viewer.agent.get(cards[0].url!).buffer(true).parse(binary).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // The name always ends in the extension of the bytes served.
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("보고서.pdf"));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);

    for (const id of [upload.id, shot.id, hiddenFile.id, later.id, crypto.randomUUID()]) {
      await viewer.agent.get(`${base}/files/${id}`).expect(404);
    }
  });

  it("names the avatar that answered in a colleague's thread, and dies when that avatar goes out of reach", async () => {
    const t = boot();
    const avatarOwner = await newUser(t.app, "avatarowner");
    const colleague = await newUser(t.app, "colleague");
    const viewer = await newUser(t.app, "viewer");
    const cid = "conv-colleague";
    t.store.touchConversation(colleague.id, cid, avatarOwner.id, "동료 아바타와");
    t.store.addMessage(cid, { role: "user", content: "질문" });
    t.store.addMessage(cid, { role: "assistant", content: "", response: answer("답") });
    // Only the conversation's owner shares it — never the avatar's owner.
    await createLink(avatarOwner.agent, cid).expect(404);
    const link = (await createLink(colleague.agent, cid).expect(201)).body.link as ShareLinkSummary;
    const token = tokenOf(link.url);
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    expect(payload.ownerUsername).toBe("colleague");
    expect(payload.conversation!.avatarName).toBe(t.store.resolveChatAvatar(colleague.id, avatarOwner.id)!.displayName);

    t.store.updateProfile(avatarOwner.id, { visibility: "private" });
    await open(viewer.agent, token).expect(404);
    t.store.updateProfile(avatarOwner.id, { visibility: "group" });
    await open(viewer.agent, token).expect(200);
    t.store.setSuspended(colleague.id, true);
    await open(viewer.agent, token).expect(404);
  });
});

describe("conversation share links — cascades", () => {
  it("dies with its conversation", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    const link = (await createLink(owner.agent, conversationId).expect(201)).body.link as ShareLinkSummary;
    await owner.agent.delete(`/api/conversations/${conversationId}`).expect(200);
    await open(viewer.agent, tokenOf(link.url)).expect(404);
    expect(linkRows(t.store)).toBe(0);
  });

  it("dies when a regenerate takes its last shared message — and survives one that cuts only what came later", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    const first = (await createLink(owner.agent, conversationId).expect(201)).body.link as ShareLinkSummary;
    // A later exchange, outside the first link's range.
    t.store.addMessage(conversationId, { role: "user", content: "다음 질문" });
    t.store.addMessage(conversationId, { role: "assistant", content: "다음 답", response: answer("다음 답") });

    // Regenerating the LAST answer cuts only rows after the first link's anchor.
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId, message: "다음 질문", regenerate: true })
      .expect(200);
    const kept = (await open(viewer.agent, tokenOf(first.url)).expect(200)).body as ShareViewPayload;
    expect(kept.conversation!.messages.map((m) => m.content)).toEqual(["분기 실적 정리해 줘", "**정리**했습니다."]);

    // A link over the whole conversation, then a regenerate that replaces its last message.
    await owner.agent.delete(`/api/me/share-links/${first.id}`).expect(204);
    const whole = (await createLink(owner.agent, conversationId).expect(201)).body.link as ShareLinkSummary;
    expect(whole.messageCount).toBe(4);
    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId, message: "다음 질문", regenerate: true })
      .expect(200);
    await open(viewer.agent, tokenOf(whole.url)).expect(404);
    expect(linkRows(t.store)).toBe(0);
    // The owner can share the conversation again as it stands now.
    await createLink(owner.agent, conversationId).expect(201);
  });

  it("never hands back a link whose last shared message is gone", async () => {
    const { t, owner, viewer, conversationId } = await seeded();
    const stale = (await createLink(owner.agent, conversationId).expect(201)).body.link as ShareLinkSummary;
    // The anchor row vanishes behind the cascade's back.
    dbOf(t.store).prepare("DELETE FROM messages WHERE conversation_id = ? AND role = 'assistant'").run(conversationId);
    await open(viewer.agent, tokenOf(stale.url)).expect(404);
    const fresh = await createLink(owner.agent, conversationId).expect(201);
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.link.id).not.toBe(stale.id);
    expect(fresh.body.link.messageCount).toBe(1);
    expect(linkRows(t.store)).toBe(1);
  });

  it("keeps a file link and a conversation link of one conversation apart", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const cid = "conv-both";
    t.store.touchConversation(owner.id, cid, owner.id, "둘 다");
    const deck = file(t, cid, "pptx", { name: "보고.pptx" });
    t.store.addMessage(cid, { role: "user", content: "덱" });
    t.store.addMessage(cid, { role: "assistant", content: "", response: answer("완성"), attachments: [deck] });

    const fileLink = (await owner.agent.post(`/api/conversations/${cid}/files/${deck.id}/share-links`).send({}).expect(201)).body
      .link as ShareLinkSummary;
    const conversationLink = (await createLink(owner.agent, cid).expect(201)).body.link as ShareLinkSummary;
    expect(fileLink.kind).toBe("file");
    expect(conversationLink.id).not.toBe(fileLink.id);
    // The card's dialog asks by conversation + file: it never sees the conversation link.
    const forCard = (await owner.agent.get(`/api/me/share-links?conversationId=${cid}&fileId=${deck.id}`).expect(200))
      .body as ShareLinkSummary[];
    expect(forCard.map((l) => l.id)).toEqual([fileLink.id]);

    const filePayload = (await open(viewer.agent, tokenOf(fileLink.url)).expect(200)).body as ShareViewPayload;
    expect(filePayload.kind).toBe("file");
    expect(filePayload.conversation).toBeUndefined();
    // Revoking one leaves the other.
    await owner.agent.delete(`/api/me/share-links/${conversationLink.id}`).expect(204);
    await open(viewer.agent, tokenOf(fileLink.url)).expect(200);
  });
});
