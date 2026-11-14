/**
 * Chat DOCUMENT attachments on the pi side: the `input_file` parts
 * `buildResponsesBody` writes, `runPiAgent` against a scripted fake pi (what it
 * sends, what a refusal becomes, that a turn without documents is unchanged),
 * the per-turn preamble line and both metacognition surfaces. There is no
 * pi-gateway on a dev box: the real `input_file` round trip (the file landing
 * in `/workspace/uploads/`) is NOT exercised here.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServices } from "../src/server/app.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";
import type { AgentDocumentInput, AgentRequest, PiRuntimeConfig, PiRuntimeFacts } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { McpRunRegistry, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";
import { PI_RUN_TOKEN_HEADER, piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { piDocumentTurnError, runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import {
  PiGatewayError,
  buildResponsesBody,
  type PiResponseRequest,
  type PiResponsesClient,
  type PiStreamEvent,
} from "../src/server/agent/pi/responsesClient.js";
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { documentAttachmentsAllowed, piSandboxOwnerOf } from "../src/server/agent/runCapabilities.js";
import { documentAttachmentsLine } from "../src/server/agent/systemTools.js";
import { readSystemManual } from "../src/server/agent/systemManual.js";
import { isRetryableModelError } from "../src/server/agent/runErrors.js";
import { DOCUMENT_UPLOADS_SENTENCE, PI_SUBAGENT_SENTENCE } from "../src/server/agent/ownerState.js";
import { CHAT_DOCUMENT_MESSAGES } from "../src/shared/chatDocuments.js";
import { withTempDir } from "./helpers.js";

const dir = withTempDir("pi-documents");

// ---- fake pi (as in pi-runner.test.ts) ------------------------------------------------

type Step = (req: PiResponseRequest) => PiStreamEvent[] | Error | Promise<PiStreamEvent[] | Error>;

function fakeClient(steps: Step[]) {
  const requests: PiResponseRequest[] = [];
  let index = 0;
  const client: PiResponsesClient = {
    async compact() {
      throw new Error("not used");
    },
    async *stream(req) {
      requests.push(structuredClone(req));
      const step = steps[index++];
      if (!step) throw new Error(`unexpected pi request #${index}`);
      const out = await step(req);
      if (out instanceof Error) throw out;
      for (const event of out) yield event;
    },
    async cancel() {
      return { status: "cancelled" };
    },
    async input() {
      throw new PiGatewayError("not_found", { status: 404 });
    },
    async listModels() {
      return [];
    },
    async fileContent() {
      throw new Error("not used");
    },
  };
  return { client, requests };
}

const ev = (type: string, data: Record<string, unknown>): PiStreamEvent => ({ type, data });
function textTurn(id: string, text: string): PiStreamEvent[] {
  return [
    ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } }),
    ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } }),
    ev("response.output_text.delta", { delta: text }),
    ev("response.output_item.done", { item: { type: "message", id: `${id}-m`, status: "completed" } }),
    ev("response.completed", { response: { id, status: "completed", usage: { output_tokens: 7 } } }),
  ];
}
const inputText = (req: PiResponseRequest) => (req.input.kind === "prompt" ? req.input.text : "");
const inputFiles = (req: PiResponseRequest) => (req.input.kind === "prompt" ? req.input.files : undefined);

// ---- fixtures ---------------------------------------------------------------------------

const PI: PiRuntimeConfig = { gatewayUrl: "http://pi.invalid", apiKey: "service-key", deckSandbox: false };
const NOW = new Date("2026-11-11T03:00:00Z");
const NO_RETRY = { attempts: 1 };

const PDF_B64 = Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64");
const XLSX_B64 = Buffer.from("PK\u0003\u0004 [Content_Types].xml xl/workbook.xml").toString("base64");
const DOCUMENTS: AgentDocumentInput[] = [
  { name: "분기 보고서.pdf", mediaType: "application/pdf", data: PDF_B64, size: 1_300_000 },
  { name: 'it"s `data`.xlsx', mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: XLSX_B64, size: 34_500 },
];
const DOCUMENTS_LINE =
  '**Attached documents (this turn)**: the user attached 2 documents to this message, saved in your sandbox before this turn started: "/workspace/uploads/분기 보고서.pdf" (PDF, 1.2 MB); "/workspace/uploads/it\\"s `data`.xlsx" (Excel workbook, 34 KB). ' +
  "Read them from those paths — python3 with pypdf, python-docx, python-pptx, openpyxl, pandas for PDF and Office files, `read` for csv/txt/md/json — instead of asking the user to paste the content; " +
  'a csv or text file may be CP949/EUC-KR (common for Korean Excel exports) rather than UTF-8 — if UTF-8 decoding fails, read it with `encoding="cp949"`. ' +
  "`/workspace/uploads/` is shared by all of this user's conversations and a later upload with the same name replaces a file there, so copy one into this conversation's folder if you will need it later.";

let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function setup() {
  services = createServices({
    dataDir: path.join(dir(), "data"),
    agentRuntime: "pi",
    sessionSecret: "t",
    pi: { ...PI, workspacesDir: path.join(dir(), "ws") },
  });
  const { store, config } = services;
  piServicesFor(store, config).models = createPiModelCatalog({ listModels: async () => [{ id: "m-opus" }] });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  store.touchConversation(owner.id, "conv-1", owner.id, "hello");
  const base = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "이 문서들 요약해 줘",
    avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
    conversationId: "conv-1",
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    elevated: true,
    autoApprove: true,
    cwd: dir(),
    ...over,
  });
  return { store, config, owner, base };
}

const chatEvents = (extra: Partial<AgentEvents> = {}): AgentEvents => ({ steers: new SteerChannel(), ...extra });

// ---- the request body -----------------------------------------------------------------

describe("buildResponsesBody: input_file parts", () => {
  const request = (input: PiResponseRequest["input"]): PiResponseRequest => ({ user: "u-1", input, model: "m-opus" });

  it("sends each document as an input_file part after the text and the images", () => {
    const body = buildResponsesBody(
      request({
        kind: "prompt",
        text: "요약해 줘",
        images: [{ mediaType: "image/png", data: "AAAA" }],
        files: [
          { filename: "분기 보고서.pdf", mediaType: "application/pdf", data: PDF_B64 },
          { filename: "data.csv", mediaType: "text/csv", data: "YSxi" },
        ],
      }),
    );
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "요약해 줘" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "분기 보고서.pdf", file_data: `data:application/pdf;base64,${PDF_B64}` },
          { type: "input_file", filename: "data.csv", file_data: "data:text/csv;base64,YSxi" },
        ],
      },
    ]);
    // Exactly the shape pi's `inputFile` reads (vendor/pi-gateway apps/gateway/src/api/request.ts).
    const piSource = fs.readFileSync(path.join(__dirname, "../vendor/pi-gateway/apps/gateway/src/api/request.ts"), "utf8");
    expect(piSource).toContain("part.filename");
    expect(piSource).toContain("part.file_data");
    expect(piSource).toContain('part.type === "input_file"');
  });

  it("a document-only message has no input_text part", () => {
    const body = buildResponsesBody(request({ kind: "prompt", text: "", files: [{ filename: "a.pdf", mediaType: "application/pdf", data: PDF_B64 }] }));
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF_B64}` }] },
    ]);
  });

  it("a turn without documents is the request it always was: a plain string input, an images-only array", () => {
    expect(JSON.stringify(buildResponsesBody(request({ kind: "prompt", text: "안녕" })))).toBe(
      '{"model":"m-opus","input":"안녕","stream":true,"user":"u-1"}',
    );
    expect(JSON.stringify(buildResponsesBody(request({ kind: "prompt", text: "안녕", files: [] })))).toBe(
      '{"model":"m-opus","input":"안녕","stream":true,"user":"u-1"}',
    );
    expect(JSON.stringify(buildResponsesBody(request({ kind: "prompt", text: "봐줘", images: [{ mediaType: "image/png", data: "AAAA" }] })))).toBe(
      '{"model":"m-opus","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"봐줘"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}],"stream":true,"user":"u-1"}',
    );
  });
});

// ---- the runner ---------------------------------------------------------------------------

describe("runPiAgent: document attachments", () => {
  it("sends the turn's documents as files, names them in the preamble, and leaves a turn without documents unchanged", async () => {
    const { store, config, owner, base } = setup();
    store.touchConversation(owner.id, "conv-2", owner.id, "hello");
    const withDocs = fakeClient([() => textTurn("resp_d1_1", "요약입니다")]);
    await runPiAgent(base({ documents: DOCUMENTS }), [], config, store, chatEvents(), undefined, { client: withDocs.client, now: () => NOW });
    const plain = fakeClient([() => textTurn("resp_d2_1", "네")]);
    await runPiAgent(base({ conversationId: "conv-2" }), [], config, store, chatEvents(), undefined, { client: plain.client, now: () => NOW });

    const [sent] = withDocs.requests;
    expect(sent!.user).toBe(owner.id);
    expect(sent!.readOnly).toBeUndefined();
    expect(inputFiles(sent!)).toEqual([
      { filename: "분기 보고서.pdf", mediaType: "application/pdf", data: PDF_B64 },
      { filename: 'it"s `data`.xlsx', mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: XLSX_B64 },
    ]);
    expect(inputText(sent!)).toContain(DOCUMENTS_LINE);
    // What pi receives on the wire.
    const content = (buildResponsesBody(sent!).input as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content.map((part) => part.type)).toEqual(["input_text", "input_file", "input_file"]);
    expect(content[1]).toEqual({ type: "input_file", filename: "분기 보고서.pdf", file_data: `data:application/pdf;base64,${PDF_B64}` });

    // No documents → no `files`, a plain string input, and the same text minus the documents paragraph.
    const [bare] = plain.requests;
    expect(Object.keys(bare!.input).sort()).toEqual(["kind", "text"]);
    expect(typeof buildResponsesBody(bare!).input).toBe("string");
    expect(inputText(bare!)).not.toContain("Attached documents (this turn)");
    expect(inputText(bare!).replaceAll("conv-2", "conv-1")).toBe(inputText(sent!).replace(`${DOCUMENTS_LINE}\n\n`, ""));
    // Everything else about the two requests is the same (the run token and the conversation's folder aside).
    const comparable = (req: PiResponseRequest) => ({ ...req, input: undefined, headers: undefined, instructions: req.instructions?.replaceAll(/c\/[A-Za-z0-9_-]+/g, "c/X") });
    expect(comparable(bare!)).toEqual(comparable(sent!));
  });

  it("a CP949 CSV and a UTF-16 (BOM) text file reach pi byte-for-byte, with the encoding hint in the turn's preamble", async () => {
    const { store, config, base } = setup();
    // "이름,값\r\n가,1\r\n" in CP949 (EUC-KR): not valid UTF-8.
    const cp949 = Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb0, 0xaa, 0x0d, 0x0a, 0xb0, 0xa1, 0x2c, 0x31, 0x0d, 0x0a]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("이름\t값\r\n가\t1\r\n", "utf16le")]);
    const { client, requests } = fakeClient([() => textTurn("resp_k_1", "정리했습니다")]);
    await runPiAgent(
      base({
        documents: [
          { name: "매출.csv", mediaType: "text/csv", data: cp949.toString("base64"), size: cp949.length },
          { name: "유니코드.txt", mediaType: "text/plain", data: utf16.toString("base64"), size: utf16.length },
        ],
      }),
      [],
      config,
      store,
      chatEvents(),
      undefined,
      { client },
    );
    const parts = (buildResponsesBody(requests[0]!).input as { content: { type: string; filename?: string; file_data?: string }[] }[])[0]!.content.filter(
      (entry) => entry.type === "input_file",
    );
    expect(parts.map((part) => part.filename)).toEqual(["매출.csv", "유니코드.txt"]);
    // What pi decodes and writes (its DATA_URL rule: everything after `;base64,`).
    expect(parts.map((part) => Buffer.from(/^data:[^,]*;base64,(.*)$/s.exec(part.file_data!)![1]!, "base64"))).toEqual([cp949, utf16]);
    expect(inputText(requests[0]!)).toContain('"/workspace/uploads/매출.csv" (CSV, 15 bytes)');
    expect(inputText(requests[0]!)).toContain('read it with `encoding="cp949"`');
  });

  it("a steer follow-up turn carries neither the files nor their preamble line", async () => {
    const { store, config, base } = setup();
    const steers = new SteerChannel();
    const { client, requests } = fakeClient([
      () => {
        steers.push("그리고 표로 정리해 줘");
        return textTurn("resp_f_1", "요약입니다");
      },
      () => textTurn("resp_f_2", "표입니다"),
    ]);
    await runPiAgent(base({ documents: DOCUMENTS }), [], config, store, { steers }, undefined, { client });
    expect(inputFiles(requests[0]!)).toHaveLength(2);
    expect(inputFiles(requests[1]!)).toBeUndefined();
    expect(inputText(requests[1]!)).toMatch(/그리고 표로 정리해 줘$/);
    expect(inputText(requests[1]!)).not.toContain("Attached documents");
  });

  it("a lost session is rebuilt WITH the documents (the re-sent attempt carries them again)", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("not_found", { status: 404, code: "404" }),
      () => textTurn("resp_h_1", "요약입니다"),
    ]);
    await runPiAgent(base({ documents: DOCUMENTS, resumeSessionId: "resp_old_3" }), [], config, store, chatEvents(), undefined, { client });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.previousResponseId).toBeUndefined();
    expect(inputFiles(requests[1]!)).toEqual(inputFiles(requests[0]!));
    expect(inputText(requests[1]!)).toContain("Attached documents (this turn)");
  });

  it("surfaces pi's refusal of a file as a clear Korean error — never retried, never dropped, never a 'model is busy' nudge", async () => {
    const { store, config, base } = setup();
    const fail = async (error: Error, documents: AgentDocumentInput[] = DOCUMENTS) => {
      const { client, requests } = fakeClient([() => error]);
      const outcome = await runPiAgent(base({ documents }), [], config, store, chatEvents(), undefined, { client, retry: NO_RETRY }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(requests).toHaveLength(1);
      return outcome as PiGatewayError;
    };

    const refused = await fail(
      new PiGatewayError("bad_request", { status: 400, code: "invalid_file_input", upstreamMessage: "input_file.filename must be a plain file name" }),
    );
    expect(refused).toBeInstanceOf(PiGatewayError);
    expect(refused.message).toBe(
      "첨부한 문서가 전달되지 않았습니다 (파일 이름이나 형식을 받을 수 없거나, 문서를 받을 수 없는 대화입니다). 파일을 확인한 뒤 다시 첨부해 주세요.",
    );
    expect(refused.code).toBe("invalid_file_input");
    expect(refused.upstreamMessage).toBe("input_file.filename must be a plain file name");
    expect(isRetryableModelError(refused)).toBe(false);

    // pi could not write the file into the sandbox: 502 `Sandbox error: …`.
    const sandbox = await fail(new PiGatewayError("server", { status: 502, retryable: true, upstreamMessage: "Sandbox error: write failed: ENOSPC" }));
    expect(sandbox.message).toBe("첨부한 문서를 아바타의 작업 공간(샌드박스)에 저장하지 못했습니다. 문서는 전달되지 않았으니 잠시 후 다시 보내 주세요.");
    expect(sandbox.status).toBeUndefined();
    expect(sandbox.retryable).toBe(false);
    expect(isRetryableModelError(sandbox)).toBe(false);

    // pi's body cap.
    const tooLarge = await fail(new PiGatewayError("too_large", { status: 413 }));
    expect(tooLarge.message).toBe("첨부한 문서와 이미지가 너무 커서 전달되지 않았습니다. 파일을 줄이거나 나눠서 보내 주세요.");

    // Without documents the same failures are what they always were.
    const plain502 = new PiGatewayError("server", { status: 502, retryable: true, upstreamMessage: "Sandbox error: container failed" });
    expect(await fail(plain502, [])).toBe(plain502);
    expect(isRetryableModelError(plain502)).toBe(true);
    // …and an unrelated failure of a document turn is not rewritten.
    const auth = new PiGatewayError("auth", { status: 401 });
    expect(await fail(auth)).toBe(auth);
    expect(piDocumentTurnError(new Error("boom"))).toBeInstanceOf(Error);
  });

  it("the client's own size pre-check names the documents", async () => {
    const { createPiResponsesClient } = await import("../src/server/agent/pi/responsesClient.js");
    const client = createPiResponsesClient({ baseUrl: "http://pi.invalid", serviceKey: "k", fetch: (async () => { throw new Error("must not be called"); }) as typeof fetch });
    const huge = "A".repeat(17 * 1024 * 1024);
    const drain = async (input: PiResponseRequest["input"]) => {
      try {
        for await (const _event of client.stream({ user: "u-1", input })) void _event;
        return null;
      } catch (error) {
        return error as PiGatewayError;
      }
    };
    const withFile = await drain({ kind: "prompt", text: "x", files: [{ filename: "a.pdf", mediaType: "application/pdf", data: huge }] });
    expect(withFile?.kind).toBe("too_large");
    expect(withFile?.message).toBe("첨부한 문서와 이미지가 너무 커서 보낼 수 없습니다. 파일을 줄이거나 나눠서 보내 주세요.");
    const imageOnly = await drain({ kind: "prompt", text: "x", images: [{ mediaType: "image/png", data: huge }] });
    expect(imageOnly?.message).toBe("첨부 이미지가 너무 커서 보낼 수 없습니다.");
  });

  it("never sends a document on a run that cannot take one (a read_only colleague chat, a routine, a task-API turn)", async () => {
    const { store, config, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    store.touchConversation(mate.id, "conv-m", base().avatar.id, "hi");
    const cases: Partial<AgentRequest>[] = [
      { conversationId: "conv-m", viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false },
      { headless: true, allowHeadlessTools: true },
      { externalTaskApi: true },
    ];
    for (const over of cases) {
      const { client, requests } = fakeClient([]);
      const outcome = await runPiAgent(base({ documents: DOCUMENTS, ...over }), [], config, store, over.headless ? undefined : chatEvents(), undefined, { client }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(outcome).toBeInstanceOf(PiGatewayError);
      expect((outcome as PiGatewayError).message).toBe(CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE);
      expect(requests).toEqual([]);
    }
  });
});

// ---- where it is allowed -------------------------------------------------------------------

describe("documentAttachmentsAllowed: one decision for the route, the plan and both surfaces", () => {
  const avatar = { id: "owner-1" };
  it("is true only for an interactive turn in the avatar owner's own sandbox", () => {
    expect(documentAttachmentsAllowed({ avatar, viewerUserId: "owner-1" })).toBe(true);
    expect(documentAttachmentsAllowed({ avatar, viewerUserId: "mate-1" })).toBe(false);
    expect(documentAttachmentsAllowed({ avatar, viewerUserId: "owner-1", externalTaskApi: true })).toBe(false);
    expect(documentAttachmentsAllowed({ avatar, viewerUserId: "owner-1", headless: true })).toBe(false);
    expect(documentAttachmentsAllowed({ avatar, headless: true })).toBe(false);
    expect(documentAttachmentsAllowed({ avatar, viewerUserId: "mate-1", avatarConsultation: true, headless: true })).toBe(false);
    expect(piSandboxOwnerOf({ avatar, viewerUserId: "owner-1" })).toBe("owner");
    expect(piSandboxOwnerOf({ avatar })).toBe("owner");
    expect(piSandboxOwnerOf({ avatar, viewerUserId: "mate-1" })).toBe("viewer");
    expect(piSandboxOwnerOf({ avatar, viewerUserId: "owner-1", avatarConsultation: true })).toBe("nobody");
  });
});

// ---- both metacognition surfaces ------------------------------------------------------------

describe("the avatar is told about document attachments", () => {
  const facts = (over: Partial<PiRuntimeFacts>): PiRuntimeFacts => ({ readOnlyBuiltins: false, shellSecretNames: [], ...over });
  const promptRequest = (pi: PiRuntimeFacts, over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "hi",
    avatar: { id: "owner-1", displayName: "Owner", alias: "", persona: "" },
    viewerUserId: "owner-1",
    viewerIsOwner: true,
    piRuntime: pi,
    ...over,
  });
  const OWNER_NOTE =
    "**Attached documents**: in a chat the user can attach pdf, docx, xlsx, pptx, csv, txt, md, json files to a message; " +
    "each one is saved at `/workspace/uploads/<filename>` in your sandbox before the turn starts, and the message names its path. " +
    "`/workspace/uploads/` is kept between conversations and shared by all of this user's conversations, and a later file with the same name REPLACES the earlier one — if that matters, copy the file into this conversation's folder. " +
    "Read an attached document with the sandbox's Python libraries (pypdf, python-docx, python-pptx, openpyxl, pandas) instead of asking the user to paste it; " +
    'a csv or text file may be CP949/EUC-KR (common for Korean Excel exports) rather than UTF-8 — if UTF-8 decoding fails, read it with `encoding="cp949"`. ' +
    "A scheduled routine run or an external-task turn of this conversation carries no attachments.";
  const VIEWER_NOTE =
    "**Attached documents**: this viewer cannot attach documents (pdf, docx, xlsx, pptx, csv, txt, md, json) in this conversation — that works only in a chat with one's OWN avatar, and this session is read-only. " +
    "If they want you to work from a document, ask them to paste the relevant text, or to attach it in a chat with their own avatar.";

  it("frozen prompt: the owner's conversation says how attachments arrive; a colleague's says they cannot be attached", () => {
    const owner = buildSystemPromptAppend(promptRequest(facts({ sandboxOwner: "owner", conversationDir: "/workspace/c/conv-1", documentAttachments: true })));
    expect(owner).toContain(OWNER_NOTE);
    expect(OWNER_NOTE).toContain(DOCUMENT_UPLOADS_SENTENCE);
    // Frozen per conversation: the SAME text on a routine run of that conversation (the per-run fact is describe_system's).
    const routine = buildSystemPromptAppend(
      promptRequest(facts({ sandboxOwner: "owner", conversationDir: "/workspace/c/conv-1", documentAttachments: false, nonInteractive: true }), {
        headless: true,
        allowHeadlessTools: true,
      }),
    );
    expect(routine).toContain(OWNER_NOTE);

    const viewer = buildSystemPromptAppend(
      promptRequest(facts({ sandboxOwner: "viewer", readOnlyBuiltins: true, conversationDir: "/workspace/c/conv-m" }), { viewerUserId: "mate-1", viewerIsOwner: false }),
    );
    expect(viewer).toContain(VIEWER_NOTE);
    expect(viewer).not.toContain("in a chat the user can attach");

    // No conversation (a consultation's fresh sandbox, a profile generator's run folder): nobody attaches anything.
    for (const pi of [
      facts({ sandboxOwner: "nobody", conversationDir: "/workspace/c/run-ask" }),
      facts({ sandboxOwner: "owner", conversationDir: "/workspace/c/run-profile" }),
      facts({ sandboxOwner: "owner" }),
    ]) {
      expect(buildSystemPromptAppend(promptRequest(pi))).not.toContain("**Attached documents**");
    }
  });

  it("per-turn preamble: one line with each path, type and size — only on a turn that carries documents", () => {
    const request = promptRequest(facts({ sandboxOwner: "owner", conversationDir: "/workspace/c/conv-1", documentAttachments: true }));
    expect(buildPiTurnPreamble({ ...request, documents: DOCUMENTS }, { now: NOW })).toContain(DOCUMENTS_LINE);
    expect(buildPiTurnPreamble(request, { now: NOW })).not.toContain("Attached documents");
    expect(buildPiTurnPreamble({ ...request, documents: [] }, { now: NOW })).not.toContain("Attached documents");
    const one = buildPiTurnPreamble({ ...request, documents: [{ name: "memo.txt", mediaType: "text/plain", data: "YQ==", size: 12 }] }, { now: NOW });
    expect(one).toContain(
      '**Attached documents (this turn)**: the user attached a document to this message, saved in your sandbox before this turn started: "/workspace/uploads/memo.txt" (plain text, 12 bytes). Read it from that path — ',
    );
  });

  it("describe_system: available with the folder and libraries, or not available with the reason", () => {
    expect(documentAttachmentsLine({ piRuntime: facts({ sandboxOwner: "owner", documentAttachments: true }) })).toBe(
      `- Document attachments: AVAILABLE in this run — the user can attach pdf, docx, xlsx, pptx, csv, txt, md, json files to a message; ${DOCUMENT_UPLOADS_SENTENCE}`,
    );
    expect(documentAttachmentsLine({ piRuntime: facts({ sandboxOwner: "viewer", readOnlyBuiltins: true, documentAttachments: false }) })).toBe(
      "- Document attachments: NOT available in this run — this session is read-only in a colleague's sandbox, and documents can be attached only in a chat with one's OWN avatar (ask them to paste the relevant text instead). No message of this run carries a document",
    );
    expect(documentAttachmentsLine({ piRuntime: facts({ sandboxOwner: "nobody" }), headless: true })).toBe(
      "- Document attachments: NOT available in this run — this consultation runs in a temporary sandbox with nobody attaching anything. No message of this run carries a document",
    );
    expect(documentAttachmentsLine({ piRuntime: facts({ sandboxOwner: "owner", documentAttachments: false }), externalTaskApi: true })).toBe(
      "- Document attachments: NOT available in this run — an external system submitted this turn, and the task API carries text only. Files the user attached in earlier chats may still be in `/workspace/uploads/` (kept between conversations; a same-named upload replaces a file)",
    );
    expect(documentAttachmentsLine({ piRuntime: facts({ sandboxOwner: "owner", documentAttachments: false }), headless: true })).toBe(
      "- Document attachments: NOT available in this run — this is an unattended run with nobody attaching anything. Files the user attached in earlier chats may still be in `/workspace/uploads/` (kept between conversations; a same-named upload replaces a file)",
    );
  });

  it("a live run states the same facts on both surfaces: the frozen instructions and describe_system through /mcp", async () => {
    const { store, config, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    store.touchConversation(mate.id, "conv-m", base().avatar.id, "hi");
    const registry = new McpRunRegistry();
    const app = express();
    app.use(express.json());
    app.use(createMcpHttpRouter({ registry }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const described: string[] = [];
    const step: Step = async (req) => {
      const mcp = new Client({ name: "broker", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp/system`), {
          requestInit: { headers: { authorization: `Bearer ${req.headers![PI_RUN_TOKEN_HEADER]!}` } },
        }),
      );
      const result = (await mcp.callTool({ name: "describe_system", arguments: {} })) as { content: { text?: string }[] };
      described.push(result.content.map((part) => part.text ?? "").join("\n"));
      await mcp.close();
      return textTurn(`resp_s${described.length}_1`, "ok");
    };
    const { client, requests } = fakeClient([step, step, step]);
    try {
      await runPiAgent(base({ documents: DOCUMENTS }), [], config, store, chatEvents(), undefined, { client, registry });
      await runPiAgent(
        base({ conversationId: "conv-m", viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false }),
        [],
        config,
        store,
        chatEvents(),
        undefined,
        { client, registry },
      );
      store.touchConversation(base().avatar.id, "conv-routine", base().avatar.id, "routine");
      await runPiAgent(base({ conversationId: "conv-routine", headless: true, allowHeadlessTools: true }), [], config, store, undefined, undefined, { client, registry });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const [ownerRun, mateRun, routineRun] = requests;
    // Owner chat: both surfaces say documents arrive in /workspace/uploads/.
    expect(ownerRun!.instructions).toContain(OWNER_NOTE);
    expect(described[0]).toContain(`- Document attachments: AVAILABLE in this run — the user can attach pdf, docx, xlsx, pptx, csv, txt, md, json files to a message; ${DOCUMENT_UPLOADS_SENTENCE}`);
    // Colleague chat (read_only): both say this viewer cannot attach one.
    expect(mateRun!.readOnly).toBe(true);
    expect(mateRun!.instructions).toContain(VIEWER_NOTE);
    expect(described[1]).toContain("- Document attachments: NOT available in this run — this session is read-only in a colleague's sandbox");
    // Routine: the live surface says no, with the reason.
    expect(described[2]).toContain("- Document attachments: NOT available in this run — this is an unattended run with nobody attaching anything.");
    // Subagents are stated on every pi run.
    for (const text of described) expect(text).toContain(`- Subagents: ${PI_SUBAGENT_SENTENCE}`);
  });

  it("pi's own system prompt names the uploads folder, the document libraries and the Agent tool", () => {
    const prompt = fs.readFileSync(path.join(__dirname, "../scripts/pi-system-prompt.md"), "utf8");
    expect(prompt).toContain(
      "- Files the user attached to a message are in {{WORKSPACE}}/uploads/ (the message names each path). A later upload with the same name replaces the file. Python has pypdf, python-docx, python-pptx, openpyxl and pandas (and numpy, matplotlib): read a PDF, Word, PowerPoint or Excel file with them rather than asking the user to paste its content. A CSV or text file may be CP949/EUC-KR (common for Korean Excel exports) rather than UTF-8: if UTF-8 decoding fails, read it with `encoding=\"cp949\"`.",
    );
    expect(prompt).toContain(
      "- Use Agent to hand a self-contained multi-step task (reading many files, running many commands) to a general-purpose subagent; this keeps long intermediate work out of the conversation. It sees none of this conversation, so put everything it needs in the prompt. A subagent cannot ask the user anything or show them files.",
    );
    // The libraries the prompt names are the ones pi's sandbox image installs, and the subagent is pi's built-in.
    const dockerfile = fs.readFileSync(path.join(__dirname, "../vendor/pi-gateway/images/sandbox/Dockerfile"), "utf8");
    for (const lib of ["pypdf", "python-docx", "python-pptx", "openpyxl", "pandas", "numpy", "matplotlib"]) expect(dockerfile).toContain(lib);
    const subagents = fs.readFileSync(path.join(__dirname, "../vendor/pi-gateway/apps/gateway/src/agent/subagents.ts"), "utf8");
    expect(subagents).toContain('name: "general-purpose"');
    expect(subagents).toContain('export const AGENT_TOOL = "Agent"');
  });

  it("the manual's chat topic documents both", () => {
    const { text } = readSystemManual("chat");
    expect(text).toContain("Documents: in a chat with your OWN avatar the composer also takes pdf, docx, xlsx, pptx, csv, txt, md, json files — up to 5 per message, 8 MB each and 8 MB together");
    expect(text).toContain(
      'Text files are accepted in any text encoding: a csv or text file may be CP949/EUC-KR (common for Korean Excel exports) rather than UTF-8 — if UTF-8 decoding fails, read it with `encoding="cp949"`.',
    );
    expect(text).not.toContain("must be UTF-8");
    expect(text).toContain("`/workspace/uploads/<filename>`");
    expect(text).toContain(`Subagents: ${PI_SUBAGENT_SENTENCE}.`);
  });
});
