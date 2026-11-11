// @vitest-environment jsdom
// Document attachments, the library half: what the composer may stage (every
// validation branch, judged BEFORE a byte is read), how a refusal is worded,
// reading the bytes, and what `sendMessage` posts, shows and restores.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { regenerate, sendMessage, submitRewindEdit, startRewindEdit, setRewindEditDraft } from "../src/client/src/lib/chat.js";
import {
  IMAGE_AND_DOCUMENT_ACCEPT,
  attachmentsTooLarge,
  documentRefusalMessages,
  documentTypeLabel,
  documentsReading,
  isFileDrag,
  planDocumentIntake,
  removePendingDocument,
  splitAttachFiles,
  stageDocuments,
} from "../src/client/src/lib/composerDocuments.js";
import { resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import type { ChatPane, PendingDocument } from "../src/client/src/lib/types.js";
import {
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_DOCUMENT_MESSAGES,
  MAX_CHAT_ATTACHMENTS_ENCODED_BYTES,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENTS_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_BYTES,
} from "../src/shared/chatDocuments.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";

const PRISTINE = structuredClone(readState());

function seedPane(overrides: Partial<ChatPane> = {}): string {
  const id = overrides.id ?? "pane-docs";
  const pane = {
    id,
    avatar: { id: "owner", alias: "내 아바타", displayName: "나", isOwn: true } as any,
    conversationId: "c",
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
    canvases: [],
    sideTab: null,
    stickBottom: true,
    usage: null,
    abortController: null,
    ...overrides,
  } as ChatPane;
  updateState((s) => {
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
  });
  return id;
}

function pane(id: string): ChatPane {
  return readState().chatPanes.find((p) => p.id === id)!;
}

function staged(id: string, name: string, size = 4, dataUrl: string | null = "data:application/pdf;base64,JVBERg=="): PendingDocument {
  return { id, name, size, mediaType: "application/pdf", dataUrl };
}

function warnings(): string[] {
  return get(toasts)
    .filter((t) => t.kind === "warn")
    .map((t) => t.message);
}

type FetchHandler = (url: string, init: RequestInit) => unknown;
function useFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function sseRes(frames: Array<[string, unknown]>) {
  const enc = new TextEncoder();
  const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}) };
}
function doneFrame(id: string, text: string): [string, unknown] {
  return ["done", { message: { id, role: "assistant", content: text, response: { kind: "text", runtime: "pi", text }, conversationId: "c", createdAt: "t" } }];
}
function row(id: string, role: "user" | "assistant", content: string, extra: Record<string, unknown> = {}): any {
  return { id, role, content, conversationId: "c", response: null, createdAt: "2026-11-11T00:00:00.000Z", ...extra };
}
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: { id: "owner", roles: [] } as any });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("planDocumentIntake: every refusal, before any byte is read", () => {
  const ok = { name: "보고서.pdf", size: 100 };

  it("accepts every document extension and maps the stored media type", () => {
    const plan = planDocumentIntake(
      CHAT_DOCUMENT_EXTENSIONS.slice(0, MAX_CHAT_DOCUMENTS_PER_MESSAGE).map((ext) => ({ name: `a.${ext}`, size: 10 })),
      [],
      true,
    );
    expect(plan.refused).toEqual([]);
    expect(plan.accepted.map((a) => a.name)).toEqual(["a.pdf", "a.docx", "a.xlsx", "a.pptx", "a.csv"]);
    expect(plan.accepted[0].mediaType).toBe("application/pdf");
    expect(plan.accepted[4].mediaType).toBe("text/csv");
  });

  it.each([
    ["TYPE", { name: "setup.exe", size: 10 }],
    ["TYPE", { name: "확장자없음", size: 10 }],
    ["NAME", { name: "a\u0007.pdf", size: 10 }],
    ["NAME", { name: `${"가".repeat(90)}.pdf`, size: 10 }],
    ["EMPTY", { name: "빈.txt", size: 0 }],
    ["TOO_LARGE", { name: "큰.pdf", size: MAX_CHAT_DOCUMENT_BYTES + 1 }],
  ] as const)("refuses %s and still accepts the file next to it", (problem, bad) => {
    const plan = planDocumentIntake([bad, ok], [], true);
    expect(plan.refused).toEqual([{ name: bad.name, problem }]);
    expect(plan.accepted).toEqual([{ index: 1, name: "보고서.pdf", mediaType: "application/pdf" }]);
  });

  it("refuses the files past the per-message count, counting what is already staged", () => {
    const already = Array.from({ length: MAX_CHAT_DOCUMENTS_PER_MESSAGE - 1 }, (_, i) => ({ name: `s${i}.txt`, size: 1 }));
    const plan = planDocumentIntake([ok, { name: "하나더.md", size: 1 }], already, true);
    expect(plan.accepted.map((a) => a.name)).toEqual(["보고서.pdf"]);
    expect(plan.refused).toEqual([{ name: "하나더.md", problem: "TOO_MANY" }]);
  });

  it("refuses a file that would push the total over the cap, and takes a smaller one after it", () => {
    const half = Math.floor(MAX_CHAT_DOCUMENTS_TOTAL_BYTES / 2);
    const plan = planDocumentIntake(
      [
        { name: "a.pdf", size: half },
        { name: "b.pdf", size: half + 2 },
        { name: "c.pdf", size: 1 },
      ],
      [],
      true,
    );
    expect(plan.accepted.map((a) => a.name)).toEqual(["a.pdf", "c.pdf"]);
    expect(plan.refused).toEqual([{ name: "b.pdf", problem: "TOTAL_TOO_LARGE" }]);
  });

  it("counts the images staged beside them against the ONE request budget", () => {
    const doc = { name: "큰.pdf", size: MAX_CHAT_DOCUMENTS_TOTAL_BYTES };
    // Alone it fits; with ~5 MiB of base64 images already staged it cannot ride.
    expect(planDocumentIntake([doc], [], true).accepted).toHaveLength(1);
    const plan = planDocumentIntake([doc, { name: "작은.txt", size: 10 }], [], true, 5 * 1024 * 1024);
    expect(plan.refused).toEqual([{ name: "큰.pdf", problem: "TOTAL_TOO_LARGE" }]);
    expect(plan.accepted.map((a) => a.name)).toEqual(["작은.txt"]);
  });

  it("refuses EVERYTHING where documents are not offered", () => {
    const plan = planDocumentIntake([ok, { name: "setup.exe", size: 1 }], [], false);
    expect(plan.accepted).toEqual([]);
    expect(plan.refused.map((r) => r.problem)).toEqual(["NOT_ALLOWED_HERE", "NOT_ALLOWED_HERE"]);
  });

  it("makes same-named files unique — against each other and against what is staged (case-insensitively)", () => {
    const plan = planDocumentIntake(
      [
        { name: "a.pdf", size: 1 },
        { name: "A.PDF", size: 1 },
        { name: "b.csv", size: 1 },
      ],
      [{ name: "a.pdf", size: 1 }],
      true,
    );
    expect(plan.accepted.map((a) => a.name)).toEqual(["a (2).pdf", "A (3).PDF", "b.csv"]);
  });
});

describe("refusal wording", () => {
  it("names the file and gives the shared Korean sentence, one message per reason", () => {
    const messages = documentRefusalMessages([
      { name: "setup.exe", problem: "TYPE" },
      { name: "큰.pdf", problem: "TOO_LARGE" },
      { name: "run.bat", problem: "TYPE" },
    ]);
    expect(messages).toEqual([
      `'setup.exe', 'run.bat': ${CHAT_DOCUMENT_MESSAGES.TYPE}`,
      `'큰.pdf': ${CHAT_DOCUMENT_MESSAGES.TOO_LARGE}`,
    ]);
  });

  it("lists three names and counts the rest; a nameless file still gets a label", () => {
    const [message] = documentRefusalMessages(
      ["a.exe", "b.exe", "c.exe", "d.exe", ""].map((name) => ({ name, problem: "TYPE" as const })),
    );
    expect(message.startsWith("'a.exe', 'b.exe', 'c.exe' 외 2개: ")).toBe(true);
    expect(documentRefusalMessages([{ name: "", problem: "NAME" }])[0]).toContain("'이름 없는 파일'");
  });

  it("has a sentence for every problem the shared module names", () => {
    for (const problem of Object.keys(CHAT_DOCUMENT_MESSAGES) as Array<keyof typeof CHAT_DOCUMENT_MESSAGES>)
      expect(documentRefusalMessages([{ name: "x", problem }])[0]).toBe(`'x': ${CHAT_DOCUMENT_MESSAGES[problem]}`);
  });
});

describe("small helpers", () => {
  it("sends an image down the image path whatever its name says, everything else to the document check", () => {
    const png = new File(["x"], "report.pdf", { type: "image/png" });
    const pdf = new File(["x"], "scan.pdf", { type: "application/pdf" });
    const unknown = new File(["x"], "notes.md", { type: "" });
    const { images, others } = splitAttachFiles([png, pdf, unknown]);
    expect(images).toEqual([png]);
    expect(others).toEqual([pdf, unknown]);
  });

  it("tells a file drag from the app's own drags", () => {
    expect(isFileDrag({ dataTransfer: { types: ["Files"] } })).toBe(true);
    expect(isFileDrag({ dataTransfer: { types: ["application/x-noah-conversation", "text/plain"] } })).toBe(false);
    expect(isFileDrag({ dataTransfer: null })).toBe(false);
  });

  it("offers the picker images and every document extension", () => {
    expect(IMAGE_AND_DOCUMENT_ACCEPT).toBe("image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.xlsx,.pptx,.csv,.txt,.md,.json");
  });

  it("labels a chip by its extension", () => {
    expect(documentTypeLabel("분기 보고.PDF")).toBe("PDF");
    expect(documentTypeLabel("a.docx")).toBe("DOCX");
    expect(documentTypeLabel(undefined)).toBe("파일");
  });

  it("measures images and documents against the ONE request budget", () => {
    const rawFitting = Math.floor((MAX_CHAT_ATTACHMENTS_ENCODED_BYTES / 4) * 3);
    expect(attachmentsTooLarge([], [{ size: rawFitting }])).toBe(false);
    expect(attachmentsTooLarge([{ dataUrl: `data:image/png;base64,${"A".repeat(8)}` }], [{ size: rawFitting }])).toBe(true);
  });
});

describe("stageDocuments", () => {
  it("stages a chip at once in a reading state, then fills in the bytes under the EXTENSION's media type", async () => {
    const id = seedPane();
    // The browser's own type for the file is ignored (often empty, differs per OS).
    const file = new File(["a,b\n1,2\n"], "표.csv", { type: "application/vnd.ms-excel" });

    const done = stageDocuments(id, [file], true);
    // Synchronously after the call: the chip exists, the bytes do not yet.
    expect(pane(id).pendingDocuments).toMatchObject([{ name: "표.csv", size: file.size, mediaType: "text/csv", dataUrl: null }]);
    expect(documentsReading(pane(id))).toBe(true);

    await done;
    expect(pane(id).pendingDocuments![0].dataUrl).toBe(`data:text/csv;base64,${btoa("a,b\n1,2\n")}`);
    expect(documentsReading(pane(id))).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it("names the refused file with its reason and stages the others", async () => {
    const id = seedPane();
    await stageDocuments(
      id,
      [new File(["MZ"], "setup.exe"), new File(["%PDF-1.7"], "문서.pdf"), new File([], "빈.txt")],
      true,
    );
    expect(pane(id).pendingDocuments?.map((d) => d.name)).toEqual(["문서.pdf"]);
    expect(warnings()).toEqual([`'setup.exe': ${CHAT_DOCUMENT_MESSAGES.TYPE}`, `'빈.txt': ${CHAT_DOCUMENT_MESSAGES.EMPTY}`]);
  });

  it("stages nothing in a pane that does not take documents", async () => {
    const id = seedPane({ avatar: { id: "colleague", alias: "동료", isOwn: false } as any });
    await stageDocuments(id, [new File(["%PDF-1.7"], "문서.pdf")], false);
    expect(pane(id).pendingDocuments ?? []).toEqual([]);
    expect(warnings()).toEqual([`'문서.pdf': ${CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE}`]);
  });

  it("gives a second same-named file its own name, counting what is already staged", async () => {
    const id = seedPane();
    await stageDocuments(id, [new File(["1"], "a.txt")], true);
    await stageDocuments(id, [new File(["2"], "a.txt")], true);
    expect(pane(id).pendingDocuments?.map((d) => d.name)).toEqual(["a.txt", "a (2).txt"]);
  });

  it("drops a chip whose file could not be read, and says which", async () => {
    const id = seedPane();
    const original = FileReader.prototype.readAsDataURL;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, blob: Blob) {
      if ((blob as File).name === "깨짐.pdf") queueMicrotask(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>));
      else original.call(this, blob);
    });
    await stageDocuments(id, [new File(["x"], "깨짐.pdf"), new File(["y"], "정상.txt")], true);
    expect(pane(id).pendingDocuments?.map((d) => d.name)).toEqual(["정상.txt"]);
    expect(warnings()).toEqual(["'깨짐.pdf' 파일을 읽지 못했습니다. 다시 첨부해 주세요."]);
  });

  it("removes a chip, and a read that finishes after the removal does not bring it back", async () => {
    const id = seedPane();
    const done = stageDocuments(id, [new File(["x"], "a.txt"), new File(["y"], "b.txt")], true);
    const first = pane(id).pendingDocuments![0];
    removePendingDocument(id, first.id);
    await done;
    expect(pane(id).pendingDocuments?.map((d) => d.name)).toEqual(["b.txt"]);
  });
});

describe("sendMessage with staged documents", () => {
  const A = staged("doc-a", "a.pdf", 4, "data:application/pdf;base64,JVBERg==");
  const B = staged("doc-b", "a (2).pdf", 6, "data:application/pdf;base64,JVBERi0x");

  it("posts `files` (id, unique name, data URL), shows the cards at once and clears the composer", async () => {
    const id = seedPane({ pendingDocuments: [A, B], draft: "요약해 줘" });
    const bodies: any[] = [];
    let unsentAtPost: string[] | undefined;
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(JSON.parse(String(init.body)));
        unsentAtPost = pane(id).unsentDocumentIds;
        return sseRes([["open", { conversationId: "c", runId: "r1", userMessageId: "srv-u" }], doneFrame("n1", "요약입니다")]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "요약해 줘");

    expect(bodies[0].files).toEqual([
      { id: "doc-a", name: "a.pdf", data: A.dataUrl },
      { id: "doc-b", name: "a (2).pdf", data: B.dataUrl },
    ]);
    expect(bodies[0].images).toBeUndefined();
    // The optimistic bubble carried the cards (the stored file-card shape) while
    // the upload was still on its way…
    expect(unsentAtPost).toEqual(["doc-a", "doc-b"]);
    const user = pane(id).messages[0];
    expect(user).toMatchObject({ id: "srv-u", role: "user", content: "요약해 줘" });
    expect(user.attachments).toEqual([
      { id: "doc-a", kind: "file", mediaType: "application/pdf", name: "a.pdf", size: 4, uploaded: true },
      { id: "doc-b", kind: "file", mediaType: "application/pdf", name: "a (2).pdf", size: 6, uploaded: true },
    ]);
    // …and once the server opened the run they are downloadable.
    expect(pane(id).unsentDocumentIds).toEqual([]);
    expect(pane(id).pendingDocuments).toEqual([]);
    expect(pane(id).draft).toBe("");
  });

  it("sends a document-only message (no text), images before documents in the bubble", async () => {
    const image = { id: "img1", dataUrl: "data:image/png;base64,AAAA", name: "shot.png", mediaType: "image/png" as const };
    const id = seedPane({ pendingDocuments: [A], pendingImages: [image] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(JSON.parse(String(init.body)));
        return sseRes([doneFrame("n1", "확인")]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "");
    expect(bodies[0]).toMatchObject({ message: "", images: [{ id: "img1", data: image.dataUrl }], files: [{ id: "doc-a", name: "a.pdf" }] });
    expect(pane(id).messages[0].attachments?.map((a) => a.kind)).toEqual(["image", "file"]);
  });

  it("restores the draft and the staged documents when the server refuses (400)", async () => {
    const id = seedPane({ pendingDocuments: [A], draft: "이 문서 봐줘" });
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({ error: CHAT_DOCUMENT_MESSAGES.BAD_FORMAT }, 400);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "이 문서 봐줘");
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).draft).toBe("이 문서 봐줘");
    expect(pane(id).pendingDocuments).toEqual([A]);
    expect(pane(id).unsentDocumentIds).toEqual([]);
    expect(warnings().some((m) => m.includes(CHAT_DOCUMENT_MESSAGES.BAD_FORMAT))).toBe(true);
  });

  it("restores them on a network failure too", async () => {
    const id = seedPane({ pendingDocuments: [A, B] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (String(input) === "/api/chat/stream") throw new TypeError("Failed to fetch");
        return jsonRes({ conversations: [] });
      }),
    );
    await sendMessage(id, "보내기");
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).pendingDocuments).toEqual([A, B]);
    expect(pane(id).draft).toBe("보내기");
  });

  it("does not send while a staged document is still being read", async () => {
    const id = seedPane({ pendingDocuments: [staged("doc-r", "읽는중.pdf", 10, null)], draft: "보내기" });
    const fetchFn = useFetch(() => undefined);
    await sendMessage(id, "보내기");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).pendingDocuments).toHaveLength(1);
    expect(warnings()).toEqual(["첨부한 파일을 아직 읽는 중입니다. 잠시 후 다시 보내 주세요."]);
  });

  it("does not upload a message whose images + documents exceed the request budget", async () => {
    const big = staged("doc-big", "big.pdf", MAX_CHAT_DOCUMENTS_TOTAL_BYTES, "data:application/pdf;base64,AA==");
    const image = { id: "img1", dataUrl: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`, name: "shot.png", mediaType: "image/png" as const };
    const id = seedPane({ pendingDocuments: [big], pendingImages: [image], draft: "둘 다" });
    const fetchFn = useFetch(() => undefined);
    await sendMessage(id, "둘 다");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).pendingDocuments).toEqual([big]);
    expect(warnings()).toEqual([CHAT_DOCUMENT_MESSAGES.TOTAL_TOO_LARGE]);
  });

  it("regenerate sends no file again and leaves the composer's staged documents for the next message", async () => {
    const card = { id: "doc-old", kind: "file", mediaType: "application/pdf", name: "old.pdf", size: 9, uploaded: true };
    const id = seedPane({
      pendingDocuments: [A],
      draft: "다음 말",
      // A document-only turn: the stored copy is the message, so no text is needed.
      messages: [row("u1", "user", "", { attachments: [card] }), row("a1", "assistant", "답")],
    });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(JSON.parse(String(init.body)));
        return sseRes([["open", { conversationId: "c", runId: "r1" }], doneFrame("n1", "새 답")]);
      }
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [row("u1", "user", "", { attachments: [card] }), row("n1", "assistant", "새 답")], canvases: [] });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    regenerate(id);
    await waitFor(() => bodies.length === 1 && !pane(id).streaming);
    await flush();
    expect(bodies[0]).toMatchObject({ regenerate: true, message: "" });
    expect(bodies[0].files).toBeUndefined();
    expect(pane(id).messages[0].attachments).toEqual([card]);
    expect(pane(id).pendingDocuments).toEqual([A]);
    expect(pane(id).draft).toBe("다음 말");
  });

  it("an edit-and-resend keeps the row's document cards and sends no file again", async () => {
    const card = { id: "doc-old", kind: "file", mediaType: "application/pdf", name: "old.pdf", size: 9, uploaded: true };
    const id = seedPane({ messages: [row("u1", "user", "원래 질문", { attachments: [card] }), row("a1", "assistant", "답")] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(JSON.parse(String(init.body)));
        return sseRes([["open", { conversationId: "c", runId: "r1", userMessageId: "srv-u" }], doneFrame("n1", "새 답")]);
      }
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [row("srv-u", "user", "고친 질문", { attachments: [card] }), row("n1", "assistant", "새 답")], canvases: [] });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    startRewindEdit(id, "u1");
    setRewindEditDraft(id, "고친 질문");
    const sending = submitRewindEdit(id);
    await flush();
    resolveConfirmation(true);
    await sending;
    await flush();
    expect(bodies[0]).toMatchObject({ rewindFromMessageId: "u1", message: "고친 질문" });
    expect(bodies[0].files).toBeUndefined();
    expect(pane(id).messages[0]).toMatchObject({ role: "user", content: "고친 질문", attachments: [card] });
  });
});
