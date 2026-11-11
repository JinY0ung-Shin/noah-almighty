// Document attachments in the composer and the user's bubble (ChatView): the
// three ways a file gets in — the picker, a paste, a drop — because on the
// fleet a security agent can refuse the file dialog, so the picker must never
// be the only one; the chips; where documents are NOT offered (a colleague's
// avatar); and the cards of a sent / stored message.
//
// The React port of tests/svelte-chat-documents.test.ts (vitest "react" project).
import { act, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { addConversationToSplit, sendSteer } from "../src/client/src/lib/chat";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { ChatPane } from "../src/client/src/lib/types";
import type { AvatarDetail } from "../src/server/types";
import { CHAT_DOCUMENT_MESSAGES } from "../src/shared/chatDocuments";

// The two side doors out of the composer are faked; everything else ChatView
// imports from the chat module stays real.
vi.mock("../src/client/src/lib/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/chat")>()),
  sendSteer: vi.fn(async () => {}),
  addConversationToSplit: vi.fn(async () => {}),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const CONV_DND_MIME = "application/x-noah-conversation";

function avatar(own: boolean): AvatarDetail {
  return {
    id: own ? "me" : "colleague",
    username: own ? "me" : "kim",
    displayName: own ? "나" : "김동료",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    isOwn: own,
    elevated: true,
    plugins: [],
  } as unknown as AvatarDetail;
}

function pane(id: string, own: boolean, overrides: Partial<ChatPane> = {}): ChatPane {
  return {
    id,
    avatar: avatar(own),
    conversationId: `conv-${id}`,
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
    canvases: [],
    ...overrides,
  } as unknown as ChatPane;
}

function seed(panes: ChatPane[]): void {
  replaceState({
    avatars: [],
    user: { id: "me", roles: [] },
    chatPanes: panes,
    activePaneId: panes[0].id,
    view: "chat",
    // A vision-off default ("file mode"): an image is staged with its original
    // bytes — jsdom has no canvas to downscale on. It is still an IMAGE.
    bootstrap: { modelSelection: { defaultVision: false, models: [] } },
  } as unknown as Parameters<typeof replaceState>[0]);
}

const pdf = () => new File(["%PDF-1.7 demo"], "분기 보고.pdf", { type: "application/pdf" });
const csv = () => new File(["a,b\n1,2\n"], "표.csv", { type: "text/csv" });
const exe = () => new File(["MZ"], "setup.exe", { type: "application/x-msdownload" });
const png = () => new File([PNG_BYTES], "shot.png", { type: "image/png" });

function fileInput(container: HTMLElement, paneId = "p1"): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[data-pane="${paneId}"] .composer-attach input[type='file']`);
  expect(input).toBeTruthy();
  return input!;
}
function textarea(container: HTMLElement, paneId = "p1"): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] .composer-box textarea`)!;
}
function paneEl(container: HTMLElement, paneId = "p1"): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-pane="${paneId}"]`)!;
}
function chips(container: HTMLElement, paneId = "p1"): string[] {
  return [...container.querySelectorAll(`[data-pane="${paneId}"] .composer-doc`)].map((el) =>
    [...el.querySelectorAll(".composer-doc-type, .composer-doc-name, .composer-doc-info")].map((n) => n.textContent?.trim()).join(" | "),
  );
}
function stagedNames(index = 0): string[] {
  return (readState().chatPanes[index].pendingDocuments ?? []).map((d) => d.name);
}
async function settled(index = 0): Promise<void> {
  await waitFor(() => {
    const docs = readState().chatPanes[index].pendingDocuments ?? [];
    expect(docs.every((d) => d.dataUrl !== null)).toBe(true);
  });
}
function warnings(): string[] {
  return get(toasts)
    .filter((t) => t.kind === "warn")
    .map((t) => t.message);
}
/** What a browser hands a drag/paste handler for files. */
function fileTransfer(files: File[], extraTypes: string[] = []) {
  return { files, types: ["Files", ...extraTypes], items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), dropEffect: "none", getData: () => "" };
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
  toasts.set([]);
  vi.mocked(sendSteer).mockClear();
  vi.mocked(addConversationToSplit).mockClear();
});

describe("the attach control", () => {
  it("offers images AND documents on the viewer's own avatar, and says so", () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    const input = fileInput(container);
    expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.xlsx,.pptx,.csv,.txt,.md,.json");
    // The input carries the control's name and stays in the tab order (not `hidden`).
    expect(input.getAttribute("aria-label")).toBe("이미지·문서 첨부 (모델이 이미지 내용을 보지 못해 이미지도 파일로 전달됨)");
    expect(input.hidden).toBe(false);
    // The tooltip names the two ways in that need no file dialog.
    expect(container.querySelector<HTMLElement>("label.composer-attach")!.title).toContain("붙여넣기(Ctrl+V)나 끌어다 놓기로도 첨부할 수 있어요");
  });

  it("stays an image control on a colleague's avatar", () => {
    seed([pane("p1", false)]);
    const { container } = render(<ChatView />);
    const input = fileInput(container);
    expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
    expect(input.getAttribute("aria-label")).toBe("이미지 첨부 (모델이 내용을 보지 못하고 파일로 전달됨)");
  });
});

describe("three ways in", () => {
  it("picker: stages the documents as chips and names the refused file with its reason", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);

    fireEvent.change(fileInput(container), { target: { files: [pdf(), csv(), exe()] } });
    await settled();

    expect(chips(container)).toEqual(["PDF | 분기 보고.pdf | 13 B", "CSV | 표.csv | 8 B"]);
    expect(warnings()).toEqual([`'setup.exe': ${CHAT_DOCUMENT_MESSAGES.TYPE}`]);
    // The strip is a named group; each chip's remove button is a real, named control.
    expect(container.querySelector(".composer-attachments")?.getAttribute("role")).toBe("group");
    const remove = container.querySelector<HTMLButtonElement>(".composer-doc-remove")!;
    expect(remove.tagName).toBe("BUTTON");
    expect(remove.getAttribute("aria-label")).toBe("분기 보고.pdf 제거");
  });

  it("paste: files copied in the file manager are staged and the paste is consumed", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);

    // `files` only — what a file-manager copy looks like (no usable `items`).
    const notPrevented = fireEvent.paste(textarea(container), { clipboardData: { files: [pdf(), exe()], items: [], types: ["Files"] } });
    await settled();

    expect(notPrevented).toBe(false);
    expect(stagedNames()).toEqual(["분기 보고.pdf"]);
    expect(warnings()).toEqual([`'setup.exe': ${CHAT_DOCUMENT_MESSAGES.TYPE}`]);
  });

  it("paste: plain text is left to the textarea", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);

    const notPrevented = fireEvent.paste(textarea(container), {
      clipboardData: { files: [], items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], types: ["text/plain"] },
    });

    expect(notPrevented).toBe(true);
    expect(stagedNames()).toEqual([]);
    expect(get(toasts)).toEqual([]);
  });

  it("paste: an image still goes down the image path, next to a document", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    const files = [png(), csv()];
    fireEvent.paste(textarea(container), {
      clipboardData: { files, items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), types: ["Files"] },
    });
    await settled();
    await waitFor(() => expect(readState().chatPanes[0].pendingImages?.length).toBe(1));
    expect(stagedNames()).toEqual(["표.csv"]);
    // One strip: the thumbnail first, then the document chip.
    const strip = container.querySelector(".composer-attachments")!;
    expect([...strip.children].map((el) => el.className.split(" ")[0])).toEqual(["composer-thumb", "composer-doc"]);
  });

  it("drop: shows the affordance while a file is dragged over the pane, then stages what was dropped", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    const target = paneEl(container);

    const overNotPrevented = fireEvent.dragOver(target, { dataTransfer: fileTransfer([]) });
    expect(overNotPrevented).toBe(false); // the pane accepts the drop
    const overlay = container.querySelector(".chat-drop-overlay");
    expect(overlay?.textContent).toContain("여기에 놓아 첨부");
    expect(overlay?.textContent).toContain("PDF · DOCX · XLSX · PPTX · CSV · TXT · MD · JSON");

    const dropNotPrevented = fireEvent.drop(target, { dataTransfer: fileTransfer([pdf(), csv(), exe()]) });
    await settled();

    expect(dropNotPrevented).toBe(false);
    expect(container.querySelector(".chat-drop-overlay")).toBeNull();
    expect(stagedNames()).toEqual(["분기 보고.pdf", "표.csv"]);
    expect(warnings()).toEqual([`'setup.exe': ${CHAT_DOCUMENT_MESSAGES.TYPE}`]);
  });

  it("drop: the affordance goes when the drag leaves the pane, not when it crosses a child", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    const target = paneEl(container);
    // jsdom has no DragEvent, so `relatedTarget` (where the drag went) is set by hand.
    const leaveTo = (to: Element) => {
      const event = createEvent.dragLeave(target, { dataTransfer: fileTransfer([]) });
      Object.defineProperty(event, "relatedTarget", { value: to });
      return fireEvent(target, event);
    };
    fireEvent.dragOver(target, { dataTransfer: fileTransfer([]) });
    leaveTo(textarea(container));
    expect(container.querySelector(".chat-drop-overlay")).toBeTruthy();
    leaveTo(document.body);
    await waitFor(() => expect(container.querySelector(".chat-drop-overlay")).toBeNull());
  });

  it("a conversation dragged from the rail still opens as a split pane, and stages nothing", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    const conversationDrag = { files: [], types: [CONV_DND_MIME, "text/plain"], dropEffect: "none", getData: (type: string) => (type === CONV_DND_MIME ? "conv-9" : "") };

    fireEvent.dragOver(paneEl(container), { dataTransfer: conversationDrag });
    // Not a file drag: no file affordance, the conversation one instead.
    expect(container.querySelector(".chat-drop-overlay")).toBeNull();
    expect(container.querySelector(".chat-layout.drop-active")).toBeTruthy();

    fireEvent.drop(paneEl(container), { dataTransfer: conversationDrag });
    expect(vi.mocked(addConversationToSplit)).toHaveBeenCalledWith("conv-9");
    expect(stagedNames()).toEqual([]);
    expect(get(toasts)).toEqual([]);
  });

  it("a file dropped OUTSIDE a pane never navigates the browser — only while the chat view is mounted", async () => {
    seed([pane("p1", true)]);
    const { unmount } = render(<ChatView />);

    // Outside any pane: the window refuses the drop (default prevented).
    expect(fireEvent.dragOver(document.body, { dataTransfer: fileTransfer([]) })).toBe(false);
    expect(fireEvent.drop(document.body, { dataTransfer: fileTransfer([pdf()]) })).toBe(false);
    expect(stagedNames()).toEqual([]);
    // Other drags (text, links) are none of its business.
    expect(fireEvent.dragOver(document.body, { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(true);

    unmount();
    expect(fireEvent.dragOver(document.body, { dataTransfer: fileTransfer([]) })).toBe(true);
    expect(fireEvent.drop(document.body, { dataTransfer: fileTransfer([pdf()]) })).toBe(true);
  });
});

describe("chips", () => {
  it("removes one chip and keeps the rest", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    fireEvent.change(fileInput(container), { target: { files: [pdf(), csv()] } });
    await settled();

    fireEvent.click(container.querySelector<HTMLButtonElement>('.composer-doc-remove[aria-label="분기 보고.pdf 제거"]')!);
    await waitFor(() => expect(chips(container)).toEqual(["CSV | 표.csv | 8 B"]));
    expect(stagedNames()).toEqual(["표.csv"]);
  });

  it("gives same-named files of one message their own names", async () => {
    seed([pane("p1", true)]);
    const { container } = render(<ChatView />);
    fireEvent.change(fileInput(container), { target: { files: [new File(["1"], "a.txt"), new File(["22"], "a.txt")] } });
    await settled();
    expect(stagedNames()).toEqual(["a.txt", "a (2).txt"]);
  });

  it("shows a reading state and holds the send until the bytes are in", async () => {
    seed([
      pane("p1", true, {
        draft: "요약해 줘",
        pendingDocuments: [{ id: "d1", name: "큰 파일.pdf", size: 7 * 1024 * 1024, mediaType: "application/pdf", dataUrl: null }],
      }),
    ]);
    const { container } = render(<ChatView />);
    expect(chips(container)).toEqual(["PDF | 큰 파일.pdf | 읽는 중…"]);
    expect(container.querySelector(".composer-doc.is-reading")).toBeTruthy();
    const send = container.querySelector<HTMLButtonElement>('.send-button[aria-label="보내기"]')!;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("첨부한 파일을 읽는 중입니다…");
  });

  it("a document alone makes the message sendable", () => {
    seed([pane("p1", true, { pendingDocuments: [{ id: "d1", name: "a.pdf", size: 4, mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERg==" }] })]);
    const { container } = render(<ChatView />);
    expect(container.querySelector<HTMLButtonElement>('.send-button[aria-label="보내기"]')!.disabled).toBe(false);
  });

  it("refuses to steer while a document is staged, says when it can go, and keeps it staged", async () => {
    seed([
      pane("p1", true, {
        streaming: true,
        liveRunId: "run-1",
        draft: "중간에 한마디",
        pendingDocuments: [{ id: "d1", name: "a.pdf", size: 4, mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERg==" }],
      }),
    ]);
    const { container } = render(<ChatView />);
    fireEvent.keyDown(textarea(container), { key: "Enter" });
    expect(vi.mocked(sendSteer)).not.toHaveBeenCalled();
    expect(warnings()).toEqual(["문서는 응답이 끝난 뒤 보낼 수 있어요."]);
    expect(stagedNames()).toEqual(["a.pdf"]);
  });
});

describe("a colleague's avatar", () => {
  it("refuses a dropped or pasted document with the shared sentence and stages nothing — an image still attaches", async () => {
    seed([pane("p1", false)]);
    const { container } = render(<ChatView />);

    fireEvent.dragOver(paneEl(container), { dataTransfer: fileTransfer([]) });
    expect(container.querySelector(".chat-drop-overlay")?.textContent).toContain("문서는 내 아바타와의 대화에서만 첨부할 수 있어요");

    fireEvent.drop(paneEl(container), { dataTransfer: fileTransfer([pdf(), png()]) });
    await waitFor(() => expect(readState().chatPanes[0].pendingImages?.length).toBe(1));
    expect(stagedNames()).toEqual([]);
    expect(container.querySelector(".composer-doc")).toBeNull();
    expect(warnings()).toEqual([`'분기 보고.pdf': ${CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE}`]);

    toasts.set([]);
    fireEvent.paste(textarea(container), { clipboardData: { files: [csv()], items: [], types: ["Files"] } });
    await waitFor(() => expect(warnings()).toEqual([`'표.csv': ${CHAT_DOCUMENT_MESSAGES.NOT_ALLOWED_HERE}`]));
    expect(stagedNames()).toEqual([]);
  });
});

describe("split view", () => {
  it("each pane stages its own documents", async () => {
    seed([pane("p1", true), pane("p2", true)]);
    const { container } = render(<ChatView />);

    fireEvent.change(fileInput(container, "p1"), { target: { files: [pdf()] } });
    fireEvent.drop(paneEl(container, "p2"), { dataTransfer: fileTransfer([csv()]) });
    await settled(0);
    await settled(1);

    expect(stagedNames(0)).toEqual(["분기 보고.pdf"]);
    expect(stagedNames(1)).toEqual(["표.csv"]);
    expect(chips(container, "p1")).toEqual(["PDF | 분기 보고.pdf | 13 B"]);
    expect(chips(container, "p2")).toEqual(["CSV | 표.csv | 8 B"]);
  });
});

describe("the user's bubble", () => {
  const stored = { id: "doc-1", kind: "file", mediaType: "application/pdf", name: "분기 보고.pdf", size: 2048, uploaded: true };
  const userRow = (attachments: unknown[]) => ({ id: "u1", conversationId: "conv-p1", role: "user", content: "요약해 줘", attachments, response: null, createdAt: "2026-11-11T00:00:00.000Z" });

  it("renders a stored document as a download link of the user's own file — never an image, never a preview button", () => {
    seed([pane("p1", true, { messages: [userRow([stored])] as unknown as ChatPane["messages"] })]);
    const { container } = render(<ChatView />);

    const card = container.querySelector<HTMLAnchorElement>(".message.user a.msg-file-card")!;
    expect(card).toBeTruthy();
    expect(card.getAttribute("href")).toBe(`/api/conversations/conv-p1/files/doc-1?name=${encodeURIComponent("분기 보고.pdf")}`);
    expect(card.getAttribute("download")).toBe("분기 보고.pdf");
    expect(card.target).toBe("");
    expect(card.textContent?.replace(/\s+/g, " ").trim()).toBe("분기 보고.pdf PDF · 2.0 KB · 내려받기");
    expect(container.querySelector(".message.user img")).toBeNull();
    expect(container.querySelector(".message.user button.msg-file-card")).toBeNull();
  });

  it("shows a just-sent document as on its way until the server has it, then as the link", async () => {
    seed([pane("p1", true, { messages: [userRow([stored])] as unknown as ChatPane["messages"], unsentDocumentIds: ["doc-1"] })]);
    const { container } = render(<ChatView />);

    expect(container.querySelector(".message.user a.msg-file-card")).toBeNull();
    const pending = container.querySelector(".message.user .msg-file-card.is-unsent")!;
    expect(pending.textContent?.replace(/\s+/g, " ").trim()).toBe("분기 보고.pdf PDF · 2.0 KB · 보내는 중…");
    expect(pending.getAttribute("aria-busy")).toBe("true");

    // A synchronous `act`: an awaited one would also let the mount's own loads land, and the
    // run-less re-read they end in replaces this fixture's rows (the stub answers no messages).
    act(() => replaceState({ chatPanes: [{ ...readState().chatPanes[0], unsentDocumentIds: [] }] }));
    await waitFor(() => expect(container.querySelector(".message.user a.msg-file-card")).toBeTruthy());
  });

  it("keeps an image and a document of the same message apart", () => {
    const image = { id: "img-1", kind: "image", mediaType: "image/png", name: "shot.png" };
    seed([pane("p1", true, { messages: [userRow([image, stored])] as unknown as ChatPane["messages"] })]);
    const { container } = render(<ChatView />);
    expect(container.querySelectorAll(".message.user img.msg-image")).toHaveLength(1);
    expect(container.querySelectorAll(".message.user a.msg-file-card")).toHaveLength(1);
  });
});
