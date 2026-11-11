/**
 * Chat DOCUMENT attachments at the route: the `files` field of
 * `POST /api/chat/stream`, where it is allowed, what is stored on the user
 * message, the download, the regenerate/rewind re-send and every deletion
 * cascade. The agent layer is mocked (the pi request itself is covered by
 * tests/pi-documents.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig, MessageAttachment } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

const H = vi.hoisted(() => ({ requests: [] as AgentRequest[] }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (agentRequest: AgentRequest, _roots: unknown, config: AppConfig, _store: unknown, events: AgentEvents): Promise<AgentResponse> => {
      H.requests.push(agentRequest);
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.("[mock]");
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "[mock]" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { executeChatTurn, resolveChatTarget } from "../src/server/routes/chat.js";
import {
  CHAT_DOCUMENT_MEDIA_TYPES,
  CHAT_DOCUMENT_MESSAGES,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENT_BYTES,
} from "../src/shared/chatDocuments.js";
import { PPTX_MEDIA_TYPE } from "../src/shared/shareLinks.js";
import { decodeChatDocuments } from "../src/server/chatDocuments.js";

let tempDir: string;
const getTempDir = withTempDir("routes-chat-documents", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
});

function boot() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "pi",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "test-key", deckSandbox: false },
    sessionSecret: "test",
  });
  return { services, app: createApp(services), store: services.store, config: services.config };
}

const dataUrl = (buffer: Buffer, mime = "application/octet-stream") => `data:${mime};base64,${buffer.toString("base64")}`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const ooxml = (folder: string) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\0\0[Content_Types].xml\0\0${folder}/main.xml\0\0`)]);
const XLSX = ooxml("xl");
const PPTX = ooxml("ppt");
const CSV = Buffer.from("이름,값\n가,1\n", "utf8");
/** "이름,값\r\n가,1\r\n" in CP949 (EUC-KR), as Korean Excel saves a CSV — not valid UTF-8. */
const CP949_CSV = Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb0, 0xaa, 0x0d, 0x0a, 0xb0, 0xa1, 0x2c, 0x31, 0x0d, 0x0a]);
/** Excel's "Unicode text": UTF-16 LE with a BOM — full of NUL bytes, and still text. */
const UTF16_TXT = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("이름\t값\r\n가\t1\r\n", "utf16le")]);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const pdfFile = { name: "보고서.pdf", data: dataUrl(PDF, "application/pdf") };
const storedFiles = (config: AppConfig, conversationId: string) => {
  try {
    return fs.readdirSync(chatFilesDir(config, conversationId)).sort();
  } catch {
    return [];
  }
};
const uploads = (attachments: MessageAttachment[] | undefined) => (attachments ?? []).filter((att) => att.kind === "file" && att.uploaded);

async function owner(app: ReturnType<typeof createApp>, name = "docowner") {
  const agent = request.agent(app);
  const id = (await signup(agent, name).expect(201)).body.user.id as string;
  return { agent, id };
}

describe("POST /api/chat/stream — document attachments (files)", () => {
  it("stores the documents on the user message, hands them to the run and serves them back as downloads only", async () => {
    const { app, store, config } = boot();
    const { agent, id } = await owner(app);
    await agent
      .post("/api/chat/stream")
      .send({
        avatarId: id,
        conversationId: "conv-doc",
        message: "이 문서 요약해 줘",
        images: [{ name: "shot.png", data: `data:image/png;base64,${PNG.toString("base64")}` }],
        files: [pdfFile, { name: "보고서.pdf", data: dataUrl(PDF) }, { id: "sheet-1", name: "표.xlsx", data: dataUrl(XLSX, "text/html") }],
      })
      .expect(200);

    const userRow = store.listMessages(id, "conv-doc").find((m) => m.role === "user")!;
    const [image, ...documents] = userRow.attachments!;
    expect(image).toMatchObject({ kind: "image", mediaType: "image/png" });
    expect(documents).toEqual([
      { id: expect.any(String), kind: "file", mediaType: "application/pdf", name: "보고서.pdf", size: PDF.length, uploaded: true },
      { id: expect.any(String), kind: "file", mediaType: "application/pdf", name: "보고서 (2).pdf", size: PDF.length, uploaded: true },
      { id: "sheet-1", kind: "file", mediaType: CHAT_DOCUMENT_MEDIA_TYPES.xlsx, name: "표.xlsx", size: XLSX.length, uploaded: true },
    ]);
    // The run gets the same documents (base64, the stored names) next to the image.
    expect(H.requests).toHaveLength(1);
    expect(H.requests[0]!.images).toHaveLength(1);
    expect(H.requests[0]!.documents).toEqual([
      { name: "보고서.pdf", mediaType: "application/pdf", data: PDF.toString("base64"), size: PDF.length },
      { name: "보고서 (2).pdf", mediaType: "application/pdf", data: PDF.toString("base64"), size: PDF.length },
      { name: "표.xlsx", mediaType: CHAT_DOCUMENT_MEDIA_TYPES.xlsx, data: XLSX.toString("base64"), size: XLSX.length },
    ]);
    // Noah's copies sit in the conversation's file store.
    expect(storedFiles(config, "conv-doc")).toEqual([`${documents[0]!.id}.pdf`, `${documents[1]!.id}.pdf`, "sheet-1.xlsx"].sort());

    // The existing file route serves an upload as a DOWNLOAD: attachment, nosniff, never inline.
    const download = await agent
      .get(`/api/conversations/conv-doc/files/${documents[0]!.id}`)
      .query({ name: "보고서.pdf" })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.body).toEqual(PDF);
    expect(download.headers["content-type"]).toContain("application/pdf");
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(download.headers["content-disposition"]).toContain(encodeURIComponent("보고서.pdf"));
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    // A crafted name never changes the served type's extension.
    const renamed = await agent.get(`/api/conversations/conv-doc/files/sheet-1`).query({ name: "x.html" }).expect(200);
    expect(renamed.headers["content-disposition"]).toContain("x.html.xlsx");

    // Another signed-in user gets the same 404 as for any file card.
    const other = request.agent(app);
    await signup(other, "docother").expect(201);
    await other.get(`/api/conversations/conv-doc/files/${documents[0]!.id}`).expect(404);
  });

  it("takes a message that is only a document, and a text file as json/csv", async () => {
    const { app, store } = boot();
    const { agent, id } = await owner(app);
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: id, conversationId: "conv-only", message: "", files: [{ name: "data.csv", data: dataUrl(CSV) }, { name: "a.json", data: dataUrl(Buffer.from("{}")) }] })
      .expect(200);
    const userRow = store.listMessages(id, "conv-only").find((m) => m.role === "user")!;
    expect(userRow.content).toBe("");
    expect(uploads(userRow.attachments).map((att) => [att.name, att.mediaType])).toEqual([
      ["data.csv", "text/csv"],
      ["a.json", "application/json"],
    ]);
    const json = uploads(userRow.attachments)[1]!;
    const served = await agent.get(`/api/conversations/conv-only/files/${json.id}`).expect(200);
    expect(served.headers["content-type"]).toContain("application/json");
    expect(served.headers["content-disposition"]).toMatch(/^attachment;/);
  });

  it("accepts a CP949 CSV and a UTF-16 (BOM) text file: stored and handed to the run byte-for-byte", async () => {
    const { app, store, config } = boot();
    const { agent, id } = await owner(app);
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: id, conversationId: "conv-cp949", message: "매출 정리해 줘", files: [{ name: "매출.csv", data: dataUrl(CP949_CSV, "text/csv") }, { name: "유니코드.txt", data: dataUrl(UTF16_TXT) }] })
      .expect(200);
    const [upload, wide] = uploads(store.listMessages(id, "conv-cp949").find((m) => m.role === "user")!.attachments);
    expect(upload).toEqual({ id: expect.any(String), kind: "file", mediaType: "text/csv", name: "매출.csv", size: CP949_CSV.length, uploaded: true });
    expect(fs.readFileSync(path.join(chatFilesDir(config, "conv-cp949"), `${upload!.id}.csv`))).toEqual(CP949_CSV);
    expect(wide).toEqual({ id: expect.any(String), kind: "file", mediaType: "text/plain", name: "유니코드.txt", size: UTF16_TXT.length, uploaded: true });
    expect(fs.readFileSync(path.join(chatFilesDir(config, "conv-cp949"), `${wide!.id}.txt`))).toEqual(UTF16_TXT);
    expect(H.requests[0]!.documents).toEqual([
      { name: "매출.csv", mediaType: "text/csv", data: CP949_CSV.toString("base64"), size: CP949_CSV.length },
      { name: "유니코드.txt", mediaType: "text/plain", data: UTF16_TXT.toString("base64"), size: UTF16_TXT.length },
    ]);
    expect(H.requests[0]!.documents!.map((d) => Buffer.from(d.data, "base64"))).toEqual([CP949_CSV, UTF16_TXT]);
  });

  it("refuses every invalid upload with its Korean message before anything is written or run", async () => {
    const { app, store, config } = boot();
    const { agent, id } = await owner(app);
    const send = (files: unknown) =>
      agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-bad", message: "봐줘", files });
    const cases: [keyof typeof CHAT_DOCUMENT_MESSAGES, unknown][] = [
      ["TYPE", [{ name: "run.exe", data: dataUrl(PDF) }]],
      ["NAME", [{ name: "../보고서.pdf", data: dataUrl(PDF) }]],
      ["EMPTY", [{ name: "a.txt", data: "data:text/plain;base64," }]],
      ["TOO_LARGE", [{ name: "big.txt", data: dataUrl(Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES + 1, 0x61)) }]],
      ["TOO_MANY", Array.from({ length: MAX_CHAT_DOCUMENTS_PER_MESSAGE + 1 }, (_, i) => ({ name: `${i}.txt`, data: dataUrl(CSV) }))],
      [
        "TOTAL_TOO_LARGE",
        [
          { name: "1.txt", data: dataUrl(Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES / 2, 0x61)) },
          { name: "2.txt", data: dataUrl(Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES / 2, 0x61)) },
          { name: "3.txt", data: dataUrl(CSV) },
        ],
      ],
      ["BAD_FORMAT", [{ name: "가짜.pdf", data: dataUrl(CSV, "application/pdf") }]],
      // A text type takes any text encoding, but not a binary file wearing its extension.
      ["BAD_FORMAT", [{ name: "사진.txt", data: dataUrl(PNG, "text/plain") }]],
      ["BAD_FORMAT", [{ name: "nul.txt", data: dataUrl(Buffer.from("abc\0def")) }]],
      ["BAD_FORMAT", "not-a-list"],
    ];
    for (const [problem, files] of cases) {
      const res = await send(files).expect(400);
      expect(res.body.error, problem).toBe(CHAT_DOCUMENT_MESSAGES[problem]);
    }
    expect(H.requests).toHaveLength(0);
    expect(store.listMessages(id, "conv-bad")).toEqual([]);
    expect(storedFiles(config, "conv-bad")).toEqual([]);
  });

  it("refuses documents everywhere but the owner's own interactive chat (NOT_ALLOWED_HERE)", async () => {
    const { app, store, config, services } = boot();
    const { id: ownerId } = await owner(app);
    const colleague = request.agent(app);
    const colleagueId = (await signup(colleague, "docmate").expect(201)).body.user.id as string;

    // A colleague chatting with someone else's avatar: a read_only pi session.
    const res = await colleague
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-mate", message: "이거 봐줘", files: [pdfFile] })
      .expect(400);
    expect(res.body.error).toBe(CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE);
    expect(store.listMessages(colleagueId, "conv-mate")).toEqual([]);
    expect(storedFiles(config, "conv-mate")).toEqual([]);
    // The same colleague CAN attach one to their own avatar, and a plain message to the owner's still works.
    await colleague.post("/api/chat/stream").send({ avatarId: colleagueId, conversationId: "conv-own", message: "봐줘", files: [pdfFile] }).expect(200);
    await colleague.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-mate", message: "안녕" }).expect(200);
    expect(H.requests.map((r) => r.documents?.length ?? 0)).toEqual([1, 0]);

    // An external-task-API turn of the owner's own avatar (its body carries text only).
    const target = resolveChatTarget({ store, viewerUserId: ownerId, avatarId: ownerId, ownerOnlyCommand: false });
    if (!target.ok) throw new Error("expected the owner's own avatar to resolve");
    const decoded = decodeChatDocuments([pdfFile]);
    if ("error" in decoded) throw new Error(decoded.error);
    const direct = (extra: { externalTaskId?: string }) =>
      executeChatTurn(
        { config, store, observedModel: services.observedModel },
        {
          ownerUserId: ownerId,
          ownerDisplayName: "docowner",
          target: target.target,
          conversationId: "conv-task",
          agentMessage: "작업",
          displayMessage: "작업",
          images: [],
          documents: decoded.documents,
          regenerate: false,
          audit: () => {},
          ...extra,
        },
        { onRunOpen: () => true },
      );
    expect(await direct({ externalTaskId: "task-1" })).toEqual({
      ok: false,
      refusal: { status: 400, message: CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE, userMessagePersisted: false },
    });
    expect(store.listMessages(ownerId, "conv-task")).toEqual([]);
    expect(storedFiles(config, "conv-task")).toEqual([]);
    // The same turn without the provenance stamp is the owner's own chat: accepted.
    expect(await direct({})).toEqual({ ok: true });
  });

  it("does not extend the external task API body: `files` there is ignored, never stored or sent", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/server/avatarTaskRunner.ts"), "utf8");
    expect(source).not.toContain("documents");
    const routes = fs.readFileSync(path.join(__dirname, "../src/server/routes/avatarTasks.ts"), "utf8");
    expect(routes).not.toMatch(/req\.body\??\.files/);
  });

  it("refuses a document on a mid-turn message, a /compact, a regenerate and an edit", async () => {
    const { app, store } = boot();
    const { agent, id } = await owner(app);
    await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-r", message: "첫 메시지", files: [pdfFile] }).expect(200);
    const userRow = store.listMessages(id, "conv-r").find((m) => m.role === "user")!;

    const steer = await agent.post("/api/chat/runs/any-run/message").send({ message: "추가", files: [pdfFile] }).expect(400);
    expect(steer.body.error).toBe("응답 중에 보내는 메시지에는 문서를 첨부할 수 없습니다. 응답이 끝난 뒤 보내 주세요.");
    const compact = await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-r", message: "/compact", files: [pdfFile] }).expect(400);
    expect(compact.body.error).toBe("/compact에는 문서를 첨부할 수 없습니다.");
    for (const body of [{ regenerate: true, message: "" }, { rewindFromMessageId: userRow.id, message: "고친 메시지" }]) {
      const res = await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-r", files: [pdfFile], ...body }).expect(400);
      expect(res.body.error).toBe("다시 시작하거나 다시 생성할 때는 문서를 새로 첨부할 수 없습니다.");
    }
    expect(H.requests).toHaveLength(1);
    expect(store.listMessages(id, "conv-r").filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("re-sends the stored documents on a regenerate and on an edit, which keeps them on its replacement row", async () => {
    const { app, store, config } = boot();
    const { agent, id } = await owner(app);
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: id, conversationId: "conv-rs", message: "", files: [pdfFile, { name: "표.xlsx", data: dataUrl(XLSX) }] })
      .expect(200);
    const first = H.requests[0]!.documents!;
    expect(first.map((d) => d.name)).toEqual(["보고서.pdf", "표.xlsx"]);
    const userRow = store.listMessages(id, "conv-rs").find((m) => m.role === "user")!;
    const before = storedFiles(config, "conv-rs");
    expect(before).toHaveLength(2);

    // Regenerate: a document-only message is still a message, and the same documents ride the re-run.
    await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-rs", message: "", regenerate: true }).expect(200);
    expect(H.requests[1]!.documents).toEqual(first);

    // Edit: the replacement row carries the documents, their copies survive the sweep, and they are re-sent.
    await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-rs", message: "표 위주로", rewindFromMessageId: userRow.id }).expect(200);
    expect(H.requests[2]!.documents).toEqual(first);
    const rows = store.listMessages(id, "conv-rs");
    const replacement = rows.find((m) => m.role === "user")!;
    expect(rows.filter((m) => m.role === "user")).toHaveLength(1);
    expect(replacement.id).not.toBe(userRow.id);
    expect(replacement.content).toBe("표 위주로");
    expect(replacement.attachments).toEqual(userRow.attachments);
    expect(storedFiles(config, "conv-rs")).toEqual(before);
  });

  it("a rewind that drops a later message removes that message's document copies, and only those", async () => {
    const { app, store, config } = boot();
    const { agent, id } = await owner(app);
    await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-rw", message: "첫 번째", files: [pdfFile] }).expect(200);
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: id, conversationId: "conv-rw", message: "두 번째", files: [{ name: "data.csv", data: dataUrl(CSV) }] })
      .expect(200);
    const [firstRow, secondRow] = store.listMessages(id, "conv-rw").filter((m) => m.role === "user");
    const kept = `${uploads(firstRow!.attachments)[0]!.id}.pdf`;
    const dropped = `${uploads(secondRow!.attachments)[0]!.id}.csv`;
    expect(storedFiles(config, "conv-rw")).toEqual([kept, dropped].sort());

    // Editing the FIRST message cuts the second one (and its document) out of the conversation.
    await agent.post("/api/chat/stream").send({ avatarId: id, conversationId: "conv-rw", message: "첫 번째 (수정)", rewindFromMessageId: firstRow!.id }).expect(200);
    expect(storedFiles(config, "conv-rw")).toEqual([kept]);
    expect(H.requests[2]!.documents!.map((d) => d.name)).toEqual(["보고서.pdf"]);
    await agent.get(`/api/conversations/conv-rw/files/${uploads(secondRow!.attachments)[0]!.id}`).expect(404);
  });

  it("conversation delete, 비우기 (bulk delete) and user delete remove the stored copies", async () => {
    const { app, config } = boot();
    const { agent: admin } = await owner(app, "docadmin");
    const user = request.agent(app);
    const userId = (await signup(user, "docuser").expect(201)).body.user.id as string;
    const send = (conversationId: string) =>
      user.post("/api/chat/stream").send({ avatarId: userId, conversationId, message: "문서", files: [pdfFile] }).expect(200);

    await send("conv-one");
    expect(storedFiles(config, "conv-one")).toHaveLength(1);
    await user.delete("/api/conversations/conv-one").expect(200);
    expect(fs.existsSync(chatFilesDir(config, "conv-one"))).toBe(false);

    await send("conv-two");
    await send("conv-three");
    await user.delete("/api/conversations").expect(200);
    expect(fs.existsSync(chatFilesDir(config, "conv-two"))).toBe(false);
    expect(fs.existsSync(chatFilesDir(config, "conv-three"))).toBe(false);

    await send("conv-four");
    expect(storedFiles(config, "conv-four")).toHaveLength(1);
    await admin.delete(`/api/admin/users/${userId}`).expect(200);
    expect(fs.existsSync(chatFilesDir(config, "conv-four"))).toBe(false);
  });

  it("never makes a share link for a .pptx the user attached", async () => {
    const { app, store } = boot();
    const { agent, id } = await owner(app);
    await agent
      .post("/api/chat/stream")
      .send({ avatarId: id, conversationId: "conv-share", message: "내 발표 자료", files: [{ name: "내 발표.pptx", data: dataUrl(PPTX) }] })
      .expect(200);
    const [upload] = uploads(store.listMessages(id, "conv-share").find((m) => m.role === "user")!.attachments);
    expect(upload!.mediaType).toBe(PPTX_MEDIA_TYPE);
    const res = await agent.post(`/api/conversations/conv-share/files/${upload!.id}/share-links`).send({ expiresInDays: 7 }).expect(400);
    expect(res.body.error).toBe("PPTX 파일만 공유 링크를 만들 수 있습니다.");
    expect((await agent.get("/api/me/share-links").expect(200)).body).toEqual([]);
  });
});
